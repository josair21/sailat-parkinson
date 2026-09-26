const state = {
  catalog: null,
  dataset: null,
  datasetBase: null,
  run: null,
  stratifiedSummary: null,
  runBase: null,
  runChoice: null,
  patient: null,
  patientData: null,
  selectedEventId: null,
  selectedSeed: null,
  selectedSeedTab: "overview",
  seedOofView: "events",
  selectedSeedPatient: null,
  seedTestView: "summary",
  selectedHoldoutPatient: null,
  holdoutHeaderSort: null,
  holdoutHeaderDirection: "desc",
  holdoutReturnState: null,
  seedSignalIndexPromise: null,
  seedPatientMetadata: new Map(),
  holdoutOpenToken: 0,
  seedRecords: new Map(),
  split: "oof",
  activeView: "global",
  globalTab: "overview",
  cohortRecords: new Map(),
  patientSignalRecords: new Map(),
  cohortLoaded: false,
  cohortLoading: false,
  cohortToken: 0,
  cohortHeaderSort: null,
  cohortHeaderDirection: "desc",
  actionChartLoaded: false,
  actionChartLoading: false,
  actionChartToken: 0,
  signalToken: 0,
  signalChannels: null,
  signalSourceChannels: null,
  signalElapsedTime: null,
  signalFrequencySummary: null,
  signalSpectrum: null,
  signalOriginalSpectrum: null,
  datasetArchive: null,
  datasetFiles: new Map(),
  datasetRoot: "",
  uploadedDataset: null,
  uploadedRun: null,
  uploadedRuns: [],
  addingRuns: false,
  currentRunIndex: 0,
  workspaceCached: false,
  cacheDisabledForSession: false,
  datasetUploadName: "dataset.zip",
  runUploadName: "run.json",
  runUploadText: null,
};

const WORKSPACE_DB = "parkinson-local-workspace";
const WORKSPACE_STORE = "workspaces";
const WORKSPACE_KEY = "active";
const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[char]));
const fmt = (value, digits = 3) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const fmtPct = (value) => typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A";

function applyTheme(preference) {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111922" : "#f5f7fa");
  if (state.patientData) renderProbabilityPlot();
  if (state.activeView === "seeds" && state.selectedSeedTab !== "overview") renderSeedView();
  if (state.signalChannels && state.dataset?.signal) {
    const channels = state.signalChannels, rate = state.dataset.signal.sampling_rate_hz;
    drawTimeSeries($("#acc-canvas"), channels, rate, 0, "m/s²", state.signalElapsedTime);
    drawTimeSeries($("#gyr-canvas"), channels, rate, 3, "deg/s", state.signalElapsedTime);
    const reference=$("#signal-source-psd")?.checked?state.signalOriginalSpectrum:null;
    drawPSD($("#acc-psd-canvas"), state.signalSpectrum, 0, reference);
    drawPSD($("#gyr-psd-canvas"), state.signalSpectrum, 3, reference);
    drawBandPowerBars($("#acc-band-canvas"), state.signalFrequencySummary, 0);
    drawBandPowerBars($("#gyr-band-canvas"), state.signalFrequencySummary, 3);
  }
}

function isDarkTheme() { return document.documentElement.dataset.theme === "dark"; }

async function fetchJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} while loading ${url}`);
  return response.json();
}

function parseZipDirectory(buffer) {
  const view = new DataView(buffer);
  const lower = Math.max(0, view.byteLength - 22 - 0xffff);
  let endOffset = -1;
  for (let offset = view.byteLength - 22; offset >= lower; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error("The dataset file is not a valid ZIP archive.");
  const count = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  let offset = view.getUint32(endOffset + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || offset === 0xffffffff) {
    throw new Error("ZIP64 dataset archives are not supported by this browser loader.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = new Map();
  const end = offset + directorySize;
  while (offset < end) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("The dataset ZIP has a damaged central directory.");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameBytes = new Uint8Array(buffer, offset + 46, nameLength);
    const name = decoder.decode(nameBytes).replaceAll("\\", "/");
    if (flags & 1) throw new Error(`Encrypted ZIP entries are not supported (${name}).`);
    if (![0, 8].includes(method)) throw new Error(`Unsupported ZIP compression method ${method} (${name}).`);
    if (!name.endsWith("/")) entries.set(name, { method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function safeArchivePath(path) {
  const parts = String(path || "").replaceAll("\\", "/").split("/");
  const clean = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("A dataset reference points outside the ZIP archive.");
    clean.push(part);
  }
  return clean.join("/");
}

async function readDatasetFile(relativePath) {
  if (!state.datasetArchive) throw new Error("Choose a dataset ZIP first.");
  const path = safeArchivePath(`${state.datasetRoot}/${relativePath}`);
  const entry = state.datasetFiles.get(path);
  if (!entry) throw new Error(`Dataset archive is missing ${relativePath}.`);
  const view = new DataView(state.datasetArchive);
  const local = entry.localOffset;
  if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`Invalid ZIP entry header for ${relativePath}.`);
  const dataOffset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const compressed = new Uint8Array(state.datasetArchive, dataOffset, entry.compressedSize);
  let bytes;
  if (entry.method === 0) bytes = compressed;
  else {
    if (!window.DecompressionStream) throw new Error("This browser cannot decompress ZIP files; use a recent version of Chrome or Edge.");
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      throw new Error(`Could not decompress ${relativePath}: ${error.message || error}`);
    }
  }
  if (bytes.byteLength !== entry.size) throw new Error(`ZIP entry length mismatch for ${relativePath}.`);
  return bytes;
}

async function readDatasetJSON(relativePath) {
  const bytes = await readDatasetFile(relativePath);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function openWorkspaceDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("This browser does not support local workspace storage."));
    const request = indexedDB.open(WORKSPACE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(WORKSPACE_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local workspace storage."));
  });
}

async function withWorkspaceStore(mode, action) {
  const db = await openWorkspaceDB();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(WORKSPACE_STORE, mode);
      const store = transaction.objectStore(WORKSPACE_STORE);
      const request = action(store);
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error || request?.error || new Error("Local workspace storage failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Local workspace storage was interrupted."));
    });
  } finally { db.close(); }
}

async function saveWorkspaceCopy() {
  if (!state.datasetArchive || !state.uploadedRuns.length) return false;
  const now = Date.now();
  const saved = {
    id: WORKSPACE_KEY,
    datasetName: state.datasetUploadName,
    datasetBlob: new Blob([state.datasetArchive], { type: "application/zip" }),
    runName: state.runUploadName,
    runText: state.runUploadText,
    runs: state.uploadedRuns.map((item)=>({name:item.name,text:item.text})),
    savedAt: now,
    expiresAt: now + WORKSPACE_TTL_MS,
  };
  await withWorkspaceStore("readwrite", (store) => store.put(saved));
  state.workspaceCached = true;
  return true;
}

async function cacheSelectedPair() {
  if (!state.uploadedDataset || !state.uploadedRuns.length) return;
  if (state.uploadedRuns.some((item)=>item.run.dataset_id !== state.uploadedDataset.dataset_id)) {
    $("#upload-status").textContent = "At least one run does not match this dataset. Choose runs made for this dataset.";
    return;
  }
  try {
    if (!state.workspaceCached) await saveWorkspaceCopy();
    $("#forget-data-button").disabled = false;
    $("#upload-status").textContent = `Dataset and ${state.uploadedRuns.length} run${state.uploadedRuns.length===1?"":"s"} saved in this browser until ${new Date(Date.now() + WORKSPACE_TTL_MS).toLocaleString()}.`;
  } catch (error) {
    $("#upload-status").textContent = `Files are ready, but this browser could not save a refresh copy: ${error.message || error}`;
  }
}

async function forgetWorkspaceCopy() {
  await withWorkspaceStore("readwrite", (store) => store.delete(WORKSPACE_KEY));
  state.workspaceCached = false;
  state.cacheDisabledForSession = true;
  $("#forget-data-button").disabled = true;
  $("#upload-status").textContent = "Saved browser copy deleted.";
}

async function restoreWorkspaceCopy() {
  let saved;
  try { saved = await withWorkspaceStore("readonly", (store) => store.get(WORKSPACE_KEY)); }
  catch { return; }
  if (!saved) return;
  if (!saved.expiresAt || saved.expiresAt <= Date.now()) {
    try { await forgetWorkspaceCopy(); } catch {}
    $("#upload-status").textContent = "The saved browser copy expired. Select the files again.";
    return;
  }
  try {
    state.datasetUploadName = saved.datasetName || "dataset.zip";
    state.runUploadName = saved.runName || "run.json";
    state.runUploadText = saved.runText;
    await loadDatasetUpload(saved.datasetBlob);
    await loadRunUpload(saved.runs?.length?saved.runs:[{name:state.runUploadName,text:saved.runText}]);
    $("#dataset-file-name").textContent = state.datasetUploadName;
    $("#run-file-name").textContent = state.runUploadName;
    $("#upload-status").textContent = `Restored local copy · expires ${new Date(saved.expiresAt).toLocaleString()}`;
    $("#forget-data-button").disabled = false;
    $("#open-workspace-button").disabled = false;
    state.workspaceCached = true;
    await openUploadedWorkspace({ remember: false });
  } catch (error) {
    try { await forgetWorkspaceCopy(); } catch {}
    $("#upload-status").textContent = `Saved copy could not be opened: ${error.message || error}. Select the files again.`;
    $("#loading-state").classList.remove("hidden");
    $("#error-state").classList.add("hidden");
  }
}

async function runRecord(item) {
  if (item?.data && typeof item.data === "object") return item.data;
  if (!item?.data_ref) throw new Error("Run record has no embedded data or data_ref.");
  return fetchJSON(new URL(item.data_ref, state.runBase));
}

async function fetchGzipArrayBuffer(url) {
  let compressed;
  if (state.datasetArchive) compressed=await readDatasetFile(url);
  else {
    const response = await fetch(url, {cache:"force-cache"});
    if (!response.ok) throw new Error(`Asset request failed (${response.status})`);
    compressed=new Uint8Array(await response.arrayBuffer());
  }
  if (!("DecompressionStream" in window)) throw new Error("This browser does not support gzip stream decompression.");
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function urlFrom(base, relative) {
  return new URL(relative, base);
}

function showError(error) {
  console.error(error);
  $("#loading-state").classList.add("hidden");
  $("#dashboard").classList.add("hidden");
  $("#error-state").classList.remove("hidden");
  $("#error-message").textContent = error.message || String(error);
}

async function loadDatasetUpload(file) {
  if (!file) return;
  state.datasetUploadName = file.name || state.datasetUploadName;
  const buffer = await file.arrayBuffer();
  const entries = parseZipDirectory(buffer);
  const manifests = [...entries.keys()].filter((path) => path.endsWith("manifest.json"));
  if (manifests.length !== 1) throw new Error(`Expected one dataset manifest in the ZIP; found ${manifests.length}.`);
  const manifestPath = manifests[0];
  const root = manifestPath.slice(0, manifestPath.lastIndexOf("manifest.json"));
  const entry = entries.get(manifestPath);
  const previousArchive = state.datasetArchive, previousFiles = state.datasetFiles, previousRoot = state.datasetRoot;
  state.datasetArchive = buffer; state.datasetFiles = entries; state.datasetRoot = root;
  try {
    const manifest = await readDatasetJSON("manifest.json");
    if (!manifest.dataset_id || !manifest.signal || !manifest.signals_index_ref) throw new Error("The ZIP does not contain a supported converted dataset manifest.");
    state.uploadedDataset = manifest;
  } catch (error) {
    state.datasetArchive = previousArchive; state.datasetFiles = previousFiles; state.datasetRoot = previousRoot;
    throw error;
  }
}

async function loadRunUpload(file, {append = false} = {}) {
  if (!file) return;
  const files=Array.isArray(file)?file:[file];
  const uploads=[];
  for(const item of files) {
    const sourceText=typeof item.text==="function"?await item.text():item.text;
    const run=JSON.parse(sourceText);
    if (!run.dataset_id || !Array.isArray(run.patients) || !Array.isArray(run.seed_results)) {
      throw new Error(`${item.name||"A selected file"} is not a supported converted run JSON.`);
    }
    uploads.push({name:item.name||"run.json",text:sourceText,run});
  }
  if(!uploads.length)throw new Error("Choose at least one converted run JSON file.");
  const previous=append?state.uploadedRuns:[];
  const datasetIds=new Set([...previous,...uploads].map((item)=>item.run.dataset_id));
  if(datasetIds.size!==1)throw new Error("All selected run files must use the same dataset.");
  const additions=append?uploads.filter((item)=>!previous.some((existing)=>existing.name===item.name&&existing.text===item.text)):uploads;
  if(append&&!additions.length)throw new Error("Those run files are already loaded.");
  state.uploadedRuns=[...previous,...additions];
  state.uploadedRun=state.uploadedRuns[0].run;
  state.runUploadText=state.uploadedRuns[0].text;
  state.runUploadName=state.uploadedRuns.map((item)=>item.name).join(", ");
  return previous.length;
}

function renderRunSelector(selectedIndex = 0) {
  state.catalog = { runs: state.uploadedRuns.map((item)=>({label:`${item.run.run_family||item.run.run_id||"Run"} · ${item.name}`})), seedCount:state.uploadedRuns.reduce((total,item)=>total+item.run.seed_results.length,0) };
  const selector=$("#run-select");
  selector.innerHTML=state.catalog.runs.map((run,index)=>`<option value="${index}">${escapeHTML(run.label)}</option>`).join("")+`<option value="__add_run__">＋ Add run file…</option>`;
  selector.disabled=false;
  selector.value=String(selectedIndex);
}

async function openUploadedWorkspace({ remember = true } = {}) {
  $("#error-state").classList.add("hidden");
  try {
    if (!state.uploadedDataset || !state.uploadedRuns.length) throw new Error("Select the dataset ZIP and at least one run JSON.");
    const mismatched=state.uploadedRuns.find((item)=>item.run.dataset_id!==state.uploadedDataset.dataset_id);
    if (mismatched) {
      throw new Error(`Dataset mismatch: ${mismatched.name} expects ${mismatched.run.dataset_id}, but the ZIP contains ${state.uploadedDataset.dataset_id}.`);
    }
    if (remember && !state.workspaceCached && !state.cacheDisabledForSession) {
      try { await saveWorkspaceCopy(); } catch (error) { console.warn("Could not cache the workspace in this browser:", error); }
    }
    state.dataset = state.uploadedDataset;
    renderRunSelector(0);
    $("#dataset-status").textContent = `${state.dataset.counts?.signals ?? "—"} source records · ${(state.dataset.dataset_id || "").slice(0, 10)}`;
    $("#global-count").textContent = "LOSO";
    $("#seed-count").textContent = String(state.catalog.seedCount || "—");
    $("#loading-state").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    $("#change-data-button").classList.remove("hidden");
    $("#forget-data-button").disabled = !state.workspaceCached;
    await selectRun(0);
  } catch (error) { showError(error); }
}

async function selectRun(index) {
  closeHoldoutPatient();
  state.holdoutHeaderSort=null;
  state.holdoutHeaderDirection="desc";
  state.runChoice = state.catalog.runs[index];
  state.runBase = new URL(".", location.href);
  const uploaded=state.uploadedRuns[index];
  if(!uploaded)throw new Error("The selected run is not loaded.");
  state.currentRunIndex=index;
  $("#run-select").value=String(index);
  state.run=uploaded.run;
  state.uploadedRun=uploaded.run;
  state.runUploadText=uploaded.text;
  state.runUploadName=uploaded.name;
  state.seedSignalIndexPromise = null;
  state.seedPatientMetadata.clear();
  if (state.run.dataset_id !== state.dataset.dataset_id) {
    throw new Error(`Run expects dataset ${state.run.dataset_id}, but catalog loaded ${state.dataset.dataset_id}.`);
  }
  const hasLoso=Array.isArray(state.run.patients)&&state.run.patients.length>0;
  state.activeView=hasLoso?"global":"seeds";
  state.globalTab="overview";
  state.selectedSeedTab="overview";
  $("#global-nav-item").classList.toggle("hidden",!hasLoso);
  document.querySelectorAll(".nav-item").forEach((button)=>{const active=button.dataset.view===state.activeView;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));});
  $("#global-view").classList.toggle("hidden",!hasLoso);
  $("#seed-view").classList.toggle("hidden",hasLoso);
  $("#global-controls").classList.add("hidden");
  state.stratifiedSummary = state.run.stratified_summary || null;
  $("#threshold-chip b").textContent = fmt(state.run.threshold, 3);
  $("#seed-count").textContent = String(state.run.seed_results?.length ?? 0);
  if(hasLoso)populatePatients();
  else{state.patient=null;state.patientData=null;$("#patient-select").replaceChildren(new Option("No LOSO patient data",""));$("#patient-select").disabled=true;}
  state.seedRecords.clear();
  state.patientData = null;
  state.cohortRecords.clear();
  state.patientSignalRecords.clear();
  state.cohortLoaded = false;
  state.cohortLoading = false;
  state.cohortToken++;
  state.cohortHeaderSort = null;
  state.cohortHeaderDirection = "desc";
  state.actionChartLoaded = false;
  state.actionChartLoading = false;
  state.actionChartToken++;
  $("#global-controls").classList.toggle("hidden", state.activeView !== "global" || state.globalTab !== "subject");
  renderGlobalKpis();
  renderStratifiedSummary();
  if (hasLoso&&state.patient) await selectPatient(state.patient);
  if (state.globalTab === "overview" && state.activeView === "global") {
    await Promise.all([loadActionBoxplotData(),renderLosoPerformanceSummary()]);
  }
  if (state.globalTab === "cohort" && state.activeView === "global") await loadCohortRecords();
  if (state.activeView === "seeds") await prepareSeeds();
}

function renderStratifiedSummary() {
  const summary = state.stratifiedSummary;
  const renderRows = (groups) => {
    if (!groups?.length) return '<tr><td colspan="10" class="empty-cell">No grouped results available.</td></tr>';
    return groups.map((row) => `<tr><td>${escapeHTML(row.group)}</td><td>${row.event_count}</td><td>${row.consensus_count}</td><td>${row.disagreement_count}</td><td>${row.nonbinary_consensus_count}</td><td>${fmtPct(row.recall)}</td><td>${fmtPct(row.specificity)}</td><td>${fmtPct(row.fnr)}</td><td>${fmtPct(row.fpr)}</td><td>${fmtPct(row.balanced_accuracy)}</td></tr>`).join("");
  };
  $("#action-results-rows").innerHTML = renderRows(summary?.by_action);
  $("#dominance-results-rows").innerHTML = renderRows(summary?.by_filename_side);
  $("#stratified-threshold").textContent = summary ? `Stored threshold ${fmt(summary.threshold, 3)}` : "Summary unavailable";
  const coverage = summary?.side_coverage;
  $("#dominance-results-note").textContent = summary
    ? `Action results include only actions with event predictions in this run; source actions without predictions cannot have model metrics here. Filename convention: .00 = Non-dominant; .01 = Dominant. Events count only when candidate filenames agree on side. ${coverage.assigned_events} assigned; ${coverage.no_candidate_events} without candidates; ${coverage.uncertain_candidate_side_events} with mixed or unrecognized candidate sides. Ambiguous signal identity may still remain.`
    : "Action results require stored event predictions. Dominance groups require recognized, consistent source filename suffixes; unknown and mixed candidate sides are excluded.";
}

function populatePatients() {
  const patients = state.run.patients || [];
  const preferred = patients.some((p) => p.patient_id === "2065") ? "2065" : patients[0]?.patient_id;
  $("#patient-select").innerHTML = patients.map((p) => `<option value="${escapeHTML(p.patient_id)}">${escapeHTML(p.patient_id)} · ${p.event_count} events</option>`).join("");
  $("#patient-select").disabled = !patients.length;
  if (preferred) {
    state.patient = preferred;
    $("#patient-select").value = preferred;
  }
  if (state.run.seed_results?.length && !state.run.seed_results.some((entry) => String(entry.seed) === String(state.selectedSeed))) state.selectedSeed = String(state.run.seed_results[0].seed);
}

async function selectPatient(patientId) {
  state.patient = patientId;
  state.selectedEventId = null;
  $("#patient-select").value = patientId;
  const info = state.run.patients.find((item) => String(item.patient_id) === String(patientId));
  if (!info) return;
  const record = state.cohortRecords.get(String(patientId)) || await runRecord(info);
  state.cohortRecords.set(String(patientId), record);
  if (record.shared_metadata_ref && !Array.isArray(record.metadata_records)) {
    const metadataRecord = await readDatasetJSON(record.shared_metadata_ref);
    record.metadata_records = metadataRecord.metadata_records || [];
  }
  const sourceSignals=await sourceSignalsForPatient(patientId);
  record.source_transition_events=transitionSignalEvents(sourceSignals,record.events||[]);
  state.patientData = record;
  renderPatient();
  updateGlobalHeading();
}

async function sourceSignalsForPatient(patientId) {
  const id=String(patientId);
  let sourceSignals=state.patientSignalRecords.get(id);
  if(!sourceSignals){
    const pattern=state.dataset.patient_signals_ref_pattern;
    if(pattern){
      const ref=pattern.replace("<patient-id>",encodeURIComponent(id));
      try{sourceSignals=(await readDatasetJSON(ref)).signals||[];}
      catch(error){
        const message=String(error.message||error);
        if(!message.includes("404")&&!message.includes("Dataset archive is missing"))throw error;
      }
    }
    if(!sourceSignals){
      const index=await readDatasetJSON(state.dataset.signals_index_ref);
      sourceSignals=(index.signals||[]).filter((row)=>String(row.patient_id)===id);
    }
    state.patientSignalRecords.set(id,sourceSignals);
  }
  return sourceSignals.filter((row)=>String(row.patient_id)===id);
}

function transitionSignalEvents(sourceSignals,predictionEvents) {
  const isWatch4=(row)=>{
    const device=String(row?.device||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    return device==="smartwatch"||device==="galaxywatch4"||device==="gw4";
  };
  const normalizeAction=(action)=>String(action||"").trim().toLowerCase().replace(/[ _]+/g,"-");
  const predictionSources=predictionEvents.flatMap((event)=>{
    const candidates=(event.signal_match?.candidates||[]).filter(isWatch4);
    if(candidates.length!==1)return [];
    const source=candidates[0];
    if(!source.source_file||!Number.isFinite(source.start_elapsed_time_s)||!Number.isFinite(source.end_elapsed_time_s))return [];
    return [{event,source}];
  });
  return sourceSignals
    .filter((row)=>String(row.action).trim().toLowerCase()==="transition"&&isWatch4(row))
    .filter((row)=>{
      if(!row.source_file||!Number.isFinite(row.start_elapsed_time_s)||!Number.isFinite(row.end_elapsed_time_s))return false;
      const adjacent=predictionSources.filter(({source})=>source.source_file===row.source_file);
      const previous=adjacent
        .filter(({source})=>source.end_elapsed_time_s<=row.start_elapsed_time_s+1)
        .sort((a,b)=>b.source.end_elapsed_time_s-a.source.end_elapsed_time_s)[0];
      const following=adjacent
        .filter(({source})=>source.start_elapsed_time_s>=row.end_elapsed_time_s-1)
        .sort((a,b)=>a.source.start_elapsed_time_s-b.source.start_elapsed_time_s)[0];
      const nextEpoch=normalizeAction(row.next_epoch);
      const followingMatches=normalizeAction(following?.event.action)===nextEpoch
        ||normalizeAction(following?.source.previous_epoch)===nextEpoch;
      return Boolean(previous&&following
        &&normalizeAction(previous.event.action)===normalizeAction(row.previous_epoch)
        &&followingMatches);
    })
    .map((row)=>({
      event_id:`transition-${row.source_h5_index}`,
      action:row.action,
      source_h5_index:row.source_h5_index,
      device:row.device,
      source_filename:row.source_filename,
      source_file:row.source_file,
      previous_epoch:row.previous_epoch,
      next_epoch:row.next_epoch,
      nearest_transition_index:row.nearest_transition_index,
      start_elapsed_time_s:row.start_elapsed_time_s,
      end_elapsed_time_s:row.end_elapsed_time_s,
      start_timestamp_us:row.start_timestamp_us,
      end_timestamp_us:row.end_timestamp_us,
      transition_source:true,
      signal_match:{status:"matched",candidates:[row]},
    }));
}

function metaValue(row, key) {
  return row?.[key] === null || row?.[key] === undefined || row[key] === "" ? null : row[key];
}

function codeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decodeCode(value, mapping) {
  const number = codeNumber(value);
  return number !== null && Object.hasOwn(mapping, number) ? mapping[number] : value === null ? "Not recorded" : `Code ${value}`;
}

function decodeAge(value) {
  const code = codeNumber(value);
  if (code === null || !Number.isInteger(code)) return value === null ? "Not recorded" : `Code ${value}`;
  if (code === 0) return "18–20 years";
  const start = 21 + 5 * (code - 1);
  return `${start}–${start + 4} years`;
}

function decodeDuration(value, diagnosis) {
  const diagnosisCode = codeNumber(diagnosis);
  const code = codeNumber(value);
  if (diagnosisCode === 0) return "Not applicable";
  if (code === null || !Number.isInteger(code)) return value === null ? "Not recorded" : String(value);
  if (code === 0) return "0–5 years";
  return `${code * 5 + 1}–${code * 5 + 5} years`;
}

function metadataFields(row) {
  const diagnosis = metaValue(row, "Diagnosis-Coded");
  return [
    ["DIAGNOSIS", decodeCode(diagnosis, {0:"Healthy",1:"Parkinson’s disease",2:"Other movement disorder"})],
    ["AGE RANGE", decodeAge(metaValue(row, "Age-Coded"))],
    ["SEX · CODED", metaValue(row, "Sex-Coded") === null ? "Not recorded" : `Code ${row["Sex-Coded"]}`],
    ["DURATION", decodeDuration(metaValue(row, "Years since Diagnosis-Coded"), diagnosis)],
    ["DOMINANCE · CODED", metaValue(row, "Dominance-Coded") === null ? "Not recorded" : `Code ${row["Dominance-Coded"]}`],
    ["WORST SIDE", decodeCode(metaValue(row, "Worst side - Coded"), {0:"Symmetric",1:"Left",2:"Right"})],
    ["PROTOCOL", metaValue(row, "Protocol") ?? "Not recorded"],
    ["MEASUREMENT", `${metaValue(row, "Mom.") ?? "—"} · ${metaValue(row, "Meas. Year") ?? "—"}`],
  ];
}

function consensusEvents(events) {
  return events.filter((event) => event.a1 === event.a2 && [0, 1].includes(Number(event.a1)));
}

function metricSummary(events) {
  const rows = consensusEvents(events);
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const event of rows) {
    const truth = Number(event.a1), predicted = Number(event.predicted_class);
    if (truth === 1 && predicted === 1) tp++;
    else if (truth === 0 && predicted === 0) tn++;
    else if (truth === 0 && predicted === 1) fp++;
    else if (truth === 1 && predicted === 0) fn++;
  }
  const positives = tp + fn, negatives = tn + fp;
  const recall = positives ? tp / positives : null;
  const specificity = negatives ? tn / negatives : null;
  return {
    total: events.length,
    consensus: rows.length,
    positive: positives,
    negative: negatives,
    disagreement: events.filter((event) => event.a1 !== event.a2).length,
    tp, tn, fp, fn,
    recall,
    specificity,
    balancedAccuracy: recall !== null && specificity !== null ? (recall + specificity) / 2 : null,
    baApplicable: recall !== null && specificity !== null,
    confidentErrors: rows.filter((event) => (event.a1 === 0 && event.probability >= .8) || (event.a1 === 1 && event.probability <= .2)).length,
  };
}

function kpiCard(label, value, note, icon = "·") {
  return `<article class="kpi-card"><div class="kpi-top"><span class="kpi-label">${escapeHTML(label)}</span><span class="kpi-icon">${icon}</span></div><div class="kpi-value">${escapeHTML(value)}</div><div class="kpi-sub">${escapeHTML(note)}</div></article>`;
}

function renderGlobalKpis() {
  const count = state.run?.counts || {};
  const patientCount = state.run?.patients?.length || 0;
  const totals = count.prediction_events || 0;
  const signals = `${count.signals_matched || 0} linked`;
  $("#global-kpis").innerHTML = [
    kpiCard("HELD-OUT PATIENTS", String(patientCount), "Patients in this LOSO result", "◉"),
    kpiCard("PREDICTION EVENTS", String(totals), "Across the selected LOSO run", "⌁"),
    kpiCard("STORED THRESHOLD", fmt(state.run?.threshold, 3), "Read from the selected run", "⊘"),
    kpiCard("SIGNAL MATCHES", signals, `${count.signals_ambiguous || 0} ambiguous · ${count.signals_unmatched || 0} unmatched`, "⌁"),
  ].join("");
}

function renderLosoPerformanceSummary() {
  const summary=state.run?.stratified_summary;
  const groups=summary?.by_action;
  const panel=$("#loso-performance-summary");
  if(!Array.isArray(groups)||!groups.length){panel.classList.add("hidden");return;}
  panel.classList.remove("hidden");
  const total=(key)=>groups.reduce((sum,row)=>sum+(Number.isFinite(row[key])?row[key]:0),0);
  const tp=total("tp"),tn=total("tn"),fp=total("fp"),fn=total("fn");
  const positives=tp+fn,negatives=tn+fp;
  const recall=positives?tp/positives:null;
  const specificity=negatives?tn/negatives:null;
  const balancedAccuracy=recall!==null&&specificity!==null?(recall+specificity)/2:null;
  const precision=tp+fp?tp/(tp+fp):null;
  const f1=2*tp+fp+fn?2*tp/(2*tp+fp+fn):null;
  const events=total("event_count"),consensus=total("consensus_count");
  const excluded=total("disagreement_count")+total("nonbinary_consensus_count");
  const cards=[
    kpiCard("POOLED LOSO BA",balancedAccuracy===null?"N/A":fmtPct(balancedAccuracy),"All binary consensus predictions"),
    kpiCard("RECALL",recall===null?"N/A":fmtPct(recall),`${tp} / ${positives} positive consensus events`),
    kpiCard("SPECIFICITY",specificity===null?"N/A":fmtPct(specificity),`${tn} / ${negatives} negative consensus events`),
    kpiCard("PRECISION",precision===null?"N/A":fmtPct(precision),"Pooled event-level predictions"),
    kpiCard("F1",f1===null?"N/A":fmtPct(f1),"Pooled event-level predictions"),
    kpiCard("ALL INPUT EVENTS",String(events),`${consensus} binary consensus scored · ${excluded} excluded`),
  ];
  $("#loso-performance-kpis").innerHTML=cards.join("");
  $("#loso-performance-threshold").textContent=`Stored LOSO threshold ${fmt(summary.threshold,3)}`;
  $("#loso-performance-note").textContent="Confusion counts are pooled across all held-out patients and actions, not averaged per patient. Only binary consensus events (A1 = A2 in {0, 1}) contribute to performance metrics; disagreements and nonbinary consensus events are excluded.";
}

function renderPatient() {
  const record = state.patientData;
  if (!record) return;
  const events = record.events || [];
  const summary = metricSummary(events);
  const patientInfo = state.run.patients.find((item) => String(item.patient_id) === String(record.patient_id));
  const metadata = record.metadata_ref ? null : record.metadata_records;
  const records = metadata || [];
  const metaCount = record.metadata_match_count ?? records.length;
  $("#patient-avatar").textContent = String(record.patient_id).slice(-4);
  $("#patient-title").textContent = `Patient ${record.patient_id}`;
  $("#patient-subtitle").textContent = `${summary.total} events · ${metaCount} metadata record${metaCount === 1 ? "" : "s"}`;
  if (records.length) {
    const unique = new Map();
    records.forEach((row) => metadataFields(row).forEach(([label, value]) => {
      const key = `${label}:${value}`;
      if (!unique.has(key)) unique.set(key, [label, value]);
    }));
    $("#patient-meta").innerHTML = [...unique.values()].map(([label, value]) => `<div class="meta-item"><span>${escapeHTML(label)}</span><b title="${escapeHTML(value)}">${escapeHTML(value)}</b></div>`).join("");
  } else {
    $("#patient-meta").innerHTML = `<div class="meta-item"><span>METADATA</span><b>${metaCount ? "Shared metadata package" : "Not available"}</b></div>`;
  }
  $("#patient-stats").innerHTML = [
    ["CONSENSUS",String(summary.consensus),`${summary.negative} negative · ${summary.positive} positive`],
    ["BALANCED ACCURACY",summary.baApplicable?fmtPct(summary.balancedAccuracy):"N/A",summary.baApplicable?"Both classes present":"Single-class patient"],
    ["RECALL",summary.recall===null?"N/A":fmtPct(summary.recall),summary.positive?`${summary.tp} / ${summary.positive} positives`:"No positive consensus events"],
    ["SPECIFICITY",summary.specificity===null?"N/A":fmtPct(summary.specificity),summary.negative?`${summary.tn} / ${summary.negative} negatives`:"No negative consensus events"],
    ["DISAGREEMENT",String(summary.disagreement),`${summary.confidentErrors} high-confidence error heuristics`],
  ].map(([label,value,note])=>`<div class="patient-stat"><span>${escapeHTML(label)}</span><b>${escapeHTML(value)}</b><small>${escapeHTML(note)}</small></div>`).join("");
  renderGlobalEvents();
  if (!state.selectedEventId && events.length) state.selectedEventId = events[0].event_id;
  renderProbabilityPlot();
  renderEventTable();
  const selected = events.find((event) => event.event_id === state.selectedEventId);
  renderSelectedEvent(selected);
}

async function loadCohortRecords() {
  if (state.cohortLoaded || state.cohortLoading) return;
  state.cohortLoading = true;
  const token = state.cohortToken;
  $("#cohort-results-count").textContent = "Loading patient summariesâ€¦";
  $("#cohort-rows").innerHTML = '<tr><td colspan="8" class="empty-cell">Loading stored patient summaries and shared metadata. Signal assets are not loaded.</td></tr>';
  try {
    await Promise.all((state.run.patients || []).map(async (patient) => {
      const id = String(patient.patient_id);
      let record = state.cohortRecords.get(id);
      if (!record) {
        record = await runRecord(patient);
        if (token === state.cohortToken) state.cohortRecords.set(id, record);
      }
      if (record.shared_metadata_ref && !Array.isArray(record.metadata_records)) {
        const metadata = await readDatasetJSON(record.shared_metadata_ref);
        if (token === state.cohortToken) record.metadata_records = metadata.metadata_records || [];
      }
    }));
    if (token !== state.cohortToken) return;
    state.cohortLoaded = true;
    renderCohort();
  } catch (error) {
    if (token !== state.cohortToken) return;
    $("#cohort-results-count").textContent = "Could not load cohort";
    $("#cohort-rows").innerHTML = `<tr><td colspan="8" class="empty-cell">${escapeHTML(error.message || error)}</td></tr>`;
  } finally {
    if (token === state.cohortToken) state.cohortLoading = false;
  }
}

async function loadActionBoxplotData() {
  if (state.actionChartLoaded || state.actionChartLoading) return;
  state.actionChartLoading = true;
  const token = state.actionChartToken;
  $("#action-boxplot-status").textContent = "Loading event summariesâ€¦";
  $("#action-boxplot").innerHTML = '<div class="empty-inline">Loading stored event probabilities. Signal assets are not loaded.</div>';
  try {
    await Promise.all((state.run.patients || []).map(async (patient) => {
      const id = String(patient.patient_id);
      if (!state.cohortRecords.has(id)) {
        const record = await runRecord(patient);
        if (token === state.actionChartToken) state.cohortRecords.set(id, record);
      }
    }));
    if (token !== state.actionChartToken) return;
    const events = [...state.cohortRecords.values()].flatMap((record) =>
      (record.events || []).map((event) => ({...event, cohort_patient_id:String(record.patient_id)})));
    state.actionChartLoaded = true;
    const predictionCount = events.filter((event) => typeof event.probability === "number" && Number.isFinite(event.probability)).length;
    $("#action-boxplot-status").textContent = `${predictionCount} stored event probabilities Â· threshold ${fmt(state.run.threshold, 3)}`;
    $("#action-boxplot").innerHTML = makeActionBoxplotSvg(events, state.run.threshold);
    $("#action-boxplot").querySelectorAll(".boxplot-outlier").forEach((point) => {
      const inspect = async () => {
        await selectPatient(point.dataset.patientId);
        setGlobalTab("subject");
        await selectEvent(point.dataset.eventId);
        $("#signal-title").scrollIntoView({behavior:"smooth",block:"start"});
      };
      point.addEventListener("click", () => inspect().catch(showError));
      point.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspect().catch(showError); }
      });
    });
  } catch (error) {
    if (token !== state.actionChartToken) return;
    $("#action-boxplot-status").textContent = "Could not load event summaries";
    $("#action-boxplot").innerHTML = `<div class="empty-inline">${escapeHTML(error.message || error)}</div>`;
  } finally {
    if (token === state.actionChartToken) state.actionChartLoading = false;
  }
}

function probabilityGroup(event) {
  if (event.a1 !== event.a2) return "disagreement";
  if (event.a1 === 0) return "negative";
  if (event.a1 === 1) return "positive";
  return "other";
}

function quantile(sorted, proportion) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * proportion;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function makeActionBoxplotSvg(events, threshold) {
  const groups = [
    {key:"negative", label:"Consensus negative", color:"#318c7d"},
    {key:"positive", label:"Consensus positive", color:"#cc8752"},
    {key:"disagreement", label:"A1/A2 disagreement", color:"#8870b2"},
    {key:"other", label:"Other consensus", color:"#85939e"},
  ];
  const actions = [...new Set(events.map((event) => event.action || "Unknown"))].sort((a, b) => a.localeCompare(b));
  if (!actions.length) return '<div class="empty-inline">No event predictions are available for this run.</div>';
  const width = Math.max(900, 150 + actions.length * 190), height = 360;
  const left = 52, right = 18, top = 24, bottom = 68;
  const plotHeight = height - top - bottom, plotWidth = width - left - right;
  const y = (value) => top + (1 - value) * plotHeight;
  const actionWidth = plotWidth / actions.length;
  const boxWidth = Math.min(21, actionWidth / 5.4);
  const parts = [`<svg class="action-boxplot-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Boxplots of stored tremor probabilities by action and annotation group">`];
  for (let tick = 0; tick <= 4; tick++) {
    const value = tick / 4, yy = y(value);
    parts.push(`<line class="boxplot-grid" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"/><text class="boxplot-axis" x="${left - 9}" y="${yy + 3}" text-anchor="end">${value.toFixed(2)}</text>`);
  }
  const thresholdY = y(threshold);
  parts.push(`<line class="boxplot-threshold" x1="${left}" y1="${thresholdY}" x2="${width - right}" y2="${thresholdY}"/><text class="boxplot-threshold-label" x="${width - right - 2}" y="${thresholdY - 5}" text-anchor="end">threshold ${fmt(threshold, 3)}</text>`);
  actions.forEach((action, actionIndex) => {
    const center = left + actionWidth * (actionIndex + .5);
    const offsetStep = Math.min(31, actionWidth / (groups.length + .5));
    groups.forEach((group, groupIndex) => {
    const centerX = center + (groupIndex - (groups.length - 1) / 2) * offsetStep;
      const groupedEvents = events.filter((event) => (event.action || "Unknown") === action && probabilityGroup(event) === group.key
        && typeof event.probability === "number" && Number.isFinite(event.probability) && event.probability >= 0 && event.probability <= 1)
        .sort((a, b) => a.probability - b.probability);
      const values = groupedEvents.map((event) => event.probability);
      if (values.length) {
        const q1 = quantile(values, .25), median = quantile(values, .5), q3 = quantile(values, .75);
        const lowerFence = q1 - 1.5 * (q3 - q1), upperFence = q3 + 1.5 * (q3 - q1);
        const lower = values.find((value) => value >= lowerFence), upper = [...values].reverse().find((value) => value <= upperFence);
        const boxTop = y(q3), boxBottom = y(q1), half = boxWidth / 2;
        parts.push(`<g class="boxplot-series"><title>${escapeHTML(actionName(action))} Â· ${escapeHTML(group.label)} Â· n=${values.length} Â· median=${fmt(median, 3)}</title>`);
        parts.push(`<line x1="${centerX}" y1="${y(upper)}" x2="${centerX}" y2="${y(lower)}" stroke="${group.color}"/><line x1="${centerX - half / 2}" y1="${y(upper)}" x2="${centerX + half / 2}" y2="${y(upper)}" stroke="${group.color}"/><line x1="${centerX - half / 2}" y1="${y(lower)}" x2="${centerX + half / 2}" y2="${y(lower)}" stroke="${group.color}"/>`);
        parts.push(`<rect x="${centerX - half}" y="${boxTop}" width="${boxWidth}" height="${Math.max(1, boxBottom - boxTop)}" fill="${group.color}" fill-opacity=".2" stroke="${group.color}"/><line x1="${centerX - half}" y1="${y(median)}" x2="${centerX + half}" y2="${y(median)}" stroke="${group.color}" stroke-width="2"/>`);
        values.forEach((value, index) => {
          if (value < lower || value > upper) {
            const jitter = ((index % 5) - 2) * 2.4;
            const event = groupedEvents[index];
            const patientId = event?.cohort_patient_id || "";
            const eventId = event?.event_id || "";
            parts.push(`<circle class="boxplot-outlier" tabindex="0" role="button" aria-label="Inspect outlier for patient ${escapeHTML(patientId)}, probability ${fmt(value, 3)}" data-patient-id="${escapeHTML(patientId)}" data-event-id="${escapeHTML(eventId)}" cx="${centerX + jitter}" cy="${y(value)}" r="3.2" fill="${group.color}" fill-opacity=".8"><title>${escapeHTML(actionName(action))} Â· ${escapeHTML(group.label)} Â· patient ${escapeHTML(patientId)} Â· event ${escapeHTML(eventId)} Â· p=${fmt(value, 3)}</title></circle>`);
          }
        });
        parts.push(`</g>`);
      }
      parts.push(`<text class="boxplot-count" x="${centerX}" y="${height - bottom + 17}" text-anchor="middle">${values.length}</text>`);
    });
    parts.push(`<text class="boxplot-action" x="${center}" y="${height - 15}" text-anchor="middle">${escapeHTML(actionName(action))}</text>`);
  });
  parts.push(`</svg>`);
  return parts.join("");
}

function cohortPatientRows() {
  const action = $("#cohort-action").value;
  const classFilter = $("#cohort-classes").value;
  const minimum = Math.max(0, Number.parseInt($("#cohort-min-n").value, 10) || 0);
  const metric = $("#cohort-sort").value;
  const rows = (state.run.patients || []).map((info) => {
    const record = state.cohortRecords.get(String(info.patient_id));
    const allEvents = record?.events || [];
    const events = action === "all" ? allEvents : allEvents.filter((event) => event.action === action);
    const summary = metricSummary(events);
    const keep = classFilter === "both" ? summary.positive > 0 && summary.negative > 0
      : classFilter === "positive" ? summary.positive > 0 && summary.negative === 0
      : classFilter === "negative" ? summary.negative > 0 && summary.positive === 0
      : classFilter === "none" ? summary.consensus === 0 : true;
    return { id: String(info.patient_id), events, summary, keep };
  }).filter((row) => row.keep && row.summary.consensus >= minimum);
  rows.sort((a, b) => {
    const valueFor = (row) => metric === "ba" ? row.summary.balancedAccuracy
      : metric === "fnr" ? (row.summary.recall === null ? null : 1 - row.summary.recall)
      : metric === "fpr" ? (row.summary.specificity === null ? null : 1 - row.summary.specificity)
      : metric === "confident-errors" ? row.summary.confidentErrors
      : (row.summary.consensus ? (row.summary.fp + row.summary.fn) / row.summary.consensus : null);
    const av = valueFor(a), bv = valueFor(b);
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    if (av !== bv) return metric === "ba" ? av - bv : bv - av;
    return a.id.localeCompare(b.id, undefined, {numeric:true});
  });
  return rows;
}

function cohortMetadataValue(record, key) {
  const rows = record?.metadata_records || [];
  if (!rows.length) return "Not recorded";
  const decode = key === "Diagnosis-Coded"
    ? (value) => decodeCode(value, {0:"Healthy",1:"Parkinson’s disease",2:"Other movement disorder"})
    : decodeAge;
  const values = rows.map((row) => {
    const raw = metaValue(row, key);
    return raw === null ? "Not recorded" : String(decode(raw));
  });
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : "Multiple values";
}

function ensureSeedPatientMetadata(patientIds,split,record) {
  const pending=[];
  for(const id of patientIds) {
    const key=String(id);
    if(!state.seedPatientMetadata.has(key)) {
      const entry={loaded:false,records:[]};
      entry.promise=readDatasetJSON(`patients/${key}.json`).then((data)=>{entry.records=data.metadata_records||[];}).catch(()=>{entry.records=[];}).finally(()=>{entry.loaded=true;});
      state.seedPatientMetadata.set(key,entry);
    }
    const entry=state.seedPatientMetadata.get(key);
    if(!entry.loaded)pending.push(entry.promise);
  }
  if(!pending.length)return;
  Promise.all(pending).then(()=>{
    if(state.activeView!=="seeds"||String(state.selectedSeed)!==String(record.seed))return;
    if(split==="oof"&&state.selectedSeedTab===String(record.seed))renderSeedPatientAnalysis(record,true);
    else if(split==="test"&&state.selectedSeedTab===String(record.seed)&&state.seedTestView==="patients")renderHoldoutPatientAnalysis(record,true);
  });
}

function seedPatientMetadataValue(patientId,key) {
  const entry=state.seedPatientMetadata.get(String(patientId));
  return !entry||!entry.loaded?"Loading…":cohortMetadataValue({metadata_records:entry.records},key);
}

function renderCohort() {
  if (!state.cohortLoaded) return;
  const metric = $("#cohort-sort").value;
  const labels = {"error-rate":"consensus error rate","ba":"balanced accuracy","fnr":"false negative rate","fpr":"false positive rate","confident-errors":"high-confidence error heuristics"};
  const rows = cohortPatientRows().map((row, index) => {
    const record = state.cohortRecords.get(row.id);
    return {
      ...row,
      defaultRank: index + 1,
      diagnosis: cohortMetadataValue(record, "Diagnosis-Coded"),
      age: cohortMetadataValue(record, "Age-Coded"),
    };
  });
  if (state.cohortHeaderSort) {
    const key = state.cohortHeaderSort;
    const direction = state.cohortHeaderDirection === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const summaryA = a.summary, summaryB = b.summary;
      let av, bv;
      if (key === "rank") { av = a.defaultRank; bv = b.defaultRank; }
      else if (key === "patient") return direction * a.id.localeCompare(b.id, undefined, {numeric:true});
      else if (key === "consensus") { av = summaryA.total ? summaryA.consensus / summaryA.total : null; bv = summaryB.total ? summaryB.consensus / summaryB.total : null; }
      else if (key === "class-count") return direction * (summaryA.negative - summaryB.negative || summaryA.positive - summaryB.positive);
      else if (key === "specificity") { av = summaryA.negative ? summaryA.tn / summaryA.negative : null; bv = summaryB.negative ? summaryB.tn / summaryB.negative : null; }
      else if (key === "recall") { av = summaryA.positive ? summaryA.tp / summaryA.positive : null; bv = summaryB.positive ? summaryB.tp / summaryB.positive : null; }
      else if (key === "diagnosis") { av = a.diagnosis; bv = b.diagnosis; }
      else if (key === "age") { av = a.age; bv = b.age; }
      else {
        av = summaryA.consensus ? (summaryA.fp + summaryA.fn) / summaryA.consensus : null;
        bv = summaryB.consensus ? (summaryB.fp + summaryB.fn) / summaryB.consensus : null;
      }
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      const order = typeof av === "string" ? av.localeCompare(bv, undefined, {numeric:true}) : av - bv;
      return direction * order || a.id.localeCompare(b.id, undefined, {numeric:true});
    });
  }
  document.querySelectorAll(".cohort-sort-button").forEach((button) => {
    const active = state.cohortHeaderSort === button.dataset.cohortSort;
    const label = button.dataset.label || button.textContent.trim();
    button.dataset.label = label;
    button.innerHTML = `${escapeHTML(label)}${active ? `<span aria-hidden="true"> ${state.cohortHeaderDirection === "asc" ? "&uarr;" : "&darr;"}</span>` : ""}`;
    button.setAttribute("aria-label", active ? `${label}, sorted ${state.cohortHeaderDirection === "asc" ? "ascending" : "descending"}` : `Sort by ${label}`);
    button.closest("th").setAttribute("aria-sort", active ? (state.cohortHeaderDirection === "asc" ? "ascending" : "descending") : "none");
  });
  $("#cohort-results-count").textContent = `${rows.length} of ${state.run.patients.length} patients · sorted by ${labels[metric]}`;
  $("#cohort-count").textContent = String(state.run.patients.length);
  if (!rows.length) {
    $("#cohort-rows").innerHTML = '<tr><td colspan="8" class="empty-cell">No patients match these filters.</td></tr>';
    return;
  }
  $("#cohort-rows").innerHTML = rows.map(({id, summary, diagnosis, age}, index) => {
    const specificity = summary.negative ? `${summary.tn}/${summary.negative}` : "N/A";
    const recall = summary.positive ? `${summary.tp}/${summary.positive}` : "N/A";
    return `<tr class="cohort-patient-row" data-patient-id="${escapeHTML(id)}">
      <td>${index + 1}</td><td class="event-id"><button class="cohort-patient-link" type="button" aria-label="Inspect patient ${escapeHTML(id)}">${escapeHTML(id)}</button></td>
      <td class="cohort-fraction">${summary.consensus}/${summary.total}</td><td>${summary.negative}/${summary.positive}</td><td class="cohort-fraction">${specificity}</td><td class="cohort-fraction">${recall}</td>
      <td>${escapeHTML(diagnosis)}</td><td>${escapeHTML(age)}</td></tr>`;
  }).join("");
  const openPatient = async (row) => {
    await selectPatient(row.dataset.patientId);
    setGlobalTab("subject");
  };
  $("#cohort-rows").querySelectorAll(".cohort-patient-row").forEach((row) => {
    row.addEventListener("click", () => openPatient(row));
  });
}

function setGlobalTab(tab) {
  state.globalTab = tab;
  const overview = tab === "overview";
  const subject = tab === "subject";
  $("#global-controls").classList.toggle("hidden", !subject || state.activeView !== "global");
  $("#overview-panel").classList.toggle("hidden", !overview);
  $("#subject-panel").classList.toggle("hidden", !subject);
  $("#cohort-panel").classList.toggle("hidden", tab !== "cohort");
  document.querySelectorAll(".global-tab").forEach((button) => {
    const active = button.dataset.globalTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  if (overview) {
    $("#page-title").textContent = "Global LOSO overview";
    loadActionBoxplotData();
  } else if (subject) {
    $("#page-title").textContent = "Patient inspection";
    if (state.patientData) renderGlobalEvents();
  } else {
    $("#page-title").textContent = "Global LOSO cohort";
    loadCohortRecords();
  }
  updateGlobalHeading();
}

function updateGlobalHeading() {
  if (!state.run) return;
  if (state.globalTab === "subject") {
    const events = state.patientData?.events || [];
    const summary = metricSummary(events);
    const errorRate = summary.consensus ? fmtPct((summary.fp + summary.fn) / summary.consensus) : "N/A";
    $("#page-title").textContent = "Patient inspection";
    $("#page-subtitle").textContent = `${state.run.run_family} / ${events.length} events for patient ${state.patient} / consensus error rate ${errorRate}`;
  } else if (state.globalTab === "cohort") {
    $("#page-title").textContent = "Global LOSO cohort";
    $("#page-subtitle").textContent = `${state.run.run_family} / compare held-out patients using stored predictions`;
  } else {
    $("#page-title").textContent = "Global LOSO overview";
    $("#page-subtitle").textContent = `${state.run.run_family} / ${state.run.patients.length} held-out patients / ${state.run.counts.prediction_events} prediction events`;
  }
}

function filteredEvents() {
  const events = [...(state.patientData?.events || []), ...(state.patientData?.source_transition_events || [])];
  const action = $("#action-filter").value;
  const category = $("#event-filter").value;
  const search = $("#event-search").value.trim().toLowerCase();
  return events.filter((event) => {
    if (action !== "all" && event.action !== action) return false;
    if (event.transition_source) {
      if (category !== "all") return false;
      if (search && !`${event.action} ${event.previous_epoch || ""} ${event.next_epoch || ""} ${event.source_h5_index} ${event.source_filename || ""}`.toLowerCase().includes(search)) return false;
      return true;
    }
    if (category === "consensus" && !event.consensus) return false;
    if (category === "disagreement" && event.a1 === event.a2) return false;
    if (category === "errors" && !(event.consensus && event.correct_on_consensus === false)) return false;
    if (search && !`${event.action} ${event.event_id} ${event.a1} ${event.a2}`.toLowerCase().includes(search)) return false;
    return true;
  });
}

function orderEventsBySourceTime(events) {
  const sourceRow=(event)=>event.transition_source?event:(event.signal_match?.status==="matched"&&event.signal_match.candidates?.length===1?event.signal_match.candidates[0]:null);
  const sideOrder={"Dominant":0,"Non-dominant":1,"Mixed candidates":2,"Unknown":3};
  const timed=events.map((event,index)=>({event,index,source:sourceRow(event),side:eventSide(event)}));
  timed.sort((left,right)=>{
    const sideDifference=(sideOrder[left.side]??3)-(sideOrder[right.side]??3);
    if(sideDifference)return sideDifference;
    const a=left.source,b=right.source;
    if(!a||!b)return !a&&!b?left.index-right.index:!a?1:-1;
    const aFile=String(a.source_file||""),bFile=String(b.source_file||"");
    if(aFile!==bFile&&(aFile||bFile))return aFile.localeCompare(bFile,undefined,{numeric:true})||left.index-right.index;
    if(Number.isFinite(a.start_elapsed_time_s)&&Number.isFinite(b.start_elapsed_time_s)){
      const elapsedOrder=a.start_elapsed_time_s-b.start_elapsed_time_s;
      if(elapsedOrder)return elapsedOrder;
    }
    if(Number.isFinite(a.start_timestamp_us)&&Number.isFinite(b.start_timestamp_us)){
      const timestampOrder=a.start_timestamp_us-b.start_timestamp_us;
      if(timestampOrder)return timestampOrder;
    }
    const elapsedOrder=(Number(a.start_elapsed_time_s)||0)-(Number(b.start_elapsed_time_s)||0);
    return elapsedOrder||left.index-right.index;
  });
  return timed.map((item)=>item.event);
}

function eventStatus(event) {
  if (event.a1 !== event.a2) return ["Disagreement", "disagreement"];
  if (event.correct_on_consensus === null) return ["Unknown label", "neutral"];
  if (event.correct_on_consensus) return ["Correct", "good"];
  return [Number(event.a1) === 0 ? "False positive" : "False negative", "error"];
}

function actionName(value) {
  return String(value || "Unknown").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function filenameSide(filename) {
  const match = String(filename || "").match(/\.(00|01)(?=_|$)/);
  if (!match) return null;
  return match[1] === "00" ? "Non-dominant" : "Dominant";
}

function eventSide(event) {
  const sides = [...new Set((event.signal_match?.candidates || []).map((candidate) => filenameSide(candidate.source_filename)).filter(Boolean))];
  if (sides.length === 1) return sides[0];
  if (sides.length > 1) return "Mixed candidates";
  return filenameSide(event.filename) || "Unknown";
}

function eventMoment(event) {
  const filenames=(event.signal_match?.candidates||[]).map((candidate)=>candidate.source_filename);
  if(!filenames.length)filenames.push(event.source_filename,event.filename);
  const moments=[...new Set(filenames.map((filename)=>String(filename||"").match(/(?:^|_)(M[A-Z])(?:_|$)/)?.[1]).filter(Boolean))];
  return moments.length===1?moments[0]:moments.length>1?"Multiple":"Unknown";
}

function activePatientThreshold() {
  return state.patientData?.analysis_threshold ?? state.run?.threshold;
}

function renderGlobalEvents() {
  const events = state.patientData?.events || [];
  const summary = metricSummary(events);
  $("#event-count").textContent = `${filteredEvents().length} / ${events.length}`;
  const n = events.length;
  const threshold = activePatientThreshold();
  const data = events.map((event) => {
    const [status] = eventStatus(event);
    return { probability: event.probability, label: event.a1 === event.a2 ? Number(event.a1) : null, disagreement: event.a1 !== event.a2, predicted: event.predicted_class, id: event.event_id, status };
  });
  const errorRate = summary.consensus ? fmtPct((summary.fp + summary.fn) / summary.consensus) : "N/A";
  $("#page-title").textContent = state.globalTab === "subject" ? "Patient inspection" : "Global LOSO overview";
  $("#page-subtitle").textContent = `${state.run.run_family} · ${n} events for patient ${state.patient} · consensus error rate ${errorRate}`;
  $("#threshold-chip b").textContent = fmt(threshold, 3);
}

function pointColor(item) {
  const dark = isDarkTheme(), outline = dark ? "#1c2833" : "#fff";
  if (item.disagreement) return { fill: dark ? "#1c2833" : "#fff", stroke: "#a78bcc" };
  if (item.status === "Correct") return { fill: "#4c9a83", stroke: outline };
  return { fill: "#d87868", stroke: outline };
}

function makeProbabilitySvg(items, threshold, selectedId, accessor = (item) => ({xLabel:String(item.index + 1), id:item.id, probability:item.probability, disagreement:item.disagreement, status:item.status})) {
  const width = Math.max(650, Math.min(1100, items.length * 11));
  const height = 214, left = 42, right = 17, top = 15, bottom = 28;
  const plotW = width - left - right, plotH = height - top - bottom;
  const y = (p) => top + (1 - Math.max(0, Math.min(1, p))) * plotH;
  let svg = `<svg class="probability-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Event probability plot from zero to one">`;
  for (const tick of [0, .25, .5, .75, 1]) {
    const yy = y(tick);
    svg += `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}"/><text class="chart-axis" x="${left - 8}" y="${yy + 3}" text-anchor="end">${tick.toFixed(2)}</text>`;
  }
  const thresholdY = y(threshold);
  svg += `<line class="chart-threshold" x1="${left}" x2="${width - right}" y1="${thresholdY}" y2="${thresholdY}"/><text class="chart-threshold-label" x="${width - right - 3}" y="${thresholdY - 5}" text-anchor="end">stored threshold ${threshold.toFixed(3)}</text>`;
  items.forEach((item, index) => {
    const view = accessor(item, index);
    const xx = left + (items.length <= 1 ? plotW / 2 : (index / (items.length - 1)) * plotW);
    const yy = y(view.probability);
    const colors = pointColor({disagreement:view.disagreement,status:view.status});
    const selected = view.id === selectedId;
    const radius = items.length > 300 ? 2.8 : 4.1;
    svg += `<circle class="event-point${selected ? " selected" : ""}" data-event-id="${escapeHTML(view.id)}" cx="${xx.toFixed(2)}" cy="${yy.toFixed(2)}" r="${selected ? radius + 1 : radius}" fill="${colors.fill}" stroke="${colors.stroke}"/><title>${escapeHTML(view.xLabel)} · p=${fmt(view.probability, 3)} · ${escapeHTML(view.status)}</title></circle>`;
  });
  svg += `<text class="chart-axis" x="${left}" y="${height - 7}">Event order</text></svg>`;
  return svg;
}

function renderProbabilityPlot() {
  const events = state.patientData?.events || [];
  if (!events.length) {
    $("#probability-plot").innerHTML = `<div class="empty-inline">No events are stored for this patient.</div>`;
    return;
  }
  $("#probability-plot").innerHTML = makeProbabilitySvg(events, activePatientThreshold(), state.selectedEventId, (event) => {
    const [status] = eventStatus(event);
    return {id:event.event_id,xLabel:event.event_id,probability:event.probability,disagreement:event.a1 !== event.a2,status};
  });
  $("#probability-plot").querySelectorAll(".event-point").forEach((point) => point.addEventListener("click", () => selectEvent(point.dataset.eventId)));
}

function renderEventTable() {
  const rows = orderEventsBySourceTime(filteredEvents());
  const predictionCount = state.patientData?.events?.length || 0;
  const transitionCount = state.patientData?.source_transition_events?.length || 0;
  $("#event-count").textContent = `${rows.length} shown · ${predictionCount} predictions · ${transitionCount} transitions`;
  if (!rows.length) {
    $("#event-rows").innerHTML = `<tr><td colspan="9" class="empty-cell">No events match these filters.</td></tr>`;
    return;
  }
  $("#event-rows").innerHTML = rows.map((event) => {
    if (event.transition_source) {
      const context=[event.previous_epoch,event.next_epoch].filter(Boolean).map(actionName).join(" \u2192 ");
      const start=Number.isFinite(event.start_elapsed_time_s)?`${fmt(event.start_elapsed_time_s,2)} s`:"unknown";
      const end=Number.isFinite(event.end_elapsed_time_s)?`${fmt(event.end_elapsed_time_s,2)} s`:"unknown";
      return `<tr data-event-id="${escapeHTML(event.event_id)}" class="${event.event_id === state.selectedEventId ? "selected-row" : ""}">
      <td class="event-id">HDF5 row ${escapeHTML(event.source_h5_index)}</td><td>${escapeHTML(actionName(event.action))}${context?`<br><small>Between ${escapeHTML(context)}</small>`:""}</td><td>${escapeHTML(actionName(event.device))} · ${escapeHTML(filenameSide(event.source_filename) || "Unknown")}<br><small>${start}-${end}</small></td><td>${escapeHTML(eventMoment(event))}</td><td>&mdash;</td>
      <td>&mdash;</td><td>&mdash;</td><td>&mdash;</td><td><span class="badge neutral">Source signal: no prediction</span></td></tr>`;
    }
    const [status, tone] = eventStatus(event);
    const soft = event.soft_target_stored;
    const model = Number(event.predicted_class) === 1 ? "Tremor" : "No tremor";
    return `<tr data-event-id="${escapeHTML(event.event_id)}" class="${event.event_id === state.selectedEventId ? "selected-row" : ""}">
      <td class="event-id">${escapeHTML(event.event_id)}</td><td>${escapeHTML(actionName(event.action))}</td><td>${escapeHTML(eventSide(event))}</td><td>${escapeHTML(eventMoment(event))}</td><td class="label-pair">${escapeHTML(event.a1)} / ${escapeHTML(event.a2)}</td>
      <td>${fmt(soft, 2)}</td><td class="probability-cell">${fmt(event.probability, 3)}</td><td>${model}</td><td><span class="badge ${tone}">${escapeHTML(status)}</span></td></tr>`;
  }).join("");
  $("#event-rows").querySelectorAll("tr[data-event-id]").forEach((row) => row.addEventListener("click", () => selectEvent(row.dataset.eventId)));
}

async function selectEvent(eventId) {
  state.selectedEventId = eventId;
  const event = [...(state.patientData?.events || []), ...(state.patientData?.source_transition_events || [])].find((item) => item.event_id === eventId);
  renderProbabilityPlot();
  renderEventTable();
  await renderSelectedEvent(event);
}

async function renderSelectedEvent(event) {
  const token = ++state.signalToken;
  if (!event) return;
  $("#signal-title").textContent = `${actionName(event.action)} · event ${event.source_npz_index ?? event.event_id}`;
  const match = event.signal_match || {status:"unmatched",candidates:[]};
  const select = $("#signal-source-select");
  select.replaceChildren();
  if (match.status === "unmatched" || !match.candidates?.length) {
    select.disabled = true;
    select.add(new Option("No signal match", ""));
    $("#signal-provenance").textContent = `No signal linked · ${match.reason || "source record unavailable"}. The prediction remains available for analysis.`;
    setSignalEmpty("This event has no valid HDF5 signal match.");
    return;
  }
  const ambiguous = match.status === "ambiguous";
  if (ambiguous) select.add(new Option(`Choose a candidate source… · side: ${eventSide(event)}`, ""));
  match.candidates.forEach((candidate, index) => {
    const side = filenameSide(candidate.source_filename);
    const sourceLabel = `${candidate.source_filename || `HDF5 row ${candidate.source_h5_index}`} · ${side || "side unknown"} · ${candidate.device || "device not recorded"} · Δ ${fmt(candidate.duration_difference_s, 3)} s`;
    select.add(new Option(sourceLabel, String(index)));
  });
  select.disabled = false;
  const loadCandidate = async (index) => {
    if (index === "") {
      $("#signal-provenance").textContent = `Laterality: ${eventSide(event)} (filename code .00 = non-dominant; .01 = dominant). Signal match is ambiguous (${match.reason}); select a candidate to inspect a signal.`;
      setSignalEmpty("Choose a candidate source record to view the signal.");
      return;
    }
    const candidate = match.candidates[Number(index)];
    const base = state.datasetBase;
    const matchDescription=candidate.match_method|| (ambiguous ? "Researcher-selected candidate; match remains ambiguous" : "Unique closest-duration match");
    const sourceLabels=!event.transition_source&&Number.isFinite(Number(candidate.dataset_a1))&&Number.isFinite(Number(candidate.dataset_a2))
      ? `Dataset annotations A1/A2: ${candidate.dataset_a1}/${candidate.dataset_a2}${Number(candidate.dataset_a1)!==Number(event.a1)||Number(candidate.dataset_a2)!==Number(event.a2)?` (run annotations: ${event.a1}/${event.a2})`:""}`
      : "Dataset annotations unavailable";
    const between=[event.previous_epoch,event.next_epoch].filter(Boolean).map(actionName).join(" \u2192 ");
    const elapsed=Number.isFinite(event.start_elapsed_time_s)&&Number.isFinite(event.end_elapsed_time_s)?`recording time ${fmt(event.start_elapsed_time_s,2)}-${fmt(event.end_elapsed_time_s,2)} s`:"recording time unavailable";
    const transitionNote=event.transition_source?`Transition source segment${between?` between ${between}`:""}; ${elapsed}. No prediction labels or probabilities are assigned. `:"";
    $("#signal-provenance").textContent = `${transitionNote}Laterality: ${filenameSide(candidate.source_filename) || "unknown"} · ${matchDescription} · ${sourceLabels} · HDF5 row ${candidate.source_h5_index} · ${candidate.source_filename || "source filename not recorded"} · ${candidate.device || "device not recorded"} · ${candidate.sample_count} samples at ${fmt(state.dataset.signal.sampling_rate_hz, 1)} Hz source rate`;
    $("#signal-empty").textContent = "Loading selected signal…";
    $("#signal-empty").classList.remove("hidden");
    try {
      const [raw, spectrumRaw, elapsedRaw] = await Promise.all([
        fetchGzipArrayBuffer(candidate.signal_ref),
        fetchGzipArrayBuffer(candidate.spectrum_ref),
        candidate.elapsed_time_ref ? fetchGzipArrayBuffer(candidate.elapsed_time_ref) : Promise.resolve(null),
      ]);
      const channels = decodeFloatChannels(raw, candidate.sample_count);
      const elapsedTime = elapsedRaw ? decodeElapsedTimes(elapsedRaw, candidate.elapsed_time_sample_count) : null;
      const spectrum = decodeSpectrum(spectrumRaw, candidate.spectrum_frequency_count, candidate.spectrum_nperseg, state.dataset.signal.source_sampling_rate_hz);
      if (token !== state.signalToken) return;
      state.signalSourceChannels = channels;
      state.signalElapsedTime = elapsedTime;
      state.signalFrequencySummary = candidate.frequency_summary;
      state.signalOriginalSpectrum = spectrum;
      updateSignalFilterControls();
      applySignalFilter();
      drawBandPowerBars($("#acc-band-canvas"), state.signalFrequencySummary, 0);
      drawBandPowerBars($("#gyr-band-canvas"), state.signalFrequencySummary, 3);
      $("#psd-rate-note").textContent=`Selected signal sampled at ${fmt(state.dataset.signal.sampling_rate_hz, 1)} Hz`;
      $("#signal-empty").classList.add("hidden");
    } catch (error) {
      if (token !== state.signalToken) return;
      setSignalEmpty(`${error.message}. The prediction and labels are still available.`);
    }
  };
  select.onchange = () => loadCandidate(select.value);
  const smartwatchIndex=match.candidates.findIndex((candidate)=>/smart\s*watch|smartwatch|galaxy\s*watch/i.test(String(candidate.device||"")));
  const defaultIndex=!ambiguous&&match.candidates.length===1?0:smartwatchIndex;
  if(defaultIndex>=0) {
    select.value=String(defaultIndex);
    await loadCandidate(String(defaultIndex));
  } else {
    select.value = "";
    await loadCandidate("");
  }
}

function setSignalEmpty(message) {
  state.signalChannels = null;
  state.signalSourceChannels = null;
  state.signalElapsedTime = null;
  state.signalFrequencySummary = null;
  state.signalSpectrum = null;
  state.signalOriginalSpectrum = null;
  $("#signal-source-psd").checked=false;
  $("#signal-source-psd").disabled=true;
  $("#signal-filter-status").textContent="Select a source signal to apply filtering";
  ["#acc-band-canvas", "#gyr-band-canvas"].forEach((selector) => { const canvas=$(selector);canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height); });
  $("#signal-empty").textContent = message;
  $("#signal-empty").classList.remove("hidden");
  ["#acc-canvas", "#gyr-canvas", "#acc-psd-canvas", "#gyr-psd-canvas"].forEach((selector) => {
    const canvas = $(selector);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });
}

function decodeFloatChannels(buffer, sampleCount) {
  const expected = sampleCount * 6 * 4;
  if (buffer.byteLength !== expected) throw new Error(`Signal byte length mismatch: expected ${expected}, received ${buffer.byteLength}`);
  const view = new DataView(buffer);
  const channels = Array.from({length:6}, () => new Float32Array(sampleCount));
  for (let sample = 0; sample < sampleCount; sample++) {
    for (let channel = 0; channel < 6; channel++) channels[channel][sample] = view.getFloat32((sample * 6 + channel) * 4, true);
  }
  return channels;
}

function decodeElapsedTimes(buffer, sampleCount) {
  const expected = sampleCount * 8;
  if (buffer.byteLength !== expected) throw new Error(`Elapsed-time byte length mismatch: expected ${expected}, received ${buffer.byteLength}`);
  const view = new DataView(buffer), values = new Float64Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample++) values[sample] = view.getFloat64(sample * 8, true);
  return values;
}

function decodeSpectrum(buffer, frequencyCount, nperseg, sampleRate) {
  const expected = frequencyCount * 6 * 4;
  if (buffer.byteLength !== expected) throw new Error(`Spectrum byte length mismatch: expected ${expected}, received ${buffer.byteLength}`);
  const view = new DataView(buffer), channels = Array.from({length:6}, () => new Float32Array(frequencyCount));
  const frequency = Float64Array.from({length:frequencyCount}, (_, index) => index * sampleRate / nperseg);
  for (let channel = 0; channel < 6; channel++) {
    for (let bin = 0; bin < frequencyCount; bin++) channels[channel][bin] = view.getFloat32((channel * frequencyCount + bin) * 4, true);
  }
  return {frequency, channels};
}

const BUTTERWORTH_Q = [0.541196100146197, 1.306562964876377];

function makeBiquad(type, cutoffHz, sampleRate, q) {
  const frequency=Math.min(sampleRate*.499,Math.max(.001,cutoffHz));
  const omega=2*Math.PI*frequency/sampleRate, cosine=Math.cos(omega), sine=Math.sin(omega), alpha=sine/(2*q);
  let b0,b1,b2;
  if(type==="lowpass"){b0=(1-cosine)/2;b1=1-cosine;b2=b0;}
  else if(type==="highpass"){b0=(1+cosine)/2;b1=-(1+cosine);b2=b0;}
  else throw new Error(`Unsupported filter section: ${type}`);
  const a0=1+alpha,a1=-2*cosine,a2=1-alpha;
  return {b0:b0/a0,b1:b1/a0,b2:b2/a0,a1:a1/a0,a2:a2/a0};
}

function runBiquad(values, coefficients) {
  const output=new Float64Array(values.length);
  if(!values.length)return output;
  const {b0,b1,b2,a1,a2}=coefficients, first=values[0];
  const dcGain=(b0+b1+b2)/(1+a1+a2);
  let z1=dcGain*first-b0*first,z2=b2*first-a2*dcGain*first;
  for(let i=0;i<values.length;i++){
    const value=values[i],result=b0*value+z1;
    z1=b1*value-a1*result+z2;z2=b2*value-a2*result;output[i]=result;
  }
  return output;
}

function zeroPhaseBiquad(values, coefficients, padLength) {
  const count=values.length,pad=Math.min(Math.max(0,count-1),padLength);
  const extended=new Float64Array(count+pad*2);
  for(let i=0;i<pad;i++)extended[pad-1-i]=values[Math.min(count-1,i+1)];
  extended.set(values,pad);
  for(let i=0;i<pad;i++)extended[pad+count+i]=values[Math.max(0,count-2-i)];
  let filtered=runBiquad(extended,coefficients);
  filtered.reverse();filtered=runBiquad(filtered,coefficients);filtered.reverse();
  return filtered.slice(pad,pad+count);
}

function filterSignalChannel(input, type, lowHz, highHz, sampleRate) {
  if(type==="none")return input;
  const filterKinds=type==="bandpass"?["highpass","lowpass"]:[type];
  const sections=[];
  for(const filterKind of filterKinds){
    const cutoff=filterKind==="highpass"?lowHz:highHz;
    for(const q of BUTTERWORTH_Q)sections.push(makeBiquad(filterKind,cutoff,sampleRate,q));
  }
  const lowest=type==="highpass"?lowHz:type==="bandpass"?lowHz:highHz;
  const padLength=Math.ceil(3*sampleRate/lowest);
  let output=Float64Array.from(input);
  for(const section of sections)output=zeroPhaseBiquad(output,section,padLength);
  return Float32Array.from(output);
}

function fftInPlace(real, imaginary) {
  const n=real.length;
  for(let i=1,j=0;i<n;i++){
    let bit=n>>1;
    for(;j&bit;bit>>=1)j^=bit;
    j^=bit;
    if(i<j){[real[i],real[j]]=[real[j],real[i]];[imaginary[i],imaginary[j]]=[imaginary[j],imaginary[i]];}
  }
  for(let size=2;size<=n;size<<=1){
    const angle=-2*Math.PI/size,stepReal=Math.cos(angle),stepImaginary=Math.sin(angle),half=size>>1;
    for(let start=0;start<n;start+=size){
      let twiddleReal=1,twiddleImaginary=0;
      for(let j=0;j<half;j++){
        const even=start+j,odd=even+half;
        const oddReal=real[odd]*twiddleReal-imaginary[odd]*twiddleImaginary;
        const oddImaginary=real[odd]*twiddleImaginary+imaginary[odd]*twiddleReal;
        real[odd]=real[even]-oddReal;imaginary[odd]=imaginary[even]-oddImaginary;
        real[even]+=oddReal;imaginary[even]+=oddImaginary;
        const nextReal=twiddleReal*stepReal-twiddleImaginary*stepImaginary;
        twiddleImaginary=twiddleReal*stepImaginary+twiddleImaginary*stepReal;twiddleReal=nextReal;
      }
    }
  }
}

function computeWelchSpectrum(channels, sampleRate) {
  const sampleCount=channels[0]?.length||0;
  if(sampleCount<8)throw new Error("At least 8 samples are required to calculate a Welch PSD.");
  const nperseg=Math.min(1024,sampleCount),fftLength=2**Math.ceil(Math.log2(nperseg)),half=fftLength>>1,step=Math.floor(nperseg/2);
  const window=Float64Array.from({length:nperseg},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/nperseg));
  const windowPower=window.reduce((sum,value)=>sum+value*value,0),frequency=Float64Array.from({length:half+1},(_,i)=>i*sampleRate/fftLength);
  const segments=Math.floor((sampleCount-nperseg)/step)+1,result=[];
  for(const channel of channels){
    const power=new Float64Array(half+1);
    for(let start=0;start+nperseg<=sampleCount;start+=step){
      let mean=0;for(let i=0;i<nperseg;i++)mean+=channel[start+i];mean/=nperseg;
      const real=new Float64Array(fftLength),imaginary=new Float64Array(fftLength);
      for(let i=0;i<nperseg;i++)real[i]=(channel[start+i]-mean)*window[i];
      fftInPlace(real,imaginary);
      for(let bin=0;bin<=half;bin++){
        const oneSided=bin>0&&bin<half?2:1;
        power[bin]+=oneSided*(real[bin]*real[bin]+imaginary[bin]*imaginary[bin])/(sampleRate*windowPower);
      }
    }
    for(let bin=0;bin<power.length;bin++)power[bin]/=segments;
    result.push(Float32Array.from(power));
  }
  return {frequency,channels:result};
}

function updateSignalFilterControls() {
  const type=$("#signal-filter-type").value;
  $("#filter-low-control").classList.toggle("hidden",!(["highpass","bandpass"].includes(type)));
  $("#filter-high-control").classList.toggle("hidden",!(["lowpass","bandpass"].includes(type)));
  const overlay=$("#signal-source-psd");
  overlay.disabled=!state.signalOriginalSpectrum||type==="none";
  if(overlay.disabled)overlay.checked=false;
}

function applySignalFilter() {
  if(!state.signalSourceChannels||!state.dataset?.signal)return;
  const type=$("#signal-filter-type").value,sampleRate=state.dataset.signal.sampling_rate_hz,nyquist=sampleRate/2;
  const lowHz=Number($("#signal-filter-low").value),highHz=Number($("#signal-filter-high").value);
  if(["highpass","bandpass"].includes(type)&&(!Number.isFinite(lowHz)||lowHz<=0||lowHz>=nyquist)){
    $("#signal-filter-status").textContent=`Low cutoff must be between 0 and ${fmt(nyquist,1)} Hz`;return;
  }
  if(["lowpass","bandpass"].includes(type)&&(!Number.isFinite(highHz)||highHz<=0||highHz>=nyquist)){
    $("#signal-filter-status").textContent=`High cutoff must be between 0 and ${fmt(nyquist,1)} Hz`;return;
  }
  if(type==="bandpass"&&lowHz>=highHz){$("#signal-filter-status").textContent="Low cutoff must be below high cutoff";return;}
  try{
    const channels=state.signalSourceChannels.map((channel)=>filterSignalChannel(channel,type,lowHz,highHz,sampleRate));
    state.signalChannels=channels;
    state.signalSpectrum=computeWelchSpectrum(channels,sampleRate);
    drawTimeSeries($("#acc-canvas"),channels,sampleRate,0,"m/s²", state.signalElapsedTime);
    drawTimeSeries($("#gyr-canvas"),channels,sampleRate,3,"deg/s",state.signalElapsedTime);
    const reference=$("#signal-source-psd").checked?state.signalOriginalSpectrum:null;
    drawPSD($("#acc-psd-canvas"),state.signalSpectrum,0,reference);
    drawPSD($("#gyr-psd-canvas"),state.signalSpectrum,3,reference);
    const name=type==="none"?"Unfiltered source signal":type==="bandpass"?`Zero-phase 4th-order Butterworth high-pass ${lowHz} Hz + low-pass ${highHz} Hz`:`Zero-phase 4th-order Butterworth ${type} ${type==="lowpass"?highHz:lowHz} Hz`;
    $("#signal-filter-status").textContent=`${name} · ${fmt(sampleRate,1)} Hz · Welch PSD recalculated`;
  }catch(error){$("#signal-filter-status").textContent=`Filter could not be applied: ${error.message||error}`;}
}

function setupCanvas(canvas, height) {
  const width = Math.max(320, canvas.clientWidth || 600);
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  return {ctx,width,height};
}

const AXIS_COLORS = ["#357c91", "#d28b47", "#6d9b73"];

function drawTimeSeries(canvas, channels, sampleRate, offset, unit, elapsedTimes = null) {
  const {ctx,width,height} = setupCanvas(canvas, 210);
  const left = 45, right = 10, top = 13, bottom = 23, plotW = width-left-right, plotH = height-top-bottom;
  const arrays = channels.slice(offset, offset+3);
  let min = Infinity, max = -Infinity;
  arrays.forEach((arr) => arr.forEach((value) => { if (Number.isFinite(value)) { min=Math.min(min,value);max=Math.max(max,value); } }));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (max === min) {max += 1;min -= 1;}
  const pad = (max-min)*.08; min-=pad; max+=pad;
  ctx.clearRect(0,0,width,height);
  ctx.font="9px monospace";ctx.fillStyle=isDarkTheme()?"#a9b7c2":"#8d99a2";ctx.strokeStyle=isDarkTheme()?"#33424f":"#edf0f2";ctx.lineWidth=1;
  for(let tick=0;tick<=4;tick++){
    const y=top+tick*plotH/4;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();
    const value=max-(tick/4)*(max-min);ctx.textAlign="right";ctx.fillText(value.toPrecision(3),left-6,y+3);
  }
  const hasElapsed=elapsedTimes?.length===channels[0].length&&elapsedTimes.length>0&&Number.isFinite(elapsedTimes[0])&&Number.isFinite(elapsedTimes[elapsedTimes.length-1]);
  const timeStart=hasElapsed?elapsedTimes[0]:0,timeEnd=hasElapsed?elapsedTimes[elapsedTimes.length-1]:channels[0].length/sampleRate;
  const timeSpan=Math.max(Number.EPSILON,timeEnd-timeStart);
  for(let tick=0;tick<=4;tick++){
    const x=left+tick*plotW/4;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,height-bottom);ctx.stroke();
    ctx.textAlign="center";ctx.fillText((timeStart+timeSpan*tick/4).toFixed(1),x,height-5);
  }
  arrays.forEach((arr,axis)=>{
    ctx.beginPath();ctx.strokeStyle=AXIS_COLORS[axis];ctx.lineWidth=1.05;
    if(arr.length<=plotW*2){
      for(let i=0;i<arr.length;i++){const fraction=hasElapsed?(elapsedTimes[i]-timeStart)/timeSpan:i/(arr.length-1);const x=left+fraction*plotW;const y=top+(max-arr[i])/(max-min)*plotH;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
    }else{
      for(let pixel=0;pixel<Math.ceil(plotW);pixel++){
        const start=Math.floor(pixel*arr.length/plotW),end=Math.max(start+1,Math.floor((pixel+1)*arr.length/plotW));
        let low=Infinity,high=-Infinity;for(let i=start;i<Math.min(end,arr.length);i++){low=Math.min(low,arr[i]);high=Math.max(high,arr[i]);}
        const x=left+pixel,yLow=top+(max-low)/(max-min)*plotH,yHigh=top+(max-high)/(max-min)*plotH;
        ctx.moveTo(x,yHigh);ctx.lineTo(x,yLow);
      }
    }
    ctx.stroke();
  });
  ctx.textAlign="left";arrays.forEach((_,axis)=>{ctx.fillStyle=AXIS_COLORS[axis];ctx.fillText(["X","Y","Z"][axis],left+axis*23,10);});
  ctx.textAlign="right";ctx.fillStyle=isDarkTheme()?"#a9b7c2":"#89969f";ctx.fillText(unit,width-right,10);
}

function drawPSD(canvas, spectrum, channelOffset, referenceSpectrum=null) {
  const {ctx,width,height}=setupCanvas(canvas,180),left=45,right=10,top=14,bottom=24,plotW=width-left-right,plotH=height-top-bottom;
  ctx.clearRect(0,0,width,height);
  const axes=spectrum?.channels?.slice(channelOffset,channelOffset+3),frequency=spectrum?.frequency;
  if(!axes||!frequency?.length)return;
  const maxHz=Math.min(50,frequency[frequency.length-1]);
  let minLog=Infinity,maxLog=-Infinity;
  axes.forEach((values)=>values.forEach((power,index)=>{if(frequency[index]<=maxHz&&power>0){const value=Math.log10(power);minLog=Math.min(minLog,value);maxLog=Math.max(maxLog,value);}}));
  if(referenceSpectrum)referenceSpectrum.channels.slice(channelOffset,channelOffset+3).forEach((values)=>values.forEach((power,index)=>{if(referenceSpectrum.frequency[index]<=maxHz&&power>0){const value=Math.log10(power);minLog=Math.min(minLog,value);maxLog=Math.max(maxLog,value);}}));
  if(!Number.isFinite(minLog)||!Number.isFinite(maxLog))return;
  if(maxLog-minLog<1){maxLog+=.5;minLog-=.5;}
  const y=(value)=>top+(maxLog-value)/(maxLog-minLog)*plotH,x=(hz)=>left+hz/maxHz*plotW;
  ctx.fillStyle=isDarkTheme()?"#203b3a":"#edf6f3";ctx.fillRect(x(3),top,x(Math.min(12,maxHz))-x(3),plotH);
  ctx.font="9px monospace";ctx.textAlign="right";ctx.fillStyle=isDarkTheme()?"#a9b7c2":"#8d99a2";ctx.strokeStyle=isDarkTheme()?"#33424f":"#edf0f2";
  for(let tick=0;tick<=4;tick++){const yy=top+tick*plotH/4;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(width-right,yy);ctx.stroke();ctx.fillText((maxLog-tick*(maxLog-minLog)/4).toFixed(1),left-6,yy+3);}
  for(let hz=0;hz<=maxHz;hz+=5){const xx=x(hz);ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,height-bottom);ctx.stroke();ctx.textAlign="center";ctx.fillText(String(hz),xx,height-5);}
  axes.forEach((values,axis)=>{ctx.beginPath();ctx.strokeStyle=AXIS_COLORS[axis];ctx.lineWidth=1.1;let started=false;for(let i=0;i<values.length;i++){if(frequency[i]>maxHz)break;const power=values[i];if(!(power>0))continue;const xx=x(frequency[i]),yy=y(Math.log10(power));if(!started){ctx.moveTo(xx,yy);started=true;}else ctx.lineTo(xx,yy);}ctx.stroke();});
  if(referenceSpectrum){
    const referenceAxes=referenceSpectrum.channels.slice(channelOffset,channelOffset+3),referenceFrequency=referenceSpectrum.frequency;
    referenceAxes.forEach((values,axis)=>{ctx.beginPath();ctx.strokeStyle=AXIS_COLORS[axis];ctx.lineWidth=1;ctx.setLineDash([3,3]);let started=false;for(let i=0;i<values.length;i++){if(referenceFrequency[i]>maxHz)break;const power=values[i];if(!(power>0))continue;const xx=x(referenceFrequency[i]),yy=y(Math.log10(power));if(!started){ctx.moveTo(xx,yy);started=true;}else ctx.lineTo(xx,yy);}ctx.stroke();});
    ctx.setLineDash([]);
  }
  ctx.textAlign="left";axes.forEach((_,axis)=>{ctx.fillStyle=AXIS_COLORS[axis];ctx.fillText(["X","Y","Z"][axis],left+axis*22,10);});
}

function drawBandPowerBars(canvas, summary, channelOffset) {
  const {ctx,width,height}=setupCanvas(canvas,122),left=42,right=8,top=12,bottom=25,plotW=width-left-right,plotH=height-top-bottom;
  ctx.clearRect(0,0,width,height);
  const bands=summary?.bands_hz,powers=summary?.channel_band_power;
  if(!Array.isArray(bands)||!Array.isArray(powers))return;
  const values=[];
  for(let axis=0;axis<3;axis++)for(let band=0;band<bands.length;band++){const value=powers[channelOffset+axis]?.[band];if(Number.isFinite(value)&&value>0)values.push(Math.log10(value));}
  if(!values.length)return;
  let minLog=Math.min(...values),maxLog=Math.max(...values);if(maxLog-minLog<1){minLog-=.5;maxLog+=.5;}
  const y=(value)=>top+(maxLog-value)/(maxLog-minLog)*plotH;
  ctx.font="8px monospace";ctx.textAlign="right";ctx.fillStyle=isDarkTheme()?"#a9b7c2":"#8d99a2";ctx.strokeStyle=isDarkTheme()?"#33424f":"#edf0f2";
  for(let tick=0;tick<=3;tick++){const yy=top+tick*plotH/3,logValue=maxLog-tick*(maxLog-minLog)/3;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(width-right,yy);ctx.stroke();ctx.fillText(logValue.toFixed(1),left-5,yy+3);}
  const groupWidth=plotW/bands.length,barWidth=Math.min(18,groupWidth*.2),gap=Math.min(3,groupWidth*.035),clusterWidth=barWidth*3+gap*2,baseY=top+plotH;
  bands.forEach((band,bandIndex)=>{
    const center=left+groupWidth*(bandIndex+.5),start=center-clusterWidth/2;
    for(let axis=0;axis<3;axis++){const power=powers[channelOffset+axis]?.[bandIndex];if(!Number.isFinite(power)||power<=0)continue;const yy=y(Math.log10(power));ctx.fillStyle=AXIS_COLORS[axis];ctx.fillRect(start+axis*(barWidth+gap),yy,barWidth,baseY-yy);}
    ctx.textAlign="center";ctx.fillStyle=isDarkTheme()?"#a9b7c2":"#8d99a2";ctx.fillText(`${bands[bandIndex][0]}–${bands[bandIndex][1]}`,center,height-7);
  });
  ctx.textAlign="left";["X","Y","Z"].forEach((axis,index)=>{ctx.fillStyle=AXIS_COLORS[index];ctx.fillText(axis,left+index*18,9);});
}

async function prepareSeeds() {
  if (!state.run?.seed_results?.length) return;
  const missing = state.run.seed_results.filter((item) => !state.seedRecords.has(String(item.seed)));
  await Promise.all(missing.map(async (item) => {
    const record = await runRecord(item);
    state.seedRecords.set(String(item.seed), record);
  }));
  if (state.selectedSeedTab !== "overview" && !state.run.seed_results.some((entry) => String(entry.seed) === String(state.selectedSeedTab))) state.selectedSeedTab="overview";
  if (state.selectedSeedTab !== "overview") state.selectedSeed=state.selectedSeedTab;
  else if (!state.selectedSeed || !state.run.seed_results.some((entry) => String(entry.seed) === String(state.selectedSeed))) state.selectedSeed=String(state.run.seed_results[0].seed);
  renderSeedTabs();
  if (state.selectedSeedTab === "overview") renderSeedOverview(); else renderSeedView();
}

function renderSeedTabs() {
  const entries = state.run?.seed_results || [];
  const overviewActive = state.selectedSeedTab === "overview";
  const overview = `<button class="seed-tab${overviewActive ? " active" : ""}" type="button" role="tab" aria-selected="${overviewActive}" data-seed-tab="overview">Overview</button>`;
  $("#seed-tabs").innerHTML = overview + entries.map((entry) => {
    const seed = String(entry.seed);
    const active = seed === String(state.selectedSeedTab);
    return `<button class="seed-tab${active ? " active" : ""}" type="button" role="tab" aria-selected="${active}" data-seed-tab="${escapeHTML(seed)}">Seed ${escapeHTML(seed)}</button>`;
  }).join("");
}

function renderSeedOverview() {
  renderSeedTabs();
  $("#seed-overview-panel").classList.remove("hidden");
  $("#seed-split-tabs").classList.add("hidden");
  $("#seed-kpis").classList.add("hidden");
  $("#oof-detail").classList.add("hidden");
  $("#test-detail").classList.add("hidden");
  $("#threshold-chip b").textContent="—";
  $("#page-title").textContent="Seed results overview";
  $("#page-subtitle").textContent=`${state.run.run_family} · compare cross-seed averages and individual seed metrics`;
  const records=(state.run.seed_results||[]).map((entry)=>state.seedRecords.get(String(entry.seed))).filter(Boolean);
  const meanSd=(values)=>{
    const valid=values.filter((value)=>typeof value==="number"&&Number.isFinite(value));
    if(!valid.length)return null;
    const mean=valid.reduce((sum,value)=>sum+value,0)/valid.length;
    const sd=valid.length>1?Math.sqrt(valid.reduce((sum,value)=>sum+(value-mean)**2,0)/(valid.length-1)):null;
    return {mean,sd,n:valid.length};
  };
  const displayAggregate=(result,percent)=>result?`${percent?fmtPct(result.mean):result.mean.toFixed(1)} ± ${result.sd===null?"N/A":percent?fmtPct(result.sd):result.sd.toFixed(1)}`:"N/A";
  const metricFor=(record,split,key)=>readMetric(split==="oof"?record.oof_metrics?.consensus:record.final_test_metrics,key);
  const countFor=(record,split)=>{
    if(split==="oof"){
      const events=record.oof_predictions?.events;
      return Array.isArray(events)?events.filter((event)=>event.consensus).length:readMetric(record.oof_metrics?.consensus,"n");
    }
    return readMetric(record.final_test_metrics,"n");
  };
  const aggregateRow=(label,split)=>{
    const ba=meanSd(records.map((record)=>metricFor(record,split,"ba")));
    const recall=meanSd(records.map((record)=>metricFor(record,split,"recall")));
    const specificity=meanSd(records.map((record)=>metricFor(record,split,"specificity")));
    const count=meanSd(records.map((record)=>countFor(record,split)));
    return `<tr><td>${label}</td><td>${displayAggregate(ba,true)}</td><td>${displayAggregate(recall,true)}</td><td>${displayAggregate(specificity,true)}</td><td>${displayAggregate(count,false)}</td></tr>`;
  };
  $("#seed-overview-summary").innerHTML=aggregateRow("OOF","oof")+aggregateRow("Final test / holdout","test");
  $("#seed-overview-rows").innerHTML=(state.run.seed_results||[]).map((entry)=>{
    const record=state.seedRecords.get(String(entry.seed));
    if(!record)return "";
    const oof=record.oof_metrics?.consensus;
    const test=record.final_test_metrics;
    const n=record.oof_predictions?.events?.filter((event)=>event.consensus).length ?? oof?.n ?? "—";
    return `<tr><td>Seed ${escapeHTML(entry.seed)}</td><td>${seedMetricCell(readMetric(oof,"ba"))}</td><td>${seedMetricCell(readMetric(oof,"recall"))}</td><td>${seedMetricCell(readMetric(oof,"specificity"))}</td><td>${escapeHTML(n)}</td><td>${seedMetricCell(readMetric(test,"ba"))}</td><td>${seedMetricCell(readMetric(test,"recall"))}</td><td>${seedMetricCell(readMetric(test,"specificity"))}</td><td>${escapeHTML(test?.n??"—")}</td></tr>`;
  }).join("");
}

function readMetric(metrics, key) {
  const value=metrics?.[key];return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function seedMetricCell(value) {
  return value === null ? "N/A" : fmtPct(value);
}

function seedMetricsForSplit(record, split) {
  return split === "oof" ? record.oof_metrics?.consensus ?? null : record.final_test_metrics;
}

function renderSeedView() {
  const selected=state.seedRecords.get(String(state.selectedSeed));if(!selected)return;
  $("#seed-overview-panel").classList.add("hidden");
  $("#seed-split-tabs").classList.remove("hidden");
  $("#seed-kpis").classList.remove("hidden");
  const split=state.split;
  const activeMetrics=seedMetricsForSplit(selected, split);
  const activeThreshold=split === "oof" ? selected.oof_threshold : selected.final_test_threshold;
  $("#threshold-chip b").textContent=fmt(activeThreshold,3);
  $("#page-title").textContent=split === "oof" ? `Seed ${selected.seed} · OOF analysis` : `Seed ${selected.seed} · final test`;
  $("#page-subtitle").textContent=`${state.run.run_family} · stored ${split === "oof" ? "out-of-fold" : "final-test"} results · no threshold tuning`;
  renderSeedTabs();
  const n=activeMetrics?.n ?? (split === "oof" ? selected.oof_predictions.events.length : 0);
  $("#seed-kpis").innerHTML=[
    kpiCard("BALANCED ACCURACY",seedMetricCell(readMetric(activeMetrics,"ba")),split === "oof" ? "Consensus events only" : "Stored evaluation metric","◉"),
    kpiCard("RECALL",seedMetricCell(readMetric(activeMetrics,"recall")),split === "oof" ? "Consensus events only" : "Stored evaluation metric","↗"),
    kpiCard("SPECIFICITY",seedMetricCell(readMetric(activeMetrics,"specificity")),split === "oof" ? "Consensus events only" : "Stored evaluation metric","↘"),
    kpiCard("EVENTS",n ? String(n) : "—",split === "oof" ? "Consensus events (A1 = A2)" : "Final-test aggregate count","⌁"),
  ].join("");
  $("#oof-detail").classList.toggle("hidden",split !== "oof");
  $("#test-detail").classList.toggle("hidden",split !== "test");
  if(split === "oof")renderOof(selected);else renderTest(selected);
}

function renderOof(record) {
  const events=record.oof_predictions.events||[];
  const hasPatientIds=record.oof_predictions.event_identity_available===true && events.some((event)=>event.patient_id!==null && event.patient_id!==undefined && String(event.patient_id)!=="");
  $("#oof-identity-note").textContent=hasPatientIds
    ? "Patient, action, filename, and source row identifiers are available. These remain OOF predictions from this seed, not LOSO results."
    : "This run did not save patient identifiers for OOF events, so they cannot be grouped by patient.";
  $("#seed-oof-view-tabs").classList.toggle("hidden",!hasPatientIds);
  $("#seed-patient-tab").classList.toggle("hidden",!hasPatientIds);
  if(!hasPatientIds)state.seedOofView="events";
  $("#seed-oof-view-tabs").querySelectorAll("[data-seed-oof-view]").forEach((button)=>{
    const active=button.dataset.seedOofView===state.seedOofView;
    button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));
  });
  $("#seed-oof-events").classList.toggle("hidden",state.seedOofView!=="events");
  $("#seed-oof-patients").classList.toggle("hidden",state.seedOofView!=="patients");
  $("#oof-threshold").textContent=`Stored threshold ${fmt(record.oof_threshold,3)}`;
  const chartRows=events.map((event,index)=>({index,probability:event.probability_from_stored_logit,disagreement:!event.consensus,status:event.consensus?(event.correct_on_consensus?"Correct":"Error"):"Disagreement",id:String(index)}));
  $("#oof-plot").innerHTML=makeProbabilitySvg(chartRows,record.oof_threshold,null,(item)=>({id:item.id,xLabel:`Array row ${item.index}`,probability:item.probability,disagreement:item.disagreement,status:item.status}));
  $("#oof-rows").innerHTML=events.map((event)=>{
    const status=event.consensus?(event.correct_on_consensus?["Correct","good"]:["Error","error"]):["Disagreement","disagreement"];
    return `<tr><td class="event-id">${escapeHTML(event.source_array_index)}</td><td>${escapeHTML(event.patient_id??"—")}</td><td>${escapeHTML(event.action??"—")}</td><td>${escapeHTML(event.source_hdf_index??"—")}</td><td class="label-pair">${escapeHTML(event.a1)} / ${escapeHTML(event.a2)}</td><td>${fmt(event.soft_target_stored,2)}</td><td class="probability-cell">${fmt(event.probability_from_stored_logit,3)}</td><td>${fmt(record.oof_threshold,3)}</td><td>${event.predicted_class_at_stored_oof_threshold?"Tremor":"No tremor"}</td><td><span class="badge ${status[1]}">${status[0]}</span></td></tr>`;
  }).join("");
    renderSeedPatientAnalysis(record,hasPatientIds);
}

function seedPatientGroups(record) {
  const groups=new Map();
  for(const event of record.oof_predictions?.events||[]) {
    if(event.patient_id===null||event.patient_id===undefined||String(event.patient_id)==="")continue;
    const id=String(event.patient_id);
    if(!groups.has(id))groups.set(id,[]);
    groups.get(id).push({...event,event_id:String(event.source_array_index),probability:event.probability_from_stored_logit,predicted_class:event.predicted_class_at_stored_oof_threshold});
  }
  return groups;
}

function renderSeedPatientAnalysis(record,hasPatientIds) {
  if(!hasPatientIds)return;
  const groups=seedPatientGroups(record);
  const summaries=[...groups.entries()].map(([id,events])=>({id,events,summary:metricSummary(events)}));
  summaries.sort((left,right)=>{
    const a=left.summary.consensus?(left.summary.fp+left.summary.fn)/left.summary.consensus:-1;
    const b=right.summary.consensus?(right.summary.fp+right.summary.fn)/right.summary.consensus:-1;
    return b-a || (right.summary.fp+right.summary.fn)-(left.summary.fp+left.summary.fn) || left.id.localeCompare(right.id,undefined,{numeric:true});
  });
  if(state.selectedSeedPatient&&!groups.has(String(state.selectedSeedPatient)))state.selectedSeedPatient=null;
  $("#seed-patient-count").textContent=`${summaries.length} patients`;
  $("#seed-patient-rows").innerHTML=summaries.map(({id,summary},index)=>{
    const specificity=summary.negative?`${summary.tn}/${summary.negative}`:"N/A";
    const recall=summary.positive?`${summary.tp}/${summary.positive}`:"N/A";
    const diagnosis=seedPatientMetadataValue(id,"Diagnosis-Coded");
    const age=seedPatientMetadataValue(id,"Age-Coded");
    return `<tr class="cohort-patient-row${id===String(state.selectedSeedPatient)?" selected-row":""}" data-seed-patient="${escapeHTML(id)}"><td>${index+1}</td><td class="event-id">${escapeHTML(id)}</td><td>${summary.consensus}/${summary.total}</td><td>${summary.negative}/${summary.positive}</td><td class="cohort-fraction">${specificity}</td><td class="cohort-fraction">${recall}</td><td>${escapeHTML(diagnosis)}</td><td>${escapeHTML(age)}</td></tr>`;
  }).join("")||'<tr><td colspan="8" class="empty-cell">No patient identifiers are available.</td></tr>';
  const selected=groups.get(String(state.selectedSeedPatient));
  if(!selected) {
    $("#seed-patient-title").textContent="Choose a patient";
    $("#seed-patient-summary").textContent="";
    $("#seed-patient-event-rows").innerHTML='<tr><td colspan="7" class="empty-cell">Select a patient to inspect its OOF events.</td></tr>';
  } else {
    const summary=metricSummary(selected);
    $("#seed-patient-title").textContent=`Patient ${state.selectedSeedPatient}`;
    $("#seed-patient-summary").textContent=`${summary.consensus}/${summary.total} consensus events · ${summary.fp+summary.fn} errors`;
    $("#seed-patient-event-rows").innerHTML=selected.map((event)=>{
      const status=eventStatus(event);
      return `<tr><td class="event-id">${escapeHTML(event.source_array_index)}</td><td>${escapeHTML(event.action??"—")}</td><td>${escapeHTML(event.source_hdf_index??"—")}</td><td>${escapeHTML(event.filename??"—")}</td><td class="label-pair">${escapeHTML(event.a1)} / ${escapeHTML(event.a2)}</td><td class="probability-cell">${fmt(event.probability,3)}</td><td><span class="badge ${status[1]}">${status[0]}</span></td></tr>`;
    }).join("");
  }
  $("#seed-patient-rows").querySelectorAll("[data-seed-patient]").forEach((row)=>row.addEventListener("click",()=>{
    state.selectedSeedPatient=row.dataset.seedPatient;
    renderSeedPatientAnalysis(record,true);
  }));
  ensureSeedPatientMetadata(groups.keys(),"oof",record);
}

function renderTest(record) {
  const metrics=record.final_test_metrics||{};
  $("#test-threshold").textContent=`Stored threshold ${fmt(record.final_test_threshold,3)}`;
  const fields=[["BA","ba"],["Recall","recall"],["Specificity","specificity"],["Precision","precision"],["F1","f1"],["ROC-AUC","roc_auc"],["PR-AUC","pr_auc"],["N","n"],["Loss","loss"]];
  $("#test-metrics").innerHTML=fields.map(([label,key])=>{
    const value=metrics[key];const display=typeof value === "number" ? (key==="n"?String(value):fmtPct(value)) : (value===undefined||value===null?"N/A":String(value));
    return `<div class="test-metric"><span>${escapeHTML(label)}</span><b>${escapeHTML(display)}</b></div>`;
  }).join("");
  const cm=metrics.confusion_matrix;
  if(Array.isArray(cm)&&cm.length===2){
    $("#confusion-matrix").innerHTML=`<div class="confusion-title">CONFUSION MATRIX · STORED COUNTS</div><table class="confusion-table"><thead><tr><th></th><th>Pred 0</th><th>Pred 1</th></tr></thead><tbody><tr><th>True 0</th><td>${escapeHTML(cm[0]?.[0])}</td><td>${escapeHTML(cm[0]?.[1])}</td></tr><tr><th>True 1</th><td>${escapeHTML(cm[1]?.[0])}</td><td>${escapeHTML(cm[1]?.[1])}</td></tr></tbody></table>`;
  }else $("#confusion-matrix").textContent="No confusion matrix is present in this run artifact.";
  renderHoldoutPatientAnalysis(record,record.final_test_event_predictions_available===true);
}

function renderHoldoutPatientAnalysis(record,hasPatientIds) {
  const events=record.holdout_predictions?.events||[];
  hasPatientIds=hasPatientIds&&events.some((event)=>event.patient_id!==null&&event.patient_id!==undefined&&String(event.patient_id)!=="");
  $("#test-identity-note").textContent=hasPatientIds
    ? "Patient, action, filename, source row, labels, and stored-threshold predictions are available for the final-test events."
    : "This run does not contain patient-identified final-test event predictions.";
  $("#seed-test-view-tabs").classList.toggle("hidden",!hasPatientIds);
  $("#test-aggregate-panel").classList.toggle("hidden",hasPatientIds&&state.seedTestView==="patients");
  $("#test-patient-panel").classList.toggle("hidden",!hasPatientIds||state.seedTestView!=="patients");
  $("#seed-test-view-tabs").querySelectorAll("[data-seed-test-view]").forEach((button)=>{
    const active=button.dataset.seedTestView===state.seedTestView;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));
  });
  if(!hasPatientIds)return;
  const groups=new Map();
  for(const event of events) {
    if(event.patient_id===null||event.patient_id===undefined||String(event.patient_id)==="")continue;
    const id=String(event.patient_id);
    if(!groups.has(id))groups.set(id,[]);
    groups.get(id).push({...event,event_id:String(event.source_array_index),probability:event.probability_from_stored_logit,predicted_class:event.predicted_class_at_stored_threshold});
  }
  const summaries=[...groups.entries()].map(([id,rows])=>({id,rows,summary:metricSummary(rows)}));
  summaries.sort((left,right)=>{
    const a=left.summary.consensus?(left.summary.fp+left.summary.fn)/left.summary.consensus:-1;
    const b=right.summary.consensus?(right.summary.fp+right.summary.fn)/right.summary.consensus:-1;
    return b-a||(right.summary.fp+right.summary.fn)-(left.summary.fp+left.summary.fn)||left.id.localeCompare(right.id,undefined,{numeric:true});
  });
  summaries.forEach((row,index)=>{row.difficultyRank=index+1;row.diagnosis=seedPatientMetadataValue(row.id,"Diagnosis-Coded");row.age=seedPatientMetadataValue(row.id,"Age-Coded");});
  if(state.holdoutHeaderSort) {
    const direction=state.holdoutHeaderDirection==="asc"?1:-1;
    summaries.sort((left,right)=>{
      const key=state.holdoutHeaderSort;
      let a,b;
      if(key==="rank"){a=left.difficultyRank;b=right.difficultyRank;}
      else if(key==="patient")return direction*left.id.localeCompare(right.id,undefined,{numeric:true});
      else if(key==="consensus"){a=left.summary.total?left.summary.consensus/left.summary.total:null;b=right.summary.total?right.summary.consensus/right.summary.total:null;}
      else if(key==="class-count"){a=left.summary.negative;b=right.summary.negative;if(a===b){a=left.summary.positive;b=right.summary.positive;}}
      else if(key==="specificity"){a=left.summary.negative?left.summary.tn/left.summary.negative:null;b=right.summary.negative?right.summary.tn/right.summary.negative:null;}
      else if(key==="recall"){a=left.summary.positive?left.summary.tp/left.summary.positive:null;b=right.summary.positive?right.summary.tp/right.summary.positive:null;}
      else if(key==="diagnosis"){a=left.diagnosis;b=right.diagnosis;}
      else {a=left.age;b=right.age;}
      if(a===null&&b!==null)return 1;
      if(b===null&&a!==null)return -1;
      const order=typeof a==="string"?a.localeCompare(b,undefined,{numeric:true}):a-b;
      return direction*order||left.id.localeCompare(right.id,undefined,{numeric:true});
    });
  }
  if(state.selectedHoldoutPatient&&!groups.has(String(state.selectedHoldoutPatient)))state.selectedHoldoutPatient=null;
  $("#test-patient-count").textContent=`${summaries.length} patients`;
  $("#test-patient-rows").innerHTML=summaries.map(({id,summary,diagnosis,age},index)=>{
    const specificity=summary.negative?`${summary.tn}/${summary.negative}`:"N/A";
    const recall=summary.positive?`${summary.tp}/${summary.positive}`:"N/A";
    return `<tr class="cohort-patient-row${id===String(state.selectedHoldoutPatient)?" selected-row":""}" data-holdout-patient="${escapeHTML(id)}"><td>${index+1}</td><td class="event-id">${escapeHTML(id)}</td><td>${summary.consensus}/${summary.total}</td><td>${summary.negative}/${summary.positive}</td><td class="cohort-fraction">${specificity}</td><td class="cohort-fraction">${recall}</td><td>${escapeHTML(diagnosis)}</td><td>${escapeHTML(age)}</td></tr>`;
  }).join("")||'<tr><td colspan="8" class="empty-cell">No patient identifiers are available.</td></tr>';
  document.querySelectorAll(".seed-holdout-sort-button").forEach((button)=>{
    const active=state.holdoutHeaderSort===button.dataset.holdoutSort;
    const label=button.dataset.label||button.textContent.trim();button.dataset.label=label;
    button.innerHTML=`${escapeHTML(label)}${active?`<span aria-hidden="true"> ${state.holdoutHeaderDirection==="asc"?"&uarr;":"&darr;"}</span>`:""}`;
    button.setAttribute("aria-label",active?`${label}, sorted ${state.holdoutHeaderDirection==="asc"?"ascending":"descending"}`:`Sort by ${label}`);
    button.closest("th").setAttribute("aria-sort",active?(state.holdoutHeaderDirection==="asc"?"ascending":"descending"):"none");
  });
  const selected=groups.get(String(state.selectedHoldoutPatient));
  if(!selected) {
    $("#test-patient-title").textContent="Choose a patient";
    $("#test-patient-summary").textContent="";
    $("#test-patient-event-rows").innerHTML='<tr><td colspan="7" class="empty-cell">Select a patient to inspect its holdout events.</td></tr>';
  } else {
    const summary=metricSummary(selected);
    $("#test-patient-title").textContent=`Patient ${state.selectedHoldoutPatient}`;
    $("#test-patient-summary").textContent=`${summary.consensus}/${summary.total} consensus events · ${summary.fp+summary.fn} errors`;
    $("#test-patient-event-rows").innerHTML=selected.map((event)=>{
      const status=eventStatus(event);
      return `<tr><td class="event-id">${escapeHTML(event.source_array_index)}</td><td>${escapeHTML(event.action??"—")}</td><td>${escapeHTML(event.source_hdf_index??"—")}</td><td>${escapeHTML(event.filename??"—")}</td><td class="label-pair">${escapeHTML(event.a1)} / ${escapeHTML(event.a2)}</td><td class="probability-cell">${fmt(event.probability,3)}</td><td><span class="badge ${status[1]}">${status[0]}</span></td></tr>`;
    }).join("");
  }
  $("#test-patient-rows").querySelectorAll("[data-holdout-patient]").forEach((row)=>row.addEventListener("click",()=>{
    openHoldoutPatient(row.dataset.holdoutPatient,record).catch((error)=>{
      $("#holdout-patient-load-status").textContent=`Could not open patient inspection: ${error.message||error}`;
      $("#holdout-patient-load-status").classList.remove("hidden");
    });
  }));
  ensureSeedPatientMetadata(groups.keys(),"test",record);
}

async function openHoldoutPatient(patientId,record) {
  const token=++state.holdoutOpenToken;
  const seed=String(state.selectedSeed);
  state.selectedHoldoutPatient=String(patientId);
  $("#holdout-patient-load-status").textContent="Loading patient metadata and source segments…";
  $("#holdout-patient-load-status").classList.remove("hidden");
  const [metadata,signals] = await Promise.all([
    readDatasetJSON(`patients/${patientId}.json`),
    sourceSignalsForPatient(patientId),
  ]);
  if(token!==state.holdoutOpenToken||seed!==String(state.selectedSeed)||state.split!=="test")return;
  const events=(record.holdout_predictions?.events||[]).filter((event)=>String(event.patient_id)===String(patientId));
  const normalized=events.map((event)=>{
    const filename=String(event.filename||"").split(/[\\/]/).pop().toLocaleLowerCase();
    const matchingRows=filename?signals.filter((row)=>String(row.patient_id)===String(event.patient_id)&&row.action===event.action&&String(row.source_filename||"").split(/[\\/]/).pop().toLocaleLowerCase()===filename):[];
    const candidates=matchingRows.map((row)=>({
      source_h5_index:row.source_h5_index,source_filename:row.source_filename,source_file:row.source_file,device:row.device,
      source_segment_index:row.source_segment_index,epoch:row.epoch,previous_epoch:row.previous_epoch,next_epoch:row.next_epoch,
      nearest_transition_index:row.nearest_transition_index,start_elapsed_time_s:row.start_elapsed_time_s,end_elapsed_time_s:row.end_elapsed_time_s,
      start_timestamp_us:row.start_timestamp_us,end_timestamp_us:row.end_timestamp_us,
      dataset_a1:row.a1,dataset_a2:row.a2,
      sample_count:row.sample_count,signal_ref:row.signal_ref,spectrum_ref:row.spectrum_ref,
      elapsed_time_ref:row.elapsed_time_ref,elapsed_time_sample_count:row.elapsed_time_sample_count,
      spectrum_frequency_count:row.spectrum_frequency_count,spectrum_nperseg:row.spectrum_nperseg,
      frequency_summary:row.frequency_summary,
      match_method:matchingRows.length===1?"Unique patient/action/filename match":"Candidate matches patient/action/filename; source remains ambiguous",
    }));
    const consensus=Number(event.a1)===Number(event.a2)&&[0,1].includes(Number(event.a1));
    return {
      ...event,event_id:String(event.source_array_index),source_npz_index:event.source_array_index,
      probability:event.probability_from_stored_logit,soft_target_stored:event.soft_target_from_a1_a2,
      predicted_class:event.predicted_class_at_stored_threshold,consensus,
      correct_on_consensus:consensus?Number(event.predicted_class_at_stored_threshold)===Number(event.a1):null,
      signal_match:candidates.length===1?{status:"matched",candidates}:candidates.length>1?{status:"ambiguous",reason:"Multiple dataset source rows match this patient's action and filename.",candidates}:{status:"unmatched",reason:"No dataset source row matches this patient's action and filename.",candidates:[]},
    };
  });
  const previousPatientData=state.patientData;
  state.holdoutReturnState={patientData:previousPatientData,patient:state.patient,selectedEventId:state.selectedEventId,globalTab:state.globalTab};
  state.patient=String(patientId);
  state.selectedEventId=null;
  state.patientData={patient_id:String(patientId),events:normalized,source_transition_events:transitionSignalEvents(signals,normalized),metadata_records:metadata.metadata_records||[],metadata_match_count:(metadata.metadata_records||[]).length,analysis_threshold:record.final_test_threshold};
  state.globalTab="subject";
  $("#subject-panel").classList.remove("hidden");
  $("#seed-subject-mount").appendChild($("#subject-panel"));
  $("#holdout-patient-cohort").classList.add("hidden");
  $("#holdout-patient-inspection").classList.remove("hidden");
  $("#holdout-patient-load-status").classList.add("hidden");
  renderPatient();
  updateGlobalHeading();
  $("#page-title").textContent=`Patient ${patientId} · final test`;
}

function closeHoldoutPatient() {
  ++state.holdoutOpenToken;
  if(!state.holdoutReturnState)return;
  ++state.signalToken;
  const panel=$("#subject-panel"),anchor=$("#subject-panel-anchor");
  panel.classList.add("hidden");
  anchor.parentNode.insertBefore(panel,anchor.nextSibling);
  $("#holdout-patient-inspection").classList.add("hidden");
  $("#holdout-patient-cohort").classList.remove("hidden");
  state.patientData=state.holdoutReturnState.patientData;
  state.patient=state.holdoutReturnState.patient;
  state.selectedEventId=state.holdoutReturnState.selectedEventId;
  state.globalTab=state.holdoutReturnState.globalTab;
  state.holdoutReturnState=null;
  setSignalEmpty("Choose an event to load its signal. Ambiguous links require you to choose a source record.");
  renderHoldoutPatientAnalysis(state.seedRecords.get(String(state.selectedSeed)),true);
}

function setView(view) {
  if(view!=="seeds")closeHoldoutPatient();
  state.activeView=view;
  document.querySelectorAll(".nav-item").forEach((button)=>{const active=button.dataset.view===view;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));});
  $("#global-view").classList.toggle("hidden",view!=="global");
  $("#seed-view").classList.toggle("hidden",view!=="seeds");
  $("#global-controls").classList.toggle("hidden",view!=="global" || state.globalTab!=="subject");
  if(view==="global"){
    $("#page-title").textContent=state.globalTab === "subject" ? "Patient inspection" : state.globalTab === "cohort" ? "Global LOSO cohort" : "Global LOSO overview";
    setGlobalTab(state.globalTab);
    if(state.patientData && state.globalTab === "subject")renderGlobalEvents();
  }else{
    $("#page-title").textContent="Seed results";
    prepareSeeds().catch(showError);
  }
}

function installHandlers() {
  applyTheme("system");
  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  colorScheme.addEventListener?.("change", () => applyTheme("system"));
  $("#retry-button").addEventListener("click",()=>{$("#error-state").classList.add("hidden");$("#loading-state").classList.remove("hidden");});
  const updateUploadReady = () => { $("#open-workspace-button").disabled = !(state.uploadedDataset && state.uploadedRuns.length); };
  const handleRunFiles = async(files, append) => {
    if(!files.length)return;
    if(!append){state.workspaceCached=false;state.cacheDisabledForSession=false;}
    $("#upload-status").textContent=`Reading ${files.length} run JSON file${files.length===1?"":"s"}…`;
    try{
      const selectedIndex=await loadRunUpload(files,{append});
      if(append){
        state.workspaceCached=false;state.cacheDisabledForSession=false;
        $("#run-file-name").textContent=state.runUploadName;
        renderRunSelector(selectedIndex);
        await selectRun(selectedIndex);
      }else{
        $("#run-file-name").textContent=state.runUploadName;
      }
      $("#upload-status").textContent=`${state.uploadedRuns.length} run${state.uploadedRuns.length===1?"":"s"} ready · same-dataset check pending`;
      updateUploadReady();
      await cacheSelectedPair();
    }catch(error){
      if(!append){state.uploadedRun=null;state.uploadedRuns=[];state.runUploadText=null;}
      $("#upload-status").textContent=`Run JSON error: ${error.message||error}`;
    }
  };
  $("#dataset-file").addEventListener("change",async(event)=>{
    const file=event.target.files?.[0];if(!file)return;
    state.workspaceCached=false;state.cacheDisabledForSession=false;
    $("#dataset-file-name").textContent=file.name;$("#upload-status").textContent="Reading dataset archive…";
    try{await loadDatasetUpload(file);$("#upload-status").textContent=`Dataset ready · ${state.uploadedDataset.counts?.signals ?? "—"} source records`;}catch(error){state.uploadedDataset=null;$("#upload-status").textContent=`Dataset ZIP error: ${error.message||error}`;}
    updateUploadReady();
    await cacheSelectedPair();
  });
  $("#run-file").addEventListener("change",async(event)=>{
    const files=Array.from(event.target.files||[]);if(!files.length)return;
    await handleRunFiles(files,state.addingRuns);
    state.addingRuns=false;
    event.target.value="";
  });
  $("#add-run-file").addEventListener("change",async(event)=>{
    const files=Array.from(event.target.files||[]);if(!files.length){state.addingRuns=false;return;}
    await handleRunFiles(files,true);
    state.addingRuns=false;
    event.target.value="";
  });
  $("#open-workspace-button").addEventListener("click",openUploadedWorkspace);
  $("#forget-data-button").addEventListener("click",()=>forgetWorkspaceCopy().catch((error)=>{$("#upload-status").textContent=`Could not delete saved copy: ${error.message||error}`;}));
  $("#change-data-button").addEventListener("click",()=>{$("#dashboard").classList.add("hidden");$("#error-state").classList.add("hidden");$("#loading-state").classList.remove("hidden");});
  $("#run-select").addEventListener("change",(event)=>{
    if(event.target.value==="__add_run__"){
      event.target.value=String(state.currentRunIndex);
      state.addingRuns=true;
      const input=$("#add-run-file");input.value="";input.click();
      return;
    }
    selectRun(Number(event.target.value)).catch(showError);
  });
  $("#patient-select").addEventListener("change",(event)=>selectPatient(event.target.value).catch(showError));
  $("#signal-filter-type").addEventListener("change",()=>{updateSignalFilterControls();applySignalFilter();});
  ["#signal-filter-low","#signal-filter-high"].forEach((selector)=>$(selector).addEventListener("input",applySignalFilter));
  $("#signal-source-psd").addEventListener("change",()=>{
    if(!state.signalSpectrum)return;
    const reference=$("#signal-source-psd").checked?state.signalOriginalSpectrum:null;
    drawPSD($("#acc-psd-canvas"),state.signalSpectrum,0,reference);
    drawPSD($("#gyr-psd-canvas"),state.signalSpectrum,3,reference);
  });
  $("#action-filter").addEventListener("change",()=>{renderProbabilityPlot();renderEventTable();});
  $("#event-filter").addEventListener("change",()=>{renderProbabilityPlot();renderEventTable();});
  $("#event-search").addEventListener("input",renderEventTable);
  document.querySelectorAll("#global-view .global-tab").forEach((button)=>button.addEventListener("click",()=>setGlobalTab(button.dataset.globalTab)));
  $("#cohort-sort").addEventListener("change",()=>{state.cohortHeaderSort=null;renderCohort();});
  ["#cohort-action","#cohort-classes"].forEach((selector)=>$(selector).addEventListener("change",renderCohort));
  $("#cohort-min-n").addEventListener("change",renderCohort);
  document.querySelectorAll(".cohort-sort-button").forEach((button)=>button.addEventListener("click",()=>{
    const key=button.dataset.cohortSort;
    if(state.cohortHeaderSort===key)state.cohortHeaderDirection=state.cohortHeaderDirection==="asc"?"desc":"asc";
    else{state.cohortHeaderSort=key;state.cohortHeaderDirection=key==="error-rate"?"desc":"asc";}
    renderCohort();
  }));
  $("#cohort-reset").addEventListener("click",()=>{
    $("#cohort-sort").value="error-rate";$("#cohort-action").value="all";$("#cohort-classes").value="any";$("#cohort-min-n").value="1";state.cohortHeaderSort=null;renderCohort();
  });
  $("#seed-tabs").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-seed-tab]");if(!button)return;
    closeHoldoutPatient();
    state.selectedSeedTab=button.dataset.seedTab;
    if(state.selectedSeedTab!=="overview"){
      state.selectedSeed=state.selectedSeedTab;
      state.seedOofView="events";
      state.selectedSeedPatient=null;
      state.seedTestView="summary";
      state.selectedHoldoutPatient=null;
      state.holdoutHeaderSort=null;
      state.holdoutHeaderDirection="desc";
    }
    renderSeedTabs();
    if(state.selectedSeedTab==="overview")renderSeedOverview();else renderSeedView();
  });
  $("#seed-oof-view-tabs").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-seed-oof-view]");if(!button)return;
    state.seedOofView=button.dataset.seedOofView;
    $("#seed-oof-view-tabs").querySelectorAll("[data-seed-oof-view]").forEach((item)=>{
      const active=item===button;item.classList.toggle("active",active);item.setAttribute("aria-selected",String(active));
    });
    const selected=state.seedRecords.get(String(state.selectedSeed));
    if(selected)renderOof(selected);
  });
  $("#seed-test-view-tabs").addEventListener("click",(event)=>{
    const button=event.target.closest("[data-seed-test-view]");if(!button)return;
    closeHoldoutPatient();
    state.seedTestView=button.dataset.seedTestView;
    const selected=state.seedRecords.get(String(state.selectedSeed));
    if(selected)renderTest(selected);
  });
  document.querySelectorAll(".seed-holdout-sort-button").forEach((button)=>button.addEventListener("click",()=>{
    const key=button.dataset.holdoutSort;
    if(state.holdoutHeaderSort===key)state.holdoutHeaderDirection=state.holdoutHeaderDirection==="asc"?"desc":"asc";
    else{state.holdoutHeaderSort=key;state.holdoutHeaderDirection=key==="consensus"?"desc":"asc";}
    const selected=state.seedRecords.get(String(state.selectedSeed));
    if(selected)renderHoldoutPatientAnalysis(selected,true);
  }));
  $("#holdout-back-button").addEventListener("click",closeHoldoutPatient);
  document.querySelectorAll(".nav-item").forEach((button)=>button.addEventListener("click",()=>setView(button.dataset.view)));
  document.querySelectorAll(".segment").forEach((button)=>button.addEventListener("click",()=>{
    closeHoldoutPatient();
    state.split=button.dataset.split;document.querySelectorAll(".segment").forEach((item)=>{const active=item===button;item.classList.toggle("active",active);item.setAttribute("aria-selected",String(active));});renderSeedView();
  }));
  $("#about-button").addEventListener("click",()=>$("#about-dialog").showModal());
  window.addEventListener("resize",()=>{
    const event=state.patientData?.events.find((item)=>item.event_id===state.selectedEventId);
    if(event?.signal_match?.status==="matched")renderSelectedEvent(event);
  });
}

installHandlers();
restoreWorkspaceCopy();
