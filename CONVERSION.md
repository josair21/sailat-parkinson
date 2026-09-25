# Offline data and run conversion

The source HDF5 and patient metadata are shared by all training runs. Convert that source once into a private static dataset package, then convert each run's result files separately. Per-run packages reference the shared `dataset_id`; they do not contain copies of the signals or patient metadata.

The scripts use the existing `mpy11` environment (`h5py`, `numpy`, `scipy`, and `pyyaml`) and never modify source files. They omit model weights and scalers.

## 1. Convert the shared dataset once

```powershell
micromamba run -n mpy11 python scripts/convert_source_dataset.py `
  --hdf5 "C:\Users\Josue\Documents\liveserver\data\unfiltered_full_epochs_dual_labels.h5" `
  --metadata-csv "C:\Users\Josue\Documents\liveserver\data\A1-Protocol-Metadata.csv" `
  --signal-sampling-rate-hz 100 `
  --display-sampling-rate-hz 20 `
  --output "C:\Users\Josue\Documents\parkinson-data\gw4-source"
```

The output must be a new directory. Its `manifest.json` contains a `dataset_id` derived from the source HDF5 and metadata checksums, package schema, and conversion rates. Keep this package and reuse it for all runs that use the same source dataset. Reconvert only when the source HDF5/metadata or conversion schema/settings change.

The dataset package contains:

```text
gw4-source/
  manifest.json                   dataset ID, source checksums, channels, rates
  conversion_report.json          counts, output sizes, round-trip result
  index.json                      HDF5 row metadata and lazy signal references
  patients/<patient-id>.json      unchanged coded metadata rows
  signals/h5_<index>.20hz.f32.gz one compressed 20 Hz signal per source HDF5 row
  spectra/h5_<index>.psd.f32.gz   precomputed 0–20 Hz Welch PSD per source row
```

Every row in the shared six-channel `X` dataset is preserved, including every action string (transition actions included), A1/A2 label pair, patient, source filename, and device. `score_a1` and `score_a2` are retained as their raw codes without conversion to model labels; observed values and per-action/per-label-pair counts are recorded in the manifest. Signals are low-pass filtered and converted from 100 Hz to 20 Hz using SciPy's polyphase FIR resampler before gzip-compressed float32 output. The emitted file is decompressed and compared element-by-element with the computed 20 Hz array. The original-rate arrays are not emitted.

Welch PSD is computed offline from each original 100 Hz signal (Hann window, 50% overlap, constant detrend, density scaling, `nperseg=min(1024, sample_count)`). The converter integrates PSD over 3–7, 7–10, 10–12, and 3–12 Hz for each of the six channels. These precomputed band powers travel with the matching event candidates in the run package; the browser performs no FFT. The 10–12 Hz summary is retained from the original signal because it cannot be represented by a 20 Hz waveform. The 20 Hz time series itself has a 10 Hz Nyquist limit and must not be interpreted above that limit.

The precomputed Welch spectrum is also retained as a separate gzip-compressed float32 asset for each source row, from 0–20 Hz at the original Welch frequency resolution. The browser fetches and plots this spectrum only when a candidate event is selected. The PSD and the band-power table both come from the original 100 Hz signal; neither is recalculated in the browser.

## 2. Convert each run's results

The converter automatically detects whether a run root has LOSO results. With one LOSO child, it includes that result and all seed results; with none, it includes only seeds. If several LOSO children exist, specify one with `--loso-run`.

For a run family that has both LOSO predictions and five seed OOF/test outputs:

```powershell
micromamba run -n mpy11 python scripts/convert_loso_run.py `
  --run-root "C:\Users\Josue\Documents\liveserver\runs\6ch_pretrain_weak" `
  --dataset-package "C:\Users\Josue\Documents\parkinson-data\gw4-source" `
  --output "C:\Users\Josue\Documents\parkinson-data\runs\6ch_pretrain_weak-lososeed42.json"
```

The output is one compact JSON file containing the run metadata, LOSO patient events (when available), stratified summary, seed OOF data, and holdout predictions (when available). It references the shared dataset by `dataset_id`; it does not duplicate dataset signals or patient metadata.

For a seed-only run family without LOSO results, omit `--loso-run`:

```powershell
micromamba run -n mpy11 python scripts/convert_loso_run.py `
  --run-root "C:\Users\Josue\Documents\parkinson-data\windownet-run" `
  --dataset-package "C:\Users\Josue\Documents\parkinson-data\gw4-source" `
  --output "C:\Users\Josue\Documents\parkinson-data\runs\windownet-seeds.json"
```

The converter detects `5fold_*` or `seedNN` result directories. It retains stored seed OOF results, event-level holdout predictions when available, and final-test aggregate metrics and thresholds. If newer exports include patient/action/source identifiers, those identities stay attached to OOF and holdout events. Per-epoch intermediate predictions are omitted; stored seed OOF results and best-epoch/selection summaries from `experiment_metrics.yml` are kept. Raw NPZ/YAML, model and pretraining weights, scalers, logs, and source code are not copied. Without LOSO results, the JSON has no global patient ranking or LOSO threshold.

The selected LOSO threshold comes from `loso_metadata.yml`; each seed's OOF and test threshold/metrics come from that seed's `experiment_metrics.yml`. Thresholds are preserved; the converter does not tune them.

The output is a single JSON file. Its `patients` and `seed_results` entries embed their records. The shared dataset remains a separate package referenced by `dataset_assets_prefix`.

Each run JSON references the corresponding shared dataset assets under:

```text
datasets/<dataset_id>/manifest.json
datasets/<dataset_id>/signals/<signal-file>
datasets/<dataset_id>/spectra/<spectrum-file>
datasets/<dataset_id>/patients/<patient-id>.json
```

When uploading, place the shared dataset once under `datasets/<dataset_id>/` and each run JSON under `runs/<run_id>.json`. The dashboard resolves signal and metadata refs relative to `dataset_assets_prefix` in the run JSON. Configure access to cover both paths.

The offline run converter also aggregates stored event predictions by action and by filename side. Metrics use the frozen LOSO threshold and only binary consensus labels (`A1 == A2`, label 0 or 1); annotator disagreements and nonbinary consensus labels are counted separately. Recall/FNR and specificity/FPR are N/A when their class is absent, and balanced accuracy is N/A unless both classes occur. Filename suffix `.00` maps to Non-dominant and `.01` to Dominant, following the project convention. An event enters a side group only when all matched candidate filenames are recognized and agree on side; events without candidates, mixed-side candidates, and unrecognized codes stay unassigned. Ambiguous signal identity may still be side-assignable when all candidate filenames agree.

These are prediction-result groups, so they include only actions present in the selected run's event prediction files. The shared source package preserves all source actions and A1/A2 labels, including transition and other actions. If an action has no event-level model prediction in the run artifacts, it cannot have model performance metrics in this summary.

## Available result detail and limits

- The global LOSO `predictions.npz` files contain patient, action, labels, probability, and duration, so they can be joined to shared patient metadata and matched to shared signals.
- Matching uses exact patient/action/A1/A2 fields and source duration at the original GW4 rate of 100 Hz. Ties and source rows proposed for multiple events are marked ambiguous with candidate source details. Missing or out-of-tolerance records stay unmatched. The browser signal itself is the 20 Hz derivative.
- Seed OOF files may or may not contain patient/action/source identifiers. The converter preserves them when present and never infers missing identities.
- Final-test artifacts may contain only aggregate metrics or may also contain event-level holdout predictions. The converter preserves whichever detail is available.
- Older seed exports lack patient/action/source identifiers; the newer WindowNet example has them for OOF and holdout events, and the converter retains them. The seed dashboard currently focuses on OOF detail and aggregate final-test metrics.
- The six-channel HDF5 `X` signals are original GW4 at 100 Hz and remain offline. The shared package serves a filtered 20 Hz derivative plus 100 Hz-derived band-power summaries. The run config's 64 Hz is the model's separate resampled input. Armband signals are 50 Hz but are not present in this HDF5 `X` schema and are not part of this package.
- Patient metadata codes are preserved as stored. Decode them in the dashboard from the documented codebooks; repeated measurement records remain separate.
- Non-finite aggregate metric values are represented as the explicit strings `"NaN"`, `"Infinity"`, or `"-Infinity"` in JSON because JSON has no non-finite number type.

The generated dataset and run JSON files contain patient/event-level data, even after conversion, and must not be committed to GitHub. Store them only in an appropriately protected location. Only aggregate outputs that cannot identify or link to individuals may be committed. A public object URL would bypass Access on the HTML page; verify that Access protects data paths and requests before uploading to Cloudflare.
