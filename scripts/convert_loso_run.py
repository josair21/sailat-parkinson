#!/usr/bin/env python3
"""Convert an experiment's global LOSO and per-seed OOF/test results to static assets.

This is an offline converter. It never modifies its source files and never
copies model weights or scalers. The generated directory is intended for a
separate private object store, not for Git.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import yaml


SCHEMA_VERSION = 3
CHANNELS = ["acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z"]
UNITS = ["m/s^2", "m/s^2", "m/s^2", "deg/s", "deg/s", "deg/s"]
REQUIRED_NPZ_KEYS = ("probability", "label", "label_a1", "label_a2", "patient", "action")
DATASET_SCHEMA_VERSION = 3


def _stratified_metrics(events: list[dict[str, Any]]) -> dict[str, Any]:
    tp = tn = fp = fn = disagreements = nonbinary = 0
    for event in events:
        a1, a2 = event["a1"], event["a2"]
        if a1 != a2:
            disagreements += 1
            continue
        if a1 not in (0, 1):
            nonbinary += 1
            continue
        predicted = event["predicted_class"]
        if a1 == 1 and predicted == 1: tp += 1
        elif a1 == 1: fn += 1
        elif predicted == 0: tn += 1
        else: fp += 1
    positives, negatives = tp + fn, tn + fp
    recall = tp / positives if positives else None
    specificity = tn / negatives if negatives else None
    return {
        "event_count": len(events), "consensus_count": tp + tn + fp + fn,
        "disagreement_count": disagreements, "nonbinary_consensus_count": nonbinary,
        "positive_count": positives, "negative_count": negatives,
        "tp": tp, "tn": tn, "fp": fp, "fn": fn,
        "recall": recall, "specificity": specificity,
        "fnr": fn / positives if positives else None,
        "fpr": fp / negatives if negatives else None,
        "balanced_accuracy": (recall + specificity) / 2 if recall is not None and specificity is not None else None,
    }


def _event_filename_side(event: dict[str, Any]) -> str | None:
    candidates = event.get("signal_match", {}).get("candidates", [])
    if not candidates:
        return None
    sides = set()
    for candidate in candidates:
        filename = candidate.get("source_filename") or ""
        match = re.search(r"\.(00|01)(?=_|$)", filename)
        if not match:
            return None
        sides.add("Non-dominant" if match.group(1) == "00" else "Dominant")
    return next(iter(sides)) if len(sides) == 1 else None


def _stratified_summary(events: list[dict[str, Any]], threshold: float) -> dict[str, Any]:
    by_action: dict[str, list[dict[str, Any]]] = {}
    by_side: dict[str, list[dict[str, Any]]] = {"Dominant": [], "Non-dominant": []}
    no_candidate = uncertain_side = 0
    for event in events:
        by_action.setdefault(event["action"], []).append(event)
        candidates = event.get("signal_match", {}).get("candidates", [])
        side = _event_filename_side(event)
        if side:
            by_side[side].append(event)
        elif not candidates:
            no_candidate += 1
        else:
            uncertain_side += 1
    return {
        "schema_version": 1,
        "threshold": threshold,
        "by_action": [{"group": action, **_stratified_metrics(group)} for action, group in sorted(by_action.items())],
        "by_filename_side": [{"group": side, **_stratified_metrics(group)} for side, group in by_side.items()],
        "side_coverage": {"assigned_events": sum(map(len, by_side.values())), "no_candidate_events": no_candidate,
                          "uncertain_candidate_side_events": uncertain_side},
        "notes": ["Performance metrics use only binary consensus events (A1 == A2 and label in {0, 1}); disagreements and nonbinary consensus are counted separately.",
                  "Predictions use the threshold stored in this LOSO run.",
                  "Filename suffix .00 maps to Non-dominant and .01 maps to Dominant. Events are assigned only when all candidate filenames support the same side."],
    }


def _json_dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _text(value: Any, field: str) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(f"HDF5 field {field!r} contains non-UTF-8 text") from exc
    return str(value)


def _finite(value: Any, label: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"Non-finite value in {label}: {result}")
    return result


def _json_safe(value: Any, label: str = "metrics") -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item, f"{label}.{key}") for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item, f"{label}[]") for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        number = float(value)
        if not math.isfinite(number):
            return "NaN" if math.isnan(number) else ("Infinity" if number > 0 else "-Infinity")
        return number
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    raise ValueError(f"Unsupported YAML value in {label}: {type(value).__name__}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_dataset_index(dataset_package: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest_path = dataset_package / "manifest.json"
    index_path = dataset_package / "index.json"
    if not manifest_path.is_file() or not index_path.is_file():
        raise FileNotFoundError(f"Dataset package needs manifest.json and index.json: {dataset_package}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if manifest.get("schema_version") != DATASET_SCHEMA_VERSION or index.get("schema_version") != DATASET_SCHEMA_VERSION:
        raise ValueError("Unsupported shared dataset package schema version")
    dataset_id = manifest.get("dataset_id")
    if not isinstance(dataset_id, str) or len(dataset_id) != 64:
        raise ValueError("Shared dataset package has an invalid dataset_id")
    rows = index.get("signals")
    if not isinstance(rows, list) or len(rows) != manifest.get("counts", {}).get("signals"):
        raise ValueError("Shared dataset signal index does not match its manifest count")
    required = {"source_h5_index", "patient_id", "action", "a1", "a2", "sample_count", "duration_s", "signal_ref", "frequency_summary", "spectrum_ref", "spectrum_frequency_count", "spectrum_nperseg", "spectrum_max_frequency_hz"}
    for row in rows:
        if not isinstance(row, dict) or not required.issubset(row):
            raise ValueError("Shared dataset index contains a row with an unknown schema")
        summary = row["frequency_summary"]
        if not isinstance(summary, dict) or summary.get("bands_hz") != [[3.0, 7.0], [7.0, 10.0], [10.0, 12.0], [3.0, 12.0]]:
            raise ValueError("Shared dataset index has an unsupported frequency-summary schema")
        channel_power = summary.get("channel_band_power")
        if not isinstance(channel_power, list) or len(channel_power) != len(CHANNELS) or any(
            not isinstance(channel, list) or len(channel) != 4 or any(not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0 for value in channel)
            for channel in channel_power
        ):
            raise ValueError("Shared dataset index contains invalid frequency band powers")
        if not isinstance(row["spectrum_frequency_count"], int) or row["spectrum_frequency_count"] < 1:
            raise ValueError("Shared dataset index contains an invalid spectrum bin count")
        if not isinstance(row["spectrum_nperseg"], int) or row["spectrum_nperseg"] < 8:
            raise ValueError("Shared dataset index contains an invalid Welch segment length")
        if not isinstance(row["spectrum_max_frequency_hz"], (int, float)) or not 0 < row["spectrum_max_frequency_hz"] <= 20:
            raise ValueError("Shared dataset index contains an invalid spectrum frequency limit")
        ref = Path(row["signal_ref"])
        if ref.is_absolute() or ".." in ref.parts or not (dataset_package / ref).is_file():
            raise ValueError(f"Shared dataset signal is missing or unsafe: {row['signal_ref']}")
        spectrum_ref = Path(row["spectrum_ref"])
        if spectrum_ref.is_absolute() or ".." in spectrum_ref.parts or not (dataset_package / spectrum_ref).is_file():
            raise ValueError(f"Shared dataset spectrum is missing or unsafe: {row['spectrum_ref']}")
    return manifest, rows


def _read_events(npz_path: Path, expected_patient: str, threshold: float) -> list[dict[str, Any]]:
    with np.load(npz_path, allow_pickle=False) as data:
        missing = [key for key in REQUIRED_NPZ_KEYS if key not in data.files]
        if missing:
            raise ValueError(f"{npz_path}: missing required prediction arrays: {missing}")
        size = len(data["probability"])
        optional = ("duration",)
        for key in (*REQUIRED_NPZ_KEYS, *(key for key in optional if key in data.files)):
            if data[key].ndim != 1 or len(data[key]) != size:
                raise ValueError(f"{npz_path}: array {key!r} is not one-dimensional with length {size}")

        events = []
        for index in range(size):
            patient = _text(data["patient"][index], "patient")
            if patient != expected_patient:
                raise ValueError(
                    f"{npz_path}: patient array contains {patient!r}; directory says {expected_patient!r}"
                )
            probability = _finite(data["probability"][index], f"{npz_path}: probability[{index}]")
            if not 0 <= probability <= 1:
                raise ValueError(f"{npz_path}: probability[{index}] is outside [0, 1]")
            a1, a2 = int(data["label_a1"][index]), int(data["label_a2"][index])
            soft_target = _finite(data["label"][index], f"{npz_path}: label[{index}]")
            action = _text(data["action"][index], "action")
            duration = _finite(data["duration"][index], f"{npz_path}: duration[{index}]") if "duration" in data.files else None
            if duration is not None and duration <= 0:
                duration = None
            predicted_class = int(probability >= threshold)
            consensus = a1 == a2
            consensus_label = a1 if consensus else None
            events.append(
                {
                    "event_id": f"{expected_patient}:{index}",
                    "source_npz_index": index,
                    "action": action,
                    "duration_s": duration,
                    "a1": a1,
                    "a2": a2,
                    "soft_target_stored": soft_target,
                    "soft_target_from_a1_a2": (a1 + a2) / 2.0,
                    "consensus": consensus,
                    "consensus_label": consensus_label,
                    "probability": probability,
                    "threshold": threshold,
                    "predicted_class": predicted_class,
                    "correct_on_consensus": (predicted_class == consensus_label) if consensus else None,
                    "confident_fp_heuristic": bool(consensus and consensus_label == 0 and probability >= 0.80),
                    "confident_fn_heuristic": bool(consensus and consensus_label == 1 and probability <= 0.20),
                    "signal_match": None,
                }
            )
        return events


def _match_events(
    events: list[dict[str, Any]],
    patient_id: str,
    signal_rows: list[dict[str, Any]],
    max_duration_difference_s: float,
    tie_tolerance_s: float,
) -> dict[str, int]:
    by_attributes: dict[tuple[str, str, int, int], list[dict[str, Any]]] = {}
    for row in signal_rows:
        by_attributes.setdefault((row["patient_id"], row["action"], row["a1"], row["a2"]), []).append(row)

    proposals: dict[int, list[dict[str, Any]]] = {}
    stats = {"matched": 0, "ambiguous": 0, "unmatched": 0}
    for event in events:
        key = (patient_id, event["action"], event["a1"], event["a2"])
        candidates = by_attributes.get(key, [])
        if not candidates:
            event["signal_match"] = {"status": "unmatched", "reason": "no_hdf5_row_with_same_patient_action_and_labels", "candidates": []}
            stats["unmatched"] += 1
            continue
        if event["duration_s"] is None:
            event["signal_match"] = {
                "status": "ambiguous",
                "reason": "prediction_duration_unavailable",
                "candidates": [],
            }
            proposals[id(event)] = candidates
            continue

        ranked = sorted(
            (
                (abs(row["duration_s"] - event["duration_s"]), row["source_h5_index"]),
                row,
            )
            for row in candidates
        )
        best_delta = ranked[0][0][0]
        if best_delta > max_duration_difference_s:
            event["signal_match"] = {
                "status": "unmatched",
                "reason": "closest_hdf5_duration_exceeds_tolerance",
                "closest_duration_difference_s": best_delta,
                "candidates": [],
            }
            stats["unmatched"] += 1
            continue

        near_best = [row for (delta, _), row in ranked if delta - best_delta <= tie_tolerance_s]
        proposals[id(event)] = near_best
        event["signal_match"] = {
            "status": "ambiguous" if len(near_best) > 1 else "matched",
            "reason": "duration_tie" if len(near_best) > 1 else "unique_closest_duration",
            "closest_duration_difference_s": best_delta,
            "candidates": [],
        }

    # A source signal proposed for multiple prediction events cannot be silently
    # assigned to each one. Keep those events explicitly ambiguous.
    proposal_owners: dict[int, list[dict[str, Any]]] = {}
    for event in events:
        for row in proposals.get(id(event), []):
            proposal_owners.setdefault(row["source_h5_index"], []).append(event)
    collision_events: set[int] = set()
    for owners in proposal_owners.values():
        if len(owners) > 1:
            collision_events.update(id(event) for event in owners)

    for event in events:
        proposed = proposals.get(id(event))
        if proposed is None:
            continue
        match = event["signal_match"]
        if id(event) in collision_events:
            match["status"] = "ambiguous"
            match["reason"] = "hdf5_signal_proposed_for_multiple_prediction_events"
            proposed = [
                row for row in by_attributes.get((patient_id, event["action"], event["a1"], event["a2"]), [])
                if event["duration_s"] is None
                or abs(row["duration_s"] - event["duration_s"]) <= max_duration_difference_s
            ]
        if match["status"] == "ambiguous" and not proposed:
            proposed = by_attributes.get((patient_id, event["action"], event["a1"], event["a2"]), [])

        details = []
        for row in proposed:
            details.append(
                {
                    "source_h5_index": row["source_h5_index"],
                    "signal_ref": row["signal_ref"],
                    "sample_count": row["sample_count"],
                    "duration_s_from_shared_dataset": row["duration_s"],
                    "duration_difference_s": abs(row["duration_s"] - event["duration_s"]) if event["duration_s"] is not None else None,
                    "device": row.get("device"),
                    "source_filename": row.get("source_filename"),
                    "frequency_summary": row["frequency_summary"],
                    "spectrum_ref": row["spectrum_ref"],
                    "spectrum_frequency_count": row["spectrum_frequency_count"],
                    "spectrum_nperseg": row["spectrum_nperseg"],
                    "spectrum_max_frequency_hz": row["spectrum_max_frequency_hz"],
                }
            )
        match["candidates"] = details
        if match["status"] == "matched":
            stats["matched"] += 1
        else:
            stats["ambiguous"] += 1
    return stats


def _sigmoid(logit: float) -> float:
    if logit >= 0:
        return 1.0 / (1.0 + math.exp(-logit))
    exp_value = math.exp(logit)
    return exp_value / (1.0 + exp_value)


def _read_seed_results(run_root: Path, strategy: str) -> tuple[list[tuple[Path, dict[str, Any]]], list[dict[str, Any]], float]:
    """Package per-seed OOF predictions and stored aggregate final-test metrics."""
    seed_dirs = sorted(path for path in run_root.glob("5fold_*") if path.is_dir())
    if not seed_dirs:
        raise FileNotFoundError(f"No 5fold seed directories found under {run_root}")

    outputs: list[tuple[Path, dict[str, Any]]] = []
    summaries = []
    seen_seeds: set[str] = set()
    model_rates: set[float] = set()
    for seed_dir in seed_dirs:
        config_path = seed_dir / "config.yml"
        metrics_path = seed_dir / "experiment_metrics.yml"
        predictions_path = seed_dir / "oof_predictions.npz"
        for required in (config_path, metrics_path, predictions_path):
            if not required.is_file():
                raise FileNotFoundError(f"Seed result is incomplete; missing {required}")
        with config_path.open("r", encoding="utf-8") as stream:
            config = yaml.safe_load(stream)
        with metrics_path.open("r", encoding="utf-8") as stream:
            metrics = yaml.safe_load(stream)
        if not isinstance(config, dict) or "seed" not in config:
            raise ValueError(f"Stored seed missing from {config_path}")
        seed = str(config["seed"])
        if seed in seen_seeds:
            raise ValueError(f"More than one selected seed result found for seed {seed}")
        seen_seeds.add(seed)
        try:
            selected_oof_metrics = metrics["cv"]["strategies"][strategy]["oof"]
            test_metrics = metrics["final_test"]
            model_rate_config = float(config["data"]["sampling_rate"])
            model_rate_metrics = float(metrics["computational_cost"]["sampling_rate_hz"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"{seed_dir}: missing selected strategy metrics or sampling-rate metadata") from exc
        if not isinstance(selected_oof_metrics, dict) or not isinstance(test_metrics, dict):
            raise ValueError(f"{seed_dir}: malformed OOF or final_test metrics")
        if "threshold" not in selected_oof_metrics or "threshold" not in test_metrics:
            raise ValueError(f"{seed_dir}: stored OOF/final-test threshold missing")
        oof_threshold = _finite(selected_oof_metrics["threshold"], f"{seed_dir}: OOF threshold")
        test_threshold = _finite(test_metrics["threshold"], f"{seed_dir}: final-test threshold")
        if not 0 <= oof_threshold <= 1 or not 0 <= test_threshold <= 1:
            raise ValueError(f"{seed_dir}: stored threshold outside [0, 1]")
        if model_rate_config <= 0 or model_rate_metrics <= 0 or model_rate_config != model_rate_metrics:
            raise ValueError(f"{seed_dir}: config and metrics disagree on model-input sampling rate")
        model_rates.add(model_rate_metrics)

        with np.load(predictions_path, allow_pickle=False) as data:
            required_arrays = ("soft_logits", "soft_targets", "soft_a1", "soft_a2")
            missing = [key for key in required_arrays if key not in data.files]
            if missing:
                raise ValueError(f"{predictions_path}: missing OOF arrays {missing}")
            size = len(data["soft_logits"])
            if any(data[key].ndim != 1 or len(data[key]) != size for key in required_arrays):
                raise ValueError(f"{predictions_path}: OOF array lengths/shapes do not match")
            event_rows = []
            for index in range(size):
                logit = _finite(data["soft_logits"][index], f"{predictions_path}: soft_logits[{index}]")
                probability = _sigmoid(logit)
                a1, a2 = int(data["soft_a1"][index]), int(data["soft_a2"][index])
                soft_target = _finite(data["soft_targets"][index], f"{predictions_path}: soft_targets[{index}]")
                agreement = a1 == a2
                consensus = agreement and a1 in (0, 1)
                prediction = int(probability >= oof_threshold)
                event_rows.append(
                    {
                        "source_array_index": index,
                        "logit": logit,
                        "probability_from_stored_logit": probability,
                        "a1": a1,
                        "a2": a2,
                        "annotator_agreement": agreement,
                        "consensus": consensus,
                        "consensus_label": a1 if consensus else None,
                        "soft_target_stored": soft_target,
                        "soft_target_from_a1_a2": (a1 + a2) / 2.0,
                        "predicted_class_at_stored_oof_threshold": prediction,
                        "correct_on_consensus": (prediction == a1) if consensus else None,
                    }
                )
        seed_record = {
            "seed": seed,
            "seed_directory": seed_dir.name,
            "strategy": strategy,
            "oof_threshold": oof_threshold,
            "oof_metrics": _json_safe(selected_oof_metrics, f"{seed_dir.name}.oof_metrics"),
            "oof_predictions": {
                "source_file": predictions_path.name,
                "event_identity_available": False,
                "identity_note": "Array index only; patient, action, duration, and HDF5 source identifiers are absent from this NPZ.",
                "events": event_rows,
            },
            "final_test_threshold": test_threshold,
            "final_test_metrics": _json_safe(test_metrics, f"{seed_dir.name}.final_test"),
            "final_test_event_predictions_available": False,
        }
        relative = Path("seed-results") / f"seed_{seed}.json"
        outputs.append((relative, seed_record))
        summaries.append(
            {
                "seed": seed,
                "strategy": strategy,
                "data_ref": relative.as_posix(),
                "oof_event_count": len(event_rows),
                "oof_threshold": oof_threshold,
                "final_test_threshold": test_threshold,
                "final_test_event_predictions_available": False,
            }
        )
    if len(model_rates) != 1:
        raise ValueError(f"Seed folders disagree on model-input sampling rate: {sorted(model_rates)}")
    return outputs, summaries, next(iter(model_rates))


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-root", required=True, type=Path, help="Run family directory, e.g. liveserver/runs/6ch_pretrain_weak")
    parser.add_argument("--loso-run", required=True, help="LOSO child directory, e.g. loso_seed42")
    parser.add_argument("--dataset-package", required=True, type=Path, help="Previously converted shared dataset package")
    parser.add_argument("--output", required=True, type=Path, help="New output directory outside Git")
    parser.add_argument("--max-duration-difference-s", type=float, default=0.5)
    parser.add_argument("--tie-tolerance-s", type=float, default=0.01)
    return parser.parse_args()


def main() -> int:
    args = _args()
    run_root = args.run_root.resolve()
    loso_dir = (run_root / args.loso_run).resolve()
    dataset_package, output = args.dataset_package.resolve(), args.output.resolve()
    if args.max_duration_difference_s < 0 or args.tie_tolerance_s < 0:
        raise ValueError("duration tolerances must be nonnegative")
    if not loso_dir.is_dir():
        raise FileNotFoundError(f"LOSO result directory does not exist: {loso_dir}")
    if output.exists():
        raise FileExistsError(f"Output already exists; choose a new output path: {output}")
    for source in (run_root, dataset_package):
        if output == source or output in source.parents or source in output.parents:
            raise ValueError(f"Output must not be inside or overwrite a source path: {source}")

    dataset_manifest, signal_rows = _read_dataset_index(dataset_package)
    dataset_id = dataset_manifest["dataset_id"]
    dataset_signal_rate = _finite(dataset_manifest["signal"]["sampling_rate_hz"], "shared dataset display signal rate")
    dataset_source_rate = _finite(dataset_manifest["signal"]["source_sampling_rate_hz"], "shared dataset source signal rate")
    if dataset_source_rate != 100.0 or dataset_signal_rate != 20.0:
        raise ValueError(f"Expected 100 Hz source and 20 Hz display signals, dataset package says {dataset_source_rate} Hz source / {dataset_signal_rate} Hz display")

    metadata_path_yaml = loso_dir / "loso_metadata.yml"
    if not metadata_path_yaml.is_file():
        raise FileNotFoundError(f"Missing stored LOSO threshold metadata: {metadata_path_yaml}")
    with metadata_path_yaml.open("r", encoding="utf-8") as stream:
        run_metadata = yaml.safe_load(stream)
    if not isinstance(run_metadata, dict) or "threshold" not in run_metadata:
        raise ValueError(f"Stored threshold missing from {metadata_path_yaml}")
    threshold = _finite(run_metadata["threshold"], "stored LOSO threshold")
    if not 0 <= threshold <= 1:
        raise ValueError("Stored threshold is outside [0, 1]")

    strategy = run_metadata.get("strategy")
    if not isinstance(strategy, str) or not strategy:
        raise ValueError(f"Stored strategy missing from {metadata_path_yaml}")
    seed_results, seed_summaries, model_sampling_rate = _read_seed_results(run_root, strategy)
    patient_files = sorted(loso_dir.glob("patient_*/predictions.npz"))
    if not patient_files:
        raise FileNotFoundError(f"No patient_*/predictions.npz files found in {loso_dir}")

    output.parent.mkdir(parents=True, exist_ok=True)
    temp_path = Path(tempfile.mkdtemp(prefix=f".{output.name}.building-", dir=output.parent))
    try:
        all_events = 0
        totals = {"matched": 0, "ambiguous": 0, "unmatched": 0}
        patient_summaries = []
        stratified_events = []
        metadata_counts = dataset_manifest.get("metadata", {}).get("metadata_records_by_patient", {})
        for npz_path in patient_files:
            patient_id = npz_path.parent.name.removeprefix("patient_")
            events = _read_events(npz_path, patient_id, threshold)
            all_events += len(events)
            counts = _match_events(
                events,
                patient_id,
                signal_rows,
                args.max_duration_difference_s,
                args.tie_tolerance_s,
            )
            for key, value in counts.items():
                totals[key] += value
            stratified_events.extend(events)
            relative_patient_path = Path("patients") / f"{patient_id}.json"
            _json_dump(
                temp_path / relative_patient_path,
                {
                    "patient_id": patient_id,
                    "shared_metadata_ref": f"patients/{patient_id}.json",
                    "metadata_match_count": metadata_counts.get(patient_id, 0),
                    "prediction_source": npz_path.name,
                    "prediction_sha256": _sha256(npz_path),
                    "events": events,
                },
            )
            patient_summaries.append(
                {
                    "patient_id": patient_id,
                    "event_count": len(events),
                    "shared_metadata_ref": f"patients/{patient_id}.json",
                    "metadata_match_count": metadata_counts.get(patient_id, 0),
                    "prediction_sha256": _sha256(npz_path),
                    "data_ref": relative_patient_path.as_posix(),
                }
            )

        stratified_summary_ref = "stratified_summary.json"
        _json_dump(temp_path / stratified_summary_ref, _stratified_summary(stratified_events, threshold))
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "run_id": f"{run_root.name}__{args.loso_run}",
            "run_family": run_root.name,
            "loso_run": args.loso_run,
            "dataset_id": dataset_id,
            "dataset_manifest_ref": f"datasets/{dataset_id}/manifest.json",
            "dataset_assets_prefix": f"datasets/{dataset_id}/",
            "threshold": threshold,
            "threshold_source": "stored loso_metadata.yml; not optimized by converter",
            "stratified_summary_ref": stratified_summary_ref,
            "signal": {
                "source": "shared GW4 six-channel HDF5 X dataset package",
                "processing_state": dataset_manifest["signal"]["processing_state"],
                "sampling_rate_hz": dataset_signal_rate,
                "source_sampling_rate_hz": dataset_source_rate,
                "sampling_rate_source": "shared converted browser preview dataset manifest",
                "model_input_sampling_rate_hz": model_sampling_rate,
                "model_input_sampling_rate_source": "selected seed run config and experiment metrics",
                "armband_sampling_rate_hz": 50.0,
                "armband_note": "Armband signals are not present in the shared six-channel HDF5 X package.",
                "channels": CHANNELS,
                "units": UNITS,
                "dtype": "float32 little-endian",
                "encoding": "row-major interleaved gzip stream; one file per HDF5 source row",
            },
            "matching": {
                "attributes": ["patient_id", "action", "a1", "a2"],
                "duration_method": "closest shared dataset sample_count / source rate to prediction duration",
                "max_duration_difference_s": args.max_duration_difference_s,
                "tie_tolerance_s": args.tie_tolerance_s,
                "reused_source_signals": "marked ambiguous; never silently attached to multiple prediction events",
            },
            "source": {
                "loso_metadata_filename": metadata_path_yaml.name,
                "loso_metadata_sha256": _sha256(metadata_path_yaml),
            },
            "counts": {
                "patients": len(patient_summaries),
                "prediction_events": all_events,
                "signals_matched": totals["matched"],
                "signals_ambiguous": totals["ambiguous"],
                "signals_unmatched": totals["unmatched"],
            },
            "patients": patient_summaries,
            "seed_results": seed_summaries,
        }
        _json_dump(temp_path / "manifest.json", manifest)
        for relative, value in seed_results:
            _json_dump(temp_path / relative, value)
        _json_dump(temp_path / "conversion_report.json", {
            "run_id": manifest["run_id"],
            "counts": manifest["counts"],
            "seed_result_count": len(seed_summaries),
            "shared_dataset_id": dataset_id,
            "run_package_bytes_excluding_this_report": sum(path.stat().st_size for path in temp_path.rglob("*") if path.is_file()),
            "notes": [
                "No dataset signals, patient metadata, model weights, or scaler objects were copied into this run package.",
                "Events without a valid signal match remain available with an explicit unmatched status.",
                "Ambiguous candidates retain source row, device, and source filename for researcher review.",
                "Run-wide stratified action and filename-side metrics are in stratified_summary.json; side assignments require candidate filenames to agree.",
                "OOF logits/labels have no patient, action, duration, or source-event identifiers in the supplied NPZ; only array-order analysis is possible.",
                "Seed final-test artifacts contain aggregate metrics, not all event-level predictions.",
            ],
        })
        temp_path.rename(output)
    except Exception:
        shutil.rmtree(temp_path, ignore_errors=True)
        raise

    print(json.dumps({"output": str(output), **manifest["counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"conversion failed: {exc}", file=sys.stderr)
        raise SystemExit(2)
