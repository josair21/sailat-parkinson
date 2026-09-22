# Agent Instructions

## Mission

Build a new, clean static web project for the Parkinsonian tremor LOSO error-analysis dashboard at `parkinson.sai.lat`.

This is a separate project. Do not import or modify files from the existing dashboard project unless the user explicitly asks. Do not copy raw research data, predictions, annotations, or generated artifacts into GitHub.

## Target architecture

- Static frontend deployed from GitHub to Cloudflare Pages.
- Analysis, filtering, plotting, event inspection, and signal processing run in the visitor's browser.
- No Python application or hosted application functions/API in the deployed site.
- Large converted research data may be served as static files from Cloudflare R2, loaded lazily by the browser.
- Conversion must be a documented, reproducible offline/browser-side workflow. Do not assume the source HDF5 can be used directly without verifying browser library support, memory behavior, and dataset scale.
- Do not commit research data or credentials to GitHub. Ensure data access is appropriately restricted before uploading it to Cloudflare. Static data URLs are public unless an effective access control configuration is verified.

## Scientific integrity

- Do not retrain models or alter frozen thresholds, annotations, or original LOSO results.
- Do not infer missing metadata or treat annotator disagreement as ordinary ground truth.
- Consensus is `a1 == a2`; only consensus events enter consensus metrics. Preserve disagreements and show A1/A2 separately, with soft target `(a1 + a2) / 2`.
- Use the selected run's stored threshold; never optimize a threshold in the dashboard.
- For single-class patients, show relevant recall/specificity and FNR/FPR, and mark conventional balanced accuracy as not applicable.
- Keep observations distinct from hypotheses. A model probability or waveform alone does not establish a labeling error.
- Clearly label signal provenance and preprocessing state. Use true time axes, readable Acc/Gyr plots, and scientifically appropriate PSD calculations.

## Data handling

- Preserve original HDF5, NPZ, CSV, annotation, report, and configuration files unchanged.
- Never infer unavailable fields or silently coerce unknown schema variants.
- Measure source and converted sizes before choosing a format or storage layout.
- Load metadata and summaries first; fetch event signals only when selected.
- Validate schema, lengths, units, sampling rate, and round-trip fidelity during conversion.
- Keep generated conversion outputs out of source control; document paths and reproducibility.

## Workflow

- Read `PROJECT_STATE.md` and `PLAN.md` before implementation decisions.
- Inspect the new project structure and check Git status before edits.
- Make minimal, reversible changes. Do not overwrite unrelated files or bring over residual files from the previous project.
- Do not deploy, upload research data, or configure public access without explicit authorization.
- Do not add tests or run them unless asked to verify/test; report what was actually verified.
