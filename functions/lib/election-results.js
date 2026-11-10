// Generated from packages/content-core/src/election-results.ts.
// Regenerate with: node scripts/generate-election-results.mjs
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

// packages/content-core/src/election-results.ts
var election_results_exports = {};
__export(election_results_exports, {
  ELECTION_RACE_STATUSES: () => ELECTION_RACE_STATUSES,
  ELECTION_RESULTS_LIMITS: () => ELECTION_RESULTS_LIMITS,
  electionRaceError: () => electionRaceError,
  electionRaceKey: () => electionRaceKey,
  electionResultsError: () => electionResultsError,
  isElectionInstant: () => isElectionInstant,
  isElectionResultsData: () => isElectionResultsData
});
module.exports = __toCommonJS(election_results_exports);

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
function isElectionResultsData(value, complete = false) {
  return electionResultsError(value, complete) === null;
}
function electionRaceKey(value) {
  function canonical(input) {
    if (Array.isArray(input)) return input.map(canonical);
    if (record(input)) return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
    return input;
  }
  return JSON.stringify(canonical(value));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ELECTION_RACE_STATUSES,
  ELECTION_RESULTS_LIMITS,
  electionRaceError,
  electionRaceKey,
  electionResultsError,
  isElectionInstant,
  isElectionResultsData
});
