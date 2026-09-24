const DEFAULT_CATALOG = "./local-data/catalog.json";
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
  seedRecords: new Map(),
  split: "oof",
  activeView: "global",
  signalToken: 0,
  signalChannels: null,
  signalFrequencySummary: null,
  signalSpectrum: null,
};

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[char]));
const fmt = (value, digits = 3) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const fmtPct = (value) => typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A";

function applyTheme(preference) {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111922" : "#f5f7fa");
  if (state.patientData) renderProbabilityPlot();
  if (state.activeView === "seeds" && state.selectedSeed) renderSeedView();
  if (state.signalChannels && state.dataset?.signal) {
    const channels = state.signalChannels, rate = state.dataset.signal.sampling_rate_hz;
    drawTimeSeries($("#acc-canvas"), channels, rate, 0, "m/s²");
    drawTimeSeries($("#gyr-canvas"), channels, rate, 3, "deg/s");
    drawPSD($("#acc-psd-canvas"), state.signalSpectrum, 0);
    drawPSD($("#gyr-psd-canvas"), state.signalSpectrum, 3);
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

async function fetchGzipArrayBuffer(url) {
  const response = await fetch(url, {cache:"force-cache"});
  if (!response.ok) throw new Error(`Asset request failed (${response.status})`);
  if (!("DecompressionStream" in window)) throw new Error("This browser does not support gzip stream decompression.");
  const stream = new Blob([await response.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"));
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
  $("#error-message").textContent = `${error.message || error}. Check that the local server is running from the project folder and that local-data/catalog.json exists.`;
}

async function boot() {
  $("#error-state").classList.add("hidden");
  $("#loading-state").classList.remove("hidden");
  try {
    const queryCatalog = new URLSearchParams(location.search).get("catalog");
    const catalogURL = queryCatalog || DEFAULT_CATALOG;
    state.catalog = await fetchJSON(catalogURL);
    if (!Array.isArray(state.catalog.runs) || !state.catalog.runs.length || !state.catalog.datasetManifest || !state.catalog.datasetBase) {
      throw new Error("Catalog must define datasetManifest, datasetBase, and at least one run.");
    }
    state.datasetBase = new URL(state.catalog.datasetBase, location.href);
    state.dataset = await fetchJSON(new URL(state.catalog.datasetManifest, location.href));
    $("#dataset-status").textContent = `${state.dataset.counts?.signals ?? "—"} source records · ${(state.dataset.dataset_id || "").slice(0, 10)}`;
    $("#run-select").innerHTML = state.catalog.runs.map((run, index) => `<option value="${index}">${escapeHTML(run.label || run.id || `Run ${index + 1}`)}</option>`).join("");
    $("#run-select").disabled = false;
    $("#global-count").textContent = "LOSO";
    $("#seed-count").textContent = String(state.catalog.seedCount || "—");
    $("#loading-state").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    await selectRun(0);
  } catch (error) {
    showError(error);
  }
}

async function selectRun(index) {
  state.runChoice = state.catalog.runs[index];
  const manifestURL = new URL(state.runChoice.manifest, location.href);
  state.runBase = new URL(".", manifestURL);
  state.run = await fetchJSON(manifestURL);
  if (state.run.dataset_id !== state.dataset.dataset_id) {
    throw new Error(`Run expects dataset ${state.run.dataset_id}, but catalog loaded ${state.dataset.dataset_id}.`);
  }
  state.stratifiedSummary = state.run.stratified_summary_ref
    ? await fetchJSON(new URL(state.run.stratified_summary_ref, state.runBase)) : null;
  $("#threshold-chip b").textContent = fmt(state.run.threshold, 3);
  $("#seed-count").textContent = String(state.run.seed_results?.length ?? 0);
  populatePatients();
  state.seedRecords.clear();
  state.patientData = null;
  renderGlobalKpis();
  renderStratifiedSummary();
  if (state.patient) await selectPatient(state.patient);
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
  if (state.run.seed_results?.length) {
    $("#seed-select").innerHTML = state.run.seed_results.map((entry) => `<option value="${escapeHTML(entry.seed)}">Seed ${escapeHTML(entry.seed)}</option>`).join("");
    $("#seed-select").disabled = false;
    if (!state.run.seed_results.some((entry) => String(entry.seed) === String(state.selectedSeed))) state.selectedSeed = String(state.run.seed_results[0].seed);
    $("#seed-select").value = state.selectedSeed;
  }
}

async function selectPatient(patientId) {
  state.patient = patientId;
  state.selectedEventId = null;
  $("#patient-select").value = patientId;
  const info = state.run.patients.find((item) => String(item.patient_id) === String(patientId));
  if (!info) return;
  const record = await fetchJSON(new URL(info.data_ref, state.runBase));
  if (record.shared_metadata_ref) {
    const metadataRecord = await fetchJSON(new URL(record.shared_metadata_ref, state.datasetBase));
    record.metadata_records = metadataRecord.metadata_records || [];
  }
  state.patientData = record;
  renderPatient();
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

function filteredEvents() {
  const events = state.patientData?.events || [];
  const action = $("#action-filter").value;
  const category = $("#event-filter").value;
  const search = $("#event-search").value.trim().toLowerCase();
  return events.filter((event) => {
    if (action !== "all" && event.action !== action) return false;
    if (category === "consensus" && !event.consensus) return false;
    if (category === "disagreement" && event.a1 === event.a2) return false;
    if (category === "errors" && !(event.consensus && event.correct_on_consensus === false)) return false;
    if (search && !`${event.action} ${event.event_id} ${event.a1} ${event.a2}`.toLowerCase().includes(search)) return false;
    return true;
  });
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
  return "Unknown";
}

function renderGlobalEvents() {
  const events = state.patientData?.events || [];
  const summary = metricSummary(events);
  $("#event-count").textContent = `${filteredEvents().length} / ${events.length}`;
  const n = events.length;
  const threshold = state.run.threshold;
  const data = events.map((event) => {
    const [status] = eventStatus(event);
    return { probability: event.probability, label: event.a1 === event.a2 ? Number(event.a1) : null, disagreement: event.a1 !== event.a2, predicted: event.predicted_class, id: event.event_id, status };
  });
  const errorRate = summary.consensus ? fmtPct((summary.fp + summary.fn) / summary.consensus) : "N/A";
  $("#page-title").textContent = `Global LOSO inspection`;
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
  $("#probability-plot").innerHTML = makeProbabilitySvg(events, state.run.threshold, state.selectedEventId, (event) => {
    const [status] = eventStatus(event);
    return {id:event.event_id,xLabel:event.event_id,probability:event.probability,disagreement:event.a1 !== event.a2,status};
  });
  $("#probability-plot").querySelectorAll(".event-point").forEach((point) => point.addEventListener("click", () => selectEvent(point.dataset.eventId)));
}

function renderEventTable() {
  const rows = filteredEvents();
  $("#event-count").textContent = `${rows.length} / ${state.patientData?.events?.length || 0}`;
  if (!rows.length) {
    $("#event-rows").innerHTML = `<tr><td colspan="7" class="empty-cell">No events match these filters.</td></tr>`;
    return;
  }
  $("#event-rows").innerHTML = rows.map((event) => {
    const [status, tone] = eventStatus(event);
    const soft = event.soft_target_stored;
    const model = Number(event.predicted_class) === 1 ? "Tremor" : "No tremor";
    return `<tr data-event-id="${escapeHTML(event.event_id)}" class="${event.event_id === state.selectedEventId ? "selected-row" : ""}">
      <td class="event-id">${escapeHTML(event.event_id)}</td><td>${escapeHTML(actionName(event.action))}</td><td>${escapeHTML(eventSide(event))}</td><td class="label-pair">${escapeHTML(event.a1)} / ${escapeHTML(event.a2)}</td>
      <td>${fmt(soft, 2)}</td><td class="probability-cell">${fmt(event.probability, 3)}</td><td>${model}</td><td><span class="badge ${tone}">${escapeHTML(status)}</span></td></tr>`;
  }).join("");
  $("#event-rows").querySelectorAll("tr[data-event-id]").forEach((row) => row.addEventListener("click", () => selectEvent(row.dataset.eventId)));
}

async function selectEvent(eventId) {
  state.selectedEventId = eventId;
  const event = state.patientData?.events.find((item) => item.event_id === eventId);
  renderProbabilityPlot();
  renderEventTable();
  await renderSelectedEvent(event);
}

async function renderSelectedEvent(event) {
  const token = ++state.signalToken;
  if (!event) return;
  $("#signal-title").textContent = `${actionName(event.action)} · event ${event.source_npz_index}`;
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
    $("#signal-provenance").textContent = `Laterality: ${filenameSide(candidate.source_filename) || "unknown"} · ${ambiguous ? "Researcher-selected candidate; match remains ambiguous" : "Unique closest-duration match"} · HDF5 row ${candidate.source_h5_index} · ${candidate.source_filename || "source filename not recorded"} · ${candidate.device || "device not recorded"} · ${candidate.sample_count} samples · ${fmt(state.dataset.signal.sampling_rate_hz, 1)} Hz filtered preview from ${fmt(state.dataset.signal.source_sampling_rate_hz, 1)} Hz source`;
    $("#signal-empty").textContent = "Loading selected signal…";
    $("#signal-empty").classList.remove("hidden");
    try {
      const [raw, spectrumRaw] = await Promise.all([
        fetchGzipArrayBuffer(new URL(candidate.signal_ref, base)),
        fetchGzipArrayBuffer(new URL(candidate.spectrum_ref, base)),
      ]);
      const channels = decodeFloatChannels(raw, candidate.sample_count);
      const spectrum = decodeSpectrum(spectrumRaw, candidate.spectrum_frequency_count, candidate.spectrum_nperseg, state.dataset.signal.source_sampling_rate_hz);
      if (token !== state.signalToken) return;
      state.signalChannels = channels;
      state.signalFrequencySummary = candidate.frequency_summary;
      state.signalSpectrum = spectrum;
      drawTimeSeries($("#acc-canvas"), channels, state.dataset.signal.sampling_rate_hz, 0, "m/s²");
      drawTimeSeries($("#gyr-canvas"), channels, state.dataset.signal.sampling_rate_hz, 3, "deg/s");
      drawPSD($("#acc-psd-canvas"), state.signalSpectrum, 0);
      drawPSD($("#gyr-psd-canvas"), state.signalSpectrum, 3);
      drawBandPowerBars($("#acc-band-canvas"), state.signalFrequencySummary, 0);
      drawBandPowerBars($("#gyr-band-canvas"), state.signalFrequencySummary, 3);
      $("#signal-empty").classList.add("hidden");
    } catch (error) {
      if (token !== state.signalToken) return;
      setSignalEmpty(`${error.message}. The prediction and labels are still available.`);
    }
  };
  select.onchange = () => loadCandidate(select.value);
  if (!ambiguous && match.candidates.length === 1) {
    select.value = "0";
    await loadCandidate("0");
  } else {
    select.value = "";
    await loadCandidate("");
  }
}

function setSignalEmpty(message) {
  state.signalChannels = null;
  state.signalFrequencySummary = null;
  state.signalSpectrum = null;
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

function drawTimeSeries(canvas, channels, sampleRate, offset, unit) {
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
  const duration=channels[0].length/sampleRate;
  for(let tick=0;tick<=4;tick++){
    const x=left+tick*plotW/4;ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,height-bottom);ctx.stroke();
    ctx.textAlign="center";ctx.fillText((duration*tick/4).toFixed(1),x,height-5);
  }
  arrays.forEach((arr,axis)=>{
    ctx.beginPath();ctx.strokeStyle=AXIS_COLORS[axis];ctx.lineWidth=1.05;
    const stride=Math.max(1,Math.floor(arr.length/Math.max(1,plotW*1.5)));
    for(let i=0;i<arr.length;i+=stride){const x=left+(i/(arr.length-1))*plotW;const y=top+(max-arr[i])/(max-min)*plotH;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
    ctx.stroke();
  });
  ctx.textAlign="left";arrays.forEach((_,axis)=>{ctx.fillStyle=AXIS_COLORS[axis];ctx.fillText(["X","Y","Z"][axis],left+axis*23,10);});
  ctx.textAlign="right";ctx.fillStyle=isDarkTheme()?"#a9b7c2":"#89969f";ctx.fillText(unit,width-right,10);
}

function drawPSD(canvas, spectrum, channelOffset) {
  const {ctx,width,height}=setupCanvas(canvas,180),left=45,right=10,top=14,bottom=24,plotW=width-left-right,plotH=height-top-bottom;
  ctx.clearRect(0,0,width,height);
  const axes=spectrum?.channels?.slice(channelOffset,channelOffset+3),frequency=spectrum?.frequency;
  if(!axes||!frequency?.length)return;
  const maxHz=Math.min(20,frequency[frequency.length-1]);
  let minLog=Infinity,maxLog=-Infinity;
  axes.forEach((values)=>values.forEach((power,index)=>{if(frequency[index]<=maxHz&&power>0){const value=Math.log10(power);minLog=Math.min(minLog,value);maxLog=Math.max(maxLog,value);}}));
  if(!Number.isFinite(minLog)||!Number.isFinite(maxLog))return;
  if(maxLog-minLog<1){maxLog+=.5;minLog-=.5;}
  const y=(value)=>top+(maxLog-value)/(maxLog-minLog)*plotH,x=(hz)=>left+hz/maxHz*plotW;
  ctx.fillStyle=isDarkTheme()?"#203b3a":"#edf6f3";ctx.fillRect(x(3),top,x(Math.min(12,maxHz))-x(3),plotH);
  ctx.font="9px monospace";ctx.textAlign="right";ctx.fillStyle=isDarkTheme()?"#a9b7c2":"#8d99a2";ctx.strokeStyle=isDarkTheme()?"#33424f":"#edf0f2";
  for(let tick=0;tick<=4;tick++){const yy=top+tick*plotH/4;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(width-right,yy);ctx.stroke();ctx.fillText((maxLog-tick*(maxLog-minLog)/4).toFixed(1),left-6,yy+3);}
  for(let hz=0;hz<=maxHz;hz+=5){const xx=x(hz);ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,height-bottom);ctx.stroke();ctx.textAlign="center";ctx.fillText(String(hz),xx,height-5);}
  axes.forEach((values,axis)=>{ctx.beginPath();ctx.strokeStyle=AXIS_COLORS[axis];ctx.lineWidth=1.1;let started=false;for(let i=0;i<values.length;i++){if(frequency[i]>maxHz)break;const power=values[i];if(!(power>0))continue;const xx=x(frequency[i]),yy=y(Math.log10(power));if(!started){ctx.moveTo(xx,yy);started=true;}else ctx.lineTo(xx,yy);}ctx.stroke();});
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
    const record = await fetchJSON(new URL(item.data_ref, state.runBase));
    state.seedRecords.set(String(item.seed), record);
  }));
  if (!state.selectedSeed) state.selectedSeed=String(state.run.seed_results[0].seed);
  renderSeedView();
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
  const split=state.split;
  const activeMetrics=seedMetricsForSplit(selected, split);
  const activeThreshold=split === "oof" ? selected.oof_threshold : selected.final_test_threshold;
  $("#threshold-chip b").textContent=fmt(activeThreshold,3);
  $("#page-title").textContent=split === "oof" ? `Seed ${selected.seed} · OOF analysis` : `Seed ${selected.seed} · final test`;
  $("#page-subtitle").textContent=`${state.run.run_family} · stored ${split === "oof" ? "out-of-fold" : "final-test"} results · no threshold tuning`;
  $("#seed-strategy").textContent=split === "oof" ? `${selected.strategy} · consensus (A1 = A2)` : `${selected.strategy} labels`;
  const n=activeMetrics?.n ?? (split === "oof" ? selected.oof_predictions.events.length : 0);
  $("#seed-kpis").innerHTML=[
    kpiCard("BALANCED ACCURACY",seedMetricCell(readMetric(activeMetrics,"ba")),split === "oof" ? "Consensus events only" : "Stored evaluation metric","◉"),
    kpiCard("RECALL",seedMetricCell(readMetric(activeMetrics,"recall")),split === "oof" ? "Consensus events only" : "Stored evaluation metric","↗"),
    kpiCard("SPECIFICITY",seedMetricCell(readMetric(activeMetrics,"specificity")),split === "oof" ? "Consensus events only" : "Stored evaluation metric","↘"),
    kpiCard("EVENTS",n ? String(n) : "—",split === "oof" ? "Consensus events (A1 = A2)" : "Final-test aggregate count","⌁"),
  ].join("");
  renderSeedComparison();
  $("#oof-detail").classList.toggle("hidden",split !== "oof");
  $("#test-detail").classList.toggle("hidden",split !== "test");
  if(split === "oof")renderOof(selected);else renderTest(selected);
}

function renderSeedComparison() {
  const entries=state.run.seed_results||[];
  const recordFor=(seed)=>state.seedRecords.get(String(seed));
  const selectedSplit=state.split;
  $("#seed-summary-rows").innerHTML=entries.map((entry)=>{
    const record=recordFor(entry.seed);if(!record)return "";
    const metrics=seedMetricsForSplit(record, selectedSplit);
    return `<tr><td>Seed ${escapeHTML(entry.seed)}</td><td>${selectedSplit === "oof"?"OOF":"Test"}</td><td>${seedMetricCell(readMetric(metrics,"ba"))}</td><td>${seedMetricCell(readMetric(metrics,"recall"))}</td><td>${seedMetricCell(readMetric(metrics,"specificity"))}</td><td>${seedMetricCell(readMetric(metrics,"f1"))}</td><td>${seedMetricCell(readMetric(metrics,"roc_auc"))}</td><td>${escapeHTML(metrics?.n??"—")}</td></tr>`;
  }).join("");
}

function renderOof(record) {
  const events=record.oof_predictions.events||[];
  $("#oof-threshold").textContent=`Stored threshold ${fmt(record.oof_threshold,3)}`;
  const chartRows=events.map((event,index)=>({index,probability:event.probability_from_stored_logit,disagreement:!event.consensus,status:event.consensus?(event.correct_on_consensus?"Correct":"Error"):"Disagreement",id:String(index)}));
  $("#oof-plot").innerHTML=makeProbabilitySvg(chartRows,record.oof_threshold,null,(item)=>({id:item.id,xLabel:`Array row ${item.index}`,probability:item.probability,disagreement:item.disagreement,status:item.status}));
  $("#oof-rows").innerHTML=events.map((event)=>{
    const status=event.consensus?(event.correct_on_consensus?["Correct","good"]:["Error","error"]):["Disagreement","disagreement"];
    return `<tr><td class="event-id">${event.source_array_index}</td><td class="label-pair">${escapeHTML(event.a1)} / ${escapeHTML(event.a2)}</td><td>${fmt(event.soft_target_stored,2)}</td><td class="probability-cell">${fmt(event.probability_from_stored_logit,3)}</td><td>${fmt(record.oof_threshold,3)}</td><td>${event.predicted_class_at_stored_oof_threshold?"Tremor":"No tremor"}</td><td><span class="badge ${status[1]}">${status[0]}</span></td></tr>`;
  }).join("");
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
}

function setView(view) {
  state.activeView=view;
  document.querySelectorAll(".nav-item").forEach((button)=>{const active=button.dataset.view===view;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));});
  $("#global-controls").classList.toggle("hidden",view!=="global");
  $("#seed-controls").classList.toggle("hidden",view!=="seeds");
  $("#global-view").classList.toggle("hidden",view!=="global");
  $("#seed-view").classList.toggle("hidden",view!=="seeds");
  if(view==="global"){
    $("#page-title").textContent="Global LOSO inspection";
    if(state.patientData)renderGlobalEvents();
  }else prepareSeeds().catch(showError);
}

function installHandlers() {
  const themeSelect = $("#theme-select");
  let themePreference = "system";
  try { themePreference = localStorage.getItem("parkinson-theme") || "system"; } catch {}
  if (!["system", "light", "dark"].includes(themePreference)) themePreference = "system";
  themeSelect.value = themePreference;
  applyTheme(themePreference);
  themeSelect.addEventListener("change", () => {
    themePreference = themeSelect.value;
    try { localStorage.setItem("parkinson-theme", themePreference); } catch {}
    applyTheme(themePreference);
  });
  const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
  colorScheme.addEventListener?.("change", () => { if (themePreference === "system") applyTheme("system"); });
  $("#retry-button").addEventListener("click",boot);
  $("#run-select").addEventListener("change",(event)=>selectRun(Number(event.target.value)).catch(showError));
  $("#patient-select").addEventListener("change",(event)=>selectPatient(event.target.value).catch(showError));
  $("#action-filter").addEventListener("change",()=>{renderProbabilityPlot();renderEventTable();});
  $("#event-filter").addEventListener("change",()=>{renderProbabilityPlot();renderEventTable();});
  $("#event-search").addEventListener("input",renderEventTable);
  $("#seed-select").addEventListener("change",(event)=>{state.selectedSeed=event.target.value;renderSeedView();});
  document.querySelectorAll(".nav-item").forEach((button)=>button.addEventListener("click",()=>setView(button.dataset.view)));
  document.querySelectorAll(".segment").forEach((button)=>button.addEventListener("click",()=>{
    state.split=button.dataset.split;document.querySelectorAll(".segment").forEach((item)=>{const active=item===button;item.classList.toggle("active",active);item.setAttribute("aria-selected",String(active));});renderSeedView();
  }));
  $("#about-button").addEventListener("click",()=>$("#about-dialog").showModal());
  window.addEventListener("resize",()=>{
    const event=state.patientData?.events.find((item)=>item.event_id===state.selectedEventId);
    if(event?.signal_match?.status==="matched")renderSelectedEvent(event);
  });
}

installHandlers();
boot();
