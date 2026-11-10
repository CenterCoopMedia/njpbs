// Generated from packages/content-core/src/data-hub-reporting.ts.
// Regenerate with: node scripts/generate-data-hub-reporting.mjs
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

// packages/content-core/src/data-hub-reporting.ts
var data_hub_reporting_exports = {};
__export(data_hub_reporting_exports, {
  DATA_HUB_FIGURES: () => DATA_HUB_FIGURES,
  emptyDataHubReporting: () => emptyDataHubReporting,
  emptyReportingMapping: () => emptyReportingMapping,
  parseDataHubReporting: () => parseDataHubReporting,
  parseReportingMapping: () => parseReportingMapping,
  reportingIdentity: () => reportingIdentity,
  reportingIdentityKey: () => reportingIdentityKey,
  reportingStoryUrl: () => reportingStoryUrl,
  selectReportingStories: () => selectReportingStories
});
module.exports = __toCommonJS(data_hub_reporting_exports);
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
var emptyReportingMapping = () => ({
  posts: { tags: [], categories: [] },
  spotlight: { tags: [], categories: [] },
  pins: [],
  hidden: []
});
var emptyDataHubReporting = () => ({ schemaVersion: 1, figures: {}, featured: { inheritFigure: true } });
function fail() {
  throw new Error("Check the Data Hub reporting terms, story selections and limits.");
}
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail();
}
function text(value, max) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
}
function reportingIdentity(value, pin = false) {
  const keys = ["source", "id"];
  if (pin && value && typeof value === "object" && Object.hasOwn(value, "note")) keys.push("note");
  if (value && typeof value === "object" && Object.hasOwn(value, "canonicalHref")) keys.push("canonicalHref");
  object(value, keys);
  if (!["posts", "spotlight"].includes(String(value.source))) fail();
  if (typeof value.id !== "string" || (value.source === "posts" ? !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) : !/^[1-9]\d{0,14}$/.test(value.id))) fail();
  if (value.note !== void 0) text(value.note, 500);
  if (value.canonicalHref !== void 0 && reportingStoryUrl(value.canonicalHref) === null) fail();
}
var reportingIdentityKey = (value) => `${value.source}:${value.id}`;
function parseReportingMapping(value) {
  object(value, ["posts", "spotlight", "pins", "hidden"]);
  for (const source of ["posts", "spotlight"]) {
    const terms = value[source];
    object(terms, ["tags", "categories"]);
    for (const taxonomy of ["tags", "categories"]) {
      const list = terms[taxonomy];
      if (!Array.isArray(list) || list.length > 5) fail();
      const keys = list.map((term) => {
        if (source === "posts") {
          text(term, 200);
          if (/^format:/i.test(term)) fail();
          return term;
        }
        object(term, ["id", "slug", "label"]);
        if (!Number.isSafeInteger(term.id) || Number(term.id) < 1) fail();
        text(term.slug, 200);
        text(term.label, 200);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(term.slug))) fail();
        return term.id;
      });
      if (new Set(keys).size !== keys.length) fail();
    }
  }
  for (const field of ["pins", "hidden"]) {
    const list = value[field];
    if (!Array.isArray(list) || list.length > (field === "pins" ? 3 : 20)) fail();
    list.forEach((item) => reportingIdentity(item, field === "pins"));
    if (new Set(list.map(reportingIdentityKey)).size !== list.length) fail();
  }
  const mapping = value;
  if (mapping.pins.some((pin) => mapping.hidden.some((hidden) => reportingIdentityKey(pin) === reportingIdentityKey(hidden)))) fail();
  return structuredClone(mapping);
}
function parseDataHubReporting(value) {
  if (value === void 0) return void 0;
  object(value, ["schemaVersion", "figures", "featured"]);
  if (value.schemaVersion !== 1 || !value.figures || typeof value.figures !== "object" || Array.isArray(value.figures)) fail();
  if (Object.keys(value.figures).some((key) => !Object.hasOwn(DATA_HUB_FIGURES, key))) fail();
  for (const mapping of Object.values(value.figures)) parseReportingMapping(mapping);
  const featured = value.featured;
  object(featured, featured && typeof featured === "object" && featured.inheritFigure === true ? ["inheritFigure"] : ["inheritFigure", "mapping"]);
  if (featured.inheritFigure !== true) {
    if (featured.inheritFigure !== false) fail();
    parseReportingMapping(featured.mapping);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024) fail();
  return structuredClone(value);
}
function reportingStoryUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\\u0000-\u001f\u007f%]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    const host = url.hostname.replace(/^www\./, "");
    if (host !== "njpbs.org" && host !== "njspotlightnews.org") return null;
    if (host === "njpbs.org" ? !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname) : !/^\/\d{4}\/\d{2}\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(url.pathname)) return null;
    url.hostname = host === "njpbs.org" ? host : `www.${host}`;
    return url.href;
  } catch {
    return null;
  }
}
function selectReportingStories(mapping, candidates, now) {
  parseReportingMapping(mapping);
  const matches = (story) => {
    const terms = mapping[story.source];
    return ["tags", "categories"].some((kind) => terms[kind].some((term) => story[kind].includes(typeof term === "string" ? term : term.id)));
  };
  const canonical = (story) => reportingStoryUrl(story.canonicalHref) ?? reportingStoryUrl(story.href);
  const hiddenUrls = new Set(mapping.hidden.flatMap((hidden) => {
    const href = reportingStoryUrl(hidden.canonicalHref) ?? candidates.find((story) => reportingIdentityKey(story) === reportingIdentityKey(hidden))?.canonicalHref ?? candidates.find((story) => reportingIdentityKey(story) === reportingIdentityKey(hidden))?.href;
    return href ? [reportingStoryUrl(href)] : [];
  }));
  const available = candidates.filter((story) => reportingStoryUrl(story.href) && story.title.trim() && story.title.length <= 300 && Number.isFinite(Date.parse(story.publishedAt)) && Date.parse(story.publishedAt) <= now && !hiddenUrls.has(canonical(story)) && !mapping.hidden.some((hidden) => reportingIdentityKey(hidden) === reportingIdentityKey(story)));
  const pins = mapping.pins.flatMap((pin) => {
    const pinUrl = reportingStoryUrl(pin.canonicalHref) ?? candidates.find((story2) => reportingIdentityKey(story2) === reportingIdentityKey(pin))?.canonicalHref ?? candidates.find((story2) => reportingIdentityKey(story2) === reportingIdentityKey(pin))?.href;
    const story = available.find((story2) => reportingIdentityKey(story2) === reportingIdentityKey(pin) || pinUrl && canonical(story2) === reportingStoryUrl(pinUrl));
    return story ? [{ ...story, pinnedBy: pin, ...pin.note ? { note: pin.note } : {} }] : [];
  });
  const automatic = available.filter(matches).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || reportingIdentityKey(a).localeCompare(reportingIdentityKey(b)));
  const eligible = [...pins, ...automatic];
  const result = [];
  for (const story of eligible) {
    const key = canonical(story);
    if (result.some((item) => canonical(item) === key)) continue;
    const local = eligible.find((item) => item.source === "posts" && canonical(item) === key);
    result.push({ ...local ?? story, ...story.note ? { note: story.note } : {}, ...story.pinnedBy ? { pinnedBy: story.pinnedBy } : {} });
    if (result.length === 3) break;
  }
  return result;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DATA_HUB_FIGURES,
  emptyDataHubReporting,
  emptyReportingMapping,
  parseDataHubReporting,
  parseReportingMapping,
  reportingIdentity,
  reportingIdentityKey,
  reportingStoryUrl,
  selectReportingStories
});
