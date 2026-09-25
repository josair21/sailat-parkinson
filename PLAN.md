# Project Plan

## Goal

Build and deploy a clean, static, browser-side LOSO inspection dashboard at `parkinson.sai.lat`, with no always-on user machine and no hosted application functions. Keep personal data and credentials out of GitHub; only non-identifying processed aggregates may be stored there under `AGENTS.md`.

## Phase 1: Inventory and constraints

1. Locate the source HDF5, prediction runs, metadata, schemas, and documentation without modifying them.
2. Record file sizes, event/sample counts, array shapes, dtypes, units, sampling rates, and available identifiers.
3. Determine the minimum data required for summaries versus selected-event inspection.
4. Confirm institutional permission and data handling requirements for Cloudflare storage and browser delivery.
5. Check current Cloudflare Free limits and select a design that fits measured data sizes.

**Deliverable:** data inventory and an approved storage/access decision; no data uploaded yet.

## Phase 2: Static data format and conversion workflow

1. Compare browser-readable options using measured requirements. Candidate approach: small JSON/Parquet summary tables plus compressed typed-array chunks for signals.
2. Keep patient/event-level data out of GitHub even after conversion. Only non-identifying processed aggregates may be stored there; keep other converted data in an appropriately protected store.
3. Define stable identifiers and explicit schema/version metadata; preserve missing values rather than inventing them.
4. Build a reproducible offline or browser-local conversion process that reads source files and emits static assets. Conversion can use local tooling, but the deployed dashboard must not require Python or a server function.
5. Validate counts, labels, event matching, units, sampling/time axes, and representative signal values against the unchanged source data.
6. Split assets for lazy loading and test peak browser memory and transfer size.

**Deliverable:** documented conversion specification, validation report, and reproducible processed packages, with personal data stored only in an appropriately protected location.

## Phase 3: Access and storage design

1. Decide whether the dashboard/data are public or restricted to named researchers.
2. For restricted data, choose and verify an access mechanism that protects both the site and its data assets; do not rely on obscurity of URLs.
3. Store larger static assets in R2 and configure the browser to request only the selected patient's/event's data.
4. Keep credentials and upload tokens out of client code and Git. Upload through a controlled local process or Cloudflare's supported tooling.
5. Document backup, replacement, and deletion procedures for converted data.

**Deliverable:** private/public access decision, configured storage, and a safe repeatable upload procedure.

## Phase 4: Client-side dashboard

1. Build a lightweight static frontend compatible with Cloudflare Pages and `parkinson.sai.lat`.
2. Implement run and patient selection, decoded metadata, class composition, valid patient metrics, event table, probability plot, selected-event Acc/Gyr plots, and PSD.
3. Preserve scientific rules in `AGENTS.md` and `PROJECT_STATE.md`; keep formulas and undefined-value behavior documented.
4. Load summaries first and selected signal chunks on demand; make missing/corrupt assets visible with clear errors.
5. Add reference-event comparison only after the core inspection flow works.

**Deliverable:** local static build that can inspect representative converted data entirely in the browser.

## Phase 5: Deploy and validate

1. Connect the clean GitHub repository to Cloudflare Pages; deploy code only from GitHub.
2. Configure `parkinson.sai.lat` as the custom domain.
3. Upload converted data separately and verify access controls and CORS/browser loading.
4. Validate patients 2065, 1607, and 1834 using stored annotations and predictions; do not infer labels from diagnosis.
5. Verify direct data URLs are inaccessible to unauthorized users if the project is restricted.
6. Document deployment, data refresh, conversion, and rollback procedures.

**Deliverable:** deployed static site and reproducible operations documentation.

## Decisions / gates

- Do not upload research data until storage permission and access-control design are confirmed.
- Do not pick final formats or promise the Cloudflare Free tier fits until the source and converted sizes are measured.
- Do not port every existing screen before the core patient/event inspection workflow is usable.
- Do not deploy publicly until the data exposure model has been verified.

## Current status

- Phase 1 inventory has begun using the read-only `liveserver` source. The selected `6ch_pretrain_weak` example has five per-seed OOF/test metric folders and a `loso_seed42` global prediction folder. The source HDF5 is 88.6 MB.
- Offline conversion is split into a one-time shared dataset package and small per-run result packages. New runs reference the same content-derived `dataset_id`; see `CONVERSION.md`.
- The shared dataset converter emits filtered 20 Hz signal previews, 0–20 Hz Welch spectra, and band-power summaries computed from the 100 Hz source. It preserves every source HDF5 row, action string, and A1/A2 label pair, including transition actions. Schema v3 packages are generated locally under ignored `local-data/v3/`; original-rate waveforms remain offline.
- A static local UI now covers Global LOSO, per-seed OOF, and final-test aggregate metrics. The static server listens on loopback at port 8765.
- Global LOSO now includes run-wide per-action and filename-side metrics from a precomputed summary. Only binary consensus events contribute to performance metrics; disagreement and side-assignment coverage are reported separately. Actions without event predictions in this LOSO artifact cannot receive prediction metrics.
- OOF per-event identities and final-test per-event predictions are not present in the current artifacts. Full patient/event-level OOF/test inspection requires future training exports with identifiers and predictions.
- Before running conversion, review HDF5 event-match ambiguity. Before uploading, establish the Cloudflare Access path for both app and data, authorization, and retention policy.
