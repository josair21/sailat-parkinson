# Offline run conversion

`scripts/convert_loso_run.py` packages one experiment for browser-side analysis. It reads the existing `liveserver` LOSO outputs, each selected seed's OOF artifacts, the HDF5 signal source, and the A1 metadata CSV. It never writes to those inputs. It omits model weights and scalers.

Run it from the `parkinson.sai.lat` project using the existing `mpy11` environment:

```powershell
micromamba run -n mpy11 python scripts/convert_loso_run.py `
  --run-root "C:\Users\Josue\Documents\liveserver\runs\6ch_pretrain_weak" `
  --loso-run loso_seed42 `
  --hdf5 "C:\Users\Josue\Documents\liveserver\data\unfiltered_full_epochs_dual_labels.h5" `
  --metadata-csv "C:\Users\Josue\Documents\liveserver\data\A1-Protocol-Metadata.csv" `
  --signal-sampling-rate-hz 100 `
  --output "C:\Users\Josue\Documents\parkinson-data\6ch_pretrain_weak"
```

The destination must not already exist. The converter builds a temporary sibling directory and renames it into place only after conversion succeeds. Keep the destination outside this Git repository; upload it separately only after Cloudflare Access covers both the dashboard and its data requests.

## Output layout

```text
6ch_pretrain_weak/
  manifest.json                 run metadata, threshold, patients, seed index, source hashes
  conversion_report.json        counts, sizes, and data-availability notes
  patients/<patient-id>.json    patient metadata and global LOSO event predictions
  seed-results/seed_<seed>.json per-seed OOF predictions and final-test metrics
  signals/h5_<index>.f32.gz     selected source signal arrays, fetched only for inspection
```

Patient and seed JSON are small indexable records. Each distinct HDF5 signal is written once as row-major, interleaved little-endian float32 in gzip. The browser can request only the selected signal. The manifest gives channel order, units, sample counts, and explicit signal provenance.

The selected LOSO threshold comes from that run's `loso_metadata.yml`. Each seed's OOF and test thresholds/metrics come from that seed's `experiment_metrics.yml`. Thresholds are preserved; the converter does not tune them. Patient class metrics should be computed from consensus events in the dashboard, with balanced accuracy marked N/A for single-class patients.

## Available result detail and limits

- The global LOSO `predictions.npz` files contain patient, action, labels, probability, and duration, so they can be joined to patient metadata and offered for signal inspection.
- Seed `oof_predictions.npz` files contain logits, soft targets, and A1/A2 arrays, but no patient ID, action, duration, or source-event identifier. The converter retains array order and labels the events as unidentified; it does not join them to HDF5 or patient metadata.
- The seed `experiment_metrics.yml` files contain aggregate final-test metrics, but not all final-test event predictions. The package includes those aggregate metrics without inventing event rows.
- To enable per-event OOF/test inspection with patient and waveform links, future training exports need stable event identifiers plus patient/action/labels for OOF and final test, and final-test logits or probabilities. This converter cannot recover fields absent from the source artifacts.
- The HDF5 `X` group has six numeric channels. The 100 Hz rate applies to the original GW4 signal; 64 Hz in the model config is the resampled model input. The converter stores the HDF5 data as found and does not resample or filter it. Armband signals at 50 Hz are not part of this six-channel `X` schema and are not included.
- Signal linking uses exact patient/action/A1/A2 fields, then compares HDF5 sample-count duration at the explicit 100 Hz source rate with the prediction duration. Ties and source rows claimed by multiple prediction events are marked ambiguous, with candidate source details retained. Missing or out-of-tolerance records stay unmatched. Review `conversion_report.json` and the event statuses before relying on signal links.

The source HDF5 and metadata remain unchanged. The generated files contain research data and must be stored privately. A public R2/object URL would bypass an Access policy on the HTML page, so verify data-request protection before uploading or publishing the package.
