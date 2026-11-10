// Generated from packages/content-core/src/live-blog-draft.ts.
// Regenerate with: node scripts/generate-live-blog.mjs
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

// packages/content-core/src/live-blog-draft.ts
var live_blog_draft_exports = {};
__export(live_blog_draft_exports, {
  LIVE_BLOG_CONTRACT_VERSION: () => LIVE_BLOG_CONTRACT_VERSION,
  LIVE_BLOG_MAX_REGISTERED_AUTHORS: () => LIVE_BLOG_MAX_REGISTERED_AUTHORS,
  LiveBlogDraftError: () => LiveBlogDraftError,
  assertLiveBlogData: () => assertLiveBlogData,
  assertLiveBlogFollowUpsEditable: () => assertLiveBlogFollowUpsEditable,
  assertLiveBlogReady: () => assertLiveBlogReady,
  assertLiveBlogRetainsPublished: () => assertLiveBlogRetainsPublished,
  freezeLiveBlogData: () => freezeLiveBlogData,
  liveBlogFollowUpsEqual: () => liveBlogFollowUpsEqual,
  liveBlogMediaAssetIds: () => liveBlogMediaAssetIds,
  liveBlogVideoBlocks: () => liveBlogVideoBlocks,
  parseLiveBlogDraft: () => parseLiveBlogDraft,
  prepareLiveBlogDraft: () => prepareLiveBlogDraft,
  previewLiveBlogData: () => previewLiveBlogData,
  publicLiveBlogData: () => publicLiveBlogData,
  publicRichText: () => publicRichText
});
module.exports = __toCommonJS(live_blog_draft_exports);

// packages/content-core/src/town-lookup.ts
function isTownLookupData(value, complete = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  if (Object.keys(data).some((key) => !["heading", "introduction", "sourceLine"].includes(key))) return false;
  return typeof data.heading === "string" && data.heading.length <= 200 && (!complete || !!data.heading.trim()) && typeof data.introduction === "string" && data.introduction.length <= 4e3 && typeof data.sourceLine === "string" && data.sourceLine.length <= 500;
}

// packages/content-core/src/data-hub-reporting.ts
var DATA_HUB_FIGURES = {
  unemployment: "Unemployment",
  industryjobs: "Industry jobs",
  propertytax: "Property taxes",
  precipitation: "Precipitation",
  minimumwage: "Minimum wage",
  electricity: "Electricity",
  medianrent: "Median rent",
  medianincome: "Median income",
  housingpermits: "Housing permits",
  voterregistration: "Voter registration",
  statebudget: "State budget",
  temperature: "Temperature",
  familycare: "NJ FamilyCare",
  uninsured: "Health insurance",
  inflationmetro: "Metro inflation",
  schoolabsence: "Chronic absenteeism",
  graduation: "Graduation",
  snap: "NJ SNAP"
};

// packages/content-core/src/data-hub-composition.ts
var DATA_HUB_SECTIONS = {
  introduction: "Page introduction",
  featured: "Featured finding",
  latest: "Latest findings",
  finder: "Find figures",
  overview: "New Jersey in context",
  collection: "Explore the figures",
  ...DATA_HUB_FIGURES,
  methodology: "Reading the numbers"
};
function isDataHubSectionData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["sectionId", "heading", "introduction"].includes(key)) && typeof data.sectionId === "string" && Object.hasOwn(DATA_HUB_SECTIONS, data.sectionId) && typeof data.heading === "string" && data.heading.length <= 300 && typeof data.introduction === "string" && data.introduction.length <= 4e3 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.heading + data.introduction);
}
function dataHubCompositionError(blocks, pageId) {
  const seen = /* @__PURE__ */ new Set();
  for (const block of blocks) {
    if (block.type !== "data_hub_section") continue;
    if (pageId !== void 0 && pageId !== "data-hub") return "Data Hub sections belong only on the Data Hub Page.";
    if (seen.has(block.data.sectionId)) return "Each compiled Data Hub section can appear only once.";
    seen.add(block.data.sectionId);
  }
  return null;
}

// packages/content-core/src/content-layout.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRowData(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "columns")) return false;
  const columns = value.columns;
  return Array.isArray(columns) && columns.length >= 1 && columns.length <= 4 && Array.from(columns).every((width) => Number.isInteger(width) && width >= 1 && width <= 12) && columns.reduce((sum, width) => sum + width, 0) === 12;
}
function isBlockLayout(value) {
  return isRecord(value) && Object.keys(value).every((key) => key === "rowId" || key === "column") && typeof value.rowId === "string" && value.rowId.length > 0 && Number.isInteger(value.column) && value.column >= 0;
}
function contentLayoutError(blocks) {
  if (!blocks.some((block) => block.type === "row" || block.layout !== void 0)) return null;
  let row = null;
  let previousColumn = 0;
  for (const [index, block] of blocks.entries()) {
    if (block.order !== index) return "Row layouts require block order to match array position";
    if (block.type === "row") {
      if (!isRowData(block.data)) return `Row ${block.id} has invalid column widths`;
      if (block.section !== void 0 || block.layout !== void 0) {
        return `Row ${block.id} cannot be nested or own a named page region`;
      }
      row = { id: block.id, columns: block.data.columns };
      previousColumn = 0;
      continue;
    }
    if (block.layout === void 0) {
      row = null;
      continue;
    }
    if (!isBlockLayout(block.layout)) return `Block ${block.id} has invalid row membership`;
    if (block.section !== void 0) return `Block ${block.id} cannot move a named page region into a row`;
    if (!row || row.id !== block.layout.rowId) return `Block ${block.id} must follow its row and its other content`;
    if (block.layout.column >= row.columns.length) return `Block ${block.id} refers to a missing column`;
    if (block.layout.column < previousColumn) return `Row ${row.id} content must follow column reading order`;
    previousColumn = block.layout.column;
  }
  return null;
}
function visibleLayoutBlocks(blocks) {
  if (!blocks.some((block) => block.type === "row" || block.layout !== void 0)) {
    return blocks.filter((block) => block.visible);
  }
  const hiddenRows = new Set(blocks.filter((block) => block.type === "row" && !block.visible).map((block) => block.id));
  return blocks.filter((block) => block.visible && (!block.layout || !hiddenRows.has(block.layout.rowId))).map((block, order) => ({ ...block, order }));
}

// packages/content-core/src/home-source-selection.ts
function isHomeSelectionReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value;
  return Object.keys(receipt).length === 4 && typeof receipt.buildBatchId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(receipt.buildBatchId) && Number.isSafeInteger(receipt.generation) && Number(receipt.generation) > 0 && typeof receipt.commitSha === "string" && /^[a-f0-9]{40}$/.test(receipt.commitSha) && typeof receipt.digest === "string" && /^[a-f0-9]{64}$/.test(receipt.digest);
}
function isHomeSelectedIds(value, maximum) {
  return Array.isArray(value) && value.length <= maximum && value.every((id2) => typeof id2 === "string" && !!id2.trim() && id2.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(id2)) && new Set(value).size === value.length;
}
function homeCatalogJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(homeCatalogJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${homeCatalogJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Home catalog contains invalid data.");
}

// packages/content-core/src/dynamic-shelves.ts
var SHELF_TOPICS = Object.freeze([
  Object.freeze({ id: "budget", label: "Budget" }),
  Object.freeze({ id: "business", label: "Business" }),
  Object.freeze({ id: "delaney-hall", label: "Delaney Hall" }),
  Object.freeze({ id: "energy-environment", label: "Energy and environment" }),
  Object.freeze({ id: "immigration", label: "Immigration" }),
  Object.freeze({ id: "social-issues", label: "Social issues" })
]);
var SHELF_TOPIC_IDS = new Set(SHELF_TOPICS.map((t) => t.id));
function isShelfTopicId(value) {
  return typeof value === "string" && SHELF_TOPIC_IDS.has(value);
}
var TOPIC_SHELF_SOURCES = ["njpbs_related_index"];
var VIDEO_LIBRARIES = ["njpbs_watch", "pbs_national"];
var VIDEO_LIBRARY_LABELS = Object.freeze({
  njpbs_watch: "NJ PBS video library",
  pbs_national: "PBS national library"
});
var SHELF_ITEM_LIMITS = [3, 4, 6, 8, 12];
var SHELF_SORTS = ["newest", "oldest", "curated"];
var SHELF_SORT_LABELS = Object.freeze({
  newest: "Newest first",
  oldest: "Oldest first",
  curated: "The order the approved list carries"
});
var SHELF_PIN_MAX = 6;

// packages/content-core/src/publish-instant.ts
var UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
function parsePublishInstant(value) {
  if (typeof value !== "string") return null;
  const match = value.match(UTC_INSTANT);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  const ms = millis ? Number(millis.padEnd(3, "0")) : 0;
  const instant = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const roundTrip = new Date(instant);
  if (roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() !== mo - 1 || roundTrip.getUTCDate() !== d || roundTrip.getUTCHours() !== h || roundTrip.getUTCMinutes() !== mi || roundTrip.getUTCSeconds() !== s) {
    return null;
  }
  return instant;
}

// packages/content-core/src/editorial-dates.ts
var EDITORIAL_DATE_SOURCES = Object.freeze([
  "firstPublish",
  "backdated",
  "legacy"
]);
var CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
function isCalendarDay(value) {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) return false;
  const parsed = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// packages/content-core/src/datasets.ts
var MAX_DATASET_BYTES = 200 * 1024;
function validDatasetId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

// packages/content-core/src/data-figure.ts
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyFields(value, fields2) {
  return Object.keys(value).every((key) => fields2.includes(key));
}
function isDraftId(value, complete) {
  return typeof value === "string" && (!complete && value === "" || validDatasetId(value));
}
function isDataFigureData(value, complete = false) {
  if (!isObject(value) || !hasOnlyFields(value, ["datasetId", "version", "display"]) || !isDraftId(value.datasetId, complete) || value.display !== "compact" && value.display !== "expanded" || !isObject(value.version)) return false;
  if (value.version.mode === "latestApproved") {
    return hasOnlyFields(value.version, ["mode"]);
  }
  if (value.version.mode === "pinned") {
    return hasOnlyFields(value.version, ["mode", "releaseId"]) && isDraftId(value.version.releaseId, complete);
  }
  return false;
}

// packages/content-core/src/county-comparison.ts
var COUNTY_COMPARISON_VERSION = "nj-federal-counties-2020-2024-v1";
function isCountyComparisonData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["datasetVersion", "heading", "intro", "source"].includes(key)) && data.datasetVersion === COUNTY_COMPARISON_VERSION && typeof data.heading === "string" && data.heading.length <= 300 && typeof data.intro === "string" && data.intro.length <= 4e3 && typeof data.source === "string" && data.source.length <= 1e3 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.heading + data.intro + data.source);
}

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

// packages/content-core/src/bio-profiles.ts
var BIO_LIMITS = Object.freeze({
  profileId: 120,
  name: 120,
  role: 180,
  party: 60,
  area: 160,
  summary: 600,
  sourceUrl: 2e3,
  sourceLabel: 120,
  alt: 300,
  caption: 300
});
var IDENTITY_KEYS = ["profileId", "kind", "name", "role", "party", "area"];
var CARD_KEYS = [...IDENTITY_KEYS, "summary", "sourceUrl", "sourceLabel", "asOf", "image"];
function record2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function closed(value, keys3) {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys3.includes(key));
}
function text2(value, limit, required) {
  return typeof value === "string" && value.length <= limit && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) && (!required || value.trim().length > 0);
}
function identityFields(value, complete) {
  return typeof value.profileId === "string" && (!complete && value.profileId === "" || /^[A-Za-z0-9_-]{1,120}$/.test(value.profileId)) && (value.kind === "person" || value.kind === "organization") && text2(value.name, BIO_LIMITS.name, complete) && text2(value.role, BIO_LIMITS.role, complete) && (value.party === void 0 || text2(value.party, BIO_LIMITS.party, false)) && (value.area === void 0 || text2(value.area, BIO_LIMITS.area, false));
}
function validSource(value, complete) {
  if (!text2(value, BIO_LIMITS.sourceUrl, complete)) return false;
  if (!complete && value === "") return true;
  return isExactHttpsUrl(value, BIO_LIMITS.sourceUrl);
}
function validDay(value, complete) {
  if (!complete && value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validImage(value, complete) {
  if (!record2(value) || !closed(value, ["assetId", "alt", "altDecorative", "caption"])) return false;
  if (typeof value.assetId !== "string" || !(!complete && value.assetId === "" || /^[A-Za-z0-9_-]{1,128}$/.test(value.assetId))) return false;
  if (value.altDecorative !== void 0 && typeof value.altDecorative !== "boolean") return false;
  if (!text2(value.alt, BIO_LIMITS.alt, complete && value.altDecorative !== true)) return false;
  if (value.altDecorative === true && value.alt !== "") return false;
  return value.caption === void 0 || text2(value.caption, BIO_LIMITS.caption, false);
}
function isBioCardData(value, complete = false) {
  return record2(value) && closed(value, CARD_KEYS) && identityFields(value, complete) && text2(value.summary, BIO_LIMITS.summary, complete) && validSource(value.sourceUrl, complete) && text2(value.sourceLabel, BIO_LIMITS.sourceLabel, complete) && validDay(value.asOf, complete) && (value.image === void 0 || validImage(value.image, complete));
}

// packages/content-core/src/content-link.ts
var CONTENT_LINK_DIRECTORY_MAX_BYTES = 1024 * 1024;

// packages/content-core/src/safe-href.ts
var SAFE_SCHEMES = /* @__PURE__ */ new Set(["http", "https", "mailto", "tel"]);
function safeHref(raw) {
  if (typeof raw !== "string") return null;
  const href = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (href.length === 0) return null;
  if (href.replace(/\\/g, "/").startsWith("//")) return null;
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
  const protocol = scheme?.[1].toLowerCase();
  if (protocol && !SAFE_SCHEMES.has(protocol)) return null;
  if (protocol === "http" || protocol === "https") {
    try {
      const url = new URL(href);
      if (url.username || url.password) return null;
    } catch {
      return null;
    }
  }
  return href;
}

// packages/content-core/src/media-origin.ts
var deploymentEnvironment = typeof __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ !== "undefined" ? __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ : typeof process !== "undefined" ? process.env.CMS_DEPLOYMENT_ENVIRONMENT : void 0;
var CMS_MEDIA_ORIGIN = deploymentEnvironment === "development" ? "https://dev-media.example.org" : "https://media.njpbs.org";
function cleanHttpsUrl(url) {
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}
function isCmsMediaUrl(url) {
  return cleanHttpsUrl(url) && (url.origin === "https://media.njpbs.org" || url.origin === CMS_MEDIA_ORIGIN) && url.pathname.startsWith("/cms-media/") && url.pathname.length > 11;
}

// packages/content-core/src/home-source-curation.ts
function homeSourceObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// packages/content-core/src/partner-player.ts
function extractPartnerPlayerSrc(playerCode) {
  if (!playerCode) return null;
  const source2 = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(playerCode)?.[1] ?? playerCode;
  let url;
  try {
    const value = source2.trim().replaceAll("&amp;", "&");
    url = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "player.pbs.org" || url.username || url.password || url.port) return null;
  const match = /^\/(?:partnerplayer|portalplayer|viralplayer)\/([A-Za-z0-9_+-]{1,128}={0,2})\/?$/.exec(url.pathname);
  if (!match) return null;
  const parameters = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    const time = ["start", "end"].includes(name) && /^\d{1,6}$/.test(value);
    const flag = ["topbar", "endscreen", "autoplay", "muted"].includes(name) && /^(?:true|false)$/.test(value);
    if ((time || flag) && !parameters.has(name)) parameters.set(name, value);
  }
  const query = parameters.toString();
  return `https://player.pbs.org/partnerplayer/${match[1]}/${query ? `?${query}` : ""}`;
}

// packages/content-core/src/home-newscast-source.ts
var HOME_NEWSCAST_SHOW_ID = "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5";
var HOME_NEWSCAST_ASSETS_URL = `https://media.services.pbs.org/api/v1/assets/?show-id=${HOME_NEWSCAST_SHOW_ID}&type=full_length&parent-type=episode&available=public&country=US&platform-slug=bento&sort=-premiered_on`;

// packages/content-core/src/home-newscast-data.ts
var HOME_NEWSCAST_LAYOUTS = ["feature", "compact"];
var HOME_NEWSCAST_DEFAULTS = Object.freeze({
  showId: HOME_NEWSCAST_SHOW_ID,
  heading: "Latest newscast",
  summary: "",
  layout: "feature",
  watchLabel: "Watch the latest",
  pastLabel: "Past newscasts",
  liveLabel: "Watch live"
});
function isHomeNewscastData(value, complete) {
  if (!homeSourceObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 7 || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !["showId", "heading", "summary", "layout", "watchLabel", "pastLabel", "liveLabel"].includes(key)) || value.showId !== HOME_NEWSCAST_SHOW_ID || !HOME_NEWSCAST_LAYOUTS.includes(value.layout)) return false;
  return ["heading", "watchLabel", "pastLabel", "liveLabel"].every((key) => typeof value[key] === "string" && value[key].length <= 120 && !/[\u0000-\u001f\u007f]/.test(value[key]) && (!complete || !!value[key].trim())) && typeof value.summary === "string" && value.summary.length <= 2e3 && !/[\u0000-\u001f\u007f]/.test(value.summary);
}

// packages/content-core/src/video-block.ts
var VIDEO_BLOCK_SOURCE_ID = "video-library";
var VIDEO_PUBLIC_PREFIX = `${CMS_MEDIA_ORIGIN}/cms-media/video/`;
var VIDEO_BLOCK_LIMITS = Object.freeze({
  assetId: 200,
  title: 200,
  caption: 600,
  url: 2e3
});
var DATA_FIELDS = /* @__PURE__ */ new Set(["sourceId", "assetId", "title", "caption", "public"]);
var PUBLIC_FIELDS = /* @__PURE__ */ new Set(["url", "posterUrl", "width", "height", "mimeType"]);
function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedString(value, max) {
  return typeof value === "string" && value.length <= max;
}
function isPublicVideoUrl(value, extension) {
  if (!boundedString(value, VIDEO_BLOCK_LIMITS.url)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.href === value && isCmsMediaUrl(url) && /^\/cms-media\/video\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\.(mp4|jpg)$/.test(url.pathname) && url.pathname.endsWith(`.${extension}`);
}
function isPublicVideoData(value) {
  if (!plainObject(value) || !Object.keys(value).every((key) => PUBLIC_FIELDS.has(key))) return false;
  return isPublicVideoUrl(value.url, "mp4") && isPublicVideoUrl(value.posterUrl, "jpg") && Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0 && value.mimeType === "video/mp4";
}
function isVideoBlockData(value, publishable = true) {
  if (!plainObject(value) || !Object.keys(value).every((key) => DATA_FIELDS.has(key))) return false;
  if (value.sourceId !== VIDEO_BLOCK_SOURCE_ID) return false;
  if (!boundedString(value.assetId, VIDEO_BLOCK_LIMITS.assetId)) return false;
  if (!boundedString(value.title, VIDEO_BLOCK_LIMITS.title)) return false;
  if (value.caption !== void 0 && !boundedString(value.caption, VIDEO_BLOCK_LIMITS.caption)) return false;
  if (value.public !== void 0 && !isPublicVideoData(value.public)) return false;
  if (publishable && (!value.assetId.trim() || !value.title.trim())) return false;
  return true;
}

// packages/content-core/src/data-table.ts
var DATA_TABLE_FIELD_LIMITS = Object.freeze({
  title: 250,
  csv: 8e4,
  source: 500,
  sourceHref: 2e3
});
function csvRows(csv, preserveCellText = false) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char !== '"') {
        cell += char;
        continue;
      }
      if (csv[i + 1] === '"') {
        cell += '"';
        i += 1;
        continue;
      }
      quoted = false;
      closedQuote = true;
      continue;
    }
    if (char === '"' && !cell && !closedQuote) {
      quoted = true;
      continue;
    }
    const newline = char === "\n" || preserveCellText && char === "\r";
    if (char !== "," && !newline) {
      if (closedQuote || char === '"') throw new Error("Check the quotation marks in the CSV.");
      cell += char;
      continue;
    }
    row.push(preserveCellText ? cell : cell.trim());
    cell = "";
    closedQuote = false;
    if (row.length > 12) throw new Error("Use at most 12 columns.");
    if (newline) {
      rows.push(row);
      row = [];
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
    }
    if (rows.length > 101) throw new Error("Use at most 100 data rows.");
  }
  if (quoted) throw new Error("Close the quotation marks in the CSV.");
  if (cell || closedQuote || row.length) {
    row.push(preserveCellText ? cell : cell.trim());
    rows.push(row);
  }
  return rows;
}
function parseDataTable(csv) {
  if (csv.length > DATA_TABLE_FIELD_LIMITS.csv) throw new Error("Use at most 80,000 characters of CSV data.");
  const rows = csvRows(csv.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  const headers = rows.shift() ?? [];
  if (!headers.length || headers.some((header) => !header)) throw new Error("Give each column a header in the first row.");
  if (headers.length > 12) throw new Error("Use at most 12 columns.");
  if (!rows.length || rows.length > 100) throw new Error("Add 1\u2013100 data rows after the header row.");
  if (rows.some((row) => row.every((cell) => !cell))) throw new Error("Remove empty data rows.");
  if (rows.some((row) => row.length !== headers.length)) throw new Error("Use the same number of columns in every row.");
  return { headers, rows };
}
function dataTableError(data) {
  if (data.title.length > DATA_TABLE_FIELD_LIMITS.title) return "Use 250 characters or fewer for the table title.";
  if (data.source.length > DATA_TABLE_FIELD_LIMITS.source) return "Use 500 characters or fewer for the source label.";
  if (data.sourceHref.length > DATA_TABLE_FIELD_LIMITS.sourceHref) return "Use 2,000 characters or fewer for the source URL.";
  if (!data.title.trim()) return "Give the data table a title.";
  if (data.sourceHref.trim() && (!data.source.trim() || safeHref(data.sourceHref) === null)) return "Give the source link a label and an approved URL.";
  try {
    parseDataTable(data.csv);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Check the CSV data.";
  }
}
function isDataTableData(data, publishable) {
  if (Object.keys(data).some((key) => !Object.hasOwn(DATA_TABLE_FIELD_LIMITS, key))) return false;
  if (!Object.entries(DATA_TABLE_FIELD_LIMITS).every(([key, limit]) => typeof data[key] === "string" && data[key].length <= limit)) return false;
  return !publishable || dataTableError(data) === null;
}

// packages/content-core/src/document-list.ts
var DOCUMENT_LIST_MAX = 100;
function isNoticeAddedAt(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isDocumentListData(value, complete = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  if (Object.keys(data).some((key) => key !== "documents") || !Array.isArray(data.documents) || data.documents.length > DOCUMENT_LIST_MAX) return false;
  const ids = /* @__PURE__ */ new Set();
  return data.documents.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const item = entry;
    if (Object.keys(item).some((key) => !["itemId", "assetId", "title", "publisher", "addedAt"].includes(key))) return false;
    if (typeof item.itemId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.itemId) || ids.has(item.itemId)) return false;
    ids.add(item.itemId);
    return typeof item.assetId === "string" && (item.assetId === "" && !complete || /^[A-Za-z0-9_-]{1,128}$/.test(item.assetId)) && typeof item.title === "string" && item.title.length <= 300 && (!complete || item.title.trim().length > 0) && (item.publisher === void 0 || item.publisher === "njpba" || item.publisher === "njpbs") && (item.addedAt === void 0 && !complete || isNoticeAddedAt(item.addedAt));
  });
}

// packages/content-core/src/content-model.ts
function isRichTextNode(value) {
  if (typeof value !== "object" || value === null) return false;
  const node = value;
  if (typeof node.type !== "string" || node.type === "bio") return false;
  if (node.attrs !== void 0 && !isRecord2(node.attrs)) return false;
  if (node.text !== void 0 && typeof node.text !== "string") return false;
  if (node.content !== void 0) {
    if (!Array.isArray(node.content)) return false;
    for (const child of node.content) if (!isRichTextNode(child)) return false;
  }
  if (node.marks !== void 0) {
    if (!Array.isArray(node.marks)) return false;
    for (const mark of node.marks) {
      if (typeof mark !== "object" || mark === null) return false;
      const candidate = mark;
      if (typeof candidate.type !== "string" || candidate.attrs !== void 0 && !isRecord2(candidate.attrs)) {
        return false;
      }
      if (candidate.type === "bio") return false;
    }
  }
  return true;
}
function isRichTextDoc(value) {
  return isRichTextNode(value) && value.type === "doc" && Array.isArray(value.content);
}
function publicRichText(node) {
  const attrs = (value, fields2) => Object.fromEntries(fields2.filter((key) => value?.[key] !== void 0).map((key) => [key, structuredClone(value[key])]));
  return {
    type: node.type,
    ...node.text === void 0 ? {} : { text: node.text },
    ...node.type === "heading" && node.attrs?.level !== void 0 ? { attrs: attrs(node.attrs, ["level"]) } : {},
    ...node.content ? { content: node.content.map((child) => publicRichText(child)) } : {},
    ...node.marks ? { marks: node.marks.map((mark) => ({
      type: mark.type,
      ...mark.type === "link" ? { attrs: attrs(mark.attrs, ["href", "allowLegacyHost"]) } : {}
    })) } : {}
  };
}
function richTextIsEmpty(doc) {
  const hasText = (node) => typeof node.text === "string" && node.text.trim().length > 0 || (node.content?.some(hasText) ?? false);
  return !doc.content.some(hasText);
}
var CONTENT_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "archived"
];
var NON_ASSIGNABLE_CONTENT_STATUSES = /* @__PURE__ */ new Set([
  "published",
  "archived"
]);
var ASSIGNABLE_CONTENT_STATUSES = Object.freeze(
  CONTENT_STATUSES.filter(
    (status) => !NON_ASSIGNABLE_CONTENT_STATUSES.has(status)
  )
);
var BLOCK_TYPES = [
  "bio_card",
  "town_lookup",
  "data_table",
  "data_figure",
  "election_results",
  "county_comparison",
  "data_hub_section",
  "row",
  "headline",
  "prose",
  "image",
  "video",
  "image_gallery",
  "cta_row",
  "card_grid",
  "link_card",
  "document_list",
  "faq_item",
  "coverage_list",
  "embed",
  "html",
  "content_shelf",
  "promotion_playlist",
  "newsletter_signup",
  "home_newscast",
  "topic_shelf",
  "video_playlist",
  "record_card",
  "sponsor_strip",
  "divider"
];
var BLOCK_TYPE_SET = new Set(BLOCK_TYPES);
var GALLERY_PRESENTATIONS = ["grid", "carousel"];
var GALLERY_CLICK_BEHAVIOR = "Clicking an image does nothing. Gallery images are not links, and the public site has no lightbox or full-screen viewer.";
var GALLERY_PRESENTATION_SPECS = Object.freeze([
  Object.freeze({
    value: "grid",
    label: "Grid",
    layout: "Every image is visible at once in a grid that wraps to fit the screen: several across on a desktop, one under another on a phone.",
    clickBehavior: GALLERY_CLICK_BEHAVIOR
  }),
  Object.freeze({
    value: "carousel",
    label: "Carousel",
    layout: "The images sit in one row people scroll sideways, the same row the home page uses for programs. It can be scrolled by touch, trackpad, or the arrow keys once it has focus.",
    clickBehavior: GALLERY_CLICK_BEHAVIOR
  })
]);
var GALLERY_PRESENTATION_SET = new Set(GALLERY_PRESENTATIONS);
var LINK_CARD_LIMITS = Object.freeze({
  title: 250,
  source: 120,
  summary: 500,
  url: 2e3
});
var LINK_CARD_DATA_KEY_SET = /* @__PURE__ */ new Set([
  "title",
  "url",
  "source",
  "date",
  "summary"
]);
var COVERAGE_LIST_LIMITS = Object.freeze({
  title: 250,
  outlet: 120,
  url: 2e3,
  entries: 100
});
var COVERAGE_LIST_DATA_KEY_SET = /* @__PURE__ */ new Set(["entries"]);
var COVERAGE_ENTRY_KEY_SET = /* @__PURE__ */ new Set([
  "title",
  "outlet",
  "date",
  "url"
]);
var AP_MAP_HEIGHTS = Object.freeze({ small: 600, medium: 900, large: 1200 });
var AP_MAP_MOBILE_HEIGHT_LIMITS = Object.freeze({ min: 320, max: 4096 });
var EMBED_WIDTH_LIMITS = Object.freeze({ min: 160, max: 4096 });
var EMBED_HEIGHT_LIMITS = Object.freeze({ min: 90, max: 4096 });
var EMBED_ASPECT_RATIO_LIMITS = Object.freeze({ min: 9 / 16, max: 21 / 9 });
var HTML_BLOCK_LIMITS = Object.freeze({ html: 5e4, title: 200 });
var HTML_DATA_KEY_SET = /* @__PURE__ */ new Set(["html", "title"]);
var CONTENT_SHELF_SOURCES = [
  "pbs_featured",
  "pbs_more",
  "spotlight_news",
  "station_posts"
];
var CONTENT_SHELF_ITEM_LIMITS = [3, 4, 6, 8, 12, 16, 24];
var CONTENT_SHELF_PRESENTATIONS = ["rail", "grid", "two_features", "list"];
var PROMOTION_PLAYLIST_PLACEMENTS = [
  "before_start",
  "before_featured",
  "before_passport",
  "before_more",
  "before_spotlight"
];
var SHELF_PRESENTATIONS = ["rail", "grid", "list"];
var SHELF_COLUMNS = [2, 3, 4];
var RECORD_CARD_KINDS = ["program", "event", "sponsor", "newsletter"];
function isRecordCardData(data, publishable = true) {
  if (!isRecord2(data)) return false;
  return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["recordKind", "recordId", "variant"].includes(key)) && RECORD_CARD_KINDS.includes(data.recordKind) && typeof data.recordId === "string" && (!publishable && data.recordId === "" || /^[A-Za-z0-9_-]{1,128}$/.test(data.recordId)) && (data.variant === void 0 || data.variant === "card" || data.variant === "compact");
}
var CONTENT_SHELF_SOURCE_SET = new Set(CONTENT_SHELF_SOURCES);
var CONTENT_SHELF_ITEM_LIMIT_SET = new Set(CONTENT_SHELF_ITEM_LIMITS);
var PROMOTION_PLAYLIST_PLACEMENT_SET = new Set(
  PROMOTION_PLAYLIST_PLACEMENTS
);
var PROMOTION_PLAYLIST_DATA_KEY_SET = /* @__PURE__ */ new Set([
  "title",
  "placement",
  "presentation",
  "columns",
  "cards"
]);
var PROMOTION_PLAYLIST_CARD_KEY_SET = /* @__PURE__ */ new Set([
  "itemId",
  "title",
  "summary",
  "imageAssetId",
  "alt",
  "altDecorative",
  "href"
]);
var SHELF_SORT_SET = new Set(SHELF_SORTS);
var SHELF_ITEM_LIMIT_SET = new Set(SHELF_ITEM_LIMITS);
var TOPIC_SHELF_SOURCE_SET = new Set(TOPIC_SHELF_SOURCES);
var VIDEO_LIBRARY_SET = new Set(VIDEO_LIBRARIES);
var TOPIC_SHELF_DATA_KEY_SET = /* @__PURE__ */ new Set([
  "title",
  "topic",
  "source",
  "itemLimit",
  "sort",
  "pinned"
]);
var VIDEO_PLAYLIST_DATA_KEY_SET = /* @__PURE__ */ new Set([
  "title",
  "topic",
  "library",
  "itemLimit",
  "sort",
  "pinned"
]);
var CONTENT_SHELF_DATA_KEY_SET = /* @__PURE__ */ new Set([
  "title",
  "source",
  "itemLimit",
  "moreLabel",
  "moreHref",
  "presentation",
  "columns",
  "selectedIds",
  "selectionReceipt"
]);
function isRecord2(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isOptionalString(value) {
  return value === void 0 || typeof value === "string";
}
function isOptionalEmbedDimension(value, limits) {
  return value === void 0 || Number.isInteger(value) && Number(value) >= limits.min && Number(value) <= limits.max;
}
function hasValidEmbedAspectRatio(width, height) {
  if (width === void 0 || height === void 0) return true;
  if (typeof width !== "number" || typeof height !== "number") return false;
  const ratio = width / height;
  return ratio >= EMBED_ASPECT_RATIO_LIMITS.min && ratio <= EMBED_ASPECT_RATIO_LIMITS.max;
}
function isOptionalCollectionItemId(value) {
  return value === void 0 || typeof value === "string" && value.trim().length > 0;
}
function isCoverageEntry(value) {
  if (!isRecord2(value)) return false;
  if (!Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && COVERAGE_ENTRY_KEY_SET.has(key)
  )) {
    return false;
  }
  return typeof value.title === "string" && value.title.length <= COVERAGE_LIST_LIMITS.title && typeof value.outlet === "string" && value.outlet.length <= COVERAGE_LIST_LIMITS.outlet && typeof value.date === "string" && (value.date.length === 0 || isCalendarDay(value.date)) && typeof value.url === "string" && value.url.length <= COVERAGE_LIST_LIMITS.url;
}
function isCoverageListData(data) {
  return Reflect.ownKeys(data).every(
    (key) => typeof key === "string" && COVERAGE_LIST_DATA_KEY_SET.has(key)
  ) && Array.isArray(data.entries) && data.entries.length <= COVERAGE_LIST_LIMITS.entries && data.entries.every(isCoverageEntry);
}
function hasUniqueCollectionItemIds(items) {
  const seen = /* @__PURE__ */ new Set();
  for (const item of items) {
    if (!isRecord2(item)) return false;
    const itemId = item.itemId;
    if (itemId === void 0) continue;
    if (typeof itemId !== "string" || itemId.trim().length === 0) return false;
    if (seen.has(itemId)) return false;
    seen.add(itemId);
  }
  return true;
}
function isImageData(value) {
  if (!isRecord2(value)) return false;
  if (!(value.altDecorative === void 0 || typeof value.altDecorative === "boolean")) {
    return false;
  }
  if (value.altDecorative === true && value.alt !== "") return false;
  return isOptionalCollectionItemId(value.itemId) && typeof value.assetId === "string" && typeof value.alt === "string" && isOptionalString(value.caption);
}
function isImageBlockData(value) {
  if (!isImageData(value)) return false;
  const { href, newTab } = value;
  if (!isOptionalString(href) || !(newTab === void 0 || typeof newTab === "boolean")) return false;
  return !(value.altDecorative === true && href !== void 0 && href.trim().length > 0);
}
function isValidShelfPins(value) {
  if (value === void 0) return true;
  if (!Array.isArray(value) || value.length > SHELF_PIN_MAX) return false;
  const seen = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!isRecord2(entry)) return false;
    if (Reflect.ownKeys(entry).some((key) => key !== "id")) return false;
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) return false;
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
  }
  return true;
}
function hasValidShelfQuery(data, keys3) {
  return Reflect.ownKeys(data).every((key) => typeof key === "string" && keys3.has(key)) && typeof data.title === "string" && isShelfTopicId(data.topic) && typeof data.itemLimit === "number" && SHELF_ITEM_LIMIT_SET.has(data.itemLimit) && typeof data.sort === "string" && SHELF_SORT_SET.has(data.sort) && isValidShelfPins(data.pinned);
}
function hasValidPromotionPlaylistCard(card, publishable) {
  if (!isRecord2(card)) return false;
  const decorative = card.altDecorative === true;
  return Reflect.ownKeys(card).every(
    (key) => typeof key === "string" && PROMOTION_PLAYLIST_CARD_KEY_SET.has(key)
  ) && typeof card.itemId === "string" && card.itemId.trim().length > 0 && typeof card.title === "string" && typeof card.summary === "string" && typeof card.imageAssetId === "string" && typeof card.alt === "string" && (card.altDecorative === void 0 || typeof card.altDecorative === "boolean") && (!decorative || card.alt === "") && typeof card.href === "string" && (!publishable || card.title.trim().length > 0 && card.summary.trim().length > 0 && card.imageAssetId.trim().length > 0 && safeHref(card.href) !== null);
}
function hasValidBlockData(type, data, publishable, homeNewsletter = false) {
  switch (type) {
    case "document_list":
      return isDocumentListData(data, publishable);
    case "bio_card":
      return isBioCardData(data, publishable);
    case "data_hub_section":
      return isDataHubSectionData(data);
    case "data_figure":
      return isDataFigureData(data, publishable);
    case "county_comparison":
      return isCountyComparisonData(data);
    case "town_lookup":
      return isTownLookupData(data, publishable);
    case "election_results":
      return isElectionResultsData(data, publishable);
    case "headline":
      return typeof data.text === "string" && (data.level === void 0 || typeof data.level === "number" && Number.isFinite(data.level));
    case "prose":
      return isRichTextDoc(data.content);
    case "image":
      return isImageBlockData(data);
    case "video":
      return isVideoBlockData(data, publishable);
    case "image_gallery":
      return Array.isArray(data.images) && data.images.every(isImageData) && hasUniqueCollectionItemIds(data.images) && (data.presentation === void 0 || typeof data.presentation === "string" && GALLERY_PRESENTATION_SET.has(data.presentation));
    case "cta_row":
      return Array.isArray(data.ctas) && data.ctas.every((cta) => {
        if (!isRecord2(cta)) return false;
        return typeof cta.label === "string" && typeof cta.href === "string" && (cta.variant === void 0 || cta.variant === "primary" || cta.variant === "secondary");
      });
    case "card_grid":
      return Array.isArray(data.cards) && data.cards.every((card) => {
        if (!isRecord2(card)) return false;
        return typeof card.title === "string" && isOptionalCollectionItemId(card.itemId) && isOptionalString(card.label) && (card.body === void 0 || isRichTextDoc(card.body)) && isOptionalString(card.imageAssetId) && isOptionalString(card.href);
      }) && hasUniqueCollectionItemIds(data.cards);
    case "link_card":
      return Reflect.ownKeys(data).every(
        (key) => typeof key === "string" && LINK_CARD_DATA_KEY_SET.has(key)
      ) && typeof data.title === "string" && data.title.length <= LINK_CARD_LIMITS.title && typeof data.url === "string" && data.url.length <= LINK_CARD_LIMITS.url && isOptionalString(data.source) && (typeof data.source !== "string" || data.source.length <= LINK_CARD_LIMITS.source) && isOptionalString(data.date) && (typeof data.date !== "string" || data.date.length === 0 || isCalendarDay(data.date)) && isOptionalString(data.summary) && (typeof data.summary !== "string" || data.summary.length <= LINK_CARD_LIMITS.summary) && (!publishable || data.title.trim().length > 0 && safeHref(data.url) !== null);
    case "faq_item":
      return typeof data.question === "string" && isRichTextDoc(data.answer);
    case "coverage_list":
      return isCoverageListData(data);
    case "data_table":
      return isDataTableData(data, publishable);
    case "embed":
      return typeof data.url === "string" && isOptionalString(data.host) && isOptionalString(data.caption) && isOptionalString(data.heading) && (data.mapSize === void 0 || typeof data.mapSize === "string" && ["small", "medium", "large"].includes(data.mapSize)) && (data.mapWidth === void 0 || typeof data.mapWidth === "string" && ["content", "wide"].includes(data.mapWidth)) && isOptionalEmbedDimension(data.mobileHeight, AP_MAP_MOBILE_HEIGHT_LIMITS) && isOptionalEmbedDimension(data.width, EMBED_WIDTH_LIMITS) && isOptionalEmbedDimension(data.height, EMBED_HEIGHT_LIMITS) && hasValidEmbedAspectRatio(data.width, data.height);
    case "html":
      return Reflect.ownKeys(data).every(
        (key) => typeof key === "string" && HTML_DATA_KEY_SET.has(key)
      ) && typeof data.html === "string" && data.html.length <= HTML_BLOCK_LIMITS.html && (data.title === void 0 || typeof data.title === "string" && data.title.length <= HTML_BLOCK_LIMITS.title) && (!publishable || data.html.trim().length > 0);
    case "content_shelf":
      return Reflect.ownKeys(data).every(
        (key) => typeof key === "string" && CONTENT_SHELF_DATA_KEY_SET.has(key)
      ) && typeof data.title === "string" && typeof data.source === "string" && CONTENT_SHELF_SOURCE_SET.has(data.source) && typeof data.itemLimit === "number" && CONTENT_SHELF_ITEM_LIMIT_SET.has(data.itemLimit) && typeof data.moreLabel === "string" && typeof data.moreHref === "string" && (data.presentation === void 0 || CONTENT_SHELF_PRESENTATIONS.includes(data.presentation)) && (data.columns === void 0 || SHELF_COLUMNS.includes(data.columns)) && (data.selectedIds === void 0 && data.selectionReceipt === void 0 || isHomeSelectedIds(data.selectedIds, Number(data.itemLimit)) && isHomeSelectionReceipt(data.selectionReceipt));
    case "promotion_playlist":
      return Reflect.ownKeys(data).every(
        (key) => typeof key === "string" && PROMOTION_PLAYLIST_DATA_KEY_SET.has(key)
      ) && typeof data.title === "string" && typeof data.placement === "string" && PROMOTION_PLAYLIST_PLACEMENT_SET.has(data.placement) && (data.presentation === void 0 || SHELF_PRESENTATIONS.includes(data.presentation)) && (data.columns === void 0 || SHELF_COLUMNS.includes(data.columns)) && Array.isArray(data.cards) && hasUniqueCollectionItemIds(data.cards) && data.cards.every((card) => hasValidPromotionPlaylistCard(card, publishable)) && (!publishable || data.title.trim().length > 0 && data.cards.length >= 1 && data.cards.length <= 12);
    case "home_newscast":
      return isHomeNewscastData(data, false);
    case "newsletter_signup":
      return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["newsletterIds", "heading", "intro", "actionLabel", "selectionReceipt", "backgroundImageAssetId"].includes(key)) && Array.isArray(data.newsletterIds) && data.newsletterIds.length <= 4 && data.newsletterIds.every((id2) => typeof id2 === "string" && id2.trim().length > 0) && new Set(data.newsletterIds).size === data.newsletterIds.length && (data.heading === void 0 || typeof data.heading === "string") && (data.intro === void 0 || typeof data.intro === "string") && (data.actionLabel === void 0 || typeof data.actionLabel === "string") && (data.selectionReceipt === void 0 || isHomeSelectionReceipt(data.selectionReceipt)) && (!publishable || homeNewsletter || data.newsletterIds.length >= 1);
    case "topic_shelf":
      return hasValidShelfQuery(data, TOPIC_SHELF_DATA_KEY_SET) && typeof data.source === "string" && TOPIC_SHELF_SOURCE_SET.has(data.source);
    case "video_playlist":
      return hasValidShelfQuery(data, VIDEO_PLAYLIST_DATA_KEY_SET) && typeof data.library === "string" && VIDEO_LIBRARY_SET.has(data.library);
    case "record_card":
      return isRecordCardData(data, publishable);
    case "sponsor_strip":
      return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["heading", "sponsorIds", "layout"].includes(key)) && (data.heading === void 0 || typeof data.heading === "string" && data.heading.length <= 120) && (data.layout === "row" || data.layout === "grid") && Array.isArray(data.sponsorIds) && data.sponsorIds.length >= (publishable ? 1 : 0) && data.sponsorIds.length <= 12 && data.sponsorIds.every((id2) => typeof id2 === "string" && id2.trim().length > 0) && new Set(data.sponsorIds).size === data.sponsorIds.length;
    case "row":
      return isRowData(data);
    case "divider":
      return Reflect.ownKeys(data).length === 0;
  }
}
function parseBlocks(input, { complete = true, pageId } = {}) {
  if (!Array.isArray(input)) {
    return { ok: false, error: "blocks must be an array" };
  }
  const seenIds = /* @__PURE__ */ new Set();
  for (let i = 0; i < input.length; i++) {
    const entry = input[i];
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `blocks[${i}] is not an object` };
    }
    const block = entry;
    if (typeof block.type !== "string" || !BLOCK_TYPE_SET.has(block.type)) {
      return { ok: false, error: `blocks[${i}] has unknown type ${String(block.type)}` };
    }
    if (typeof block.id !== "string" || block.id.length === 0) {
      return { ok: false, error: `blocks[${i}] is missing a string id` };
    }
    if (seenIds.has(block.id)) {
      return { ok: false, error: `blocks[${i}] repeats id ${block.id}` };
    }
    seenIds.add(block.id);
    if (typeof block.order !== "number" || !Number.isFinite(block.order)) {
      return { ok: false, error: `blocks[${i}] is missing a numeric order` };
    }
    if (typeof block.visible !== "boolean") {
      return { ok: false, error: `blocks[${i}] is missing a boolean visible flag` };
    }
    if (block.section !== void 0 && typeof block.section !== "string") {
      return { ok: false, error: `blocks[${i}] has a non-string section` };
    }
    if (!isRecord2(block.data)) {
      return { ok: false, error: `blocks[${i}] is missing a data object` };
    }
    if (Object.hasOwn(block.data, "backgroundImageAssetId")) {
      const band = block.section === "home-newsletter" && block.type === "newsletter_signup" || block.section === "home-passport-copy" && block.type === "prose" || block.section === "home-donor" && block.type === "card_grid";
      if (!band || pageId !== void 0 && pageId !== "home" || typeof block.data.backgroundImageAssetId !== "string" || !/^[A-Za-z0-9_-]{0,128}$/.test(block.data.backgroundImageAssetId)) {
        return { ok: false, error: "Home band background requires a media asset id on its named Home section." };
      }
    }
    if (block.section === "home-newsletter" && pageId !== void 0 && pageId !== "home") {
      return { ok: false, error: "The Home Newsletter bar belongs only on Home." };
    }
    if (block.type === "home_newscast" && block.section !== "home-newscast") {
      return { ok: false, error: "Newscast requires its named Home section." };
    }
    if (block.type === "newsletter_signup" && block.section !== "home-newsletter" && (block.data.actionLabel !== void 0 || block.data.selectionReceipt !== void 0)) {
      return { ok: false, error: "Home Newsletter fields require the named Home bar." };
    }
    if (!hasValidBlockData(block.type, block.data, block.type === "data_table" ? false : complete && block.visible, block.section === "home-newsletter")) {
      return { ok: false, error: `blocks[${i}] has invalid data for ${block.type}` };
    }
  }
  if (pageId === "kids" && input.some((block) => block.type === "record_card" && block.data.recordKind === "newsletter")) {
    return { ok: false, error: "Newsletter record cards are not allowed on the Kids page" };
  }
  const hubError = dataHubCompositionError(input, pageId);
  if (hubError) return { ok: false, error: hubError };
  const layoutError = contentLayoutError(input);
  if (layoutError) return { ok: false, error: layoutError };
  for (const block of visibleLayoutBlocks(input)) {
    if (complete && block.type === "data_table" && !isDataTableData({ ...block.data }, true)) {
      return { ok: false, error: `blocks[${input.findIndex((entry) => entry.id === block.id)}] has invalid data for data_table` };
    }
  }
  return { ok: true, blocks: input };
}

// packages/content-core/src/player-permissions.ts
var PLAYER_PERMISSIONS = {
  livestream: "geolocation; encrypted-media",
  "on-demand": "encrypted-media"
};
function pbsPlayerPermissions(kind) {
  return PLAYER_PERMISSIONS[kind];
}

// packages/content-core/src/embed-player.ts
var YOUTUBE_HOSTS = /* @__PURE__ */ new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtube-nocookie.com"]);
var YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
var YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
function youtubePlayerSrc(url) {
  const parsed = pastedPlayerUrl(url);
  if (!parsed || !YOUTUBE_HOSTS.has(parsed.hostname)) return null;
  const [first = "", second = "", third = ""] = parsed.pathname.split("/").filter(Boolean);
  const channel = first === "channel" && third === "live" ? second : first === "embed" && second === "live_stream" ? parsed.searchParams.get("channel") ?? "" : "";
  if (YOUTUBE_CHANNEL_ID.test(channel)) {
    return `https://www.youtube.com/embed/live_stream?channel=${channel}`;
  }
  const id2 = parsed.hostname === "youtu.be" ? first : first === "watch" ? parsed.searchParams.get("v") ?? "" : ["live", "embed", "shorts"].includes(first) ? second : "";
  if (!YOUTUBE_VIDEO_ID.test(id2)) return null;
  const start = youtubeStartSeconds(parsed.searchParams.get("start") ?? parsed.searchParams.get("t"));
  return `https://www.youtube-nocookie.com/embed/${id2}${start > 0 ? `?start=${start}` : ""}`;
}
function pastedPlayerUrl(url) {
  const pasted = (/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(url)?.[1] ?? url).trim().replaceAll("&amp;", "&");
  const link = /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(pasted) ? `https://${pasted}` : pasted.startsWith("//") ? `https:${pasted}` : pasted;
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  return parsed;
}
function facebookVideoUrl(url) {
  if (!["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"].includes(url.hostname)) return null;
  const reel = /^\/reel\/(\d{1,25})\/?$/.exec(url.pathname);
  if (reel) return `https://www.facebook.com/reel/${reel[1]}/`;
  const path = /^\/([A-Za-z0-9._-]+)\/videos\/(?:[A-Za-z0-9_-]+\/)?(\d{1,25})\/?$/.exec(url.pathname);
  if (path) return `https://www.facebook.com/${path[1]}/videos/${path[2]}/`;
  const id2 = url.searchParams.get("v") ?? "";
  if (/^\/(?:watch\/?|video\.php)$/.test(url.pathname) && /^\d{1,25}$/.test(id2)) {
    return `https://www.facebook.com/watch/?v=${id2}`;
  }
  return null;
}
function embedPlayer(value, allowAutoplay = true) {
  const url = pastedPlayerUrl(value);
  if (!url) return null;
  const youtube = youtubePlayerSrc(value);
  if (youtube) return { src: youtube, title: "YouTube video player", allow: "autoplay; encrypted-media; picture-in-picture; web-share" };
  switch (url.hostname) {
    case "vimeo.com":
    case "www.vimeo.com":
    case "player.vimeo.com": {
      const path = url.hostname === "player.vimeo.com" ? /^\/video\/(\d{1,12})\/?$/ : /^\/(?:channels\/[A-Za-z0-9_-]+\/|groups\/[A-Za-z0-9_-]+\/videos\/)?(\d{1,12})(?:\/([0-9a-f]{6,64}))?\/?$/i;
      const match = path.exec(url.pathname);
      if (!match) return null;
      const hash = match[2] ?? url.searchParams.get("h");
      if (hash !== null && !/^[0-9a-f]{6,64}$/i.test(hash)) return null;
      const query = hash ? `h=${hash}&dnt=1` : "dnt=1";
      return { src: `https://player.vimeo.com/video/${match[1]}?${query}`, title: "Vimeo video player", allow: "autoplay; fullscreen; picture-in-picture; encrypted-media" };
    }
    case "tiktok.com":
    case "www.tiktok.com": {
      const id2 = /^\/(?:@[A-Za-z0-9._-]+\/video|embed\/v2|player\/v1)\/(\d{10,25})\/?$/.exec(url.pathname)?.[1];
      return id2 ? { src: `https://www.tiktok.com/embed/v2/${id2}`, title: "TikTok video player", allow: "autoplay; fullscreen; picture-in-picture", vertical: true } : null;
    }
    case "instagram.com":
    case "www.instagram.com": {
      const path = /^\/(p|reel)\/([A-Za-z0-9_-]{5,64})(?:\/embed)?\/?$/.exec(url.pathname);
      return path ? { src: `https://www.instagram.com/${path[1]}/${path[2]}/embed`, title: "Instagram video player", allow: "autoplay; fullscreen", vertical: path[1] === "reel" } : null;
    }
    case "facebook.com":
    case "www.facebook.com":
    case "m.facebook.com":
    case "web.facebook.com": {
      const inner = url.pathname === "/plugins/video.php" ? pastedPlayerUrl(url.searchParams.get("href") ?? "") : url;
      const video = inner ? facebookVideoUrl(inner) : null;
      return video ? { src: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(video)}`, title: "Facebook video player", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", vertical: video.startsWith("https://www.facebook.com/reel/") } : null;
    }
    case "player.pbs.org": {
      let src = extractPartnerPlayerSrc(value);
      if (src && !allowAutoplay) {
        const url2 = new URL(src);
        url2.searchParams.delete("autoplay");
        src = url2.href;
      }
      return src ? { src, title: "PBS video player", allow: pbsPlayerPermissions("on-demand") } : null;
    }
    default:
      return null;
  }
}
function xVideoLink(value) {
  const url = pastedPlayerUrl(value);
  if (!url || !["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(url.hostname)) return null;
  const path = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/video\/\d+)?\/?$/.exec(url.pathname);
  return path ? `https://x.com/${path[1]}/status/${path[2]}` : null;
}
function youtubeStartSeconds(value) {
  const match = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/.exec(value ?? "");
  if (!match) return 0;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total <= 86400 ? total : 0;
}

// packages/content-core/src/post-lead-media.ts
var object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var text3 = (value, max) => typeof value === "string" && value.length <= max;
var assetId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
var keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
function isPostLeadMedia(value, complete = true) {
  if (!object(value) || !object(value.data) || !keys(value, ["kind", "data", "posterAssetId"])) return false;
  const data = value.data;
  if (value.kind === "image") {
    return value.posterAssetId === void 0 && keys(data, ["assetId", "alt", "altDecorative", "caption"]) && isImageData(data) && (data.assetId === "" && !complete || assetId(data.assetId)) && text3(data.alt, 2e3) && (data.caption === void 0 || text3(data.caption, 600)) && (!complete || data.altDecorative === true || data.alt.trim().length > 0);
  }
  if (value.posterAssetId !== void 0 && value.posterAssetId !== "" && !assetId(value.posterAssetId)) return false;
  if (value.kind === "library-video") {
    return isVideoBlockData(data, false) && (data.assetId === "" && !complete || assetId(data.assetId)) && (!complete || Boolean(data.title.trim() || data.caption?.trim()));
  }
  if (value.kind !== "embed" && value.kind !== "linked-video") return false;
  if (!keys(data, ["url", "host", "caption", "title", "width", "height"]) || !text3(data.title, 200) || !text3(data.url, 4e3) || data.caption !== void 0 && !text3(data.caption, 600) || data.host !== void 0 && !text3(data.host, 200)) return false;
  const { title: _title, ...embed } = data;
  if (!parseBlocks([{ id: "lead", type: "embed", order: 0, visible: true, data: embed }], { complete: false }).ok) return false;
  if (complete && !(data.title.trim() || data.caption?.trim())) return false;
  if (!complete && data.url === "") return true;
  if (embedPlayer(data.url) || xVideoLink(data.url)) return true;
  if (value.kind === "embed" || safeHref(data.url) !== data.url) return false;
  try {
    const url = new URL(data.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}
function leadMediaAssetIds(value) {
  if (!isPostLeadMedia(value, false)) return [];
  return value.kind === "image" ? value.data.assetId ? [value.data.assetId] : [] : value.posterAssetId ? [value.posterAssetId] : [];
}
function leadVideoBlocks(value) {
  return isPostLeadMedia(value, false) && value.kind === "library-video" ? [{ id: "post-lead-video", type: "video", order: -1, visible: true, data: value.data }] : [];
}
function withoutPublicLeadVideo(value) {
  if (!object(value) || value.kind !== "library-video" || !object(value.data)) return value;
  const { public: _ignored, ...data } = value.data;
  return { ...value, data };
}

// packages/content-core/src/author-profiles.ts
var AUTHOR_ID_PREFIX = "au_";
var AUTHOR_ID_ENTROPY_CHARS = 32;
var AUTHOR_ID_PATTERN = new RegExp(
  `^${AUTHOR_ID_PREFIX}[0-9a-f]{${AUTHOR_ID_ENTROPY_CHARS}}$`
);
function isAuthorId(value) {
  return typeof value === "string" && AUTHOR_ID_PATTERN.test(value);
}
var AUTHOR_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

// packages/content-core/src/story-credits.ts
var STORY_CREDITS_MAX = 12;
var STORY_CREDIT_NAME_MAX = 120;
var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
function sanitizeCreditText(value) {
  return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
}
function normalizeCustomCreditName(value) {
  if (typeof value !== "string") return "";
  return sanitizeCreditText(value).slice(0, STORY_CREDIT_NAME_MAX);
}
function normalizeOne(raw, index, errors) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push(`Credit ${index + 1} is not a credit`);
    return null;
  }
  const value = raw;
  const kind = value.kind;
  if (kind === "registered") {
    if (!isAuthorId(value.authorId)) {
      errors.push(`Credit ${index + 1} names an author we do not recognize`);
      return null;
    }
    return { kind: "registered", authorId: value.authorId };
  }
  if (kind === "custom") {
    const name = normalizeCustomCreditName(value.name);
    if (name.length === 0) {
      return null;
    }
    return { kind: "custom", name };
  }
  errors.push(`Credit ${index + 1} is not a registered or custom byline`);
  return null;
}
function normalizeStoryCredits(value) {
  if (value === void 0 || value === null) {
    return { ok: true, credits: [], errors: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, credits: [], errors: ["Bylines must be a list"] };
  }
  const errors = [];
  if (value.length > STORY_CREDITS_MAX) {
    return {
      ok: false,
      credits: [],
      errors: [`A story can carry at most ${STORY_CREDITS_MAX} bylines`]
    };
  }
  const credits = [];
  const seenAuthorIds = /* @__PURE__ */ new Set();
  value.forEach((raw, index) => {
    const credit = normalizeOne(raw, index, errors);
    if (!credit) return;
    if (credit.kind === "registered") {
      if (seenAuthorIds.has(credit.authorId)) return;
      seenAuthorIds.add(credit.authorId);
    }
    credits.push(credit);
  });
  return { ok: errors.length === 0, credits: errors.length === 0 ? credits : [], errors };
}

// packages/content-core/src/live-blog.ts
var LIVE_BLOG_CONTRACT_VERSION = 3;
var LIVE_BLOG_MAX_UPDATES = 200;
var LIVE_BLOG_MAX_FOLLOW_UPS = 20;
var LIVE_BLOG_FOLLOW_UP_MAX_CHARACTERS = 1e3;
var LIVE_BLOG_MAX_MEDIA = 100;
var LIVE_BLOG_BRANDING = "nj-decides-2026";
var LIVE_BLOG_MAX_BYTES = 256 * 1024;
var LIVE_BLOG_COVERAGE_STATES = ["ongoing", "paused", "ended"];
function isLiveBlogPresentation(value) {
  return record3(value) && keys2(value, ["reporterPhotos", "reporterCards", "playful"]) && Object.values(value).every((field) => typeof field === "boolean");
}
function record3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys2(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text4(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function isLiveBlogId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}
function frozenCredits(value, complete) {
  if (!Array.isArray(value) || complete && value.length === 0 || value.length > STORY_CREDITS_MAX) return false;
  const authors = /* @__PURE__ */ new Set();
  return value.every((credit) => {
    if (!record3(credit)) return false;
    const name = credit.kind === "custom" ? credit.name : credit.displayName;
    if (!text4(name, 120) || normalizeCustomCreditName(name) !== name) return false;
    if (credit.kind === "custom") return keys2(credit, ["kind", "name"]);
    if (credit.kind !== "registered" || !isAuthorId(credit.authorId) || !keys2(credit, ["kind", "authorId", "displayName", "slug"]) || credit.slug !== void 0 && typeof credit.slug !== "string" || authors.has(credit.authorId)) return false;
    authors.add(credit.authorId);
    return true;
  });
}
function assertLiveBlogData(value, { complete = true } = {}) {
  if (!record3(value) || !keys2(value, ["schemaVersion", "branding", "presentation", "coverageState", "updatedAt", "updates"]) || value.schemaVersion !== 1 || value.branding !== void 0 && value.branding !== LIVE_BLOG_BRANDING || value.presentation !== void 0 && !isLiveBlogPresentation(value.presentation) || !LIVE_BLOG_COVERAGE_STATES.includes(value.coverageState) || typeof value.updatedAt !== "string" || parsePublishInstant(value.updatedAt) === null || !Array.isArray(value.updates) || value.updates.length > LIVE_BLOG_MAX_UPDATES) {
    throw new Error("Invalid live blog snapshot.");
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > LIVE_BLOG_MAX_BYTES) throw new Error();
  } catch {
    throw new Error("Live blog snapshot exceeds the JSON size limit or is not serializable.");
  }
  let mediaCount = 0;
  const seen = /* @__PURE__ */ new Set();
  const changedAt = parsePublishInstant(value.updatedAt);
  for (const entry of value.updates) {
    if (!record3(entry) || !keys2(entry, ["id", "headline", "body", "credits", "publishedAt", "updatedAt", "keyUpdate", "correction", "withdrawal", "media", "followUps"]) || !isLiveBlogId(entry.id) || seen.has(entry.id) || typeof entry.headline !== "string" || entry.headline.length > 240 || complete && !entry.headline.trim() || !isRichTextDoc(entry.body) || complete && entry.withdrawal === void 0 && richTextIsEmpty(entry.body) || entry.media !== void 0 && (!isPostLeadMedia(entry.media, complete) || ++mediaCount > LIVE_BLOG_MAX_MEDIA) || !frozenCredits(entry.credits, complete) || typeof entry.keyUpdate !== "boolean" || typeof entry.publishedAt !== "string" || typeof entry.updatedAt !== "string" || entry.correction !== void 0 && !text4(entry.correction, 1e3) || entry.withdrawal !== void 0 && (!text4(entry.withdrawal, 1e3) || entry.headline !== "Update withdrawn" || entry.body.content.length !== 0 || entry.keyUpdate !== false || entry.media !== void 0 || entry.followUps !== void 0)) {
      throw new Error("Invalid live blog update or duplicate update id.");
    }
    const publishedAt = parsePublishInstant(entry.publishedAt);
    const updatedAt = parsePublishInstant(entry.updatedAt);
    if (publishedAt === null || updatedAt === null || updatedAt < publishedAt || updatedAt > changedAt || complete && (entry.correction !== void 0 || entry.withdrawal !== void 0) && updatedAt === publishedAt) {
      throw new Error("Live blog update dates must be real UTC instants in publication order.");
    }
    assertLiveBlogFollowUps(entry.followUps, entry.publishedAt, entry.updatedAt, complete);
    seen.add(entry.id);
  }
}
function publicLiveBlogData(value, asOf) {
  return projectLiveBlogData(value, asOf, true);
}
function previewLiveBlogData(value, asOf) {
  return projectLiveBlogData(value, asOf, false);
}
function projectLiveBlogData(value, asOf, complete) {
  value = record3(value) && Array.isArray(value.updates) ? { ...value, updates: value.updates.map((entry) => {
    if (!record3(entry) || entry.withdrawal === void 0) return entry;
    const { followUps: _auditThread, ...tombstone } = entry;
    return tombstone;
  }) } : value;
  assertLiveBlogData(value, { complete });
  const cutoff = parsePublishInstant(asOf);
  if (cutoff === null || parsePublishInstant(value.updatedAt) > cutoff) {
    throw new Error("Live blog revision is newer than its enclosing published snapshot.");
  }
  return { ...structuredClone(value), updates: value.updates.map((entry) => ({
    ...structuredClone(entry),
    body: publicRichText(entry.body),
    ...entry.followUps === void 0 ? {} : { followUps: entry.followUps.map((followUp) => ({
      ...structuredClone(followUp),
      body: publicRichText(followUp.body)
    })) }
  })) };
}
function liveBlogMediaAssetIds(value) {
  if (!record3(value) || !Array.isArray(value.updates)) return [];
  return value.updates.flatMap((entry) => record3(entry) && entry.withdrawal === void 0 ? leadMediaAssetIds(entry.media) : []);
}
function liveBlogVideoBlocks(value) {
  if (!record3(value) || !Array.isArray(value.updates)) return [];
  return value.updates.flatMap((entry, index) => record3(entry) && entry.withdrawal === void 0 ? leadVideoBlocks(entry.media).map((block) => ({ ...block, id: `live-blog-video-${index}`, order: index })) : []);
}
function isLiveBlogFollowUpBody(value, complete = true) {
  if (!isRichTextDoc(value) || value.text !== void 0 || value.marks?.length) return false;
  let characters = 0;
  if (!value.content.every((paragraph) => paragraph.type === "paragraph" && paragraph.text === void 0 && !paragraph.marks?.length && (paragraph.content ?? []).every((node) => {
    if (node.type !== "text" || typeof node.text !== "string" || node.content !== void 0 || node.marks?.some((mark) => !["bold", "italic", "link"].includes(mark.type))) return false;
    characters += Array.from(node.text).length;
    return true;
  }))) return false;
  return characters <= LIVE_BLOG_FOLLOW_UP_MAX_CHARACTERS && (!complete || !richTextIsEmpty(value));
}
function assertLiveBlogFollowUps(value, parentPublishedAt, parentUpdatedAt, complete) {
  if (value === void 0) return;
  if (!Array.isArray(value) || value.length > LIVE_BLOG_MAX_FOLLOW_UPS) throw new Error("Invalid live blog follow-ups.");
  const ids = /* @__PURE__ */ new Set();
  let oldest = parsePublishInstant(parentPublishedAt);
  for (const item of value) {
    if (!record3(item) || !keys2(item, ["id", "body", "credits", "publishedAt", "updatedAt", "correction", "withdrawal"]) || !isLiveBlogId(item.id) || ids.has(item.id) || !frozenCredits(item.credits, complete) || !isLiveBlogFollowUpBody(item.body, complete && item.withdrawal === void 0) || item.correction !== void 0 && !text4(item.correction, 1e3) || item.withdrawal !== void 0 && (!text4(item.withdrawal, 1e3) || item.body.content.length !== 0)) {
      throw new Error("Invalid live blog follow-up.");
    }
    const published = parsePublishInstant(typeof item.publishedAt === "string" ? item.publishedAt : ""), updated = parsePublishInstant(typeof item.updatedAt === "string" ? item.updatedAt : "");
    if (published === null || updated === null || published < oldest || updated < published || updated > parsePublishInstant(parentUpdatedAt) || complete && (item.correction !== void 0 || item.withdrawal !== void 0) && updated === published) {
      throw new Error("Invalid live blog follow-up dates or order.");
    }
    oldest = published;
    ids.add(item.id);
  }
}

// packages/content-core/src/live-blog-draft.ts
var LiveBlogDraftError = class extends Error {
};
var LIVE_BLOG_MAX_REGISTERED_AUTHORS = 64;
function object2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function only(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function budget(value) {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > LIVE_BLOG_MAX_BYTES) throw new LiveBlogDraftError();
  } catch {
    throw new LiveBlogDraftError("Live blog exceeds its JSON size limit or is not serializable.");
  }
}
function parseLiveBlogDraft(value, { complete = false } = {}) {
  budget(value);
  if (!object2(value) || !only(value, ["schemaVersion", "branding", "presentation", "coverageState", "updates"]) || value.schemaVersion !== 1 || value.branding !== void 0 && value.branding !== LIVE_BLOG_BRANDING || !LIVE_BLOG_COVERAGE_STATES.includes(value.coverageState) || value.presentation !== void 0 && !isLiveBlogPresentation(value.presentation) || !Array.isArray(value.updates) || value.updates.length > LIVE_BLOG_MAX_UPDATES) {
    throw new LiveBlogDraftError("Check the live blog presentation, coverage state and entries.");
  }
  let mediaCount = 0;
  const ids = /* @__PURE__ */ new Set();
  const authors = /* @__PURE__ */ new Set();
  const updates = value.updates.map((raw) => {
    if (!object2(raw) || !only(raw, ["id", "headline", "body", "credits", "keyUpdate", "correction", "withdrawal", "media", "followUps"]) || typeof raw.id !== "string" || raw.id !== "" && (!isLiveBlogId(raw.id) || ids.has(raw.id)) || typeof raw.headline !== "string" || raw.headline.length > 240 || !isRichTextDoc(raw.body) || typeof raw.keyUpdate !== "boolean") {
      throw new LiveBlogDraftError("Check the live blog entry id, headline and rich text.");
    }
    const media = raw.media == null ? void 0 : withoutPublicLeadVideo(raw.media);
    if (media !== void 0 && (!isPostLeadMedia(media, complete && raw.withdrawal === void 0) || raw.withdrawal === void 0 && ++mediaCount > LIVE_BLOG_MAX_MEDIA)) {
      throw new LiveBlogDraftError("Check entry media selections, alt text and video titles; at most 100 entries may have media.");
    }
    if (raw.id) ids.add(raw.id);
    for (const field of ["correction", "withdrawal"]) {
      if (raw[field] !== void 0 && (typeof raw[field] !== "string" || !raw[field].trim() || raw[field].length > 1e3)) {
        throw new LiveBlogDraftError("A correction or withdrawal needs a visible explanation of at most 1,000 characters.");
      }
    }
    const normalized = normalizeStoryCredits(raw.credits);
    if (!normalized.ok) throw new LiveBlogDraftError(normalized.errors[0]);
    for (const credit of normalized.credits) if (credit.kind === "registered") authors.add(credit.authorId);
    if (authors.size > LIVE_BLOG_MAX_REGISTERED_AUTHORS) {
      throw new LiveBlogDraftError(`A live blog may credit at most ${LIVE_BLOG_MAX_REGISTERED_AUTHORS} distinct registered authors. Use custom credits for other contributors.`);
    }
    if (complete && raw.withdrawal === void 0 && (!raw.headline.trim() || richTextIsEmpty(raw.body) || !normalized.credits.length)) {
      throw new LiveBlogDraftError("Each published entry needs a headline, readable body and byline.");
    }
    const followUps = parseFollowUps(raw.followUps, complete && raw.withdrawal === void 0, authors);
    return {
      ...followUps === void 0 ? {} : { followUps },
      id: raw.id,
      headline: raw.headline,
      body: structuredClone(raw.body),
      credits: normalized.credits,
      keyUpdate: raw.keyUpdate,
      ...media === void 0 ? {} : { media: structuredClone(media) },
      ...raw.correction === void 0 ? {} : { correction: raw.correction },
      ...raw.withdrawal === void 0 ? {} : { withdrawal: raw.withdrawal }
    };
  });
  return { schemaVersion: 1, ...value.branding === void 0 ? {} : { branding: LIVE_BLOG_BRANDING }, ...value.presentation === void 0 ? {} : { presentation: { ...value.presentation } }, coverageState: value.coverageState, updates };
}
function assertLiveBlogRetainsPublished(draft, published) {
  if (!published) return;
  assertLiveBlogData(published);
  if (!draft && published.updates.length === 0) return;
  if (!draft) throw new LiveBlogDraftError("A published live blog must be retained. Withdraw entries with a visible explanation instead.");
  for (const entry of published.updates) {
    const next = draft.updates.find((item) => item.id === entry.id);
    if (!next) throw new LiveBlogDraftError("Published entries cannot be removed. Withdraw the entry with a visible explanation instead.");
    for (const followUp of entry.followUps ?? []) {
      const retained = next.followUps?.find((item) => item.id === followUp.id);
      if (!retained) throw new LiveBlogDraftError("Published follow-ups cannot be removed. Withdraw the follow-up instead.");
      if (followUp.withdrawal !== void 0 && retained.withdrawal === void 0) throw new LiveBlogDraftError("A withdrawn follow-up cannot be restored.");
    }
    if (entry.withdrawal !== void 0 && next.withdrawal === void 0) {
      throw new LiveBlogDraftError("A withdrawn entry cannot be restored to reporting. Add a new entry instead.");
    }
  }
}
function prepareLiveBlogDraft(value, options) {
  const draft = parseLiveBlogDraft(value);
  assertLiveBlogFollowUpsEditable(draft, options.previous, options.published);
  const known = new Set([...options.previous?.updates ?? [], ...options.published?.updates ?? []].map((entry) => entry.id));
  const assigned = new Set(known);
  for (const entry of draft.updates) {
    if (!entry.id || entry.id.startsWith("tmp-")) {
      const id2 = options.mintId();
      if (!isLiveBlogId(id2) || id2.startsWith("tmp-") || assigned.has(id2)) throw new LiveBlogDraftError("Could not create a unique live blog entry id.");
      entry.id = id2;
      assigned.add(id2);
    } else if (!known.has(entry.id)) {
      throw new LiveBlogDraftError("New live blog entries need a server-generated id. Reload before saving.");
    }
  }
  for (const entry of draft.updates) {
    const known2 = new Set([
      ...options.previous?.updates.find((old) => old.id === entry.id)?.followUps ?? [],
      ...options.published?.updates.find((old) => old.id === entry.id)?.followUps ?? []
    ].map((item) => item.id));
    const assigned2 = new Set(known2);
    for (const item of entry.followUps ?? []) {
      if (!item.id || item.id.startsWith("tmp-")) {
        const id2 = options.mintId();
        if (!isLiveBlogId(id2) || id2.startsWith("tmp-") || assigned2.has(id2)) throw new LiveBlogDraftError("Could not create a unique follow-up id.");
        item.id = id2;
        assigned2.add(id2);
      } else if (!known2.has(item.id)) throw new LiveBlogDraftError("New follow-ups need a server-generated id. Reload before saving.");
    }
  }
  assertLiveBlogRetainsPublished(draft, options.published);
  budget(draft);
  return draft;
}
function authored(entry) {
  return homeCatalogJson({
    headline: entry.headline,
    body: entry.body,
    media: entry.media === void 0 ? null : withoutPublicLeadVideo(entry.media),
    credits: normalizeStoryCredits(entry.credits).credits,
    keyUpdate: entry.keyUpdate,
    correction: entry.correction ?? null,
    withdrawal: entry.withdrawal ?? null
  });
}
function entryForPublication(entry, previous) {
  if (entry.withdrawal === void 0) return entry;
  const { media: _media, followUps: _followUps, ...tombstone } = entry;
  return {
    ...tombstone,
    headline: "Update withdrawn",
    body: { type: "doc", content: [] },
    keyUpdate: false,
    ...previous ? { credits: previous.credits } : {}
  };
}
function assertLiveBlogReady(value, previous) {
  const draft = parseLiveBlogDraft(value);
  assertLiveBlogRetainsPublished(draft, previous);
  for (const entry of draft.updates) {
    if (!entry.id || entry.id.startsWith("tmp-")) throw new LiveBlogDraftError("Save live blog entries before publication.");
    if (entry.followUps?.some((item) => !item.id || item.id.startsWith("tmp-"))) throw new LiveBlogDraftError("Save follow-ups before publication.");
  }
  parseLiveBlogDraft(draft, { complete: true });
  for (const entry of draft.updates) {
    const before = previous?.updates.find((item) => item.id === entry.id);
    if (entry.withdrawal === void 0) assertFollowUpsReady(entry.followUps, before?.followUps);
    if (before && authored(entryForPublication(entry, before)) === authored(before)) continue;
    if (before && !entry.withdrawal && (!entry.correction || entry.correction === before.correction)) {
      throw new LiveBlogDraftError("An edited published entry needs a new visible correction explanation.");
    }
    if (!before && (entry.correction || entry.withdrawal)) throw new LiveBlogDraftError("Only a previously published entry can be corrected or withdrawn.");
  }
  return draft;
}
function freezeLiveBlogData(value, options) {
  const draft = options.preview ? parseLiveBlogDraft(value) : assertLiveBlogReady(value, options.previous);
  if (options.preview) {
    assertLiveBlogRetainsPublished(draft, options.previous);
    if (draft.updates.some((entry) => !entry.id || entry.id.startsWith("tmp-") || entry.followUps?.some((item) => !item.id || item.id.startsWith("tmp-")))) throw new LiveBlogDraftError("Save live blog entries before previewing.");
  }
  const instant = parsePublishInstant(options.at);
  if (instant === null || options.previous && instant < parsePublishInstant(options.previous.updatedAt)) throw new LiveBlogDraftError("Invalid live blog publication time.");
  let changed = !options.previous || options.previous.coverageState !== draft.coverageState || options.previous.branding !== draft.branding || homeCatalogJson(options.previous.presentation ?? null) !== homeCatalogJson(draft.presentation ?? null);
  const updates = draft.updates.map((entry) => {
    const previous = options.previous?.updates.find((item) => item.id === entry.id);
    const publicEntry = entryForPublication(entry, previous);
    const followUps = entry.withdrawal === void 0 ? freezeFollowUps(entry.followUps, previous?.followUps, options) : void 0;
    if (options.previous && homeCatalogJson(followUps ?? []) !== homeCatalogJson(previous?.followUps ?? []) && instant <= parsePublishInstant(options.previous.updatedAt)) throw new LiveBlogDraftError("A follow-up change needs a later blog publication time.");
    const ownSame = previous && authored(publicEntry) === authored(previous);
    const same = ownSame && homeCatalogJson(followUps ?? []) === homeCatalogJson(previous.followUps ?? []);
    if (same) return structuredClone(previous);
    if (previous && instant <= parsePublishInstant(previous.updatedAt)) throw new LiveBlogDraftError("An entry revision needs a later publication time.");
    changed = true;
    const creditsWithFallback = entry.credits.map((credit) => credit.kind !== "registered" ? credit : {
      ...previous?.credits.find((old) => old.kind === "registered" && old.authorId === credit.authorId),
      ...credit
    });
    const credits = (ownSame || entry.withdrawal) && previous ? previous.credits : options.freezeCredits(creditsWithFallback);
    if (JSON.stringify(normalizeStoryCredits(credits).credits) !== JSON.stringify(entry.withdrawal && previous ? normalizeStoryCredits(previous.credits).credits : entry.credits)) {
      throw new LiveBlogDraftError("Every entry byline needs a resolved author name. Repair the byline before publication.");
    }
    const { followUps: _draftFollowUps, ...publicReporting } = publicEntry;
    return { ...publicReporting, ...followUps === void 0 ? {} : { followUps }, credits, publishedAt: previous?.publishedAt ?? options.at, updatedAt: options.at };
  });
  const result = {
    schemaVersion: 1,
    ...draft.branding === void 0 ? {} : { branding: draft.branding },
    ...draft.presentation === void 0 ? {} : { presentation: { ...draft.presentation } },
    coverageState: draft.coverageState,
    updatedAt: changed ? options.at : options.previous.updatedAt,
    updates
  };
  assertLiveBlogData(result, { complete: !options.preview });
  return result;
}
function parseFollowUps(value, complete, authors) {
  if (value === void 0) return;
  if (!Array.isArray(value) || value.length > LIVE_BLOG_MAX_FOLLOW_UPS) throw new LiveBlogDraftError("An update may have at most 20 follow-ups.");
  if (value.length === 0) return;
  const ids = /* @__PURE__ */ new Set();
  return value.map((raw) => {
    if (!object2(raw) || !only(raw, ["id", "body", "credits", "correction", "withdrawal"]) || typeof raw.id !== "string" || raw.id !== "" && (!isLiveBlogId(raw.id) || ids.has(raw.id)) || !isLiveBlogFollowUpBody(raw.body, complete && raw.withdrawal === void 0)) {
      throw new LiveBlogDraftError("Follow-ups need a unique id and up to 1,000 characters in paragraphs, with links, bold or italic only.");
    }
    if (raw.id) ids.add(raw.id);
    for (const field of ["correction", "withdrawal"]) {
      if (raw[field] !== void 0 && (typeof raw[field] !== "string" || !raw[field].trim() || raw[field].length > 1e3)) {
        throw new LiveBlogDraftError("A follow-up correction or withdrawal needs an explanation of at most 1,000 characters.");
      }
    }
    const credits = normalizeStoryCredits(raw.credits);
    if (!credits.ok || complete && !credits.credits.length) throw new LiveBlogDraftError("Each follow-up needs a valid byline.");
    for (const credit of credits.credits) if (credit.kind === "registered") authors.add(credit.authorId);
    if (authors.size > LIVE_BLOG_MAX_REGISTERED_AUTHORS) throw new LiveBlogDraftError("A live blog may credit at most 64 distinct registered authors.");
    return {
      id: raw.id,
      body: structuredClone(raw.body),
      credits: credits.credits,
      ...raw.correction === void 0 ? {} : { correction: raw.correction },
      ...raw.withdrawal === void 0 ? {} : { withdrawal: raw.withdrawal }
    };
  });
}
function followUpForPublication(item, previous) {
  return item.withdrawal === void 0 ? item : {
    ...item,
    body: { type: "doc", content: [] },
    credits: previous?.credits ?? item.credits
  };
}
function followUpAuthored(item) {
  return homeCatalogJson({
    body: item.body,
    credits: normalizeStoryCredits(item.credits).credits,
    correction: item.correction ?? null,
    withdrawal: item.withdrawal ?? null
  });
}
function assertFollowUpsReady(items = [], previous = []) {
  for (const item of items) {
    const before = previous.find((old) => old.id === item.id);
    if (before && followUpAuthored(followUpForPublication(item, before)) === followUpAuthored(before)) continue;
    if (before && !item.withdrawal && (!item.correction || item.correction === before.correction)) {
      throw new LiveBlogDraftError("An edited published follow-up needs a new visible correction explanation.");
    }
    if (!before && (item.correction || item.withdrawal)) throw new LiveBlogDraftError("Only a previously published follow-up can be corrected or withdrawn.");
  }
}
function freezeFollowUps(items, previous, options) {
  if (items === void 0) return;
  return items.map((item) => {
    const before = previous?.find((old) => old.id === item.id);
    const publicItem = followUpForPublication(item, before);
    if (before && followUpAuthored(publicItem) === followUpAuthored(before)) return structuredClone(before);
    if (before && parsePublishInstant(options.at) <= parsePublishInstant(before.updatedAt)) throw new LiveBlogDraftError("A follow-up revision needs a later publication time.");
    const fallback = item.credits.map((credit) => credit.kind !== "registered" ? credit : {
      ...before?.credits.find((old) => old.kind === "registered" && old.authorId === credit.authorId),
      ...credit
    });
    const credits = item.withdrawal && before ? before.credits : options.freezeCredits(fallback);
    if (homeCatalogJson(normalizeStoryCredits(credits).credits) !== homeCatalogJson(item.withdrawal && before ? normalizeStoryCredits(before.credits).credits : item.credits)) {
      throw new LiveBlogDraftError("Every follow-up byline needs a resolved author name.");
    }
    return { ...publicItem, credits, publishedAt: before?.publishedAt ?? options.at, updatedAt: options.at };
  }).sort((a, b) => parsePublishInstant(a.publishedAt) - parsePublishInstant(b.publishedAt));
}
function assertLiveBlogFollowUpsEditable(draft, previous, published) {
  for (const entry of draft?.updates ?? []) {
    const publishedBefore = published?.updates.find((old) => old.id === entry.id);
    const before = previous?.updates.find((old) => old.id === entry.id) ?? publishedBefore;
    if (entry.withdrawal === void 0 && publishedBefore?.withdrawal === void 0) continue;
    if (!liveBlogFollowUpsEqual(entry.followUps, before?.followUps)) throw new LiveBlogDraftError("Follow-ups are hidden with this withdrawn update and cannot be changed.");
  }
}
function liveBlogFollowUpsEqual(left = [], right = []) {
  const reporting = (items) => homeCatalogJson(items.map((item) => ({ id: item.id, authored: followUpAuthored(item) })));
  return reporting(left) === reporting(right);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LIVE_BLOG_CONTRACT_VERSION,
  LIVE_BLOG_MAX_REGISTERED_AUTHORS,
  LiveBlogDraftError,
  assertLiveBlogData,
  assertLiveBlogFollowUpsEditable,
  assertLiveBlogReady,
  assertLiveBlogRetainsPublished,
  freezeLiveBlogData,
  liveBlogFollowUpsEqual,
  liveBlogMediaAssetIds,
  liveBlogVideoBlocks,
  parseLiveBlogDraft,
  prepareLiveBlogDraft,
  previewLiveBlogData,
  publicLiveBlogData,
  publicRichText
});
