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
- Offline conversion is split into `scripts/convert_source_dataset.py` and `scripts/convert_loso_run.py`. The shared dataset was converted once locally; the example run package references it by content-derived ID. Both outputs are under ignored `local-data/` and have not been uploaded.
- The source has two material gaps: OOF arrays lack patient/action/event IDs, and final-test artifacts contain aggregate metrics rather than all event predictions. The converter preserves those limits instead of joining or fabricating events.
- GW4 source signals are 100 Hz; the private browser package serves filtered 20 Hz previews. Precomputed Welch spectra (0–20 Hz) and per-channel band powers (3–7, 7–10, 10–12, and 3–12 Hz) come from the original source before resampling. All 1,608 HDF5 rows retain their action strings and raw A1/A2 labels, including transition actions. The model input is separately resampled to 64 Hz. Armband 50 Hz signals are not present in the selected six-channel HDF5 `X` schema.
- Signal matching can be ambiguous or unmatched for some global LOSO events. Converter output reports these cases explicitly; review them before interpreting signal/event links.
- Institutional/cloud storage authorization, Cloudflare account limits, Access protection for both the site and data, and retention/backups remain to be confirmed before upload.
- Raw data, predictions, annotations, credentials, and private exports must not enter the Git repository.
- A static site or static object URL is public unless access protection has been explicitly configured and verified.

## Current implementation status

- Static browser UI exists in `index.html`, `styles.css`, and `app.js` for Global LOSO patient/event inspection, seed-level OOF distributions, and aggregate final-test metrics.
- Local shared dataset package contains 1,608 GW4 signal records and 88 patient metadata records. The example LOSO package contains 78 patients and 675 events (344 unique signal links, 206 ambiguous, 125 unmatched).
- The static server binds to `127.0.0.1:8765`; local data and catalog are ignored by Git. The shared dataset uses schema v3. The current run package uses schema v3 and includes offline run-wide performance summaries by predicted action and filename-derived side; it has not been uploaded.
- Current stratified summaries cover 675 stored LOSO event predictions across kinetic, postural, rest-end, and rest-start actions. The source dataset also preserves other actions, including transition and task actions, but this LOSO run has no event predictions for those actions. Filename suffix `.00`/`.01` is used for non-dominant/dominant grouping only when candidate filenames consistently agree. Side grouping excludes 275 events with no candidates or uncertain candidate-side codes.
- No Cloudflare resources, uploads, authentication configuration, or public deployment have been created.
- OOF and final-test source-artifact limitations remain as documented above.
