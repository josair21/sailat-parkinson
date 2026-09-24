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

For the example global LOSO result and the five seed OOF/test outputs:

```powershell
micromamba run -n mpy11 python scripts/convert_loso_run.py `
  --run-root "C:\Users\Josue\Documents\liveserver\runs\6ch_pretrain_weak" `
  --loso-run loso_seed42 `
  --dataset-package "C:\Users\Josue\Documents\parkinson-data\gw4-source" `
  --output "C:\Users\Josue\Documents\parkinson-data\runs\6ch_pretrain_weak-lososeed42"
```

This writes only run-specific prediction/metric JSON plus references into the shared dataset. The selected LOSO threshold comes from `loso_metadata.yml`; each seed's OOF and test threshold/metrics come from that seed's `experiment_metrics.yml`. Thresholds are preserved; the converter does not tune them. The output must be a new directory.

```text
6ch_pretrain_weak-lososeed42/
  manifest.json                 run metadata, shared dataset ID, patient/seed index
  stratified_summary.json       run-wide prediction metrics by action and filename side
  conversion_report.json        counts and source-artifact limitations
  patients/<patient-id>.json    global LOSO event predictions, shared metadata ref
  seed-results/seed_<seed>.json per-seed OOF predictions and final-test metrics
```

Each run package lists the corresponding shared assets under:

```text
datasets/<dataset_id>/manifest.json
datasets/<dataset_id>/signals/<signal-file>
datasets/<dataset_id>/spectra/<spectrum-file>
datasets/<dataset_id>/patients/<patient-id>.json
```

When uploading, place the shared dataset once under `datasets/<dataset_id>/` and each result package under `runs/<run_id>/`. The dashboard resolves signal and metadata refs relative to `dataset_assets_prefix` in each run manifest. Configure access to cover both paths.

The offline run converter also aggregates stored event predictions by action and by filename side. Metrics use the frozen LOSO threshold and only binary consensus labels (`A1 == A2`, label 0 or 1); annotator disagreements and nonbinary consensus labels are counted separately. Recall/FNR and specificity/FPR are N/A when their class is absent, and balanced accuracy is N/A unless both classes occur. Filename suffix `.00` maps to Non-dominant and `.01` to Dominant, following the project convention. An event enters a side group only when all matched candidate filenames are recognized and agree on side; events without candidates, mixed-side candidates, and unrecognized codes stay unassigned. Ambiguous signal identity may still be side-assignable when all candidate filenames agree.

These are prediction-result groups, so they include only actions present in the selected run's event prediction files. The shared source package preserves all source actions and A1/A2 labels, including transition and other actions. If an action has no event-level model prediction in the run artifacts, it cannot have model performance metrics in this summary.

## Available result detail and limits

- The global LOSO `predictions.npz` files contain patient, action, labels, probability, and duration, so they can be joined to shared patient metadata and matched to shared signals.
- Matching uses exact patient/action/A1/A2 fields and source duration at the original GW4 rate of 100 Hz. Ties and source rows proposed for multiple events are marked ambiguous with candidate source details. Missing or out-of-tolerance records stay unmatched. The browser signal itself is the 20 Hz derivative.
- Seed `oof_predictions.npz` files contain logits, soft targets, and A1/A2 arrays, but no patient ID, action, duration, or event identifier. The converter retains array order and labels the rows as unidentified; it does not link them to HDF5 or patient metadata.
- Seed `experiment_metrics.yml` files contain aggregate final-test metrics but not all final-test event predictions. The package includes aggregate metrics without inventing event rows.
- Full per-event OOF/test inspection with patient and waveform links requires future training exports to include stable event identifiers, patient/action/labels, and final-test logits or probabilities.
- The six-channel HDF5 `X` signals are original GW4 at 100 Hz and remain offline. The shared package serves a filtered 20 Hz derivative plus 100 Hz-derived band-power summaries. The run config's 64 Hz is the model's separate resampled input. Armband signals are 50 Hz but are not present in this HDF5 `X` schema and are not part of this package.
- Patient metadata codes are preserved as stored. Decode them in the dashboard from the documented codebooks; repeated measurement records remain separate.
- Non-finite aggregate metric values are represented as the explicit strings `"NaN"`, `"Infinity"`, or `"-Infinity"` in JSON because JSON has no non-finite number type.

The generated dataset and run packages contain research data. Keep them outside Git and private. A public object URL would bypass Access on the HTML page; verify that Access protects the data paths and requests before upload.
