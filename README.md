# Parkinson Results Analysis

Static browser dashboard for inspecting Parkinsonian tremor LOSO predictions, per-seed OOF results, final-test metrics, and selected source signals. Analysis and plots run in the browser. The local HTTP server below only serves static files.

## Local workspace

Open the site and select the matching converted dataset ZIP and one run JSON in the two upload blocks. The browser keeps a local IndexedDB copy for up to 24 hours so a refresh can restore the workspace. The files are not uploaded to the web server. Use **Forget saved files** to remove the browser copy; the dataset ZIP and run JSON in ignored `local-data/` are unaffected.

Start the static server from this project directory:

```powershell
micromamba run -n mpy11 python -m http.server 8765 --bind 127.0.0.1
```

Open <http://127.0.0.1:8765/>. Stop the server with Ctrl+C. It listens only on loopback.

## Refresh data

Use the two-step process in [CONVERSION.md](CONVERSION.md): convert shared HDF5 signals and metadata once, then convert each new run against that shared dataset package. Load the generated ZIP and JSON directly in the dashboard; never put personal data in Git.

The global LOSO package includes event predictions and source-match status. Seed OOF rows currently have only array indices and labels; final-test outputs contain aggregate metrics without event-level predictions. The UI shows those source limits explicitly.

## Deployment

The site is static and has no application API. Research data must stay in private storage separate from GitHub. Before deployment, configure access for both the page and every data URL, then point a catalog at the shared dataset and run packages. Do not rely on hidden URLs as access control.
