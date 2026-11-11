// Generated from packages/content-core/src/block-content-validation.ts.
// Regenerate with: node scripts/generate-block-content-validation.mjs
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

// packages/content-core/src/block-content-validation.ts
var block_content_validation_exports = {};
__export(block_content_validation_exports, {
  blockContentError: () => blockContentError
});
module.exports = __toCommonJS(block_content_validation_exports);

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

// packages/content-core/src/content-layout.ts
function visibleLayoutBlocks(blocks) {
  if (!blocks.some((block) => block.type === "row" || block.layout !== void 0)) {
    return blocks.filter((block) => block.visible);
  }
  const hiddenRows = new Set(blocks.filter((block) => block.type === "row" && !block.visible).map((block) => block.id));
  return blocks.filter((block) => block.visible && (!block.layout || !hiddenRows.has(block.layout.rowId))).map((block, order) => ({ ...block, order }));
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

// packages/content-core/src/station-time.ts
var STATION_TIME_ZONE = "America/New_York";
function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(instant));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const fields2 = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
  if (Object.values(fields2).some((value) => !value)) {
    throw new Error(`Could not format a date in ${timeZone}.`);
  }
  return fields2;
}
function instantToStationLocal(value, timeZone = STATION_TIME_ZONE) {
  if (typeof value !== "string") return "";
  const instant = parsePublishInstant(value);
  if (instant === null) return "";
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
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

// packages/content-core/src/content-link.ts
var CONTENT_LINK_URL_MAX = 2048;
function contentLinkError(value) {
  if (value.contentLinkMode !== void 0 && !(typeof value.contentLinkMode === "string" && ["normal", "custom"].includes(value.contentLinkMode))) return "Choose the normal NJ PBS address or a custom URL.";
  if (value.contentLinkNewTab !== void 0 && typeof value.contentLinkNewTab !== "boolean") return "Open in a new tab must be on or off.";
  if (value.contentLinkUrl !== void 0 && (typeof value.contentLinkUrl !== "string" || value.contentLinkUrl.length > CONTENT_LINK_URL_MAX)) return "The custom URL must be at most 2,048 characters.";
  if (value.contentLinkMode === "custom" && (!isExactHttpsUrl(value.contentLinkUrl, CONTENT_LINK_URL_MAX) || value.contentLinkUrl.includes("\\"))) return "Enter a full https:// address without a username or password.";
  if (value.contentLinkMode === "custom" && new URL(value.contentLinkUrl).href.length > CONTENT_LINK_URL_MAX) return "The custom URL must be at most 2,048 characters.";
  return null;
}
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
function isSafeHref(raw) {
  return safeHref(raw) !== null;
}

// packages/content-core/src/media-origin.ts
var deploymentEnvironment = typeof __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ !== "undefined" ? __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ : typeof process !== "undefined" ? process.env.CMS_DEPLOYMENT_ENVIRONMENT : void 0;
var CMS_MEDIA_ORIGIN = deploymentEnvironment === "development" ? "https://dev-media.example.org" : "https://media.njpbs.org";

// packages/content-core/src/home-newscast-source.ts
var HOME_NEWSCAST_SHOW_ID = "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5";
var HOME_NEWSCAST_ASSETS_URL = `https://media.services.pbs.org/api/v1/assets/?show-id=${HOME_NEWSCAST_SHOW_ID}&type=full_length&parent-type=episode&available=public&country=US&platform-slug=bento&sort=-premiered_on`;

// packages/content-core/src/home-newscast-data.ts
var HOME_NEWSCAST_DEFAULTS = Object.freeze({
  showId: HOME_NEWSCAST_SHOW_ID,
  heading: "Latest newscast",
  summary: "",
  layout: "feature",
  watchLabel: "Watch the latest",
  pastLabel: "Past newscasts",
  liveLabel: "Watch live"
});

// packages/content-core/src/video-block.ts
var VIDEO_PUBLIC_PREFIX = `${CMS_MEDIA_ORIGIN}/cms-media/video/`;
var VIDEO_BLOCK_LIMITS = Object.freeze({
  assetId: 200,
  title: 200,
  caption: 600,
  url: 2e3
});

// packages/content-core/src/data-table.ts
var DATA_TABLE_FIELD_LIMITS = Object.freeze({
  title: 250,
  csv: 8e4,
  source: 500,
  sourceHref: 2e3
});

// packages/content-core/src/content-model.ts
function isRichTextNode(value) {
  if (typeof value !== "object" || value === null) return false;
  const node = value;
  if (typeof node.type !== "string" || node.type === "bio") return false;
  if (node.attrs !== void 0 && !isRecord(node.attrs)) return false;
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
      if (typeof candidate.type !== "string" || candidate.attrs !== void 0 && !isRecord(candidate.attrs)) {
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
  "support_appeal",
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
var NESTED_MEDIA_COLLECTION_MAX = 12;
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
var SUPPORT_APPEAL_DEFAULTS = Object.freeze({
  heading: "Before you go, a request for help\u2026",
  copy: [
    "NJ PBS is entering a dynamic new chapter; operating out of Montclair State, we're delivering state-of-the-art public reporting while training New Jersey's next generation of journalists, storytellers, and technical leaders alongside seasoned media veterans\u2013in addition to streaming your favorite shows!",
    "Because we operate as an independent entity and can no longer rely on federal subsidies, our strength and sustainability rest directly with you.",
    "Will you join us in building the future of New Jersey public media? Your year-end contribution directly funds our independent newsroom, fuels homegrown Jersey storytelling, and equips future media leaders."
  ].join("\n\n"),
  buttonLabel: "Donate to the NJ PBS Year-End Fund",
  href: "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport",
  style: "blue"
});
var LINK_CARD_LIMITS = Object.freeze({
  title: 250,
  source: 120,
  summary: 500,
  url: 2e3
});
var COVERAGE_LIST_LIMITS = Object.freeze({
  title: 250,
  outlet: 120,
  url: 2e3,
  entries: 100
});
var AP_MAP_HEIGHTS = Object.freeze({ small: 600, medium: 900, large: 1200 });
var AP_MAP_MOBILE_HEIGHT_LIMITS = Object.freeze({ min: 320, max: 4096 });
var EMBED_WIDTH_LIMITS = Object.freeze({ min: 160, max: 4096 });
var EMBED_HEIGHT_LIMITS = Object.freeze({ min: 90, max: 4096 });
var EMBED_ASPECT_RATIO_LIMITS = Object.freeze({ min: 9 / 16, max: 21 / 9 });
var HTML_BLOCK_LIMITS = Object.freeze({ html: 5e4, title: 200 });
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
var CONTENT_SHELF_SOURCE_SET = new Set(CONTENT_SHELF_SOURCES);
var CONTENT_SHELF_ITEM_LIMIT_SET = new Set(CONTENT_SHELF_ITEM_LIMITS);
var PROMOTION_PLAYLIST_PLACEMENT_SET = new Set(
  PROMOTION_PLAYLIST_PLACEMENTS
);
var SHELF_SORT_SET = new Set(SHELF_SORTS);
var SHELF_ITEM_LIMIT_SET = new Set(SHELF_ITEM_LIMITS);
var TOPIC_SHELF_SOURCE_SET = new Set(TOPIC_SHELF_SOURCES);
var VIDEO_LIBRARY_SET = new Set(VIDEO_LIBRARIES);
function isRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// packages/content-core/src/public-pages.ts
var PUBLIC_PAGES = [
  {
    id: "home",
    title: "Home",
    path: "/",
    family: "home",
    area: "station",
    editorTemplate: "home"
  },
  {
    id: "watch",
    title: "Watch NJ PBS",
    path: "/watch/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding"
  },
  {
    id: "live",
    title: "PBS Livestream",
    path: "/live/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding"
  },
  {
    id: "schedule",
    title: "Schedule",
    path: "/schedule/",
    family: "schedule",
    area: "watch",
    editorTemplate: "programLanding"
  },
  {
    id: "kids",
    title: "Kids",
    path: "/kids/",
    family: "service",
    area: "watch",
    editorTemplate: "programLanding"
  },
  {
    id: "support",
    title: "Support NJ PBS",
    path: "/support/",
    family: "service",
    area: "support",
    editorTemplate: "programLanding"
  },
  {
    id: "give",
    title: "Give to NJ PBS",
    path: "/give/",
    aliases: ["/donate/"],
    family: "service",
    area: "support",
    editorTemplate: "programLanding"
  },
  {
    id: "passport",
    title: "NJ PBS Passport",
    path: "/passport/",
    family: "service",
    area: "support",
    editorTemplate: "programLanding"
  },
  {
    id: "about",
    title: "About NJ PBS",
    path: "/about/",
    family: "service",
    area: "station",
    editorTemplate: "programLanding"
  },
  {
    id: "staff",
    title: "Staff",
    path: "/staff/",
    family: "staff",
    area: "station",
    editorTemplate: "genericPage"
  },
  {
    id: "contact",
    title: "Contact NJ PBS",
    path: "/contact/",
    family: "article",
    area: "station",
    editorTemplate: "genericPage"
  },
  {
    id: "faq",
    title: "NJ PBS transition FAQ",
    path: "/faq/",
    family: "article",
    area: "support",
    editorTemplate: "genericPage"
  },
  {
    id: "accessibility",
    title: "Accessibility statement",
    path: "/accessibility/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "closed-captioning",
    title: "Closed captioning",
    path: "/closed-captioning/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "privacy",
    title: "Privacy policy",
    path: "/privacy/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "public-file",
    title: "FCC public inspection files",
    path: "/public-file/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "eeo",
    title: "FCC EEO report",
    path: "/eeo/",
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  {
    id: "public-meetings",
    title: "Meeting notices",
    path: "/meeting-notices/",
    aliases: ["/public-meetings/"],
    family: "article",
    area: "compliance",
    editorTemplate: "genericPage"
  },
  { id: "data-hub", title: "New Jersey by the Numbers", path: "/data-hub/", family: "dataHub", area: "station", editorTemplate: "genericPage" }
];
var PUBLIC_PAGE_IDS = PUBLIC_PAGES.map((page) => page.id);

// packages/content-core/src/content-sections.ts
var SEEDED_CONTENT_SECTIONS = Object.freeze([
  Object.freeze({
    id: "watch",
    label: "Watch",
    description: "Live, on-demand, schedule and kids pages.",
    order: 1
  }),
  Object.freeze({
    id: "support",
    label: "Support",
    description: "Membership, giving and Passport pages.",
    order: 2
  }),
  Object.freeze({
    id: "station",
    label: "Station",
    description: "Home, about and contact pages.",
    order: 3
  }),
  Object.freeze({
    id: "compliance",
    label: "Compliance",
    description: "Public file, accessibility, EEO and policy pages.",
    order: 4
  }),
  Object.freeze({
    id: "news",
    label: "News",
    description: "Newscast stories, posts and newsroom records.",
    order: 5
  })
]);
var SEEDED_SECTION_IDS = new Set(
  SEEDED_CONTENT_SECTIONS.map((section) => section.id)
);

// packages/content-core/src/editor-admin.ts
var SECTION_BLOCK_CATALOG = Object.freeze({
  home: Object.freeze([
    "row",
    "headline",
    "prose",
    "image",
    "image_gallery",
    "cta_row",
    "card_grid",
    "embed",
    "html",
    "content_shelf",
    "promotion_playlist",
    "topic_shelf",
    "video_playlist",
    "newsletter_signup",
    "home_newscast",
    "record_card",
    "sponsor_strip",
    "divider"
  ]),
  programLanding: Object.freeze([
    "row",
    "headline",
    "prose",
    "image",
    "card_grid",
    "link_card",
    "faq_item",
    "cta_row",
    "embed",
    "county_comparison",
    "town_lookup",
    "html",
    "video_playlist",
    "promotion_playlist",
    "record_card",
    "divider",
    "sponsor_strip"
  ]),
  genericPage: Object.freeze([
    "embed",
    "data_hub_section",
    "document_list",
    "data_table",
    "data_figure",
    "election_results",
    "county_comparison",
    "town_lookup",
    "row",
    "headline",
    "prose",
    "image",
    "video",
    "cta_row",
    "faq_item",
    "link_card",
    "coverage_list",
    "html",
    "topic_shelf",
    "video_playlist",
    "promotion_playlist",
    "record_card",
    "newsletter_signup",
    "divider",
    "sponsor_strip"
  ]),
  // A related-story shelf at the foot of a story is the case the request was built
  // from (#1046), so a post gets the topic shelf. It does not get a video playlist:
  // a story that wants one video wants a video block or an embed, not a queried row.
  post: Object.freeze([
    "bio_card",
    "data_table",
    "data_figure",
    "election_results",
    "row",
    "prose",
    "image",
    "video",
    "image_gallery",
    "embed",
    "html",
    "cta_row",
    "support_appeal",
    "link_card",
    "topic_shelf",
    "promotion_playlist",
    "record_card",
    "newsletter_signup",
    "divider",
    "sponsor_strip"
  ])
});
var SECTION_BLOCK_MAX = Object.freeze({
  home: Object.freeze({
    headline: 1,
    image_gallery: 2,
    card_grid: 2,
    cta_row: 3,
    content_shelf: 4,
    promotion_playlist: 8,
    topic_shelf: 2,
    video_playlist: 2,
    home_newscast: 1
  }),
  programLanding: Object.freeze({ promotion_playlist: 8, headline: 1, cta_row: 2, video_playlist: 1 }),
  genericPage: Object.freeze({ promotion_playlist: 8, headline: 1, cta_row: 2, coverage_list: 1, topic_shelf: 2, video_playlist: 1, video: 4 }),
  post: Object.freeze({ promotion_playlist: 8, image_gallery: 2, cta_row: 2, support_appeal: 1, topic_shelf: 1, video: 4 })
});
var SECTION_BLOCK_TOTAL_MAX = Object.freeze({
  home: 40,
  programLanding: 40,
  genericPage: 40,
  post: 200
});
var SECTION_LABELS = Object.freeze({
  home: "the home page",
  programLanding: "a program landing page",
  genericPage: "a content page",
  post: "a post"
});
var BLOCK_LABELS = Object.freeze({
  bio_card: "bio card",
  row: "row",
  headline: "heading",
  prose: "text",
  image: "image",
  video: "uploaded video",
  image_gallery: "image gallery",
  cta_row: "buttons",
  support_appeal: "support appeal",
  card_grid: "card set",
  link_card: "link card",
  document_list: "PDF notices",
  faq_item: "FAQ item",
  coverage_list: "coverage list",
  town_lookup: "town election lookup",
  data_table: "data table",
  data_hub_section: "Data Hub section",
  data_figure: "data figure",
  election_results: "election results",
  county_comparison: "county comparison",
  embed: "video or embed",
  html: "custom HTML",
  content_shelf: "content shelf",
  promotion_playlist: "manual content shelf",
  newsletter_signup: "newsletter signup",
  home_newscast: "Newscast",
  topic_shelf: "related stories",
  video_playlist: "video content shelf",
  record_card: "Program, event, sponsor, or newsletter",
  sponsor_strip: "sponsor strip",
  divider: "divider"
});
var IMAGE_ITEM_FIELDS = [
  { key: "assetId", label: "Image", help: "Choose an image from the media library.", kind: "asset", required: true },
  { key: "alt", label: "Alt text", help: "Describe the image for screen readers and when it cannot load.", kind: "text", required: false, recommended: true, requiredWhen: "assetId", requiredUnless: "altDecorative" },
  { key: "altDecorative", label: "Mark as decorative", help: "Turn this on for an image that carries no information, such as a background pattern. Leave the alt text empty.", kind: "toggle", required: false },
  { key: "caption", label: "Caption", help: "An optional caption shown under the image.", kind: "text", required: false }
];
var CTA_ITEM_FIELDS = [
  { key: "label", label: "Button label", help: "The words on the button, for example Watch now.", kind: "text", required: true },
  { key: "href", label: "Button link", help: "Where the button goes when clicked.", kind: "url", required: true }
];
var CARD_ITEM_FIELDS = [
  { key: "label", label: "Card label", help: "An optional short category shown above the title.", kind: "text", required: false },
  { key: "title", label: "Card title", help: "The card's heading.", kind: "text", required: true },
  { key: "body", label: "Card text", help: "An optional short description, in one continuous editor.", kind: "richText", required: false },
  { key: "imageAssetId", label: "Card image", help: "An optional image from the media library.", kind: "asset", required: false },
  { key: "href", label: "Card link", help: "An optional link the card opens.", kind: "url", required: false }
];
var LINK_CARD_FIELDS = [
  {
    key: "title",
    label: "Card title",
    help: "The linked page or article title.",
    kind: "text",
    required: true,
    maxLength: LINK_CARD_LIMITS.title
  },
  {
    key: "url",
    label: "Card link",
    help: "The public page this card opens.",
    kind: "url",
    required: true,
    maxLength: LINK_CARD_LIMITS.url
  },
  {
    key: "source",
    label: "Source",
    help: "Optional. The publication, organization, or site name.",
    kind: "text",
    required: false,
    maxLength: LINK_CARD_LIMITS.source
  },
  {
    key: "date",
    label: "Date",
    help: "Optional. The day the linked item was published.",
    kind: "date",
    required: false
  },
  {
    key: "summary",
    label: "Summary",
    help: "Optional. A short description shown on the card.",
    kind: "text",
    required: false,
    maxLength: LINK_CARD_LIMITS.summary
  }
];
var COVERAGE_ITEM_FIELDS = [
  {
    key: "title",
    label: "Article title",
    help: "The headline of the outside article.",
    kind: "text",
    required: true,
    maxLength: COVERAGE_LIST_LIMITS.title
  },
  {
    key: "outlet",
    label: "Outlet",
    help: "The publication that ran the article.",
    kind: "text",
    required: false,
    maxLength: COVERAGE_LIST_LIMITS.outlet
  },
  { key: "date", label: "Article date", help: "The day the article ran.", kind: "date", required: false },
  {
    key: "url",
    label: "Article link",
    help: "The public link to the article.",
    kind: "url",
    required: false,
    maxLength: COVERAGE_LIST_LIMITS.url
  }
];
var CONTENT_SHELF_FIELDS = [
  {
    key: "title",
    label: "Shelf heading",
    help: "The heading shown above this content shelf.",
    kind: "text",
    required: true
  },
  {
    key: "source",
    label: "Content source",
    help: "Choose the service that supplies the cards. Cards refresh from that service and are not copied into this page.",
    kind: "select",
    required: true,
    options: [
      { value: "pbs_featured", label: "PBS featured programs" },
      { value: "pbs_more", label: "PBS more to watch" },
      { value: "spotlight_news", label: "NJ Spotlight News" },
      { value: "station_posts", label: "Published NJ PBS Posts" }
    ]
  },
  {
    key: "presentation",
    label: "Shelf layout",
    help: "Keep a horizontal row or show a wrapping grid. Both use the same source cards.",
    kind: "select",
    required: false,
    options: [
      { value: "rail", label: "Horizontal row" },
      { value: "grid", label: "Wrapping grid" }
    ]
  },
  {
    key: "columns",
    label: "Grid columns",
    help: "The desktop column count. The grid uses two columns on phones.",
    kind: "select",
    required: false,
    options: [2, 3, 4].map((value) => ({ value, label: value + " columns" }))
  },
  {
    key: "itemLimit",
    label: "Number of items",
    help: "The most cards this shelf requests from its source.",
    kind: "select",
    required: true,
    options: CONTENT_SHELF_ITEM_LIMITS.map((value) => ({
      value,
      label: `${value} items`
    }))
  },
  {
    key: "moreLabel",
    label: "More link label",
    help: "The words on the link beside the shelf heading.",
    kind: "text",
    required: true
  },
  {
    key: "moreHref",
    label: "More link",
    help: "Where the link beside the shelf heading goes.",
    kind: "url",
    required: true
  }
];
var PROMOTION_CARD_FIELDS = [
  { key: "title", label: "Content title", help: "The content name shown below the image.", kind: "text", required: true },
  { key: "summary", label: "Content summary", help: "A short description of the selected content.", kind: "text", required: true },
  { key: "imageAssetId", label: "Content image", help: "Choose an image from the media library.", kind: "asset", required: true },
  { key: "alt", label: "Alt text", help: "Describe the image for screen readers and when it cannot load.", kind: "text", required: false, recommended: true, requiredWhen: "imageAssetId", requiredUnless: "altDecorative" },
  { key: "altDecorative", label: "Mark as decorative", help: "Turn this on only when the image adds no information. Leave the alt text empty.", kind: "toggle", required: false },
  { key: "href", label: "Content link", help: "Paste the approved NJ PBS or PBS page for this content.", kind: "url", required: true }
];
var PROMOTION_PLACEMENT_LABELS = {
  before_start: "Before the newsletter signup",
  before_featured: "Before Featured on NJ PBS",
  before_passport: "Before PBS Passport",
  before_more: "Before More to watch",
  before_spotlight: "Before NJ Spotlight News"
};
var SHELF_PRESENTATION_LABELS = { rail: "Horizontal row", grid: "Card grid", list: "List" };
var PROMOTION_PLAYLIST_FIELDS = [
  {
    key: "title",
    label: "Shelf heading",
    help: "The heading shown above this manual content shelf.",
    kind: "text",
    required: true
  },
  {
    key: "presentation",
    label: "Shelf layout",
    help: "Choose how the cards appear.",
    kind: "select",
    required: false,
    options: SHELF_PRESENTATIONS.map((value) => ({ value, label: SHELF_PRESENTATION_LABELS[value] }))
  },
  {
    key: "columns",
    label: "Grid columns",
    help: "Columns stack on small screens.",
    kind: "select",
    required: false,
    options: SHELF_COLUMNS.map((value) => ({ value, label: `${value} columns` }))
  },
  {
    key: "placement",
    label: "Home page position",
    help: "Choose which existing Home page section this manual content shelf appears before.",
    kind: "select",
    required: true,
    options: PROMOTION_PLAYLIST_PLACEMENTS.map((value) => ({
      value,
      label: PROMOTION_PLACEMENT_LABELS[value]
    }))
  },
  {
    key: "cards",
    label: "Shelf items",
    help: "Add up to twelve items and put them in display order.",
    kind: "list",
    required: true,
    minItems: 1,
    maxItems: 12,
    itemFields: PROMOTION_CARD_FIELDS
  }
];
var TOPIC_OPTIONS = SHELF_TOPICS.map((topic) => ({
  value: topic.id,
  label: topic.label
}));
var SORT_OPTIONS = SHELF_SORTS.map((sort) => ({
  value: sort,
  label: SHELF_SORT_LABELS[sort]
}));
var SHELF_COUNT_OPTIONS = SHELF_ITEM_LIMITS.map((value) => ({
  value,
  label: `Up to ${value} items`
}));
var TOPIC_SHELF_PIN_FIELDS = [
  {
    key: "id",
    label: "Pinned story",
    help: "Choose a story from the approved list. Pinned stories appear first, in this order.",
    kind: "select",
    required: true
  }
];
var VIDEO_PLAYLIST_PIN_FIELDS = [
  {
    key: "id",
    label: "Pinned video",
    help: "Choose a video from the approved library. Pinned videos appear first, in this order.",
    kind: "select",
    required: true
  }
];
var TOPIC_SHELF_FIELDS = [
  {
    key: "title",
    label: "Shelf heading",
    help: "The heading shown above the related stories.",
    kind: "text",
    required: true
  },
  {
    key: "topic",
    label: "Topic",
    help: "The shelf fills itself with approved stories carrying this topic.",
    kind: "select",
    required: true,
    options: TOPIC_OPTIONS
  },
  {
    key: "source",
    label: "Where the stories come from",
    help: "Only approved story sources can fill this shelf.",
    kind: "select",
    required: true,
    options: [{ value: "njpbs_related_index", label: "Approved NJ PBS related-story list" }]
  },
  {
    key: "itemLimit",
    label: "How many stories",
    help: "The most stories this shelf will show.",
    kind: "select",
    required: true,
    options: SHELF_COUNT_OPTIONS
  },
  {
    key: "sort",
    label: "Order",
    help: "How the stories that are not pinned are ordered.",
    kind: "select",
    required: true,
    options: SORT_OPTIONS
  },
  {
    key: "pinned",
    label: "Pinned stories",
    help: `Optional. Pinned stories come first, in this order, ahead of everything the topic finds. Up to ${SHELF_PIN_MAX}.`,
    kind: "list",
    required: false,
    maxItems: SHELF_PIN_MAX,
    itemFields: TOPIC_SHELF_PIN_FIELDS
  }
];
var VIDEO_PLAYLIST_FIELDS = [
  {
    key: "title",
    label: "Shelf heading",
    help: "The heading shown above the videos.",
    kind: "text",
    required: true
  },
  {
    key: "topic",
    label: "Topic",
    help: "The playlist fills itself with approved videos carrying this topic.",
    kind: "select",
    required: true,
    options: TOPIC_OPTIONS
  },
  {
    key: "library",
    label: "Video library",
    help: "Only NJ PBS and PBS libraries can fill a playlist. A video with no confirmed captions, runtime, or rights window is never shown.",
    kind: "select",
    required: true,
    options: VIDEO_LIBRARIES.map((library) => ({
      value: library,
      label: VIDEO_LIBRARY_LABELS[library]
    }))
  },
  {
    key: "itemLimit",
    label: "How many videos",
    help: "The most videos this playlist will show.",
    kind: "select",
    required: true,
    options: SHELF_COUNT_OPTIONS
  },
  {
    key: "sort",
    label: "Order",
    help: "How the videos that are not pinned are ordered.",
    kind: "select",
    required: true,
    options: SORT_OPTIONS
  },
  {
    key: "pinned",
    label: "Pinned videos",
    help: `Optional. Pinned videos come first, in this order, ahead of everything the topic finds. Up to ${SHELF_PIN_MAX}.`,
    kind: "list",
    required: false,
    maxItems: SHELF_PIN_MAX,
    itemFields: VIDEO_PLAYLIST_PIN_FIELDS
  }
];
var BLOCK_FIELDS = {
  home_newscast: [
    { key: "heading", label: "Heading", help: "The heading above the latest newscast.", kind: "text", required: true, maxLength: 120 },
    { key: "summary", label: "Summary", help: "An optional plain-text introduction.", kind: "text", multiline: true, required: false, maxLength: 2e3 },
    {
      key: "layout",
      label: "Layout",
      help: "Choose the approved poster presentation.",
      kind: "select",
      required: true,
      options: [{ value: "feature", label: "Poster beside copy" }, { value: "compact", label: "Compact stacked card" }]
    },
    { key: "watchLabel", label: "Watch button text", help: "The action opens the approved episode.", kind: "text", required: true, maxLength: 120 },
    { key: "pastLabel", label: "Past newscasts text", help: "The action opens this program's past episodes.", kind: "text", required: true, maxLength: 120 },
    { key: "liveLabel", label: "Watch live text", help: "The action opens the station livestream.", kind: "text", required: true, maxLength: 120 }
  ],
  newsletter_signup: [
    { key: "heading", label: "Heading", help: "Optional heading above the newsletters.", kind: "text", required: false },
    { key: "intro", label: "Introduction", help: "Optional short introduction.", kind: "text", required: false, multiline: true },
    { key: "newsletterIds", label: "Newsletters", help: "Choose one to four newsletters. Only records with a secure signup link appear publicly.", kind: "list", required: true, minItems: 1, maxItems: 4 }
  ],
  headline: [
    { key: "text", label: "Heading", help: "The heading text for this section.", kind: "text", required: true }
  ],
  bio_card: [
    { key: "name", label: "Name", help: "The person or organization readers will see.", kind: "text", required: true, maxLength: 120 },
    { key: "role", label: "Role", help: "Current job or the role relevant to this story.", kind: "text", required: true, maxLength: 180 },
    { key: "party", label: "Party", help: "Include only a verified political affiliation when relevant.", kind: "text", required: false, maxLength: 60 },
    { key: "area", label: "Area served", help: "Use Statewide for statewide roles, or a specific district, town, county or region. Leave blank when unnecessary.", kind: "text", required: false, maxLength: 160 },
    { key: "summary", label: "Short biography", help: "A few sourced sentences that help explain this story. Leave out internal research notes.", kind: "text", multiline: true, required: true, maxLength: 600 },
    { key: "sourceUrl", label: "Source link", help: "The HTTPS source supporting these public facts.", kind: "url", required: true, maxLength: 2e3, requireHttps: true },
    { key: "sourceLabel", label: "Source name", help: "A readable name for the source.", kind: "text", required: true, maxLength: 120 },
    { key: "asOf", label: "Facts checked", help: "The date these facts were verified. Recheck roles before publishing.", kind: "date", required: true }
  ],
  prose: [
    { key: "content", label: "Body", help: "Write freely: paragraphs, headings, links, and lists in one continuous editor.", kind: "richText", required: true }
  ],
  image: [
    { key: "assetId", label: "Image", help: "Choose an image from the media library.", kind: "asset", required: true },
    { key: "alt", label: "Alt text", help: "Describe the image for screen readers and when it cannot load.", kind: "text", required: false, recommended: true, requiredWhen: "assetId", requiredUnless: "altDecorative" },
    { key: "altDecorative", label: "Mark as decorative", help: "Turn this on for an image that carries no information, such as a background pattern. Leave the alt text empty.", kind: "toggle", required: false },
    { key: "caption", label: "Caption", help: "An optional caption shown under the image.", kind: "text", required: false },
    { key: "href", label: "Image link", help: "Optional. Where the image goes when clicked, such as the full video. Say where it goes in the alt text. A decorative image cannot have a link.", kind: "url", required: false, requiredUnless: "altDecorative", namedBy: ["alt", "caption"] },
    { key: "newTab", label: "Open link in a new tab", help: "Turn this on to open the link in a new browser tab.", kind: "toggle", required: false }
  ],
  video: [
    { key: "assetId", label: "Video", help: "Choose a video from the media library. Only videos with a ready viewing copy can be picked.", kind: "text", required: true },
    { key: "title", label: "Video title", help: "Names the video for screen readers. Readers do not see it on the page.", kind: "text", required: true, maxLength: 200 },
    { key: "caption", label: "Caption", help: "An optional caption shown under the video.", kind: "text", required: false, maxLength: 600 }
  ],
  image_gallery: [
    { key: "images", label: "Images", help: "Add images to the gallery, each with its own alt text.", kind: "list", required: true, maxItems: NESTED_MEDIA_COLLECTION_MAX, itemFields: IMAGE_ITEM_FIELDS }
  ],
  cta_row: [
    { key: "ctas", label: "Buttons", help: "Add one or more buttons, each with a label and a link.", kind: "list", required: true, itemFields: CTA_ITEM_FIELDS }
  ],
  support_appeal: [
    { key: "heading", label: "Heading", help: "A short invitation to support NJ PBS. Place this block at the end of the story.", kind: "text", required: true, maxLength: 120 },
    { key: "copy", label: "Appeal text", help: "Explain why readers should give. Separate paragraphs with a blank line.", kind: "text", multiline: true, required: true, maxLength: 2e3 },
    { key: "buttonLabel", label: "Button text", help: "A short action such as Donate.", kind: "text", required: true, maxLength: 60 },
    { key: "href", label: "Button link", help: "The Support page or a secure donation link.", kind: "url", required: true, maxLength: 2e3 },
    { key: "backgroundImageAssetId", label: "Decorative image", help: "Optional image from the media library. It fills the right third on wide screens and is hidden on phones. Keep all information in the text.", kind: "asset", required: false },
    {
      key: "style",
      label: "Style",
      help: "Choose a coordinated background, text and button palette with accessible contrast.",
      kind: "select",
      required: true,
      options: [{ value: "blue", label: "PBS blue" }, { value: "light", label: "Light (lavender)" }, { value: "dark", label: "Dark with teal accent" }]
    }
  ],
  card_grid: [
    { key: "cards", label: "Cards", help: "Add cards, each with a title and an optional image, text, and link.", kind: "list", required: true, maxItems: NESTED_MEDIA_COLLECTION_MAX, itemFields: CARD_ITEM_FIELDS }
  ],
  link_card: LINK_CARD_FIELDS,
  document_list: [{
    key: "documents",
    label: "PDF notices",
    help: "Upload PDFs and give each a readable title. Newest additions appear first.",
    kind: "list",
    required: false,
    maxItems: 100,
    itemFields: [
      { key: "title", label: "Notice title", help: "A readable title for this PDF.", kind: "text", required: true, maxLength: 300 },
      { key: "assetId", label: "PDF", help: "Choose a PDF from the media library.", kind: "asset", required: true }
    ]
  }],
  faq_item: [
    { key: "question", label: "Question", help: "The question a viewer would ask.", kind: "text", required: true },
    { key: "answer", label: "Answer", help: "The answer, in the same continuous editor as other prose.", kind: "richText", required: true }
  ],
  coverage_list: [
    {
      key: "entries",
      label: "Articles",
      help: "Add, edit, reorder, or remove each outside article. Put newer items first, or keep the current order.",
      kind: "list",
      required: true,
      minItems: 1,
      maxItems: COVERAGE_LIST_LIMITS.entries,
      itemFields: COVERAGE_ITEM_FIELDS
    }
  ],
  data_hub_section: [
    { key: "sectionId", label: "Compiled section", help: "Choose a reviewed Data Hub section. Values, sources and dates stay compiled.", kind: "select", required: true, options: Object.entries(DATA_HUB_SECTIONS).map(([value, label]) => ({ value, label })) },
    { key: "heading", label: "Heading", help: "Leave blank to use the reviewed heading.", kind: "text", required: false, maxLength: 300 },
    { key: "introduction", label: "Introduction", help: "Leave blank to use the reviewed introduction.", kind: "text", multiline: true, required: false, maxLength: 4e3 }
  ],
  data_figure: [
    { key: "datasetId", label: "Data figure", help: "Choose an approved shared dataset.", kind: "text", required: true, maxLength: 128 },
    { key: "display", label: "Display", help: "Show the chart or keep it in a disclosure.", kind: "select", required: true, options: [{ value: "compact", label: "Compact" }, { value: "expanded", label: "Expanded" }] }
  ],
  town_lookup: [
    { key: "heading", label: "Heading", help: "Name the town lookup section.", kind: "text", required: true, maxLength: 200 },
    { key: "introduction", label: "Introduction", help: "Introduce the past results readers can find.", kind: "text", multiline: true, required: false, maxLength: 4e3 },
    { key: "sourceLine", label: "Source line", help: "Add context about the sources. Election source links always appear with the figures.", kind: "text", multiline: true, required: false, maxLength: 500 }
  ],
  election_results: [],
  county_comparison: [
    { key: "heading", label: "Heading", help: "Leave blank to use the reviewed heading.", kind: "text", required: false, maxLength: 300 },
    { key: "intro", label: "Introduction", help: "Leave blank to use the reviewed introduction.", kind: "text", multiline: true, required: false, maxLength: 4e3 },
    { key: "source", label: "Source line", help: "Leave blank to use the reviewed source credit. Official source links always appear.", kind: "text", multiline: true, required: false, maxLength: 1e3 }
  ],
  data_table: [
    { key: "title", label: "Table title", help: "Name what the data shows.", kind: "text", required: true },
    { key: "csv", label: "CSV data", help: "Paste a header row and 1\u2013100 data rows, with at most 12 columns.", kind: "text", required: true },
    { key: "source", label: "Data source", help: "Name the source and date of the data.", kind: "text", required: false },
    { key: "sourceHref", label: "Source link", help: "An optional link to the source.", kind: "url", required: false }
  ],
  embed: [
    { key: "url", label: "Video or embed link", help: "Paste a video player link or iframe code, or an AP published results layout link. AP results use a direct embed; put the link here instead of in Custom HTML. X/Twitter videos show as cards. Other links show as links.", kind: "url", required: true },
    { key: "caption", label: "Caption", help: "Optional text below an AP map, or a heading above a video player. Enter LIVE to add a red live light to a video player.", kind: "text", required: false },
    { key: "width", label: "Player width", help: "Optional width in pixels. Video players stay responsive on smaller screens. AP results always use the available width; leave this blank for AP.", kind: "number", required: false, ...EMBED_WIDTH_LIMITS, aspectRatioWith: "height", minAspectRatio: EMBED_ASPECT_RATIO_LIMITS.min, maxAspectRatio: EMBED_ASPECT_RATIO_LIMITS.max },
    { key: "height", label: "Player height", help: "Optional video height in pixels. Video players use the pasted ratio or provider default when both size fields are blank. AP layouts have separate map size and mobile height controls.", kind: "number", required: false, ...EMBED_HEIGHT_LIMITS }
  ],
  html: [
    { key: "html", label: "HTML", help: "Paste HTML, CSS, and scripts. They run in a sealed frame that cannot change the rest of the page.", kind: "text", multiline: true, required: true, maxLength: 5e4 },
    { key: "title", label: "Frame title", help: 'Describe the content for screen reader users, such as "Election results map".', kind: "text", required: false, maxLength: 200 }
  ],
  content_shelf: CONTENT_SHELF_FIELDS,
  promotion_playlist: PROMOTION_PLAYLIST_FIELDS,
  topic_shelf: TOPIC_SHELF_FIELDS,
  video_playlist: VIDEO_PLAYLIST_FIELDS,
  record_card: [
    { key: "recordKind", label: "Record type", help: "Choose the kind of record.", kind: "text", required: true },
    { key: "recordId", label: "Record", help: "Choose a saved record.", kind: "text", required: true }
  ],
  sponsor_strip: [
    { key: "heading", label: "Heading", help: "An optional heading above the sponsors.", kind: "text", required: false, maxLength: 120 },
    { key: "sponsorIds", label: "Sponsors", help: "Choose one to 12 sponsors and arrange their order.", kind: "list", required: true, minItems: 1, maxItems: 12 },
    { key: "layout", label: "Layout", help: "Show logos in one row or a wrapping grid.", kind: "select", required: true, options: [{ value: "row", label: "Row" }, { value: "grid", label: "Grid" }] }
  ],
  // Row split controls belong to the layout surface, not a payload text field.
  row: [],
  divider: []
};
function cloneField(f) {
  const path = f.path ? [...f.path] : void 0;
  const options = f.options?.map((option) => ({ ...option }));
  return f.itemFields ? { ...f, path, options, itemFields: f.itemFields.map(cloneField) } : { ...f, path, options };
}
function editorFieldsForBlock(type) {
  const fields2 = BLOCK_FIELDS[type];
  return fields2.map(cloneField);
}
var CONTENT_LINK_FIELDS = [
  { key: "contentLinkMode", label: "Point this content to", help: "Choose where readers go when they click this item. Publish to apply the change. Your body stays saved.", kind: "select", required: false, options: [{ value: "normal", label: "Its normal NJ PBS address" }, { value: "custom", label: "A custom URL" }] },
  { key: "contentLinkUrl", label: "Custom URL", help: "Use a full https:// address without a username or password. Up to 2,048 characters.", kind: "url", required: false, requireHttps: true, maxLength: 2048 },
  { key: "contentLinkNewTab", label: "Open in a new tab", help: "Readers keep their place on NJ PBS.", kind: "toggle", required: false }
];
var SEARCH_FIELDS = [
  { key: "title", path: ["seo"], label: "Search title", help: "Leave this blank to use the page or post title.", kind: "text", required: false },
  { key: "description", path: ["seo"], label: "Search description", help: "Optional search-only override. Leave blank to use the page summary or a Post's summary, then Excerpt.", kind: "text", required: false },
  { key: "noindex", path: ["seo"], label: "Hide from search engines", help: "Ask search engines not to index this page or post.", kind: "toggle", required: false }
];
var SOCIAL_FIELDS = [
  { key: "title", path: ["social"], label: "Social title", help: "This title appears when people share the link.", kind: "text", required: false },
  { key: "description", path: ["social"], label: "Social description", help: "Optional shared-link override. Leave blank to use the page summary or a Post's summary, then Excerpt.", kind: "text", required: false },
  { key: "imageAssetId", path: ["social"], label: "Social image", help: "Choose the image used in social link cards.", kind: "asset", required: false }
];
var POST_SEARCH_FIELDS = SEARCH_FIELDS.map(
  (field) => field.key === "title" ? {
    ...field,
    help: "Uses the post title by default. Customize only when a search result needs different wording."
  } : field
);
var POST_SOCIAL_FIELDS = SOCIAL_FIELDS.map(
  (field) => field.key === "title" ? {
    ...field,
    help: "Uses the post title by default. Customize only when a shared link needs different wording."
  } : field
);
var POST_BASIC_FIELDS = [
  { key: "title", label: "Post title", help: "The title people see on the post and in listings.", kind: "text", required: true },
  { key: "summary", label: "Summary", help: "Optional text below the title. Also used in listings, search, and social sharing.", kind: "text", required: false }
];
var POST_EXCERPT_FIELDS = [
  { key: "excerpt", label: "Excerpt", help: "Optional fallback for listing cards and default Search and Social descriptions when summary is empty. It does not appear beneath the post title.", kind: "text", required: false }
];
var POST_DATE_FIELDS = [
  { key: "date", label: "Editorial date shown with the post", help: "Leave blank to use the date the post first published. Set a date only to run an older story under the day it originally appeared.", kind: "date", required: false },
  { key: "recordMeaningfulUpdate", label: "Record a meaningful update", help: "Turn this on when this save changes the substance of the story. Leave it off for a typo or a small fix. It turns itself back off once the update is recorded.", kind: "toggle", required: false },
  { key: "showUpdatedDate", label: "Show the update date on the post", help: "Turn this on to show readers when the story was last meaningfully updated.", kind: "toggle", required: false }
];
var POST_ORGANIZATION_FIELDS = [
  { key: "coverageLabelId", label: "Coverage label", help: "Choose a published series or special coverage label. Save and publish to update it on the public site.", kind: "text", required: false },
  { key: "showInHomeHero", label: "Show in Home hero", help: "Includes this Post when Home selects by tags. Keeps the current order and limit.", kind: "toggle", required: false },
  { key: "spotlightNews", label: "Spotlight News", help: "Show NJ Spotlight News above this headline and on post listings. Leave off for other posts. Save and publish to update the public label.", kind: "toggle", required: false },
  { key: "slug", label: "URL slug", help: "The part after njpbs.org/posts/. Leave blank for a new draft to use its title. Use lowercase letters, numbers and hyphens. Publish a URL change to redirect old links.", kind: "text", required: false },
  // One free-text name became an ordered credit list in #1040: a story can have
  // two reporters, a staff credit, and a guest contributor, and the order is
  // editorial meaning. A registered credit stores the person, not the spelling of
  // their name, so a rename fixes every draft at once.
  { key: "credits", label: "Byline", help: "Credit the people who made this. Add staff by name, or add a custom credit such as NJ PBS staff.", kind: "storyCredits", required: false },
  { key: "categories", label: "Categories", help: "Add public topics that help readers find related posts. The first category is the main topic shown above the headline.", kind: "list", required: false },
  { key: "tags", label: "Tags", help: "Add topics that group this post with related work. The first tag appears beside the main category above the headline.", kind: "list", required: false }
];
var HERO_BACKGROUND_FIELDS = [
  { key: "heroBackgroundImage", label: "Hero background image", help: "Choose a decorative image behind the heading. Keep important information in the page text. Remove the image to restore the default background.", kind: "asset", required: false },
  { key: "heroBackgroundPosition", label: "Background crop position", help: "Choose which part of the image stays visible when it fills the hero.", kind: "select", required: false, options: [
    { value: "center", label: "Center" },
    { value: "top", label: "Top" },
    { value: "bottom", label: "Bottom" }
  ] }
];
var POST_HERO_IMAGE_FIELDS = [
  ...HERO_BACKGROUND_FIELDS,
  { key: "heroImage", label: "Lead image", help: "The image shown at the top and in listings.", kind: "asset", required: false },
  { key: "heroImageAlt", label: "Lead image alt text", help: "Describe what this image adds in this post.", kind: "text", required: false, recommended: true, requiredWhen: "heroImage", requiredUnless: "heroImageDecorative" },
  { key: "heroImageDecorative", label: "Mark lead image as decorative", help: "Turn this on only when the image adds no information. Leave the alt text empty.", kind: "toggle", required: false },
  { key: "heroImageCaption", label: "Lead image caption", help: "Add a description or photo credit beneath the lead image. This optional caption is separate from alt text.", kind: "text", multiline: true, required: false }
];
var RECORD_FIELDS = {
  program: [
    { key: "title", label: "Title", help: "The program or show name.", kind: "text", required: true },
    { key: "genre", label: "Genre", help: "The kind of program, for example news or nature.", kind: "text", required: false },
    { key: "description", label: "Synopsis", help: "A short description of the program, in one continuous editor.", kind: "richText", required: true },
    { key: "slug", label: "URL slug", help: "The part after njpbs.org/programs/. Leave blank for a new program to use its title. Publish a URL change to redirect old links.", kind: "text", required: false },
    { key: "keyArtAssetId", label: "Key art", help: "Choose an image from the media library.", kind: "asset", required: false },
    { key: "keyArtAlt", label: "Key art alt text", help: "Describe what the image adds to this program.", kind: "text", required: false, recommended: true, requiredWhen: "keyArtAssetId", requiredUnless: "keyArtDecorative" },
    { key: "keyArtDecorative", label: "Mark key art as decorative", help: "Use only when the image adds no information. Leave the alt text empty.", kind: "toggle", required: false },
    { key: "watchUrl", label: "Watch URL", help: "Link to this program on watch.njpbs.org.", kind: "url", required: false },
    { key: "memberOnly", label: "Members only", help: "Turn on if this program is for Passport members.", kind: "toggle", required: false }
  ],
  staff: [
    { key: "name", label: "Name", help: "The staff member's full name.", kind: "text", required: true },
    { key: "role", label: "Role", help: "Their title or role at NJ PBS.", kind: "text", required: true },
    { key: "bio", label: "Bio", help: "A short biography, written in one continuous editor.", kind: "richText", required: true }
  ],
  event: [
    { key: "title", label: "Title", help: "The event name.", kind: "text", required: true },
    { key: "slug", label: "URL slug", help: "The part after njpbs.org/events/. Leave blank on a new record to use its title. Published URL changes redirect old links.", kind: "text", required: false },
    { key: "startsAt", label: "Starts", help: "When the event begins, in New Jersey time.", kind: "datetime", required: true },
    { key: "endsAt", label: "Ends", help: "When the event ends, in New Jersey time, if it has a set end.", kind: "datetime", required: false },
    { key: "location", label: "Location", help: "Where the event takes place.", kind: "text", required: false },
    { key: "venueAddress", label: "Venue address", help: "Optional street address for an in-person event.", kind: "text", required: false },
    { key: "onlineUrl", label: "Online event URL", help: "Optional HTTPS link for joining online.", kind: "url", required: false },
    { key: "imageAssetId", label: "Event image", help: "Choose an image from the media library.", kind: "asset", required: false },
    { key: "imageAlt", label: "Event image alt text", help: "Describe what the image adds.", kind: "text", required: false, recommended: true, requiredWhen: "imageAssetId", requiredUnless: "imageDecorative" },
    { key: "imageDecorative", label: "Mark event image as decorative", help: "Use only when the image adds no information. Leave alt text empty.", kind: "toggle", required: false },
    { key: "registrationUrl", label: "Registration URL", help: "Use an HTTPS registration or ticket link.", kind: "url", required: false },
    { key: "registrationLabel", label: "Registration button label", help: "Defaults to Register.", kind: "text", required: false },
    { key: "isFree", label: "Free event", help: "Show this event as free.", kind: "toggle", required: false },
    { key: "priceText", label: "Price", help: "Optional ticket price or admission details.", kind: "text", required: false },
    { key: "description", label: "Details", help: "What to expect, in one continuous editor.", kind: "richText", required: true }
  ],
  sponsor: [
    { key: "name", label: "Name", help: "The sponsor's name, as it should appear on air and on the site.", kind: "text", required: true },
    { key: "href", label: "Website", help: "The sponsor's link.", kind: "url", required: true },
    { key: "logoAssetId", label: "Logo", help: "The sponsor's logo, shown with the on-air and on-site acknowledgment.", kind: "asset", required: false },
    { key: "logoAlt", label: "Logo alt text", help: "Name or describe the logo for this placement.", kind: "text", required: false, recommended: true, requiredWhen: "logoAssetId", requiredUnless: "logoDecorative" },
    { key: "logoDecorative", label: "Mark logo as decorative", help: "Use only when the visible sponsor name is beside the logo. Leave the alt text empty.", kind: "toggle", required: false },
    { key: "tier", label: "Tier", help: "A short label, such as Presenting sponsor.", kind: "text", required: false, maxLength: 80 },
    { key: "description", label: "Description", help: "A short plain-text description, up to 280 characters.", kind: "text", multiline: true, required: false, maxLength: 280 },
    { key: "activeFrom", label: "Active from", help: "The first day this sponsor may appear on the site.", kind: "date", required: false },
    { key: "activeUntil", label: "Active until", help: "The last day this sponsor may appear on the site.", kind: "date", required: false }
  ],
  newsletter: [
    { key: "title", label: "Name", help: "The newsletter's name, as a reader sees it.", kind: "text", required: true },
    { key: "summary", label: "Summary", help: "A short plain-text description shown in signup cards.", kind: "text", required: false, maxLength: 300 },
    { key: "frequency", label: "Frequency", help: "How often readers can expect it, for example Weekly.", kind: "text", required: false, maxLength: 60 },
    { key: "signupUrl", label: "Signup link", help: "A secure provider signup page. A newsletter without this link stays out of signup blocks.", kind: "url", required: false },
    { key: "imageAssetId", label: "Image", help: "Optional image from the media library.", kind: "asset", required: false },
    { key: "imageAlt", label: "Image alt text", help: "Describe the image unless it adds no information beside the newsletter title.", kind: "text", required: false, recommended: true, requiredWhen: "imageAssetId", requiredUnless: "imageDecorative" },
    { key: "imageDecorative", label: "Mark image as decorative", help: "Use when the visible newsletter title conveys the same information. Leave alt text empty.", kind: "toggle", required: false },
    { key: "body", label: "Description", help: "What the newsletter is and what a subscriber gets, in one continuous editor.", kind: "richText", required: true }
  ],
  post: [
    ...POST_BASIC_FIELDS,
    ...CONTENT_LINK_FIELDS,
    ...POST_EXCERPT_FIELDS,
    ...POST_DATE_FIELDS,
    ...POST_ORGANIZATION_FIELDS,
    ...POST_HERO_IMAGE_FIELDS,
    ...POST_SEARCH_FIELDS,
    ...POST_SOCIAL_FIELDS
  ]
};
var CONTENT_FREE_BLOCKS = Object.freeze(
  BLOCK_TYPES.filter((t) => BLOCK_FIELDS[t].length === 0)
);

// packages/content-core/src/field-path.ts
function segments(field) {
  return [...field.path ?? [], field.key];
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readFieldValue(values, field) {
  const path = segments(field);
  let cursor = values;
  for (const key of path) {
    if (!isRecord2(cursor)) return void 0;
    cursor = cursor[key];
  }
  return cursor;
}

// packages/content-core/src/field-validation.ts
function isFieldFilled(field, value) {
  switch (field.kind) {
    // Read a datetime through the same projection the control uses, so a value the
    // control renders as blank is not simultaneously reported as filled. A legacy
    // event holds "2026-08-01" in startsAt, which is a non-blank string and would
    // otherwise satisfy required while the editor stares at an empty field with no
    // message next to it (#509).
    case "datetime":
      return instantToStationLocal(value) !== "";
    case "toggle":
      return true;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "richText":
      return isRichTextDoc(value) && !richTextIsEmpty(value);
    case "list":
    // A byline is filled when it holds at least one credit (#1040). It is an
    // optional field today, so this only decides whether a "no byline yet" state
    // counts as answered, never whether a post can be saved.
    case "storyCredits":
      return Array.isArray(value) && value.length > 0;
    // A select whose options are declared is filled only by one of them. A select with NO
    // declared option list has its choices supplied by the surface that renders it (the
    // dynamic-shelf pin pickers, filtered to the block's chosen source), so completeness
    // falls back to "holds something", the same reading every other field gets.
    case "select":
      return field.options ? field.options.some((option) => Object.is(option.value, value)) : typeof value === "string" && value.trim().length > 0;
    default:
      return typeof value === "string" && value.trim().length > 0;
  }
}
function fieldHasAnyValue(field, value) {
  if (typeof value === "string") return value.length > 0;
  return isFieldFilled(field, value);
}
function fieldIsRequired(field, siblings) {
  if (!field.required) return false;
  return conditionApplies(field, siblings);
}
function conditionApplies(field, siblings) {
  if (field.requiredWhen && isBlank(readFieldValue(siblings, { ...field, key: field.requiredWhen }))) {
    return false;
  }
  return !releaseIsOn(field, siblings);
}
function releaseIsOn(field, siblings) {
  if (!field.requiredUnless) return false;
  return readFieldValue(siblings, { ...field, key: field.requiredUnless }) === true;
}
function releasedFieldContradiction(field, value, context = {}) {
  if (!field.requiredUnless) return null;
  if (!releaseIsOn(field, context.siblings ?? {})) return null;
  if (!fieldHasAnyValue(field, value)) return null;
  const release = context.fields?.find((other) => other.key === field.requiredUnless);
  return `${field.label} must be empty while ${release ? release.label : field.requiredUnless} is on.`;
}
var SAFE_URL_MESSAGE = "must use http, https, mailto, tel, or a relative link.";
function richTextHasUnsafeLink(value) {
  if (!isRichTextDoc(value)) return false;
  const nodeHasUnsafeLink = (node) => Boolean(
    node.marks?.some(
      (mark) => mark.type === "link" && !isSafeHref(mark.attrs?.href)
    ) || node.content?.some(nodeHasUnsafeLink)
  );
  return nodeHasUnsafeLink(value);
}
function isBlank(value) {
  return value === void 0 || value === null || typeof value === "string" && value.trim().length === 0;
}
var STORED_VALUE_QUOTE_LIMIT = 40;
function unreadableDatetimeMessage(field, value) {
  if (field.kind !== "datetime") return null;
  if (isBlank(value) || instantToStationLocal(value) !== "") return null;
  const tail = "which is not a date and time this control can show. Clear it or set a new one.";
  if (typeof value !== "string") {
    return `${field.label} holds a value that is not a date and time this control can show. Clear it or set a new one.`;
  }
  const stored = value.length > STORED_VALUE_QUOTE_LIMIT ? `${value.slice(0, STORED_VALUE_QUOTE_LIMIT)}\u2026` : value;
  return `${field.label} holds "${stored}", ${tail}`;
}
function editorFieldValidationMessage(field, value, context = {}) {
  const siblings = context.siblings ?? {};
  if (field.key === "contentLinkUrl") return contentLinkError(siblings);
  const contradiction = releasedFieldContradiction(field, value, context);
  if (contradiction) return contradiction;
  if (field.kind === "select" && field.options !== void 0 && !isBlank(value) && !field.options.some((option) => Object.is(option.value, value))) {
    return `${field.label} must use one of the available choices.`;
  }
  if (!context.allowIncomplete && field.kind === "list" && typeof field.minItems === "number" && Array.isArray(value) && value.length < field.minItems) {
    return `${field.label} must contain at least ${field.minItems}. Add ${field.minItems - value.length} to save.`;
  }
  if (field.kind === "list" && typeof field.maxItems === "number" && Array.isArray(value) && value.length > field.maxItems) {
    return `${field.label} can hold at most ${field.maxItems}. Remove ${value.length - field.maxItems} to save.`;
  }
  const unreadableDatetime = unreadableDatetimeMessage(field, value);
  if (unreadableDatetime) return unreadableDatetime;
  if (field.kind === "number" && !isBlank(value)) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return `${field.label} must be a whole number.`;
    }
    if (typeof field.min === "number" && value < field.min) {
      return `${field.label} must be at least ${field.min}.`;
    }
    if (typeof field.max === "number" && value > field.max) {
      return `${field.label} can be at most ${field.max}.`;
    }
    const pairedValue = field.aspectRatioWith ? siblings[field.aspectRatioWith] : void 0;
    if (typeof pairedValue === "number" && typeof field.minAspectRatio === "number" && typeof field.maxAspectRatio === "number" && (value / pairedValue < field.minAspectRatio || value / pairedValue > field.maxAspectRatio)) {
      const pairedLabel = context.fields?.find((candidate) => candidate.key === field.aspectRatioWith)?.label ?? field.aspectRatioWith;
      return `${field.label} and ${pairedLabel} must use a video ratio from 9:16 through 21:9.`;
    }
  }
  if (!context.allowIncomplete && fieldIsRequired(field, siblings) && !isFieldFilled(field, value)) {
    return `${field.label} is required.`;
  }
  if (field.kind === "richText" && richTextHasUnsafeLink(value)) {
    return `${field.label} contains a link that ${SAFE_URL_MESSAGE}`;
  }
  if (field.kind === "date" && !isBlank(value) && !isCalendarDay(value)) {
    return `${field.label} must be a real calendar day.`;
  }
  if (typeof field.maxLength === "number" && typeof value === "string" && value.length > field.maxLength) {
    return `${field.label} can be at most ${field.maxLength} characters. Shorten it to save.`;
  }
  if (field.kind !== "url") return null;
  if (field.requireHttps && value !== "" && !isExactHttpsUrl(value, field.maxLength)) {
    return `${field.label} must be a secure HTTPS link.`;
  }
  if (field.key === "signupUrl" && !isBlank(value)) {
    try {
      const url = new URL(String(value));
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || /[\u0000-\u001F\u007F]/.test(String(value))) {
        return `${field.label} must be a secure HTTPS link.`;
      }
    } catch {
      return `${field.label} must be a secure HTTPS link.`;
    }
  }
  if (!isBlank(value) && !isSafeHref(value)) {
    return `${field.label} ${SAFE_URL_MESSAGE}`;
  }
  if (!context.allowIncomplete && field.namedBy && !isBlank(value) && field.namedBy.every((key) => isBlank(readFieldValue(siblings, { ...field, key })))) {
    const names = field.namedBy.map(
      (key) => context.fields?.find((other) => other.key === key)?.label.toLowerCase() ?? key
    );
    return `${field.label} needs ${names.join(" or ")} to name it for screen readers.`;
  }
  return null;
}
function missingBlockContent(fields2, data, context = {}) {
  return walkBlockFields(fields2, data, editorFieldValidationMessage, context);
}
function walkBlockFields(fields2, data, messageFor, context = {}) {
  const messages = [];
  for (const field of fields2) {
    const message = messageFor(field, readFieldValue(data, field), {
      ...context,
      siblings: data,
      fields: fields2
    });
    if (message) messages.push(message);
  }
  for (const field of fields2) {
    if (field.kind !== "list" || !field.itemFields) continue;
    const items = Array.isArray(data[field.key]) ? data[field.key] : [];
    items.forEach((item, index) => {
      const itemData = item ?? {};
      for (const sub of field.itemFields) {
        const message = messageFor(sub, readFieldValue(itemData, sub), {
          ...context,
          siblings: itemData,
          fields: field.itemFields
        });
        if (message) messages.push(`${field.label} ${index + 1}: ${message}`);
      }
    });
  }
  return messages;
}

// packages/content-core/src/block-content-validation.ts
function blockContentError(blocks, { complete = true } = {}) {
  const visible = new Set(visibleLayoutBlocks(blocks).map((block) => block.id));
  for (const block of blocks) {
    if (block.type === "election_results") {
      const error = electionResultsError(block.data, complete && visible.has(block.id));
      if (error) return error;
    }
    const fields2 = editorFieldsForBlock(block.type);
    if (block.type === "content_shelf") {
      const presentation = fields2.find((field) => field.key === "presentation");
      if (presentation) presentation.options = CONTENT_SHELF_PRESENTATIONS.map((value) => ({ value, label: value }));
      const itemLimit = fields2.find((field) => field.key === "itemLimit");
      if (itemLimit) itemLimit.options = CONTENT_SHELF_ITEM_LIMITS.map((value) => ({
        value,
        label: `${value} items`
      }));
    }
    const errors = missingBlockContent(fields2, block.data, {
      allowIncomplete: !complete || !visible.has(block.id) || block.type === "newsletter_signup" && block.section === "home-newsletter" && block.data.newsletterIds.length === 0
    });
    if (errors.length) return errors[0];
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  blockContentError
});
