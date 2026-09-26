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

- The current shared source is `raw_data/unfiltered_full_epochs_dual_labels_with_transitions.h5`; coded A1 metadata remains at `C:\Users\Josue\Documents\liveserver\data\A1-Protocol-Metadata.csv`.
- The current HDF5 is 232.8 MB and contains 2,933 six-channel signal rows, including 1,325 transitions across nine actions. It provides per-row transition context, elapsed-time arrays, timestamp bounds, source segment indexes, and nearest-transition links.
- Offline conversion is split into `scripts/convert_source_dataset.py` and `scripts/convert_loso_run.py`. The shared dataset was converted once locally; the example run package references it by content-derived ID. Both outputs are under ignored `local-data/` and have not been uploaded.
- Artifact coverage differs by run version: older seed OOF arrays lack patient/action/event IDs, while the newer WindowNet seed-only export includes patient, action, filename, and source-row identity for both OOF and holdout events. Other final-test artifacts may contain only aggregate metrics. The converter preserves these limits instead of joining or fabricating events.
- The user-confirmed source sampling rate is 100 Hz. Schema v6 preserves source-rate signals, 0-20 Hz Welch spectra, band powers, transition adjacency context, timestamp bounds, and per-sample elapsed times. Transition segments remain source-only rows without labels or prediction probabilities. The source includes 49 transition rows without absolute timestamp bounds, but their relative elapsed-time arrays are available. The model input remains separately resampled to 64 Hz.
- Signal matching can be ambiguous or unmatched for some global LOSO events. Converter output reports these cases explicitly; review them before interpreting signal/event links.
- Institutional/cloud storage authorization, Cloudflare account limits, Access protection for both the site and data, and retention/backups remain to be confirmed before upload.
- Personal data must not enter GitHub, whether raw, pseudonymized, or converted. Only non-identifying processed aggregate outputs may be committed. Credentials and original source files also remain excluded.
- A static site or static object URL is public unless access protection has been explicitly configured and verified.

## Current implementation status

- Static browser UI exists in `index.html`, `styles.css`, and `app.js` for Global LOSO patient/event inspection, seed-level OOF distributions, and aggregate final-test metrics.
- The current local schema v6 shared package contains 2,933 GW4 signal records and 88 metadata records. The matching LOSO package contains 78 patients and 675 events (344 unique signal links, 206 ambiguous, 125 unmatched). All converted data and run JSONs are under ignored `local-data/v6/`.
- The static server binds to `127.0.0.1:8765`. The dashboard starts with separate dataset ZIP and run JSON selectors; it caches the selected pair in browser IndexedDB for up to 24 hours so refreshes can restore the workspace. Files are not sent to the server. A Forget saved files control removes the browser copy. Converted patient-level files remain local and ignored by Git. The shared dataset package uses schema v6 and includes patient-specific source-signal indexes. Transition rows show their recorded previous/next epoch context and recording elapsed time, remain source-only without labels/probabilities, and open true-time signal/PSD plots. Source-rate plots support browser-side, zero-phase Butterworth filtering.
- The run converter detects LOSO-plus-seed versus seed-only source layouts and emits one compact `run.json` with embedded patient and seed records. It omits per-epoch intermediates and all model/pretraining weights. The browser accepts inline records and remains compatible with split run files. Example outputs are local under ignored `local-data/run-json/`.
- Current stratified summaries cover 675 stored LOSO event predictions across kinetic, postural, rest-end, and rest-start actions. The source dataset also preserves other actions, including transition and task actions, but this LOSO run has no event predictions for those actions. Filename suffix `.00`/`.01` is used for non-dominant/dominant grouping only when candidate filenames consistently agree. Side grouping excludes 275 events with no candidates or uncertain candidate-side codes.
- Seed Results has an Overview tab and independent tabs per seed. When stored OOF or final-test event predictions include patient identity, the corresponding view supports patient grouping, consensus-only patient metrics, and patient inspection with metadata, probability/event views, and signal/PSD graphs when a source row can be matched using patient, action, labels, and filename. Multiple matching signals are shown as ambiguous for researcher selection; unmatched events remain without signal. These remain seed OOF or holdout analyses, not LOSO. Artifacts without identity or event predictions retain their source limitations.
- Seed-only runs open directly to Seed Results and hide Global LOSO navigation when there are no LOSO patient records.
- The local upload accepts multiple converted run JSON files when they share the selected dataset. Runs appear in the Experiment selector, and the 24-hour IndexedDB workspace cache retains the dataset and all selected run files.
- No Cloudflare resources, uploads, authentication configuration, or public deployment have been created.
