"use strict";

const host = require("./host.js");
const { BoardwalkClient } = require("./client.js");
const { upload, requireSignedTransferUrl } = require("./transfer.js");
const { sha256 } = require("js-sha256");
const { validateMarkers, toClipMarkers, mergeClipMarkers } = require("./markers.js");
const config = require("./config.js");
const { prepareButton, setDisabled, isDisabled } = require("./controls.js");
const { Reports, safeEvent, expectedError } = require("./reports.js");
const { clearTracked, clearMessage } = require("./cache.js");
const { pairingApprovalUrl } = require("./pairing.js");
const client = new BoardwalkClient(host.uxp.storage.secureStorage);
const $ = id => document.getElementById(id);
const state = { view: "library", assets: [], cursor: null, asset: null, cached: null, file: null, upload: null, controller: null, pairing: 0, busy: false };
let approvalUrl = config.approvalUrl;
const reports = new Reports({ store: host.diagnosticStore, account: () => client.session?.user?.uid,
  context: () => ({ ...host.reportEnvironment(), ...(config.revision ? { pluginRevision: config.revision } : {}),
    view: !client.session ? "connection" : state.view === "library" && !$("asset-detail").hidden ? "detail" : state.view }),
  send: payload => client.request("cmsSubmitPremiereReport", payload) });
const requestOperations = {
  cmsStartPremierePairing: "auth.start", cmsPollPremierePairing: "auth.poll", cmsRevokePremiereSession: "auth.revoke",
  session: "auth.restore", cmsListSourceMedia: "library.list", cmsCreateSourceMediaRead: "media.download",
  cmsRequestVideoClip: "media.export", cmsGetVideoClip: "media.export", cmsCreateVideoClipRead: "media.download",
  cmsUpdateSourceMediaMetadata: "markers.save", cmsStartSourceMediaUpload: "upload.start",
  cmsResumeSourceMediaUpload: "upload.start", cmsSignSourceMediaUploadParts: "upload.part",
  cmsCompleteSourceMediaUpload: "upload.complete", cmsCancelSourceMediaUpload: "upload.cancel", cmsSubmitPremiereReport: "report.submit",
};
let pendingSessionEvents = null;
client.onResult = event => {
  const operation = event.posterRead ? "library.list" : requestOperations[event.operation || event.endpoint];
  const uid = client.session?.user?.uid;
  if (!uid || pendingSessionEvents?.uid !== uid) pendingSessionEvents = null;
  if (operation === "auth.restore" && event.error && event.uid === uid && uid && reports.uid !== uid) {
    const safe = safeEvent({ timestamp: new Date().toISOString(), ...event, operation }, Date.now());
    if (safe) {
      pendingSessionEvents ||= { uid, events: [] };
      pendingSessionEvents.events = [...pendingSessionEvents.events, safe].slice(-20);
    }
  } else if (operation) reports.record({ ...event, operation }, event.uid, event.error);
  if (!client.session && reports.uid) {
    void clearAccountState();
    message("Your Boardwalk connection ended. Connect again.");
  }
};
const buttonOperations = { connect: "auth.start", "sign-out": "auth.revoke", "import": "media.import",
  "import-selected": "media.import", "import-cached": "media.import", "test-import": "media.import",
  "apply-markers": "markers.apply", "read-markers": "markers.read", "save-markers": "markers.save",
  "link-source": "markers.read", upload: "upload.complete", "resume-upload": "upload.complete",
  "cancel-upload": "upload.cancel", "choose-cache": "cache", "clear-cache": "cache", "send-report": "report.submit" };
const selectedAssets = new Map();
const posters = new Map();
const posterReads = new Map();
const posterQueue = [];
let activePosterReads = 0;
let posterGeneration = 0;
const viewScroll = {};
const size = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
let markerDraft = null;
let returnSource = null;
let returnMarkers = [];
let searchTimer;
let libraryRequest = 0;
let detailRequest = 0;
let displayedQuery = "";
let sessionRestore = null;
const activityJobs = new Map();
function stopActivity(id) {
  const job = activityJobs.get(id);
  if (job) clearInterval(job.timer);
  activityJobs.delete(id);
  $(id).removeAttribute("data-active");
}
function startActivity(id) {
  stopActivity(id);
  const element = $(id);
  const dots = Array.from(element.children);
  let frame = 0;
  // Premiere UXP does not animate CSS keyframes. Only opacity changes each tick.
  const paint = () => { dots.forEach((dot, index) => { dot.style.opacity = index === frame % dots.length ? "1" : ".25"; }); frame++; };
  element.setAttribute("data-active", "true");
  paint();
  const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const job = { timer: reducedMotion ? null : setInterval(paint, 200) };
  activityJobs.set(id, job);
  return () => { if (activityJobs.get(id) === job) stopActivity(id); };
}
function clearPosters() {
  posterGeneration++;
  posters.clear(); posterReads.clear(); posterQueue.length = 0;
}
function applyPoster(image, url) {
  image.src = requireSignedTransferUrl(url);
  image.hidden = false;
  if (image.id === "detail-poster") $("detail-poster-empty").hidden = true;
}
function drainPosters() {
  while (activePosterReads < 3 && posterQueue.length) {
    const job = posterQueue.shift();
    if (job.generation !== posterGeneration || job.token !== client.session?.sessionToken) continue;
    activePosterReads++;
    void client.request("cmsCreateSourceMediaRead", { assetId: job.asset.id, action: "poster" }).then(({ access }) => {
      if (job.generation !== posterGeneration || job.token !== client.session?.sessionToken) return;
      const url = requireSignedTransferUrl(access.url);
      posters.set(job.asset.id, url);
      for (const image of job.images) {
        if (document.contains(image) && image.getAttribute("data-asset-id") === job.asset.id) applyPoster(image, url);
      }
    }).catch(() => { /* A failed poster leaves its fixed thumbnail space available. */ }).finally(() => {
      if (posterReads.get(job.asset.id) === job) posterReads.delete(job.asset.id);
      activePosterReads--;
      drainPosters();
    });
  }
}
function bindPoster(asset, image) {
  image.hidden = true;
  image.removeAttribute("src");
  image.setAttribute("data-asset-id", asset.id);
  let attempted = false;
  const fallback = () => {
    image.hidden = true;
    if (image.id === "detail-poster") $("detail-poster-empty").hidden = false;
    if (attempted || asset.viewingCopy?.state !== "ready") return;
    attempted = true;
    let job = posterReads.get(asset.id);
    if (!job) {
      job = { asset, images: new Set(), generation: posterGeneration, token: client.session?.sessionToken };
      posterReads.set(asset.id, job); posterQueue.push(job);
    }
    job.images.add(image);
    drainPosters();
  };
  image.onerror = fallback;
  try {
    if (posters.has(asset.id)) applyPoster(image, posters.get(asset.id));
    else fallback();
  } catch { fallback(); }
}
function accountKey(name) {
  if (!client.session?.user?.uid) throw expectedError("Reconnect Boardwalk to restore this account's settings.");
  return `boardwalk-${name}-${client.session.user.uid}`;
}
function pathKey(path) { return path.replace(/\\/g, "/"); }
function sourceMappings() {
  try { return JSON.parse(localStorage.getItem(accountKey("sources")) || "{}"); }
  catch { return {}; }
}
async function trackedSelection() {
  const selection = await host.selectedClip();
  const source = sourceMappings()[pathKey(selection.path)];
  if (!source || source.sourceId !== "video-library" || !source.assetId) {
    throw expectedError("Select a clip downloaded by this Boardwalk account. Its source link must still be available on this computer.");
  }
  return { ...selection, source };
}
function renderMarkers() {
  const markers = state.asset?.markers || [];
  $("marker-count").textContent = Array.isArray(state.asset?.markers)
    ? `${markers.length} markers stored in Boardwalk` : "Loading markers...";
  $("marker-list").textContent = "";
  for (const marker of markers) {
    const row = document.createElement("p");
    row.textContent = `${(marker.startMs / 1000).toFixed(3)}–${(marker.endMs / 1000).toFixed(3)}s: ${marker.name || marker.type}${marker.comment ? ` / ${marker.comment}` : ""}`;
    $("marker-list").appendChild(row);
  }
  markerDraft = null;
  $("marker-draft-status").textContent = "";
  $("save-markers").hidden = true;
  $("replace-markers").checked = false;
  renderView();
}
function renderSelection() {
  $("batch-actions").hidden = state.view !== "library" || !client.session || !$("asset-detail").hidden;
  $("selection-count").textContent = selectedAssets.size ? `${selectedAssets.size} ${selectedAssets.size === 1 ? "video" : "videos"} selected` : "No videos selected";
  setDisabled($("import-selected"), state.busy || selectedAssets.size === 0);
  setDisabled($("clear-selection"), state.busy || selectedAssets.size === 0);
}

function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = error ? "message error" : "message";
  $("message").hidden = !text;
}
function renderView() {
  for (const name of ["library", "return", "settings"]) {
    $(`view-${name}`).hidden = state.view !== name || (name !== "settings" && !client.session);
    $(`tab-${name}`).setAttribute("aria-pressed", String(state.view === name));
  }
  $("connection").hidden = Boolean(client.session) || state.view === "settings";
  $("sign-out").hidden = !client.session;
  $("account-name").textContent = client.session ? `Connected as ${client.session.user.displayName || "Boardwalk staff"}` : "Not connected.";
  $("account-expiry").textContent = client.session ? `Connected until ${new Date(client.session.expiresAt).toLocaleDateString()}.` : "";
  setDisabled($("return-markers"), state.busy || returnMarkers === null);
  for (const id of ["replace-markers", "apply-markers", "read-markers", "save-markers"]) {
    setDisabled($(id), state.busy || !Array.isArray(state.asset?.markers));
  }
  renderSelection();
  renderReport();
}
function renderReport() {
  $("report-open").setAttribute("aria-expanded", String(!$("report-form").hidden));
  $("report-description").readOnly = Boolean(reports.manual);
  $("send-report").textContent = reports.manual ? "Retry report" : "Send report";
  setDisabled($("send-report"), state.busy || !client.session);
  $("report-note").textContent = !client.session ? "Connect Boardwalk to send a report."
    : reports.storageAvailable ? "Includes plugin and Premiere versions and recent operation results. Video names, file paths, and account credentials are excluded from diagnostics."
      : "Local diagnostics could not be saved. This report can still include operation results from this session.";
}
async function restoreReports() {
  const sessionToken = client.session?.sessionToken;
  const pending = reports.setAccount(client.session?.user?.uid);
  const generation = reports.generation;
  await pending;
  if (generation !== reports.generation || sessionToken !== client.session?.sessionToken) return;
  const buffered = pendingSessionEvents;
  pendingSessionEvents = null;
  if (buffered?.uid === reports.uid) for (const event of buffered.events) reports.record(event, buffered.uid);
  $("report-description").value = reports.manual?.description || "";
  $("report-status").textContent = reports.manual ? "A previous report is waiting for a receipt. Retry checks the same report." : "";
  $("report-form").hidden = !reports.manual;
  renderReport();
}
async function restoreSession() {
  if (!client.session) return;
  const sessionToken = client.session.sessionToken;
  if (sessionRestore?.token === sessionToken) { await sessionRestore.promise; return; }
  if (reports.uid === client.session.user.uid) return;
  const job = { token: sessionToken };
  sessionRestore = job;
  job.promise = (async () => {
    const live = await client.request("session");
    if (client.session?.sessionToken !== sessionToken) throw expectedError("The account changed. Try again.");
    // The credential is already stored; rewriting it could race sign-out.
    client.session = { ...client.session, user: live.user, expiresAt: live.expiresAt };
    await restoreReports();
    if (client.session?.sessionToken !== sessionToken) throw expectedError("The account changed. Try again.");
    await restoreUpload();
  })().finally(() => { if (sessionRestore === job) sessionRestore = null; });
  await job.promise;
}
async function clearAccountState() {
  pendingSessionEvents = null;
  clearTimeout(searchTimer); libraryRequest++; detailRequest++;
  stopActivity("library-loading"); stopActivity("marker-loading");
  state.assets = []; state.asset = null; state.cached = null; state.file = null; state.upload = null;
  selectedAssets.clear(); clearPosters();
  returnSource = null; returnMarkers = []; markerDraft = null;
  $("return-source").textContent = "No source linked."; $("return-markers").checked = false;
  $("assets").textContent = ""; $("asset-detail").hidden = true; $("library-list").hidden = false;
  $("return-file").textContent = "No file selected.";
  for (const id of ["return-name", "return-description", "return-credit", "return-tags"]) $(id).value = "";
  await restoreReports();
  renderView();
}
async function run(action, operation = "ui") {
  if (state.busy) return;
  const previousFocus = document.activeElement;
  state.busy = true;
  message("");
  for (const control of document.querySelectorAll('[role="button"],input,select,textarea')) setDisabled(control, control.id !== "stop-transfer");
  try { await reports.measure(operation, action); }
  catch (error) { if (!error.handledInView) message(error.message || "The action failed. Try again.", !error.expected); }
  finally {
    state.busy = false;
    for (const control of document.querySelectorAll('[role="button"],input,select,textarea')) setDisabled(control, false);
    renderView();
    const scrollTop = state.restoreScroll ?? $("content").scrollTop;
    const target = state.returnFocus || previousFocus;
    if (target && document.contains(target) && !isDisabled(target) && !target.closest("[hidden]")) target.focus();
    else $(`tab-${state.view}`).focus();
    state.returnFocus = null;
    $("content").scrollTop = scrollTop;
    if (state.revealFocus && target) {
      const field = target.getBoundingClientRect();
      const viewport = $("content").getBoundingClientRect();
      if (field.bottom > viewport.bottom) $("content").scrollTop += field.bottom - viewport.bottom;
      else if (field.top < viewport.top) $("content").scrollTop -= viewport.top - field.top;
    }
    delete state.revealFocus;
    delete state.restoreScroll;
    if (state.view === "library" && $("asset-detail").hidden && $("search").value.trim() !== displayedQuery) {
      void searchLibrary(true);
    }
  }
}
function bind(id, action) { $(id).addEventListener("click", () => void run(action, buttonOperations[id] || "ui")); }
async function refreshProject() {
  try { $("project-name").textContent = (await host.activeProject()).name; }
  catch { $("project-name").textContent = "Open a project to import video."; }
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function connect() {
  const attempt = ++state.pairing;
  const pair = await client.post("cmsStartPremierePairing", { deviceName: "Premiere Pro", hostVersion: String(host.uxp.host?.version || "unknown") });
  $("pair-code").value = pair.userCode;
  $("copy-code-status").textContent = "";
  approvalUrl = pairingApprovalUrl(pair, config.approvalUrl);
  $("pair-status").textContent = "Waiting for browser approval...";
  $("pairing").hidden = false;
  $("connect").hidden = true;
  state.returnFocus = $("pair-code");
  void pollPairing(pair, attempt);
  await host.uxp.shell.openExternal(approvalUrl);
}
async function copyCode() {
  $("copy-code-status").textContent = "";
  try {
    await navigator.clipboard.setContent({ "text/plain": $("pair-code").value });
    $("copy-code-status").textContent = "Code copied.";
  } catch {
    $("copy-code-status").textContent = "Could not copy. Select the code and copy it.";
  }
}
async function pollPairing(pair, attempt) {
  const expires = Date.now() + pair.expiresIn * 1000;
  let interval = Math.max(5, pair.interval || 5);
  const stopLoading = startActivity("pair-loading");
  try {
    while (attempt === state.pairing && Date.now() < expires) {
      await sleep(interval * 1000);
      if (attempt !== state.pairing) return;
      let result;
      try { result = await client.post("cmsPollPremierePairing", { deviceCode: pair.deviceCode }); }
      catch (error) {
        if (error.status === 429) { interval = Math.max(interval + 5, error.retryAfter); continue; }
        throw error;
      }
      if (attempt !== state.pairing) {
        if (result.sessionToken) {
          const temporary = new BoardwalkClient(host.uxp.storage.secureStorage);
          temporary.session = result;
          await temporary.post("cmsRevokePremiereSession", {}, { authenticated: true });
        }
        return;
      }
      if (result.status === "approved") {
        await client.remember({ sessionToken: result.sessionToken, expiresAt: result.expiresAt, user: result.user });
        await restoreReports();
        await restoreUpload();
        $("pairing").hidden = true;
        $("connect").hidden = false;
        renderView();
        await run(() => loadLibrary(), "library.list");
        return;
      }
      if (result.status !== "pending") throw new Error("This connection was not approved. Start again to get a new code.");
    }
    if (attempt === state.pairing) throw new Error("The connection code expired. Connect again for a new code.");
  } catch (error) {
    if (attempt === state.pairing) {
      $("pairing").hidden = true;
      $("connect").hidden = false;
      message(error.message, true);
    }
  } finally { stopLoading(); }
}
async function loadLibrary(more = false) {
  const stopLoading = startActivity("library-loading");
  try {
    clearTimeout(searchTimer);
    const request = ++libraryRequest;
    const q = $("search").value.trim();
    const sessionToken = client.session?.sessionToken;
    const background = !state.busy;
    const currentRequest = () => request === libraryRequest && q === $("search").value.trim() && !(background && state.busy);
    more = more && q === displayedQuery;
    const previousScroll = more ? $("content").scrollTop : 0;
    $("library-status").textContent = "Loading videos...";
    let page;
    try {
      await restoreSession();
      page = await client.request("cmsListSourceMedia", {
        limit: 24, posters: true, ...(q ? { q } : {}), ...(more && state.cursor ? { cursor: state.cursor } : {}),
      });
    } catch (error) {
      if (currentRequest()) throw error;
      return;
    }
    if (!currentRequest() || client.session?.sessionToken !== sessionToken) return;
    if (!more) { selectedAssets.clear(); clearPosters(); }
    displayedQuery = q;
    for (const poster of page.posters || []) posters.set(poster.assetId, poster.url);
    state.assets = more ? [...state.assets, ...page.records] : page.records;
    state.cursor = page.nextCursor;
    $("assets").textContent = "";
    for (const asset of state.assets) {
      const card = document.createElement("div"); card.className = "asset-card";
      const button = prepareButton(document.createElement("div"));
      button.className = "asset";
      const thumbnail = document.createElement("span"); thumbnail.className = "asset-thumb";
      const caption = document.createElement("span"); caption.className = "asset-caption";
      const image = document.createElement("img");
      image.alt = ""; image.className = "asset-poster";
      image.setAttribute("loading", "lazy");
      thumbnail.appendChild(image);
      bindPoster(asset, image);
      const name = document.createElement("strong"); name.textContent = asset.name;
      const seconds = asset.viewingCopy?.durationSeconds;
      const duration = Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "Duration unavailable";
      const meta = document.createElement("span"); meta.textContent = `${duration} / ${size(asset.sizeBytes)} / ${asset.rightsStatus === "pending" ? "Rights pending" : "Rights recorded"}`;
      caption.appendChild(name); caption.appendChild(meta);
      if (asset.description) { const description = document.createElement("span"); description.textContent = asset.description; caption.appendChild(description); }
      button.appendChild(thumbnail); button.appendChild(caption);
      button.addEventListener("click", () => showAsset(asset, button));
      const label = document.createElement("label"); label.className = "asset-select";
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = selectedAssets.has(asset.id);
      checkbox.setAttribute("aria-label", `Select ${asset.name} for import`);
      card.className = checkbox.checked ? "asset-card selected" : "asset-card";
      checkbox.addEventListener("change", () => {
        if (state.busy) { checkbox.checked = selectedAssets.has(asset.id); return; }
        if (checkbox.checked) selectedAssets.set(asset.id, asset); else selectedAssets.delete(asset.id);
        card.className = checkbox.checked ? "asset-card selected" : "asset-card";
        renderSelection();
      });
      label.appendChild(checkbox);
      card.appendChild(button); card.appendChild(label); $("assets").appendChild(card);
    }
    $("more").hidden = !page.hasMore;
    $("library-status").textContent = state.assets.length ? `${state.assets.length} ${state.assets.length === 1 ? "video" : "videos"} loaded` : "No videos found. Try a different name or refresh the library.";
    renderSelection();
    if (state.view === "library" && $("asset-detail").hidden) $("content").scrollTop = previousScroll;
  } finally { stopLoading(); }
}
async function searchLibrary(preserveMessage = false) {
  clearTimeout(searchTimer);
  if (state.busy || !client.session) return;
  if (!preserveMessage) message("");
  try { await loadLibrary(); }
  catch (error) {
    $("library-status").textContent = error.message || "Search failed. Type again or refresh to retry.";
    renderView();
  }
}
function showAsset(asset, trigger) {
  if (state.busy) return;
  clearTimeout(searchTimer);
  libraryRequest++;
  stopActivity("library-loading");
  message("");
  state.libraryScroll = $("content").scrollTop;
  state.libraryTrigger = trigger;
  state.asset = { ...asset, markers: undefined };
  state.cached = null;
  $("import-cached").hidden = true;
  $("library-list").hidden = true;
  $("asset-detail").hidden = false;
  $("back").focus();
  $("content").scrollTop = 0;
  renderSelection();
  $("asset-name").textContent = asset.name;
  const poster = $("detail-poster");
  $("detail-poster-empty").hidden = false;
  bindPoster(asset, poster);
  $("asset-description").textContent = asset.description || "";
  const duration = asset.viewingCopy?.durationSeconds;
  const durationLabel = Number.isFinite(duration) ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}` : "Duration unavailable";
  $("asset-meta").textContent = `${durationLabel} / ${asset.originalName} / ${size(asset.sizeBytes)}`;
  $("asset-rights").textContent = asset.rightsStatus === "pending" ? "Rights review is pending. Confirm permission before using this footage." : "";
  $("actual-range").textContent = "";
  $("out-seconds").value = asset.viewingCopy?.durationSeconds || "";
  $("format").value = localStorage.getItem(accountKey("import-format")) || "original";
  updateFormat();
  renderMarkers();
  void loadAssetMarkers(asset.id);
}
async function loadAssetMarkers(assetId) {
  const request = ++detailRequest;
  const token = client.session?.sessionToken;
  const current = () => request === detailRequest && token === client.session?.sessionToken && !$("asset-detail").hidden;
  const stopLoading = startActivity("marker-loading");
  try {
    const result = await client.request("cmsListSourceMedia", { assetId });
    if (!current()) return;
    const asset = result.records?.find(item => item.id === assetId);
    if (!asset || !Array.isArray(asset.markers)) throw expectedError("Source markers are unavailable.");
    state.asset = { ...asset, markers: validateMarkers(asset.markers) };
    renderMarkers();
  } catch {
    if (current()) $("marker-count").textContent = "Markers could not load. Reopen the video to retry.";
  } finally { stopLoading(); }
}
function updateFormat() {
  $("range-fields").hidden = $("range").value !== "clip";
  $("format-note").textContent = $("format").value === "prores_mov"
    ? "Creates a paid ProRes export at the source size. Existing ready exports are reused."
    : $("range").value === "clip"
      ? "Copies original audio and video without re-encoding. Supported MP4/MOV files only. Cuts expand to safe keyframes; the returned range is shown before import. Uses server compute."
      : "Downloads the camera original without conversion.";
}
function progress(bytes, total) {
  $("transfer-progress").value = total ? Math.min(100, bytes / total * 100) : 0;
  $("transfer-status").textContent = total ? `${size(bytes)} of ${size(total)}` : `${size(bytes)} downloaded`;
}
async function transfer(title, action) {
  state.controller = new AbortController();
  $("transfer").hidden = false;
  $("transfer-title").textContent = title;
  $("transfer-progress").value = 0;
  $("transfer-status").textContent = "Preparing...";
  const scrollTop = $("content").scrollTop;
  $("stop-transfer").focus();
  $("content").scrollTop = scrollTop;
  const stopLoading = startActivity("transfer-loading");
  try { await action(state.controller.signal); }
  catch (error) {
    if (state.controller.signal.aborted && !error.expected) throw expectedError("Transfer stopped. Your source is unchanged.");
    throw error;
  }
  finally { stopLoading(); state.controller = null; $("transfer").hidden = true; }
}
async function confirmDownloadCredit(asset, access, signal, acknowledgedCredit) {
  const credit = (access.credit === undefined ? asset.credit : access.credit)?.trim();
  if (!credit || credit === acknowledgedCredit) return credit;
  if (signal.aborted) throw expectedError("Download canceled. The video was not imported.");
  $("download-credit").textContent = credit;
  $("credit-warning").hidden = false;
  const accepted = await new Promise(resolve => {
    const finish = value => {
      $("credit-continue").removeEventListener("click", accept);
      $("credit-cancel").removeEventListener("click", cancel);
      signal.removeEventListener("abort", cancel);
      $("credit-warning").hidden = true;
      $("stop-transfer").focus();
      resolve(value);
    };
    const accept = () => finish(true);
    const cancel = () => finish(false);
    for (const id of ["credit-continue", "credit-cancel"]) setDisabled($(id), false);
    $("credit-continue").addEventListener("click", accept);
    $("credit-cancel").addEventListener("click", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    $("credit-cancel").focus();
  });
  if (!accepted) throw expectedError("Download canceled. The video was not imported.");
  return credit;
}
async function pullAsset(asset = state.asset, selectedFormat, selectedScope, expectedProject) {
  const project = expectedProject || await host.activeProject();
  if ((await host.activeProject()).guid.toString() !== project.guid.toString()) {
    throw expectedError("The active project changed. Return to the intended project before importing.");
  }
  const format = selectedFormat || $("format").value;
  const scope = selectedScope || $("range").value;
  if ($("remember-format").checked) localStorage.setItem(accountKey("import-format"), format);
  let boundaries = {};
  if (scope === "clip") {
    const inMs = Math.round(Number($("in-seconds").value) * 1000);
    const outMs = Math.round(Number($("out-seconds").value) * 1000);
    if (!Number.isSafeInteger(inMs) || !Number.isSafeInteger(outMs) || inMs < 0 || outMs <= inMs) throw expectedError("Enter an out point after the in point.");
    boundaries = { inMs, outMs };
  }
  await transfer(`Importing ${asset.name}`, async signal => {
    let access;
    let expectedBytes = asset.sizeBytes;
    let source = { sourceId: "video-library", assetId: asset.id };
    if (format === "original" && scope === "source") {
      let acknowledgedCredit;
      for (let attempt = 0; attempt < 2; attempt++) {
        const requestedAt = Date.now();
        ({ access } = await client.request("cmsCreateSourceMediaRead", { assetId: asset.id, action: "download" }, signal));
        acknowledgedCredit = await confirmDownloadCredit(asset, access, signal, acknowledgedCredit);
        // Source links last five minutes; the client clock can differ from S3's clock.
        if (Date.now() - requestedAt < 299_000) break;
        if (attempt === 1) throw expectedError("The download link expired. Try again.");
      }
    } else {
      let { clip } = await client.request("cmsRequestVideoClip", { assetId: asset.id, scope, format: format === "original" ? "original_copy" : format, ...boundaries }, signal);
      while (["queued", "processing"].includes(clip.state)) {
        if (signal.aborted) throw expectedError("Stopped waiting. The export may still finish in Boardwalk; reopen this asset to use it.");
        $("transfer-status").textContent = format === "original" ? "Copying the original range in Boardwalk..." : "Preparing ProRes in Boardwalk...";
        await sleep(5000);
        ({ clip } = await client.request("cmsGetVideoClip", { assetId: asset.id, clipId: clip.id }, signal));
      }
      if (clip.state !== "ready") {
        const reasons = {
          original_media_unsupported: "This video's tracks or codecs are not supported for original ranges. Choose the full original or ProRes.",
          original_timing_unsupported: "The source timing could not be verified for an unchanged range. Choose the full original or ProRes.",
          original_output_limit: "This range exceeds the extraction limit. Choose a shorter range or download the full original.",
          processing_unconfirmed: "The export's outcome needs an administrator to check it before another original range can start.",
        };
        throw new Error(reasons[clip.errorCode] || "The export did not finish. Check the asset's exports in Boardwalk.");
      }
      ({ access } = await client.request("cmsCreateVideoClipRead", { assetId: asset.id, clipId: clip.id }, signal));
      expectedBytes = clip.sizeBytes;
      if (scope === "clip") {
        const inMs = Math.round(clip.sourceStartSeconds * 1000);
        const outMs = Math.round(clip.sourceEndSeconds * 1000);
        if (!Number.isSafeInteger(inMs) || !Number.isSafeInteger(outMs) || inMs < 0 || outMs <= inMs) {
          throw new Error("The export is missing its source timing. Open it in Boardwalk before importing.");
        }
        source = { ...source, inMs, outMs };
        $("actual-range").textContent = `Returned source range: ${inMs / 1000}–${outMs / 1000}s`;
      }
    }
    state.cached = await reports.measure("media.download", () => host.downloadToCache({ asset, access, expectedBytes, signal, onProgress: progress,
      ...(format === "prores_mov" || scope === "clip" ? { label: `${asset.name}-${format === "original" ? "original-range" : "prores"}.mov` } : {}) }));
    const mappings = sourceMappings();
    mappings[pathKey(state.cached.nativePath)] = source;
    localStorage.setItem(accountKey("sources"), JSON.stringify(mappings));
    $("import-cached").hidden = false;
    if (signal.aborted) throw expectedError("Download complete. Import the cached file when you're ready.");
    await reports.measure("media.import", () => host.importFile(state.cached, project));
    message(`Imported ${asset.name} into ${project.name}.${source.inMs === undefined ? "" : ` Source range: ${source.inMs / 1000}–${source.outMs / 1000}s.`}`);
  });
}
async function saveUpload(session) {
  state.upload = session;
  localStorage.setItem(accountKey("upload"), JSON.stringify(session));
  $("resume-upload").hidden = false;
  $("cancel-upload").hidden = false;
}
function clearUpload() {
  state.upload = null;
  localStorage.removeItem(accountKey("upload"));
  $("resume-upload").hidden = true;
  $("cancel-upload").hidden = true;
}
async function restoreUpload() {
  state.upload = null;
  $("resume-upload").hidden = true;
  $("cancel-upload").hidden = true;
  const pending = localStorage.getItem(accountKey("upload"));
  if (pending) {
    try {
      const saved = JSON.parse(pending);
      if (!saved || (typeof saved.sessionId !== "string" && typeof saved.startRequest?.requestId !== "string")) throw new Error("Invalid upload checkpoint");
      await saveUpload(saved);
    }
    catch { clearUpload(); }
  }
}
async function returnVideo(resume = false) {
  if (!state.file) throw expectedError("Choose your exported video first.");
  const name = $("return-name").value.trim();
  if (!name && !resume) throw expectedError("Enter a name for the new asset.");
  if (state.upload && !resume) throw expectedError("Resume or cancel the existing upload before starting another.");
  const metadata = await state.file.getMetadata();
  await transfer(`Uploading ${state.file.name}`, async signal => {
    if (!resume) {
      const startRequest = {
        requestId: `premiere-${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`,
        originalName: state.file.name, mimeType: "application/octet-stream", sizeBytes: metadata.size,
        lastModified: new Date(metadata.dateModified).getTime(),
        ...(returnSource ? { parentSource: returnSource } : {}),
        metadata: { name, description: $("return-description").value.trim(), credit: $("return-credit").value.trim(),
          tags: $("return-tags").value.split(",").map(tag => tag.trim()).filter(Boolean), rightsStatus: "pending",
          markers: $("return-markers").checked ? validateMarkers(returnMarkers) : [] },
      };
      await saveUpload({ startRequest });
    }
    if (state.upload.startRequest) {
      const request = state.upload.startRequest;
      if (request.originalName !== state.file.name || request.sizeBytes !== metadata.size ||
          request.lastModified !== new Date(metadata.dateModified).getTime()) throw expectedError("Choose the same file to resume this upload.");
      const result = await client.request("cmsStartSourceMediaUpload", request, signal);
      if (result.asset) { clearUpload(); message(`Uploaded ${result.asset.name}. Rights review is pending.`); return; }
      await saveUpload(result.upload);
    }
    const asset = await upload({ fs: host.fs, client, file: state.file, path: host.local.getFsUrl(state.file), session: state.upload, signal,
      digest: async data => btoa(String.fromCharCode(...sha256.array(data))), onProgress: progress, onSession: saveUpload });
    clearUpload();
    message(`Uploaded ${asset.name}. Rights review is pending.`);
  });
}
function initialize() {
  for (const button of document.querySelectorAll('[role="button"]')) prepareButton(button);
  for (const name of ["library", "return", "settings"]) bind(`tab-${name}`, async () => {
    if (name === "return") await restoreSession();
    viewScroll[state.view] = $("content").scrollTop;
    state.view = name; renderView();
    state.restoreScroll = viewScroll[name] || 0;
  });
  bind("connect", connect);
  bind("open-browser", () => host.uxp.shell.openExternal(approvalUrl));
  bind("copy-code", copyCode);
  bind("cancel-pairing", async () => {
    state.pairing++; stopActivity("pair-loading"); $("pairing").hidden = true; $("connect").hidden = false;
    state.returnFocus = $("connect");
  });
  bind("refresh", () => loadLibrary());
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    libraryRequest++;
    stopActivity("library-loading");
    searchTimer = setTimeout(() => void searchLibrary(), 250);
  });
  $("search").addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); void searchLibrary(); }
  });
  bind("more", () => loadLibrary(true));
  bind("clear-selection", async () => {
    selectedAssets.clear();
    for (const checkbox of $("assets").querySelectorAll("input")) checkbox.checked = false;
    for (const card of $("assets").querySelectorAll(".asset-card")) card.className = "asset-card";
    renderSelection();
  });
  bind("import-selected", async () => {
    const batch = [...selectedAssets.values()];
    if (!batch.length) throw expectedError("Select videos before importing.");
    const format = $("batch-format").value;
    const project = await host.activeProject();
    let imported = 0;
    for (const asset of batch) {
      try { await pullAsset(asset, format, "source", project); }
      catch (error) { throw Object.assign(new Error(`${imported} of ${batch.length} imported. Stopped at ${asset.name}: ${error.message}`),
        { cause: error, expected: error.expected, status: error.status, diagnosticCode: error.diagnosticCode }); }
      selectedAssets.delete(asset.id); imported++; renderSelection();
      const checkboxes = $("assets").querySelectorAll("input");
      const cards = $("assets").querySelectorAll(".asset-card");
      state.assets.forEach((listed, index) => {
        const selected = selectedAssets.has(listed.id);
        if (checkboxes[index]) checkboxes[index].checked = selected;
        if (cards[index]) cards[index].className = selected ? "asset-card selected" : "asset-card";
      });
    }
    message(`Imported ${imported} selected ${imported === 1 ? "video" : "videos"}.`);
  });
  bind("back", async () => {
    detailRequest++; stopActivity("marker-loading");
    $("asset-detail").hidden = true; $("library-list").hidden = false;
    if ($("search").value.trim() !== displayedQuery) {
      await loadLibrary();
      state.returnFocus = $("search"); state.restoreScroll = 0;
      return;
    }
    state.returnFocus = state.libraryTrigger || $("search");
    state.restoreScroll = state.libraryScroll || 0;
  });
  $("format").addEventListener("change", updateFormat);
  $("range").addEventListener("change", updateFormat);
  bind("import", pullAsset);
  bind("apply-markers", async () => {
    if (!$("replace-markers").checked) throw expectedError("Check Replace the selected clip's markers before applying. Premiere keeps the change in its undo history.");
    const selection = await trackedSelection();
    if (selection.source.assetId !== state.asset.id) throw expectedError("The selected clip belongs to a different Boardwalk asset.");
    const undoSteps = await host.replaceMarkers(selection, toClipMarkers(state.asset.markers || [], selection.source));
    $("replace-markers").checked = false;
    message(undoSteps ? `Markers applied. Use Premiere's undo ${undoSteps === 2 ? "twice" : "once"} to restore the previous markers.` : "This clip already has no markers.");
  });
  bind("read-markers", async () => {
    const selection = await trackedSelection();
    if (selection.source.assetId !== state.asset.id) throw expectedError("The selected clip belongs to a different Boardwalk asset.");
    markerDraft = mergeClipMarkers(state.asset.markers || [], await host.readMarkers(selection), selection.source);
    $("marker-draft-status").textContent = `${markerDraft.length} source markers ready to save, including markers kept outside the downloaded range.`;
    $("save-markers").hidden = false;
  });
  bind("save-markers", async () => {
    if (!markerDraft) throw expectedError("Read the selected clip's markers first.");
    const result = await client.request("cmsUpdateSourceMediaMetadata", { assetId: state.asset.id,
      expectedVersion: state.asset.version, changes: { markers: markerDraft } });
    state.asset = result.asset;
    state.assets = state.assets.map(asset => asset.id === result.asset.id ? result.asset : asset);
    renderMarkers(); message("Markers saved to Boardwalk.");
  });
  bind("import-cached", async () => { const name = await host.importFile(state.cached); message(`Imported cached video into ${name}.`); });
  bind("choose-return", async () => { const file = await host.selectVideo(); if (file) { state.file = file; $("return-file").textContent = file.name; $("return-name").value = file.name.replace(/\.[^.]+$/, ""); } });
  bind("upload", () => returnVideo());
  bind("link-source", async () => {
    const selection = await trackedSelection();
    let markers;
    try { markers = validateMarkers(await host.readMarkers(selection)); }
    catch (error) {
      if (error.code !== "weblink_unsupported") throw error;
      markers = null;
    }
    returnSource = selection.source;
    returnMarkers = markers;
    $("return-markers").checked = false;
    $("return-source").textContent = `${returnSource.assetId}${returnSource.inMs === undefined ? " / full source" : ` / ${returnSource.inMs / 1000}–${returnSource.outMs / 1000}s`}${markers === null ? " / This clip has WebLink markers. Marker inclusion is unavailable." : ""}`;
  });
  bind("clear-source", async () => { returnSource = null; returnMarkers = []; $("return-markers").checked = false; $("return-source").textContent = "No source linked."; });
  bind("resume-upload", () => returnVideo(true));
  bind("cancel-upload", async () => {
    if (state.upload.startRequest) {
      const result = await client.request("cmsStartSourceMediaUpload", state.upload.startRequest);
      if (result.asset) { clearUpload(); message("This upload already completed."); return; }
      await saveUpload(result.upload);
    }
    const result = await client.request("cmsResumeSourceMediaUpload", { sessionId: state.upload.sessionId });
    if (!result.asset) await client.request("cmsCancelSourceMediaUpload", { sessionId: result.upload.sessionId, version: result.upload.version });
    clearUpload(); message(result.asset ? "This upload already completed." : "Upload canceled.");
  });
  $("stop-transfer").addEventListener("click", () => state.controller?.abort());
  bind("choose-cache", async () => { const folder = await host.cacheFolder({ choose: true }); if (folder) $("cache-path").textContent = folder.nativePath; });
  bind("clear-cache", async () => {
    if (!client.session) throw expectedError("Connect your account before clearing its downloads.");
    if (!$("confirm-clear-cache").checked) throw expectedError("Confirm that you no longer need these files. Premiere clips using them will go offline.");
    const folder = await host.cacheFolder();
    if (!folder) return;
    const result = await clearTracked({ entries: await folder.getEntries(), mappings: sourceMappings(), key: pathKey,
      save: mappings => localStorage.setItem(accountKey("sources"), JSON.stringify(mappings)) });
    if (state.cached && !Object.hasOwn(sourceMappings(), pathKey(state.cached.nativePath))) {
      state.cached = null; $("import-cached").hidden = true;
    }
    $("confirm-clear-cache").checked = false;
    message(clearMessage(result));
  });
  bind("check-project", refreshProject);
  bind("report-open", async () => {
    const opening = $("report-form").hidden;
    if (opening) await restoreSession();
    $("report-form").hidden = !opening;
    if (!$("report-form").hidden) {
      state.returnFocus = $("report-description");
      state.revealFocus = true;
    }
  });
  bind("send-report", async () => {
    $("report-status").textContent = reports.manual ? "Checking the previous report..." : "Sending report...";
    const stopLoading = startActivity("report-loading");
    try {
      const id = await reports.submitManual($("report-description").value);
      $("report-description").value = "";
      $("report-status").textContent = `Report received. Reference: ${id}. Contact your administrator for support follow-up.`;
    } catch (error) {
      $("report-status").textContent = error.message || "The report could not be sent. Retry when connected.";
      error.handledInView = true;
      throw error;
    } finally { stopLoading(); }
  });
  bind("test-import", async () => { const project = await host.activeProject(); const file = await host.selectVideo(); if (file) { await host.importFile(file, project); message(`Imported ${file.name} into ${project.name}.`); } });
  bind("sign-out", async () => {
    try { await client.signOut(); }
    finally { if (!client.session) await clearAccountState(); }
    message("Signed out of Boardwalk.");
  });
  void run(async () => {
    await refreshProject();
    await client.restore();
    renderView();
    if (client.session) {
      await restoreSession();
      await loadLibrary();
    } else await restoreReports();
  }, "auth.restore");
  setInterval(() => void reports.flush(), 30000);
}
host.uxp.entrypoints.setup({ panels: { boardwalkPanel: { show: refreshProject } } });
initialize();
