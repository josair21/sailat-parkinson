#!/usr/bin/env python3
"""Convert the shared GW4 HDF5 source and metadata once for static delivery."""

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
from scipy.signal import resample_poly, welch


SCHEMA_VERSION = 3
CHANNELS = ["acc_x", "acc_y", "acc_z", "gyr_x", "gyr_y", "gyr_z"]
UNITS = ["m/s^2", "m/s^2", "m/s^2", "deg/s", "deg/s", "deg/s"]
REQUIRED_FIELDS = ("subject_id", "action", "score_a1", "score_a2", "filename", "device")
POWER_BANDS_HZ = [(3.0, 7.0), (7.0, 10.0), (10.0, 12.0), (3.0, 12.0)]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def decode(value: Any, field: str) -> str:
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(f"HDF5 field {field!r} contains non-UTF-8 text") from exc
    return str(value)


def json_dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def load_metadata(path: Path) -> dict[str, list[dict[str, Any]]]:
    by_patient: dict[str, list[dict[str, Any]]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames or "VB-ID" not in reader.fieldnames:
            raise ValueError(f"Metadata CSV must contain 'VB-ID': {path}")
        for row in reader:
            patient_id = (row.get("VB-ID") or "").strip()
            if patient_id:
                # Retain coded source values; decode them in the dashboard from documented codebooks.
                by_patient.setdefault(patient_id, []).append(
                    {key: value if value != "" else None for key, value in row.items() if key is not None}
                )
    return by_patient


def frequency_products(signal: np.ndarray, sampling_rate_hz: float) -> tuple[dict[str, Any], np.ndarray, int, float]:
    if signal.shape[0] < 8:
        raise ValueError("At least 8 source samples are required for a frequency summary")
    nperseg = min(1024, signal.shape[0])
    frequencies, density = welch(
        signal,
        fs=sampling_rate_hz,
        window="hann",
        nperseg=nperseg,
        noverlap=nperseg // 2,
        detrend="constant",
        scaling="density",
        axis=0,
    )
    channels: list[list[float]] = []
    for channel in range(signal.shape[1]):
        powers = []
        for low_hz, high_hz in POWER_BANDS_HZ:
            inside = (frequencies > low_hz) & (frequencies < high_hz)
            points = np.concatenate(([low_hz], frequencies[inside], [high_hz]))
            values = np.interp(points, frequencies, density[:, channel])
            power = float(np.sum((values[:-1] + values[1:]) * np.diff(points) * 0.5))
            powers.append(power)
        channels.append(powers)
    summary = {
        "method": "Welch PSD integral; Hann window; 50% overlap; constant detrend",
        "source_sampling_rate_hz": sampling_rate_hz,
        "bands_hz": [list(band) for band in POWER_BANDS_HZ],
        "units_squared": ["(m/s^2)^2" if channel < 3 else "(deg/s)^2" for channel in range(signal.shape[1])],
        "channel_band_power": channels,
    }
    visible = frequencies <= 20.0
    spectrum = np.asarray(density[visible, :].T, dtype="<f4", order="C")
    return summary, spectrum, nperseg, float(frequencies[visible][-1])


def write_signal(output: Path, index: int, dataset: h5py.Dataset, source_rate: float, downsample_factor: int) -> tuple[str, int, int, dict[str, Any], dict[str, Any], int]:
    source = np.asarray(dataset[:], dtype=np.float64, order="C")
    if not np.all(np.isfinite(source)):
        raise ValueError(f"HDF5 X[{index}] contains non-finite values; refusing incomplete frequency summaries")
    summary, spectrum, nperseg, spectrum_max_hz = frequency_products(source, source_rate)
    reduced = np.asarray(resample_poly(source, up=1, down=downsample_factor, axis=0), dtype="<f4", order="C")
    expected_samples = (source.shape[0] + downsample_factor - 1) // downsample_factor
    if reduced.shape != (expected_samples, source.shape[1]):
        raise ValueError(f"Unexpected resampled shape for HDF5 X[{index}]: {reduced.shape}")
    relative = Path("signals") / f"h5_{index:04d}.20hz.f32.gz"
    target = output / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=6, fileobj=raw, mtime=0) as zipped:
            zipped.write(reduced.tobytes(order="C"))
    with gzip.open(target, "rb") as zipped:
        restored = np.frombuffer(zipped.read(), dtype="<f4").reshape(reduced.shape)
    if not np.array_equal(restored, reduced):
        raise ValueError(f"20 Hz float32 gzip round-trip mismatch for HDF5 X[{index}]")
    spectrum_relative = Path("spectra") / f"h5_{index:04d}.psd.f32.gz"
    spectrum_target = output / spectrum_relative
    spectrum_target.parent.mkdir(parents=True, exist_ok=True)
    with spectrum_target.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=6, fileobj=raw, mtime=0) as zipped:
            zipped.write(spectrum.tobytes(order="C"))
    with gzip.open(spectrum_target, "rb") as zipped:
        restored_spectrum = np.frombuffer(zipped.read(), dtype="<f4").reshape(spectrum.shape)
    if not np.array_equal(restored_spectrum, spectrum):
        raise ValueError(f"Precomputed Welch spectrum gzip round-trip mismatch for HDF5 X[{index}]")
    spectrum_info = {
        "spectrum_ref": spectrum_relative.as_posix(),
        "spectrum_frequency_count": int(spectrum.shape[1]),
        "spectrum_nperseg": nperseg,
        "spectrum_max_frequency_hz": spectrum_max_hz,
    }
    return relative.as_posix(), target.stat().st_size, int(reduced.shape[0]), summary, spectrum_info, spectrum_target.stat().st_size


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hdf5", required=True, type=Path, help="Unchanged source GW4 HDF5 file")
    parser.add_argument("--metadata-csv", required=True, type=Path, help="Unchanged A1 metadata CSV")
    parser.add_argument("--output", required=True, type=Path, help="New shared dataset package directory")
    parser.add_argument("--signal-sampling-rate-hz", type=float, default=100.0, help="Original GW4 rate; model input resampling is separate")
    parser.add_argument("--display-sampling-rate-hz", type=float, default=20.0, help="Reduced rate for browser-visible signal previews")
    args = parser.parse_args()

    h5_path, metadata_path, output = args.hdf5.resolve(), args.metadata_csv.resolve(), args.output.resolve()
    rate = float(args.signal_sampling_rate_hz)
    if not math.isfinite(rate) or rate <= 0:
        raise ValueError("--signal-sampling-rate-hz must be a positive finite number")
    display_rate = float(args.display_sampling_rate_hz)
    if not math.isfinite(display_rate) or display_rate <= 0 or display_rate >= rate:
        raise ValueError("--display-sampling-rate-hz must be positive and below the source rate")
    downsample_factor = round(rate / display_rate)
    if not math.isclose(rate / display_rate, downsample_factor, rel_tol=0, abs_tol=1e-9):
        raise ValueError("Source/display rates must have an integer downsampling ratio")
    if not h5_path.is_file() or not metadata_path.is_file():
        raise FileNotFoundError("Source HDF5 or metadata CSV does not exist")
    if output.exists():
        raise FileExistsError(f"Output already exists; choose a new path: {output}")
    if any(output == source.parent or source.parent in output.parents for source in (h5_path, metadata_path)):
        raise ValueError("Dataset output must not be inside either source path")

    h5_hash, metadata_hash = sha256(h5_path), sha256(metadata_path)
    identity = f"{SCHEMA_VERSION}:{h5_hash}:{metadata_hash}:{rate:g}:{display_rate:g}:{POWER_BANDS_HZ}"
    dataset_id = hashlib.sha256(identity.encode("ascii")).hexdigest()
    metadata_by_patient = load_metadata(metadata_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=f".{output.name}.building-", dir=output.parent))
    try:
        with h5py.File(h5_path, "r") as h5:
            missing = [key for key in REQUIRED_FIELDS if key not in h5]
            if missing or "X" not in h5 or not isinstance(h5["X"], h5py.Group):
                raise ValueError(f"Unknown HDF5 schema; missing fields {missing} or X group")
            row_count = len(h5["subject_id"])
            for key in REQUIRED_FIELDS:
                if len(h5[key]) != row_count:
                    raise ValueError(f"HDF5 array {key!r} length differs from subject_id")
            if len(h5["X"]) != row_count:
                raise ValueError(f"HDF5 X group has {len(h5['X'])} rows, expected {row_count}")

            signal_rows = []
            total_signal_bytes = 0
            total_spectrum_bytes = 0
            for index in range(row_count):
                key = str(index)
                if key not in h5["X"]:
                    raise ValueError(f"HDF5 X group has no dataset for row {index}")
                signal = h5["X"][key]
                if signal.ndim != 2 or signal.shape[1] != 6 or signal.dtype.kind != "f" or signal.dtype.itemsize != 4:
                    raise ValueError(f"Unexpected HDF5 X[{index}] schema: shape={signal.shape}, dtype={signal.dtype}")
                ref, compressed_bytes, display_sample_count, summary, spectrum_info, spectrum_bytes = write_signal(temp, index, signal, rate, downsample_factor)
                patient_id = decode(h5["subject_id"][index], "subject_id")
                signal_rows.append(
                    {
                        "source_h5_index": index,
                        "patient_id": patient_id,
                        "action": decode(h5["action"][index], "action"),
                        "a1": int(h5["score_a1"][index]),
                        "a2": int(h5["score_a2"][index]),
                        "source_filename": Path(decode(h5["filename"][index], "filename")).name,
                        "device": decode(h5["device"][index], "device"),
                        "source_sample_count": int(signal.shape[0]),
                        "sample_count": display_sample_count,
                        "duration_s": signal.shape[0] / rate,
                        "signal_ref": ref,
                        "compressed_bytes": compressed_bytes,
                        "frequency_summary": summary,
                        **spectrum_info,
                    }
                )
                total_signal_bytes += compressed_bytes
                total_spectrum_bytes += spectrum_bytes

        patient_ids = sorted(set(metadata_by_patient) | {row["patient_id"] for row in signal_rows})
        action_counts: dict[str, int] = {}
        label_pair_counts: dict[str, int] = {}
        a1_values: set[int] = set()
        a2_values: set[int] = set()
        for row in signal_rows:
            action_counts[row["action"]] = action_counts.get(row["action"], 0) + 1
            label_key = f"a1_{row['a1']}_a2_{row['a2']}"
            label_pair_counts[label_key] = label_pair_counts.get(label_key, 0) + 1
            a1_values.add(row["a1"])
            a2_values.add(row["a2"])
        for patient_id in patient_ids:
            json_dump(
                temp / "patients" / f"{patient_id}.json",
                {"patient_id": patient_id, "metadata_records": metadata_by_patient.get(patient_id, [])},
            )
        json_dump(temp / "index.json", {"schema_version": SCHEMA_VERSION, "signals": signal_rows})
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "dataset_id": dataset_id,
            "source": {
                "hdf5_filename": h5_path.name,
                "hdf5_sha256": h5_hash,
                "metadata_filename": metadata_path.name,
                "metadata_sha256": metadata_hash,
            },
            "signal": {
                "source": "GW4 six-channel HDF5 X dataset",
                "processing_state": f"Browser signal is anti-aliased and resampled from {rate:g} Hz to {display_rate:g} Hz; band powers use the source before resampling",
                "source_sampling_rate_hz": rate,
                "sampling_rate_hz": display_rate,
                "sampling_rate_source": "explicit conversion rates",
                "resampling": {
                    "method": "scipy.signal.resample_poly",
                    "up": 1,
                    "down": downsample_factor,
                    "window": "Kaiser beta=5.0 (SciPy default)",
                    "anti_alias_filter": "polyphase FIR low-pass applied before decimation",
                },
                "frequency_summary": {
                    "source_sampling_rate_hz": rate,
                    "method": "Welch PSD integrated over frequency bands before resampling",
                    "bands_hz": [list(band) for band in POWER_BANDS_HZ],
                    "nperseg": "min(1024, source sample count)",
                },
                "power_spectrum": {
                    "source_sampling_rate_hz": rate,
                    "maximum_frequency_hz": 20.0,
                    "method": "Welch PSD; Hann window; 50% overlap; constant detrend; density scaling",
                    "storage": "per-signal gzip float32, six channels by frequency bins",
                    "frequency_axis": "uniform bins from 0 Hz with spacing source_sampling_rate_hz / spectrum_nperseg",
                },
                "model_input_sampling_rate_hz": None,
                "channels": CHANNELS,
                "units": UNITS,
                "dtype": "float32 little-endian",
                "encoding": "row-major interleaved gzip stream; reduced-rate browser preview only",
            },
            "metadata": {
                "source_code_values_preserved": True,
                "patient_records": len(patient_ids),
                "metadata_records_by_patient": {patient_id: len(metadata_by_patient.get(patient_id, [])) for patient_id in patient_ids},
                "records_ref_pattern": "patients/<patient-id>.json",
            },
            "annotations": {
                "a1_source_field": "score_a1",
                "a2_source_field": "score_a2",
                "raw_values_preserved_without_recoding": True,
                "observed_a1_values": sorted(a1_values),
                "observed_a2_values": sorted(a2_values),
            },
            "signals_index_ref": "index.json",
            "counts": {
                "signals": len(signal_rows),
                "patients": len(patient_ids),
                "signals_by_action": action_counts,
                "signals_by_annotator_label_pair": label_pair_counts,
            },
        }
        json_dump(temp / "manifest.json", manifest)
        json_dump(
            temp / "conversion_report.json",
            {
                "dataset_id": dataset_id,
                "counts": manifest["counts"],
                "source_hdf5_bytes": h5_path.stat().st_size,
                "compressed_signal_bytes": total_signal_bytes,
                "compressed_spectrum_bytes": total_spectrum_bytes,
                "generated_bytes_excluding_this_report": sum(p.stat().st_size for p in temp.rglob("*") if p.is_file()),
                "round_trip_validation": "Every emitted reduced-rate signal and precomputed Welch spectrum was decompressed and compared element-by-element with its in-memory array.",
                "notes": ["No original-rate signal arrays, HDF5, predictions, model weights, or scaler objects were copied."],
            },
        )
        temp.rename(output)
    except Exception:
        shutil.rmtree(temp, ignore_errors=True)
        raise

    print(json.dumps({"output": str(output), "dataset_id": dataset_id, **manifest["counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"dataset conversion failed: {exc}", file=sys.stderr)
        raise SystemExit(2)
