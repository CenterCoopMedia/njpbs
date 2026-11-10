// Generated from packages/content-core/src/data-hub-reporting-sources.ts.
// Regenerate with: node scripts/generate-data-hub-reporting-sources.mjs
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

// packages/content-core/src/data-hub-reporting-sources.ts
var data_hub_reporting_sources_exports = {};
__export(data_hub_reporting_sources_exports, {
  parseDataHubSources: () => parseDataHubSources,
  parseReportingStory: () => parseReportingStory,
  parseSpotlightReportingSnapshot: () => parseSpotlightReportingSnapshot,
  projectReportingPost: () => projectReportingPost,
  reportingMappings: () => reportingMappings,
  reportingPinsKey: () => reportingPinsKey,
  reportingQueryKey: () => reportingQueryKey,
  spotlightReportingFor: () => spotlightReportingFor
});
module.exports = __toCommonJS(data_hub_reporting_sources_exports);

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
  const instant2 = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const roundTrip = new Date(instant2);
  if (roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() !== mo - 1 || roundTrip.getUTCDate() !== d || roundTrip.getUTCHours() !== h || roundTrip.getUTCMinutes() !== mi || roundTrip.getUTCSeconds() !== s) {
    return null;
  }
  return instant2;
}

// packages/content-core/src/publish-gate.ts
function isPublishable(record, now) {
  const visible = record.publiclyVisible === true || record.publiclyVisible === void 0 && record.status === "published";
  if (!visible || record.deleted) return false;
  const snapshotTime = record.status !== "published" && typeof record.published === "object" && record.published !== null && "publishedAt" in record.published ? record.published.publishedAt : record.publishAt;
  if (typeof snapshotTime !== "string") return false;
  const publishAt = parsePublishInstant(snapshotTime);
  return publishAt !== null && publishAt <= now.getTime();
}

// packages/content-core/src/station-time.ts
var STATION_TIME_ZONE = "America/New_York";
var LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}
function zonedParts(instant2, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(instant2));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  const fields = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
  if (Object.values(fields).some((value) => !value)) {
    throw new Error(`Could not format a date in ${timeZone}.`);
  }
  return fields;
}
function offsetMinutes(instant2, timeZone) {
  const parts = zonedParts(instant2, timeZone);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asIfUtc - instant2) / 6e4);
}
function zonedLocalInstants(date, time, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2));
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set(
    [-24, 0, 24].map(
      (hours) => offsetMinutes(localAsUtc + hours * 36e5, timeZone)
    )
  );
  const expected = `${date}T${time.slice(0, 2)}:${time.slice(2)}:00`;
  return Array.from(offsets).map((offset) => localAsUtc - offset * 6e4).filter((instant2) => {
    const parts = zonedParts(instant2, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` === expected;
  }).sort((a, b) => a - b);
}
function instantToStationLocal(value, timeZone = STATION_TIME_ZONE) {
  if (typeof value !== "string") return "";
  const instant2 = parsePublishInstant(value);
  if (instant2 === null) return "";
  const parts = zonedParts(instant2, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function stationLocalToInstant(local, timeZone = STATION_TIME_ZONE) {
  const match = typeof local === "string" ? local.match(LOCAL_DATE_TIME) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  if (year < 1e3) return null;
  const check = new Date(asIfUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) {
    return null;
  }
  const candidates = zonedLocalInstants(
    `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    `${pad(hour)}${pad(minute)}`,
    timeZone
  );
  if (candidates.length > 0) {
    return new Date(candidates[0]).toISOString();
  }
  const before = offsetMinutes(asIfUtc - 24 * 36e5, timeZone);
  return new Date(asIfUtc - before * 6e4).toISOString();
}

// packages/content-core/src/editorial-dates.ts
var EDITORIAL_DATE_SOURCES = Object.freeze([
  "firstPublish",
  "backdated",
  "legacy"
]);
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
var CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
function isCalendarDay(value) {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) return false;
  const parsed = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function stationCalendarDay(value, timeZone = STATION_TIME_ZONE) {
  const local = instantToStationLocal(value, timeZone);
  return local === "" ? null : local.slice(0, 10);
}
function resolveEditorialDateSource(record) {
  const stored = record?.editorialDateSource;
  if (typeof stored === "string" && EDITORIAL_DATE_SOURCES.includes(stored)) {
    return stored;
  }
  return nonEmptyString(record?.date) ? "legacy" : "firstPublish";
}
function resolveDisplayDate(record, timeZone = STATION_TIME_ZONE) {
  if (!record) return null;
  const source = resolveEditorialDateSource(record);
  if (source === "firstPublish") {
    return stationCalendarDay(record.firstPublishedAt, timeZone);
  }
  const stored = nonEmptyString(record.date);
  if (stored && isCalendarDay(stored)) return stored;
  return stationCalendarDay(record.firstPublishedAt, timeZone);
}
function stationDayStartInstant(day, timeZone = STATION_TIME_ZONE) {
  if (!isCalendarDay(day)) return null;
  const midnight = stationLocalToInstant(`${day}T00:00`, timeZone);
  return midnight === null ? null : parsePublishInstant(midnight);
}
function editorialSortInstant(record, timeZone = STATION_TIME_ZONE) {
  if (!record) return null;
  const firstPublishedAt = typeof record.firstPublishedAt === "string" ? record.firstPublishedAt : "";
  if (resolveEditorialDateSource(record) === "firstPublish") {
    return parsePublishInstant(firstPublishedAt);
  }
  const day = resolveDisplayDate(record, timeZone);
  if (day !== null && stationCalendarDay(firstPublishedAt, timeZone) === day) {
    return parsePublishInstant(firstPublishedAt);
  }
  return day === null ? null : stationDayStartInstant(day, timeZone);
}

// packages/content-core/src/data-hub-reporting.ts
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

// packages/content-core/src/data-hub-reporting-sources.ts
function reportingMappings(config) {
  return [...Object.values(config.figures), ...config.featured.inheritFigure ? [] : [config.featured.mapping]];
}
function reportingQueryKey(mapping) {
  parseReportingMapping(mapping);
  return `t:${mapping.spotlight.tags.map((term) => term.id).sort((a, b) => a - b).join(",")};c:${mapping.spotlight.categories.map((term) => term.id).sort((a, b) => a - b).join(",")};x:${mapping.hidden.filter((item) => item.source === "spotlight").map((item) => Number(item.id)).sort((a, b) => a - b).join(",")}`;
}
var reportingPinsKey = (mappings) => [...new Set(mappings.flatMap((mapping) => mapping.pins.filter((pin) => pin.source === "spotlight").map((pin) => Number(pin.id))))].sort((a, b) => a - b).join(",");
function fail2() {
  throw new Error("Invalid retained Data Hub reporting.");
}
function object2(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail2();
  if (keys && (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)))) fail2();
}
function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function text2(value, max) {
  return typeof value === "string" && value.trim() === value && !!value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function parseReportingStory(raw) {
  object2(raw);
  const keys = ["source", "id", "href", "title", "publishedAt", "tags", "categories"];
  for (const optional of ["byline", "canonicalHref"]) if (Object.hasOwn(raw, optional)) keys.push(optional);
  object2(raw, keys);
  reportingIdentity({ source: raw.source, id: raw.id });
  if (!text2(raw.title, 300) || !instant(raw.publishedAt) || reportingStoryUrl(raw.href) !== raw.href || (raw.source === "posts" ? !String(raw.href).startsWith("https://njpbs.org/") : !String(raw.href).startsWith("https://www.njspotlightnews.org/")) || raw.byline !== void 0 && !text2(raw.byline, 300) || raw.canonicalHref !== void 0 && reportingStoryUrl(raw.canonicalHref) !== raw.canonicalHref) fail2();
  for (const kind of ["tags", "categories"]) {
    const terms = raw[kind];
    if (!Array.isArray(terms) || terms.length > 500 || new Set(terms).size !== terms.length || terms.some((term) => raw.source === "posts" ? !text2(term, 200) : !Number.isSafeInteger(term) || term < 1)) fail2();
  }
  return structuredClone(raw);
}
function parseSpotlightReportingSnapshot(raw) {
  if (raw === void 0) return void 0;
  object2(raw, ["schemaVersion", "queries", "pins"]);
  if (raw.schemaVersion !== 1 || new TextEncoder().encode(JSON.stringify(raw)).length > 2 * 1024 * 1024) fail2();
  object2(raw.queries);
  const keys = Object.keys(raw.queries);
  if (keys.length > 19 || keys.some((key) => key.length > 600 || !/^t:[0-9,]*;c:[0-9,]*;x:[0-9,]*$/.test(key))) fail2();
  function query(value, pin = false) {
    object2(value, pin ? ["key", "checkedAt", "failed", "stories"] : ["checkedAt", "failed", "stories"]);
    if (value.checkedAt !== null && !instant(value.checkedAt) || typeof value.failed !== "boolean" || !Array.isArray(value.stories) || value.stories.length > (pin ? 57 : 25)) fail2();
    const rows = value.stories.map(parseReportingStory);
    if (rows.some((story) => story.source !== "spotlight") || new Set(rows.map((story) => story.id)).size !== rows.length || rows.length && value.checkedAt === null) fail2();
    if (pin && (typeof value.key !== "string" || value.key.length > 1e3 || !/^[0-9,]*$/.test(value.key))) fail2();
  }
  Object.values(raw.queries).forEach((value) => query(value));
  query(raw.pins, true);
  return structuredClone(raw);
}
function spotlightReportingFor(mapping, snapshot) {
  const query = snapshot?.queries[reportingQueryKey(mapping)];
  const pinIds = new Set(mapping.pins.filter((pin) => pin.source === "spotlight").map((pin) => pin.id));
  const hasQuery = mapping.spotlight.tags.length + mapping.spotlight.categories.length > 0;
  return {
    checkedAt: hasQuery ? query?.checkedAt ?? null : pinIds.size ? snapshot?.pins.checkedAt ?? null : null,
    failed: Boolean(hasQuery && query?.failed || pinIds.size && snapshot?.pins.failed),
    stories: [...query?.stories ?? [], ...snapshot?.pins.stories.filter((story) => pinIds.has(story.id)) ?? []].filter((story, index, rows) => rows.findIndex((row) => row.id === story.id) === index)
  };
}
function projectReportingPost(id, document, cutoffAt) {
  if (!isPublishable(document, new Date(cutoffAt))) return null;
  const published = document.published;
  if (!published || typeof published !== "object" || Array.isArray(published)) return null;
  const snapshot = published;
  const metadata = snapshot.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const data = metadata;
  if (data.type !== "post" || !Number.isSafeInteger(snapshot.sourceVersion) || Number(snapshot.sourceVersion) < 1 || !Number.isSafeInteger(document.version) || Number(snapshot.sourceVersion) > Number(document.version) || Number.isSafeInteger(document.publicSourceVersion) && Number(snapshot.sourceVersion) < Number(document.publicSourceVersion)) return null;
  const at = editorialSortInstant(data);
  if (at === null || at > cutoffAt) return null;
  const byline = Array.isArray(data.credits) && data.credits.length <= 12 ? data.credits.flatMap((credit) => {
    if (!credit || typeof credit !== "object") return [];
    const name = credit.kind === "registered" ? credit.displayName : credit.kind === "custom" ? credit.name : null;
    return text2(name, 120) ? [name] : [];
  }).join(", ") : "";
  try {
    return parseReportingStory({
      source: "posts",
      id,
      href: `https://njpbs.org/posts/${data.slug}/`,
      title: data.title,
      publishedAt: new Date(at).toISOString(),
      ...byline && byline.length <= 300 ? { byline } : {},
      tags: data.tags ?? [],
      categories: data.categories ?? []
    });
  } catch {
    return null;
  }
}
function parseDataHubSources(raw, now) {
  if (raw === void 0) return void 0;
  if (!Number.isFinite(now)) fail2();
  object2(raw);
  object2(raw, Object.hasOwn(raw, "spotlight") ? ["cutoffAt", "posts", "spotlight"] : ["cutoffAt", "posts"]);
  if (!instant(raw.cutoffAt) || Date.parse(raw.cutoffAt) > now || !Array.isArray(raw.posts) || raw.posts.length > 1e3 || new TextEncoder().encode(JSON.stringify(raw)).length > 3 * 1024 * 1024) fail2();
  const posts = raw.posts.map(parseReportingStory);
  if (posts.some((story) => story.source !== "posts" || Date.parse(story.publishedAt) > Date.parse(String(raw.cutoffAt))) || new Set(posts.map((story) => story.id)).size !== posts.length || new Set(posts.map((story) => story.href)).size !== posts.length) fail2();
  const spotlight = parseSpotlightReportingSnapshot(raw.spotlight);
  return { cutoffAt: raw.cutoffAt, posts, ...spotlight ? { spotlight } : {} };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  parseDataHubSources,
  parseReportingStory,
  parseSpotlightReportingSnapshot,
  projectReportingPost,
  reportingMappings,
  reportingPinsKey,
  reportingQueryKey,
  spotlightReportingFor
});
