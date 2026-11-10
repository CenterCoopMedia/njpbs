"use strict";

const { GoogleAuth } = require("google-auth-library");
const { ElectionSourceError, parseElectionRoster, electionApInitialUrl } = require("./election-result-sources");
const rehearsal = require("./election-source-rehearsal");
const ROSTER_URL = "https://centercoopmedia.github.io/nj-decides/data/2026-general-candidates.json";
const RESULTS_URL = "https://centercoopmedia.github.io/nj-decides/data/2026-general-results.json";
const fail = (code, message, fetchCause, httpStatus) => { throw Object.assign(new ElectionSourceError(code, message),
  fetchCause ? { fetchCause, ...(httpStatus === undefined ? {} : { httpStatus }) } : {}); };
const MAX_BYTES = 512 * 1024;
const FETCH_CAUSES = new Set(["timeout", "dns", "tls", "network", "auth", "quota", "http-4xx", "http-5xx", "http", "parse", "empty", "size"]);

function transportCause(error) {
  const code = error?.cause?.code ?? error?.code;
  if (["TimeoutError", "AbortError"].includes(error?.name) ||
      ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return "timeout";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (typeof code === "string" && (code.startsWith("ERR_TLS_") ||
      ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code))) return "tls";
  return "network";
}
/** Only fixed codes and a numeric provider status may cross the storage boundary. */
function fetchFailure(error) {
  if (!FETCH_CAUSES.has(error?.fetchCause)) return null;
  return { code: error.fetchCause, ...(Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599
    ? { httpStatus: error.httpStatus } : {}) };
}

/** Never surface a provider body, request object, auth header or raw error. */
async function jsonGet(url, { fetchImpl = fetch, headers = {}, limit = MAX_BYTES, allowNotModified = false } = {}) {
  let response;
  try { response = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(8000) }); }
  catch (error) { fail("source-unavailable", "The source could not be read. The previous public values are retained.", transportCause(error)); }
  if (response.status === 304 && allowNotModified) return { notModified: true, etag: response.headers.get("etag") };
  if (!response.ok) {
    // Elections v3 documents 403 as per-minute quota exhaustion (401 is
    // invalid authentication). Other providers retain their 403 auth meaning.
    const apQuota = [403, 429].includes(response.status) && new URL(url).origin === "https://api.ap.org";
    const quota = response.status === 429 || apQuota;
    const error = new ElectionSourceError(response.status === 429 || response.status === 403 ? "source-access" : "source-unavailable",
      apQuota ? "The source query quota is exhausted. Polling will retry within the configured budget."
        : response.status === 401 || response.status === 403 ? "The source refused access. Check the connection's read access." : "The source is unavailable. The previous public values are retained.");
    error.httpStatus = response.status;
    error.fetchCause = quota ? "quota" : response.status === 401 || response.status === 403 ? "auth"
      : response.status >= 500 ? "http-5xx" : response.status >= 400 ? "http-4xx" : "http";
    const retry = response.headers.get("retry-after");
    if (retry) {
      const seconds = /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
      if (Number.isFinite(seconds)) error.retryAfterSeconds = Math.min(86400, Math.max(60, seconds));
    }
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) fail("source-shape", "The source returned an empty response.", "empty", response.status);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail("source-size", "The source response exceeds the connection limit.", "size", response.status); }
      chunks.push(Buffer.from(value));
    }
    return { data: JSON.parse(Buffer.concat(chunks).toString("utf8")), etag: response.headers.get("etag") };
  } catch (error) {
    if (error instanceof ElectionSourceError) throw error;
    fail("source-shape", "The source did not return complete valid JSON.", error instanceof SyntaxError ? "parse" : transportCause(error), response.status);
  } finally { reader.releaseLock(); }
}
async function readRoster({ fetchImpl = fetch } = {}) {
  return parseElectionRoster((await jsonGet(ROSTER_URL, { fetchImpl })).data);
}
/** ADC uses the attached Functions runtime account, with read-only Sheets scope. */
async function readSheetGrid(source, { fetchImpl = fetch } = {}) {
  try {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
    const token = await auth.getAccessToken();
    if (!token) fail("sheet-access", "Sheet access is not configured for the Functions runtime account.");
    const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}`);
    url.search = new URLSearchParams({ ranges: `'${source.tab.replace(/'/g, "''")}'!A1:AN501`, includeGridData: "true",
      fields: "sheets(data(rowData(values(effectiveValue,effectiveFormat(numberFormat)))))" }).toString();
    return (await jsonGet(url.href, { fetchImpl, headers: { Authorization: `Bearer ${token}` } })).data;
  } catch (error) {
    if (error instanceof ElectionSourceError) throw error;
    fail("sheet-access", "The Functions runtime account could not read the Sheet. Check Viewer sharing and Sheets API access.");
  }
}
function apCursor(value, { apRehearsal, mapping } = {}) {
  if (typeof value !== "string" || value.length > 4000 || /\s|\p{Cc}/u.test(value)) fail("ap-cursor", "AP returned an invalid update cursor.");
  let url;
  try { url = new URL(value); } catch { fail("ap-cursor", "AP returned an invalid update cursor."); }
  const allowed = new Set(["statepostal", "raceid", "level", "resultstype", "candidateinfo", "format", "mindatetime",
    "officeid", "racetypeid", "votetypes", "avotes", "winner", "national", "uncontested", "setzerocounts", "omitresults"]);
  if (url.origin !== "https://api.ap.org" || url.pathname !== "/v3/elections/2026-11-03" || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => !allowed.has(key.toLowerCase()))) fail("ap-cursor", "AP returned an unsafe update cursor.");
  if (url.searchParams.get("statePostal")?.toUpperCase() !== "NJ" && url.searchParams.get("statepostal")?.toUpperCase() !== "NJ") fail("ap-cursor", "AP returned a cursor for a different state.");
  if (apRehearsal) {
    const names = [...url.searchParams.keys()].map(key => key.toLowerCase());
    if (new Set(names).size !== names.length) fail("ap-cursor", "AP rehearsal cursors cannot repeat query options.");
    const params = Object.fromEntries([...url.searchParams].map(([key, value]) => [key.toLowerCase(), value]));
    if (params.resultstype !== "t" || params.level !== "state" || params.candidateinfo !== "brief" || params.format !== "json" ||
        params.raceid?.split(",").sort().join(",") !== Object.keys(mapping).sort().join(",")) fail("ap-cursor", "AP rehearsal cursors must keep the exact test query and mapped races.");
  }
  return url.href;
}
/** Optional Secret Manager lookup: absent configuration cannot break Sheet/repo. */
async function readApSecret({ fetchImpl = fetch, projectId }) {
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId ?? "")) fail("ap-disabled", "AP is not configured.");
  let token;
  try {
    const meta = await jsonGet("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { fetchImpl, headers: { "Metadata-Flavor": "Google" }, limit: 16 * 1024 });
    token = meta.data.access_token;
    if (typeof token !== "string" || !token) fail("ap-disabled", "AP is not configured.");
    const value = await jsonGet(`https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/AP_ELECTIONS_API_KEY/versions/latest:access`,
      { fetchImpl, headers: { Authorization: `Bearer ${token}` }, limit: 16 * 1024 });
    const encoded = value.data?.payload?.data;
    if (typeof encoded !== "string") fail("ap-disabled", "AP is not configured.");
    const key = Buffer.from(encoded, "base64").toString("utf8").trim();
    if (!key || key.length > 4096 || /\p{Cc}/u.test(key)) fail("ap-disabled", "AP is not configured.");
    return key;
  } catch { fail("ap-disabled", "AP is not configured. The coordinator must provision the Functions secret and runtime access."); }
}
async function readSource({ connection, roster, now, fetchImpl = fetch, sheetsApi = readSheetGrid, projectId }) {
  const source = connection.config.source;
  if (source.kind === "sheet") return { data: await sheetsApi(source, { fetchImpl }) };
  if (source.kind === "repo") {
    const cache = connection.pendingData;
    const result = await jsonGet(connection.config.rehearsal === true ? rehearsal.RESULTS_URL : RESULTS_URL, { fetchImpl, allowNotModified: Boolean(cache && connection.sourceEtag),
      headers: cache && connection.sourceEtag ? { "If-None-Match": connection.sourceEtag } : {} });
    if (!result.notModified) return result;
    // Rebuild only validated selected values, then run the full normalizer
    // again so 304 cannot hide stale times or changes in the current roster.
    return { etag: result.etag ?? connection.sourceEtag, data: { schemaVersion: 1, electionDate: roster.electionDate,
      generatedAt: connection.sourceGeneratedAt, sample: connection.config.rehearsal === true, races: cache.races.map(race => ({
        id: race.id, status: race.status, asOf: race.asOf, reportingShare: race.reportingShare,
        ...(race.expectedVoteShare !== undefined ? { expectedVoteShare: race.expectedVoteShare } : {}),
        sourceKind: race.sourceKind, sourceLabel: race.sourceLabel, sourceUrl: race.sourceUrl,
        candidates: race.candidates.map(candidate => ({ id: candidate.id, votes: candidate.votes, share: candidate.share })),
        ...(race.calledCandidateId ? { calledCandidateId: race.calledCandidateId, apCallUrl: race.apCallUrl } : {}),
      })) } };
  }
  const key = await readApSecret({ fetchImpl, projectId });
  const context = { roster, raceIds: connection.config.raceIds, now, apRehearsal: connection.config.apRehearsal };
  const cursorOptions = { apRehearsal: connection.config.apRehearsal, mapping: source.mapping };
  // One periodic full query replaces a delta poll, using the same request slot.
  // It detects a race removed from the provider rather than treating it as quiet.
  const full = !connection.apCursor || !connection.apStaging &&
    (!connection.lastApFullCheckAt || Date.parse(now) - Date.parse(connection.lastApFullCheckAt) >= 600000);
  const url = full ? electionApInitialUrl(source.mapping, context) : apCursor(connection.apCursor, cursorOptions);
  const result = await jsonGet(url, { fetchImpl, headers: { "x-api-key": key, "Accept-Encoding": "gzip", Accept: "application/json" } });
  // Check before persisting: no raw/key-bearing cursor ever reaches Firestore.
  result.cursor = apCursor(result.data.nextrequest, cursorOptions);
  result.full = full;
  return result;
}
module.exports = { ROSTER_URL, RESULTS_URL, jsonGet, readRoster, readSheetGrid, readApSecret, readSource, apCursor, fetchFailure };
