# Project State

## Project

New, clean project for a browser-based patient-level LOSO error-analysis dashboard, intended for `parkinson.sai.lat`.

This project is separate from the existing Streamlit dashboard. Its goal is to avoid inheriting that project's residual files while preserving its research purpose and scientific safeguards.

## Desired operating model

- Source code in GitHub.
- Static site hosting on Cloudflare Pages.
- Research data converted into efficient static browser-readable assets and stored separately from source code, likely in Cloudflare R2 after access controls and institutional approval are established.
- All dashboard interaction and analysis run client-side in the browser. No always-on user computer, Python web server, or deployed application function is intended.
- Do not assume HDF5 should be downloaded or parsed as one large file in the browser. First measure it and choose a lazy, chunked representation that fits browser memory and Cloudflare limits.

## Research purpose

Inspect existing LOSO outputs and wearable IMU signals to understand why held-out patients or events are correctly or incorrectly classified. This is an inspection tool, not a training or relabeling pipeline.

Primary flow:
1. Select an experiment/run.
2. Select a patient and inspect decoded metadata and class composition.
3. Review appropriate patient metrics and every event's labels and probability.
4. Select an event and inspect Acc/Gyr time series and PSD.
5. Compare the event with suitable reference events without asserting a cause or changing labels.

## Scientific rules to preserve

- A1/A2 consensus is `a1 == a2`; consensus label is A1 only for consensus events.
- Soft target is `(a1 + a2) / 2`.
- Disagreement events remain visible and must not be presented as ordinary hard-label errors.
- Use the frozen threshold stored for the selected run. Do not tune it.
- Balanced accuracy is interpretable as a conventional patient-level binary metric only when both consensus classes are present. For a single-class patient, report the defined class-specific metrics and mark BA N/A.
- Show inspection flags at probability >= 0.80 for consensus-negative FP and <= 0.20 for consensus-positive FN only as heuristics, never clinical thresholds.
- Do not infer missing metadata. Decode categorical metadata according to dataset documentation.
- Distinguish observations from hypotheses; model confidence and signal appearance alone do not prove a label is wrong.
- Show whether data are raw, resampled, filtered, normalized, or model input. Preserve true time axes and identify sampling rate.
- Welch PSD (or an established project method) should show Hz and relevant tremor-frequency context without over-interpreting peaks.

## Data and security status

- The intended source is `C:\Users\Josue\Documents\liveserver\runs\6ch_pretrain_weak`, with the source HDF5 and A1 metadata under `liveserver\data`.
- The source HDF5 is about 88.6 MB and contains six-channel numeric `X` arrays for 1,608 rows. The run family has five selected 5-fold seed runs and `loso_seed42`; model weights/scalers are not needed in the dashboard package.
- A first offline converter now exists at `scripts/convert_loso_run.py`. It is designed to package global LOSO predictions/signals and each seed's OOF arrays and final-test aggregate metrics. It has not yet been run, and generated research data has not been created or uploaded.
- The source has two material gaps: OOF arrays lack patient/action/event IDs, and final-test artifacts contain aggregate metrics rather than all event predictions. The converter preserves those limits instead of joining or fabricating events.
- GW4 source signals are 100 Hz; the model input is resampled to 64 Hz. Armband 50 Hz signals are not present in the selected six-channel HDF5 `X` schema. The converter preserves source HDF5 signals and records the rates separately.
- Signal matching can be ambiguous or unmatched for some global LOSO events. Converter output reports these cases explicitly; review them before interpreting signal/event links.
- Institutional/cloud storage authorization, Cloudflare account limits, Access protection for both the site and data, and retention/backups remain to be confirmed before upload.
- Raw data, predictions, annotations, credentials, and private exports must not enter the Git repository.
- A static site or static object URL is public unless access protection has been explicitly configured and verified.

## Current implementation status

Planning and conversion tooling only. No website, generated data package, Cloudflare resources, or deployment has been created in this folder. See `CONVERSION.md` for the input/output schema, command, and known source-artifact limits.
