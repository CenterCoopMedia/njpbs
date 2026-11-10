// Generated from packages/content-core/src/election-result-sources.ts.
// Regenerate with: node scripts/generate-election-result-sources.mjs
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/content-core/src/election-result-sources.ts
var election_result_sources_exports = {};
__export(election_result_sources_exports, {
  AP_PUBLIC_RESULTS_URL: () => AP_PUBLIC_RESULTS_URL,
  ELECTION_SHEET_COLUMNS: () => ELECTION_SHEET_COLUMNS,
  ELECTION_SOURCE_MODES: () => ELECTION_SOURCE_MODES,
  ElectionSourceError: () => ElectionSourceError,
  electionApCache: () => electionApCache,
  electionApInitialUrl: () => electionApInitialUrl,
  electionStatusKey: () => electionStatusKey,
  normalizeApResults: () => normalizeApResults,
  normalizeRepoResults: () => normalizeRepoResults,
  normalizeSheetGridResults: () => normalizeSheetGridResults,
  normalizeSheetResults: () => normalizeSheetResults,
  parseElectionApMapping: () => parseElectionApMapping,
  parseElectionApRehearsal: () => parseElectionApRehearsal,
  parseElectionRoster: () => parseElectionRoster,
  selectElectionSourceMode: () => selectElectionSourceMode
});
module.exports = __toCommonJS(election_result_sources_exports);

// packages/content-core/src/exact-https-url.ts
function isExactHttpsUrl(value, maxLength = Number.POSITIVE_INFINITY) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value || /[\u0000-\u0020\u007F]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// packages/content-core/src/election-results.ts
var ELECTION_RACE_STATUSES = {
  awaiting: "Awaiting results",
  counting: "Votes being counted",
  called: "AP race call",
  official: "Official results",
  certified: "Certified results"
};
var ELECTION_RESULTS_LIMITS = { races: 20, candidates: 24 };
function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function fields(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value, max, required) {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && (!required || value.trim().length > 0);
}
function id(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function share(value) {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function source(value, complete) {
  return !complete && value === "" || isExactHttpsUrl(value, 2e3);
}
function isElectionInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const day = /* @__PURE__ */ new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return day.toISOString().slice(0, 10) === value.slice(0, 10);
}
function candidateError(value, complete) {
  if (!record(value) || !fields(value, ["id", "name", "party", "photo", "votes", "share"]) || !id(value.id)) return "Each candidate needs a unique identity.";
  if (!text(value.name, 120, complete) || value.party !== void 0 && !text(value.party, 60, false)) return "Use a candidate name of up to 120 characters and a party label of up to 60 characters.";
  if (value.votes !== null && (!Number.isSafeInteger(value.votes) || Number(value.votes) < 0)) return "Votes must be a whole number of zero or more, or blank when unknown.";
  if (!share(value.share)) return "Candidate shares must be between 0 and 100, or blank when unknown.";
  if (value.votes === 0 && typeof value.share === "number" && value.share > 0) return "A candidate with zero votes cannot have a positive vote share.";
  if (value.photo !== void 0) {
    const photo = value.photo;
    if (!record(photo) || !fields(photo, ["assetId", "alt", "caption"]) || !id(photo.assetId) || !text(photo.alt, 300, complete) || photo.caption !== void 0 && !text(photo.caption, 300, false)) return "Choose a Media photo and add a description of up to 300 characters.";
  }
  return null;
}
function electionRaceError(value, complete = false) {
  if (!record(value) || !fields(value, ["id", "office", "district", "status", "candidates", "sourceKind", "sourceLabel", "sourceUrl", "asOf", "reportingShare", "expectedVoteShare", "calledCandidateId", "apCallUrl"]) || !id(value.id)) return "Each race needs a unique identity and known fields.";
  if (!text(value.office, 160, complete) || !text(value.district, 160, complete)) return "Add the office and district, using up to 160 characters each.";
  if (typeof value.status !== "string" || !Object.hasOwn(ELECTION_RACE_STATUSES, value.status)) return "Choose a race status.";
  if (!Array.isArray(value.candidates) || value.candidates.length > ELECTION_RESULTS_LIMITS.candidates || complete && value.candidates.length < 2) return "Add between 2 and 24 candidates, including any reported write-ins.";
  const identities = /* @__PURE__ */ new Set();
  for (const candidate of value.candidates) {
    const error = candidateError(candidate, complete);
    if (error) return error;
    if (identities.has(candidate.id)) return "Candidate identities must be unique within a race.";
    identities.add(candidate.id);
  }
  const candidates = value.candidates;
  if (candidates.reduce((sum, candidate) => sum + (candidate.share ?? 0), 0) > 100.1) return "Candidate shares cannot total more than 100% (apart from rounding).";
  if (!["official", "ap"].includes(String(value.sourceKind)) || !text(value.sourceLabel, 160, complete) || !source(value.sourceUrl, complete)) return "Name the source and use a credential-free HTTPS source link.";
  if (!(value.asOf === "" && !complete) && !isElectionInstant(value.asOf)) return "Use a real as-of date and time with a time zone.";
  if (!share(value.reportingShare)) return "Reporting share must be between 0 and 100, or blank when unknown.";
  if (Object.hasOwn(value, "expectedVoteShare") && (typeof value.expectedVoteShare !== "number" || !Number.isFinite(value.expectedVoteShare) || value.expectedVoteShare < 0 || value.expectedVoteShare > 1)) return "Expected vote share must be a fraction between 0 and 1, or omitted when unknown.";
  if (value.status === "called") {
    const candidateMissing = value.calledCandidateId === void 0 || value.calledCandidateId === "";
    const candidateValid = candidateMissing && !complete || id(value.calledCandidateId) && identities.has(value.calledCandidateId);
    if (value.sourceKind !== "ap" || !candidateValid || !source(value.apCallUrl ?? "", complete)) return "An AP call needs the called candidate, an AP source and a link to the AP call. A concession is not a call.";
  } else if (value.calledCandidateId !== void 0 || value.apCallUrl !== void 0) return "AP call details are allowed only for an AP race call.";
  if (["official", "certified"].includes(value.status) && value.sourceKind !== "official") return "Official or certified results must use an official source.";
  if (complete && value.status !== "awaiting" && candidates.some((candidate) => candidate.votes === null || candidate.share === null)) return "Add the reported votes and share for every candidate before approval.";
  if (value.status === "awaiting" && candidates.some((candidate) => candidate.votes !== null || candidate.share !== null)) return "Use Votes being counted when numbers are available. Leave unknown numbers blank.";
  return null;
}
function electionResultsError(value, complete = false) {
  if (!record(value) || !fields(value, ["races"]) || !Array.isArray(value.races) || value.races.length > ELECTION_RESULTS_LIMITS.races || complete && value.races.length === 0) return "Add between 1 and 20 races to the results section.";
  const identities = /* @__PURE__ */ new Set();
  for (const race of value.races) {
    const error = electionRaceError(race, complete);
    if (error) return error;
    if (identities.has(race.id)) return "Race identities must be unique within the results section.";
    identities.add(race.id);
  }
  return null;
}
function electionRaceKey(value) {
  function canonical(input) {
    if (Array.isArray(input)) return input.map(canonical);
    if (record(input)) return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
    return input;
  }
  return JSON.stringify(canonical(value));
}

// packages/content-core/src/election-result-sources.ts
var ELECTION_SOURCE_MODES = ["approve-once", "counts-auto", "automatic"];
var AP_PUBLIC_RESULTS_URL = "https://apnews.com/hub/election-2026";
var ELECTION_SHEET_COLUMNS = [
  "race_id",
  "candidate_id",
  "votes",
  "share",
  "status",
  "as_of",
  "reporting_share",
  "source_kind",
  "source_label",
  "source_url",
  "called_candidate_id",
  "ap_call_url"
];
var ElectionSourceError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ElectionSourceError";
  }
  code;
};
function fail(code, message) {
  throw new ElectionSourceError(code, message);
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("shape", "Expected a source object.");
}
function fields2(value, required, optional = []) {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key))) {
    fail("shape", "The source has missing or unknown fields.");
  }
}
function text2(value, max = 160) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function id2(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function array(value, max) {
  if (!Array.isArray(value) || value.length > max) fail("shape", "The source exceeds its row or race limit.");
}
function unique(values, code = "identity") {
  if (new Set(values).size !== values.length) fail(code, "The source contains duplicate identities.");
}
function parseElectionRoster(input, electionDate = "2026-11-03") {
  object(input);
  fields2(input, ["schemaVersion", "electionDate", "races", "candidates"]);
  if (input.schemaVersion !== 1 || input.electionDate !== electionDate) fail("roster", "Use the selected election roster.");
  array(input.races, 20);
  array(input.candidates, 480);
  if (!input.races.length || !input.candidates.length) fail("roster", "The roster is empty.");
  const candidates = input.candidates.map((candidate) => {
    object(candidate);
    fields2(candidate, [
      "id",
      "raceId",
      "name",
      "firstName",
      "lastName",
      "ballotLabel",
      "party",
      "incumbent",
      "campaignWebsite",
      "ballotStatus",
      "aliases"
    ], ["publishedProfileUrl"]);
    if (!id2(candidate.id) || !id2(candidate.raceId) || !text2(candidate.name, 120) || !text2(candidate.firstName, 120) || !text2(candidate.lastName, 120) || !text2(candidate.ballotLabel, 60) || !text2(candidate.party, 60) || typeof candidate.incumbent !== "boolean" || !text2(candidate.ballotStatus, 60) || !(candidate.campaignWebsite === "" || isExactHttpsUrl(candidate.campaignWebsite, 2e3))) fail("roster", "The roster has invalid candidate details.");
    array(candidate.aliases, 24);
    if (candidate.aliases.some((alias) => !text2(alias, 120))) fail("roster", "The roster has invalid aliases.");
    if (candidate.publishedProfileUrl !== void 0 && (!isExactHttpsUrl(candidate.publishedProfileUrl, 2e3) || new URL(candidate.publishedProfileUrl).hostname !== "www.njspotlightnews.org")) fail("roster", "A profile link must be a published NJ Spotlight News URL.");
    return candidate;
  });
  unique(candidates.map((candidate) => candidate.id));
  const races = input.races.map((race) => {
    object(race);
    fields2(race, ["id", "office", "district", "candidateIds"]);
    if (!id2(race.id) || !text2(race.office) || !text2(race.district)) fail("roster", "The roster has an invalid race.");
    array(race.candidateIds, 24);
    if (race.candidateIds.length < 2 || race.candidateIds.some((cid) => !id2(cid))) fail("roster", "Each roster race needs candidate identities.");
    unique(race.candidateIds);
    if (race.candidateIds.some((cid) => !candidates.some((candidate) => candidate.id === cid && candidate.raceId === race.id)) || candidates.filter((candidate) => candidate.raceId === race.id).length !== race.candidateIds.length) fail("roster", "Race and candidate roster identities disagree.");
    return race;
  });
  unique(races.map((race) => race.id));
  if (candidates.some((candidate) => !races.some((race) => race.id === candidate.raceId))) fail("roster", "A candidate has no roster race.");
  return structuredClone({ schemaVersion: 1, electionDate: input.electionDate, races, candidates });
}
function contextCheck(context) {
  if (!isElectionInstant(context.now) || !Array.isArray(context.raceIds) || !context.raceIds.length || context.raceIds.length > 20 || context.raceIds.some((rid) => !context.roster.races.some((race) => race.id === rid))) fail("mapping", "Select known roster races.");
  unique(context.raceIds);
  const age = context.maxAgeSeconds ?? 300;
  if (!Number.isSafeInteger(age) || age < 60 || age > 86400) fail("mapping", "Source age must be between 60 seconds and 24 hours.");
  return age;
}
function checked(data, context, freshness = "race") {
  const age = contextCheck(context);
  const error = electionResultsError(data, true);
  if (error) fail("contract", error);
  for (const rid of context.raceIds) {
    const race = data.races.find((item) => item.id === rid);
    if (!race) fail("missing-race", "A selected race disappeared from the source.");
    const time = Date.parse(race.asOf);
    if (time > Date.parse(context.now)) fail("future", "The source time is in the future.");
    if (freshness === "race" && Date.parse(context.now) - time > age * 1e3) fail("stale", "The source is older than the connection allows.");
    const previous = context.previous?.races.find((item) => item.id === rid);
    if (previous && time < Date.parse(previous.asOf)) fail("regression", "The source time moved backward.");
  }
  return data;
}
var raceFields = ["id", "status", "asOf", "reportingShare", "sourceKind", "sourceLabel", "sourceUrl", "candidates"];
function rosterRace(input, context, directAttribution) {
  object(input);
  fields2(input, raceFields, ["calledCandidateId", "apCallUrl", "expectedVoteShare"]);
  const roster = context.roster.races.find((race2) => race2.id === input.id);
  if (!roster) fail("roster", "The source contains a race outside the roster.");
  array(input.candidates, 24);
  const candidates = input.candidates.map((value) => {
    object(value);
    fields2(value, ["id", "votes", "share"]);
    const candidate = context.roster.candidates.find((item) => item.id === value.id && item.raceId === input.id);
    if (!candidate) fail("roster", "The source contains a candidate outside the race roster.");
    return {
      id: candidate.id,
      name: candidate.name,
      party: candidate.ballotLabel,
      votes: value.votes,
      share: value.share,
      ...context.photos?.[candidate.id] ? { photo: structuredClone(context.photos[candidate.id]) } : {}
    };
  });
  unique(candidates.map((candidate) => candidate.id));
  if (candidates.length !== roster.candidateIds.length) fail("missing-candidate", "A roster candidate disappeared from the source.");
  const { candidates: _candidates, ...race } = input;
  return {
    ...race,
    office: roster.office,
    district: roster.district,
    candidates: roster.candidateIds.map((cid) => candidates.find((candidate) => candidate.id === cid)),
    ...input.status === "called" && directAttribution && !input.apCallUrl ? { apCallUrl: AP_PUBLIC_RESULTS_URL } : {}
  };
}
function normalizeRepoResults(input, context) {
  contextCheck(context);
  object(input);
  fields2(input, ["schemaVersion", "electionDate", "generatedAt", "sample", "races"]);
  if (input.schemaVersion !== 1 || input.electionDate !== context.roster.electionDate || input.sample !== (context.rehearsal === true) || !isElectionInstant(input.generatedAt) || Date.parse(input.generatedAt) > Date.parse(context.now)) fail("envelope", "Use live results for the selected election with a valid generation time.");
  array(input.races, 20);
  const all = input.races.map((race) => rosterRace(race, context, true));
  unique(all.map((race) => race.id));
  return checked({ races: context.raceIds.map((rid) => all.find((race) => race.id === rid) ?? fail("missing-race", "A selected race disappeared from the source.")) }, context);
}
function cellNumber(value) {
  if (value === "" || value === void 0 || value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  fail("number", "Use unformatted numbers; blank means unknown.");
}
function normalizeSheetResults(values, mapping, context) {
  contextCheck(context);
  array(values, 501);
  if (!values.length || !Array.isArray(values[0])) fail("sheet", "The Sheet needs a header row.");
  const headers = values[0];
  const names = ELECTION_SHEET_COLUMNS.map((key) => mapping[key] ?? key);
  if (names.some((name) => !text2(name, 120))) fail("mapping", "Choose a header for each mapped column.");
  unique(names, "mapping");
  const positions = ELECTION_SHEET_COLUMNS.map((key, index) => {
    const matches = headers.flatMap((header, i) => header === names[index] ? [i] : []);
    if (matches.length > 1 || matches.length === 0 && !["called_candidate_id", "ap_call_url"].includes(key)) fail("mapping", "A mapped header is missing or repeated.");
    return matches[0] ?? -1;
  });
  const races = /* @__PURE__ */ new Map();
  const repeated = /* @__PURE__ */ new Map();
  for (const row of values.slice(1)) {
    if (!Array.isArray(row)) fail("sheet", "Each Sheet row must be a cell list.");
    if (row.every((value) => value === "" || value === null)) continue;
    const cells = Object.fromEntries(ELECTION_SHEET_COLUMNS.map((key, i) => [key, positions[i] < 0 ? "" : row[positions[i]] ?? ""]));
    if (!id2(cells.race_id) || !id2(cells.candidate_id)) fail("identity", "Each Sheet row needs roster race and candidate IDs.");
    const candidate = { id: cells.candidate_id, votes: cellNumber(cells.votes), share: cellNumber(cells.share) };
    const race = {
      id: cells.race_id,
      status: cells.status,
      asOf: cells.as_of,
      reportingShare: cellNumber(cells.reporting_share),
      sourceKind: cells.source_kind,
      sourceLabel: cells.source_label,
      sourceUrl: cells.source_url,
      ...cells.called_candidate_id ? { calledCandidateId: cells.called_candidate_id } : {},
      ...cells.ap_call_url ? { apCallUrl: cells.ap_call_url } : {}
    };
    const signature = electionRaceKey(race);
    if (repeated.has(race.id) && repeated.get(race.id) !== signature) fail("sheet", "Repeated race fields disagree in the Sheet.");
    repeated.set(race.id, signature);
    const existing = races.get(race.id);
    if (existing) existing.candidates.push(candidate);
    else races.set(race.id, { ...race, candidates: [candidate] });
  }
  const all = [...races.values()].map((race) => rosterRace(race, context, false));
  return checked({ races: context.raceIds.map((rid) => all.find((race) => race.id === rid) ?? fail("missing-race", "A selected race disappeared from the source.")) }, context);
}
function normalizeSheetGridResults(input, mapping, context) {
  object(input);
  array(input.sheets, 1);
  if (input.sheets.length !== 1) fail("sheet", "Read one bounded Sheet range.");
  const sheet = input.sheets[0];
  object(sheet);
  array(sheet.data, 1);
  if (sheet.data.length !== 1) fail("sheet", "Read one bounded Sheet range.");
  const grid = sheet.data[0];
  object(grid);
  array(grid.rowData, 501);
  const header = grid.rowData[0];
  object(header);
  const headerCells = header.values ?? [];
  array(headerCells, 40);
  const mappedNames = new Set(ELECTION_SHEET_COLUMNS.map((key) => mapping[key] ?? key));
  const mappedPositions = new Set(headerCells.flatMap((cell, index) => {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) return [];
    const value = cell.effectiveValue;
    return value && typeof value === "object" && !Array.isArray(value) && mappedNames.has(String(value.stringValue)) ? [index] : [];
  }));
  const values = grid.rowData.map((row, rowIndex) => {
    object(row);
    const cells = row.values ?? [];
    array(cells, 40);
    return cells.map((cell, index) => {
      if (rowIndex > 0 && !mappedPositions.has(index)) return "";
      object(cell);
      const format = cell.effectiveFormat;
      if (rowIndex > 0 && format !== void 0) {
        object(format);
        const number = format.numberFormat;
        if (number !== void 0) {
          object(number);
          if (number.type === "PERCENT") fail("sheet-format", "Use percentage points from 0 to 100, with plain number formatting instead of percent cells.");
        }
      }
      const value = cell.effectiveValue;
      if (value === void 0) return "";
      object(value);
      if (Object.hasOwn(value, "errorValue") || Object.hasOwn(value, "boolValue")) fail("sheet", "Sheet formulas must resolve to text or numbers without errors.");
      return value.numberValue ?? value.stringValue ?? "";
    });
  });
  return normalizeSheetResults(values, mapping, context);
}
function apInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail("ap", "AP returned an invalid source time.");
  }
  const instant = value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, "$1");
  if (!isElectionInstant(instant)) fail("ap", "AP returned an invalid source time.");
  return instant;
}
function electionApCache(data, mapping) {
  return { mappingKey: electionRaceKey(mapping), data: structuredClone(data) };
}
function parseElectionApMapping(input, context) {
  contextCheck(context);
  object(input);
  const pairs = Object.entries(input);
  if (pairs.length !== context.raceIds.length) fail("mapping", "Map every selected race exactly once.");
  const mapped = pairs.map(([providerId, value]) => {
    object(value);
    fields2(value, ["raceId", "candidateIds"]);
    if (!/^\d{1,20}$/.test(providerId) || typeof value.raceId !== "string" || !context.raceIds.includes(value.raceId)) fail("mapping", "Map AP race IDs to the selected roster races.");
    const race = context.roster.races.find((race2) => race2.id === value.raceId);
    object(value.candidateIds);
    const candidates = Object.entries(value.candidateIds);
    if (candidates.length !== race.candidateIds.length || candidates.some(([apid, cid]) => !/^\d{1,20}$/.test(apid) || typeof cid !== "string" || !race.candidateIds.includes(cid))) fail("mapping", "Map every AP candidate to its roster identity.");
    unique(candidates.map(([, cid]) => String(cid)), "mapping");
    return [providerId, { raceId: value.raceId, candidateIds: Object.fromEntries(candidates) }];
  });
  unique(mapped.map(([, value]) => value.raceId), "mapping");
  return Object.fromEntries(mapped);
}
function parseElectionApRehearsal(input, now, electionDate = "2026-11-03") {
  object(input);
  fields2(input, ["sourceTimeOrigin", "replayTimeOrigin"]);
  if (!isElectionInstant(now) || !isElectionInstant(input.sourceTimeOrigin) || !isElectionInstant(input.replayTimeOrigin)) {
    fail("rehearsal", "AP rehearsal requires explicit valid simulation and replay origins.");
  }
  const sourceTime = Date.parse(input.sourceTimeOrigin);
  const replayTime = Date.parse(input.replayTimeOrigin);
  const electionStart = Date.parse(`${electionDate}T00:00:00Z`);
  if (sourceTime < electionStart || sourceTime >= electionStart + 1728e5 || replayTime > Date.parse(now) || Date.parse(now) - replayTime > 864e5) fail("rehearsal", "Use the selected AP test event and a replay origin within the last day.");
  return { sourceTimeOrigin: input.sourceTimeOrigin, replayTimeOrigin: input.replayTimeOrigin };
}
function electionApInitialUrl(mapping, context) {
  const checked2 = parseElectionApMapping(mapping, context);
  if (context.apRehearsal) parseElectionApRehearsal(context.apRehearsal, context.now, context.roster.electionDate);
  const url = new URL(`https://api.ap.org/v3/elections/${context.roster.electionDate}`);
  url.search = new URLSearchParams({
    statePostal: "NJ",
    raceID: Object.keys(checked2).sort().join(","),
    level: "state",
    resultsType: context.apRehearsal ? "t" : "b",
    candidateInfo: "brief",
    format: "json"
  }).toString();
  return url.href;
}
function normalizeApResults(input, mapping, context, cache) {
  mapping = parseElectionApMapping(mapping, context);
  object(input);
  const replay = context.apRehearsal ? parseElectionApRehearsal(context.apRehearsal, context.now, context.roster.electionDate) : void 0;
  if (replay && context.rehearsal) fail("rehearsal", "AP and historical rehearsals use separate modes.");
  const matchingCache = cache?.mappingKey === electionRaceKey(mapping);
  const linkOnly = input.electionDate === void 0 && !Object.hasOwn(input, "electionDate") && input.races === void 0 && typeof input.nextrequest === "string" && matchingCache;
  if (input.electionDate !== context.roster.electionDate && !linkOnly || input.isTruncated === true) fail("ap", "AP returned a different election or an incomplete response.");
  const raw = input.races ?? [];
  array(raw, 20);
  const cached = matchingCache ? cache.data.races : [];
  const current = new Map(cached.map((race) => [race.id, rosterRace({
    id: race.id,
    status: race.status,
    asOf: race.asOf,
    reportingShare: race.reportingShare,
    sourceKind: race.sourceKind,
    ...context.expectedVoteShareEnabled && race.expectedVoteShare !== void 0 ? { expectedVoteShare: race.expectedVoteShare } : {},
    sourceLabel: race.sourceLabel,
    sourceUrl: race.sourceUrl,
    candidates: race.candidates.map((candidate) => ({ id: candidate.id, votes: candidate.votes, share: candidate.share })),
    ...race.calledCandidateId ? { calledCandidateId: race.calledCandidateId, apCallUrl: race.apCallUrl } : {}
  }, context, true)]));
  const seen = [];
  for (const value of raw) {
    object(value);
    if (!id2(String(value.raceID)) || !Object.hasOwn(mapping, String(value.raceID))) fail("roster", "An AP race is not mapped to the roster.");
    const bind = mapping[String(value.raceID)];
    seen.push(bind.raceId);
    if (value.test !== void 0 && typeof value.test !== "boolean") fail("ap", "AP returned an invalid test marker.");
    const supportedType = replay ? value.resultsType === "test" && value.test !== false : ["live", "certified"].includes(String(value.resultsType)) && value.test !== true;
    if (!supportedType || value.raceTypeID !== "G" || !["S", "H"].includes(String(value.officeID))) fail("ap", "AP test or unsupported race data cannot publish.");
    array(value.reportingUnits, 1);
    const unit = value.reportingUnits[0];
    object(unit);
    if (unit.statePostal !== "NJ" || unit.reportingunitLevel !== "1" && unit.reportingunitLevel !== 1) fail("ap", "Use AP New Jersey state totals only.");
    array(unit.candidates, 24);
    const reported = unit.candidates.map((candidate) => {
      object(candidate);
      const cid = String(candidate.candidateID);
      if (!Object.hasOwn(bind.candidateIds, cid)) fail("roster", "An AP candidate is not mapped to the roster.");
      if (!Number.isSafeInteger(candidate.voteCount) || Number(candidate.voteCount) < 0) fail("contract", "AP votes must be nonnegative whole numbers.");
      if (candidate.winner !== void 0 && !["X", "N", "R", ""].includes(String(candidate.winner))) fail("ap", "AP returned an unknown winner marker.");
      if (candidate.winner === "R") fail("ap", "A runoff requires a separately supported race contract.");
      return { id: bind.candidateIds[cid], votes: candidate.voteCount, winner: candidate.winner };
    });
    const sum = reported.reduce((total, candidate) => total + candidate.votes, 0);
    if (!Number.isSafeInteger(sum)) fail("contract", "AP vote totals exceed the safe number limit.");
    const winners = reported.filter((candidate) => candidate.winner === "X");
    if (winners.length > 1) fail("ap", "AP returned multiple winners for a single-seat race.");
    const certified = value.resultsType === "certified";
    const awaiting = !certified && !winners.length && sum === 0 && unit.precinctsReporting === 0;
    const status = certified ? "certified" : winners.length ? "called" : awaiting ? "awaiting" : "counting";
    const sourceTime = apInstant(unit.lastUpdated);
    if (replay && (Date.parse(sourceTime) < Date.parse(`${context.roster.electionDate}T00:00:00Z`) || Date.parse(sourceTime) >= Date.parse(`${context.roster.electionDate}T00:00:00Z`) + 1728e5)) fail("ap", "Use source times from the selected AP test event.");
    const asOf = replay ? new Date(Date.parse(sourceTime) - Date.parse(replay.sourceTimeOrigin) + Date.parse(replay.replayTimeOrigin)).toISOString() : sourceTime;
    const eevp = Object.hasOwn(unit, "eevp") ? unit.eevp : value.eevp;
    if (eevp !== void 0 && eevp !== null && (typeof eevp !== "number" || !Number.isFinite(eevp) || eevp < 0 || eevp > 100)) fail("ap", "AP returned an invalid expected vote percentage.");
    const race = rosterRace({
      id: bind.raceId,
      status,
      asOf,
      sourceKind: certified ? "official" : "ap",
      sourceLabel: replay ? "REHEARSAL: AP 2026 test data; replay time" : "The Associated Press",
      sourceUrl: AP_PUBLIC_RESULTS_URL,
      reportingShare: context.expectedVoteShareEnabled ? null : unit.precinctsReportingPct ?? null,
      ...context.expectedVoteShareEnabled && typeof eevp === "number" ? { expectedVoteShare: eevp / 100 } : {},
      candidates: reported.map((candidate) => ({
        id: candidate.id,
        votes: awaiting ? null : candidate.votes,
        share: awaiting ? null : sum ? Math.round(candidate.votes / sum * 1e6) / 1e4 : 0
      })),
      ...winners.length && !certified ? { calledCandidateId: winners[0].id, apCallUrl: AP_PUBLIC_RESULTS_URL } : {}
    }, context, true);
    const before = current.get(race.id);
    const previous = context.previous?.races.find((item) => item.id === race.id);
    const newest = previous && (!before || Date.parse(previous.asOf) > Date.parse(before.asOf)) ? previous : before;
    if (context.apFullReconciliation && newest && Date.parse(race.asOf) < Date.parse(newest.asOf) && electionRaceKey({ ...race, asOf: newest.asOf }) === electionRaceKey(newest)) {
      current.set(race.id, structuredClone(newest));
      continue;
    }
    if (before && Date.parse(race.asOf) < Date.parse(before.asOf)) fail("regression", "The AP source time moved backward from its cached race.");
    current.set(race.id, race);
  }
  unique(seen);
  return checked({ races: context.raceIds.map((rid) => current.get(rid) ?? fail("missing-race", "AP has not supplied a selected race.")) }, context, "poll");
}
function electionStatusKey(race) {
  return electionRaceKey({
    status: race.status,
    calledCandidateId: race.calledCandidateId ?? null,
    apCallUrl: race.apCallUrl ?? null,
    sourceKind: race.sourceKind
  });
}
function selectElectionSourceMode(incoming, previous, mode, authorizedStatuses = {}) {
  if (!ELECTION_SOURCE_MODES.includes(mode)) fail("mode", "Choose a known publication mode.");
  const pending = [];
  const races = incoming.races.map((race) => {
    const before = previous?.races.find((item) => item.id === race.id);
    if (mode !== "counts-auto" || before && electionStatusKey(before) === electionStatusKey(race) || ["awaiting", "counting"].includes(race.status) && (!before || ["awaiting", "counting"].includes(before.status)) || authorizedStatuses[race.id] === electionStatusKey(race)) return race;
    pending.push(race.id);
    if (race.status === "awaiting" && before) return structuredClone(before);
    const { calledCandidateId: _called, apCallUrl: _url, ...counts } = race;
    const fallback = before?.status === "awaiting" ? "counting" : before?.status ?? "counting";
    return {
      ...counts,
      status: fallback,
      ...before?.status === "called" ? { calledCandidateId: before.calledCandidateId, apCallUrl: before.apCallUrl } : {},
      ...before && ["called", "official", "certified"].includes(before.status) ? { sourceKind: before.sourceKind, sourceLabel: before.sourceLabel, sourceUrl: before.sourceUrl } : {}
    };
  });
  const data = { races };
  const error = electionResultsError(data, true);
  if (error) fail("contract", error);
  return { data, pending };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AP_PUBLIC_RESULTS_URL,
  ELECTION_SHEET_COLUMNS,
  ELECTION_SOURCE_MODES,
  ElectionSourceError,
  electionApCache,
  electionApInitialUrl,
  electionStatusKey,
  normalizeApResults,
  normalizeRepoResults,
  normalizeSheetGridResults,
  normalizeSheetResults,
  parseElectionApMapping,
  parseElectionApRehearsal,
  parseElectionRoster,
  selectElectionSourceMode
});
