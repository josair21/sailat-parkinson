#!/usr/bin/env python3
"""Convert an experiment's global LOSO and per-seed OOF/test results to static assets.

This is an offline converter. It never modifies its source files and never
copies model weights or scalers. The generated directory is intended for a
separate private object store, not for Git.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import h5py
import numpy as np
import yaml


SCHEMA_VERSION = 1
CHANNELS = ["acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z"]
UNITS = ["m/s^2", "m/s^2", "m/s^2", "deg/s", "deg/s", "deg/s"]
REQUIRED_NPZ_KEYS = ("probability", "label", "label_a1", "label_a2", "patient", "action")
H5_ROOT_FIELDS = ("subject_id", "action", "score_a1", "score_a2", "filename", "device")


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
            raise ValueError(f"Non-finite numeric value in {label}")
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


def _load_metadata(path: Path) -> dict[str, list[dict[str, Any]]]:
    """Keep source CSV values and repeated measurements without guessing."""
    result: dict[str, list[dict[str, Any]]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or "VB-ID" not in reader.fieldnames:
            raise ValueError(f"Metadata CSV must contain the documented 'VB-ID' column: {path}")
        for row in reader:
            patient_id = (row.get("VB-ID") or "").strip()
            if not patient_id:
                continue
            result.setdefault(patient_id, []).append(
                {key: (value if value != "" else None) for key, value in row.items() if key is not None}
            )
    return result


def _read_h5_index(h5: h5py.File) -> list[dict[str, Any]]:
    missing = [key for key in H5_ROOT_FIELDS if key not in h5]
    if missing or "X" not in h5 or not isinstance(h5["X"], h5py.Group):
        raise ValueError(f"Unknown HDF5 schema; missing root fields {missing} or X group")
    count = len(h5["subject_id"])
    for key in H5_ROOT_FIELDS:
        if len(h5[key]) != count:
            raise ValueError(f"HDF5 schema length mismatch: {key} has {len(h5[key])}, expected {count}")

    rows = []
    for index in range(count):
        signal_key = str(index)
        if signal_key not in h5["X"]:
            raise ValueError(f"HDF5 X group has no dataset for source row {index}")
        dataset = h5["X"][signal_key]
        if dataset.ndim != 2 or dataset.shape[1] != 6 or dataset.dtype.kind != "f" or dataset.dtype.itemsize != 4:
            raise ValueError(f"Unexpected HDF5 X[{index}] schema: shape={dataset.shape}, dtype={dataset.dtype}")
        rows.append(
            {
                "index": index,
                "patient_id": _text(h5["subject_id"][index], "subject_id"),
                "action": _text(h5["action"][index], "action"),
                "a1": int(h5["score_a1"][index]),
                "a2": int(h5["score_a2"][index]),
                "filename": Path(_text(h5["filename"][index], "filename")).name,
                "device": _text(h5["device"][index], "device"),
                "sample_count": int(dataset.shape[0]),
                "dataset": dataset,
            }
        )
    return rows


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


def _signal_blob(output: Path, h5_row: dict[str, Any]) -> tuple[str, int]:
    signal_id = f"h5_{h5_row['index']:04d}"
    relative = Path("signals") / f"{signal_id}.f32.gz"
    target = output / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        expected_shape = h5_row["dataset"].shape
        values = np.asarray(h5_row["dataset"][:], dtype="<f4", order="C")
        with target.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", compresslevel=6, fileobj=raw, mtime=0) as zipped:
                zipped.write(values.tobytes(order="C"))
        with gzip.open(target, "rb") as zipped:
            restored = np.frombuffer(zipped.read(), dtype="<f4").reshape(expected_shape)
        if not np.array_equal(restored, values, equal_nan=True):
            raise ValueError(f"Signal round-trip mismatch for HDF5 source row {h5_row['index']}")
    return relative.as_posix(), target.stat().st_size


def _match_events(
    output: Path,
    events: list[dict[str, Any]],
    patient_id: str,
    h5_rows: list[dict[str, Any]],
    sample_rate_hz: float,
    max_duration_difference_s: float,
    tie_tolerance_s: float,
) -> dict[str, int]:
    by_attributes: dict[tuple[str, str, int, int], list[dict[str, Any]]] = {}
    for row in h5_rows:
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
                (abs(row["sample_count"] / sample_rate_hz - event["duration_s"]), row["index"]),
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
            proposal_owners.setdefault(row["index"], []).append(event)
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
                or abs(row["sample_count"] / sample_rate_hz - event["duration_s"]) <= max_duration_difference_s
            ]
        if match["status"] == "ambiguous" and not proposed:
            proposed = by_attributes.get((patient_id, event["action"], event["a1"], event["a2"]), [])

        details = []
        for row in proposed:
            duration = row["sample_count"] / sample_rate_hz
            blob, compressed_bytes = _signal_blob(output, row)
            details.append(
                {
                    "source_h5_index": row["index"],
                    "signal_ref": blob,
                    "sample_count": row["sample_count"],
                    "duration_s_from_explicit_rate": duration,
                    "duration_difference_s": abs(duration - event["duration_s"]) if event["duration_s"] is not None else None,
                    "device": row["device"],
                    "source_filename": row["filename"],
                    "compressed_bytes": compressed_bytes,
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
    parser.add_argument("--hdf5", required=True, type=Path, help="Unchanged source HDF5 file")
    parser.add_argument("--metadata-csv", required=True, type=Path, help="Unchanged A1 protocol metadata CSV")
    parser.add_argument("--output", required=True, type=Path, help="New output directory outside Git")
    parser.add_argument(
        "--signal-sampling-rate-hz",
        type=float,
        default=100.0,
        help="Verified sampling rate of the HDF5 X signals; not the model-input rate in config.yml",
    )
    parser.add_argument("--max-duration-difference-s", type=float, default=0.5)
    parser.add_argument("--tie-tolerance-s", type=float, default=0.01)
    return parser.parse_args()


def main() -> int:
    args = _args()
    run_root = args.run_root.resolve()
    loso_dir = (run_root / args.loso_run).resolve()
    h5_path, metadata_path, output = args.hdf5.resolve(), args.metadata_csv.resolve(), args.output.resolve()
    sample_rate = _finite(args.signal_sampling_rate_hz, "--signal-sampling-rate-hz")
    if sample_rate <= 0:
        raise ValueError("--signal-sampling-rate-hz must be positive")
    if args.max_duration_difference_s < 0 or args.tie_tolerance_s < 0:
        raise ValueError("duration tolerances must be nonnegative")
    if not loso_dir.is_dir() or not h5_path.is_file() or not metadata_path.is_file():
        raise FileNotFoundError("Run child, HDF5, or metadata CSV path does not exist")
    if output.exists():
        raise FileExistsError(f"Output already exists; choose a new output path: {output}")
    for source in (run_root, h5_path, metadata_path):
        if output == source or output in source.parents:
            raise ValueError(f"Output must not be inside or overwrite a source path: {source}")

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

    metadata_by_patient = _load_metadata(metadata_path)
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
        with h5py.File(h5_path, "r") as h5:
            h5_rows = _read_h5_index(h5)
            all_events = 0
            totals = {"matched": 0, "ambiguous": 0, "unmatched": 0}
            patient_summaries = []
            for npz_path in patient_files:
                patient_id = npz_path.parent.name.removeprefix("patient_")
                events = _read_events(npz_path, patient_id, threshold)
                all_events += len(events)
                # _match_events emits only a selected signal or tied alternatives.
                counts = _match_events(
                    temp_path,
                    events,
                    patient_id,
                    h5_rows,
                    sample_rate,
                    args.max_duration_difference_s,
                    args.tie_tolerance_s,
                )
                for key, value in counts.items():
                    totals[key] += value
                patient_record = {
                    "patient_id": patient_id,
                    "metadata_records": metadata_by_patient.get(patient_id, []),
                    "metadata_match_count": len(metadata_by_patient.get(patient_id, [])),
                    "events": events,
                }
                relative_patient_path = Path("patients") / f"{patient_id}.json"
                _json_dump(temp_path / relative_patient_path, patient_record)
                patient_summaries.append(
                    {
                        "patient_id": patient_id,
                        "event_count": len(events),
                        "metadata_match_count": patient_record["metadata_match_count"],
                        "data_ref": relative_patient_path.as_posix(),
                    }
                )

        manifest = {
            "schema_version": SCHEMA_VERSION,
            "run_id": f"{run_root.name}__{args.loso_run}",
            "run_family": run_root.name,
            "loso_run": args.loso_run,
            "threshold": threshold,
            "threshold_source": "stored loso_metadata.yml; not optimized by converter",
            "signal": {
                "source": "HDF5 X dataset",
                "processing_state": "GW4 six-channel HDF5 X array as stored; no filtering or resampling performed by converter",
                "sampling_rate_hz": sample_rate,
                "sampling_rate_source": "--signal-sampling-rate-hz; 100 Hz default for the original GW4 source",
                "model_input_sampling_rate_hz": model_sampling_rate,
                "model_input_sampling_rate_source": "selected seed run config and experiment metrics",
                "armband_sampling_rate_hz": 50.0,
                "armband_note": "Armband signals are not present in this HDF5 X six-channel schema and are not converted.",
                "channels": CHANNELS,
                "units": UNITS,
                "dtype": "float32 little-endian",
                "encoding": "row-major interleaved gzip stream; one file per HDF5 source row",
            },
            "matching": {
                "attributes": ["patient_id", "action", "a1", "a2"],
                "duration_method": "closest HDF5 sample_count / explicit signal rate to prediction duration",
                "max_duration_difference_s": args.max_duration_difference_s,
                "tie_tolerance_s": args.tie_tolerance_s,
                "reused_source_signals": "marked ambiguous; never silently attached to multiple prediction events",
            },
            "source": {
                "hdf5_filename": h5_path.name,
                "hdf5_sha256": _sha256(h5_path),
                "metadata_filename": metadata_path.name,
                "metadata_sha256": _sha256(metadata_path),
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
            "source_hdf5_bytes": h5_path.stat().st_size,
            "generated_bytes_excluding_this_report": sum(path.stat().st_size for path in temp_path.rglob("*") if path.is_file()),
            "notes": [
                "No model weights, scaler objects, or source HDF5 were copied.",
                "Events without a valid signal match remain available with an explicit unmatched status.",
                "Ambiguous candidates retain source row, device, and source filename for researcher review.",
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
