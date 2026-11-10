"use strict";

const { createHash } = require("node:crypto");
const { parseBannerText } = require("./live-production-contract");

const MAX_REQUEST_BYTES = 256 * 1024;

class LiveError extends Error {
  constructor(status, message, details, code) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}
const fail = (message, status = 400, details, code) => { throw new LiveError(status, message, details, code); };
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => hash(JSON.stringify(canonical(value)));
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("Unknown request fields.");
}
const STAFF_FIELDS = {
  get_connector_package: ["sourceSha"], create_connector_download: ["sourceSha"],
  list_sessions: ["cursor"], create_session: ["title", "productionProgramId", "publicProgramId", "showPlanId"],
  get_session: [], set_mapping: ["baseMappingVersion", "deviceId", "inputs", "overlayInputs", "titleFilesConfirmed"],
  set_session_state: ["baseGeneration", "state"], list_banners: ["cursor"],
  save_banner: ["bannerId", "baseVersion", "text", "order"], archive_banner: ["bannerId", "baseVersion"],
  import_csv: ["csv", "archiveExisting"], cue: ["bannerId", "baseVersion"],
  command: ["commandId", "sessionGeneration", "mappingVersion", "expectedObservationSequence", "expectedClearGeneration", "commandAction", "bannerId", "baseVersion", "target"],
};
const AGENT_FIELDS = {
  pull: ["timingId", "afterSequence"], heartbeat: ["timingId"], fence: ["commandId"],
  receipt: ["commandId", "receiptId", "status"], observe: ["observation"],
  verify_mapping: ["mappingVersion", "inputs", "overlayInputs", "fields", "inputTypes", "titleFiles"],
};
function parseRequest(body, agent = false) {
  const extra = (agent ? AGENT_FIELDS : STAFF_FIELDS)[body?.action];
  if (!extra) fail("Choose a live production action.");
  fields(body, ["action", "sessionId", ...(agent ? ["deviceId"] : ["requestId"]), ...extra]);
  if (body.archiveExisting !== undefined && typeof body.archiveExisting !== "boolean") fail("archiveExisting must be a boolean.");
  const connectorRequest = !agent && ["get_connector_package", "create_connector_download"].includes(body.action);
  if (connectorRequest && (typeof body.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(body.sourceSha))) fail("Choose a valid connector source revision.");
  if (!connectorRequest && !["list_sessions", "create_session"].includes(body.action) && !validId(body.sessionId)) fail("Choose a valid session.");
  if (agent && !validId(body.deviceId)) fail("Choose a valid device.");
  if (!agent && !connectorRequest && !["list_sessions", "get_session", "list_banners"].includes(body.action) && !validId(body.requestId)) fail("A unique requestId is required.");
  for (const key of ["cursor", "bannerId", "deviceId", "commandId", "receiptId", "timingId", "productionProgramId", "publicProgramId", "showPlanId"]) {
    if (body[key] !== undefined && body[key] !== null && !validId(body[key])) fail(`Invalid ${key}.`);
  }
  for (const key of ["baseVersion", "baseMappingVersion", "baseGeneration", "sessionGeneration", "mappingVersion", "expectedObservationSequence", "expectedClearGeneration", "afterSequence", "order"]) {
    if (body[key] !== undefined && !(key === "baseVersion" || key === "order" || key === "afterSequence" || key === "expectedClearGeneration" || key === "expectedObservationSequence" ? nonnegative(body[key]) : positive(body[key]))) fail(`Invalid ${key}.`);
  }
  return canonical(body);
}

/** Strict RFC-style CSV cells: content is literal, including whitespace/newlines. */
function parseBannerCsv(csv) {
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 240 * 1024) fail("CSV must fit the 240 KiB import budget.", 413);
  const input = csv.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], cell = "", quoted = false, closed = false;
  function finishCell() { row.push(cell); cell = ""; closed = false; }
  function finishRow() {
    finishCell(); rows.push(row); row = [];
    if (rows.length > 101) fail("Import at most 100 banners.");
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (input[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
      continue;
    }
    if (char === ",") finishCell();
    else if (char === "\n" || char === "\r") { if (char === "\r" && input[i + 1] === "\n") i++; finishRow(); }
    else if (char === '"' && !cell && !closed) quoted = true;
    else { if (closed || char === '"') fail("Invalid CSV quoting."); cell += char; }
  }
  if (quoted) fail("Unclosed CSV quote.");
  if (cell || row.length || closed) finishRow();
  if (JSON.stringify(rows.shift()) !== JSON.stringify(["templateId", "headline", "name", "title"])) fail("CSV header must be templateId,headline,name,title.");
  if (!rows.length) fail("CSV has no banner rows.");
  return rows.map((cells, index) => {
    if (cells.length !== 4) fail(`CSV row ${index + 2} needs four cells.`);
    const [templateId, headline, name, title] = cells;
    if (templateId === "headline" && (name !== "" || title !== "")) fail(`CSV row ${index + 2} has unused name/title text.`);
    if (templateId === "name_title" && headline !== "") fail(`CSV row ${index + 2} has unused headline text.`);
    try { return parseBannerText(templateId === "headline" ? { templateId, headline } : { templateId, name, title }); }
    catch { fail(`CSV row ${index + 2} has invalid banner text.`); }
  });
}
module.exports = { MAX_REQUEST_BYTES, LiveError, fail, validId, positive, nonnegative, hash, fingerprint, fields, parseRequest, parseBannerCsv };
