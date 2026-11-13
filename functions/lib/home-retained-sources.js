// Generated from site/src/lib/home-retained-sources-entry.ts.
// Regenerate with: node scripts/generate-home-retained-sources.mjs
"use strict";
const __generatedReaderModuleUrl = require("node:url").pathToFileURL(__filename).href;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/content-core/src/publish-instant.ts
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
var UTC_INSTANT;
var init_publish_instant = __esm({
  "packages/content-core/src/publish-instant.ts"() {
    UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
  }
});

// packages/content-core/src/station-time.ts
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
  const fields4 = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second")
  };
  if (Object.values(fields4).some((value) => !value)) {
    throw new Error(`Could not format a date in ${timeZone}.`);
  }
  return fields4;
}
function instantToStationLocal(value, timeZone = STATION_TIME_ZONE) {
  if (typeof value !== "string") return "";
  const instant2 = parsePublishInstant(value);
  if (instant2 === null) return "";
  const parts = zonedParts(instant2, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
var STATION_TIME_ZONE;
var init_station_time = __esm({
  "packages/content-core/src/station-time.ts"() {
    init_publish_instant();
    STATION_TIME_ZONE = "America/New_York";
  }
});

// site/src/lib/schedule-input-shape.mjs
var init_schedule_input_shape = __esm({
  "site/src/lib/schedule-input-shape.mjs"() {
    "use strict";
  }
});

// site/src/lib/schedule-input.ts
function isScheduleFixture(value) {
  return typeof value === "object" && value !== null && "fixture" in value;
}
var init_schedule_input = __esm({
  "site/src/lib/schedule-input.ts"() {
    "use strict";
    init_schedule_input_shape();
  }
});

// packages/content-core/src/broadcast-date.ts
function isBroadcastDate(value) {
  if (typeof value !== "string") return false;
  const match = value.match(BROADCAST_DATE_PATTERN);
  if (!match) return false;
  const [, year, month, day] = match;
  const asDate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day))
  );
  return asDate.getUTCFullYear() === Number(year) && asDate.getUTCMonth() + 1 === Number(month) && asDate.getUTCDate() === Number(day);
}
function assertBroadcastDate(value) {
  if (!isBroadcastDate(value)) {
    throw new Error(`Invalid broadcast date: ${value}`);
  }
}
var BROADCAST_DATE_PATTERN;
var init_broadcast_date = __esm({
  "packages/content-core/src/broadcast-date.ts"() {
    BROADCAST_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
  }
});

// site/src/lib/broadcast-date.ts
var init_broadcast_date2 = __esm({
  "site/src/lib/broadcast-date.ts"() {
    "use strict";
    init_broadcast_date();
  }
});

// packages/content-core/src/schedule-now-next.ts
var init_schedule_now_next = __esm({
  "packages/content-core/src/schedule-now-next.ts"() {
  }
});

// packages/content-core/src/schedule-clock.ts
function scheduleDateKey(at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(at).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function resolveScheduleClock(realNow, mockTime) {
  if (mockTime) {
    const match = mockTime.match(ABSOLUTE_ISO_TIMESTAMP);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const calendarDate = /* @__PURE__ */ new Date(0);
      calendarDate.setUTCHours(0, 0, 0, 0);
      calendarDate.setUTCFullYear(year, month - 1, day);
      const parsed = Date.parse(mockTime);
      if (calendarDate.getUTCFullYear() === year && calendarDate.getUTCMonth() === month - 1 && calendarDate.getUTCDate() === day && !Number.isNaN(parsed)) {
        return new Date(parsed);
      }
    }
  }
  return new Date(realNow.getTime());
}
var SCHEDULE_TIME_ZONE, ABSOLUTE_ISO_TIMESTAMP;
var init_schedule_clock = __esm({
  "packages/content-core/src/schedule-clock.ts"() {
    init_schedule_now_next();
    init_station_time();
    SCHEDULE_TIME_ZONE = STATION_TIME_ZONE;
    ABSOLUTE_ISO_TIMESTAMP = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  }
});

// site/src/lib/schedule-view.ts
var init_schedule_view = __esm({
  "site/src/lib/schedule-view.ts"() {
    "use strict";
    init_schedule_clock();
    init_schedule_clock();
  }
});

// site/src/lib/schedule-feed.ts
var TVSS_TIME_ZONE;
var init_schedule_feed = __esm({
  "site/src/lib/schedule-feed.ts"() {
    "use strict";
    init_broadcast_date2();
    init_station_time();
    TVSS_TIME_ZONE = STATION_TIME_ZONE;
  }
});

// site/src/lib/schedule-export.ts
function formatScheduleExportInstant(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TVSS_TIME_ZONE,
    timeZoneName: "short"
  }).format(new Date(value));
}
function formatScheduleExportDate(date2) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(/* @__PURE__ */ new Date(`${date2}T12:00:00Z`));
}
function sourceState(days, exportedAt) {
  const correctedDays = days.filter((day) => day.sourceRevision);
  const pbsDays = days.filter((day) => !day.sourceRevision);
  const revisionDates = [...new Set(correctedDays.map((day) => day.sourceRevision))].sort();
  const sourceRevisionDates = revisionDates.filter(isBroadcastDate);
  const checkedTimes = pbsDays.flatMap(
    (day) => day.sourceCheckedAt ? [Date.parse(day.sourceCheckedAt)] : []
  );
  const correctedDayCount = correctedDays.length;
  const pbsCheckedDayCount = checkedTimes.length;
  const unknownDayCount = pbsDays.length - pbsCheckedDayCount;
  const correctionText = sourceRevisionDates.map((revision) => {
    const count = correctedDays.filter((day) => day.sourceRevision === revision).length;
    return `${count} corrected listing ${count === 1 ? "date comes" : "dates come"} from the NJ PBS replacement lineup dated ${formatScheduleExportDate(revision)}.`;
  }).join(" ");
  let sourceCheckedAt = null;
  let sourceStatus;
  let freshnessText;
  if (revisionDates.some((date2) => !isBroadcastDate(date2)) || checkedTimes.some((time) => !Number.isFinite(time) || time > exportedAt.getTime())) {
    sourceStatus = "invalid";
    freshnessText = "Source evidence is invalid or later than the export. Source freshness is unknown; listings may have changed.";
  } else {
    if (checkedTimes.length) sourceCheckedAt = new Date(Math.min(...checkedTimes)).toISOString();
    if (!days.length || unknownDayCount > 0) {
      sourceStatus = "unknown";
      freshnessText = days.length ? `Source freshness is unknown for ${unknownDayCount} listing ${unknownDayCount === 1 ? "date" : "dates"} with neither a PBS check nor a correction revision. Listings may have changed.` : "No listing dates were supplied. Source freshness is unknown.";
    } else if (!pbsCheckedDayCount) {
      sourceStatus = "corrected";
      freshnessText = "PBS retrieval checks do not apply to these corrected dates. Listings may change.";
    } else if (exportedAt.getTime() - Math.min(...checkedTimes) > SCHEDULE_STALE_AFTER_MS) {
      sourceStatus = "stale";
      freshnessText = "At least one PBS date was last retrieved more than 20 hours before export. Listings may have changed.";
    } else {
      sourceStatus = "fresh";
      freshnessText = "Every supplied PBS date was retrieved within 20 hours of export. Listings may still change.";
    }
  }
  const sourceCheckText = sourceCheckedAt ? `Last checked with PBS: ${formatScheduleExportInstant(sourceCheckedAt)} (oldest recorded check across ${pbsCheckedDayCount} PBS listing ${pbsCheckedDayCount === 1 ? "date" : "dates"}).` : correctedDayCount && !pbsDays.length ? `Last checked with PBS: Not applicable to the ${correctedDayCount} corrected listing ${correctedDayCount === 1 ? "date" : "dates"}.` : "Last checked with PBS: No valid check recorded.";
  const unknownText = unknownDayCount ? ` No check recorded for ${unknownDayCount} listing ${unknownDayCount === 1 ? "date" : "dates"} with no correction revision.` : "";
  return {
    sourceRevisionDates,
    correctedDayCount,
    pbsCheckedDayCount,
    unknownDayCount,
    sourceCheckedAt,
    sourceCheckText: sourceCheckText + unknownText,
    sourceStatus,
    notice: [correctionText, freshnessText].filter(Boolean).join(" ")
  };
}
function buildScheduleExport(data, exportedAt) {
  const startDate = scheduleDateKey(new Date(data.generatedAt));
  const start = /* @__PURE__ */ new Date(`${startDate}T12:00:00Z`);
  const dates = Array.from({ length: 14 }, (_, index) => {
    const date2 = new Date(start);
    date2.setUTCDate(date2.getUTCDate() + index);
    return date2.toISOString().slice(0, 10);
  });
  const endDate = dates[13];
  const rangeLabel = `${formatScheduleExportDate(startDate)} \u2013 ${formatScheduleExportDate(endDate)}`;
  const shortRangeLabel = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
    year: startDate.slice(0, 4) === endDate.slice(0, 4) ? void 0 : "numeric"
  }).formatRange(start, /* @__PURE__ */ new Date(`${endDate}T12:00:00Z`)).replace(/\s*–\s*/, " - ");
  const byDate = new Map(data.days.broadcast.map((day) => [day.date, day]));
  const days = dates.flatMap((date2) => {
    const day = byDate.get(date2);
    return day ? [day] : [];
  });
  const missingDates = dates.filter((date2) => !byDate.get(date2)?.entries.length);
  return {
    startDate,
    endDate,
    dates,
    rangeLabel,
    shortRangeLabel,
    title: "NJ PBS schedule",
    days,
    dayCount: days.filter((day) => day.entries.length > 0).length,
    listingCount: days.reduce((total, day) => total + day.entries.length, 0),
    missingDates,
    coverageNotice: missingDates.length ? `Missing listings for: ${missingDates.map(formatScheduleExportDate).join("; ")}.` : "Listings are available for all 14 dates.",
    filename: `nj-pbs-schedule-${startDate}-to-${endDate}.pdf`,
    href: "/schedule/downloads/nj-pbs-schedule.pdf",
    sourceLabel: days.some((day) => day.sourceRevision) ? days.every((day) => day.sourceRevision) ? "NJ PBS replacement lineup" : "PBS TVSS and NJ PBS replacement lineup" : data.source === "pbs-tvss-with-njpbs-corrections" ? "PBS TVSS and NJ PBS episode details" : "PBS TVSS",
    generatedAt: data.generatedAt,
    exportedAt: exportedAt.toISOString(),
    timeZone: TVSS_TIME_ZONE,
    ...sourceState(days, exportedAt)
  };
}
var SCHEDULE_STALE_AFTER_MS;
var init_schedule_export = __esm({
  "site/src/lib/schedule-export.ts"() {
    "use strict";
    init_schedule_view();
    init_broadcast_date2();
    init_schedule_feed();
    SCHEDULE_STALE_AFTER_MS = 20 * 60 * 60 * 1e3;
  }
});

// site/src/lib/home-retained-sources-entry.ts
var home_retained_sources_entry_exports = {};
__export(home_retained_sources_entry_exports, {
  createCurrentCodeContextReader: () => createCurrentCodeContextReader,
  newsletterCardData: () => newsletterCardData,
  projectHomeNewsletterRecord: () => projectHomeNewsletterRecord,
  qualifyHistoricalCodeContext: () => qualifyHistoricalCodeContext,
  readPageSchedulePacket: () => readPageSchedulePacket,
  readPreparedHomeSources: () => readPreparedHomeSources,
  readRetainedHomeSources: () => readRetainedHomeSources
});
module.exports = __toCommonJS(home_retained_sources_entry_exports);

// site/src/lib/no-build-home-sources.ts
var import_node_crypto2 = require("node:crypto");

// packages/content-core/src/editorial-dates.ts
init_publish_instant();
init_station_time();
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
function stationCalendarDay(value, timeZone = STATION_TIME_ZONE) {
  const local = instantToStationLocal(value, timeZone);
  return local === "" ? null : local.slice(0, 10);
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
function contentLinkMetadata(value) {
  const error = contentLinkError(value);
  if (error) throw new Error(error);
  return {
    ...value.contentLinkMode === void 0 ? {} : { contentLinkMode: value.contentLinkMode },
    ...value.contentLinkUrl === void 0 ? {} : { contentLinkUrl: value.contentLinkUrl },
    ...value.contentLinkNewTab === void 0 ? {} : { contentLinkNewTab: value.contentLinkNewTab }
  };
}
function contentLink(value, normalHref) {
  const error = contentLinkError(value);
  if (error) throw new Error(error);
  const external = value.contentLinkMode === "custom";
  const newTab = external && value.contentLinkNewTab !== false;
  return {
    href: external ? new URL(value.contentLinkUrl).href : normalHref,
    external,
    newTab,
    ...newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}
  };
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

// packages/content-core/src/media-origin.ts
var deploymentEnvironment = typeof __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ !== "undefined" ? __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ : typeof process !== "undefined" ? process.env.CMS_DEPLOYMENT_ENVIRONMENT : void 0;
var CMS_MEDIA_ORIGIN = deploymentEnvironment === "development" ? "https://dev-media.example.org" : "https://media.njpbs.org";
function cleanHttpsUrl(url) {
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}
function isCmsMediaUrl(url) {
  return cleanHttpsUrl(url) && (url.origin === "https://media.njpbs.org" || url.origin === CMS_MEDIA_ORIGIN) && url.pathname.startsWith("/cms-media/") && url.pathname.length > 11;
}
function isCmsImageUrl(url) {
  return isCmsMediaUrl(url) || cleanHttpsUrl(url) && url.origin === "https://njpbs.org" && url.pathname.startsWith("/brand/") && url.pathname.length > 7;
}

// packages/content-core/src/cms-image-variants.ts
function cmsImageThumbnails(image) {
  if (typeof image.url !== "string" || image.mimeType === "image/gif" || image.animated === true || !Array.isArray(image.thumbnails) || !Number.isSafeInteger(image.width) || Number(image.width) < 1 || !Number.isSafeInteger(image.height) || Number(image.height) < 1) return [];
  let original;
  try {
    original = new URL(image.url);
  } catch {
    return [];
  }
  const match = /^(\/cms-media\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9_-]+\/)([a-f0-9]{64})\.(?:jpg|png|webp|avif)$/.exec(original.pathname);
  if (!isCmsMediaUrl(original) || !match) return [];
  const sourceWidth = Number(image.width);
  const widths = sourceWidth < 480 ? [sourceWidth] : [480, 960, 1600].filter((width) => width <= sourceWidth);
  const output = /* @__PURE__ */ new Map();
  for (const item of image.thumbnails.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const { url, width, height } = item;
    if (!Number.isSafeInteger(width) || !widths.includes(width) || !Number.isSafeInteger(height) || height < 1 || Math.abs(height - Number(image.height) * width / Number(image.width)) > 1 || url !== `${original.origin}${match[1]}thumbs/${match[2]}-w${width}.webp`) continue;
    output.set(width, { url, width, height });
  }
  return [...output.values()].sort((a, b) => a.width - b.width);
}

// packages/content-core/src/coverage-label-id.ts
function isCoverageLabelId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}
function postCoverageLabelId(post) {
  if (post.coverageLabelId !== void 0) return isCoverageLabelId(post.coverageLabelId) ? post.coverageLabelId : void 0;
  const blog = post.liveBlog;
  return blog && typeof blog === "object" && "branding" in blog && blog.branding === "nj-decides-2026" ? "nj-decides-2026" : void 0;
}

// packages/content-core/src/home-source-curation.ts
init_publish_instant();

// packages/content-core/src/spotlight-image.mjs
var MILLISECONDS_PER_DAY = 864e5;
var TOPIC_IMAGE_SUFFIXES = ["", "-02"];
var TOPIC_IMAGE_SLUGS = /* @__PURE__ */ new Set([
  "budget",
  "business",
  "education",
  "energy-environment",
  "healthcare",
  "immigration",
  "law-public-safety",
  "more-issues",
  "nj-decides",
  "opinion",
  "politics",
  "social-issues",
  "under-the-dome",
  "watch"
]);
function spotlightTopicImage(topicSlug, publishedAt, seed) {
  if (!TOPIC_IMAGE_SLUGS.has(topicSlug)) return void 0;
  return `/brand/spotlight/${topicSlug}${TOPIC_IMAGE_SUFFIXES[topicVariantIndex(topicSlug, publishedAt, seed)]}.jpg`;
}
function spotlightTopicImageForStory(topicSlugs, publishedAt, seed) {
  for (const topicSlug of topicSlugs) {
    const image = spotlightTopicImage(topicSlug, publishedAt, seed);
    if (image) return image;
  }
  return void 0;
}
function topicVariantIndex(topicSlug, publishedAt, seed) {
  const publishedDate = new Date(publishedAt ?? "");
  if (!Number.isNaN(publishedDate.getTime())) {
    const publishedDay = Math.floor(publishedDate.getTime() / MILLISECONDS_PER_DAY);
    return (publishedDay + stableHash(topicSlug)) % TOPIC_IMAGE_SUFFIXES.length;
  }
  return stableHash(seed) % TOPIC_IMAGE_SUFFIXES.length;
}
function stableHash(value) {
  let hash3 = 2166136261;
  for (const character of value) {
    hash3 ^= character.codePointAt(0);
    hash3 = Math.imul(hash3, 16777619);
  }
  return (hash3 ^ hash3 >>> 16) >>> 0;
}
function spotlightFallbackImage(value) {
  if (typeof value !== "string") return void 0;
  return [...TOPIC_IMAGE_SLUGS].some((topic) => TOPIC_IMAGE_SUFFIXES.some((suffix) => value === `/brand/spotlight/${topic}${suffix}.jpg`)) ? value : void 0;
}
function spotlightStoryImage(story) {
  const fallback = spotlightFallbackImage(story.fallbackImage) ?? spotlightFallbackImage(story.image) ?? spotlightTopicImage(story.topicSlug, story.publishedAt, typeof story.href === "string" ? story.href : "") ?? "/brand/spotlight/more-issues.jpg";
  const image = spotlightCopyImageUrl(story.image);
  return image ? { url: image, alt: "", fallbackUrl: fallback } : { url: fallback, alt: "" };
}
function spotlightCopyImageUrl(value) {
  if (typeof value !== "string" || /[\\\u0000-\u0020\u007f]/.test(value)) return void 0;
  try {
    const url = new URL(value);
    return url.origin === "https://media.njpbs.org" && !url.username && !url.password && !url.search && !url.hash && /^\/cms-media\/spotlight\/[a-f0-9]{64}\/[a-f0-9]{64}\.(?:jpg|png|webp|avif|gif)$/.test(url.pathname) ? value : void 0;
  } catch {
    return void 0;
  }
}

// packages/content-core/src/home-source-curation.ts
var HOME_SOURCE_LOCKS = {
  "home-featured": { source: "pbs_featured", cap: 8, browseHref: "https://watch.njpbs.org/" },
  "home-more": { source: "pbs_more", cap: 16, browseHref: "https://watch.njpbs.org/" },
  "home-spotlight": { source: "spotlight_news", cap: 8, browseHref: "https://www.njspotlightnews.org/" },
  "home-posts": { source: "station_posts", cap: 24, browseHref: "/posts/" }
};
function homeSourceText(value, maximum) {
  return typeof value === "string" && value.length <= maximum && !!value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function homeSourceObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function homeSourceInstant(value) {
  return typeof value === "string" ? parsePublishInstant(value) : null;
}
function homeSourceImage(value) {
  if (!homeSourceObject(value) || typeof value.alt !== "string" || value.alt.length > 1e3 || typeof value.url !== "string" || /[\\\u0000-\u0020\u007f]/.test(value.url)) return void 0;
  const local = /^\/brand\/[A-Za-z0-9_./-]+$/.test(value.url) && !value.url.split("/").includes("..");
  if (spotlightCopyImageUrl(value.url)) return {
    url: value.url,
    alt: value.alt,
    fallbackUrl: spotlightFallbackImage(value.fallbackUrl) ?? "/brand/spotlight/more-issues.jpg"
  };
  if (!local && (!isExactHttpsUrl(value.url, 2048) || !(() => {
    const url = new URL(value.url);
    return isCmsImageUrl(url) || url.origin === "https://image.pbs.org" && !url.search && !url.hash;
  })())) return void 0;
  const thumbnails = cmsImageThumbnails(value);
  return {
    url: value.url,
    alt: value.alt,
    ...thumbnails.length ? { width: Number(value.width), height: Number(value.height), thumbnails } : {}
  };
}
function sourceHref(source2, href) {
  if (source2 === "station_posts") return typeof href === "string" && /^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(href);
  if (!isExactHttpsUrl(href, 2048) || href.includes("\\")) return false;
  const url = new URL(href);
  return !url.search && !url.hash && url.origin === (source2 === "spotlight_news" ? "https://www.njspotlightnews.org" : "https://watch.njpbs.org") && url.pathname !== "/";
}
function publicCard(value, source2, cutoff) {
  if (!homeSourceObject(value) || value.source !== source2 || !homeSourceText(value.id, 2048) || !homeSourceText(value.title, 300) || !(sourceHref(source2, value.href) || source2 === "station_posts" && value.contentLinkMode === "custom" && !contentLinkError(value) && value.href === new URL(value.contentLinkUrl).href)) return null;
  if (value.publishedAt !== void 0 && (homeSourceInstant(value.publishedAt) === null || homeSourceInstant(value.publishedAt) > cutoff)) return null;
  const image = source2 === "spotlight_news" ? spotlightStoryImage({
    image: homeSourceObject(value.image) ? value.image.url : void 0,
    fallbackImage: homeSourceObject(value.image) ? value.image.fallbackUrl : void 0
  }) : homeSourceImage(value.image);
  return {
    id: value.id,
    source: source2,
    title: value.title,
    href: value.href,
    ...source2 === "station_posts" ? contentLinkMetadata(value) : {},
    ...homeSourceText(value.summary, 1e4) ? { summary: value.summary } : {},
    ...source2 === "station_posts" && isCoverageLabelId(value.coverageLabelId) ? { coverageLabelId: value.coverageLabelId } : {},
    ...homeSourceText(value.sourceLabel, 200) ? { sourceLabel: value.sourceLabel } : {},
    ...homeSourceText(value.byline, 2e3) ? { byline: value.byline } : {},
    ...source2 === "spotlight_news" && value.bylineSource === "coauthors-plus" ? { bylineSource: "coauthors-plus" } : {},
    ...typeof value.publishedAt === "string" ? { publishedAt: value.publishedAt } : {},
    ...Number.isSafeInteger(value.sourceVersion) && Number(value.sourceVersion) > 0 ? { sourceVersion: Number(value.sourceVersion) } : {},
    ...isCalendarDay(value.displayDate) ? { displayDate: value.displayDate } : {},
    ...value.opinion === true ? { opinion: true } : {},
    ...image ? { image } : {}
  };
}
function curateHomeSource(section, snapshot, selection) {
  const lock = Object.hasOwn(HOME_SOURCE_LOCKS, section) ? HOME_SOURCE_LOCKS[section] : void 0;
  const cutoff = homeSourceInstant(selection?.cutoffAt);
  if (!lock || cutoff === null || Object.keys(selection).some((key2) => !["cutoffAt", "selectedIds", "limit"].includes(key2))) {
    throw new Error("Home source selection is invalid.");
  }
  const limit = selection.limit ?? lock.cap;
  if (![3, 4, 6, 8, 12, 16, 24].includes(limit) || limit > lock.cap) throw new Error("Home source limit is invalid.");
  const ids = selection.selectedIds;
  if (ids !== void 0 && (!Array.isArray(ids) || ids.length > limit || ids.some((id2) => !homeSourceText(id2, 2048)) || new Set(ids).size !== ids.length)) {
    throw new Error("Home source card selection is invalid.");
  }
  const result = {
    section,
    source: lock.source,
    browseHref: lock.browseHref,
    cutoffAt: selection.cutoffAt,
    checkedAt: null,
    cards: [],
    missingIds: [],
    emptyReason: "source_error"
  };
  if (snapshot.status === "error") return result;
  const checked = homeSourceInstant(snapshot.checkedAt);
  if (snapshot.status !== "ready" || checked === null || checked > cutoff || !Array.isArray(snapshot.cards)) {
    throw new Error("Home source receipt is invalid.");
  }
  const admitted = snapshot.cards.flatMap((value) => {
    const card = publicCard(value, lock.source, cutoff);
    return card ? [card] : [];
  });
  const counts = /* @__PURE__ */ new Map();
  for (const card of admitted) counts.set(card.id, (counts.get(card.id) ?? 0) + 1);
  const eligible = admitted.filter((card) => counts.get(card.id) === 1);
  const byId = new Map(eligible.map((card) => [card.id, card]));
  const selected = ids === void 0 ? eligible : ids.flatMap((id2) => byId.has(id2) ? [byId.get(id2)] : []);
  return {
    section,
    source: lock.source,
    browseHref: lock.browseHref,
    cutoffAt: selection.cutoffAt,
    checkedAt: snapshot.checkedAt,
    cards: selected.slice(0, limit),
    missingIds: ids?.filter((id2) => !byId.has(id2)) ?? [],
    emptyReason: selected.length ? null : ids !== void 0 ? "selection_unavailable" : "source_empty"
  };
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
var HOME_NEWSCAST_PROGRAM_HREF = "https://watch.njpbs.org/show/nj-pbs-news-with-rob-nelson/";
var HOME_NEWSCAST_ASSETS_URL = `https://media.services.pbs.org/api/v1/assets/?show-id=${HOME_NEWSCAST_SHOW_ID}&type=full_length&parent-type=episode&available=public&country=US&platform-slug=bento&sort=-premiered_on`;
var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function newscastTitleDate(value) {
  if (!homeSourceText(value, 300)) return null;
  const match = /^NJ PBS News with Rob Nelson \| ([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(value);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]) + 1;
  const date2 = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return isCalendarDay(date2) ? date2 : null;
}
function isNewscastTitle(value) {
  return value === "NJ PBS News with Rob Nelson" || newscastTitleDate(value) !== null;
}

// packages/content-core/src/home-newscast-published.ts
function closed(value, keys2) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys2.length && own.every((key2) => typeof key2 === "string" && keys2.includes(key2));
}
var emptyReasons = [null, "source_error", "source_empty", "no_eligible_episode", "withdrawn"];
var uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function refuse() {
  throw new Error("The published newscast source is invalid.");
}
function readPublishedHomeNewscast(value) {
  if (!closed(value, ["source", "showId", "showTitle", "programHref", "pastNewscastsHref", "liveHref", "cutoffAt", "checkedAt", "episode", "emptyReason"]) || value.source !== "pbs_media_manager" || value.showId !== HOME_NEWSCAST_SHOW_ID || value.showTitle !== "NJ PBS News with Rob Nelson" || value.programHref !== HOME_NEWSCAST_PROGRAM_HREF || value.pastNewscastsHref !== HOME_NEWSCAST_PROGRAM_HREF || value.liveHref !== "/live/") refuse();
  const cutoff = homeSourceInstant(value.cutoffAt), day = stationCalendarDay(String(value.cutoffAt));
  const checked = value.checkedAt === null ? null : homeSourceInstant(value.checkedAt);
  if (cutoff === null || day === null || value.checkedAt !== null && (checked === null || checked > cutoff) || !emptyReasons.includes(value.emptyReason) || value.episode === null !== (value.emptyReason !== null) || checked === null && (value.episode !== null || value.emptyReason !== "source_error")) refuse();
  let episode = null;
  if (value.episode !== null) {
    const item = value.episode;
    const playerKeys = item && typeof item === "object" && Object.hasOwn(item, "playerSrc") ? ["playerSrc"] : [];
    const summaryKeys = item && typeof item === "object" && Object.hasOwn(item, "summary") ? ["summary"] : [];
    if (!closed(item, ["id", "episodeId", "title", "episodeDate", "premieredOn", "sequence", "durationSeconds", "captioned", "href", "poster", "publicWindow", ...playerKeys, ...summaryKeys]) || !uuid(item.id) || !uuid(item.episodeId) || !isNewscastTitle(item.title) || newscastTitleDate(item.title) !== item.episodeDate || item.episodeDate !== null && (!isCalendarDay(item.episodeDate) || item.episodeDate > day) || !isCalendarDay(item.premieredOn) || item.premieredOn > day || !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1 || !Number.isSafeInteger(item.durationSeconds) || Number(item.durationSeconds) < 1 || item.captioned !== true || typeof item.href !== "string" || item.href.length > 235 || !/^https:\/\/watch\.njpbs\.org\/video\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(item.href) || !closed(item.poster, ["url", "alt"]) || item.poster.alt !== "" || !closed(item.publicWindow, ["startsAt", "endsAt", "country", "platform"]) || item.publicWindow.country !== "US" || item.publicWindow.platform !== "bento") refuse();
    if (playerKeys.length && (typeof item.playerSrc !== "string" || item.playerSrc.length > 500 || extractPartnerPlayerSrc(item.playerSrc) !== item.playerSrc)) refuse();
    if (summaryKeys.length && !homeSourceText(item.summary, 2e3)) refuse();
    const poster = homeSourceImage(item.poster);
    if (!poster || new URL(poster.url).origin !== "https://image.pbs.org") refuse();
    const start = item.publicWindow.startsAt === null ? null : homeSourceInstant(item.publicWindow.startsAt);
    const end = item.publicWindow.endsAt === null ? null : homeSourceInstant(item.publicWindow.endsAt);
    if (item.publicWindow.startsAt !== null && (start === null || start > cutoff) || item.publicWindow.endsAt !== null && (end === null || end <= cutoff)) refuse();
    episode = {
      id: item.id,
      episodeId: item.episodeId,
      title: String(item.title),
      ...summaryKeys.length ? { summary: item.summary } : {},
      episodeDate: item.episodeDate,
      premieredOn: item.premieredOn,
      sequence: Number(item.sequence),
      durationSeconds: Number(item.durationSeconds),
      captioned: true,
      href: item.href,
      ...playerKeys.length ? { playerSrc: item.playerSrc } : {},
      poster,
      publicWindow: {
        startsAt: item.publicWindow.startsAt,
        endsAt: item.publicWindow.endsAt,
        country: "US",
        platform: "bento"
      }
    };
  }
  return {
    source: "pbs_media_manager",
    showId: HOME_NEWSCAST_SHOW_ID,
    showTitle: "NJ PBS News with Rob Nelson",
    programHref: HOME_NEWSCAST_PROGRAM_HREF,
    pastNewscastsHref: HOME_NEWSCAST_PROGRAM_HREF,
    liveHref: "/live/",
    cutoffAt: String(value.cutoffAt),
    checkedAt: value.checkedAt,
    episode,
    emptyReason: value.emptyReason
  };
}
function resolvePublishedHomeNewscast(value, cutoffAt) {
  const source2 = readPublishedHomeNewscast(value), cutoff = homeSourceInstant(cutoffAt);
  if (cutoff === null || cutoff < homeSourceInstant(source2.cutoffAt)) refuse();
  const end = source2.episode?.publicWindow.endsAt;
  return { ...source2, cutoffAt, ...end && homeSourceInstant(end) <= cutoff ? { episode: null, emptyReason: "withdrawn" } : {} };
}
var packetKeys = ["source", "showId", "showTitle", "programHref", "pastNewscastsHref", "liveHref", "checkedAt", "episode", "emptyReason"];
function readHomeNewscastPacket(value) {
  if (!closed(value, packetKeys)) refuse();
  const { cutoffAt: _cutoff, ...packet } = readPublishedHomeNewscast({
    ...value,
    // With no observed episode, this clock is used only to validate the fixed
    // error envelope; it never leaves this reader or becomes a source receipt.
    cutoffAt: value.checkedAt === null ? "1970-01-01T00:00:00Z" : value.checkedAt
  });
  return packet;
}
function resolveHomeNewscastPacket(value, cutoffAt) {
  const packet = readHomeNewscastPacket(value);
  return resolvePublishedHomeNewscast({ ...packet, cutoffAt: packet.checkedAt ?? cutoffAt }, cutoffAt);
}

// packages/content-core/src/town-lookup.ts
function isTownLookupData(value, complete = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  if (Object.keys(data).some((key2) => !["heading", "introduction", "sourceLine"].includes(key2))) return false;
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
  return Reflect.ownKeys(data).every((key2) => typeof key2 === "string" && ["sectionId", "heading", "introduction"].includes(key2)) && typeof data.sectionId === "string" && Object.hasOwn(DATA_HUB_SECTIONS, data.sectionId) && typeof data.heading === "string" && data.heading.length <= 300 && typeof data.introduction === "string" && data.introduction.length <= 4e3 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.heading + data.introduction);
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
  if (!isRecord(value) || Object.keys(value).some((key2) => key2 !== "columns")) return false;
  const columns = value.columns;
  return Array.isArray(columns) && columns.length >= 1 && columns.length <= 4 && Array.from(columns).every((width) => Number.isInteger(width) && width >= 1 && width <= 12) && columns.reduce((sum, width) => sum + width, 0) === 12;
}
function isBlockLayout(value) {
  return isRecord(value) && Object.keys(value).every((key2) => key2 === "rowId" || key2 === "column") && typeof value.rowId === "string" && value.rowId.length > 0 && Number.isInteger(value.column) && value.column >= 0;
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
    return `{${Object.keys(value).sort().map((key2) => `${JSON.stringify(key2)}:${homeCatalogJson(value[key2])}`).join(",")}}`;
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

// packages/content-core/src/datasets.ts
var MAX_DATASET_BYTES = 200 * 1024;
var DATASET_UNITS = ["percent", "percent_change", "percentage_points", "number", "jobs", "people", "usd", "usd_month", "usd_hour", "usd_billion", "cents_kwh", "inches", "fahrenheit"];
var DATASET_ADJUSTMENTS = ["seasonally_adjusted", "not_seasonally_adjusted", "not_applicable"];
var DATASET_GEOGRAPHIES = ["nation", "state", "county", "municipality", "metro"];
function validDatasetId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

// packages/content-core/src/data-figure.ts
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyFields(value, fields4) {
  return Object.keys(value).every((key2) => fields4.includes(key2));
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
  return Reflect.ownKeys(data).every((key2) => typeof key2 === "string" && ["datasetVersion", "heading", "intro", "source"].includes(key2)) && data.datasetVersion === COUNTY_COMPARISON_VERSION && typeof data.heading === "string" && data.heading.length <= 300 && typeof data.intro === "string" && data.intro.length <= 4e3 && typeof data.source === "string" && data.source.length <= 1e3 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.heading + data.intro + data.source);
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
  return Object.keys(value).every((key2) => allowed.includes(key2));
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
function closed2(value, keys2) {
  return Reflect.ownKeys(value).every((key2) => typeof key2 === "string" && keys2.includes(key2));
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
  const date2 = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date2.getTime()) && date2.toISOString().slice(0, 10) === value;
}
function validImage(value, complete) {
  if (!record2(value) || !closed2(value, ["assetId", "alt", "altDecorative", "caption"])) return false;
  if (typeof value.assetId !== "string" || !(!complete && value.assetId === "" || /^[A-Za-z0-9_-]{1,128}$/.test(value.assetId))) return false;
  if (value.altDecorative !== void 0 && typeof value.altDecorative !== "boolean") return false;
  if (!text2(value.alt, BIO_LIMITS.alt, complete && value.altDecorative !== true)) return false;
  if (value.altDecorative === true && value.alt !== "") return false;
  return value.caption === void 0 || text2(value.caption, BIO_LIMITS.caption, false);
}
function isBioCardData(value, complete = false) {
  return record2(value) && closed2(value, CARD_KEYS) && identityFields(value, complete) && text2(value.summary, BIO_LIMITS.summary, complete) && validSource(value.sourceUrl, complete) && text2(value.sourceLabel, BIO_LIMITS.sourceLabel, complete) && validDay(value.asOf, complete) && (value.image === void 0 || validImage(value.image, complete));
}

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
  if (!homeSourceObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 7 || Reflect.ownKeys(value).some((key2) => typeof key2 !== "string" || !["showId", "heading", "summary", "layout", "watchLabel", "pastLabel", "liveLabel"].includes(key2)) || value.showId !== HOME_NEWSCAST_SHOW_ID || !HOME_NEWSCAST_LAYOUTS.includes(value.layout)) return false;
  return ["heading", "watchLabel", "pastLabel", "liveLabel"].every((key2) => typeof value[key2] === "string" && value[key2].length <= 120 && !/[\u0000-\u001f\u007f]/.test(value[key2]) && (!complete || !!value[key2].trim())) && typeof value.summary === "string" && value.summary.length <= 2e3 && !/[\u0000-\u001f\u007f]/.test(value.summary);
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
  if (!plainObject(value) || !Object.keys(value).every((key2) => PUBLIC_FIELDS.has(key2))) return false;
  return isPublicVideoUrl(value.url, "mp4") && isPublicVideoUrl(value.posterUrl, "jpg") && Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0 && value.mimeType === "video/mp4";
}
function isVideoBlockData(value, publishable = true) {
  if (!plainObject(value) || !Object.keys(value).every((key2) => DATA_FIELDS.has(key2))) return false;
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
  if (Object.keys(data).some((key2) => !Object.hasOwn(DATA_TABLE_FIELD_LIMITS, key2))) return false;
  if (!Object.entries(DATA_TABLE_FIELD_LIMITS).every(([key2, limit]) => typeof data[key2] === "string" && data[key2].length <= limit)) return false;
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
  if (Object.keys(data).some((key2) => key2 !== "documents") || !Array.isArray(data.documents) || data.documents.length > DOCUMENT_LIST_MAX) return false;
  const ids = /* @__PURE__ */ new Set();
  return data.documents.every((entry2) => {
    if (!entry2 || typeof entry2 !== "object" || Array.isArray(entry2)) return false;
    const item = entry2;
    if (Object.keys(item).some((key2) => !["itemId", "assetId", "title", "publisher", "addedAt"].includes(key2))) return false;
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
  return Reflect.ownKeys(data).every((key2) => typeof key2 === "string" && ["recordKind", "recordId", "variant"].includes(key2)) && RECORD_CARD_KINDS.includes(data.recordKind) && typeof data.recordId === "string" && (!publishable && data.recordId === "" || /^[A-Za-z0-9_-]{1,128}$/.test(data.recordId)) && (data.variant === void 0 || data.variant === "card" || data.variant === "compact");
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
    (key2) => typeof key2 === "string" && COVERAGE_ENTRY_KEY_SET.has(key2)
  )) {
    return false;
  }
  return typeof value.title === "string" && value.title.length <= COVERAGE_LIST_LIMITS.title && typeof value.outlet === "string" && value.outlet.length <= COVERAGE_LIST_LIMITS.outlet && typeof value.date === "string" && (value.date.length === 0 || isCalendarDay(value.date)) && typeof value.url === "string" && value.url.length <= COVERAGE_LIST_LIMITS.url;
}
function isCoverageListData(data) {
  return Reflect.ownKeys(data).every(
    (key2) => typeof key2 === "string" && COVERAGE_LIST_DATA_KEY_SET.has(key2)
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
  for (const entry2 of value) {
    if (!isRecord2(entry2)) return false;
    if (Reflect.ownKeys(entry2).some((key2) => key2 !== "id")) return false;
    if (typeof entry2.id !== "string" || entry2.id.trim().length === 0) return false;
    if (seen.has(entry2.id)) return false;
    seen.add(entry2.id);
  }
  return true;
}
function hasValidShelfQuery(data, keys2) {
  return Reflect.ownKeys(data).every((key2) => typeof key2 === "string" && keys2.has(key2)) && typeof data.title === "string" && isShelfTopicId(data.topic) && typeof data.itemLimit === "number" && SHELF_ITEM_LIMIT_SET.has(data.itemLimit) && typeof data.sort === "string" && SHELF_SORT_SET.has(data.sort) && isValidShelfPins(data.pinned);
}
function hasValidPromotionPlaylistCard(card, publishable) {
  if (!isRecord2(card)) return false;
  const decorative = card.altDecorative === true;
  return Reflect.ownKeys(card).every(
    (key2) => typeof key2 === "string" && PROMOTION_PLAYLIST_CARD_KEY_SET.has(key2)
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
    case "support_appeal":
      return Object.keys(data).every((key2) => ["heading", "copy", "buttonLabel", "href", "style", "backgroundImageAssetId"].includes(key2)) && [["heading", 120], ["copy", 2e3], ["buttonLabel", 60]].every(([key2, max]) => {
        const value = data[key2];
        return typeof value === "string" && value.length <= max && (!publishable || value.trim().length > 0);
      }) && typeof data.href === "string" && data.href.length <= 2e3 && (data.href === "" && !publishable || safeHref(data.href) !== null) && (data.style === "blue" || data.style === "light" || data.style === "dark") && (data.backgroundImageAssetId === void 0 || typeof data.backgroundImageAssetId === "string" && /^[A-Za-z0-9_-]{0,128}$/.test(data.backgroundImageAssetId));
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
        (key2) => typeof key2 === "string" && LINK_CARD_DATA_KEY_SET.has(key2)
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
        (key2) => typeof key2 === "string" && HTML_DATA_KEY_SET.has(key2)
      ) && typeof data.html === "string" && data.html.length <= HTML_BLOCK_LIMITS.html && (data.title === void 0 || typeof data.title === "string" && data.title.length <= HTML_BLOCK_LIMITS.title) && (!publishable || data.html.trim().length > 0);
    case "content_shelf":
      return Reflect.ownKeys(data).every(
        (key2) => typeof key2 === "string" && CONTENT_SHELF_DATA_KEY_SET.has(key2)
      ) && typeof data.title === "string" && typeof data.source === "string" && CONTENT_SHELF_SOURCE_SET.has(data.source) && typeof data.itemLimit === "number" && CONTENT_SHELF_ITEM_LIMIT_SET.has(data.itemLimit) && typeof data.moreLabel === "string" && typeof data.moreHref === "string" && (data.presentation === void 0 || CONTENT_SHELF_PRESENTATIONS.includes(data.presentation)) && (data.columns === void 0 || SHELF_COLUMNS.includes(data.columns)) && (data.selectedIds === void 0 && data.selectionReceipt === void 0 || isHomeSelectedIds(data.selectedIds, Number(data.itemLimit)) && isHomeSelectionReceipt(data.selectionReceipt));
    case "promotion_playlist":
      return Reflect.ownKeys(data).every(
        (key2) => typeof key2 === "string" && PROMOTION_PLAYLIST_DATA_KEY_SET.has(key2)
      ) && typeof data.title === "string" && typeof data.placement === "string" && PROMOTION_PLAYLIST_PLACEMENT_SET.has(data.placement) && (data.presentation === void 0 || SHELF_PRESENTATIONS.includes(data.presentation)) && (data.columns === void 0 || SHELF_COLUMNS.includes(data.columns)) && Array.isArray(data.cards) && hasUniqueCollectionItemIds(data.cards) && data.cards.every((card) => hasValidPromotionPlaylistCard(card, publishable)) && (!publishable || data.title.trim().length > 0 && data.cards.length >= 1 && data.cards.length <= 12);
    case "home_newscast":
      return isHomeNewscastData(data, false);
    case "newsletter_signup":
      return Reflect.ownKeys(data).every((key2) => typeof key2 === "string" && ["newsletterIds", "heading", "intro", "actionLabel", "selectionReceipt", "backgroundImageAssetId"].includes(key2)) && Array.isArray(data.newsletterIds) && data.newsletterIds.length <= 4 && data.newsletterIds.every((id2) => typeof id2 === "string" && id2.trim().length > 0) && new Set(data.newsletterIds).size === data.newsletterIds.length && (data.heading === void 0 || typeof data.heading === "string") && (data.intro === void 0 || typeof data.intro === "string") && (data.actionLabel === void 0 || typeof data.actionLabel === "string") && (data.selectionReceipt === void 0 || isHomeSelectionReceipt(data.selectionReceipt)) && (!publishable || homeNewsletter || data.newsletterIds.length >= 1);
    case "topic_shelf":
      return hasValidShelfQuery(data, TOPIC_SHELF_DATA_KEY_SET) && typeof data.source === "string" && TOPIC_SHELF_SOURCE_SET.has(data.source);
    case "video_playlist":
      return hasValidShelfQuery(data, VIDEO_PLAYLIST_DATA_KEY_SET) && typeof data.library === "string" && VIDEO_LIBRARY_SET.has(data.library);
    case "record_card":
      return isRecordCardData(data, publishable);
    case "sponsor_strip":
      return Reflect.ownKeys(data).every((key2) => typeof key2 === "string" && ["heading", "sponsorIds", "layout"].includes(key2)) && (data.heading === void 0 || typeof data.heading === "string" && data.heading.length <= 120) && (data.layout === "row" || data.layout === "grid") && Array.isArray(data.sponsorIds) && data.sponsorIds.length >= (publishable ? 1 : 0) && data.sponsorIds.length <= 12 && data.sponsorIds.every((id2) => typeof id2 === "string" && id2.trim().length > 0) && new Set(data.sponsorIds).size === data.sponsorIds.length;
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
    const entry2 = input[i];
    if (typeof entry2 !== "object" || entry2 === null) {
      return { ok: false, error: `blocks[${i}] is not an object` };
    }
    const block = entry2;
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
    if (Object.hasOwn(block.data, "backgroundImageAssetId") && block.type !== "support_appeal") {
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
      return { ok: false, error: `blocks[${input.findIndex((entry2) => entry2.id === block.id)}] has invalid data for data_table` };
    }
  }
  return { ok: true, blocks: input };
}

// packages/content-core/src/home-source-catalog.ts
var sections = Object.keys(HOME_SOURCE_LOCKS);
var MAX_HOME_CATALOG_BYTES = 4e5;
function readHomeEditorialCatalog(value) {
  if (!homeSourceObject(value) || Object.keys(value).some((key2) => !["schemaVersion", "cutoffAt", "sources", "services"].includes(key2)) || Object.keys(value).length !== (Object.hasOwn(value, "services") ? 4 : 3) || value.schemaVersion !== 1 || homeSourceInstant(value.cutoffAt) === null || !homeSourceObject(value.sources) || Object.keys(value.sources).length !== sections.length) throw new Error("Home source catalog is invalid.");
  const sources = {};
  for (const section of sections) {
    const snapshot = value.sources[section];
    if (!homeSourceObject(snapshot)) throw new Error("Home source catalog is invalid.");
    if (snapshot.status === "error" && Object.keys(snapshot).length === 1) {
      sources[section] = { status: "error" };
      continue;
    }
    if (snapshot.status !== "ready" || Object.keys(snapshot).length !== 3 || !Array.isArray(snapshot.cards) || snapshot.cards.length > 200 || homeSourceInstant(snapshot.checkedAt) === null) throw new Error("Home source catalog is invalid.");
    const cards2 = snapshot.cards.flatMap((card) => curateHomeSource(
      section,
      { status: "ready", checkedAt: String(snapshot.checkedAt), cards: [card] },
      { cutoffAt: String(value.cutoffAt) }
    ).cards);
    if (homeCatalogJson(cards2) !== homeCatalogJson(snapshot.cards) || new Set(cards2.map((card) => card.id)).size !== cards2.length) throw new Error("Home source catalog cards are invalid.");
    sources[section] = { status: "ready", checkedAt: String(snapshot.checkedAt), cards: cards2 };
  }
  const catalog = {
    schemaVersion: 1,
    cutoffAt: String(value.cutoffAt),
    sources,
    ...Object.hasOwn(value, "services") ? { services: readHomeServiceSources(value.services, String(value.cutoffAt)) } : {}
  };
  if (new TextEncoder().encode(homeCatalogJson(catalog)).byteLength > MAX_HOME_CATALOG_BYTES) throw new Error("Home source catalog is too large.");
  return catalog;
}
function boundHomeNewsletterCatalog(value, selectedIds = []) {
  if (!homeSourceObject(value)) throw new Error("Home source catalog is invalid.");
  const { services, ...rest } = value;
  const base = readHomeEditorialCatalog(rest);
  if (!Object.hasOwn(value, "services")) return base;
  const admitted = readHomeServiceSources(services, base.cutoffAt);
  const bytes = (catalog) => new TextEncoder().encode(homeCatalogJson(catalog)).byteLength;
  const unavailable = { ...base, services: { ...admitted, newsletters: { status: "error" } } };
  const fallback = () => bytes(unavailable) <= MAX_HOME_CATALOG_BYTES ? unavailable : base;
  const snapshot = admitted.newsletters;
  if (snapshot.status === "error") return fallback();
  const records = [];
  const candidate = { ...base, services: { ...admitted, newsletters: { ...snapshot, records } } };
  let used = bytes(candidate);
  if (used > MAX_HOME_CATALOG_BYTES) return fallback();
  const sorted = [...snapshot.records].sort((a, b) => {
    const left = a.id, right = b.id;
    return Number(selectedIds.includes(right)) - Number(selectedIds.includes(left)) || left.localeCompare(right);
  });
  for (const record3 of sorted) {
    const size = bytes(record3) + (records.length ? 1 : 0);
    if (used + size > MAX_HOME_CATALOG_BYTES) continue;
    records.push(record3);
    used += size;
  }
  if (!records.length && snapshot.records.length) return fallback();
  return readHomeEditorialCatalog(candidate);
}
function readHomeEditorialSourceReceipt(value) {
  if (!homeSourceObject(value) || Object.keys(value).length !== 2 || !isHomeSelectionReceipt(value.receipt)) {
    throw new Error("Home catalog receipt is invalid.");
  }
  return { catalog: readHomeEditorialCatalog(value.catalog), receipt: { ...value.receipt } };
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
function isCustomPageId(value) {
  return /^page-[a-f0-9]{32}$/.test(value);
}
var PUBLIC_PAGE_IDS = PUBLIC_PAGES.map((page) => page.id);
function publicPage(id2) {
  return PUBLIC_PAGES.find((page) => page.id === id2) ?? (isCustomPageId(id2) ? {
    id: id2,
    title: "New page",
    path: `/${id2}/`,
    family: "article",
    area: "station",
    editorTemplate: "genericPage"
  } : void 0);
}
var RESERVED_PAGE_SLUGS = /* @__PURE__ */ new Set([
  "index",
  "posts",
  "authors",
  "shows",
  "coverage",
  "search",
  "wiki",
  "admin",
  "data-hub",
  "architecture",
  "design-system",
  "admin-docs",
  "api",
  "assets",
  "sitemap",
  "robots",
  "favicon",
  "404",
  "new",
  "edit",
  "preview",
  "prototype",
  "feed",
  "rss",
  // The legacy edge map intercepts these roots before the public renderer.
  // site/tests/public-pages.test.ts checks this list against the edge classifier.
  "about-teaching-channel-presents",
  "addiction",
  "all-programs",
  "anywhere",
  "app-support",
  "author",
  "blog",
  "blog-post",
  "broadway-and-beyond",
  "careers",
  "classroom-close-up-nj",
  "closed-meetings",
  "collection",
  "connect-with-njtv-for-new-jersey-news",
  "docs",
  "due-process",
  "eguide",
  "email-preferences",
  "events",
  "funder-spots",
  "help",
  "how-to-watch",
  "midtown-men-pledge-special",
  "neal-shapiro-statement-to-the-community",
  "nj-pbs-is-at-risk",
  "nj-spotlight-and-njtv-news-join-forces",
  "njnews",
  "njtv-benefit",
  "njtv-pressroom",
  "njvid",
  "on-the-record",
  "other",
  "ournj",
  "ournj-signup",
  "overview",
  "pbsoauth",
  "perspectives",
  "private-preview",
  "program-content",
  "programs",
  "rescuing-the-river",
  "resources",
  "search-results",
  "serving-new-jersey-into-the-future",
  "share-your-story",
  "shore-week",
  "statement-from-the-wnet-group",
  "survey-of-media-consumption-habits",
  "teaching-channel-season-three",
  "teaching-channel-season-two",
  "uncategorized",
  "whats-up-at-njtv",
  "why-sponsor",
  "x270",
  "x271",
  "x272",
  "x273",
  "x274",
  "x275",
  "x276",
  "x277",
  "x279",
  "x78",
  "your-election-2024"
]);
function isAvailablePageSlug(pageId, slug) {
  if (pageId === "data-hub") return slug === "data-hub";
  if (pageId === "home" || typeof slug !== "string" || slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || RESERVED_PAGE_SLUGS.has(slug)) return false;
  const owner = PUBLIC_PAGES.find((page) => page.path === `/${slug}/` || "aliases" in page && page.aliases.some((alias) => alias === `/${slug}/`));
  return owner === void 0 || owner.id === pageId;
}
function isPublicPagePath(pageId, path) {
  if (!publicPage(pageId)) return false;
  if (pageId === "home") return path === "/";
  return typeof path === "string" && /^\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(path) && isAvailablePageSlug(pageId, path.slice(1, -1));
}
function publicPageAliases(page, canonicalPath, previousSlugs = []) {
  return [.../* @__PURE__ */ new Set([
    ...page.aliases ?? [],
    ...canonicalPath !== page.path && !isCustomPageId(page.id) ? [page.path] : [],
    ...previousSlugs.map((slug) => `/${slug}/`)
  ])].filter((route) => route !== canonicalPath).sort();
}

// packages/content-core/src/launch-fallback.ts
var passportLookupUrl = "https://www.pbs.org/passport/lookup/";
var donateUrl = "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport";
var pbsAppUrl = "https://www.pbs.org/pbs-app/";
var pbsKidsUrl = "https://pbskids.org/";
var pbsLivestreamEmbedUrl = "https://player.pbs.org/ga-livestream-partnerplayer/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&feed_cid=4211290e-ce30-49e5-9be1-2c412c5b3278";
var pbsVideoUrl = "https://watch.njpbs.org/";
var launchCompliancePageSlugs = PUBLIC_PAGES.filter(
  (page) => page.area === "compliance"
).map((page) => page.path.slice(1, -1));
var launchArticlePageSlugs = [
  ...launchCompliancePageSlugs,
  ...PUBLIC_PAGES.filter(
    (page) => page.family === "article" && page.area !== "compliance"
  ).map((page) => page.path.slice(1, -1))
];
var manualLaunchCards = [
  {
    title: "Watch NJ PBS",
    description: "Browse on-demand episodes, specials, and Passport video.",
    href: pbsVideoUrl,
    source: "manual"
  },
  {
    title: "PBS app",
    description: "Use the PBS app and sign in with your New Jersey account.",
    href: pbsAppUrl,
    source: "manual"
  },
  {
    title: "NJ Spotlight News",
    description: "Statewide news continues at the NJ Spotlight News website.",
    href: "https://www.njspotlightnews.org/",
    source: "manual"
  },
  {
    title: "PBS Kids",
    description: "Find PBS Kids videos, games, and family resources.",
    href: "/kids/",
    source: "manual"
  }
];
function selectLaunchCards(mediaCards, manual) {
  return mediaCards.length > 0 ? mediaCards : manual;
}
var launchFallbackPages = {
  watch: {
    slug: "watch",
    destinationCards: true,
    title: "Watch NJ PBS",
    description: "Browse NJ PBS programs and PBS series on demand.",
    body: [
      "Use Watch for NJ PBS video you can play on demand: full episodes, specials, documentaries, PBS series, and member video benefits.",
      "Playback, episode availability, Passport access, and sign-in are handled through the PBS video portal so the same account works on the web, the PBS app, and supported devices."
    ],
    primaryAction: {
      label: "Open PBS video portal",
      href: pbsVideoUrl,
      external: true
    },
    secondaryAction: {
      label: "Watch live",
      href: "/live/"
    }
  },
  live: {
    slug: "live",
    destinationCards: true,
    title: "PBS Livestream",
    description: "Watch the NJ PBS broadcast stream through PBS live video.",
    body: [
      "The livestream uses PBS playback, location rules, and account services so it works consistently with the PBS app and watch.njpbs.org."
    ],
    primaryAction: {
      label: "Open PBS livestream",
      href: pbsLivestreamEmbedUrl,
      external: true
    },
    secondaryAction: {
      label: "See the schedule",
      href: "/schedule/"
    }
  },
  schedule: {
    slug: "schedule",
    destinationCards: true,
    title: "Schedule",
    description: "See what is airing on NJ PBS today and this week.",
    body: [
      "Browse the NJ PBS broadcast schedule below. Listings come from PBS and update through the day, so check back before tuning in, setting a recording, or looking for a program on demand.",
      "Programs air across NJ PBS and its companion channels. After something airs, look for it on demand through the PBS video portal."
    ],
    primaryAction: {
      label: "Watch live",
      href: "/live/"
    },
    secondaryAction: {
      label: "Watch on demand",
      href: pbsVideoUrl,
      external: true
    }
  },
  kids: {
    slug: "kids",
    destinationCards: true,
    title: "Kids",
    description: "PBS Kids videos, games, and learning resources for families.",
    body: [
      "PBS Kids offers videos, games, and activities for young viewers, families, caregivers, and teachers.",
      "Use PBS Kids for favorite characters, family-friendly programming, and learning resources built around curiosity and play."
    ],
    primaryAction: {
      label: "Open PBS Kids",
      href: pbsKidsUrl,
      external: true
    }
  },
  support: {
    slug: "support",
    destinationCards: true,
    title: "Support NJ PBS",
    description: "Donate, become a member, and support public television in New Jersey.",
    body: [
      "Gifts to NJ PBS support public television programming, statewide storytelling, education, arts, culture, and public affairs.",
      "Online donation processing is handled through PBS, and this site does not collect payment information.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043."
    ],
    primaryAction: {
      label: "Donate",
      href: donateUrl,
      external: true
    },
    secondaryAction: {
      label: "Contact NJ PBS",
      href: "/contact/"
    }
  },
  give: {
    slug: "give",
    destinationCards: true,
    title: "Give to NJ PBS",
    description: "Support public television in New Jersey through NJ PBS membership and donations.",
    body: [
      "Your gift supports trusted PBS programming, statewide reporting, educational media, arts and culture, and public-service broadcasting for New Jersey.",
      "This page is the local NJ PBS giving destination. When you donate online, the payment form opens through PBS so transaction handling and member records stay secure.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043."
    ],
    primaryAction: {
      label: "Donate through PBS",
      href: donateUrl,
      external: true
    },
    secondaryAction: {
      label: "Learn about Passport",
      href: "/passport/"
    }
  },
  donate: {
    slug: "donate",
    destinationCards: true,
    title: "Donate to NJ PBS",
    description: "Make a gift to support public media for New Jersey.",
    body: [
      "Gifts support NJ PBS programming, reporting, education, arts, culture, and public-service broadcasting.",
      "Online donation processing is handled through PBS, and this site does not collect payment information.",
      "Prefer to mail a check? Make checks payable to NJ PBS and mail to: NJ PBS, 1 Normal Ave., Montclair, NJ 07043."
    ],
    primaryAction: {
      label: "Donate",
      href: donateUrl,
      external: true
    },
    secondaryAction: {
      label: "Contact NJ PBS",
      href: "/contact/"
    }
  },
  passport: {
    slug: "passport",
    destinationCards: true,
    title: "NJ PBS Passport",
    description: "Learn how the PBS Passport member benefit works for NJ PBS supporters.",
    body: [
      "PBS Passport is a member benefit that gives eligible donors extended access to a library of PBS programs, films, and specials.",
      "Support NJ PBS to start or renew access, or use the PBS lookup tool if you already donate and need help finding your Passport account."
    ],
    primaryAction: {
      label: "Donate through PBS",
      href: donateUrl,
      external: true
    },
    secondaryAction: {
      label: "Find Passport access",
      href: passportLookupUrl,
      external: true
    }
  },
  about: {
    slug: "about",
    title: "About NJ PBS",
    description: "New Jersey's public television service: the member stations, how to watch and support, and Montclair State University's new role.",
    body: [
      "NJ PBS is New Jersey's public television service. It carries PBS programs, local stories, arts and culture, education, and statewide public affairs to viewers across the state and the surrounding region.",
      "Use this site to watch live and on demand, check the broadcast schedule, follow statewide reporting from NJ Spotlight News, explore PBS Kids, and support public media in New Jersey."
    ],
    primaryAction: {
      label: "Support NJ PBS",
      href: "/give/"
    },
    secondaryAction: {
      label: "NJ Spotlight News",
      href: "https://www.njspotlightnews.org/",
      external: true
    }
  }
};
var launchFallbackRoutePages = Object.values(
  launchFallbackPages
).filter((page) => page.slug !== "schedule");

// packages/content-core/src/home-newsletter-section.ts
function homeNewsletterDataError(data, complete) {
  if (data.newsletterIds.length > 1 || data.newsletterIds.some((id2) => !/^[A-Za-z0-9_-]{1,128}$/.test(id2)) || typeof data.actionLabel !== "string" || data.actionLabel.length > 120 || (data.heading ?? "").length > 120 || (data.intro ?? "").length > 2e3 || /[\u0000-\u001f\u007f]/.test((data.heading ?? "") + (data.intro ?? "") + data.actionLabel) || data.newsletterIds.length > 0 !== (data.selectionReceipt !== void 0) || data.selectionReceipt !== void 0 && !isHomeSelectionReceipt(data.selectionReceipt) || complete && data.newsletterIds.length > 0 && !data.actionLabel.trim()) {
    return "Home Newsletter requires an empty slot or one published selection with plain-text copy and button text.";
  }
  return null;
}

// packages/content-core/src/home-composition-contract.ts
var HOME_COMPOSITION_REGIONS = [
  ["home-start", "card_grid"],
  ["home-start-action", "cta_row"],
  ["home-featured", "content_shelf"],
  ["home-passport-copy", "prose"],
  ["home-passport-action", "cta_row"],
  ["home-more", "content_shelf"],
  ["home-spotlight", "content_shelf"]
];
var HOME_OPTIONAL_REGIONS = [["home-posts", "content_shelf"], ["home-donor", "card_grid"], ["home-newsletter", "newsletter_signup"], ["home-newscast", "home_newscast"]];
var HOME_DESTINATIONS = {
  live: "/live/",
  ondemand: "https://watch.njpbs.org/",
  schedule: "/schedule/",
  kids: "/kids/",
  passport: "https://watch.njpbs.org/passport/learn-more/",
  spotlight: "https://www.njspotlightnews.org/"
};
function homeDetailText(doc) {
  if (doc === void 0 || doc.content.length === 0) return "";
  if (doc.content.length !== 1 || doc.content[0].type !== "paragraph") return null;
  const nodes = doc.content[0].content ?? [];
  if (nodes.some((node) => node.type !== "text" || (node.marks?.length ?? 0) > 0)) return null;
  return nodes.map((node) => node.text ?? "").join("");
}
function homePassportHeading(doc) {
  const heading = doc.content[0];
  if (heading?.type !== "heading" || heading.attrs?.level !== 2) return null;
  const nodes = heading.content ?? [];
  if (nodes.some((node) => node.type !== "text" || (node.marks?.length ?? 0) > 0)) return null;
  const text9 = nodes.map((node) => node.text ?? "").join("");
  return text9.trim() ? text9 : null;
}
function nonBlank(value) {
  return value.trim().length > 0;
}
function regionContentError(block, complete) {
  if (block.section === "home-newscast" && block.type === "home_newscast") {
    return isHomeNewscastData(block.data, complete && block.visible) ? null : "Newscast requires its approved program, layout, plain-text copy and action labels.";
  }
  if (block.section === "home-newsletter" && block.type === "newsletter_signup") {
    return homeNewsletterDataError(block.data, complete && block.visible);
  }
  if (block.section === "home-donor" && block.type === "card_grid") {
    const card = block.data.cards[0];
    const summary = card ? homeDetailText(card.body) : null;
    if (Object.keys(block.data).some((key2) => !["cards", "backgroundImageAssetId"].includes(key2)) || block.data.cards.length !== 1 || !card || Object.keys(card).some((key2) => !["itemId", "title", "body", "label", "href"].includes(key2)) || card.href !== "/support/" || typeof card.label !== "string" || card.title.length > 120 || card.label.length > 120 || summary === null || summary.length > 2e3 || /[\u0000-\u001f\u007f]/.test(card.title + card.label + summary) || complete && (!nonBlank(card.title) || !nonBlank(card.label))) {
      return "Home giving requires a heading, plain-text summary and one action to /support/.";
    }
    return null;
  }
  if (block.type === "card_grid") {
    const destinations = [HOME_DESTINATIONS.live, HOME_DESTINATIONS.ondemand, HOME_DESTINATIONS.schedule, HOME_DESTINATIONS.kids];
    if (block.data.cards.length !== 4) return "Start here requires four destination cards.";
    for (const [index, card] of block.data.cards.entries()) {
      if (complete && !nonBlank(card.title) || card.href !== destinations[index]) return "Keep the four Start here destinations in their original order, with a title for each.";
      if (card.label !== void 0 || homeDetailText(card.body) === null) return "Start here cards use a title and plain-text detail.";
      if (index === 3 && card.imageAssetId !== void 0) return "The Kids pathway keeps its fixed animated artwork.";
    }
  }
  if (block.type === "cta_row") {
    const action = block.data.ctas[0];
    const passport = block.section === "home-passport-action";
    const href = passport ? HOME_DESTINATIONS.passport : HOME_DESTINATIONS.schedule;
    if (block.data.ctas.length !== 1 || complete && !nonBlank(action.label) || action.href !== href) return "Each Home section action requires one label and its approved destination.";
    if (action.variant !== void 0 && action.variant !== (passport ? "primary" : "secondary")) return "Keep the Home section action's fixed presentation.";
  }
  if (complete && block.type === "prose" && (homePassportHeading(block.data.content) === null || richTextIsEmpty({ type: "doc", content: block.data.content.content.slice(1) }))) {
    return "Passport requires a plain-text level-two heading followed by its body.";
  }
  if (block.type === "content_shelf") {
    const expected = block.section === "home-featured" ? "pbs_featured" : block.section === "home-more" ? "pbs_more" : block.section === "home-posts" ? "station_posts" : "spotlight_news";
    const href = expected === "station_posts" ? "/posts/" : expected === "spotlight_news" ? HOME_DESTINATIONS.spotlight : HOME_DESTINATIONS.ondemand;
    const maximum = expected === "station_posts" ? 24 : expected === "pbs_more" ? 16 : 8;
    if (block.data.source !== expected || block.data.moreHref !== href) return "Keep the Home shelf's assigned source and approved destination.";
    if (complete && (!nonBlank(block.data.title) || !nonBlank(block.data.moreLabel))) return "Home shelves require a heading and a more-link label.";
    if (block.data.itemLimit > maximum) return `This Home shelf supports at most ${maximum} items.`;
  }
  return null;
}
function homeCompositionError(pageId, version, blocks, { complete = true } = {}) {
  if (blocks.some((block) => block.type === "home_newscast" && (block.section !== "home-newscast" || pageId !== "home" || version !== 2))) return "Newscast requires its named Home version 2 section.";
  if (blocks.some((block) => block.type === "newsletter_signup" && (block.section === "home-newsletter" ? pageId !== "home" || version !== 2 : block.data.actionLabel !== void 0 || block.data.selectionReceipt !== void 0 || pageId === "home"))) {
    return "The single Newsletter bar requires its named Home version 2 section.";
  }
  if (blocks.some((block) => block.section === "home-donor" && block.type !== "promotion_playlist") && (pageId !== "home" || version !== 2)) return "The giving plank requires Home version 2.";
  if (version === void 0) return null;
  if (pageId !== "home" || version !== 1 && version !== 2) return "The Home composition version is invalid.";
  if (version === 2) return homeCompositionV2Error(blocks, complete);
  const content = blocks.filter((block) => block.type !== "promotion_playlist");
  const required = content.filter((block) => block.section !== void 0);
  const added = content.filter((block) => block.section === void 0);
  const promotions = blocks.filter((block) => block.type === "promotion_playlist");
  if (required.length !== HOME_COMPOSITION_REGIONS.length || promotions.length > 8) return "Home requires its seven named regions and at most eight manual shelves.";
  if (added.some((block) => block.type === "content_shelf")) return "Automatic Home shelves keep their named page sections.";
  if (added.length && blocks.some((block, index) => index > 0 && block.order <= blocks[index - 1].order)) return "Home content must follow its saved reading order.";
  for (const [order, [section, type]] of HOME_COMPOSITION_REGIONS.entries()) {
    const matches = required.filter((block2) => block2.section === section);
    const block = matches[0];
    if (matches.length !== 1 || block !== required[order] || block.type !== type || order > 0 && block.order <= required[order - 1].order || !block.visible) return `Keep the ${section} region visible and in its assigned position.`;
    const error = regionContentError(block, complete);
    if (error) return error;
    if (block.type === "content_shelf" && block.data.selectedIds !== void 0) return "Curated card selections require Home version 2.";
  }
  for (const [body, action] of [["home-start", "home-start-action"], ["home-passport-copy", "home-passport-action"]]) {
    if (content.findIndex((block) => block.section === action) !== content.findIndex((block) => block.section === body) + 1) return "Add content between Home sections, not inside a section's fixed controls.";
  }
  if (promotions.some((block) => block.layout !== void 0)) return "The manual Home shelf keeps its own page placement outside rows.";
  if (promotions.some((block) => HOME_COMPOSITION_REGIONS.some(([section]) => section === block.section))) return "The manual shelf cannot replace a required Home region.";
  return null;
}
function homeCompositionV2Error(blocks, complete) {
  if (blocks.some((block) => block.type === "promotion_playlist" && block.layout !== void 0)) {
    return "The manual Home shelf stays outside rows.";
  }
  if (blocks.some((block, index) => index > 0 && block.order <= blocks[index - 1].order)) {
    return "Home content must follow its saved reading order.";
  }
  const required = blocks.filter((block) => block.section !== void 0 && block.type !== "promotion_playlist");
  if (blocks.some((block) => block.type === "promotion_playlist" && [...HOME_COMPOSITION_REGIONS, ...HOME_OPTIONAL_REGIONS].some(([section]) => section === block.section))) {
    return "The manual shelf cannot replace a required Home region.";
  }
  if (required.some((block) => ![...HOME_COMPOSITION_REGIONS, ...HOME_OPTIONAL_REGIONS].some(([section]) => section === block.section)) || blocks.filter((block) => block.type === "promotion_playlist").length > 8) {
    return "Home requires its seven named regions and at most eight manual shelves.";
  }
  for (const [section, type] of HOME_COMPOSITION_REGIONS) {
    const matches = required.filter((block2) => block2.section === section);
    const block = matches[0];
    if (matches.length !== 1 || block.type !== type || block.layout !== void 0) {
      return `Keep the ${section} region and its assigned type outside rows.`;
    }
    const error = regionContentError(block, complete);
    if (error) return error;
  }
  for (const [section, type] of HOME_OPTIONAL_REGIONS) {
    const matches = required.filter((block) => block.section === section);
    if (matches.length > 1 || matches.some((block) => block.type !== type || block.layout !== void 0)) return `Keep one ${section} region with its assigned type outside rows.`;
    if (matches[0]) {
      const error = regionContentError(matches[0], complete);
      if (error) return error;
    }
  }
  if (blocks.some((block) => block.section === void 0 && block.type === "content_shelf")) {
    return "Automatic Home shelves keep their named page sections.";
  }
  for (const [body, action] of [["home-start", "home-start-action"], ["home-passport-copy", "home-passport-action"]]) {
    const bodyIndex = blocks.findIndex((block) => block.section === body);
    const actionIndex = blocks.findIndex((block) => block.section === action);
    if (actionIndex !== bodyIndex + 1 || blocks[bodyIndex].visible !== blocks[actionIndex].visible) {
      return "Home section copy and action must stay adjacent with the same visibility.";
    }
  }
  return null;
}

// packages/content-core/src/home-newsletter-source.ts
function adaptHomeNewsletter(settings, snapshot, cutoffAt) {
  const cutoff = homeSourceInstant(cutoffAt);
  if (cutoff === null || !homeSourceObject(settings) || Object.keys(settings).some((key2) => !["newsletterIds", "actionLabel", "heading", "intro"].includes(key2)) || !Array.isArray(settings.newsletterIds) || settings.newsletterIds.length > 4 || settings.newsletterIds.some((id2) => !homeSourceText(id2, 128)) || new Set(settings.newsletterIds).size !== settings.newsletterIds.length || !homeSourceText(settings.actionLabel, 120) || settings.heading !== void 0 && !homeSourceText(settings.heading, 120) || settings.intro !== void 0 && !homeSourceText(settings.intro, 2e3)) throw new Error("Home Newsletter settings are invalid.");
  const result = {
    source: "published_newsletters",
    cutoffAt,
    checkedAt: null,
    ...settings.heading === void 0 ? {} : { heading: settings.heading },
    ...settings.intro === void 0 ? {} : { intro: settings.intro },
    cards: [],
    missingIds: [],
    emptyReason: "source_error"
  };
  if (snapshot.status === "error") return result;
  const checked = homeSourceInstant(snapshot.checkedAt);
  if (snapshot.status !== "ready" || checked === null || checked > cutoff || !Array.isArray(snapshot.records)) throw new Error("Home Newsletter receipt is invalid.");
  const cards2 = [];
  for (const id2 of settings.newsletterIds) {
    const matches = snapshot.records.filter((record4) => homeSourceObject(record4) && record4.kind === "newsletter" && record4.id === id2);
    const record3 = matches.length === 1 ? matches[0] : null;
    if (!homeSourceObject(record3) || record3.href !== null || !Number.isSafeInteger(record3.sourceVersion) || Number(record3.sourceVersion) < 1 || !homeSourceObject(record3.newsletter) || !homeSourceObject(record3.newsletter.card)) continue;
    const card = record3.newsletter.card;
    if (!homeSourceText(card.title, 300) || !isExactHttpsUrl(card.signupUrl, 2048) || card.signupUrl.includes("\\")) continue;
    const image = homeSourceImage(record3.newsletter.image && homeSourceObject(record3.newsletter.image) ? { url: record3.newsletter.image.url, alt: card.imageDecorative === true ? "" : card.imageAlt ?? "" } : void 0);
    cards2.push({
      id: id2,
      sourceVersion: Number(record3.sourceVersion),
      title: card.title,
      signupHref: card.signupUrl,
      actionLabel: settings.actionLabel,
      ...homeSourceText(card.summary, 2e3) ? { summary: card.summary } : {},
      ...homeSourceText(card.frequency, 120) ? { frequency: card.frequency } : {},
      ...image ? { image } : {}
    });
  }
  return {
    ...result,
    checkedAt: snapshot.checkedAt,
    cards: cards2,
    missingIds: settings.newsletterIds.filter((id2) => !cards2.some((card) => card.id === id2)),
    emptyReason: cards2.length ? null : "selection_unavailable"
  };
}

// packages/content-core/src/home-service-sources.ts
function projectHomeNewsletterRecord(record3, checkedAt2, cutoffAt) {
  if (!homeSourceObject(record3) || typeof record3.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record3.id)) return null;
  const source2 = adaptHomeNewsletter(
    { newsletterIds: [record3.id], actionLabel: "Sign up by email" },
    { status: "ready", checkedAt: checkedAt2, records: [record3] },
    cutoffAt
  );
  const card = source2.cards[0];
  if (!card) return null;
  return {
    id: card.id,
    kind: "newsletter",
    href: null,
    sourceVersion: card.sourceVersion,
    newsletter: {
      card: {
        title: card.title,
        signupUrl: card.signupHref,
        ...card.summary ? { summary: card.summary } : {},
        ...card.frequency ? { frequency: card.frequency } : {},
        ...card.image ? { imageAlt: card.image.alt } : {}
      },
      ...card.image ? { image: { url: card.image.url } } : {}
    }
  };
}
function createHomeNewsletterSnapshot(records, checkedAt2, cutoffAt, selectedIds = []) {
  if (!Array.isArray(records) || selectedIds.length > 1 || selectedIds.some((id2) => !/^[A-Za-z0-9_-]{1,128}$/.test(id2))) throw new Error("Home Newsletter export is invalid.");
  const projected = records.filter((record3) => homeSourceObject(record3) && record3.kind === "newsletter").flatMap((record3) => {
    const card = projectHomeNewsletterRecord(record3, checkedAt2, cutoffAt);
    return card ? [card] : [];
  });
  return readHomeServiceSources({ newsletters: { status: "ready", checkedAt: checkedAt2, records: projected.sort((a, b) => {
    const left = a.id, right = b.id;
    return Number(selectedIds.includes(right)) - Number(selectedIds.includes(left)) || left.localeCompare(right);
  }).slice(0, 200) } }, cutoffAt).newsletters;
}
function readHomeServiceSources(value, cutoffAt) {
  if (!homeSourceObject(value) || Object.keys(value).length !== (Object.hasOwn(value, "newscast") ? 2 : 1) || Object.keys(value).some((key2) => !["newsletters", "newscast"].includes(key2)) || !Object.hasOwn(value, "newsletters") || !homeSourceObject(value.newsletters)) {
    throw new Error("Home service sources are invalid.");
  }
  const newscast = Object.hasOwn(value, "newscast") ? readPublishedHomeNewscast(value.newscast) : void 0;
  if (newscast && newscast.cutoffAt !== cutoffAt) throw new Error("Newscast and Home catalog cutoffs differ.");
  const optional = newscast ? { newscast } : {};
  const snapshot = value.newsletters;
  if (snapshot.status === "error" && Object.keys(snapshot).length === 1 && Object.hasOwn(snapshot, "status")) return { newsletters: { status: "error" }, ...optional };
  const cutoff = homeSourceInstant(cutoffAt), checked = homeSourceInstant(snapshot.checkedAt);
  if (snapshot.status !== "ready" || Object.keys(snapshot).length !== 3 || Object.keys(snapshot).some((key2) => !["status", "checkedAt", "records"].includes(key2)) || cutoff === null || checked === null || checked > cutoff || !Array.isArray(snapshot.records) || snapshot.records.length > 200) throw new Error("Published Home Newsletters are invalid.");
  const records = snapshot.records.map((record3) => projectHomeNewsletterRecord(record3, String(snapshot.checkedAt), cutoffAt));
  if (records.some((record3) => record3 === null) || homeCatalogJson(records) !== homeCatalogJson(snapshot.records) || new Set(records.map((record3) => record3.id)).size !== records.length) {
    throw new Error("Published Home Newsletters are invalid.");
  }
  return { newsletters: { status: "ready", checkedAt: String(snapshot.checkedAt), records }, ...optional };
}

// site/src/lib/home-editorial-catalog.ts
var import_node_crypto = require("node:crypto");

// packages/content-core/src/spotlight-byline.mjs
function spotlightDisplayByline(value) {
  if (typeof value !== "string") return void 0;
  const byline = value.trim();
  const first = byline.replace(/, et al\.$/, "");
  if (!byline || byline.length > 2e3 || /[\u0000-\u001f\u007f<>@]/.test(byline) || /^(?:jmooney|NJ Spotlight(?: News)?)$/i.test(first)) return void 0;
  return byline;
}
function spotlightCardByline(card) {
  return card?.bylineSource === "coauthors-plus" ? spotlightDisplayByline(card.byline) : void 0;
}

// packages/content-core/src/home-spotlight-source.ts
function spotlightFeedInstant(value) {
  if (homeSourceInstant(value) !== null) return value;
  if (typeof value !== "string") return null;
  const utc = value.replace(/\+0000$/, "GMT");
  const time = Date.parse(utc);
  return Number.isFinite(time) && new Date(time).toUTCString() === utc ? new Date(time).toISOString() : null;
}
function adaptHomeSpotlight(snapshot, selection) {
  if (snapshot.status === "error") return curateHomeSource("home-spotlight", snapshot, selection);
  if (snapshot.status !== "ready" || snapshot.source !== "nj-spotlight-news-rss" || !Array.isArray(snapshot.cards)) {
    throw new Error("Keep the approved Spotlight feed source.");
  }
  const cards2 = snapshot.cards.flatMap((value) => {
    if (!homeSourceObject(value) || value.source !== "nj-spotlight-news-rss" || !homeSourceText(value.title, 300) || !homeSourceText(value.href, 2048)) return [];
    const publishedAt = spotlightFeedInstant(value.publishedAt);
    if (!publishedAt) return [];
    const categories = Array.isArray(value.sourceCategories) ? value.sourceCategories : [];
    const opinion = categories.some((category) => typeof category === "string" && /^(Opinion|Op-Ed)$/i.test(category.trim()));
    const image = spotlightStoryImage(value);
    const byline = spotlightCardByline(value);
    return [{
      id: value.href,
      source: "spotlight_news",
      title: value.title,
      href: value.href,
      sourceLabel: "NJ Spotlight News",
      publishedAt,
      displayDate: stationCalendarDay(publishedAt),
      ...byline ? { byline, bylineSource: "coauthors-plus" } : {},
      ...opinion ? { opinion: true } : {},
      ...image ? { image } : {}
    }];
  });
  return curateHomeSource("home-spotlight", { status: "ready", checkedAt: snapshot.checkedAt, cards: cards2 }, selection);
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
  const link3 = /^(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(pasted) ? `https://${pasted}` : pasted.startsWith("//") ? `https:${pasted}` : pasted;
  let parsed;
  try {
    parsed = new URL(link3);
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
      const hash3 = match[2] ?? url.searchParams.get("h");
      if (hash3 !== null && !/^[0-9a-f]{6,64}$/i.test(hash3)) return null;
      const query = hash3 ? `h=${hash3}&dnt=1` : "dnt=1";
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
var keys = (value, allowed) => Object.keys(value).every((key2) => allowed.includes(key2));
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

// packages/content-core/src/post-card-image.ts
var object2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var imageUrl = (value) => object2(value) && typeof value.url === "string" && value.url.length > 0;
function postCardImage(post) {
  if (imageUrl(post.heroImage)) return {
    image: post.heroImage,
    alt: post.heroImageDecorative === true ? "" : typeof post.heroImageAlt === "string" ? post.heroImageAlt : "",
    decorative: post.heroImageDecorative === true
  };
  const lead = post.leadMedia;
  if (!isPostLeadMedia(lead) || lead.kind !== "image") return void 0;
  const image = object2(post.assets) ? post.assets[lead.data.assetId] : void 0;
  if (!imageUrl(image)) return void 0;
  return {
    image,
    alt: lead.data.altDecorative === true ? "" : lead.data.alt,
    decorative: lead.data.altDecorative === true
  };
}

// packages/content-core/src/author-profiles.ts
var AUTHOR_PUBLIC_ROUTE_BASE = "/authors/";
var AUTHOR_ID_PREFIX = "au_";
var AUTHOR_ID_ENTROPY_CHARS = 32;
var AUTHOR_ID_PATTERN = new RegExp(
  `^${AUTHOR_ID_PREFIX}[0-9a-f]{${AUTHOR_ID_ENTROPY_CHARS}}$`
);
var AUTHOR_SLUG_MAX = 80;
var AUTHOR_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
var RESERVED_AUTHOR_SLUGS = [
  "index",
  "new",
  "edit",
  "admin",
  "api",
  "staff",
  "authors",
  "author",
  "me",
  "search",
  "rss",
  "feed"
];
function isValidAuthorSlug(value) {
  return typeof value === "string" && value.length > 0 && value.length <= AUTHOR_SLUG_MAX && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && !RESERVED_AUTHOR_SLUGS.includes(value);
}
function authorPublicPath(slug) {
  if (!isValidAuthorSlug(slug)) {
    throw new Error("authorPublicPath requires a valid slug");
  }
  return `${AUTHOR_PUBLIC_ROUTE_BASE}${slug}/`;
}

// packages/content-core/src/story-credits.ts
var STORY_CREDITS_MAX = 12;
var STORY_CREDIT_NAME_MAX = 120;
function storyCreditNames(credits) {
  return credits.map(
    (credit) => credit.kind === "custom" ? credit.name : credit.displayName ?? ""
  ).filter((name) => name.length > 0);
}
function storyCreditsByline(credits) {
  const names = storyCreditNames(credits);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// packages/content-core/src/home-station-posts-source.ts
function adaptHomeStationPosts(snapshot, selection) {
  if (snapshot.status === "error") return curateHomeSource("home-posts", snapshot, selection);
  if (snapshot.status !== "ready" || !Array.isArray(snapshot.posts)) throw new Error("Station Post source is invalid.");
  const cutoff = homeSourceInstant(selection.cutoffAt);
  if (cutoff === null) throw new Error("Station Post cutoff is invalid.");
  const entries = snapshot.posts.flatMap((value) => {
    if (!homeSourceObject(value) || value.noindex !== false || !homeSourceText(value.postId, 128) || !homeSourceText(value.title, 300) || !homeSourceText(value.path, 2048) || !/^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(value.path) || !Number.isSafeInteger(value.sourceVersion) || Number(value.sourceVersion) < 1 || !Array.isArray(value.credits) || value.credits.length > STORY_CREDITS_MAX || value.credits.some((credit) => !homeSourceObject(credit) || !homeSourceText(credit.name, STORY_CREDIT_NAME_MAX))) return [];
    const published = homeSourceInstant(value.publishedAt);
    const sortInstant = value.sortInstant;
    if (published === null || published > cutoff || sortInstant !== null && !Number.isSafeInteger(sortInstant) || value.displayDate != null && !isCalendarDay(value.displayDate)) return [];
    const byline = storyCreditsByline(value.credits.map((credit) => ({ kind: "custom", name: credit.name })));
    const selectedImage = postCardImage({
      ...value,
      assets: homeSourceObject(value.assets) ? value.assets : void 0
    });
    const leadImage = selectedImage && homeSourceObject(selectedImage.image) ? homeSourceImage({ ...selectedImage.image, alt: selectedImage.alt }) : void 0;
    const image = leadImage ?? (homeSourceObject(value.heroBackgroundImage) ? homeSourceImage({ url: value.heroBackgroundImage.url, alt: "" }) : void 0);
    const summary = homeSourceText(value.summary, 1e4) ? value.summary : homeSourceText(value.excerpt, 1e4) ? value.excerpt : void 0;
    const card = {
      id: value.postId,
      source: "station_posts",
      sourceVersion: Number(value.sourceVersion),
      title: value.title,
      href: contentLink(value, value.path).href,
      ...contentLinkMetadata(value),
      publishedAt: value.publishedAt,
      ...postCoverageLabelId(value) ? { coverageLabelId: postCoverageLabelId(value) } : {},
      sourceLabel: value.spotlightNews === true ? "NJ Spotlight News" : "NJ PBS",
      ...summary ? { summary } : {},
      ...isCalendarDay(value.displayDate) ? { displayDate: value.displayDate } : {},
      ...byline ? { byline } : {},
      ...image ? { image } : {}
    };
    return [{ card, sortInstant }];
  });
  entries.sort((a, b) => a.sortInstant === null && b.sortInstant !== null ? 1 : b.sortInstant === null && a.sortInstant !== null ? -1 : (b.sortInstant ?? 0) - (a.sortInstant ?? 0) || a.card.id.localeCompare(b.card.id));
  return curateHomeSource("home-posts", { status: "ready", checkedAt: snapshot.checkedAt, cards: entries.map((entry2) => entry2.card) }, selection);
}

// packages/content-core/src/home-hero.ts
init_publish_instant();
var HOME_HERO_SOURCES = ["cms_posts", "media_manager", "spotlight"];
function object3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Home hero must be an object.");
  return value;
}
function text4(value, field, maximum, required = false) {
  if (value === void 0 && !required) return void 0;
  if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new Error(`Home hero ${field} is invalid.`);
  return value;
}
function homeHeroHref(value) {
  if (safeHref(value) !== value || /[\u0000-\u0020\u007f\\]/.test(value) || !/^(https?:\/\/|\/(?!\/))/.test(value)) return false;
  if (!value.startsWith("/") && !/^https?:\/\/[^/?#]/.test(value)) return false;
  try {
    const url = new URL(value, "https://njpbs.org");
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
function readHomeHeroCatalog(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error("Home hero source catalog is invalid.");
  return value.map((value2) => {
    const item = object3(value2);
    if (item.source !== "cms_pages" && !HOME_HERO_SOURCES.includes(item.source)) throw new Error("Home hero catalog source is invalid.");
    const id2 = text4(item.id, "source id", 2048, true);
    const title = text4(item.title, "source title", 300, true);
    const summary = text4(item.summary, "source summary", 1e4) ?? "";
    const href = text4(item.href, "source destination", 2048, true);
    if (item.showInHomeHero !== void 0 && typeof item.showInHomeHero !== "boolean") throw new Error("Home hero source selection must be a boolean.");
    if (!homeHeroHref(href)) throw new Error("Home hero source destination is invalid.");
    const labels = (value3) => {
      if (!Array.isArray(value3) || value3.length > 100) throw new Error("Home hero source classification is invalid.");
      return value3.map((label) => text4(label, "source classification", 200, true));
    };
    let image;
    if (item.image !== void 0) {
      const raw = object3(item.image);
      if (item.source === "spotlight") {
        image = spotlightStoryImage({
          image: raw.url,
          fallbackImage: raw.fallbackUrl,
          topicSlug: Array.isArray(item.categories) ? item.categories[0] : void 0,
          href
        });
      } else {
        const url = text4(raw.url, "source image", 2048, true);
        if (!homeHeroHref(url)) throw new Error("Home hero source image is invalid.");
        const thumbnails = cmsImageThumbnails(raw);
        image = {
          url,
          alt: text4(raw.alt, "source image description", 1e3) ?? "",
          ...Number.isSafeInteger(raw.width) && Number(raw.width) > 0 ? { width: Number(raw.width) } : {},
          ...Number.isSafeInteger(raw.height) && Number(raw.height) > 0 ? { height: Number(raw.height) } : {},
          ...thumbnails.length ? { thumbnails } : {}
        };
      }
    }
    return {
      id: id2,
      title,
      summary,
      href,
      source: item.source,
      ...contentLinkMetadata(item),
      categories: labels(item.categories),
      tags: labels(item.tags),
      ...item.source === "cms_posts" && item.showInHomeHero === true ? { showInHomeHero: true } : {},
      ...item.byline === void 0 ? {} : { byline: text4(item.byline, "source byline", 2e3) },
      ...item.source === "spotlight" && item.bylineSource === "coauthors-plus" ? { bylineSource: "coauthors-plus" } : {},
      ...item.source === "cms_posts" && isCoverageLabelId(item.coverageLabelId) ? { coverageLabelId: item.coverageLabelId } : {},
      ...item.source === "cms_posts" && item.spotlightNews === true ? { spotlightNews: true } : {},
      ...isCalendarDay(item.displayDate) ? { displayDate: item.displayDate } : {},
      ...item.eyebrow === void 0 ? {} : { eyebrow: text4(item.eyebrow, "source name", 200) },
      ...image ? { image } : {}
    };
  });
}

// packages/content-core/src/home-published-sources.ts
function object4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text5(value) {
  if (typeof value !== "string")
    throw new Error("A Home source card has invalid text.");
  return value;
}
function link(value) {
  const href = text5(value);
  if (safeHref(href) === null || !/^(https?:\/\/|\/(?!\/))/.test(href)) {
    throw new Error("A Home source card has an invalid link.");
  }
  return href;
}
function date(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("A Home source has an invalid check time.");
  }
  return value;
}
function cards(value, maximum, read) {
  if (!Array.isArray(value) || value.length > maximum || value.some((card) => !object4(card))) {
    throw new Error("The Home source card list is invalid.");
  }
  return value.map(read);
}
function program(card) {
  const image = homeSourceImage({ url: card.image, alt: "" });
  return {
    title: text5(card.title),
    description: text5(card.description),
    href: link(card.href),
    ...image ? { image: image.url } : {}
  };
}
function news(card) {
  const image = spotlightStoryImage(card);
  return {
    title: text5(card.title),
    category: text5(card.category),
    href: link(card.href),
    image: image.url,
    ...image.fallbackUrl || card.fallbackImage !== void 0 ? { fallbackImage: image.fallbackUrl ?? image.url } : {},
    ...card.dateLabel === void 0 ? {} : { dateLabel: text5(card.dateLabel) }
  };
}
function optionalHeroCatalog(value) {
  if (value === void 0) return {};
  try {
    return { heroCatalog: readHomeHeroCatalog(value) };
  } catch {
    return {};
  }
}
function readHomeSourceSnapshot(value, publication) {
  if (!object4(value) || value.schemaVersion !== 1 || !object4(value.publication) || !object4(publication) || publication.schemaVersion !== 1) {
    throw new Error(
      "The Home source and publication receipts do not match. Try loading the cards again."
    );
  }
  const receipt = value.publication;
  if (typeof receipt.buildBatchId !== "string" || !receipt.buildBatchId || !Number.isSafeInteger(receipt.generation) || Number(receipt.generation) < 1 || typeof receipt.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(receipt.commitSha) || receipt.buildBatchId !== publication.buildBatchId || receipt.generation !== publication.generation || receipt.commitSha !== publication.commitSha) {
    throw new Error(
      "The Home source and publication receipts do not match. Try loading the cards again."
    );
  }
  if (!object4(value.pbs) || value.pbs.source !== "media-manager" && value.pbs.source !== "manual" || !object4(value.spotlight) || value.spotlight.source !== "spotlight-rss") {
    throw new Error("The Home source names are invalid.");
  }
  return {
    schemaVersion: 1,
    ...value.editorial === void 0 ? {} : { editorial: (() => {
      const editorial = readHomeEditorialSourceReceipt(value.editorial);
      if (homeCatalogJson({
        buildBatchId: editorial.receipt.buildBatchId,
        generation: editorial.receipt.generation,
        commitSha: editorial.receipt.commitSha
      }) !== homeCatalogJson({
        buildBatchId: receipt.buildBatchId,
        generation: receipt.generation,
        commitSha: receipt.commitSha
      })) throw new Error("Home catalog and publication receipts do not match.");
      return editorial;
    })() },
    ...optionalHeroCatalog(value.heroCatalog),
    publication: {
      buildBatchId: receipt.buildBatchId,
      generation: Number(receipt.generation),
      commitSha: receipt.commitSha
    },
    pbs: {
      source: value.pbs.source,
      ...Object.hasOwn(value.pbs, "newscast") ? { newscast: readHomeNewscastPacket(value.pbs.newscast) } : {},
      checkedAt: date(value.pbs.checkedAt),
      featured: cards(value.pbs.featured, 8, program),
      more: cards(value.pbs.more, 16, program)
    },
    spotlight: {
      source: "spotlight-rss",
      checkedAt: date(value.spotlight.checkedAt),
      cards: cards(value.spotlight.cards, 8, news)
    }
  };
}

// site/src/lib/home-editorial-catalog.ts
function createHomeEditorialCatalog(snapshot, spotlight, posts, cutoffAt, selectedPostIds = [], recordCards, selectedNewsletterIds = []) {
  if (!snapshot.publication) throw new Error("Home selection catalogs require a published generation.");
  const pbs = (section, pool) => {
    const checkedAt3 = snapshot.pbs.checkedAt ?? cutoffAt;
    const cards2 = pool.map((card) => ({
      id: card.href,
      source: section === "home-featured" ? "pbs_featured" : "pbs_more",
      title: card.title,
      href: card.href,
      ...card.description.trim() ? { summary: card.description } : {},
      sourceLabel: "PBS \xB7 NJ PBS",
      ...card.image ? { image: { url: card.image, alt: "" } } : {}
    }));
    return { status: "ready", checkedAt: checkedAt3, cards: cards2.flatMap((card) => curateHomeSource(
      section,
      { status: "ready", checkedAt: checkedAt3, cards: [card] },
      { cutoffAt }
    ).cards) };
  };
  const checkedAt2 = spotlight.checkedAt ?? cutoffAt;
  const sourceCards = (spotlight.cards ?? []).slice(0, 200).flatMap((card) => adaptHomeSpotlight({
    status: "ready",
    source: "nj-spotlight-news-rss",
    checkedAt: checkedAt2,
    cards: [card]
  }, { cutoffAt }).cards);
  const sortedPosts = [...posts].sort((a, b) => (b.sortInstant ?? 0) - (a.sortInstant ?? 0) || a.postId.localeCompare(b.postId));
  const required = new Set(selectedPostIds);
  const chosen = new Set([...sortedPosts.filter((post) => required.has(post.postId)), ...sortedPosts].slice(0, 200).map((post) => post.postId));
  const postCards = sortedPosts.filter((post) => chosen.has(post.postId)).flatMap((post) => adaptHomeStationPosts({ status: "ready", checkedAt: cutoffAt, posts: [post] }, { cutoffAt }).cards);
  const unique = (cards2) => cards2.filter((card) => cards2.filter((candidate) => candidate.id === card.id).length === 1);
  const catalog = boundHomeNewsletterCatalog({
    schemaVersion: 1,
    cutoffAt,
    ...recordCards || snapshot.pbs.newscast ? { services: {
      newsletters: recordCards ? createHomeNewsletterSnapshot(recordCards, cutoffAt, cutoffAt, selectedNewsletterIds) : { status: "error" },
      ...snapshot.pbs.newscast ? { newscast: resolveHomeNewscastPacket(snapshot.pbs.newscast, cutoffAt) } : {}
    } } : {},
    sources: {
      "home-featured": pbs("home-featured", snapshot.pbs.featured),
      "home-more": pbs("home-more", snapshot.pbs.more),
      "home-spotlight": { status: "ready", checkedAt: checkedAt2, cards: unique(sourceCards) },
      "home-posts": { status: "ready", checkedAt: cutoffAt, cards: unique(postCards) }
    }
  }, selectedNewsletterIds);
  return { catalog, receipt: {
    ...snapshot.publication,
    digest: (0, import_node_crypto.createHash)("sha256").update(homeCatalogJson(catalog)).digest("hex")
  } };
}
function assertHomeSourcePublication(sources, publication) {
  if (!publication || homeCatalogJson(sources.publication) !== homeCatalogJson({
    buildBatchId: publication.buildBatchId,
    generation: publication.generation,
    commitSha: publication.commitSha
  })) throw new Error("Home sources do not match this publication.");
  if (sources.editorial) {
    const editorial = readHomeEditorialSourceReceipt(sources.editorial);
    if (editorial.receipt.buildBatchId !== publication.buildBatchId || editorial.receipt.generation !== publication.generation || editorial.receipt.commitSha !== publication.commitSha || (0, import_node_crypto.createHash)("sha256").update(homeCatalogJson(editorial.catalog)).digest("hex") !== editorial.receipt.digest) {
      throw new Error("Home catalog does not match this publication.");
    }
  }
  return readHomeSourceSnapshot(sources, {
    schemaVersion: 1,
    buildBatchId: publication.buildBatchId,
    generation: publication.generation,
    commitSha: publication.commitSha
  });
}

// packages/content-core/src/data/related-stories.json
var related_stories_default = {
  checkedAt: "2026-09-08T15:43:39.663Z",
  provenance: "NJ Spotlight News RSS snapshots: https://www.njspotlightnews.org/budget/feed/ (checked 2026-09-08T15:43:39.664Z); https://www.njspotlightnews.org/business/feed/ (checked 2026-09-08T15:43:40.117Z); https://www.njspotlightnews.org/energy-environment/feed/ (checked 2026-09-08T15:43:39.663Z); https://www.njspotlightnews.org/immigration/feed/ (checked 2026-09-08T15:43:39.729Z); https://www.njspotlightnews.org/social-issues/feed/ (checked 2026-09-08T15:43:40.133Z). Topics match the publisher's source categories/tags exactly; no headline inference. Input order supplies curated order; this data is pending editorial review until its PR is approved. Featured images for the first five budget stories verified against publisher RSS and WordPress featured-media records on 2026-09-13. Story dates, topics and order are unchanged.",
  items: [
    {
      id: "njspotlight-851e750f9a757a42e2d083a22ae8ccb81af320d52d5227d62fc4bad4c8e1faae",
      source: "njpbs_related_index",
      title: "It\u2019s not your imagination: \u2018Bracket creep\u2019 costing you more in taxes",
      href: "https://www.njspotlightnews.org/2026/08/its-not-your-imagination-bracket-creep-costing-you-more-in-taxes/",
      topics: [
        "budget"
      ],
      publishedAt: "2026-08-31T04:09:33.000Z",
      sourceLabel: "NJ Spotlight News",
      thumbnail: {
        url: "https://media.njpbs.org/cms-media/spotlight/1d8a624c901423a554da02a1710a446eda699d3475888239d5c8cf3d8f2f8251/43b02cd0d7d4d20e02efa7ee6f117bfd9d7d29183d4b01afb824a58850d972fa.jpg",
        alt: ""
      }
    },
    {
      id: "njspotlight-982f6096f17a048be49dc851513c9c332b8caf1297771f05dd0409fea175fcde",
      source: "njpbs_related_index",
      title: "Democratic districts cashed in as NJ lawmakers drafted spending bills",
      href: "https://www.njspotlightnews.org/2026/08/democratic-districts-cashed-in-as-nj-lawmakers-drafted-spending-bills/",
      topics: [
        "budget"
      ],
      publishedAt: "2026-08-20T04:05:30.000Z",
      sourceLabel: "NJ Spotlight News",
      thumbnail: {
        url: "https://media.njpbs.org/cms-media/spotlight/90564cfd4362a2d3462986c4cbcb246304f8582ee8dfc6a49f4299042889bc7f/e03683dcd40ccbdd56b42cbc5ae17a2436c290471053fe716e2c4d002c6fd74d.jpg",
        alt: ""
      }
    },
    {
      id: "njspotlight-2acbffdf0e46d846d37f7fcd3a1664bcc373a7d178accac4961ebe8b52e64818",
      source: "njpbs_related_index",
      title: "NJ tax collections jump 9% in July, giving Sherrill budget an early boost",
      href: "https://www.njspotlightnews.org/2026/08/nj-treasury-tax-collections-ticked-up-in-july/",
      topics: [
        "budget"
      ],
      publishedAt: "2026-08-19T04:08:37.000Z",
      sourceLabel: "NJ Spotlight News",
      thumbnail: {
        url: "https://media.njpbs.org/cms-media/spotlight/cb58376680a73df9362999413185d01bd2b0b6a260d16fb612475c5e0dabcae9/b2fdeece6cec886de89c0ee2c6726e1928887dc07eb82bec44398742400326f0.jpg",
        alt: ""
      }
    },
    {
      id: "njspotlight-f04d0b79f709214dfae42d370d353fb64b33b2654a0ba36464efc0d30cb187a0",
      source: "njpbs_related_index",
      title: "Workers, retirees among those urging NJ pension to look beyond the bottom line",
      href: "https://www.njspotlightnews.org/2026/08/workers-retirees-among-those-urging-nj-pension-to-look-beyond-the-bottom-line/",
      topics: [
        "budget",
        "delaney-hall"
      ],
      publishedAt: "2026-08-03T04:08:19.000Z",
      sourceLabel: "NJ Spotlight News",
      thumbnail: {
        url: "https://media.njpbs.org/cms-media/spotlight/77abda1058885842264827a77c093955df56f04ca2685be102786866dd1642e5/d700ed67f6689e1410fad8d8c8ba9e0547bb517cef91679e4fe157c6672e40a8.jpg",
        alt: ""
      }
    },
    {
      id: "njspotlight-acc13f01c6c9a678bd00f138a47f3ef2081b41e617660ea2895e391b12d53591",
      source: "njpbs_related_index",
      title: "Funding gap delays NJ\u2019s new mental health crisis centers",
      href: "https://www.njspotlightnews.org/2026/07/funding-gap-delays-njs-new-mental-health-crisis-centers/",
      topics: [
        "budget"
      ],
      publishedAt: "2026-07-30T04:12:12.000Z",
      sourceLabel: "NJ Spotlight News",
      thumbnail: {
        url: "https://media.njpbs.org/cms-media/spotlight/b219a651c49d95a98be60d71024ee72b6832d786fdef05c11508e96eb5aa648a/1ee8bc08e4a13cf93fb64ddcebdc2ca470360bb640cd998f598cde9215165276.jpg",
        alt: ""
      }
    },
    {
      id: "njspotlight-ce742117a569fca5398d0aa0b8abab181871445563a7d18b10ea13bdba4a724c",
      source: "njpbs_related_index",
      title: "New Jersey pension fund on track to continue winning streak",
      href: "https://www.njspotlightnews.org/2026/07/new-jersey-pension-fund-on-track-to-continue-winning-streak/",
      topics: [
        "budget"
      ],
      publishedAt: "2026-07-30T04:08:15.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-6f37919b1f0144a036c619ec51b172a9a39f2fd9bf2ce5e2efb04982c8bc0e84",
      source: "njpbs_related_index",
      title: "NJ taps employers with workers on Medicaid to counter Trump cuts",
      href: "https://www.njspotlightnews.org/2026/07/nj-taps-employers-with-workers-on-medicaid-to-counter-trump-cuts/",
      topics: [
        "budget",
        "business"
      ],
      publishedAt: "2026-07-27T04:08:39.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-180e4d1cecff630d98894c48191c287932db1bfc558db303aa4097d3767cf7b8",
      source: "njpbs_related_index",
      title: "NJ Transit approves biggest budget ever, with 3% higher fares",
      href: "https://www.njspotlightnews.org/2026/07/nj-transit-approves-biggest-budget-ever-with-3-higher-fares/",
      topics: [
        "budget"
      ],
      publishedAt: "2026-07-22T04:12:59.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-d1a591e17b58d3f228c3546c74f6d46ca2764f48506dcd471f4f255e36d36469",
      source: "njpbs_related_index",
      title: "NJ Lottery sales up 5%, generating $1 billion-plus for pension system",
      href: "https://www.njspotlightnews.org/2026/07/nj-lottery-sales-up-5-generating-1-billion-plus-for-pension-system/",
      topics: [
        "budget"
      ],
      publishedAt: "2026-07-22T04:08:23.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-5ef8c05eadedb328aafbf1c1acc27acb707c8e47dd6bea3ae1fb4bd451e12703",
      source: "njpbs_related_index",
      title: "Senior, disabled homeowners up first for $4B in property tax relief",
      href: "https://www.njspotlightnews.org/2026/07/senior-disabled-homeowners-up-first-for-4b-in-property-tax-relief/",
      topics: [
        "budget"
      ],
      publishedAt: "2026-07-20T04:08:52.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-67329fd525775e18ebc719d8ae23e0fddb531ad96ae2ee393f90b2fd2653f5a2",
      source: "njpbs_related_index",
      title: "NJ coaxing World Cup fans to celebrate on this side of the Hudson",
      href: "https://www.njspotlightnews.org/2026/06/nj-coaxing-world-cup-fans-to-celebrate-on-this-side-of-the-hudson/",
      topics: [
        "business"
      ],
      publishedAt: "2026-06-09T04:10:57.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-0705db36b7bcc46b49df95a9f2e02138c4c27aae49b6a7561de4d6222437e3c1",
      source: "njpbs_related_index",
      title: "Burlington City gets lawmakers\u2019 backing for economic zone program",
      href: "https://www.njspotlightnews.org/2026/05/burlington-city-gets-lawmakers-backing-for-economic-zone-program/",
      topics: [
        "business"
      ],
      publishedAt: "2026-05-19T04:05:20.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-3d50fb71c55fd5616af7c489cac659e846e9250a5fbe2d20ec0d40bf1454acae",
      source: "njpbs_related_index",
      title: "Financial, consumer watchdog on \u2018life support\u2019 under Trump",
      href: "https://www.njspotlightnews.org/2026/02/consumer-financial-protection-bureau-cfpb-on-life-support/",
      topics: [
        "business"
      ],
      publishedAt: "2026-02-12T05:09:27.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-b498fdbbeb038675ba08fb26b73e01415f8bba4f84554733b0f3a9848e0eb3e6",
      source: "njpbs_related_index",
      title: "Slight boost in jobs, tax revenue ahead of Sherrill\u2019s first spending proposal",
      href: "https://www.njspotlightnews.org/2026/01/slight-boost-in-jobs-tax-revenue-ahead-of-sherrills-first-spending-proposal/",
      topics: [
        "budget",
        "business"
      ],
      publishedAt: "2026-01-26T05:09:43.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-87445d9b579296d1983be23cfb88c95628870b633edd822f381e546bb13ab450",
      source: "njpbs_related_index",
      title: "NJ minimum wage rises, but not for all",
      href: "https://www.njspotlightnews.org/2026/01/nj-minimum-wage-rises-but-not-for-all/",
      topics: [
        "business"
      ],
      publishedAt: "2026-01-05T05:07:53.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-c8edcfe2a83be1db9b220f2b699cf79dd9a488d30e038f62bfc8fb585e202869",
      source: "njpbs_related_index",
      title: "Stagnating national jobs market raises economic concerns",
      href: "https://www.njspotlightnews.org/2025/12/stagnating-national-jobs-market-raises-economic-concerns/",
      topics: [
        "business"
      ],
      publishedAt: "2025-12-18T05:13:00.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-7707870fd1216d0e664a3a8b0c61c016d43716d270147bddcc44f90768ac86e5",
      source: "njpbs_related_index",
      title: "FIFA World Cup ticket prices leave fans frustrated and priced out",
      href: "https://www.njspotlightnews.org/2025/12/fifa-world-cup-ticket-prices-leave-fans-frustrated-and-priced-out/",
      topics: [
        "business"
      ],
      publishedAt: "2025-12-17T05:10:34.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-f2fda795fc4bb8fb02aea79d5a6175f8e5f8736052a5713e509ca4d7cc6c058e",
      source: "njpbs_related_index",
      title: "Could layoffs in NJ preview a recession for 2026?",
      href: "https://www.njspotlightnews.org/2025/12/could-layoffs-in-nj-preview-a-recession-in-2026/",
      topics: [
        "business"
      ],
      publishedAt: "2025-12-10T05:11:37.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-f47da9a16f2830e71de7e338df333ef4cf842aa574d71bd019c50b8f9d1359bd",
      source: "njpbs_related_index",
      title: "House votes to delay North Atlantic right whale protections",
      href: "https://www.njspotlightnews.org/2026/09/house-votes-to-delay-north-atlantic-right-whale-protections/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-09-04T04:08:56.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-b5bc65ea239bbb711b6e7bce837112bfbfee93a8bd2269b6b740702b030d692d",
      source: "njpbs_related_index",
      title: "How to save endangered NJ marsh from rising sea: Build it higher",
      href: "https://www.njspotlightnews.org/2026/09/how-to-save-endangered-nj-marsh-from-rising-sea-build-it-higher/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-09-03T04:10:42.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-fa9ba4029aaf5cdbd561c80b1a07827112a255979ef065ebff78a18df02813c0",
      source: "njpbs_related_index",
      title: "Power utility overbilled customers, erred on tax law, audit finds",
      href: "https://www.njspotlightnews.org/2026/09/power-utility-overbilled-customers-erred-on-tax-law-audit-finds/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-09-02T04:14:32.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-e7663fcc2589587bda8474375f23729184edb78caaeacf36ddde363e2da05323",
      source: "njpbs_related_index",
      title: "Operator of leaky pipeline blocked inspectors, regulator says",
      href: "https://www.njspotlightnews.org/2026/08/operator-of-leaky-pipeline-blocked-inspectors-regulator-says/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-08-26T04:04:48.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-d89aec13ddbb1f5920e124a612cd69c3cd2e46e0ea189697423292b2b6ef8ffc",
      source: "njpbs_related_index",
      title: "Why \u2018salt finger mixing\u2019 draws Rutgers scientists to warming ocean",
      href: "https://www.njspotlightnews.org/2026/08/why-salt-finger-mixing-draws-rutgers-scientists-to-warming-ocean/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-08-24T04:10:19.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-f2de4b3dbd6157bb43499f83f6457d6a407e6e7616d8ac987f08529fcddca036",
      source: "njpbs_related_index",
      title: "The aching human soul of Keyport\u2019s feared cancer cluster",
      href: "https://www.njspotlightnews.org/2026/08/the-aching-human-soul-of-keyports-feared-cancer-cluster/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-08-18T04:08:45.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-396d98ce2b6937f06308d977db75927c5f176711f817059ae9c96985bb9a2df8",
      source: "njpbs_related_index",
      title: "How a question about water filters sparked a movement in Newark",
      href: "https://www.njspotlightnews.org/2026/08/how-a-question-about-water-filters-sparked-a-movement-in-newark/",
      topics: [
        "energy-environment",
        "social-issues"
      ],
      publishedAt: "2026-08-10T04:12:24.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-a10de1ff56c9871d09c6acf3f6a812accbac45efe0ccd167f6e77ef5f7078c27",
      source: "njpbs_related_index",
      title: "Chemicals persistent in cancer-riddled area near Keyport landfill",
      href: "https://www.njspotlightnews.org/2026/07/chemicals-persistent-in-cancer-riddled-area-near-keyport-landfill/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-07-30T04:10:52.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-bb18e091065e7d0eda353be224d2cb44fbd43ef4fda9cd7553fde8c7211af38b",
      source: "njpbs_related_index",
      title: "Food parasite fear drives customers to trusted New Jersey farm",
      href: "https://www.njspotlightnews.org/2026/07/food-parasite-fear-drives-customers-to-trusted-new-jersey-farm/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-07-27T04:10:41.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-5a0e4018acd4105537228b824ceb505cc08a039b1ce10a18e7697453b75a2bcb",
      source: "njpbs_related_index",
      title: "Fracking ban in Delaware River watershed survives GOP challenge",
      href: "https://www.njspotlightnews.org/2026/07/fracking-ban-in-delaware-river-watershed-survives-gop-challenge/",
      topics: [
        "energy-environment"
      ],
      publishedAt: "2026-07-23T04:12:03.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-dce449f9c696154b8d96bb2a3abefcfbcd7b07bcc47ea9a6ea1261d52d402246",
      source: "njpbs_related_index",
      title: "Q&A: Teacher of the Year creates safe zone amid \u2018culture of fear\u2019",
      href: "https://www.njspotlightnews.org/2026/09/qa-teacher-of-the-year-creates-safe-zone-amid-culture-of-fear/",
      topics: [
        "immigration",
        "delaney-hall"
      ],
      publishedAt: "2026-09-01T04:10:25.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-68ad0bdb216f5fab06f8dff38f54e724ef51b213f92b6b7fedb661e274aef26a",
      source: "njpbs_related_index",
      title: "McIver loses bid to toss charges over Delaney Hall clash with ICE",
      href: "https://www.njspotlightnews.org/2026/08/mciver-loses-bid-to-dismiss-charges-in-delaney-hall-scrum-with-ice/",
      topics: [
        "immigration",
        "delaney-hall"
      ],
      publishedAt: "2026-08-27T04:12:47.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-2ab6f833caa09a2246fd56de16f4db00a301afa395feb4c9eceba127a79b1fde",
      source: "njpbs_related_index",
      title: "Who\u2019s behind the mask? New Jerseyans haunted by ICE run-ins",
      href: "https://www.njspotlightnews.org/2026/08/whos-behind-the-mask-new-jerseyans-haunted-by-ice-run-ins/",
      topics: [
        "immigration",
        "delaney-hall"
      ],
      publishedAt: "2026-08-27T04:10:44.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-085c6243339a1c49c0420defd374586bba90ffc111eda6545b12d1191b74692b",
      source: "njpbs_related_index",
      title: "Post-detention deaths to go untracked in \u2018common sense\u2019 ICE move",
      href: "https://www.njspotlightnews.org/2026/08/post-detention-deaths-to-go-untracked-by-ices-common-sense-move/",
      topics: [
        "immigration",
        "delaney-hall"
      ],
      publishedAt: "2026-08-11T04:06:20.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-1aa53bfa0472c75fb1415df0bda8261c2afeb11b654035dc437412f12d3b8fec",
      source: "njpbs_related_index",
      title: "Death shows Delaney \u2018not adequate\u2019 in emergency, McIver says",
      href: "https://www.njspotlightnews.org/2026/08/death-shows-delaney-not-adequate-in-emergency-mciver-says/",
      topics: [
        "immigration",
        "delaney-hall"
      ],
      publishedAt: "2026-08-05T04:10:10.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-901db9adcdae7f4b2fa4c1a482b2c2ade03a3ec4d1739dd83082b3cda6e12eb5",
      source: "njpbs_related_index",
      title: "Why advocates want an end to all immigrant detention",
      href: "https://www.njspotlightnews.org/2026/07/why-advocates-want-an-end-to-all-immigrant-detention/",
      topics: [
        "immigration",
        "delaney-hall"
      ],
      publishedAt: "2026-07-22T04:10:21.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-6adc52add46a87a8baf89de38f74525fe42c61b25737901f84b2bcdf6759212b",
      source: "njpbs_related_index",
      title: "Thousands of non-citizens registered to vote in NJ, Sherrill says",
      href: "https://www.njspotlightnews.org/2026/07/thousands-of-non-citizens-registered-to-vote-in-nj-sherrill-says/",
      topics: [
        "immigration"
      ],
      publishedAt: "2026-07-22T04:06:22.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-ee2dcdc660b5901204ef5741fd09e0462e5ba7b00483c4ca0efd156574d0b503",
      source: "njpbs_related_index",
      title: "Immigration courts running like \u2018deportation machine,\u2019 attorneys say",
      href: "https://www.njspotlightnews.org/2026/07/immigration-courts-running-like-deportation-machine-attorneys-say/",
      topics: [
        "immigration"
      ],
      publishedAt: "2026-07-16T04:12:04.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-22297f885cb29eb2e9bebcc855e76833af405e9fc4277988e7d86e5067cbc458",
      source: "njpbs_related_index",
      title: "Judge criticized in rape case now serving on immigration court",
      href: "https://www.njspotlightnews.org/2026/07/judge-criticized-in-rape-case-now-serving-on-immigration-court/",
      topics: [
        "immigration"
      ],
      publishedAt: "2026-07-08T04:08:28.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-e1ef78177b6391b4069d75a5f99aa825c0fe077554a95946b6adde2359ccb34e",
      source: "njpbs_related_index",
      title: "As Trump rants, Democrats and advocates hail U.S. birthright ruling",
      href: "https://www.njspotlightnews.org/2026/07/as-trump-rants-democrats-and-advocates-hail-u-s-birthright-ruling/",
      topics: [
        "immigration"
      ],
      publishedAt: "2026-07-01T04:06:54.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-2102eb1f0507bcdd32527c4c477e3aeba348ce1b8d79fd7294f209cc8dc2f603",
      source: "njpbs_related_index",
      title: "NJ finds $16 million for crisis centers left out of state budget",
      href: "https://www.njspotlightnews.org/2026/08/nj-finds-16-million-for-crisis-centers-left-out-of-state-budget/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2026-08-24T04:08:07.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-b30b3910b1b11e49314af3c1ba08d914ef85d792d56dba1f92cecf243b00b9ed",
      source: "njpbs_related_index",
      title: "\xBFNo tienes ahorros para la jubilaci\xF3n? NJ ampl\xEDa el programa para empleados de empresas privadas",
      href: "https://www.njspotlightnews.org/2026/08/no-tienes-ahorros-para-la-jubilacion-nj-amplia-el-programa-para-empleados-de-empresas-privadas/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2026-08-14T04:14:43.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-35b4e572337b1e9fba24b591f95557935ddf97f56b78abd57921c5618c141809",
      source: "njpbs_related_index",
      title: "No retirement savings? NJ broadens program for privately employed",
      href: "https://www.njspotlightnews.org/2026/08/no-retirement-savings-nj-broadens-program-for-privately-employed/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2026-08-10T04:08:20.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-e38d810c66e02c3ff9113f1300a91417481398d921aa5985343416a2ad70379a",
      source: "njpbs_related_index",
      title: "Health care, food aid enrollees down as deeper federal cuts loom",
      href: "https://www.njspotlightnews.org/2026/07/health-care-food-aid-enrollees-down-as-deeper-federal-cuts-loom/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2026-07-14T04:08:20.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-de40aca0f9f39982a9666715e3253a1866338c5f32c389b639f60552232fac61",
      source: "njpbs_related_index",
      title: "SNAP food program benefits more than recipients, study finds",
      href: "https://www.njspotlightnews.org/2026/06/snap-food-program-benefits-more-than-recipients-study-finds/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2026-06-12T04:12:00.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-5dbd6a9bfe2e0e54da8a49a169aca657086d5e514b2e41e0cbc76ad4c97200cc",
      source: "njpbs_related_index",
      title: "\u2018Pretty scary\u2019: Food pantries expect surge due to SNAP work rule",
      href: "https://www.njspotlightnews.org/2026/04/pretty-scary-food-pantries-expect-surge-due-to-snap-work-rule/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2026-04-23T04:12:40.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-45df99135058e3d7437e1203faae0dba5d0f3f584a3456e2c74078c0c77a3402",
      source: "njpbs_related_index",
      title: "For the unhoused in bitter cold, Camden resource fair offers lifeline",
      href: "https://www.njspotlightnews.org/2026/01/for-the-unhoused-in-bitter-cold-camden-resource-fair-offers-lifeline/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2026-01-30T05:10:38.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-699e64f14d6e8a3ead9c4456882ed9e2935298906ab8845345cc13b9145aeb28",
      source: "njpbs_related_index",
      title: "Prison bills advance but deadline nears",
      href: "https://www.njspotlightnews.org/2026/01/prison-bills-advance-but-deadline-nears/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2026-01-07T05:08:28.000Z",
      sourceLabel: "NJ Spotlight News"
    },
    {
      id: "njspotlight-466876896fb6c5e4eccb8e2ee3602d2545651ddb32c32317422c5615db83dca3",
      source: "njpbs_related_index",
      title: "Government shutdown could leave thousands in NJ without food assistance",
      href: "https://www.njspotlightnews.org/2025/10/government-shutdown-could-leave-thousands-in-nj-without-food-assistance/",
      topics: [
        "social-issues"
      ],
      publishedAt: "2025-10-29T04:12:54.000Z",
      sourceLabel: "NJ Spotlight News"
    }
  ]
};

// packages/content-core/src/shelf-catalog.ts
var RELATED_STORY_INDEX = Object.freeze({
  ...related_stories_default,
  items: Object.freeze(related_stories_default.items.map((item) => Object.freeze({
    ...item,
    topics: Object.freeze(item.topics)
  })))
});
var APPROVED_VIDEO_LIBRARY = Object.freeze({
  checkedAt: "2026-08-22T00:00:00.000Z",
  provenance: "Empty pending per-asset video metadata. The committed Media Manager snapshot is a show list with no runtime, caption, or availability data, and the credentialed asset fetch that would carry them has not landed; no entry is added until its rights, captions, runtime, thumbnail, and access are sourced.",
  items: Object.freeze([])
});

// packages/content-core/src/editorial-date-format.ts
var AP_MONTHS = [
  "Jan.",
  "Feb.",
  "March",
  "April",
  "May",
  "June",
  "July",
  "Aug.",
  "Sept.",
  "Oct.",
  "Nov.",
  "Dec."
];
function parseCalendarDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}
function formatEditorialDate(value) {
  if (typeof value !== "string") return null;
  const parsed = parseCalendarDay(value);
  if (!parsed) return null;
  return `${AP_MONTHS[parsed.month - 1]} ${parsed.day}, ${parsed.year}`;
}

// site/src/lib/home-sources.ts
function sourceCard(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Home source card is invalid");
  }
  return value;
}
function text6(value) {
  if (typeof value !== "string") throw new Error("Home source text is invalid");
  return value;
}
function link2(value) {
  const href = text6(value);
  if (safeHref(href) === null || !/^(https?:\/\/|\/(?!\/))/.test(href)) {
    throw new Error("Home source URL is invalid");
  }
  return href;
}
function programCard(value) {
  const card = sourceCard(value);
  return {
    title: text6(card.title),
    description: text6(card.description),
    href: link2(card.href),
    ...card.image ? { image: link2(card.image) } : {}
  };
}
function newsCard(value) {
  const card = sourceCard(value);
  const image = spotlightStoryImage(card);
  const dateLabel = formatEditorialDate(stationCalendarDay(spotlightFeedInstant(card.publishedAt)));
  return {
    title: text6(card.title),
    href: link2(card.href),
    category: text6(card.category),
    image: image.url,
    fallbackImage: image.fallbackUrl ?? image.url,
    ...dateLabel ? { dateLabel } : card.dateLabel === void 0 ? {} : { dateLabel: text6(card.dateLabel) }
  };
}
function checkedAt(value) {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}
function createHomeSourceSnapshot(media, spotlight, publication = null) {
  const mediaCards = (media.cards ?? []).filter(Boolean);
  const pool = selectLaunchCards(
    mediaCards,
    manualLaunchCards
  ).slice(0, 24).map(programCard);
  const feedStories = (spotlight.cards ?? []).map(sourceCard);
  const heroCatalog = [
    ...mediaCards.slice(0, 100).flatMap((value) => {
      try {
        const card = programCard(value);
        return readHomeHeroCatalog([{
          id: card.href,
          source: "media_manager",
          title: card.title,
          summary: card.description,
          href: card.href,
          categories: [],
          tags: [],
          eyebrow: "PBS \xB7 NJ PBS",
          ...card.image ? { image: { url: card.image, alt: "" } } : {}
        }]);
      } catch {
        return [];
      }
    }),
    ...RELATED_STORY_INDEX.items.map((card) => {
      const feedStory = feedStories.find((item) => item.href === card.href);
      const byline = spotlightCardByline(feedStory);
      const displayDate = isCalendarDay(card.publishedAt) ? card.publishedAt : stationCalendarDay(card.publishedAt);
      const topicImage = spotlightTopicImageForStory(card.topics, card.publishedAt, card.href);
      return {
        id: card.id,
        source: "spotlight",
        title: card.title,
        summary: card.summary ?? "",
        href: card.href,
        categories: [...card.topics],
        tags: [],
        ...displayDate ? { displayDate } : {},
        ...byline ? { byline, bylineSource: "coauthors-plus" } : {},
        eyebrow: card.sourceLabel,
        ...feedStory && spotlightCopyImageUrl(feedStory.image) ? { image: spotlightStoryImage(feedStory) } : card.thumbnail ? { image: spotlightStoryImage({ image: card.thumbnail.url, topicSlug: card.topics[0], href: card.href }) } : feedStory ? { image: spotlightStoryImage(feedStory) } : topicImage ? { image: { url: topicImage, alt: "" } } : {}
      };
    }),
    ...feedStories.flatMap((card) => {
      try {
        const byline = spotlightCardByline(card);
        return readHomeHeroCatalog([{
          id: card.href,
          source: "spotlight",
          title: card.title,
          summary: "",
          href: card.href,
          categories: Array.isArray(card.sourceCategories) ? card.sourceCategories : [],
          tags: [],
          ...byline ? { byline, bylineSource: "coauthors-plus" } : {},
          eyebrow: "NJ Spotlight News",
          displayDate: stationCalendarDay(spotlightFeedInstant(card.publishedAt)),
          image: spotlightStoryImage(card)
        }]);
      } catch {
        return [];
      }
    })
  ];
  return {
    heroCatalog: heroCatalog.filter((card, index) => heroCatalog.findIndex((candidate) => candidate.href === card.href) === index),
    schemaVersion: 1,
    publication: publication ? {
      buildBatchId: publication.buildBatchId,
      generation: publication.generation,
      commitSha: publication.commitSha
    } : null,
    pbs: {
      ...Object.hasOwn(media, "newscast") ? { newscast: readHomeNewscastPacket(media.newscast) } : {},
      source: mediaCards.length ? "media-manager" : "manual",
      checkedAt: mediaCards.length ? checkedAt(media.checkedAt) : null,
      featured: mediaCards.length > 8 ? pool.slice(0, 8) : pool,
      more: mediaCards.length > 8 ? pool.slice(8, 24) : pool
    },
    spotlight: {
      source: "spotlight-rss",
      checkedAt: checkedAt(spotlight.checkedAt),
      cards: (spotlight.cards ?? []).slice(0, 8).map(newsCard)
    }
  };
}

// site/src/lib/no-build-home-sources.ts
var externalInputNames = ["launch-media-manager.json", "spotlight-news.json", "schedule.json"];
function externalContentValue(value) {
  if (Array.isArray(value)) return value.map(externalContentValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([key2]) => !["checkedAt", "generatedAt", "sourceCheckedAt"].includes(key2)).map(([key2, item]) => [key2, externalContentValue(item)]));
  return value;
}
async function readPreparedHomeSources({ inputs, read, publication }) {
  if (inputs?.schemaVersion !== 1 || !/^[A-Za-z0-9]{20}$/.test(inputs.operationId) || inputs.runtime?.owner !== "cloudflare" || !/^[a-f0-9]{40}$/.test(inputs.runtime.release) || !/^[a-f0-9]{64}$/.test(inputs.contentDigest) || !Number.isSafeInteger(inputs.checkedAt) || inputs.checkedAt < 1 || !Number.isFinite(new Date(inputs.checkedAt).getTime()) || !inputs.files || Object.keys(inputs.files).length !== 3) {
    throw new Error("The prepared Home provider identity is invalid.");
  }
  for (const name of externalInputNames) {
    const file = inputs.files[name];
    if (!file || file.key !== `post-background-v1/external-inputs/${inputs.operationId}/${name}` || !/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 * 1024) {
      throw new Error("The prepared Home provider file identity is invalid.");
    }
  }
  const payloads = {};
  for (const name of externalInputNames) {
    const file = inputs.files[name];
    const bytes = await read(file.key);
    if (!(bytes instanceof Uint8Array) || bytes.length !== file.size || (0, import_node_crypto2.createHash)("sha256").update(bytes).digest("hex") !== file.digest) {
      throw new Error("The prepared Home provider bytes changed.");
    }
    payloads[name] = JSON.parse(Buffer.from(bytes).toString("utf8"));
  }
  const content = Object.fromEntries(externalInputNames.map((name) => [name, externalContentValue(payloads[name])]));
  if ((0, import_node_crypto2.createHash)("sha256").update(JSON.stringify(content)).digest("hex") !== inputs.contentDigest) {
    throw new Error("The prepared Home provider content identity changed.");
  }
  const media = payloads["launch-media-manager.json"];
  const spotlight = payloads["spotlight-news.json"];
  const snapshot = createHomeSourceSnapshot(media, spotlight, publication);
  const editorial = createHomeEditorialCatalog(snapshot, spotlight, [], new Date(inputs.checkedAt).toISOString());
  return assertHomeSourcePublication({ ...snapshot, editorial }, publication);
}
async function readRetainedHomeSources({ source: source2, read }) {
  const file = source2.file;
  if (file.path !== "/_home-sources.json" || !["application/json", "application/json; charset=utf-8"].includes(file.contentType) || !/^post-background-v1\/home\/[A-Za-z0-9-]+\/[a-f0-9]{64}$/.test(file.key) || !/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024 * 1024) {
    throw new Error("The retained Home source identity is invalid.");
  }
  const bytes = await read(file.key);
  if (!(bytes instanceof Uint8Array) || bytes.length !== file.size || (0, import_node_crypto2.createHash)("sha256").update(bytes).digest("hex") !== file.digest) {
    throw new Error("The retained Home source bytes changed.");
  }
  const sources = assertHomeSourcePublication(JSON.parse(Buffer.from(bytes).toString("utf8")), source2.publication);
  if (!sources.editorial || sources.editorial.receipt.digest !== source2.catalogDigest) {
    throw new Error("The retained Home catalog identity changed.");
  }
  return sources;
}

// site/src/lib/page-schedule-packet.ts
var import_node_crypto4 = require("node:crypto");

// site/scripts/cloud-schedule-packet.ts
init_schedule_input();
var import_node_crypto3 = require("node:crypto");
var import_node_util = require("node:util");
init_broadcast_date2();
init_schedule_export();
init_schedule_feed();
var MAX_BYTES = 16 * 1024 * 1024;
var INPUT_NAMES = ["launch-media-manager.json", "spotlight-news.json", "schedule.json"];
var hash = (bytes) => (0, import_node_crypto3.createHash)("sha256").update(bytes).digest("hex");
function requireValue(value) {
  if (!value) throw new Error("Cloud schedule packet is unavailable");
}
function sourceIdentity(inputs) {
  requireValue(inputs?.schemaVersion === 1 && /^[A-Za-z0-9]{20}$/.test(inputs.operationId) && inputs.runtime?.owner === "cloudflare" && /^[a-f0-9]{40}$/.test(inputs.runtime.release) && /^[a-f0-9]{64}$/.test(inputs.contentDigest) && Number.isSafeInteger(inputs.checkedAt) && inputs.checkedAt > 0 && Number.isFinite(new Date(inputs.checkedAt).getTime()) && inputs.files && Object.keys(inputs.files).length === 3);
  for (const name of INPUT_NAMES) {
    const file = inputs.files[name];
    requireValue(file?.key === `post-background-v1/external-inputs/${inputs.operationId}/${name}` && /^[a-f0-9]{64}$/.test(file.digest) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_BYTES);
  }
  return {
    operationId: inputs.operationId,
    runtime: { owner: "cloudflare", release: inputs.runtime.release },
    contentDigest: inputs.contentDigest,
    scheduleDigest: inputs.files["schedule.json"].digest,
    checkedAt: inputs.checkedAt
  };
}
function packetPrefix(source2) {
  const identity = hash(JSON.stringify([
    source2.operationId,
    source2.runtime.owner,
    source2.runtime.release,
    source2.contentDigest,
    source2.scheduleDigest,
    source2.checkedAt
  ]));
  return `post-background-v1/schedule-packets/${source2.operationId}/${identity}`;
}
function checkedSchedule(bytes, checkedAt2) {
  let data;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));
  } catch {
    throw new Error("Cloud schedule packet is unavailable");
  }
  requireValue(!isScheduleFixture(data) && ["pbs-tvss", "pbs-tvss-with-njpbs-corrections"].includes(data?.source) && Number.isFinite(Date.parse(data.generatedAt)) && Date.parse(data.generatedAt) <= checkedAt2 && data.timeZone === TVSS_TIME_ZONE && data.request?.station === "WNJT" && Array.isArray(data.request.dates) && data.request.dates.length > 0 && data.request.dates.length <= 62 && data.request.dates.every(isBroadcastDate));
  for (const kind of ["broadcast", "kids"]) {
    const days = data.days?.[kind];
    requireValue(Array.isArray(days) && days.length > 0 && days.length <= 62 && new Set(days.map((day) => day.date)).size === days.length);
    for (const day of days) {
      requireValue(isBroadcastDate(day.date) && day.kind === kind && day.timeZone === TVSS_TIME_ZONE && Array.isArray(day.entries) && day.entries.length > 0 && day.entries.length <= 200 && (day.sourceRevision === void 0 || isBroadcastDate(day.sourceRevision)) && (day.sourceCheckedAt === void 0 || Number.isFinite(Date.parse(day.sourceCheckedAt)) && Date.parse(day.sourceCheckedAt) <= checkedAt2));
      for (const entry2 of day.entries) requireValue(typeof entry2.title === "string" && entry2.title.length > 0 && entry2.title.length <= 512 && Number.isFinite(Date.parse(entry2.startsAt)) && Number.isFinite(Date.parse(entry2.endsAt)) && Date.parse(entry2.endsAt) > Date.parse(entry2.startsAt) && (entry2.episodeTitle === void 0 || typeof entry2.episodeTitle === "string" && entry2.episodeTitle.length <= 1024));
    }
  }
  return data;
}
async function readSealed(storage, seal) {
  const bytes = Buffer.from(await storage.get(seal.key, { signal: AbortSignal.timeout(3e4), maxBytes: MAX_BYTES }));
  requireValue(bytes.length === seal.size && hash(bytes) === seal.digest);
  return bytes;
}
async function readCloudSchedulePacket({ inputs, packet, storage }) {
  const source2 = sourceIdentity(inputs);
  requireValue(packet?.schemaVersion === 1 && (0, import_node_util.isDeepStrictEqual)(packet.source, source2) && packet.timeZone === TVSS_TIME_ZONE && packet.exportedAt === new Date(source2.checkedAt).toISOString() && packet.files && Object.keys(packet.files).sort().join(",") === "json,pdf");
  for (const [kind, filename, contentType] of [
    ["json", "schedule.json", "application/json"],
    ["pdf", "nj-pbs-schedule.pdf", "application/pdf"]
  ]) {
    const file = packet.files[kind];
    requireValue(file && /^[a-f0-9]{64}$/.test(file.digest) && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= MAX_BYTES && file.contentType === contentType && file.key === `${packetPrefix(source2)}/${file.digest}/${filename}`);
  }
  const [json, pdf] = await Promise.all([readSealed(storage, packet.files.json), readSealed(storage, packet.files.pdf)]);
  const schedule = checkedSchedule(json, source2.checkedAt);
  const exported = buildScheduleExport(schedule, new Date(source2.checkedAt));
  requireValue(schedule.generatedAt === packet.generatedAt && exported.startDate === packet.startDate && exported.endDate === packet.endDate && pdf.subarray(0, 5).toString() === "%PDF-");
  return { schedule, exported, json, pdf };
}

// packages/content-core/src/schedule-source-snapshot.ts
init_broadcast_date();
init_schedule_clock();
function object5(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Schedule source data is invalid.");
  return value;
}
function text7(value) {
  if (typeof value !== "string" || value.length > 2e3) throw new Error("Schedule source text is invalid.");
  return value;
}
function instant(value) {
  const result = text7(value);
  if (!Number.isFinite(resolveScheduleClock(new Date(Number.NaN), result).getTime())) {
    throw new Error("Schedule source time is invalid.");
  }
  return result;
}
function list(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Schedule source list is invalid.");
  return value;
}
function entry(value) {
  const item = object5(value);
  const startsAt = instant(item.startsAt);
  const endsAt = instant(item.endsAt);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("Schedule source interval is invalid.");
  return {
    title: text7(item.title),
    startsAt,
    endsAt,
    ...item.episodeTitle === void 0 ? {} : { episodeTitle: text7(item.episodeTitle) }
  };
}
function sourceData(value) {
  const source2 = object5(value);
  if (source2.source !== "pbs-tvss" && source2.source !== "pbs-tvss-with-njpbs-corrections" || source2.timeZone !== SCHEDULE_TIME_ZONE) throw new Error("Schedule source is invalid.");
  const dates = /* @__PURE__ */ new Set();
  const days = list(source2.days, 45).map((value2) => {
    const day = object5(value2);
    const date2 = text7(day.date);
    assertBroadcastDate(date2);
    if (dates.has(date2) || day.callsign !== "wnjt") throw new Error("Schedule source day is invalid.");
    dates.add(date2);
    return { date: date2, callsign: "wnjt", entries: list(day.entries, 1e3).map(entry) };
  });
  return { source: source2.source, timeZone: SCHEDULE_TIME_ZONE, checkedAt: instant(source2.checkedAt), days };
}
function createScheduleSourceSnapshot(data, publication) {
  return { schemaVersion: 1, publication: publication ? {
    buildBatchId: publication.buildBatchId,
    generation: publication.generation,
    commitSha: publication.commitSha
  } : null, ...sourceData({ ...data, checkedAt: data.generatedAt, days: data.days.broadcast }) };
}

// site/src/lib/page-schedule-packet.ts
var hash2 = (bytes) => (0, import_node_crypto4.createHash)("sha256").update(bytes).digest("hex");
var publicSeal = ({ digest, size, contentType }) => ({ digest, size, contentType });
async function readPageSchedulePacket({ authority, storage }) {
  const packet = authority.inputs.schedulePacket;
  const { schedule: data, exported, pdf } = await readCloudSchedulePacket({ inputs: authority.inputs, packet, storage });
  const { buildBatchId, generation, commitSha } = authority.code;
  const snapshot = createScheduleSourceSnapshot(data, { buildBatchId, generation, commitSha });
  const json = Buffer.from(`${JSON.stringify(snapshot)}
`);
  if (json.length > 16 * 1024 * 1024) throw new Error("Schedule projection exceeds its bound");
  const receipt = {
    schemaVersion: 1,
    contextRevision: authority.contextRevision,
    contextDigest: authority.contextDigest,
    code: authority.code,
    source: packet.source,
    generatedAt: packet.generatedAt,
    exportedAt: packet.exportedAt,
    rawJson: publicSeal(packet.files.json),
    retainedPdf: publicSeal(packet.files.pdf),
    projectionJson: { digest: hash2(json), size: json.length, contentType: "application/json; charset=utf-8" },
    inputDigest: hash2(JSON.stringify({ data, exported }))
  };
  return { schedule: { data, exported, receipt }, json, pdf };
}

// site/scripts/cms-current-code-context.ts
var import_node_module2 = require("node:module");
var import_node_crypto7 = require("node:crypto");

// site/src/lib/retained-public-context.ts
var import_node_crypto6 = require("node:crypto");

// packages/content-core/src/posts-browse.ts
var POSTS_BROWSE_ICONS = ["ballot", "heart", "train", "leaf", "play", "pin"];
var postsBrowseTermKey = (term) => JSON.stringify([term.filter, term.value]);
var object6 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var text8 = (value, max) => typeof value === "string" && value.trim() === value && value.length > 0 && new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value);
function validPostsBrowseTerm(value) {
  return object6(value) && Object.keys(value).length === 2 && (value.filter === "category" || value.filter === "tag") && text8(value.value, 200) && !/^format:/i.test(value.value);
}
function validatePostsBrowse(value) {
  if (!object6(value) || Object.keys(value).length !== 1 || !Array.isArray(value.groups) || value.groups.length > 8)
    return "Posts browsing needs at most eight groups.";
  const ids = /* @__PURE__ */ new Set(), terms = /* @__PURE__ */ new Set();
  let total = 0;
  for (const group of value.groups) {
    if (!object6(group) || Object.keys(group).some((key2) => !["id", "label", "icon", "terms", "cover"].includes(key2)) || !text8(group.id, 64) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(group.id) || (ids.has(group.id) || group.id === "unassigned-subjects")) return "Each Posts browsing group needs a unique id.";
    ids.add(group.id);
    if (!text8(group.label, 80) || !POSTS_BROWSE_ICONS.includes(group.icon)) return "Each Posts browsing group needs a name and an available icon.";
    if (!Array.isArray(group.terms) || group.terms.length > 300) return "A Posts browsing group can contain at most 300 subjects.";
    for (const term of group.terms) {
      if (!validPostsBrowseTerm(term)) return "Choose an exact category or topic for every subject.";
      const key2 = postsBrowseTermKey(term);
      if (terms.has(key2)) return "A subject can belong to only one Posts browsing group.";
      terms.add(key2);
    }
    total += group.terms.length;
    if (group.cover !== void 0 && (!validPostsBrowseTerm(group.cover) || !group.terms.some((term) => postsBrowseTermKey(term) === postsBrowseTermKey(group.cover))))
      return "Choose a cover subject that belongs to its group.";
  }
  return total > 600 ? "Posts browsing can arrange at most 600 subjects; other subjects remain searchable." : null;
}

// packages/content-core/src/story-cta-rules.ts
var MAX_STORY_CTA_RULES = 20;
var object7 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var only = (value, keys2) => Object.keys(value).every((key2) => keys2.includes(key2));
function validateStoryCtaRules(value) {
  if (!Array.isArray(value) || value.length > MAX_STORY_CTA_RULES) return "Use at most 20 story CTA rules.";
  const ids = /* @__PURE__ */ new Set();
  for (const rule of value) {
    if (!object7(rule) || !only(rule, ["id", "label", "enabled", "target", "position", "content"]) || typeof rule.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(rule.id) || ids.has(rule.id)) return "Each rule needs a unique valid id.";
    ids.add(rule.id);
    if (typeof rule.label !== "string" || !rule.label.trim() || rule.label !== rule.label.trim() || rule.label.length > 100 || /[\u0000-\u001f\u007f]/.test(rule.label)) return "Give each rule a name of at most 100 characters.";
    if (typeof rule.enabled !== "boolean") return "Rule enabled must be a boolean.";
    if (!object7(rule.target) || !only(rule.target, ["contentTypes"]) || !Array.isArray(rule.target.contentTypes) || rule.target.contentTypes.length !== 1 || rule.target.contentTypes[0] !== "post") return "Rules can target stories only.";
    if (!object7(rule.position) || !only(rule.position, ["kind"]) || rule.position.kind !== "end") return "Choose the end of the story body.";
    const content = rule.content;
    if (!object7(content) || !only(content, ["type", "data"]) || content.type !== "support_appeal" || !object7(content.data)) return "Choose a support appeal block.";
    if (content.data.backgroundImageAssetId) return "Automatic appeals use text and a button. Add images in the story body.";
    const parsed = parseBlocks([{ id: "cta", order: 0, visible: true, ...content }]);
    if (!parsed.ok) return "Complete the CTA block with a safe link and its required text.";
  }
  return null;
}

// packages/content-core/src/cms-settings.ts
var MAX_CMS_SETTINGS_FIELDS = 50;
var MAX_CMS_SETTINGS_FIELD_NAME_BYTES = 128;
var MAX_CMS_SETTINGS_STRING_BYTES = 65536;
var MAX_CMS_SETTINGS_ASSET_LIST_ITEMS = 200;
var MAX_CMS_SETTINGS_VALUES_JSON_BYTES = 4e5;
var NEWSROOM_HOME_SETTINGS_ID = "newsroom-home";
var NEWSROOM_MILESTONE_SETTINGS_ID = "newsroom-milestone";
var NJ_DECIDES_SETTINGS_ID = "nj-decides-brand";
var COVERAGE_LABELS_SETTINGS_ID = "coverage-labels";
var STORY_CTAS_SETTINGS_ID = "story-ctas";
var MAX_COVERAGE_LABELS = 100;
function validateCoverageLabels(value) {
  if (!Array.isArray(value) || value.length > MAX_COVERAGE_LABELS) return "Coverage labels must be a list of at most 100 labels.";
  const ids = /* @__PURE__ */ new Set();
  for (const label of value) {
    if (!plainObject2(label) || Object.keys(label).some((key2) => !["id", "name", "textColor", "backgroundColor", "href", "retired"].includes(key2)) || !isCoverageLabelId(label.id) || ids.has(label.id)) return "Each coverage label needs a unique valid id.";
    ids.add(label.id);
    if (typeof label.name !== "string" || !label.name || label.name.trim() !== label.name || utf8Bytes(label.name) > 80 || /[\u0000-\u001f\u007f]/.test(label.name)) return "Coverage label names must be nonempty, trimmed text of at most 80 bytes.";
    if (typeof label.retired !== "boolean") return "Coverage label retired must be a boolean.";
    if (![label.textColor, label.backgroundColor].every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))) return "Coverage label colors must use six-digit hex values.";
    if (contrastRatio(label.textColor, label.backgroundColor) < 4.5) return "Coverage label text must have at least 4.5:1 contrast against its background.";
    if (label.href !== void 0) {
      if (typeof label.href !== "string" || utf8Bytes(label.href) > 2048 || safeHref2(label.href) !== label.href || /[\\\u0000-\u0020\u007f]/.test(label.href) || !/^(?:https?:\/\/|\/(?!\/))/i.test(label.href)) return "Coverage label links must be safe web addresses or paths starting with /.";
      try {
        const url = new URL(label.href, "https://njpbs.org");
        if (url.username || url.password) return "Coverage label links cannot contain credentials.";
      } catch {
        return "Coverage label links must be valid web addresses.";
      }
    }
  }
  return null;
}
var PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID = "public-homepage-banner";
var SITE_NAVIGATION_SETTINGS_ID = "site-navigation";
var PUBLIC_SITE_CHROME_SETTINGS_ID = "public-site-chrome";
var DEFAULT_NJ_DECIDES_SETTINGS = Object.freeze({
  backgroundColor: "#e9eaee",
  textColor: "#011375",
  linkColor: "#011375",
  ruleColor: "#8B0000",
  accentColor: "#011375",
  flagEnabled: true
});
var DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS = Object.freeze({
  enabled: false,
  message: "Montclair State University will acquire NJ Spotlight.",
  linkLabel: "Read the announcement",
  linkHref: "https://inside.montclair.edu/news/montclair-state-university-acquire-nj-spotlight-commits-continuing-its-watchdog-journalism-through"
});
var DEFAULT_PUBLIC_SITE_CHROME_SETTINGS = Object.freeze({
  newsletterEnabled: true,
  newsletterLabel: "Subscribe to the newsletter",
  newsletterHref: "https://njpbs.bluelena.io/f/1",
  newsletterOpensInNewTab: false
});
var SITE_NAVIGATION_ROUTE_KEYS = Object.freeze(["postsIndex", "inTheNews"]);
var SITE_NAVIGATION_LAUNCH_KEYS = Object.freeze([
  "pbsVideo",
  "donate",
  "passportLearnMore"
]);
var MAX_SITE_NAVIGATION_ID_BYTES = 64;
var MAX_SITE_NAVIGATION_PAGE_ID_BYTES = 80;
var MAX_SITE_NAVIGATION_LOCKED_LINKS = 20;
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
var DEFAULT_SITE_NAVIGATION = deepFreeze({
  header: [
    { id: "live", label: "Live", target: { type: "page", pageId: "live" }, external: false },
    { id: "watch-on-demand", label: "Watch on demand", target: { type: "launch", key: "pbsVideo" }, external: true },
    { id: "schedule", label: "Schedule", target: { type: "page", pageId: "schedule" }, external: false },
    { id: "posts", label: "Posts", target: { type: "route", key: "postsIndex" }, external: false },
    { id: "nj-spotlight-news", label: "NJ Spotlight News", target: { type: "href", href: "https://www.njspotlightnews.org/" }, external: true },
    { id: "kids", label: "Kids", target: { type: "page", pageId: "kids" }, external: false },
    { id: "support", label: "Support", target: { type: "page", pageId: "support" }, external: false }
  ],
  footer: [
    {
      id: "watch",
      heading: "Watch",
      links: [
        { id: "watch-live", label: "Live", target: { type: "page", pageId: "live" }, external: false },
        { id: "watch-on-demand", label: "Watch on demand", target: { type: "launch", key: "pbsVideo" }, external: true },
        { id: "watch-schedule", label: "Schedule", target: { type: "page", pageId: "schedule" }, external: false },
        { id: "watch-kids", label: "Kids", target: { type: "page", pageId: "kids" }, external: false }
      ]
    },
    {
      id: "passport",
      heading: "Passport",
      links: [
        { id: "about-passport", label: "About Passport", target: { type: "launch", key: "passportLearnMore" }, external: true },
        { id: "passport-member-benefit", label: "Passport member benefit", target: { type: "launch", key: "passportLearnMore" }, external: true },
        { id: "passport-help", label: "PBS Passport help", target: { type: "launch", key: "passportLearnMore" }, external: true }
      ]
    },
    {
      id: "support",
      heading: "Support",
      links: [
        { id: "donate", label: "Donate", target: { type: "launch", key: "donate" }, external: true },
        { id: "membership", label: "Membership", target: { type: "page", pageId: "support" }, external: false }
      ]
    },
    {
      id: "about",
      heading: "About",
      links: [
        { id: "about-us", label: "About us", target: { type: "page", pageId: "about" }, external: false },
        { id: "in-the-news", label: "In the news", target: { type: "route", key: "inTheNews" }, external: false },
        { id: "faq", label: "FAQ", target: { type: "page", pageId: "faq" }, external: false },
        { id: "contact", label: "Contact", target: { type: "page", pageId: "contact" }, external: false },
        { id: "careers", label: "Careers", target: { type: "href", href: "https://montclair.wd1.myworkdayjobs.com/en-US/JobOpportunities/?q=PBS" }, external: true }
      ]
    }
  ]
});
var CMS_SETTINGS_SCHEMAS = Object.freeze({
  [STORY_CTAS_SETTINGS_ID]: Object.freeze({ currentVersion: 1, versions: Object.freeze({
    1: Object.freeze({ schemaVersion: 1, fields: Object.freeze({ rules: Object.freeze({ kind: "storyCtaRules", required: true }) }) })
  }) }),
  [COVERAGE_LABELS_SETTINGS_ID]: Object.freeze({ currentVersion: 1, versions: Object.freeze({
    1: Object.freeze({ schemaVersion: 1, fields: Object.freeze({ labels: Object.freeze({ kind: "coverageLabels", required: true }) }) })
  }) }),
  [NEWSROOM_HOME_SETTINGS_ID]: Object.freeze({
    currentVersion: 1,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          bannerHeading: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 160
          })
        })
      })
    })
  }),
  [NEWSROOM_MILESTONE_SETTINGS_ID]: Object.freeze({
    currentVersion: 1,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          milestoneNumber: Object.freeze({
            kind: "integer",
            required: true,
            minimum: 1,
            maximum: 1e4
          })
        })
      })
    })
  }),
  [NJ_DECIDES_SETTINGS_ID]: Object.freeze({
    currentVersion: 1,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        valueContract: "njDecidesBrandV1",
        fields: Object.freeze({
          backgroundColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor"
          }),
          textColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor"
          }),
          linkColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor"
          }),
          ruleColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor"
          }),
          accentColor: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 7,
            format: "hexColor"
          }),
          flagEnabled: Object.freeze({
            kind: "boolean",
            required: true
          }),
          logoAssetId: Object.freeze({ kind: "assetId" }),
          logoAlt: Object.freeze({ kind: "string", maxBytes: 500 }),
          backgroundAssetId: Object.freeze({ kind: "assetId" })
        })
      })
    })
  }),
  [PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID]: Object.freeze({
    currentVersion: 4,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          enabled: Object.freeze({
            kind: "boolean",
            required: true
          }),
          message: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 240
          }),
          linkLabel: Object.freeze({
            kind: "string",
            maxBytes: 80,
            pairedWith: "linkHref"
          }),
          linkHref: Object.freeze({
            kind: "safeHref",
            maxBytes: 2048,
            pairedWith: "linkLabel"
          })
        })
      }),
      2: Object.freeze({
        schemaVersion: 2,
        valueContract: "publicHomepageBannerV2",
        fields: Object.freeze({
          enabled: Object.freeze({
            kind: "boolean",
            required: true
          }),
          message: Object.freeze({
            kind: "string",
            required: true,
            allowEmpty: true,
            maxBytes: 240
          }),
          linkLabel: Object.freeze({
            kind: "string",
            maxBytes: 80,
            pairedWith: "linkHref"
          }),
          linkHref: Object.freeze({
            kind: "safeHref",
            maxBytes: 2048,
            pairedWith: "linkLabel"
          }),
          njDecides: Object.freeze({ kind: "boolean" }),
          liveLabel: Object.freeze({ kind: "string", maxBytes: 24 }),
          startsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant"
          }),
          endsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant"
          })
        })
      }),
      3: Object.freeze({
        schemaVersion: 3,
        valueContract: "publicHomepageBannerV2",
        fields: Object.freeze({
          enabled: Object.freeze({
            kind: "boolean",
            required: true
          }),
          message: Object.freeze({
            kind: "string",
            required: true,
            allowEmpty: true,
            maxBytes: 240
          }),
          linkLabel: Object.freeze({
            kind: "string",
            maxBytes: 80,
            pairedWith: "linkHref"
          }),
          linkHref: Object.freeze({
            kind: "safeHref",
            maxBytes: 2048,
            pairedWith: "linkLabel"
          }),
          njDecides: Object.freeze({ kind: "boolean" }),
          liveLabel: Object.freeze({ kind: "string", maxBytes: 24 }),
          startsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant"
          }),
          endsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant"
          }),
          excludedPaths: Object.freeze({ kind: "canonicalPathList", maxItems: 50, maxBytes: 512 })
        })
      }),
      4: Object.freeze({
        schemaVersion: 4,
        valueContract: "publicHomepageBannerV4",
        fields: Object.freeze({
          enabled: Object.freeze({
            kind: "boolean",
            required: true
          }),
          message: Object.freeze({
            kind: "string",
            required: true,
            allowEmpty: true,
            maxBytes: 240
          }),
          linkLabel: Object.freeze({
            kind: "string",
            maxBytes: 80,
            pairedWith: "linkHref"
          }),
          linkHref: Object.freeze({
            kind: "safeHref",
            maxBytes: 2048,
            pairedWith: "linkLabel"
          }),
          secondLinkLabel: Object.freeze({ kind: "string", maxBytes: 80, pairedWith: "secondLinkHref" }),
          secondLinkHref: Object.freeze({ kind: "safeHref", maxBytes: 2048, pairedWith: "secondLinkLabel" }),
          njDecides: Object.freeze({ kind: "boolean" }),
          liveLabel: Object.freeze({ kind: "string", maxBytes: 24 }),
          startsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant"
          }),
          endsAt: Object.freeze({
            kind: "string",
            maxBytes: 64,
            format: "canonicalUtcInstant"
          }),
          excludedPaths: Object.freeze({ kind: "canonicalPathList", maxItems: 50, maxBytes: 512 })
        })
      })
    })
  }),
  [SITE_NAVIGATION_SETTINGS_ID]: Object.freeze({
    currentVersion: 2,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          header: Object.freeze({
            kind: "navigationLinks",
            required: true,
            maxItems: 12,
            labelMaxBytes: 80,
            hrefMaxBytes: 2048
          }),
          // Contact is the captioning and accessibility contact path. It can
          // move and be renamed, but it cannot be removed or retargeted.
          footer: Object.freeze({
            kind: "navigationColumns",
            required: true,
            maxItems: 6,
            headingMaxBytes: 40,
            maxLinks: 10,
            labelMaxBytes: 80,
            hrefMaxBytes: 2048,
            lockedLinks: Object.freeze([
              Object.freeze({
                id: "contact",
                target: Object.freeze({ type: "page", pageId: "contact" })
              })
            ])
          })
        })
      }),
      2: Object.freeze({
        schemaVersion: 2,
        fields: Object.freeze({
          postsBrowse: Object.freeze({ kind: "postsBrowse" }),
          header: Object.freeze({
            kind: "navigationLinks",
            required: true,
            maxItems: 12,
            labelMaxBytes: 80,
            hrefMaxBytes: 2048
          }),
          // Contact is the captioning and accessibility contact path. It can
          // move and be renamed, but it cannot be removed or retargeted.
          footer: Object.freeze({
            kind: "navigationColumns",
            required: true,
            maxItems: 6,
            headingMaxBytes: 40,
            maxLinks: 10,
            labelMaxBytes: 80,
            hrefMaxBytes: 2048,
            lockedLinks: Object.freeze([
              Object.freeze({
                id: "contact",
                target: Object.freeze({ type: "page", pageId: "contact" })
              })
            ])
          })
        })
      })
    })
  }),
  [PUBLIC_SITE_CHROME_SETTINGS_ID]: Object.freeze({
    currentVersion: 1,
    versions: Object.freeze({
      1: Object.freeze({
        schemaVersion: 1,
        fields: Object.freeze({
          newsletterEnabled: Object.freeze({
            kind: "boolean",
            required: true
          }),
          newsletterLabel: Object.freeze({
            kind: "string",
            required: true,
            maxBytes: 80
          }),
          newsletterHref: Object.freeze({
            kind: "safeHref",
            required: true,
            maxBytes: 2048,
            absoluteOrRootRelative: true
          }),
          newsletterOpensInNewTab: Object.freeze({
            kind: "boolean",
            required: true
          })
        })
      })
    })
  })
});
var navigationSchemaV1 = CMS_SETTINGS_SCHEMAS[SITE_NAVIGATION_SETTINGS_ID].versions[1];
var CMS_SETTINGS_READ_SCHEMAS = Object.freeze({
  ...CMS_SETTINGS_SCHEMAS,
  [SITE_NAVIGATION_SETTINGS_ID]: Object.freeze({
    ...CMS_SETTINGS_SCHEMAS[SITE_NAVIGATION_SETTINGS_ID],
    versions: Object.freeze({
      ...CMS_SETTINGS_SCHEMAS[SITE_NAVIGATION_SETTINGS_ID].versions,
      1: Object.freeze({
        ...navigationSchemaV1,
        fields: Object.freeze({
          ...navigationSchemaV1.fields,
          footer: Object.freeze({ ...navigationSchemaV1.fields.footer, uniqueHeadings: false })
        })
      })
    })
  })
});
function plainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function utf8Bytes(value) {
  return new TextEncoder().encode(value).length;
}
function positiveVersion(value) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function isMediaAssetId(value) {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}
var SAFE_HREF_SCHEMES = /* @__PURE__ */ new Set([
  "http",
  "https",
  "mailto",
  "tel"
]);
function safeHref2(raw) {
  if (typeof raw !== "string") return null;
  const href = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (href.length === 0) return null;
  if (href.replace(/\\/g, "/").startsWith("//")) return null;
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
  const protocol = scheme?.[1].toLowerCase();
  if (protocol && !SAFE_HREF_SCHEMES.has(protocol)) return null;
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
function safeNavigationHref(raw) {
  if (typeof raw !== "string" || safeHref2(raw) !== raw) return null;
  return /^(?:https?:\/\/|mailto:|tel:)/i.test(raw) || /^\/(?![/\\])/.test(raw) ? raw : null;
}
var SITE_NAVIGATION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var SITE_NAVIGATION_HASH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
var LINK_FIELDS = /* @__PURE__ */ new Set(["id", "label", "target", "external"]);
var COLUMN_FIELDS = /* @__PURE__ */ new Set(["id", "heading", "links"]);
var PAGE_TARGET_FIELDS = /* @__PURE__ */ new Set(["type", "pageId", "hash"]);
var KEY_TARGET_FIELDS = /* @__PURE__ */ new Set(["type", "key"]);
var HREF_TARGET_FIELDS = /* @__PURE__ */ new Set(["type", "href"]);
function hasOnlyFields2(value, fields4) {
  return Object.keys(value).every((key2) => fields4.has(key2));
}
function navigationId(value, maxBytes = MAX_SITE_NAVIGATION_ID_BYTES) {
  return typeof value === "string" && utf8Bytes(value) <= maxBytes && SITE_NAVIGATION_ID_PATTERN.test(value);
}
function boundedByteLimit(value) {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_CMS_SETTINGS_STRING_BYTES;
}
function boundedItemLimit(value) {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_CMS_SETTINGS_ASSET_LIST_ITEMS;
}
function navigationTargetError(target, hrefMaxBytes) {
  if (!plainObject2(target)) return "target is invalid";
  switch (target.type) {
    case "page":
      if (!hasOnlyFields2(target, PAGE_TARGET_FIELDS)) return "target is invalid";
      if (!navigationId(target.pageId, MAX_SITE_NAVIGATION_PAGE_ID_BYTES)) {
        return "target must name a public page";
      }
      if (target.hash !== void 0 && (typeof target.hash !== "string" || !SITE_NAVIGATION_HASH_PATTERN.test(target.hash))) {
        return "target section anchor is invalid";
      }
      return null;
    case "route":
      return hasOnlyFields2(target, KEY_TARGET_FIELDS) && SITE_NAVIGATION_ROUTE_KEYS.includes(target.key) ? null : "target is invalid";
    case "launch":
      return hasOnlyFields2(target, KEY_TARGET_FIELDS) && SITE_NAVIGATION_LAUNCH_KEYS.includes(target.key) ? null : "target is invalid";
    case "href":
      if (!hasOnlyFields2(target, HREF_TARGET_FIELDS) || typeof target.href !== "string") {
        return "target is invalid";
      }
      if (utf8Bytes(target.href) > hrefMaxBytes) {
        return `target link can be at most ${hrefMaxBytes} bytes`;
      }
      return safeNavigationHref(target.href) === target.href ? null : "target must contain a safe link";
    default:
      return "target is invalid";
  }
}
function sameNavigationTarget(left, right) {
  if (!plainObject2(left) || !plainObject2(right)) return false;
  const keys2 = /* @__PURE__ */ new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys2].every((key2) => left[key2] === right[key2]);
}
function navigationLinkError(link3, path, labelMaxBytes, hrefMaxBytes) {
  if (!plainObject2(link3) || !hasOnlyFields2(link3, LINK_FIELDS) || !Object.hasOwn(link3, "target")) {
    return `${path} must be a link`;
  }
  if (!navigationId(link3.id)) return `${path}.id is invalid`;
  if (typeof link3.label !== "string" || link3.label.trim() === "") {
    return `${path}.label is required`;
  }
  if (utf8Bytes(link3.label) > labelMaxBytes) {
    return `${path}.label can be at most ${labelMaxBytes} bytes`;
  }
  if (typeof link3.external !== "boolean") {
    return `${path}.external must be a boolean`;
  }
  const targetError = navigationTargetError(link3.target, hrefMaxBytes);
  return targetError ? `${path}.${targetError}` : null;
}
function navigationLinksError(field, definition, value) {
  if (!Array.isArray(value)) return `${field} must be an array of links`;
  if (value.length === 0) return `${field} must contain at least one link`;
  if (value.length > definition.maxItems) {
    return `${field} can contain at most ${definition.maxItems} links`;
  }
  const ids = /* @__PURE__ */ new Set();
  for (const [index, link3] of value.entries()) {
    const error = navigationLinkError(
      link3,
      `${field}[${index}]`,
      definition.labelMaxBytes,
      definition.hrefMaxBytes
    );
    if (error) return error;
    if (ids.has(link3.id)) return `${field} ids must be unique`;
    ids.add(link3.id);
  }
  return null;
}
function navigationColumnsError(field, definition, value) {
  if (!Array.isArray(value)) return `${field} must be an array of columns`;
  if (value.length === 0) return `${field} must contain at least one column`;
  if (value.length > definition.maxItems) {
    return `${field} can contain at most ${definition.maxItems} columns`;
  }
  const ids = /* @__PURE__ */ new Set();
  const headings = /* @__PURE__ */ new Set();
  const links = /* @__PURE__ */ new Map();
  for (const [index, column] of value.entries()) {
    const path = `${field}[${index}]`;
    if (!plainObject2(column) || !hasOnlyFields2(column, COLUMN_FIELDS) || !Object.hasOwn(column, "links")) {
      return `${path} must be a column`;
    }
    if (!navigationId(column.id)) return `${path}.id is invalid`;
    if (typeof column.heading !== "string" || column.heading.trim() === "") {
      return `${path}.heading is required`;
    }
    if (utf8Bytes(column.heading) > definition.headingMaxBytes) {
      return `${path}.heading can be at most ${definition.headingMaxBytes} bytes`;
    }
    const heading = column.heading.trim().replace(/\s+/g, " ").toLowerCase();
    if (definition.uniqueHeadings !== false && headings.has(heading)) {
      return `${path}.heading must be unique`;
    }
    headings.add(heading);
    if (!Array.isArray(column.links)) return `${path}.links must be an array of links`;
    if (column.links.length === 0) return `${path}.links must contain at least one link`;
    if (column.links.length > definition.maxLinks) {
      return `${path}.links can contain at most ${definition.maxLinks} links`;
    }
    if (ids.has(column.id)) return `${field} ids must be unique`;
    ids.add(column.id);
    for (const [linkIndex, link3] of column.links.entries()) {
      const error = navigationLinkError(
        link3,
        `${path}.links[${linkIndex}]`,
        definition.labelMaxBytes,
        definition.hrefMaxBytes
      );
      if (error) return error;
      if (ids.has(link3.id)) return `${field} ids must be unique`;
      ids.add(link3.id);
      links.set(link3.id, link3);
    }
  }
  for (const locked of definition.lockedLinks ?? []) {
    const link3 = links.get(locked.id);
    if (!link3) return `${field} must keep the ${locked.id} link`;
    if (!sameNavigationTarget(link3.target, locked.target)) {
      return `${field} link ${locked.id} cannot change its target`;
    }
  }
  return null;
}
function lockedLinksDefinitionValid(value, hrefMaxBytes) {
  if (value === void 0) return true;
  if (!Array.isArray(value) || value.length > MAX_SITE_NAVIGATION_LOCKED_LINKS) {
    return false;
  }
  const ids = /* @__PURE__ */ new Set();
  for (const locked of value) {
    if (!plainObject2(locked) || Object.keys(locked).length !== 2 || !navigationId(locked.id) || ids.has(locked.id) || navigationTargetError(locked.target, hrefMaxBytes) !== null) {
      return false;
    }
    ids.add(locked.id);
  }
  return true;
}
function cloneNavigationTarget(target) {
  switch (target.type) {
    case "page":
      return {
        type: "page",
        pageId: target.pageId,
        ...target.hash !== void 0 ? { hash: target.hash } : {}
      };
    case "href":
      return { type: "href", href: target.href };
    case "route":
      return { type: "route", key: target.key };
    case "launch":
      return { type: "launch", key: target.key };
  }
}
function navigationTargetAllowsNewTab(target) {
  return target.type === "launch" || target.type === "href" && /^https?:\/\//i.test(target.href.trim());
}
function cloneNavigationLink(link3) {
  return {
    id: link3.id,
    label: link3.label,
    target: cloneNavigationTarget(link3.target),
    external: link3.external && navigationTargetAllowsNewTab(link3.target)
  };
}
function cloneSettingsValue(definition, value) {
  if (definition.kind === "storyCtaRules") return structuredClone(value);
  if (definition.kind === "postsBrowse") return JSON.parse(JSON.stringify(value));
  if (definition.kind === "coverageLabels" && Array.isArray(value)) return value.map((label) => ({ ...label }));
  if (definition.kind === "navigationLinks" && Array.isArray(value)) {
    return value.map(cloneNavigationLink);
  }
  if (definition.kind === "navigationColumns" && Array.isArray(value)) {
    return value.map((column) => ({
      id: column.id,
      heading: column.heading,
      links: column.links.map(cloneNavigationLink)
    }));
  }
  return Array.isArray(value) ? [...value] : value;
}
function isCmsSettingsFieldDefinition(definition) {
  if (!plainObject2(definition) || typeof definition.kind !== "string" || definition.required !== void 0 && typeof definition.required !== "boolean") {
    return false;
  }
  const keys2 = new Set(Object.keys(definition));
  keys2.delete("kind");
  keys2.delete("required");
  if (definition.kind === "string" || definition.kind === "safeHref") {
    keys2.delete("maxBytes");
    keys2.delete("pairedWith");
    if (definition.kind === "string") {
      keys2.delete("allowEmpty");
      keys2.delete("format");
    }
    if (definition.kind === "safeHref") keys2.delete("absoluteOrRootRelative");
    return (definition.kind !== "string" || definition.format === void 0 || definition.format === "hexColor" || definition.format === "canonicalUtcInstant") && (definition.kind !== "string" || definition.allowEmpty === void 0 || typeof definition.allowEmpty === "boolean") && (definition.absoluteOrRootRelative === void 0 || typeof definition.absoluteOrRootRelative === "boolean") && Number.isSafeInteger(definition.maxBytes) && Number(definition.maxBytes) >= 1 && Number(definition.maxBytes) <= MAX_CMS_SETTINGS_STRING_BYTES && (definition.pairedWith === void 0 || typeof definition.pairedWith === "string" && definition.pairedWith.length > 0 && utf8Bytes(definition.pairedWith) <= MAX_CMS_SETTINGS_FIELD_NAME_BYTES) && keys2.size === 0;
  }
  if (definition.kind === "integer") {
    keys2.delete("minimum");
    keys2.delete("maximum");
    return Number.isSafeInteger(definition.minimum) && Number.isSafeInteger(definition.maximum) && Number(definition.minimum) <= Number(definition.maximum) && keys2.size === 0;
  }
  if (definition.kind === "stringList") {
    keys2.delete("maxItems");
    keys2.delete("allowedValues");
    keys2.delete("unique");
    return Number.isSafeInteger(definition.maxItems) && Number(definition.maxItems) >= 1 && Number(definition.maxItems) <= MAX_CMS_SETTINGS_ASSET_LIST_ITEMS && Array.isArray(definition.allowedValues) && definition.allowedValues.length > 0 && definition.allowedValues.length <= MAX_CMS_SETTINGS_ASSET_LIST_ITEMS && definition.allowedValues.every(
      (item) => typeof item === "string" && item.length > 0 && utf8Bytes(item) <= MAX_CMS_SETTINGS_FIELD_NAME_BYTES
    ) && new Set(definition.allowedValues).size === definition.allowedValues.length && (definition.unique === void 0 || typeof definition.unique === "boolean") && keys2.size === 0;
  }
  if (definition.kind === "canonicalPathList") {
    keys2.delete("maxItems");
    keys2.delete("maxBytes");
    return Number.isSafeInteger(definition.maxItems) && Number(definition.maxItems) >= 1 && Number(definition.maxItems) <= MAX_CMS_SETTINGS_ASSET_LIST_ITEMS && Number.isSafeInteger(definition.maxBytes) && Number(definition.maxBytes) >= 1 && Number(definition.maxBytes) <= MAX_CMS_SETTINGS_STRING_BYTES && keys2.size === 0;
  }
  if (definition.kind === "assetIdList") {
    keys2.delete("maxItems");
    return Number.isSafeInteger(definition.maxItems) && Number(definition.maxItems) >= 1 && Number(definition.maxItems) <= MAX_CMS_SETTINGS_ASSET_LIST_ITEMS && keys2.size === 0;
  }
  if (definition.kind === "navigationLinks") {
    keys2.delete("maxItems");
    keys2.delete("labelMaxBytes");
    keys2.delete("hrefMaxBytes");
    return boundedItemLimit(definition.maxItems) && boundedByteLimit(definition.labelMaxBytes) && boundedByteLimit(definition.hrefMaxBytes) && keys2.size === 0;
  }
  if (definition.kind === "navigationColumns") {
    for (const key2 of [
      "maxItems",
      "headingMaxBytes",
      "uniqueHeadings",
      "maxLinks",
      "labelMaxBytes",
      "hrefMaxBytes",
      "lockedLinks"
    ]) {
      keys2.delete(key2);
    }
    return boundedItemLimit(definition.maxItems) && boundedByteLimit(definition.headingMaxBytes) && (definition.uniqueHeadings === void 0 || typeof definition.uniqueHeadings === "boolean") && boundedItemLimit(definition.maxLinks) && boundedByteLimit(definition.labelMaxBytes) && boundedByteLimit(definition.hrefMaxBytes) && lockedLinksDefinitionValid(
      definition.lockedLinks,
      Number(definition.hrefMaxBytes)
    ) && keys2.size === 0;
  }
  return (definition.kind === "boolean" || definition.kind === "assetId" || definition.kind === "coverageLabels" || definition.kind === "postsBrowse" || definition.kind === "storyCtaRules") && keys2.size === 0;
}
function schemaError(schema) {
  if (!plainObject2(schema) || !positiveVersion(schema.schemaVersion) || !plainObject2(schema.fields) || Object.keys(schema).some(
    (key2) => key2 !== "schemaVersion" && key2 !== "fields" && key2 !== "valueContract"
  ) || schema.valueContract !== void 0 && schema.valueContract !== "njDecidesBrandV1" && schema.valueContract !== "publicHomepageBannerV2" && schema.valueContract !== "publicHomepageBannerV4" || Object.keys(schema.fields).length > MAX_CMS_SETTINGS_FIELDS) {
    return "The CMS settings schema is invalid";
  }
  const validatedFields = /* @__PURE__ */ new Map();
  for (const [field, definition] of Object.entries(schema.fields)) {
    if (!field || utf8Bytes(field) > MAX_CMS_SETTINGS_FIELD_NAME_BYTES || !isCmsSettingsFieldDefinition(definition)) {
      return "The CMS settings schema is invalid";
    }
    validatedFields.set(field, definition);
  }
  for (const [field, definition] of validatedFields) {
    if ((definition.kind === "string" || definition.kind === "safeHref") && definition.pairedWith !== void 0) {
      const paired = validatedFields.get(definition.pairedWith);
      if (definition.pairedWith === field || !paired || paired.kind !== "string" && paired.kind !== "safeHref" || paired.pairedWith !== field) {
        return "The CMS settings schema is invalid";
      }
    }
  }
  return null;
}
function schemaHistoryFor(documentId, schemas) {
  if (typeof documentId !== "string" || documentId.length === 0 || !plainObject2(schemas) || !Object.hasOwn(schemas, documentId)) {
    return null;
  }
  const history = schemas[documentId];
  if (!plainObject2(history) || !positiveVersion(history.currentVersion) || !plainObject2(history.versions) || Object.keys(history).some(
    (key2) => key2 !== "currentVersion" && key2 !== "versions"
  )) {
    return null;
  }
  const versions = Object.entries(history.versions);
  if (versions.length === 0) return null;
  for (const [key2, schema] of versions) {
    const version = Number(key2);
    if (!positiveVersion(version) || String(version) !== key2 || schemaError(schema) !== null || Number(schema.schemaVersion) !== version) {
      return null;
    }
  }
  if (!Object.hasOwn(history.versions, history.currentVersion)) return null;
  return history;
}
function cmsSettingsSchemaFor(documentId, schemaVersion, schemas = CMS_SETTINGS_SCHEMAS) {
  if (!positiveVersion(schemaVersion)) return null;
  const history = schemaHistoryFor(documentId, schemas);
  if (!history || !Object.hasOwn(history.versions, schemaVersion)) return null;
  return history.versions[Number(schemaVersion)] ?? null;
}
function currentCmsSettingsSchemaFor(documentId, schemas = CMS_SETTINGS_SCHEMAS) {
  const history = schemaHistoryFor(documentId, schemas);
  if (!history) return null;
  return history.versions[history.currentVersion] ?? null;
}
function cloneSettingsValues(schema, values) {
  return Object.fromEntries(
    Object.keys(schema.fields).filter((field) => values[field] !== void 0).map((field) => [
      field,
      cloneSettingsValue(schema.fields[field], values[field])
    ])
  );
}
function validateCmsSettingsValues(schema, values) {
  const invalidSchema = schemaError(schema);
  if (invalidSchema) return invalidSchema;
  if (!plainObject2(values)) return "CMS settings values must be an object";
  for (const field of Object.keys(values)) {
    if (!Object.hasOwn(schema.fields, field)) {
      return `Unknown settings field ${field}`;
    }
  }
  for (const [field, definition] of Object.entries(schema.fields)) {
    const value = values[field];
    if (value === null && definition.kind === "postsBrowse") return "Posts browsing must be an arrangement, not null.";
    if (value === null && definition.kind === "canonicalPathList") return `${field} must be an array of canonical site paths`;
    if (value === void 0 || value === null) {
      if (definition.required === true) return `${field} is required`;
      continue;
    }
    switch (definition.kind) {
      case "postsBrowse": {
        const error = validatePostsBrowse(value);
        if (error) return error;
        break;
      }
      case "storyCtaRules": {
        const error = validateStoryCtaRules(value);
        if (error) return error;
        break;
      }
      case "coverageLabels": {
        const error = validateCoverageLabels(value);
        if (error) return error;
        break;
      }
      case "boolean":
        if (typeof value !== "boolean") return `${field} must be a boolean`;
        break;
      case "integer":
        if (!Number.isSafeInteger(value) || Number(value) < definition.minimum || Number(value) > definition.maximum) {
          return `${field} must be an integer from ${definition.minimum} to ${definition.maximum}`;
        }
        break;
      case "string":
        if (typeof value !== "string") return `${field} must be a string`;
        if (definition.required === true && definition.allowEmpty !== true && value.trim() === "") {
          return `${field} is required`;
        }
        if (utf8Bytes(value) > definition.maxBytes) {
          return `${field} can be at most ${definition.maxBytes} bytes`;
        }
        if (definition.format === "hexColor" && !/^#[0-9A-Fa-f]{6}$/.test(value)) {
          return `${field} must use #RRGGBB`;
        }
        if (definition.format === "canonicalUtcInstant" && !canonicalInstant(value)) {
          return `${field} must be a canonical UTC instant`;
        }
        break;
      case "safeHref":
        if (typeof value !== "string") return `${field} must be a string`;
        if (value === "" && definition.required !== true) break;
        if (definition.required === true && value.trim() === "") {
          return `${field} is required`;
        }
        if (utf8Bytes(value) > definition.maxBytes) {
          return `${field} can be at most ${definition.maxBytes} bytes`;
        }
        if (safeHref2(value) !== value) {
          return `${field} must contain a safe link`;
        }
        if (definition.absoluteOrRootRelative === true && safeNavigationHref(value) !== value) {
          return `${field} must be a web, email or phone address, or a path that starts with /`;
        }
        break;
      case "stringList":
        if (!Array.isArray(value)) return `${field} must be an array of strings`;
        if (value.length > definition.maxItems) {
          return `${field} can contain at most ${definition.maxItems} items`;
        }
        if (value.some((item) => typeof item !== "string")) {
          return `${field} must contain only strings`;
        }
        if (value.some((item) => !definition.allowedValues.includes(item))) {
          return `${field} contains an unsupported value`;
        }
        if (definition.unique === true && new Set(value).size !== value.length) {
          return `${field} must not contain duplicate values`;
        }
        break;
      case "canonicalPathList":
        if (!Array.isArray(value)) return `${field} must be an array of canonical site paths`;
        if (value.length > definition.maxItems) return `${field} can contain at most ${definition.maxItems} paths`;
        if (value.some((path) => typeof path !== "string" || utf8Bytes(path) > definition.maxBytes || !/^(?:\/|\/(?:[a-z0-9][a-z0-9_-]*\/)+)$/.test(path))) {
          return `${field} must contain canonical site paths`;
        }
        if (new Set(value).size !== value.length) return `${field} must not contain duplicate paths`;
        break;
      case "assetId":
        if (value === "" && definition.required !== true) break;
        if (!isMediaAssetId(value)) {
          return `${field} must contain a valid media asset id`;
        }
        break;
      case "assetIdList":
        if (!Array.isArray(value)) {
          return `${field} must be an array of media asset ids`;
        }
        if (value.length > definition.maxItems) {
          return `${field} can contain at most ${definition.maxItems} items`;
        }
        if (value.some((item) => !isMediaAssetId(item))) {
          return `${field} must contain valid media asset ids`;
        }
        break;
      case "navigationLinks": {
        const error = navigationLinksError(field, definition, value);
        if (error) return error;
        break;
      }
      case "navigationColumns": {
        const error = navigationColumnsError(field, definition, value);
        if (error) return error;
        break;
      }
    }
  }
  for (const [field, definition] of Object.entries(schema.fields)) {
    if ((definition.kind === "string" || definition.kind === "safeHref") && definition.pairedWith !== void 0) {
      const value = values[field];
      const pairedValue = values[definition.pairedWith];
      const present = typeof value === "string" && value.trim().length > 0;
      const pairedPresent = typeof pairedValue === "string" && pairedValue.trim().length > 0;
      if (present !== pairedPresent) {
        return `${field} and ${definition.pairedWith} must be provided together`;
      }
    }
  }
  const valueContractError = validateValueContract(schema.valueContract, values);
  if (valueContractError) return valueContractError;
  const canonicalValues = cloneSettingsValues(schema, values);
  if (utf8Bytes(JSON.stringify(canonicalValues)) > MAX_CMS_SETTINGS_VALUES_JSON_BYTES) {
    return `CMS settings values can be at most ${MAX_CMS_SETTINGS_VALUES_JSON_BYTES} bytes`;
  }
  return null;
}
function relativeLuminance(hex) {
  const channel = (offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}
function validateValueContract(contract, values) {
  if (contract === "publicHomepageBannerV2" || contract === "publicHomepageBannerV4") {
    const startsAt = values.startsAt;
    const endsAt = values.endsAt;
    if (typeof startsAt === "string" && typeof endsAt === "string" && new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
      return "startsAt must be before endsAt";
    }
    if (values.njDecides !== true && typeof values.message === "string" && values.message.trim() === "") {
      return "message is required unless NJ Decides mode is enabled";
    }
    if (values.njDecides === true) {
      for (const field of contract === "publicHomepageBannerV4" ? ["linkHref", "secondLinkHref"] : ["linkHref"]) {
        const href = values[field];
        if (typeof href === "string" && href.trim() !== "" && safeNavigationHref(href) !== href) {
          return `${field} must be an absolute address or a path that starts with / for NJ Decides`;
        }
      }
    }
    if (contract === "publicHomepageBannerV4" && typeof values.secondLinkLabel === "string" && values.secondLinkLabel.trim() !== "" && !(typeof values.linkLabel === "string" && values.linkLabel.trim() !== "")) {
      return "secondLinkLabel requires the first link";
    }
    return null;
  }
  if (contract !== "njDecidesBrandV1") return null;
  if (typeof values.logoAssetId === "string" && values.logoAssetId !== "" && (typeof values.logoAlt !== "string" || values.logoAlt.trim() === "")) {
    return "logoAlt is required when logoAssetId is set";
  }
  const background = values.backgroundColor;
  for (const field of ["textColor", "linkColor"]) {
    if (contrastRatio(values[field], background) < 4.5) {
      return `${field === "textColor" ? "Text" : "Link"} color must have at least 4.5:1 contrast against the background color.`;
    }
  }
  return null;
}
function canonicalInstant(value) {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

// packages/content-core/src/coverage-labels.ts
function isCoverageLabelsBuildData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  return Object.keys(data).every((key2) => ["settingId", "labels", "sourceVersion", "publishedAt"].includes(key2)) && data.settingId === COVERAGE_LABELS_SETTINGS_ID && !validateCoverageLabels(data.labels) && Number.isSafeInteger(data.sourceVersion) && Number(data.sourceVersion) > 0 && typeof data.publishedAt === "string" && Number.isFinite(Date.parse(data.publishedAt)) && new Date(data.publishedAt).toISOString() === data.publishedAt;
}

// packages/content-core/src/story-ctas.ts
function isStoryCtasBuildData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  return Object.keys(data).every((key2) => ["settingId", "rules", "sourceVersion", "publishedAt"].includes(key2)) && data.settingId === STORY_CTAS_SETTINGS_ID && !validateStoryCtaRules(data.rules) && Number.isSafeInteger(data.sourceVersion) && Number(data.sourceVersion) > 0 && typeof data.publishedAt === "string" && Number.isFinite(Date.parse(data.publishedAt)) && new Date(data.publishedAt).toISOString() === data.publishedAt;
}

// packages/content-core/src/service-composition.ts
function serviceCompositionError(pageId, version) {
  if (version === void 0) return null;
  if (version !== 1) return "The service composition version is invalid.";
  if (publicPage(pageId)?.family !== "service") return "Only service pages can use a service composition.";
  return null;
}

// site/src/lib/public-artifact-bundle.ts
var import_node_crypto5 = require("node:crypto");

// site/src/lib/published-record-images.ts
var PROGRAM_IMAGE_FILE_LIMIT = 2 * 1024 * 1024;
var PROGRAM_IMAGE_DESCRIPTOR_LIMIT = 2 * 1024 * 1024;
var PROGRAM_IMAGE_CATALOG_LIMIT = 4 * 1024 * 1024;
var PROGRAM_IMAGE_CATALOG_JSON_LIMIT = 6 * 1024 * 1024;
var ProgramImagePreparationError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "ProgramImagePreparationError";
    this.code = code;
  }
};
var object8 = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function refuse2(code = "program_image_contract") {
  throw new ProgramImagePreparationError(code);
}
function fields2(value, names) {
  if (!object8(value) || Object.keys(value).some((name) => !names.includes(name))) refuse2();
}
function sized(value, ceiling) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) refuse2();
  if (Number(value) > ceiling) refuse2("program_image_cap_exceeded");
}
function programImagePath(value) {
  return typeof value === "string" && /^\/_astro\/[A-Za-z0-9._-]+\.(avif|webp|jpeg|jpg|png)$/.test(value) && !value.includes("..") && !/%(?:2f|5c|00)/i.test(value);
}
function programImageReferences(image) {
  const paths = [image.url];
  for (const srcset of [image.srcset, ...(image.sources ?? []).map((source2) => source2.srcset)]) {
    if (!srcset) continue;
    for (const candidate of srcset.split(",")) {
      const match = /^(\S+) ([1-9][0-9]*w)$/.exec(candidate.trim());
      if (!match || !programImagePath(match[1])) refuse2();
      paths.push(match[1]);
    }
  }
  return [...new Set(paths)];
}
function descriptor(value, original) {
  fields2(value, ["url", "mimeType", "width", "height", "credit", "srcset", "sizes", "sources"]);
  if (value.mimeType !== original.mimeType || value.width !== original.width || value.height !== original.height || value.credit !== original.credit) refuse2();
  if (original.mimeType === "image/gif") {
    if (value.url !== original.url || value.srcset !== void 0 || value.sizes !== void 0 || value.sources !== void 0) refuse2();
    return;
  }
  if (!programImagePath(value.url) || typeof value.srcset !== "string" || !value.srcset || value.srcset.length > 16384 || typeof value.sizes !== "string" || !value.sizes || value.sizes.length > 300 || !Array.isArray(value.sources) || value.sources.length !== 2) refuse2();
  for (const [index, source2] of value.sources.entries()) {
    fields2(source2, ["type", "srcset"]);
    if (source2.type !== ["image/avif", "image/webp"][index] || typeof source2.srcset !== "string" || !source2.srcset || source2.srcset.length > 16384) refuse2();
  }
  programImageReferences(value);
}
function assertProgramImageCatalog(value, programs, identity) {
  fields2(value, ["schemaVersion", "buildBatchId", "generation", "rendererSha", "mediaManifestDigest", "programs", "files"]);
  if (value.schemaVersion !== 1 || typeof value.buildBatchId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.buildBatchId) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || value.rendererSha !== identity.rendererSha || !/^[a-f0-9]{40}$/.test(String(value.rendererSha)) || !/^[a-f0-9]{64}$/.test(String(value.mediaManifestDigest)) || identity.buildBatchId !== void 0 && value.buildBatchId !== identity.buildBatchId || identity.generation !== void 0 && value.generation !== identity.generation || identity.mediaManifestDigest !== void 0 && value.mediaManifestDigest !== identity.mediaManifestDigest || !Array.isArray(value.programs) || value.programs.length > 1e3 || !Array.isArray(value.files) || value.files.length > 256) refuse2();
  if (new TextEncoder().encode(JSON.stringify(value)).length > PROGRAM_IMAGE_CATALOG_JSON_LIMIT) refuse2("program_image_cap_exceeded");
  const wanted = /* @__PURE__ */ new Map();
  for (const program2 of programs) {
    if (!program2.keyArt) continue;
    const original = program2.keyArt;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(program2.programId) || wanted.has(program2.programId) || !Number.isSafeInteger(program2.sourceVersion) || program2.sourceVersion < 1 || !/^\/programs\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(program2.path) || !/^[A-Za-z0-9_-]{1,128}$/.test(original.assetId) || !["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].includes(original.mimeType) || !Number.isSafeInteger(original.width) || original.width < 1 || !Number.isSafeInteger(original.height) || original.height < 1) refuse2();
    wanted.set(program2.programId, program2);
  }
  const seen = /* @__PURE__ */ new Set();
  const references = /* @__PURE__ */ new Set();
  const fileMap = /* @__PURE__ */ new Map();
  let total = 0;
  for (const file of value.files) {
    fields2(file, ["path", "digest", "size", "contentType", "base64"]);
    if (!programImagePath(file.path) || fileMap.has(file.path) || !/^[a-f0-9]{64}$/.test(String(file.digest)) || typeof file.base64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64) || file.base64.length % 4 !== 0 || file.contentType !== `image/${file.path.endsWith(".jpeg") || file.path.endsWith(".jpg") ? "jpeg" : file.path.split(".").at(-1)}`) refuse2();
    sized(file.size, PROGRAM_IMAGE_FILE_LIMIT);
    total += file.size;
    if (total > PROGRAM_IMAGE_CATALOG_LIMIT) refuse2("program_image_cap_exceeded");
    fileMap.set(file.path, file);
  }
  for (const entry2 of value.programs) {
    fields2(entry2, ["programId", "sourceVersion", "path", "original", "content", "grid"]);
    const program2 = typeof entry2.programId === "string" ? wanted.get(entry2.programId) : void 0;
    if (!program2?.keyArt || seen.has(program2.programId) || entry2.sourceVersion !== program2.sourceVersion || entry2.path !== program2.path) refuse2();
    fields2(entry2.original, ["assetId", "url", "mimeType", "width", "height", "credit"]);
    for (const key2 of ["assetId", "url", "mimeType", "width", "height", "credit"]) {
      if (entry2.original[key2] !== program2.keyArt[key2]) refuse2();
    }
    for (const role of ["content", "grid"]) {
      descriptor(entry2[role], program2.keyArt);
      const paths = programImageReferences(entry2[role]);
      let size = 0;
      for (const path of paths) {
        if (path === program2.keyArt.url && program2.keyArt.mimeType === "image/gif") continue;
        const file = fileMap.get(path);
        if (!file) refuse2("program_image_integrity");
        references.add(path);
        size += file.size;
      }
      if (size > PROGRAM_IMAGE_DESCRIPTOR_LIMIT) refuse2("program_image_cap_exceeded");
    }
    seen.add(program2.programId);
  }
  if (seen.size !== wanted.size || references.size !== fileMap.size) refuse2("program_image_integrity");
  return value;
}
function programImageBytes(file) {
  sized(file.size, PROGRAM_IMAGE_FILE_LIMIT);
  if (file.base64.length > Math.ceil(PROGRAM_IMAGE_FILE_LIMIT / 3) * 4) refuse2("program_image_cap_exceeded");
  let decoded;
  try {
    decoded = atob(file.base64);
  } catch {
    refuse2("program_image_integrity");
  }
  if (decoded.length !== file.size) refuse2("program_image_integrity");
  return Uint8Array.from(decoded, (value) => value.charCodeAt(0));
}

// site/src/lib/public-artifact-bundle.ts
var import_node_util3 = require("node:util");

// site/src/lib/program-card-data.ts
function programCardData(snapshot) {
  const summary = snapshot.description.content?.map((node) => node.content?.map((child) => child.text ?? "").join("") ?? "").join(" ").replace(/\s+/g, " ").trim().slice(0, 180) ?? "";
  return {
    title: snapshot.title,
    url: snapshot.path,
    art: snapshot.keyArt,
    alt: snapshot.keyArtDecorative ? "" : snapshot.keyArtAlt,
    genre: snapshot.genre,
    summary
  };
}

// site/src/lib/event-card-data.ts
function eventCardData(snapshot) {
  return {
    title: snapshot.title,
    url: snapshot.path,
    startsAt: snapshot.startsAt,
    endsAt: snapshot.endsAt,
    location: snapshot.location,
    image: snapshot.image,
    imageAlt: snapshot.imageDecorative ? "" : snapshot.imageAlt,
    registrationUrl: snapshot.registrationUrl,
    registrationLabel: snapshot.registrationLabel
  };
}

// packages/content-core/src/post-slugs.ts
var POST_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isServerMintableSlugShape(value) {
  return typeof value === "string" && POST_SLUG_SHAPE.test(value);
}

// packages/content-core/src/public-record-kinds.ts
var ROUTE_BASES = /* @__PURE__ */ new Map([
  ["post", "/posts/"],
  ["program", "/programs/"],
  ["event", "/events/"]
]);
function publicRouteBaseForRecordKind(value) {
  if (typeof value !== "string") return null;
  return ROUTE_BASES.get(value) ?? null;
}

// site/src/lib/public-content-routes.ts
var POST_PUBLIC_ROUTE_BASE = publicRouteBaseForRecordKind("post");
var PROGRAM_PUBLIC_ROUTE_BASE = publicRouteBaseForRecordKind("program");
var EVENT_PUBLIC_ROUTE_BASE = publicRouteBaseForRecordKind("event");
function isPublicContentSlug(value) {
  return isServerMintableSlugShape(value);
}
function publicPath(base, slug) {
  if (!isPublicContentSlug(slug)) {
    throw new Error(`${base}{slug}/ requires a server-mintable slug`);
  }
  return `${base}${slug}/`;
}
function postPublicPath(slug) {
  return publicPath(POST_PUBLIC_ROUTE_BASE, slug);
}
function programPublicPath(slug) {
  return publicPath(PROGRAM_PUBLIC_ROUTE_BASE, slug);
}
function eventPublicPath(slug) {
  return publicPath(EVENT_PUBLIC_ROUTE_BASE, slug);
}

// packages/content-core/src/nj-decides-brand.ts
function object9(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function resolveNjDecidesImage(value) {
  if (!object9(value) || typeof value.url !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(String(value.mimeType)) || !Number.isSafeInteger(value.width) || Number(value.width) < 1 || !Number.isSafeInteger(value.height) || Number(value.height) < 1 || Number(value.width) * Number(value.height) > 1e8) return void 0;
  try {
    if (safeHref(value.url) !== value.url || !/^\/(?!\/)/.test(value.url) && new URL(value.url).protocol !== "https:") return void 0;
  } catch {
    return void 0;
  }
  return { url: value.url, mimeType: String(value.mimeType), width: Number(value.width), height: Number(value.height) };
}

// site/src/lib/nj-decides-settings.ts
function isNjDecidesBuildData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value;
  const schema = currentCmsSettingsSchemaFor(NJ_DECIDES_SETTINGS_ID);
  const allowed = /* @__PURE__ */ new Set([...Object.keys(schema.fields), "settingId", "sourceVersion", "publishedAt", "assets"]);
  if (Object.keys(row).some((key2) => !allowed.has(key2)) || row.settingId !== NJ_DECIDES_SETTINGS_ID || !Number.isSafeInteger(row.sourceVersion) || Number(row.sourceVersion) < 1 || typeof row.publishedAt !== "string" || Number.isNaN(Date.parse(row.publishedAt)) || new Date(row.publishedAt).toISOString() !== row.publishedAt || !row.assets || typeof row.assets !== "object" || Array.isArray(row.assets)) return false;
  const values = Object.fromEntries(Object.keys(schema.fields).filter((key2) => row[key2] !== void 0).map((key2) => [key2, row[key2]]));
  if (validateCmsSettingsValues(schema, values)) return false;
  const refs = new Set([values.logoAssetId, values.backgroundAssetId].filter(Boolean));
  return Object.entries(row.assets).every(([id2, asset]) => refs.has(id2) && resolveNjDecidesImage(asset) !== void 0 && Object.keys(asset).every((key2) => ["url", "mimeType", "width", "height"].includes(key2)));
}

// packages/content-core/src/data-figure-render.ts
function isObject2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyFields3(value, fields4) {
  return Object.keys(value).every((key2) => fields4.includes(key2));
}
function isText(value, limit, required = true) {
  return typeof value === "string" && value.length <= limit && (!required || Boolean(value.trim()));
}
function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function isTimestamp(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function fitsReleaseLimit(value) {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && new TextEncoder().encode(json).length <= MAX_DATASET_BYTES;
  } catch {
    return false;
  }
}
function isBoundedNumber(value, unit) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15 && (unit !== "percent" || value >= 0 && value <= 100);
}
function isPeriod(value) {
  return isObject2(value) && hasOnlyFields3(value, ["start", "end", "label"]) && isDate(value.start) && isDate(value.end) && value.start <= value.end && isText(value.label, 120);
}
function isGeography(value) {
  if (!isObject2(value) || !hasOnlyFields3(value, ["level", "code", "label"]) || typeof value.level !== "string" || !DATASET_GEOGRAPHIES.includes(value.level) || !isText(value.code, 32) || !isText(value.label, 240)) return false;
  const patterns = {
    nation: /^[A-Z]{2}$/,
    state: /^[A-Z]{2}$/,
    county: /^\d{5}$/,
    municipality: /^\d{10}$/,
    metro: /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/
  };
  return patterns[value.level].test(value.code);
}
function isSource(value) {
  return isObject2(value) && hasOnlyFields3(value, ["publisher", "title", "url", "seriesId"]) && isText(value.publisher, 300) && isText(value.title, 300) && isExactHttpsUrl(value.url, 2e3) && (value.seriesId === void 0 || isText(value.seriesId, 120, false));
}
function isComparator(value, release) {
  if (!isObject2(value) || !hasOnlyFields3(value, ["label", "unit", "value", "period", "geography", "adjustment", "source", "comparisonNote"]) || !isText(value.label, 300) || value.unit !== release.unit || !isBoundedNumber(value.value, value.unit) || !isPeriod(value.period) || !isGeography(value.geography) || !isSource(value.source) || typeof value.adjustment !== "string" || !DATASET_ADJUSTMENTS.includes(value.adjustment) || !isText(value.comparisonNote, 2e3, false)) return false;
  const primaryPeriod = release.period;
  const primaryGeography = release.geography;
  const mismatch = value.adjustment !== release.adjustment || value.geography.code !== primaryGeography.code || value.geography.level !== primaryGeography.level || value.period.start !== primaryPeriod.start || value.period.end !== primaryPeriod.end;
  return !mismatch || Boolean(value.comparisonNote.trim());
}
function isPoint(value, unit, previousPeriod) {
  if (!isObject2(value) || !hasOnlyFields3(value, ["period", "value", "missingReason"]) || !isDate(value.period) || value.period <= previousPeriod) return false;
  if (value.value === null) return isText(value.missingReason, 500);
  return isBoundedNumber(value.value, unit) && value.missingReason === void 0;
}
function isPublicRelease(value) {
  if (!isObject2(value) || !hasOnlyFields3(value, ["label", "unit", "value", "period", "geography", "adjustment", "points", "chartText", "methodNote", "comparators", "source", "releasedOn", "verifiedOn", "changeKind", "changeNote", "reuse"]) || !fitsReleaseLimit(value) || !isText(value.label, 300) || typeof value.unit !== "string" || !DATASET_UNITS.includes(value.unit) || !isBoundedNumber(value.value, value.unit) || !isPeriod(value.period) || !isGeography(value.geography) || typeof value.adjustment !== "string" || !DATASET_ADJUSTMENTS.includes(value.adjustment) || !isSource(value.source) || !isText(value.chartText, 2e3) || !isText(value.methodNote, 4e3) || !isDate(value.releasedOn) || !isDate(value.verifiedOn) || value.verifiedOn < value.releasedOn || value.changeKind !== "new_release" && value.changeKind !== "correction" || !isText(value.changeNote, 2e3, value.changeKind === "correction") || !Array.isArray(value.points) || value.points.length < 1 || value.points.length > 240 || !Array.isArray(value.comparators) || value.comparators.length > 3 || !isObject2(value.reuse) || !hasOnlyFields3(value.reuse, ["display", "exports", "note"]) || value.reuse.display !== "allowed" || typeof value.reuse.exports !== "string" || !["unknown", "allowed", "denied"].includes(value.reuse.exports) || !isText(value.reuse.note, 2e3, false)) return false;
  let previousPeriod = "";
  for (const point of value.points) {
    if (!isPoint(point, value.unit, previousPeriod)) return false;
    previousPeriod = point.period;
  }
  return value.comparators.every((comparator) => isComparator(comparator, value));
}
function isDatasetPublicProjection(value) {
  return isObject2(value) && hasOnlyFields3(value, ["datasetId", "releaseId", "revision", "digest", "approvedAt", "release"]) && validDatasetId(value.datasetId) && validDatasetId(value.releaseId) && Number.isSafeInteger(value.revision) && value.revision >= 1 && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest) && isTimestamp(value.approvedAt) && isPublicRelease(value.release);
}

// packages/content-core/src/dataset-figures.ts
var key = (release) => `${release.datasetId}/${release.releaseId}/${release.revision}/${release.digest}`;
function object10(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function fields3(value, allowed) {
  return Object.keys(value).every((field) => allowed.includes(field));
}
function isDatasetFigures(value) {
  if (!object10(value) || !fields3(value, ["figures", "releases"]) || !Array.isArray(value.figures) || value.figures.length > 200 || !Array.isArray(value.releases) || value.releases.length > 200) return false;
  const releases = /* @__PURE__ */ new Set();
  for (const release of value.releases) {
    if (!isDatasetPublicProjection(release) || releases.has(key(release))) return false;
    releases.add(key(release));
  }
  const blocks = /* @__PURE__ */ new Set();
  const used = /* @__PURE__ */ new Set();
  for (const binding of value.figures) {
    if (!object10(binding) || !validDatasetId(binding.blockId) || !validDatasetId(binding.datasetId) || blocks.has(binding.blockId)) return false;
    blocks.add(binding.blockId);
    if (binding.withdrawn === true) {
      if (!fields3(binding, ["blockId", "datasetId", "withdrawn"])) return false;
      continue;
    }
    if (!fields3(binding, ["blockId", "datasetId", "releaseId", "revision", "digest"]) || !validDatasetId(binding.releaseId) || !Number.isSafeInteger(binding.revision) || Number(binding.revision) < 1 || typeof binding.digest !== "string" || !/^[a-f0-9]{64}$/.test(binding.digest)) return false;
    const identity = `${binding.datasetId}/${binding.releaseId}/${binding.revision}/${binding.digest}`;
    if (!releases.has(identity)) return false;
    used.add(identity);
  }
  return used.size === releases.size;
}
function createDatasetFigureResolver(figures) {
  if (!isDatasetFigures(figures)) return () => null;
  const bindings = new Map(figures.figures.map((binding) => [binding.blockId, binding]));
  const releases = new Map(figures.releases.map((release) => [key(release), release]));
  return (blockId, data) => {
    if (!isDataFigureData(data, true)) return null;
    const binding = bindings.get(blockId);
    if (!binding || binding.datasetId !== data.datasetId || "withdrawn" in binding || data.version.mode === "pinned" && binding.releaseId !== data.version.releaseId) return null;
    return releases.get(`${binding.datasetId}/${binding.releaseId}/${binding.revision}/${binding.digest}`) ?? null;
  };
}

// site/src/lib/dataset-figures-projection.ts
function isSorted(values) {
  return values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) <= 0);
}
function projectDatasetFigures(value, blocks, owner, { required = true } = {}) {
  const dataBlocks = visibleLayoutBlocks(blocks).filter((block) => block.type === "data_figure" && isDataFigureData(block.data, true));
  if (value === void 0) {
    if (required && dataBlocks.length > 0) {
      throw new Error(`${owner} has no frozen dataset figures`);
    }
    return void 0;
  }
  if (!isDatasetFigures(value)) {
    throw new Error(`${owner} has invalid frozen dataset figures`);
  }
  const figureKeys = value.figures.map((binding) => binding.blockId);
  const releaseKeys = value.releases.map((release) => `${release.datasetId}/${release.releaseId}`);
  if (!isSorted(figureKeys) || !isSorted(releaseKeys)) {
    throw new Error(`${owner} frozen dataset figures are not normalized`);
  }
  const expected = new Map(dataBlocks.map((block) => [block.id, block.data]));
  if (value.figures.length !== expected.size || value.figures.some((binding) => expected.get(binding.blockId)?.datasetId !== binding.datasetId)) {
    throw new Error(`${owner} frozen dataset figures do not match its blocks`);
  }
  const resolve = createDatasetFigureResolver(value);
  for (const block of dataBlocks) {
    const binding = value.figures.find((item) => item.blockId === block.id);
    if (!binding) throw new Error(`${owner} has an unfrozen data figure`);
    if ("withdrawn" in binding) continue;
    if (block.data.version.mode === "pinned" && binding.releaseId !== block.data.version.releaseId) {
      throw new Error(`${owner} frozen dataset figure version does not match its block`);
    }
    if (!resolve(block.id, block.data)) {
      throw new Error(`${owner} frozen dataset figure cannot be resolved`);
    }
  }
  return structuredClone(value);
}

// site/src/lib/public-artifact-inventory.ts
var import_node_module = require("node:module");
var import_node_util2 = require("node:util");
var requireModule = (0, import_node_module.createRequire)(__generatedReaderModuleUrl);
var manifestModule = requireModule(
  "./public-media-manifest.js"
);
var mediaUsageModule = requireModule(
  "./media-usage.js"
);
var deploymentModule = requireModule(
  "./public-deployment.js"
);
var {
  PUBLIC_MEDIA_MANIFEST_COLLECTIONS,
  PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
  createPublicMediaManifest
} = manifestModule;
var { collectPublishedMediaUsage } = mediaUsageModule;
var {
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
  assertPublicDeploymentReservedBatch,
  assertPublicDeploymentTerminalBatchStructure,
  projectPublicBuildReservation
} = deploymentModule;
var PUBLIC_ARTIFACT_INVENTORY_SCHEMA_VERSION = 2;
var MAX_BACKGROUND_ARTIFACT_CUTOFF_AGE_MILLIS = 60 * 6e4;
var RECEIPT_FIELDS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "mediaManifestSchemaVersion",
  "digestAlgorithm",
  "buildBatchId",
  "generation",
  "commitSha",
  "cutoffAt",
  "aggregateRoutes",
  "families",
  "ownerCount",
  "owners",
  "mediaManifestDigest"
]);
var SETTINGS_FALLBACKS_FIELD = "settingsFallbacks";
var SETTINGS_FALLBACK_FIELDS = /* @__PURE__ */ new Set(["documentId", "sourceVersion"]);
var PUBLIC_SETTINGS_IDS = /* @__PURE__ */ new Set([
  STORY_CTAS_SETTINGS_ID,
  COVERAGE_LABELS_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID
]);
var FALLBACK_SETTINGS_IDS = /* @__PURE__ */ new Set([
  STORY_CTAS_SETTINGS_ID,
  COVERAGE_LABELS_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_SITE_CHROME_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID
]);
var FAMILY_FIELDS = /* @__PURE__ */ new Set(["collection", "complete", "artifacts"]);
var ARTIFACT_FIELDS = /* @__PURE__ */ new Set([
  "documentId",
  "sourceVersion",
  "canonicalPath",
  "aliases"
]);
var OWNER_FIELDS = /* @__PURE__ */ new Set([
  "collection",
  "documentId",
  "sourceVersion",
  "assetIds",
  "occurrenceCount"
]);
var SETTINGS_INPUT_FIELDS = /* @__PURE__ */ new Set([
  "documentId",
  "sourceVersion",
  "publishedSnapshot"
]);
var SETTINGS_MEDIA_INPUT_FIELDS = /* @__PURE__ */ new Set([...SETTINGS_INPUT_FIELDS, "assetIds"]);
var SAFE_ROUTE = /^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/;
var PublicArtifactInventoryError = class extends Error {
  constructor(message = "The public artifact inventory receipt is invalid") {
    super(message);
    this.name = "PublicArtifactInventoryError";
  }
};
function invalid(message = "The public artifact inventory receipt is invalid") {
  throw new PublicArtifactInventoryError(message);
}
function plainObject3(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function hasExactFields(value, fields4) {
  return plainObject3(value) && Object.keys(value).length === fields4.size && Object.keys(value).every((field) => fields4.has(field));
}
function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function safeRoute(value) {
  return typeof value === "string" && SAFE_ROUTE.test(value);
}
var AUTHOR_ROUTE_BASE = "/authors/";
var POSTS_ROUTE = "/posts/";
var PROGRAMS_ROUTE = "/programs/";
var EVENTS_ROUTE = "/events/";
var STAFF_ROUTE = "/staff/";
function routeUnderBase(route, base) {
  if (!safeRoute(route) || !route.startsWith(base)) return false;
  const rest = route.slice(base.length, -1);
  return rest.length > 0 && !rest.includes("/");
}
function routedFamilyRoute(collection, route) {
  if (collection === "cmsAuthorProfilesPublic") {
    return routeUnderBase(route, AUTHOR_ROUTE_BASE);
  }
  if (collection !== "cmsPosts") return false;
  return ["post", "program", "event"].some((kind) => {
    const base = publicRouteBaseForRecordKind(kind);
    return base !== null && routeUnderBase(route, base);
  });
}
function definitionFor(documentId) {
  const definition = publicPage(documentId);
  if (!definition) invalid();
  return definition;
}
function inventoryFromFamilies(families) {
  return families.map(({ collection, artifacts }) => ({
    collection,
    complete: true,
    documentIds: artifacts.map(({ documentId }) => documentId)
  }));
}
function syntheticReservation(value) {
  const cutoffAt = {
    seconds: value.cutoffAt.seconds,
    nanoseconds: value.cutoffAt.nanoseconds,
    toMillis: () => value.cutoffAt.seconds * 1e3 + Math.floor(value.cutoffAt.nanoseconds / 1e6)
  };
  return {
    schemaVersion: PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    reservedAgainstGeneration: 0,
    reservedAgainstDeploymentId: null,
    reservedAgainstCommitSha: null,
    cutoffAt,
    reservedAt: cutoffAt
  };
}
function canonicalFamilies(value) {
  if (!Array.isArray(value) || value.length !== PUBLIC_MEDIA_MANIFEST_COLLECTIONS.length) {
    invalid();
  }
  const families = [];
  const routeOwners = /* @__PURE__ */ new Set();
  for (const [index, collection] of PUBLIC_MEDIA_MANIFEST_COLLECTIONS.entries()) {
    const family = value[index];
    if (!hasExactFields(family, FAMILY_FIELDS) || family.collection !== collection || family.complete !== true || !Array.isArray(family.artifacts)) {
      invalid();
    }
    const routed = collection === "cmsPosts" || collection === "cmsAuthorProfilesPublic";
    if (collection === "cmsSettings" && (family.artifacts.length > PUBLIC_SETTINGS_IDS.size || family.artifacts.some((artifact) => !plainObject3(artifact) || typeof artifact.documentId !== "string" || !PUBLIC_SETTINGS_IDS.has(artifact.documentId)))) {
      invalid();
    }
    const artifacts = family.artifacts.map((artifact) => {
      if (!hasExactFields(artifact, ARTIFACT_FIELDS) || typeof artifact.documentId !== "string" || !Number.isSafeInteger(artifact.sourceVersion) || Number(artifact.sourceVersion) < 1 || !(collection === "cmsPosts" && artifact.canonicalPath === null && Array.isArray(artifact.aliases) && artifact.aliases.length === 0) && !safeRoute(artifact.canonicalPath) || !Array.isArray(artifact.aliases) || artifact.aliases.some((alias) => !safeRoute(alias))) {
        invalid();
      }
      const canonical = {
        documentId: artifact.documentId,
        sourceVersion: Number(artifact.sourceVersion),
        canonicalPath: artifact.canonicalPath,
        aliases: [...artifact.aliases]
      };
      if (routed) {
        const sortedAliases = [...canonical.aliases].sort(compareText);
        if (!(collection === "cmsPosts" && canonical.canonicalPath === null && canonical.aliases.length === 0) && (!routedFamilyRoute(collection, canonical.canonicalPath) || canonical.aliases.some((alias) => !routedFamilyRoute(collection, alias)) || canonical.aliases.includes(canonical.canonicalPath) || new Set(canonical.aliases).size !== canonical.aliases.length || !(0, import_node_util2.isDeepStrictEqual)(canonical.aliases, sortedAliases))) {
          invalid();
        }
      } else if (collection === "cmsSettings") {
        const expected = {
          documentId: canonical.documentId,
          sourceVersion: Number(artifact.sourceVersion),
          canonicalPath: "/",
          aliases: []
        };
        if (!(0, import_node_util2.isDeepStrictEqual)(canonical, expected)) invalid();
      } else {
        const definition = definitionFor(artifact.documentId);
        const validPath = (route) => isPublicPagePath(definition.id, route);
        if (canonical.canonicalPath === null || !validPath(canonical.canonicalPath) || canonical.aliases.some((alias) => !validPath(alias)) || canonical.aliases.includes(canonical.canonicalPath) || new Set(canonical.aliases).size !== canonical.aliases.length || !(0, import_node_util2.isDeepStrictEqual)(canonical.aliases, [...canonical.aliases].sort(compareText))) invalid();
      }
      if (collection !== "cmsSettings" && canonical.canonicalPath !== null) {
        for (const route of [canonical.canonicalPath, ...canonical.aliases]) {
          if (routeOwners.has(route)) invalid();
          routeOwners.add(route);
        }
      }
      return canonical;
    });
    const sorted = [...artifacts].sort((left, right) => compareText(left.documentId, right.documentId));
    if (!(0, import_node_util2.isDeepStrictEqual)(artifacts, sorted) || new Set(artifacts.map(({ documentId }) => documentId)).size !== artifacts.length) {
      invalid();
    }
    families.push({
      collection,
      complete: true,
      artifacts
    });
  }
  return families;
}
function canonicalSettingsFallbacks(value, families) {
  if (!Array.isArray(value) || value.length === 0) invalid();
  const settingsFamily = families.find(({ collection }) => collection === "cmsSettings");
  const seen = /* @__PURE__ */ new Set();
  return value.map((fallback) => {
    if (!hasExactFields(fallback, SETTINGS_FALLBACK_FIELDS) || typeof fallback.documentId !== "string" || !FALLBACK_SETTINGS_IDS.has(fallback.documentId) || !Number.isSafeInteger(fallback.sourceVersion) || Number(fallback.sourceVersion) < 1 || seen.has(fallback.documentId) || [...seen].some((previous) => compareText(previous, String(fallback.documentId)) > 0) || !settingsFamily?.artifacts.some((artifact) => artifact.documentId === fallback.documentId && artifact.sourceVersion === fallback.sourceVersion)) {
      invalid();
    }
    seen.add(fallback.documentId);
    return {
      documentId: fallback.documentId,
      sourceVersion: Number(fallback.sourceVersion)
    };
  });
}
function assertPublicArtifactInventoryReceipt(value, expectedReservation = null) {
  const hasSettingsFallbacks = plainObject3(value) && Object.hasOwn(value, SETTINGS_FALLBACKS_FIELD);
  const receiptFields = hasSettingsFallbacks ? /* @__PURE__ */ new Set([...RECEIPT_FIELDS, SETTINGS_FALLBACKS_FIELD]) : RECEIPT_FIELDS;
  if (!hasExactFields(value, receiptFields) || value.schemaVersion !== PUBLIC_ARTIFACT_INVENTORY_SCHEMA_VERSION || value.mediaManifestSchemaVersion !== PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION || value.digestAlgorithm !== "sha256" || !plainObject3(value.cutoffAt) || !Number.isSafeInteger(value.cutoffAt.seconds) || Number(value.cutoffAt.seconds) < 0 || !Number.isSafeInteger(value.cutoffAt.nanoseconds) || Number(value.cutoffAt.nanoseconds) < 0 || Number(value.cutoffAt.nanoseconds) > 999999999 || !Array.isArray(value.aggregateRoutes) || !(0, import_node_util2.isDeepStrictEqual)(value.aggregateRoutes, [POSTS_ROUTE, PROGRAMS_ROUTE, EVENTS_ROUTE, STAFF_ROUTE]) || !Array.isArray(value.owners) || !Number.isSafeInteger(value.ownerCount) || value.ownerCount !== value.owners.length || typeof value.mediaManifestDigest !== "string") {
    invalid();
  }
  const families = canonicalFamilies(value.families);
  const owners = value.owners.map((owner) => {
    if (!hasExactFields(owner, OWNER_FIELDS)) invalid();
    return { ...owner };
  });
  const receipt = {
    schemaVersion: Number(value.schemaVersion),
    mediaManifestSchemaVersion: Number(value.mediaManifestSchemaVersion),
    digestAlgorithm: value.digestAlgorithm,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    cutoffAt: {
      seconds: Number(value.cutoffAt.seconds),
      nanoseconds: Number(value.cutoffAt.nanoseconds)
    },
    aggregateRoutes: [...value.aggregateRoutes],
    families,
    ownerCount: Number(value.ownerCount),
    owners,
    mediaManifestDigest: value.mediaManifestDigest,
    ...hasSettingsFallbacks ? { settingsFallbacks: canonicalSettingsFallbacks(value.settingsFallbacks, families) } : {}
  };
  let manifest;
  try {
    const reservation = expectedReservation === null ? syntheticReservation(receipt) : projectPublicBuildReservation(expectedReservation, receipt.buildBatchId);
    manifest = createPublicMediaManifest({
      reservation,
      artifactInventory: inventoryFromFamilies(families),
      owners
    });
  } catch {
    invalid();
  }
  if (manifest.schemaVersion !== receipt.mediaManifestSchemaVersion || manifest.digestAlgorithm !== receipt.digestAlgorithm || manifest.buildBatchId !== receipt.buildBatchId || manifest.generation !== receipt.generation || manifest.commitSha !== receipt.commitSha || !(0, import_node_util2.isDeepStrictEqual)(manifest.cutoffAt, receipt.cutoffAt) || manifest.ownerCount !== receipt.ownerCount || !(0, import_node_util2.isDeepStrictEqual)(manifest.owners, receipt.owners) || manifest.mediaManifestDigest !== receipt.mediaManifestDigest) {
    invalid();
  }
  const sourceVersions = new Map(
    families.flatMap((family) => family.artifacts.map((artifact) => [
      `${family.collection}\0${artifact.documentId}`,
      artifact.sourceVersion
    ]))
  );
  for (const owner of owners) {
    if (sourceVersions.get(`${owner.collection}\0${owner.documentId}`) !== owner.sourceVersion) {
      invalid();
    }
  }
  return receipt;
}

// site/src/lib/public-artifact-bundle.ts
var PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION = 3;
function plainObject4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertArray(value, label) {
  if (!Array.isArray(value) || value.some((entry2) => !plainObject4(entry2))) {
    throw new Error(`The public artifact bundle ${label} list is invalid`);
  }
}
function projectedAliases(value, pathFor) {
  if (!Array.isArray(value) || value.some((slug) => typeof slug !== "string")) {
    return null;
  }
  try {
    return value.map((slug) => pathFor(slug));
  } catch {
    return null;
  }
}
function projectedCanonicalPath(storedPath, slug, pathFor) {
  if (typeof storedPath !== "string" || typeof slug !== "string") return null;
  try {
    const projected = pathFor(slug);
    return storedPath === projected ? projected : null;
  } catch {
    return null;
  }
}
function canonicalInstantString(value) {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function assertSiteNavigationSetting(setting) {
  const allowed = /* @__PURE__ */ new Set(["settingId", "header", "footer", "sourceVersion", "publishedAt", "postsBrowse"]);
  if (!["settingId", "header", "footer", "sourceVersion", "publishedAt"].every((key2) => Object.hasOwn(setting, key2)) || Object.keys(setting).some((field) => !allowed.has(field)) || !Number.isSafeInteger(setting.sourceVersion) || Number(setting.sourceVersion) < 1 || !canonicalInstantString(setting.publishedAt)) {
    throw new Error("The public artifact bundle settings list is invalid");
  }
  const schema = cmsSettingsSchemaFor(SITE_NAVIGATION_SETTINGS_ID, setting.postsBrowse === void 0 ? 1 : 2);
  const settingsError = schema ? validateCmsSettingsValues(schema, { header: setting.header, footer: setting.footer, ...setting.postsBrowse === void 0 ? {} : { postsBrowse: setting.postsBrowse } }) : "The site navigation settings schema is missing";
  if (settingsError) {
    throw new Error(`The public artifact bundle settings list is invalid: ${settingsError}`);
  }
}
var PUBLIC_SITE_CHROME_BUNDLE_FIELDS = /* @__PURE__ */ new Set([
  "settingId",
  "newsletterEnabled",
  "newsletterLabel",
  "newsletterHref",
  "newsletterOpensInNewTab",
  "sourceVersion",
  "publishedAt"
]);
function assertPublicSiteChromeSetting(setting) {
  if (Object.keys(setting).length !== PUBLIC_SITE_CHROME_BUNDLE_FIELDS.size || Object.keys(setting).some((field) => !PUBLIC_SITE_CHROME_BUNDLE_FIELDS.has(field)) || !Number.isSafeInteger(setting.sourceVersion) || Number(setting.sourceVersion) < 1 || !canonicalInstantString(setting.publishedAt)) {
    throw new Error("The public artifact bundle settings list is invalid");
  }
  const schema = cmsSettingsSchemaFor(PUBLIC_SITE_CHROME_SETTINGS_ID, 1);
  const settingsError = schema ? validateCmsSettingsValues(schema, {
    newsletterEnabled: setting.newsletterEnabled,
    newsletterLabel: setting.newsletterLabel,
    newsletterHref: setting.newsletterHref,
    newsletterOpensInNewTab: setting.newsletterOpensInNewTab
  }) : "The public-site chrome settings schema is missing";
  if (settingsError) {
    throw new Error(`The public artifact bundle settings list is invalid: ${settingsError}`);
  }
}
function validSponsorCard(value, id2) {
  if (!plainObject4(value)) return false;
  const fields4 = ["sponsorId", "name", "href", "logoUrl", "logoAlt", "logoDecorative", "tier", "description"];
  return Object.keys(value).every((field) => fields4.includes(field)) && value.sponsorId === id2 && typeof value.name === "string" && !!value.name.trim() && (value.href === null || typeof value.href === "string" && /^https?:\/\//i.test(value.href) && !!safeHref(value.href)) && (value.logoUrl === null || typeof value.logoUrl === "string" && value.logoUrl.startsWith("https://")) && typeof value.logoAlt === "string" && typeof value.logoDecorative === "boolean" && (value.tier === void 0 || typeof value.tier === "string") && (value.description === void 0 || typeof value.description === "string");
}
function validNewsletterCard(value, title) {
  if (!plainObject4(value) || !plainObject4(value.card) || Object.keys(value).some((key2) => !["card", "image"].includes(key2))) return false;
  const card = value.card;
  if (card.title !== title || Object.keys(card).some((key2) => ![
    "title",
    "signupUrl",
    "frequency",
    "summary",
    "imageAssetId",
    "imageAlt",
    "imageDecorative"
  ].includes(key2))) return false;
  if (typeof card.signupUrl !== "string") return false;
  try {
    const url = new URL(card.signupUrl);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return false;
  } catch {
    return false;
  }
  if (["frequency", "summary", "imageAssetId", "imageAlt"].some((key2) => card[key2] !== void 0 && typeof card[key2] !== "string")) return false;
  if (card.imageDecorative !== void 0 && typeof card.imageDecorative !== "boolean") return false;
  if (value.image !== void 0) {
    const image = value.image;
    if (!plainObject4(image) || Object.keys(image).some((key2) => !["url", "mimeType", "width", "height"].includes(key2)) || typeof image.url !== "string" || !image.url.startsWith("https://") || typeof image.mimeType !== "string" || !/^image\/(png|jpeg|webp|gif|avif)$/.test(image.mimeType) || !Number.isSafeInteger(image.width) || Number(image.width) < 1 || !Number.isSafeInteger(image.height) || Number(image.height) < 1 || !card.imageAssetId) return false;
  }
  return true;
}
function assertRecordCards(value) {
  assertArray(value, "record card");
  const seenCards = /* @__PURE__ */ new Set();
  for (const card of value) {
    const key2 = `${card.kind}:${card.id}`;
    if (!["program", "event", "sponsor", "newsletter"].includes(String(card.kind)) || typeof card.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(card.id) || typeof card.title !== "string" || !card.title.trim() || (card.kind === "program" || card.kind === "event") && (typeof card.href !== "string" || !/^\/(?!\/)/.test(card.href)) || card.kind === "sponsor" && !(card.href === null || typeof card.href === "string" && /^https?:\/\//i.test(card.href)) || card.kind === "newsletter" && card.href !== null || Object.keys(card).some((field) => !["kind", "id", "title", "href", "program", "event", "sponsor", "newsletter", "sourceVersion"].includes(field)) || card.sourceVersion !== void 0 && (!Number.isSafeInteger(card.sourceVersion) || Number(card.sourceVersion) < 1 || card.kind !== "sponsor" && card.kind !== "newsletter") || card.sponsor !== void 0 && (card.kind !== "sponsor" || !validSponsorCard(card.sponsor, card.id)) || card.newsletter !== void 0 && (card.kind !== "newsletter" || !validNewsletterCard(card.newsletter, card.title)) || card.program !== void 0 && card.kind !== "program" || card.event !== void 0 && card.kind !== "event" || seenCards.has(key2)) {
      throw new Error("The public artifact bundle record card list is invalid");
    }
    seenCards.add(key2);
  }
}
function assertPublicArtifactBundle(value) {
  if (!plainObject4(value) || Object.keys(value).some((key2) => ![
    "schemaVersion",
    "pages",
    "posts",
    "programs",
    "events",
    "recordCards",
    "authors",
    "settings",
    "receipt",
    "homeSources",
    "programImageDescriptors"
  ].includes(key2)) || !["schemaVersion", "pages", "posts", "programs", "authors", "settings", "receipt"].every(
    (field) => Object.hasOwn(value, field)
  ) || value.schemaVersion !== PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION) {
    throw new Error("The public artifact bundle is invalid");
  }
  assertArray(value.pages, "Page");
  assertArray(value.posts, "Post");
  assertArray(value.programs, "Program");
  for (const [label, records] of [["Page", value.pages], ["Post", value.posts]]) {
    for (const record3 of records) {
      const hasDataFigure = Array.isArray(record3.blocks) && record3.blocks.some((block) => plainObject4(block) && block.type === "data_figure");
      if (record3.datasetFigures === void 0 && !hasDataFigure) continue;
      const parsed = parseBlocks(record3.blocks);
      if (!parsed.ok) throw new Error(`The public artifact bundle ${label} blocks are invalid`);
      projectDatasetFigures(
        record3.datasetFigures,
        parsed.blocks,
        `public artifact ${label.toLowerCase()} ${String(record3.pageId ?? record3.postId ?? "unknown")}`
      );
    }
  }
  if (value.recordCards !== void 0) assertRecordCards(value.recordCards);
  if (Array.isArray(value.recordCards)) {
    for (const card of value.recordCards) {
      if (card.kind === "program" && card.program !== void 0) {
        const source2 = value.programs.find((program2) => program2.programId === card.id);
        if (!source2 || !(0, import_node_util3.isDeepStrictEqual)(card.program, programCardData(source2))) {
          throw new Error("The public artifact bundle record card list is invalid");
        }
      }
      if (card.kind === "event" && card.event !== void 0) {
        const source2 = (Array.isArray(value.events) ? value.events : []).find((event) => event.eventId === card.id);
        if (!source2 || !(0, import_node_util3.isDeepStrictEqual)(card.event, eventCardData(source2))) {
          throw new Error("The public artifact bundle record card list is invalid");
        }
      }
    }
  }
  if (value.events !== void 0) assertArray(value.events, "Event");
  assertArray(value.authors, "author");
  assertArray(value.settings, "settings");
  for (const page of value.pages) {
    const serviceError = serviceCompositionError(String(page.pageId), page.serviceCompositionVersion);
    if (serviceError) throw new Error(serviceError);
    if (page.homeCompositionVersion === void 0) continue;
    const parsed = parseBlocks(page.blocks);
    if (!parsed.ok) throw new Error(`The public Home composition blocks are invalid: ${parsed.error}`);
    const error = homeCompositionError(String(page.pageId), page.homeCompositionVersion, parsed.blocks);
    if (error) throw new Error(error);
  }
  const settingIds = value.settings.map((setting) => setting.settingId);
  if (value.settings.length > 6 || new Set(settingIds).size !== settingIds.length) {
    throw new Error("The public artifact bundle settings list is invalid");
  }
  for (const setting of value.settings) {
    if (setting.settingId === STORY_CTAS_SETTINGS_ID) {
      if (!isStoryCtasBuildData(setting)) throw new Error("The story CTA settings are invalid");
      continue;
    }
    if (setting.settingId === COVERAGE_LABELS_SETTINGS_ID) {
      if (!isCoverageLabelsBuildData(setting)) throw new Error("The coverage label settings are invalid");
      continue;
    }
    if (setting.settingId === NJ_DECIDES_SETTINGS_ID) {
      if (!isNjDecidesBuildData(setting)) throw new Error("The NJ Decides settings are invalid");
      continue;
    }
    if (setting.settingId === SITE_NAVIGATION_SETTINGS_ID) {
      assertSiteNavigationSetting(setting);
      continue;
    }
    if (setting.settingId === PUBLIC_SITE_CHROME_SETTINGS_ID) {
      assertPublicSiteChromeSetting(setting);
      continue;
    }
    const allowed = /* @__PURE__ */ new Set([
      "settingId",
      "enabled",
      "message",
      "link",
      "secondLink",
      "njDecides",
      "liveLabel",
      "startsAt",
      "endsAt",
      "excludedPaths",
      "sourceVersion",
      "publishedAt"
    ]);
    const parsedAt = typeof setting.publishedAt === "string" ? new Date(setting.publishedAt) : null;
    if (Object.keys(setting).some((field) => !allowed.has(field)) || !Object.hasOwn(setting, "settingId") || !Object.hasOwn(setting, "enabled") || !Object.hasOwn(setting, "message") || !Object.hasOwn(setting, "sourceVersion") || !Object.hasOwn(setting, "publishedAt") || setting.settingId !== PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID || typeof setting.enabled !== "boolean" || typeof setting.message !== "string" || setting.njDecides !== true && setting.message.trim() === "" || !Number.isSafeInteger(setting.sourceVersion) || Number(setting.sourceVersion) < 1 || !parsedAt || Number.isNaN(parsedAt.getTime()) || parsedAt.toISOString() !== setting.publishedAt || setting.link !== void 0 && (!plainObject4(setting.link) || Object.keys(setting.link).length !== 2 || typeof setting.link.label !== "string" || setting.link.label.trim() === "" || typeof setting.link.href !== "string") || setting.secondLink !== void 0 && (!plainObject4(setting.secondLink) || Object.keys(setting.secondLink).length !== 2 || typeof setting.secondLink.label !== "string" || setting.secondLink.label.trim() === "" || typeof setting.secondLink.href !== "string")) {
      throw new Error("The public artifact bundle settings list is invalid");
    }
    const schema = cmsSettingsSchemaFor(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, 4);
    const settingsError = schema ? validateCmsSettingsValues(schema, {
      enabled: setting.enabled,
      message: setting.message,
      ...setting.njDecides !== void 0 ? { njDecides: setting.njDecides } : {},
      ...setting.liveLabel !== void 0 ? { liveLabel: setting.liveLabel } : {},
      ...setting.startsAt !== void 0 ? { startsAt: setting.startsAt } : {},
      ...setting.endsAt !== void 0 ? { endsAt: setting.endsAt } : {},
      ...setting.excludedPaths !== void 0 ? { excludedPaths: setting.excludedPaths } : {},
      ...setting.secondLink ? { secondLinkLabel: setting.secondLink.label, secondLinkHref: setting.secondLink.href } : {},
      ...setting.link ? {
        linkLabel: setting.link.label,
        linkHref: setting.link.href
      } : {}
    }) : "The public homepage banner settings schema is missing";
    if (settingsError) {
      throw new Error(`The public artifact bundle settings list is invalid: ${settingsError}`);
    }
  }
  const receipt = assertPublicArtifactInventoryReceipt(value.receipt);
  for (const setting of value.settings) if (isNjDecidesBuildData(setting)) {
    const owner = receipt.owners.find((row) => row.collection === "cmsSettings" && row.documentId === NJ_DECIDES_SETTINGS_ID);
    if (!owner || !(0, import_node_util3.isDeepStrictEqual)(owner.assetIds, Object.keys(setting.assets).sort())) {
      throw new Error("The NJ Decides image inventory differs from its rendered assets");
    }
  }
  const homeSources = value.homeSources === void 0 ? void 0 : assertHomeSourcePublication(
    value.homeSources,
    receipt
  );
  const familyVersions = new Map(
    receipt.families.map((family) => [
      family.collection,
      new Map(family.artifacts.map((artifact) => [artifact.documentId, artifact]))
    ])
  );
  const exactVersions = (collection, entries) => {
    const expected = familyVersions.get(collection);
    if (!expected || expected.size !== entries.length) {
      throw new Error(`The public artifact bundle ${collection} coverage is incomplete`);
    }
    const seen = /* @__PURE__ */ new Set();
    for (const entry2 of entries) {
      const id2 = entry2.id;
      const artifact = typeof id2 === "string" ? expected.get(id2) : void 0;
      if (typeof id2 !== "string" || seen.has(id2) || !artifact || artifact.sourceVersion !== entry2.sourceVersion || artifact.canonicalPath !== entry2.canonicalPath || !(0, import_node_util3.isDeepStrictEqual)(
        artifact.aliases,
        Array.isArray(entry2.aliases) ? [...entry2.aliases].sort() : null
      )) {
        throw new Error(`The public artifact bundle ${collection} coverage is invalid`);
      }
      seen.add(id2);
    }
  };
  exactVersions("cmsPages", value.pages.map((entry2) => {
    const definition = typeof entry2.pageId === "string" ? publicPage(entry2.pageId) : void 0;
    const previous = entry2.previousSlugs ?? [];
    const validPrevious = definition && Array.isArray(previous) && previous.every((slug) => isAvailablePageSlug(definition.id, slug));
    const canonicalPath = definition && isPublicPagePath(definition.id, entry2.path) ? entry2.path : null;
    return {
      id: entry2.pageId,
      sourceVersion: entry2.sourceVersion,
      canonicalPath,
      aliases: definition && canonicalPath && validPrevious ? publicPageAliases(definition, canonicalPath, previous) : null
    };
  }));
  exactVersions("cmsPosts", [
    ...value.posts.map((entry2) => ({
      id: entry2.postId,
      sourceVersion: entry2.sourceVersion,
      canonicalPath: projectedCanonicalPath(entry2.path, entry2.slug, postPublicPath),
      aliases: projectedAliases(entry2.previousSlugs, postPublicPath)
    })),
    ...(value.events ?? []).map((entry2) => ({
      id: entry2.eventId,
      sourceVersion: entry2.sourceVersion,
      canonicalPath: projectedCanonicalPath(entry2.path, entry2.slug, eventPublicPath),
      aliases: projectedAliases(entry2.previousSlugs, eventPublicPath)
    })),
    ...value.programs.map((entry2) => ({
      id: entry2.programId,
      sourceVersion: entry2.sourceVersion,
      canonicalPath: projectedCanonicalPath(entry2.path, entry2.slug, programPublicPath),
      aliases: projectedAliases(entry2.previousSlugs, programPublicPath)
    })),
    ...(value.recordCards ?? []).flatMap((card) => {
      if (card.kind !== "sponsor" && card.kind !== "newsletter" || card.sourceVersion === void 0) return [];
      return [{ id: card.id, sourceVersion: card.sourceVersion, canonicalPath: null, aliases: [] }];
    })
  ]);
  exactVersions("cmsAuthorProfilesPublic", value.authors.map((entry2) => ({
    id: entry2.authorId,
    sourceVersion: entry2.sourceVersion,
    canonicalPath: projectedCanonicalPath(entry2.path, entry2.slug, authorPublicPath),
    aliases: projectedAliases(entry2.previousSlugs, authorPublicPath)
  })));
  exactVersions("cmsSettings", [
    ...value.settings.map((entry2) => ({
      id: entry2.settingId,
      sourceVersion: entry2.sourceVersion,
      canonicalPath: "/",
      aliases: []
    })),
    ...(receipt.settingsFallbacks ?? []).map((fallback) => ({
      id: fallback.documentId,
      sourceVersion: fallback.sourceVersion,
      canonicalPath: "/",
      aliases: []
    }))
  ]);
  const programImageDescriptors = value.programImageDescriptors === void 0 ? void 0 : assertProgramImageCatalog(value.programImageDescriptors, value.programs, {
    rendererSha: receipt.commitSha,
    buildBatchId: receipt.buildBatchId,
    generation: receipt.generation,
    mediaManifestDigest: receipt.mediaManifestDigest
  });
  for (const file of programImageDescriptors?.files ?? []) {
    if ((0, import_node_crypto5.createHash)("sha256").update(programImageBytes(file)).digest("hex") !== file.digest) {
      throw new ProgramImagePreparationError("program_image_integrity");
    }
  }
  return {
    schemaVersion: PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
    ...programImageDescriptors === void 0 ? {} : { programImageDescriptors },
    pages: value.pages,
    posts: value.posts,
    programs: value.programs,
    ...value.recordCards === void 0 ? {} : { recordCards: value.recordCards },
    ...value.events === void 0 ? {} : { events: value.events },
    authors: value.authors,
    settings: value.settings,
    receipt,
    ...homeSources === void 0 ? {} : { homeSources }
  };
}
function normalizePublicArtifactBundle(value) {
  if (plainObject4(value) && Array.isArray(value.programs) && plainObject4(value.receipt)) {
    const oldPrograms = value.programs.filter((program2) => plainObject4(program2) && typeof program2.slug === "string" && program2.path === `/shows/${program2.slug}/`);
    if (oldPrograms.length > 0) {
      const oldIds = new Set(oldPrograms.map((program2) => program2.programId));
      value.programs = value.programs.map((program2) => plainObject4(program2) && oldIds.has(program2.programId) ? { ...program2, path: programPublicPath(String(program2.slug)) } : program2);
      if (Array.isArray(value.receipt.families)) {
        value.receipt = { ...value.receipt, families: value.receipt.families.map((family) => plainObject4(family) && family.collection === "cmsPosts" && Array.isArray(family.artifacts) ? { ...family, artifacts: family.artifacts.map((artifact) => plainObject4(artifact) && oldIds.has(artifact.documentId) ? {
          ...artifact,
          canonicalPath: typeof artifact.canonicalPath === "string" ? artifact.canonicalPath.replace(/^\/shows\//, "/programs/") : artifact.canonicalPath,
          aliases: Array.isArray(artifact.aliases) ? artifact.aliases.map((alias) => typeof alias === "string" ? alias.replace(/^\/shows\//, "/programs/") : alias) : artifact.aliases
        } : artifact) } : family) };
      }
    }
    value.programs = value.programs.map((program2) => plainObject4(program2) ? {
      ...program2,
      keyArt: program2.keyArt ?? null,
      keyArtAlt: program2.keyArtAlt ?? "",
      keyArtDecorative: program2.keyArtDecorative ?? false,
      watchUrl: program2.watchUrl ?? null
    } : program2);
    const receipt = value.receipt;
    if ((0, import_node_util3.isDeepStrictEqual)(receipt.aggregateRoutes, ["/posts/", "/staff/"]) || (0, import_node_util3.isDeepStrictEqual)(receipt.aggregateRoutes, ["/posts/", "/programs/", "/staff/"])) {
      value.receipt = { ...receipt, aggregateRoutes: ["/posts/", "/programs/", "/events/", "/staff/"] };
    }
  }
  const bundle = assertPublicArtifactBundle(value);
  const { programImageDescriptors: _privateProgramImages, ...legacy } = bundle;
  return legacy;
}

// site/node_modules/parse5/dist/common/unicode.js
var CODE_POINTS;
(function(CODE_POINTS2) {
  CODE_POINTS2[CODE_POINTS2["EOF"] = -1] = "EOF";
  CODE_POINTS2[CODE_POINTS2["NULL"] = 0] = "NULL";
  CODE_POINTS2[CODE_POINTS2["TABULATION"] = 9] = "TABULATION";
  CODE_POINTS2[CODE_POINTS2["CARRIAGE_RETURN"] = 13] = "CARRIAGE_RETURN";
  CODE_POINTS2[CODE_POINTS2["LINE_FEED"] = 10] = "LINE_FEED";
  CODE_POINTS2[CODE_POINTS2["FORM_FEED"] = 12] = "FORM_FEED";
  CODE_POINTS2[CODE_POINTS2["SPACE"] = 32] = "SPACE";
  CODE_POINTS2[CODE_POINTS2["EXCLAMATION_MARK"] = 33] = "EXCLAMATION_MARK";
  CODE_POINTS2[CODE_POINTS2["QUOTATION_MARK"] = 34] = "QUOTATION_MARK";
  CODE_POINTS2[CODE_POINTS2["AMPERSAND"] = 38] = "AMPERSAND";
  CODE_POINTS2[CODE_POINTS2["APOSTROPHE"] = 39] = "APOSTROPHE";
  CODE_POINTS2[CODE_POINTS2["HYPHEN_MINUS"] = 45] = "HYPHEN_MINUS";
  CODE_POINTS2[CODE_POINTS2["SOLIDUS"] = 47] = "SOLIDUS";
  CODE_POINTS2[CODE_POINTS2["DIGIT_0"] = 48] = "DIGIT_0";
  CODE_POINTS2[CODE_POINTS2["DIGIT_9"] = 57] = "DIGIT_9";
  CODE_POINTS2[CODE_POINTS2["SEMICOLON"] = 59] = "SEMICOLON";
  CODE_POINTS2[CODE_POINTS2["LESS_THAN_SIGN"] = 60] = "LESS_THAN_SIGN";
  CODE_POINTS2[CODE_POINTS2["EQUALS_SIGN"] = 61] = "EQUALS_SIGN";
  CODE_POINTS2[CODE_POINTS2["GREATER_THAN_SIGN"] = 62] = "GREATER_THAN_SIGN";
  CODE_POINTS2[CODE_POINTS2["QUESTION_MARK"] = 63] = "QUESTION_MARK";
  CODE_POINTS2[CODE_POINTS2["LATIN_CAPITAL_A"] = 65] = "LATIN_CAPITAL_A";
  CODE_POINTS2[CODE_POINTS2["LATIN_CAPITAL_Z"] = 90] = "LATIN_CAPITAL_Z";
  CODE_POINTS2[CODE_POINTS2["RIGHT_SQUARE_BRACKET"] = 93] = "RIGHT_SQUARE_BRACKET";
  CODE_POINTS2[CODE_POINTS2["GRAVE_ACCENT"] = 96] = "GRAVE_ACCENT";
  CODE_POINTS2[CODE_POINTS2["LATIN_SMALL_A"] = 97] = "LATIN_SMALL_A";
  CODE_POINTS2[CODE_POINTS2["LATIN_SMALL_Z"] = 122] = "LATIN_SMALL_Z";
})(CODE_POINTS || (CODE_POINTS = {}));

// site/node_modules/parse5/dist/common/error-codes.js
var ERR;
(function(ERR2) {
  ERR2["controlCharacterInInputStream"] = "control-character-in-input-stream";
  ERR2["noncharacterInInputStream"] = "noncharacter-in-input-stream";
  ERR2["surrogateInInputStream"] = "surrogate-in-input-stream";
  ERR2["nonVoidHtmlElementStartTagWithTrailingSolidus"] = "non-void-html-element-start-tag-with-trailing-solidus";
  ERR2["endTagWithAttributes"] = "end-tag-with-attributes";
  ERR2["endTagWithTrailingSolidus"] = "end-tag-with-trailing-solidus";
  ERR2["unexpectedSolidusInTag"] = "unexpected-solidus-in-tag";
  ERR2["unexpectedNullCharacter"] = "unexpected-null-character";
  ERR2["unexpectedQuestionMarkInsteadOfTagName"] = "unexpected-question-mark-instead-of-tag-name";
  ERR2["invalidFirstCharacterOfTagName"] = "invalid-first-character-of-tag-name";
  ERR2["unexpectedEqualsSignBeforeAttributeName"] = "unexpected-equals-sign-before-attribute-name";
  ERR2["missingEndTagName"] = "missing-end-tag-name";
  ERR2["unexpectedCharacterInAttributeName"] = "unexpected-character-in-attribute-name";
  ERR2["unknownNamedCharacterReference"] = "unknown-named-character-reference";
  ERR2["missingSemicolonAfterCharacterReference"] = "missing-semicolon-after-character-reference";
  ERR2["unexpectedCharacterAfterDoctypeSystemIdentifier"] = "unexpected-character-after-doctype-system-identifier";
  ERR2["unexpectedCharacterInUnquotedAttributeValue"] = "unexpected-character-in-unquoted-attribute-value";
  ERR2["eofBeforeTagName"] = "eof-before-tag-name";
  ERR2["eofInTag"] = "eof-in-tag";
  ERR2["missingAttributeValue"] = "missing-attribute-value";
  ERR2["missingWhitespaceBetweenAttributes"] = "missing-whitespace-between-attributes";
  ERR2["missingWhitespaceAfterDoctypePublicKeyword"] = "missing-whitespace-after-doctype-public-keyword";
  ERR2["missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers"] = "missing-whitespace-between-doctype-public-and-system-identifiers";
  ERR2["missingWhitespaceAfterDoctypeSystemKeyword"] = "missing-whitespace-after-doctype-system-keyword";
  ERR2["missingQuoteBeforeDoctypePublicIdentifier"] = "missing-quote-before-doctype-public-identifier";
  ERR2["missingQuoteBeforeDoctypeSystemIdentifier"] = "missing-quote-before-doctype-system-identifier";
  ERR2["missingDoctypePublicIdentifier"] = "missing-doctype-public-identifier";
  ERR2["missingDoctypeSystemIdentifier"] = "missing-doctype-system-identifier";
  ERR2["abruptDoctypePublicIdentifier"] = "abrupt-doctype-public-identifier";
  ERR2["abruptDoctypeSystemIdentifier"] = "abrupt-doctype-system-identifier";
  ERR2["cdataInHtmlContent"] = "cdata-in-html-content";
  ERR2["incorrectlyOpenedComment"] = "incorrectly-opened-comment";
  ERR2["eofInScriptHtmlCommentLikeText"] = "eof-in-script-html-comment-like-text";
  ERR2["eofInDoctype"] = "eof-in-doctype";
  ERR2["nestedComment"] = "nested-comment";
  ERR2["abruptClosingOfEmptyComment"] = "abrupt-closing-of-empty-comment";
  ERR2["eofInComment"] = "eof-in-comment";
  ERR2["incorrectlyClosedComment"] = "incorrectly-closed-comment";
  ERR2["eofInCdata"] = "eof-in-cdata";
  ERR2["absenceOfDigitsInNumericCharacterReference"] = "absence-of-digits-in-numeric-character-reference";
  ERR2["nullCharacterReference"] = "null-character-reference";
  ERR2["surrogateCharacterReference"] = "surrogate-character-reference";
  ERR2["characterReferenceOutsideUnicodeRange"] = "character-reference-outside-unicode-range";
  ERR2["controlCharacterReference"] = "control-character-reference";
  ERR2["noncharacterCharacterReference"] = "noncharacter-character-reference";
  ERR2["missingWhitespaceBeforeDoctypeName"] = "missing-whitespace-before-doctype-name";
  ERR2["missingDoctypeName"] = "missing-doctype-name";
  ERR2["invalidCharacterSequenceAfterDoctypeName"] = "invalid-character-sequence-after-doctype-name";
  ERR2["duplicateAttribute"] = "duplicate-attribute";
  ERR2["nonConformingDoctype"] = "non-conforming-doctype";
  ERR2["missingDoctype"] = "missing-doctype";
  ERR2["misplacedDoctype"] = "misplaced-doctype";
  ERR2["endTagWithoutMatchingOpenElement"] = "end-tag-without-matching-open-element";
  ERR2["closingOfElementWithOpenChildElements"] = "closing-of-element-with-open-child-elements";
  ERR2["disallowedContentInNoscriptInHead"] = "disallowed-content-in-noscript-in-head";
  ERR2["openElementsLeftAfterEof"] = "open-elements-left-after-eof";
  ERR2["abandonedHeadElementChild"] = "abandoned-head-element-child";
  ERR2["misplacedStartTagForHeadElement"] = "misplaced-start-tag-for-head-element";
  ERR2["nestedNoscriptInHead"] = "nested-noscript-in-head";
  ERR2["eofInElementThatCanContainOnlyText"] = "eof-in-element-that-can-contain-only-text";
})(ERR || (ERR = {}));

// site/node_modules/parse5/dist/tokenizer/preprocessor.js
var DEFAULT_BUFFER_WATERLINE = 1 << 16;

// site/node_modules/parse5/dist/common/token.js
var TokenType;
(function(TokenType2) {
  TokenType2[TokenType2["CHARACTER"] = 0] = "CHARACTER";
  TokenType2[TokenType2["NULL_CHARACTER"] = 1] = "NULL_CHARACTER";
  TokenType2[TokenType2["WHITESPACE_CHARACTER"] = 2] = "WHITESPACE_CHARACTER";
  TokenType2[TokenType2["START_TAG"] = 3] = "START_TAG";
  TokenType2[TokenType2["END_TAG"] = 4] = "END_TAG";
  TokenType2[TokenType2["COMMENT"] = 5] = "COMMENT";
  TokenType2[TokenType2["DOCTYPE"] = 6] = "DOCTYPE";
  TokenType2[TokenType2["EOF"] = 7] = "EOF";
  TokenType2[TokenType2["HIBERNATION"] = 8] = "HIBERNATION";
})(TokenType || (TokenType = {}));

// site/node_modules/entities/dist/esm/decode-codepoint.js
var _a;
var fromCodePoint = (
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, n/no-unsupported-features/es-builtins
  (_a = String.fromCodePoint) !== null && _a !== void 0 ? _a : function(codePoint) {
    let output = "";
    if (codePoint > 65535) {
      codePoint -= 65536;
      output += String.fromCharCode(codePoint >>> 10 & 1023 | 55296);
      codePoint = 56320 | codePoint & 1023;
    }
    output += String.fromCharCode(codePoint);
    return output;
  }
);

// site/node_modules/entities/dist/esm/decode.js
var CharCodes;
(function(CharCodes2) {
  CharCodes2[CharCodes2["NUM"] = 35] = "NUM";
  CharCodes2[CharCodes2["SEMI"] = 59] = "SEMI";
  CharCodes2[CharCodes2["EQUALS"] = 61] = "EQUALS";
  CharCodes2[CharCodes2["ZERO"] = 48] = "ZERO";
  CharCodes2[CharCodes2["NINE"] = 57] = "NINE";
  CharCodes2[CharCodes2["LOWER_A"] = 97] = "LOWER_A";
  CharCodes2[CharCodes2["LOWER_F"] = 102] = "LOWER_F";
  CharCodes2[CharCodes2["LOWER_X"] = 120] = "LOWER_X";
  CharCodes2[CharCodes2["LOWER_Z"] = 122] = "LOWER_Z";
  CharCodes2[CharCodes2["UPPER_A"] = 65] = "UPPER_A";
  CharCodes2[CharCodes2["UPPER_F"] = 70] = "UPPER_F";
  CharCodes2[CharCodes2["UPPER_Z"] = 90] = "UPPER_Z";
})(CharCodes || (CharCodes = {}));
var BinTrieFlags;
(function(BinTrieFlags2) {
  BinTrieFlags2[BinTrieFlags2["VALUE_LENGTH"] = 49152] = "VALUE_LENGTH";
  BinTrieFlags2[BinTrieFlags2["BRANCH_LENGTH"] = 16256] = "BRANCH_LENGTH";
  BinTrieFlags2[BinTrieFlags2["JUMP_TABLE"] = 127] = "JUMP_TABLE";
})(BinTrieFlags || (BinTrieFlags = {}));
var EntityDecoderState;
(function(EntityDecoderState2) {
  EntityDecoderState2[EntityDecoderState2["EntityStart"] = 0] = "EntityStart";
  EntityDecoderState2[EntityDecoderState2["NumericStart"] = 1] = "NumericStart";
  EntityDecoderState2[EntityDecoderState2["NumericDecimal"] = 2] = "NumericDecimal";
  EntityDecoderState2[EntityDecoderState2["NumericHex"] = 3] = "NumericHex";
  EntityDecoderState2[EntityDecoderState2["NamedEntity"] = 4] = "NamedEntity";
})(EntityDecoderState || (EntityDecoderState = {}));
var DecodingMode;
(function(DecodingMode2) {
  DecodingMode2[DecodingMode2["Legacy"] = 0] = "Legacy";
  DecodingMode2[DecodingMode2["Strict"] = 1] = "Strict";
  DecodingMode2[DecodingMode2["Attribute"] = 2] = "Attribute";
})(DecodingMode || (DecodingMode = {}));

// site/node_modules/parse5/dist/common/html.js
var NS;
(function(NS2) {
  NS2["HTML"] = "http://www.w3.org/1999/xhtml";
  NS2["MATHML"] = "http://www.w3.org/1998/Math/MathML";
  NS2["SVG"] = "http://www.w3.org/2000/svg";
  NS2["XLINK"] = "http://www.w3.org/1999/xlink";
  NS2["XML"] = "http://www.w3.org/XML/1998/namespace";
  NS2["XMLNS"] = "http://www.w3.org/2000/xmlns/";
})(NS || (NS = {}));
var ATTRS;
(function(ATTRS2) {
  ATTRS2["TYPE"] = "type";
  ATTRS2["ACTION"] = "action";
  ATTRS2["ENCODING"] = "encoding";
  ATTRS2["PROMPT"] = "prompt";
  ATTRS2["NAME"] = "name";
  ATTRS2["COLOR"] = "color";
  ATTRS2["FACE"] = "face";
  ATTRS2["SIZE"] = "size";
})(ATTRS || (ATTRS = {}));
var DOCUMENT_MODE;
(function(DOCUMENT_MODE2) {
  DOCUMENT_MODE2["NO_QUIRKS"] = "no-quirks";
  DOCUMENT_MODE2["QUIRKS"] = "quirks";
  DOCUMENT_MODE2["LIMITED_QUIRKS"] = "limited-quirks";
})(DOCUMENT_MODE || (DOCUMENT_MODE = {}));
var TAG_NAMES;
(function(TAG_NAMES2) {
  TAG_NAMES2["A"] = "a";
  TAG_NAMES2["ADDRESS"] = "address";
  TAG_NAMES2["ANNOTATION_XML"] = "annotation-xml";
  TAG_NAMES2["APPLET"] = "applet";
  TAG_NAMES2["AREA"] = "area";
  TAG_NAMES2["ARTICLE"] = "article";
  TAG_NAMES2["ASIDE"] = "aside";
  TAG_NAMES2["B"] = "b";
  TAG_NAMES2["BASE"] = "base";
  TAG_NAMES2["BASEFONT"] = "basefont";
  TAG_NAMES2["BGSOUND"] = "bgsound";
  TAG_NAMES2["BIG"] = "big";
  TAG_NAMES2["BLOCKQUOTE"] = "blockquote";
  TAG_NAMES2["BODY"] = "body";
  TAG_NAMES2["BR"] = "br";
  TAG_NAMES2["BUTTON"] = "button";
  TAG_NAMES2["CAPTION"] = "caption";
  TAG_NAMES2["CENTER"] = "center";
  TAG_NAMES2["CODE"] = "code";
  TAG_NAMES2["COL"] = "col";
  TAG_NAMES2["COLGROUP"] = "colgroup";
  TAG_NAMES2["DD"] = "dd";
  TAG_NAMES2["DESC"] = "desc";
  TAG_NAMES2["DETAILS"] = "details";
  TAG_NAMES2["DIALOG"] = "dialog";
  TAG_NAMES2["DIR"] = "dir";
  TAG_NAMES2["DIV"] = "div";
  TAG_NAMES2["DL"] = "dl";
  TAG_NAMES2["DT"] = "dt";
  TAG_NAMES2["EM"] = "em";
  TAG_NAMES2["EMBED"] = "embed";
  TAG_NAMES2["FIELDSET"] = "fieldset";
  TAG_NAMES2["FIGCAPTION"] = "figcaption";
  TAG_NAMES2["FIGURE"] = "figure";
  TAG_NAMES2["FONT"] = "font";
  TAG_NAMES2["FOOTER"] = "footer";
  TAG_NAMES2["FOREIGN_OBJECT"] = "foreignObject";
  TAG_NAMES2["FORM"] = "form";
  TAG_NAMES2["FRAME"] = "frame";
  TAG_NAMES2["FRAMESET"] = "frameset";
  TAG_NAMES2["H1"] = "h1";
  TAG_NAMES2["H2"] = "h2";
  TAG_NAMES2["H3"] = "h3";
  TAG_NAMES2["H4"] = "h4";
  TAG_NAMES2["H5"] = "h5";
  TAG_NAMES2["H6"] = "h6";
  TAG_NAMES2["HEAD"] = "head";
  TAG_NAMES2["HEADER"] = "header";
  TAG_NAMES2["HGROUP"] = "hgroup";
  TAG_NAMES2["HR"] = "hr";
  TAG_NAMES2["HTML"] = "html";
  TAG_NAMES2["I"] = "i";
  TAG_NAMES2["IMG"] = "img";
  TAG_NAMES2["IMAGE"] = "image";
  TAG_NAMES2["INPUT"] = "input";
  TAG_NAMES2["IFRAME"] = "iframe";
  TAG_NAMES2["KEYGEN"] = "keygen";
  TAG_NAMES2["LABEL"] = "label";
  TAG_NAMES2["LI"] = "li";
  TAG_NAMES2["LINK"] = "link";
  TAG_NAMES2["LISTING"] = "listing";
  TAG_NAMES2["MAIN"] = "main";
  TAG_NAMES2["MALIGNMARK"] = "malignmark";
  TAG_NAMES2["MARQUEE"] = "marquee";
  TAG_NAMES2["MATH"] = "math";
  TAG_NAMES2["MENU"] = "menu";
  TAG_NAMES2["META"] = "meta";
  TAG_NAMES2["MGLYPH"] = "mglyph";
  TAG_NAMES2["MI"] = "mi";
  TAG_NAMES2["MO"] = "mo";
  TAG_NAMES2["MN"] = "mn";
  TAG_NAMES2["MS"] = "ms";
  TAG_NAMES2["MTEXT"] = "mtext";
  TAG_NAMES2["NAV"] = "nav";
  TAG_NAMES2["NOBR"] = "nobr";
  TAG_NAMES2["NOFRAMES"] = "noframes";
  TAG_NAMES2["NOEMBED"] = "noembed";
  TAG_NAMES2["NOSCRIPT"] = "noscript";
  TAG_NAMES2["OBJECT"] = "object";
  TAG_NAMES2["OL"] = "ol";
  TAG_NAMES2["OPTGROUP"] = "optgroup";
  TAG_NAMES2["OPTION"] = "option";
  TAG_NAMES2["P"] = "p";
  TAG_NAMES2["PARAM"] = "param";
  TAG_NAMES2["PLAINTEXT"] = "plaintext";
  TAG_NAMES2["PRE"] = "pre";
  TAG_NAMES2["RB"] = "rb";
  TAG_NAMES2["RP"] = "rp";
  TAG_NAMES2["RT"] = "rt";
  TAG_NAMES2["RTC"] = "rtc";
  TAG_NAMES2["RUBY"] = "ruby";
  TAG_NAMES2["S"] = "s";
  TAG_NAMES2["SCRIPT"] = "script";
  TAG_NAMES2["SEARCH"] = "search";
  TAG_NAMES2["SECTION"] = "section";
  TAG_NAMES2["SELECT"] = "select";
  TAG_NAMES2["SOURCE"] = "source";
  TAG_NAMES2["SMALL"] = "small";
  TAG_NAMES2["SPAN"] = "span";
  TAG_NAMES2["STRIKE"] = "strike";
  TAG_NAMES2["STRONG"] = "strong";
  TAG_NAMES2["STYLE"] = "style";
  TAG_NAMES2["SUB"] = "sub";
  TAG_NAMES2["SUMMARY"] = "summary";
  TAG_NAMES2["SUP"] = "sup";
  TAG_NAMES2["TABLE"] = "table";
  TAG_NAMES2["TBODY"] = "tbody";
  TAG_NAMES2["TEMPLATE"] = "template";
  TAG_NAMES2["TEXTAREA"] = "textarea";
  TAG_NAMES2["TFOOT"] = "tfoot";
  TAG_NAMES2["TD"] = "td";
  TAG_NAMES2["TH"] = "th";
  TAG_NAMES2["THEAD"] = "thead";
  TAG_NAMES2["TITLE"] = "title";
  TAG_NAMES2["TR"] = "tr";
  TAG_NAMES2["TRACK"] = "track";
  TAG_NAMES2["TT"] = "tt";
  TAG_NAMES2["U"] = "u";
  TAG_NAMES2["UL"] = "ul";
  TAG_NAMES2["SVG"] = "svg";
  TAG_NAMES2["VAR"] = "var";
  TAG_NAMES2["WBR"] = "wbr";
  TAG_NAMES2["XMP"] = "xmp";
})(TAG_NAMES || (TAG_NAMES = {}));
var TAG_ID;
(function(TAG_ID2) {
  TAG_ID2[TAG_ID2["UNKNOWN"] = 0] = "UNKNOWN";
  TAG_ID2[TAG_ID2["A"] = 1] = "A";
  TAG_ID2[TAG_ID2["ADDRESS"] = 2] = "ADDRESS";
  TAG_ID2[TAG_ID2["ANNOTATION_XML"] = 3] = "ANNOTATION_XML";
  TAG_ID2[TAG_ID2["APPLET"] = 4] = "APPLET";
  TAG_ID2[TAG_ID2["AREA"] = 5] = "AREA";
  TAG_ID2[TAG_ID2["ARTICLE"] = 6] = "ARTICLE";
  TAG_ID2[TAG_ID2["ASIDE"] = 7] = "ASIDE";
  TAG_ID2[TAG_ID2["B"] = 8] = "B";
  TAG_ID2[TAG_ID2["BASE"] = 9] = "BASE";
  TAG_ID2[TAG_ID2["BASEFONT"] = 10] = "BASEFONT";
  TAG_ID2[TAG_ID2["BGSOUND"] = 11] = "BGSOUND";
  TAG_ID2[TAG_ID2["BIG"] = 12] = "BIG";
  TAG_ID2[TAG_ID2["BLOCKQUOTE"] = 13] = "BLOCKQUOTE";
  TAG_ID2[TAG_ID2["BODY"] = 14] = "BODY";
  TAG_ID2[TAG_ID2["BR"] = 15] = "BR";
  TAG_ID2[TAG_ID2["BUTTON"] = 16] = "BUTTON";
  TAG_ID2[TAG_ID2["CAPTION"] = 17] = "CAPTION";
  TAG_ID2[TAG_ID2["CENTER"] = 18] = "CENTER";
  TAG_ID2[TAG_ID2["CODE"] = 19] = "CODE";
  TAG_ID2[TAG_ID2["COL"] = 20] = "COL";
  TAG_ID2[TAG_ID2["COLGROUP"] = 21] = "COLGROUP";
  TAG_ID2[TAG_ID2["DD"] = 22] = "DD";
  TAG_ID2[TAG_ID2["DESC"] = 23] = "DESC";
  TAG_ID2[TAG_ID2["DETAILS"] = 24] = "DETAILS";
  TAG_ID2[TAG_ID2["DIALOG"] = 25] = "DIALOG";
  TAG_ID2[TAG_ID2["DIR"] = 26] = "DIR";
  TAG_ID2[TAG_ID2["DIV"] = 27] = "DIV";
  TAG_ID2[TAG_ID2["DL"] = 28] = "DL";
  TAG_ID2[TAG_ID2["DT"] = 29] = "DT";
  TAG_ID2[TAG_ID2["EM"] = 30] = "EM";
  TAG_ID2[TAG_ID2["EMBED"] = 31] = "EMBED";
  TAG_ID2[TAG_ID2["FIELDSET"] = 32] = "FIELDSET";
  TAG_ID2[TAG_ID2["FIGCAPTION"] = 33] = "FIGCAPTION";
  TAG_ID2[TAG_ID2["FIGURE"] = 34] = "FIGURE";
  TAG_ID2[TAG_ID2["FONT"] = 35] = "FONT";
  TAG_ID2[TAG_ID2["FOOTER"] = 36] = "FOOTER";
  TAG_ID2[TAG_ID2["FOREIGN_OBJECT"] = 37] = "FOREIGN_OBJECT";
  TAG_ID2[TAG_ID2["FORM"] = 38] = "FORM";
  TAG_ID2[TAG_ID2["FRAME"] = 39] = "FRAME";
  TAG_ID2[TAG_ID2["FRAMESET"] = 40] = "FRAMESET";
  TAG_ID2[TAG_ID2["H1"] = 41] = "H1";
  TAG_ID2[TAG_ID2["H2"] = 42] = "H2";
  TAG_ID2[TAG_ID2["H3"] = 43] = "H3";
  TAG_ID2[TAG_ID2["H4"] = 44] = "H4";
  TAG_ID2[TAG_ID2["H5"] = 45] = "H5";
  TAG_ID2[TAG_ID2["H6"] = 46] = "H6";
  TAG_ID2[TAG_ID2["HEAD"] = 47] = "HEAD";
  TAG_ID2[TAG_ID2["HEADER"] = 48] = "HEADER";
  TAG_ID2[TAG_ID2["HGROUP"] = 49] = "HGROUP";
  TAG_ID2[TAG_ID2["HR"] = 50] = "HR";
  TAG_ID2[TAG_ID2["HTML"] = 51] = "HTML";
  TAG_ID2[TAG_ID2["I"] = 52] = "I";
  TAG_ID2[TAG_ID2["IMG"] = 53] = "IMG";
  TAG_ID2[TAG_ID2["IMAGE"] = 54] = "IMAGE";
  TAG_ID2[TAG_ID2["INPUT"] = 55] = "INPUT";
  TAG_ID2[TAG_ID2["IFRAME"] = 56] = "IFRAME";
  TAG_ID2[TAG_ID2["KEYGEN"] = 57] = "KEYGEN";
  TAG_ID2[TAG_ID2["LABEL"] = 58] = "LABEL";
  TAG_ID2[TAG_ID2["LI"] = 59] = "LI";
  TAG_ID2[TAG_ID2["LINK"] = 60] = "LINK";
  TAG_ID2[TAG_ID2["LISTING"] = 61] = "LISTING";
  TAG_ID2[TAG_ID2["MAIN"] = 62] = "MAIN";
  TAG_ID2[TAG_ID2["MALIGNMARK"] = 63] = "MALIGNMARK";
  TAG_ID2[TAG_ID2["MARQUEE"] = 64] = "MARQUEE";
  TAG_ID2[TAG_ID2["MATH"] = 65] = "MATH";
  TAG_ID2[TAG_ID2["MENU"] = 66] = "MENU";
  TAG_ID2[TAG_ID2["META"] = 67] = "META";
  TAG_ID2[TAG_ID2["MGLYPH"] = 68] = "MGLYPH";
  TAG_ID2[TAG_ID2["MI"] = 69] = "MI";
  TAG_ID2[TAG_ID2["MO"] = 70] = "MO";
  TAG_ID2[TAG_ID2["MN"] = 71] = "MN";
  TAG_ID2[TAG_ID2["MS"] = 72] = "MS";
  TAG_ID2[TAG_ID2["MTEXT"] = 73] = "MTEXT";
  TAG_ID2[TAG_ID2["NAV"] = 74] = "NAV";
  TAG_ID2[TAG_ID2["NOBR"] = 75] = "NOBR";
  TAG_ID2[TAG_ID2["NOFRAMES"] = 76] = "NOFRAMES";
  TAG_ID2[TAG_ID2["NOEMBED"] = 77] = "NOEMBED";
  TAG_ID2[TAG_ID2["NOSCRIPT"] = 78] = "NOSCRIPT";
  TAG_ID2[TAG_ID2["OBJECT"] = 79] = "OBJECT";
  TAG_ID2[TAG_ID2["OL"] = 80] = "OL";
  TAG_ID2[TAG_ID2["OPTGROUP"] = 81] = "OPTGROUP";
  TAG_ID2[TAG_ID2["OPTION"] = 82] = "OPTION";
  TAG_ID2[TAG_ID2["P"] = 83] = "P";
  TAG_ID2[TAG_ID2["PARAM"] = 84] = "PARAM";
  TAG_ID2[TAG_ID2["PLAINTEXT"] = 85] = "PLAINTEXT";
  TAG_ID2[TAG_ID2["PRE"] = 86] = "PRE";
  TAG_ID2[TAG_ID2["RB"] = 87] = "RB";
  TAG_ID2[TAG_ID2["RP"] = 88] = "RP";
  TAG_ID2[TAG_ID2["RT"] = 89] = "RT";
  TAG_ID2[TAG_ID2["RTC"] = 90] = "RTC";
  TAG_ID2[TAG_ID2["RUBY"] = 91] = "RUBY";
  TAG_ID2[TAG_ID2["S"] = 92] = "S";
  TAG_ID2[TAG_ID2["SCRIPT"] = 93] = "SCRIPT";
  TAG_ID2[TAG_ID2["SEARCH"] = 94] = "SEARCH";
  TAG_ID2[TAG_ID2["SECTION"] = 95] = "SECTION";
  TAG_ID2[TAG_ID2["SELECT"] = 96] = "SELECT";
  TAG_ID2[TAG_ID2["SOURCE"] = 97] = "SOURCE";
  TAG_ID2[TAG_ID2["SMALL"] = 98] = "SMALL";
  TAG_ID2[TAG_ID2["SPAN"] = 99] = "SPAN";
  TAG_ID2[TAG_ID2["STRIKE"] = 100] = "STRIKE";
  TAG_ID2[TAG_ID2["STRONG"] = 101] = "STRONG";
  TAG_ID2[TAG_ID2["STYLE"] = 102] = "STYLE";
  TAG_ID2[TAG_ID2["SUB"] = 103] = "SUB";
  TAG_ID2[TAG_ID2["SUMMARY"] = 104] = "SUMMARY";
  TAG_ID2[TAG_ID2["SUP"] = 105] = "SUP";
  TAG_ID2[TAG_ID2["TABLE"] = 106] = "TABLE";
  TAG_ID2[TAG_ID2["TBODY"] = 107] = "TBODY";
  TAG_ID2[TAG_ID2["TEMPLATE"] = 108] = "TEMPLATE";
  TAG_ID2[TAG_ID2["TEXTAREA"] = 109] = "TEXTAREA";
  TAG_ID2[TAG_ID2["TFOOT"] = 110] = "TFOOT";
  TAG_ID2[TAG_ID2["TD"] = 111] = "TD";
  TAG_ID2[TAG_ID2["TH"] = 112] = "TH";
  TAG_ID2[TAG_ID2["THEAD"] = 113] = "THEAD";
  TAG_ID2[TAG_ID2["TITLE"] = 114] = "TITLE";
  TAG_ID2[TAG_ID2["TR"] = 115] = "TR";
  TAG_ID2[TAG_ID2["TRACK"] = 116] = "TRACK";
  TAG_ID2[TAG_ID2["TT"] = 117] = "TT";
  TAG_ID2[TAG_ID2["U"] = 118] = "U";
  TAG_ID2[TAG_ID2["UL"] = 119] = "UL";
  TAG_ID2[TAG_ID2["SVG"] = 120] = "SVG";
  TAG_ID2[TAG_ID2["VAR"] = 121] = "VAR";
  TAG_ID2[TAG_ID2["WBR"] = 122] = "WBR";
  TAG_ID2[TAG_ID2["XMP"] = 123] = "XMP";
})(TAG_ID || (TAG_ID = {}));
var TAG_NAME_TO_ID = /* @__PURE__ */ new Map([
  [TAG_NAMES.A, TAG_ID.A],
  [TAG_NAMES.ADDRESS, TAG_ID.ADDRESS],
  [TAG_NAMES.ANNOTATION_XML, TAG_ID.ANNOTATION_XML],
  [TAG_NAMES.APPLET, TAG_ID.APPLET],
  [TAG_NAMES.AREA, TAG_ID.AREA],
  [TAG_NAMES.ARTICLE, TAG_ID.ARTICLE],
  [TAG_NAMES.ASIDE, TAG_ID.ASIDE],
  [TAG_NAMES.B, TAG_ID.B],
  [TAG_NAMES.BASE, TAG_ID.BASE],
  [TAG_NAMES.BASEFONT, TAG_ID.BASEFONT],
  [TAG_NAMES.BGSOUND, TAG_ID.BGSOUND],
  [TAG_NAMES.BIG, TAG_ID.BIG],
  [TAG_NAMES.BLOCKQUOTE, TAG_ID.BLOCKQUOTE],
  [TAG_NAMES.BODY, TAG_ID.BODY],
  [TAG_NAMES.BR, TAG_ID.BR],
  [TAG_NAMES.BUTTON, TAG_ID.BUTTON],
  [TAG_NAMES.CAPTION, TAG_ID.CAPTION],
  [TAG_NAMES.CENTER, TAG_ID.CENTER],
  [TAG_NAMES.CODE, TAG_ID.CODE],
  [TAG_NAMES.COL, TAG_ID.COL],
  [TAG_NAMES.COLGROUP, TAG_ID.COLGROUP],
  [TAG_NAMES.DD, TAG_ID.DD],
  [TAG_NAMES.DESC, TAG_ID.DESC],
  [TAG_NAMES.DETAILS, TAG_ID.DETAILS],
  [TAG_NAMES.DIALOG, TAG_ID.DIALOG],
  [TAG_NAMES.DIR, TAG_ID.DIR],
  [TAG_NAMES.DIV, TAG_ID.DIV],
  [TAG_NAMES.DL, TAG_ID.DL],
  [TAG_NAMES.DT, TAG_ID.DT],
  [TAG_NAMES.EM, TAG_ID.EM],
  [TAG_NAMES.EMBED, TAG_ID.EMBED],
  [TAG_NAMES.FIELDSET, TAG_ID.FIELDSET],
  [TAG_NAMES.FIGCAPTION, TAG_ID.FIGCAPTION],
  [TAG_NAMES.FIGURE, TAG_ID.FIGURE],
  [TAG_NAMES.FONT, TAG_ID.FONT],
  [TAG_NAMES.FOOTER, TAG_ID.FOOTER],
  [TAG_NAMES.FOREIGN_OBJECT, TAG_ID.FOREIGN_OBJECT],
  [TAG_NAMES.FORM, TAG_ID.FORM],
  [TAG_NAMES.FRAME, TAG_ID.FRAME],
  [TAG_NAMES.FRAMESET, TAG_ID.FRAMESET],
  [TAG_NAMES.H1, TAG_ID.H1],
  [TAG_NAMES.H2, TAG_ID.H2],
  [TAG_NAMES.H3, TAG_ID.H3],
  [TAG_NAMES.H4, TAG_ID.H4],
  [TAG_NAMES.H5, TAG_ID.H5],
  [TAG_NAMES.H6, TAG_ID.H6],
  [TAG_NAMES.HEAD, TAG_ID.HEAD],
  [TAG_NAMES.HEADER, TAG_ID.HEADER],
  [TAG_NAMES.HGROUP, TAG_ID.HGROUP],
  [TAG_NAMES.HR, TAG_ID.HR],
  [TAG_NAMES.HTML, TAG_ID.HTML],
  [TAG_NAMES.I, TAG_ID.I],
  [TAG_NAMES.IMG, TAG_ID.IMG],
  [TAG_NAMES.IMAGE, TAG_ID.IMAGE],
  [TAG_NAMES.INPUT, TAG_ID.INPUT],
  [TAG_NAMES.IFRAME, TAG_ID.IFRAME],
  [TAG_NAMES.KEYGEN, TAG_ID.KEYGEN],
  [TAG_NAMES.LABEL, TAG_ID.LABEL],
  [TAG_NAMES.LI, TAG_ID.LI],
  [TAG_NAMES.LINK, TAG_ID.LINK],
  [TAG_NAMES.LISTING, TAG_ID.LISTING],
  [TAG_NAMES.MAIN, TAG_ID.MAIN],
  [TAG_NAMES.MALIGNMARK, TAG_ID.MALIGNMARK],
  [TAG_NAMES.MARQUEE, TAG_ID.MARQUEE],
  [TAG_NAMES.MATH, TAG_ID.MATH],
  [TAG_NAMES.MENU, TAG_ID.MENU],
  [TAG_NAMES.META, TAG_ID.META],
  [TAG_NAMES.MGLYPH, TAG_ID.MGLYPH],
  [TAG_NAMES.MI, TAG_ID.MI],
  [TAG_NAMES.MO, TAG_ID.MO],
  [TAG_NAMES.MN, TAG_ID.MN],
  [TAG_NAMES.MS, TAG_ID.MS],
  [TAG_NAMES.MTEXT, TAG_ID.MTEXT],
  [TAG_NAMES.NAV, TAG_ID.NAV],
  [TAG_NAMES.NOBR, TAG_ID.NOBR],
  [TAG_NAMES.NOFRAMES, TAG_ID.NOFRAMES],
  [TAG_NAMES.NOEMBED, TAG_ID.NOEMBED],
  [TAG_NAMES.NOSCRIPT, TAG_ID.NOSCRIPT],
  [TAG_NAMES.OBJECT, TAG_ID.OBJECT],
  [TAG_NAMES.OL, TAG_ID.OL],
  [TAG_NAMES.OPTGROUP, TAG_ID.OPTGROUP],
  [TAG_NAMES.OPTION, TAG_ID.OPTION],
  [TAG_NAMES.P, TAG_ID.P],
  [TAG_NAMES.PARAM, TAG_ID.PARAM],
  [TAG_NAMES.PLAINTEXT, TAG_ID.PLAINTEXT],
  [TAG_NAMES.PRE, TAG_ID.PRE],
  [TAG_NAMES.RB, TAG_ID.RB],
  [TAG_NAMES.RP, TAG_ID.RP],
  [TAG_NAMES.RT, TAG_ID.RT],
  [TAG_NAMES.RTC, TAG_ID.RTC],
  [TAG_NAMES.RUBY, TAG_ID.RUBY],
  [TAG_NAMES.S, TAG_ID.S],
  [TAG_NAMES.SCRIPT, TAG_ID.SCRIPT],
  [TAG_NAMES.SEARCH, TAG_ID.SEARCH],
  [TAG_NAMES.SECTION, TAG_ID.SECTION],
  [TAG_NAMES.SELECT, TAG_ID.SELECT],
  [TAG_NAMES.SOURCE, TAG_ID.SOURCE],
  [TAG_NAMES.SMALL, TAG_ID.SMALL],
  [TAG_NAMES.SPAN, TAG_ID.SPAN],
  [TAG_NAMES.STRIKE, TAG_ID.STRIKE],
  [TAG_NAMES.STRONG, TAG_ID.STRONG],
  [TAG_NAMES.STYLE, TAG_ID.STYLE],
  [TAG_NAMES.SUB, TAG_ID.SUB],
  [TAG_NAMES.SUMMARY, TAG_ID.SUMMARY],
  [TAG_NAMES.SUP, TAG_ID.SUP],
  [TAG_NAMES.TABLE, TAG_ID.TABLE],
  [TAG_NAMES.TBODY, TAG_ID.TBODY],
  [TAG_NAMES.TEMPLATE, TAG_ID.TEMPLATE],
  [TAG_NAMES.TEXTAREA, TAG_ID.TEXTAREA],
  [TAG_NAMES.TFOOT, TAG_ID.TFOOT],
  [TAG_NAMES.TD, TAG_ID.TD],
  [TAG_NAMES.TH, TAG_ID.TH],
  [TAG_NAMES.THEAD, TAG_ID.THEAD],
  [TAG_NAMES.TITLE, TAG_ID.TITLE],
  [TAG_NAMES.TR, TAG_ID.TR],
  [TAG_NAMES.TRACK, TAG_ID.TRACK],
  [TAG_NAMES.TT, TAG_ID.TT],
  [TAG_NAMES.U, TAG_ID.U],
  [TAG_NAMES.UL, TAG_ID.UL],
  [TAG_NAMES.SVG, TAG_ID.SVG],
  [TAG_NAMES.VAR, TAG_ID.VAR],
  [TAG_NAMES.WBR, TAG_ID.WBR],
  [TAG_NAMES.XMP, TAG_ID.XMP]
]);
var $ = TAG_ID;
var SPECIAL_ELEMENTS = {
  [NS.HTML]: /* @__PURE__ */ new Set([
    $.ADDRESS,
    $.APPLET,
    $.AREA,
    $.ARTICLE,
    $.ASIDE,
    $.BASE,
    $.BASEFONT,
    $.BGSOUND,
    $.BLOCKQUOTE,
    $.BODY,
    $.BR,
    $.BUTTON,
    $.CAPTION,
    $.CENTER,
    $.COL,
    $.COLGROUP,
    $.DD,
    $.DETAILS,
    $.DIR,
    $.DIV,
    $.DL,
    $.DT,
    $.EMBED,
    $.FIELDSET,
    $.FIGCAPTION,
    $.FIGURE,
    $.FOOTER,
    $.FORM,
    $.FRAME,
    $.FRAMESET,
    $.H1,
    $.H2,
    $.H3,
    $.H4,
    $.H5,
    $.H6,
    $.HEAD,
    $.HEADER,
    $.HGROUP,
    $.HR,
    $.HTML,
    $.IFRAME,
    $.IMG,
    $.INPUT,
    $.LI,
    $.LINK,
    $.LISTING,
    $.MAIN,
    $.MARQUEE,
    $.MENU,
    $.META,
    $.NAV,
    $.NOEMBED,
    $.NOFRAMES,
    $.NOSCRIPT,
    $.OBJECT,
    $.OL,
    $.P,
    $.PARAM,
    $.PLAINTEXT,
    $.PRE,
    $.SCRIPT,
    $.SECTION,
    $.SELECT,
    $.SOURCE,
    $.STYLE,
    $.SUMMARY,
    $.TABLE,
    $.TBODY,
    $.TD,
    $.TEMPLATE,
    $.TEXTAREA,
    $.TFOOT,
    $.TH,
    $.THEAD,
    $.TITLE,
    $.TR,
    $.TRACK,
    $.UL,
    $.WBR,
    $.XMP
  ]),
  [NS.MATHML]: /* @__PURE__ */ new Set([$.MI, $.MO, $.MN, $.MS, $.MTEXT, $.ANNOTATION_XML]),
  [NS.SVG]: /* @__PURE__ */ new Set([$.TITLE, $.FOREIGN_OBJECT, $.DESC]),
  [NS.XLINK]: /* @__PURE__ */ new Set(),
  [NS.XML]: /* @__PURE__ */ new Set(),
  [NS.XMLNS]: /* @__PURE__ */ new Set()
};
var NUMBERED_HEADERS = /* @__PURE__ */ new Set([$.H1, $.H2, $.H3, $.H4, $.H5, $.H6]);
var UNESCAPED_TEXT = /* @__PURE__ */ new Set([
  TAG_NAMES.STYLE,
  TAG_NAMES.SCRIPT,
  TAG_NAMES.XMP,
  TAG_NAMES.IFRAME,
  TAG_NAMES.NOEMBED,
  TAG_NAMES.NOFRAMES,
  TAG_NAMES.PLAINTEXT
]);

// site/node_modules/parse5/dist/tokenizer/index.js
var State;
(function(State2) {
  State2[State2["DATA"] = 0] = "DATA";
  State2[State2["RCDATA"] = 1] = "RCDATA";
  State2[State2["RAWTEXT"] = 2] = "RAWTEXT";
  State2[State2["SCRIPT_DATA"] = 3] = "SCRIPT_DATA";
  State2[State2["PLAINTEXT"] = 4] = "PLAINTEXT";
  State2[State2["TAG_OPEN"] = 5] = "TAG_OPEN";
  State2[State2["END_TAG_OPEN"] = 6] = "END_TAG_OPEN";
  State2[State2["TAG_NAME"] = 7] = "TAG_NAME";
  State2[State2["RCDATA_LESS_THAN_SIGN"] = 8] = "RCDATA_LESS_THAN_SIGN";
  State2[State2["RCDATA_END_TAG_OPEN"] = 9] = "RCDATA_END_TAG_OPEN";
  State2[State2["RCDATA_END_TAG_NAME"] = 10] = "RCDATA_END_TAG_NAME";
  State2[State2["RAWTEXT_LESS_THAN_SIGN"] = 11] = "RAWTEXT_LESS_THAN_SIGN";
  State2[State2["RAWTEXT_END_TAG_OPEN"] = 12] = "RAWTEXT_END_TAG_OPEN";
  State2[State2["RAWTEXT_END_TAG_NAME"] = 13] = "RAWTEXT_END_TAG_NAME";
  State2[State2["SCRIPT_DATA_LESS_THAN_SIGN"] = 14] = "SCRIPT_DATA_LESS_THAN_SIGN";
  State2[State2["SCRIPT_DATA_END_TAG_OPEN"] = 15] = "SCRIPT_DATA_END_TAG_OPEN";
  State2[State2["SCRIPT_DATA_END_TAG_NAME"] = 16] = "SCRIPT_DATA_END_TAG_NAME";
  State2[State2["SCRIPT_DATA_ESCAPE_START"] = 17] = "SCRIPT_DATA_ESCAPE_START";
  State2[State2["SCRIPT_DATA_ESCAPE_START_DASH"] = 18] = "SCRIPT_DATA_ESCAPE_START_DASH";
  State2[State2["SCRIPT_DATA_ESCAPED"] = 19] = "SCRIPT_DATA_ESCAPED";
  State2[State2["SCRIPT_DATA_ESCAPED_DASH"] = 20] = "SCRIPT_DATA_ESCAPED_DASH";
  State2[State2["SCRIPT_DATA_ESCAPED_DASH_DASH"] = 21] = "SCRIPT_DATA_ESCAPED_DASH_DASH";
  State2[State2["SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN"] = 22] = "SCRIPT_DATA_ESCAPED_LESS_THAN_SIGN";
  State2[State2["SCRIPT_DATA_ESCAPED_END_TAG_OPEN"] = 23] = "SCRIPT_DATA_ESCAPED_END_TAG_OPEN";
  State2[State2["SCRIPT_DATA_ESCAPED_END_TAG_NAME"] = 24] = "SCRIPT_DATA_ESCAPED_END_TAG_NAME";
  State2[State2["SCRIPT_DATA_DOUBLE_ESCAPE_START"] = 25] = "SCRIPT_DATA_DOUBLE_ESCAPE_START";
  State2[State2["SCRIPT_DATA_DOUBLE_ESCAPED"] = 26] = "SCRIPT_DATA_DOUBLE_ESCAPED";
  State2[State2["SCRIPT_DATA_DOUBLE_ESCAPED_DASH"] = 27] = "SCRIPT_DATA_DOUBLE_ESCAPED_DASH";
  State2[State2["SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH"] = 28] = "SCRIPT_DATA_DOUBLE_ESCAPED_DASH_DASH";
  State2[State2["SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN"] = 29] = "SCRIPT_DATA_DOUBLE_ESCAPED_LESS_THAN_SIGN";
  State2[State2["SCRIPT_DATA_DOUBLE_ESCAPE_END"] = 30] = "SCRIPT_DATA_DOUBLE_ESCAPE_END";
  State2[State2["BEFORE_ATTRIBUTE_NAME"] = 31] = "BEFORE_ATTRIBUTE_NAME";
  State2[State2["ATTRIBUTE_NAME"] = 32] = "ATTRIBUTE_NAME";
  State2[State2["AFTER_ATTRIBUTE_NAME"] = 33] = "AFTER_ATTRIBUTE_NAME";
  State2[State2["BEFORE_ATTRIBUTE_VALUE"] = 34] = "BEFORE_ATTRIBUTE_VALUE";
  State2[State2["ATTRIBUTE_VALUE_DOUBLE_QUOTED"] = 35] = "ATTRIBUTE_VALUE_DOUBLE_QUOTED";
  State2[State2["ATTRIBUTE_VALUE_SINGLE_QUOTED"] = 36] = "ATTRIBUTE_VALUE_SINGLE_QUOTED";
  State2[State2["ATTRIBUTE_VALUE_UNQUOTED"] = 37] = "ATTRIBUTE_VALUE_UNQUOTED";
  State2[State2["AFTER_ATTRIBUTE_VALUE_QUOTED"] = 38] = "AFTER_ATTRIBUTE_VALUE_QUOTED";
  State2[State2["SELF_CLOSING_START_TAG"] = 39] = "SELF_CLOSING_START_TAG";
  State2[State2["BOGUS_COMMENT"] = 40] = "BOGUS_COMMENT";
  State2[State2["MARKUP_DECLARATION_OPEN"] = 41] = "MARKUP_DECLARATION_OPEN";
  State2[State2["COMMENT_START"] = 42] = "COMMENT_START";
  State2[State2["COMMENT_START_DASH"] = 43] = "COMMENT_START_DASH";
  State2[State2["COMMENT"] = 44] = "COMMENT";
  State2[State2["COMMENT_LESS_THAN_SIGN"] = 45] = "COMMENT_LESS_THAN_SIGN";
  State2[State2["COMMENT_LESS_THAN_SIGN_BANG"] = 46] = "COMMENT_LESS_THAN_SIGN_BANG";
  State2[State2["COMMENT_LESS_THAN_SIGN_BANG_DASH"] = 47] = "COMMENT_LESS_THAN_SIGN_BANG_DASH";
  State2[State2["COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH"] = 48] = "COMMENT_LESS_THAN_SIGN_BANG_DASH_DASH";
  State2[State2["COMMENT_END_DASH"] = 49] = "COMMENT_END_DASH";
  State2[State2["COMMENT_END"] = 50] = "COMMENT_END";
  State2[State2["COMMENT_END_BANG"] = 51] = "COMMENT_END_BANG";
  State2[State2["DOCTYPE"] = 52] = "DOCTYPE";
  State2[State2["BEFORE_DOCTYPE_NAME"] = 53] = "BEFORE_DOCTYPE_NAME";
  State2[State2["DOCTYPE_NAME"] = 54] = "DOCTYPE_NAME";
  State2[State2["AFTER_DOCTYPE_NAME"] = 55] = "AFTER_DOCTYPE_NAME";
  State2[State2["AFTER_DOCTYPE_PUBLIC_KEYWORD"] = 56] = "AFTER_DOCTYPE_PUBLIC_KEYWORD";
  State2[State2["BEFORE_DOCTYPE_PUBLIC_IDENTIFIER"] = 57] = "BEFORE_DOCTYPE_PUBLIC_IDENTIFIER";
  State2[State2["DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED"] = 58] = "DOCTYPE_PUBLIC_IDENTIFIER_DOUBLE_QUOTED";
  State2[State2["DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED"] = 59] = "DOCTYPE_PUBLIC_IDENTIFIER_SINGLE_QUOTED";
  State2[State2["AFTER_DOCTYPE_PUBLIC_IDENTIFIER"] = 60] = "AFTER_DOCTYPE_PUBLIC_IDENTIFIER";
  State2[State2["BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS"] = 61] = "BETWEEN_DOCTYPE_PUBLIC_AND_SYSTEM_IDENTIFIERS";
  State2[State2["AFTER_DOCTYPE_SYSTEM_KEYWORD"] = 62] = "AFTER_DOCTYPE_SYSTEM_KEYWORD";
  State2[State2["BEFORE_DOCTYPE_SYSTEM_IDENTIFIER"] = 63] = "BEFORE_DOCTYPE_SYSTEM_IDENTIFIER";
  State2[State2["DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED"] = 64] = "DOCTYPE_SYSTEM_IDENTIFIER_DOUBLE_QUOTED";
  State2[State2["DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED"] = 65] = "DOCTYPE_SYSTEM_IDENTIFIER_SINGLE_QUOTED";
  State2[State2["AFTER_DOCTYPE_SYSTEM_IDENTIFIER"] = 66] = "AFTER_DOCTYPE_SYSTEM_IDENTIFIER";
  State2[State2["BOGUS_DOCTYPE"] = 67] = "BOGUS_DOCTYPE";
  State2[State2["CDATA_SECTION"] = 68] = "CDATA_SECTION";
  State2[State2["CDATA_SECTION_BRACKET"] = 69] = "CDATA_SECTION_BRACKET";
  State2[State2["CDATA_SECTION_END"] = 70] = "CDATA_SECTION_END";
  State2[State2["CHARACTER_REFERENCE"] = 71] = "CHARACTER_REFERENCE";
  State2[State2["AMBIGUOUS_AMPERSAND"] = 72] = "AMBIGUOUS_AMPERSAND";
})(State || (State = {}));
var TokenizerMode = {
  DATA: State.DATA,
  RCDATA: State.RCDATA,
  RAWTEXT: State.RAWTEXT,
  SCRIPT_DATA: State.SCRIPT_DATA,
  PLAINTEXT: State.PLAINTEXT,
  CDATA_SECTION: State.CDATA_SECTION
};

// site/node_modules/parse5/dist/parser/open-element-stack.js
var IMPLICIT_END_TAG_REQUIRED = /* @__PURE__ */ new Set([TAG_ID.DD, TAG_ID.DT, TAG_ID.LI, TAG_ID.OPTGROUP, TAG_ID.OPTION, TAG_ID.P, TAG_ID.RB, TAG_ID.RP, TAG_ID.RT, TAG_ID.RTC]);
var IMPLICIT_END_TAG_REQUIRED_THOROUGHLY = /* @__PURE__ */ new Set([
  ...IMPLICIT_END_TAG_REQUIRED,
  TAG_ID.CAPTION,
  TAG_ID.COLGROUP,
  TAG_ID.TBODY,
  TAG_ID.TD,
  TAG_ID.TFOOT,
  TAG_ID.TH,
  TAG_ID.THEAD,
  TAG_ID.TR
]);
var SCOPING_ELEMENTS_HTML = /* @__PURE__ */ new Set([
  TAG_ID.APPLET,
  TAG_ID.CAPTION,
  TAG_ID.HTML,
  TAG_ID.MARQUEE,
  TAG_ID.OBJECT,
  TAG_ID.TABLE,
  TAG_ID.TD,
  TAG_ID.TEMPLATE,
  TAG_ID.TH
]);
var SCOPING_ELEMENTS_HTML_LIST = /* @__PURE__ */ new Set([...SCOPING_ELEMENTS_HTML, TAG_ID.OL, TAG_ID.UL]);
var SCOPING_ELEMENTS_HTML_BUTTON = /* @__PURE__ */ new Set([...SCOPING_ELEMENTS_HTML, TAG_ID.BUTTON]);
var SCOPING_ELEMENTS_MATHML = /* @__PURE__ */ new Set([TAG_ID.ANNOTATION_XML, TAG_ID.MI, TAG_ID.MN, TAG_ID.MO, TAG_ID.MS, TAG_ID.MTEXT]);
var SCOPING_ELEMENTS_SVG = /* @__PURE__ */ new Set([TAG_ID.DESC, TAG_ID.FOREIGN_OBJECT, TAG_ID.TITLE]);
var TABLE_ROW_CONTEXT = /* @__PURE__ */ new Set([TAG_ID.TR, TAG_ID.TEMPLATE, TAG_ID.HTML]);
var TABLE_BODY_CONTEXT = /* @__PURE__ */ new Set([TAG_ID.TBODY, TAG_ID.TFOOT, TAG_ID.THEAD, TAG_ID.TEMPLATE, TAG_ID.HTML]);
var TABLE_CONTEXT = /* @__PURE__ */ new Set([TAG_ID.TABLE, TAG_ID.TEMPLATE, TAG_ID.HTML]);
var TABLE_CELLS = /* @__PURE__ */ new Set([TAG_ID.TD, TAG_ID.TH]);

// site/node_modules/parse5/dist/parser/formatting-element-list.js
var EntryType;
(function(EntryType2) {
  EntryType2[EntryType2["Marker"] = 0] = "Marker";
  EntryType2[EntryType2["Element"] = 1] = "Element";
})(EntryType || (EntryType = {}));
var MARKER = { type: EntryType.Marker };

// site/node_modules/parse5/dist/common/doctype.js
var QUIRKS_MODE_PUBLIC_ID_PREFIXES = [
  "+//silmaril//dtd html pro v0r11 19970101//",
  "-//as//dtd html 3.0 aswedit + extensions//",
  "-//advasoft ltd//dtd html 3.0 aswedit + extensions//",
  "-//ietf//dtd html 2.0 level 1//",
  "-//ietf//dtd html 2.0 level 2//",
  "-//ietf//dtd html 2.0 strict level 1//",
  "-//ietf//dtd html 2.0 strict level 2//",
  "-//ietf//dtd html 2.0 strict//",
  "-//ietf//dtd html 2.0//",
  "-//ietf//dtd html 2.1e//",
  "-//ietf//dtd html 3.0//",
  "-//ietf//dtd html 3.2 final//",
  "-//ietf//dtd html 3.2//",
  "-//ietf//dtd html 3//",
  "-//ietf//dtd html level 0//",
  "-//ietf//dtd html level 1//",
  "-//ietf//dtd html level 2//",
  "-//ietf//dtd html level 3//",
  "-//ietf//dtd html strict level 0//",
  "-//ietf//dtd html strict level 1//",
  "-//ietf//dtd html strict level 2//",
  "-//ietf//dtd html strict level 3//",
  "-//ietf//dtd html strict//",
  "-//ietf//dtd html//",
  "-//metrius//dtd metrius presentational//",
  "-//microsoft//dtd internet explorer 2.0 html strict//",
  "-//microsoft//dtd internet explorer 2.0 html//",
  "-//microsoft//dtd internet explorer 2.0 tables//",
  "-//microsoft//dtd internet explorer 3.0 html strict//",
  "-//microsoft//dtd internet explorer 3.0 html//",
  "-//microsoft//dtd internet explorer 3.0 tables//",
  "-//netscape comm. corp.//dtd html//",
  "-//netscape comm. corp.//dtd strict html//",
  "-//o'reilly and associates//dtd html 2.0//",
  "-//o'reilly and associates//dtd html extended 1.0//",
  "-//o'reilly and associates//dtd html extended relaxed 1.0//",
  "-//sq//dtd html 2.0 hotmetal + extensions//",
  "-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//",
  "-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//",
  "-//spyglass//dtd html 2.0 extended//",
  "-//sun microsystems corp.//dtd hotjava html//",
  "-//sun microsystems corp.//dtd hotjava strict html//",
  "-//w3c//dtd html 3 1995-03-24//",
  "-//w3c//dtd html 3.2 draft//",
  "-//w3c//dtd html 3.2 final//",
  "-//w3c//dtd html 3.2//",
  "-//w3c//dtd html 3.2s draft//",
  "-//w3c//dtd html 4.0 frameset//",
  "-//w3c//dtd html 4.0 transitional//",
  "-//w3c//dtd html experimental 19960712//",
  "-//w3c//dtd html experimental 970421//",
  "-//w3c//dtd w3 html//",
  "-//w3o//dtd w3 html 3.0//",
  "-//webtechs//dtd mozilla html 2.0//",
  "-//webtechs//dtd mozilla html//"
];
var QUIRKS_MODE_NO_SYSTEM_ID_PUBLIC_ID_PREFIXES = [
  ...QUIRKS_MODE_PUBLIC_ID_PREFIXES,
  "-//w3c//dtd html 4.01 frameset//",
  "-//w3c//dtd html 4.01 transitional//"
];
var LIMITED_QUIRKS_PUBLIC_ID_PREFIXES = ["-//w3c//dtd xhtml 1.0 frameset//", "-//w3c//dtd xhtml 1.0 transitional//"];
var LIMITED_QUIRKS_WITH_SYSTEM_ID_PUBLIC_ID_PREFIXES = [
  ...LIMITED_QUIRKS_PUBLIC_ID_PREFIXES,
  "-//w3c//dtd html 4.01 frameset//",
  "-//w3c//dtd html 4.01 transitional//"
];

// site/node_modules/parse5/dist/common/foreign-content.js
var SVG_ATTRS_ADJUSTMENT_MAP = new Map([
  "attributeName",
  "attributeType",
  "baseFrequency",
  "baseProfile",
  "calcMode",
  "clipPathUnits",
  "diffuseConstant",
  "edgeMode",
  "filterUnits",
  "glyphRef",
  "gradientTransform",
  "gradientUnits",
  "kernelMatrix",
  "kernelUnitLength",
  "keyPoints",
  "keySplines",
  "keyTimes",
  "lengthAdjust",
  "limitingConeAngle",
  "markerHeight",
  "markerUnits",
  "markerWidth",
  "maskContentUnits",
  "maskUnits",
  "numOctaves",
  "pathLength",
  "patternContentUnits",
  "patternTransform",
  "patternUnits",
  "pointsAtX",
  "pointsAtY",
  "pointsAtZ",
  "preserveAlpha",
  "preserveAspectRatio",
  "primitiveUnits",
  "refX",
  "refY",
  "repeatCount",
  "repeatDur",
  "requiredExtensions",
  "requiredFeatures",
  "specularConstant",
  "specularExponent",
  "spreadMethod",
  "startOffset",
  "stdDeviation",
  "stitchTiles",
  "surfaceScale",
  "systemLanguage",
  "tableValues",
  "targetX",
  "targetY",
  "textLength",
  "viewBox",
  "viewTarget",
  "xChannelSelector",
  "yChannelSelector",
  "zoomAndPan"
].map((attr) => [attr.toLowerCase(), attr]));
var XML_ATTRS_ADJUSTMENT_MAP = /* @__PURE__ */ new Map([
  ["xlink:actuate", { prefix: "xlink", name: "actuate", namespace: NS.XLINK }],
  ["xlink:arcrole", { prefix: "xlink", name: "arcrole", namespace: NS.XLINK }],
  ["xlink:href", { prefix: "xlink", name: "href", namespace: NS.XLINK }],
  ["xlink:role", { prefix: "xlink", name: "role", namespace: NS.XLINK }],
  ["xlink:show", { prefix: "xlink", name: "show", namespace: NS.XLINK }],
  ["xlink:title", { prefix: "xlink", name: "title", namespace: NS.XLINK }],
  ["xlink:type", { prefix: "xlink", name: "type", namespace: NS.XLINK }],
  ["xml:lang", { prefix: "xml", name: "lang", namespace: NS.XML }],
  ["xml:space", { prefix: "xml", name: "space", namespace: NS.XML }],
  ["xmlns", { prefix: "", name: "xmlns", namespace: NS.XMLNS }],
  ["xmlns:xlink", { prefix: "xmlns", name: "xlink", namespace: NS.XMLNS }]
]);
var SVG_TAG_NAMES_ADJUSTMENT_MAP = new Map([
  "altGlyph",
  "altGlyphDef",
  "altGlyphItem",
  "animateColor",
  "animateMotion",
  "animateTransform",
  "clipPath",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "foreignObject",
  "glyphRef",
  "linearGradient",
  "radialGradient",
  "textPath"
].map((tn) => [tn.toLowerCase(), tn]));
var EXITS_FOREIGN_CONTENT = /* @__PURE__ */ new Set([
  TAG_ID.B,
  TAG_ID.BIG,
  TAG_ID.BLOCKQUOTE,
  TAG_ID.BODY,
  TAG_ID.BR,
  TAG_ID.CENTER,
  TAG_ID.CODE,
  TAG_ID.DD,
  TAG_ID.DIV,
  TAG_ID.DL,
  TAG_ID.DT,
  TAG_ID.EM,
  TAG_ID.EMBED,
  TAG_ID.H1,
  TAG_ID.H2,
  TAG_ID.H3,
  TAG_ID.H4,
  TAG_ID.H5,
  TAG_ID.H6,
  TAG_ID.HEAD,
  TAG_ID.HR,
  TAG_ID.I,
  TAG_ID.IMG,
  TAG_ID.LI,
  TAG_ID.LISTING,
  TAG_ID.MENU,
  TAG_ID.META,
  TAG_ID.NOBR,
  TAG_ID.OL,
  TAG_ID.P,
  TAG_ID.PRE,
  TAG_ID.RUBY,
  TAG_ID.S,
  TAG_ID.SMALL,
  TAG_ID.SPAN,
  TAG_ID.STRONG,
  TAG_ID.STRIKE,
  TAG_ID.SUB,
  TAG_ID.SUP,
  TAG_ID.TABLE,
  TAG_ID.TT,
  TAG_ID.U,
  TAG_ID.UL,
  TAG_ID.VAR
]);

// site/node_modules/parse5/dist/parser/index.js
var InsertionMode;
(function(InsertionMode2) {
  InsertionMode2[InsertionMode2["INITIAL"] = 0] = "INITIAL";
  InsertionMode2[InsertionMode2["BEFORE_HTML"] = 1] = "BEFORE_HTML";
  InsertionMode2[InsertionMode2["BEFORE_HEAD"] = 2] = "BEFORE_HEAD";
  InsertionMode2[InsertionMode2["IN_HEAD"] = 3] = "IN_HEAD";
  InsertionMode2[InsertionMode2["IN_HEAD_NO_SCRIPT"] = 4] = "IN_HEAD_NO_SCRIPT";
  InsertionMode2[InsertionMode2["AFTER_HEAD"] = 5] = "AFTER_HEAD";
  InsertionMode2[InsertionMode2["IN_BODY"] = 6] = "IN_BODY";
  InsertionMode2[InsertionMode2["TEXT"] = 7] = "TEXT";
  InsertionMode2[InsertionMode2["IN_TABLE"] = 8] = "IN_TABLE";
  InsertionMode2[InsertionMode2["IN_TABLE_TEXT"] = 9] = "IN_TABLE_TEXT";
  InsertionMode2[InsertionMode2["IN_CAPTION"] = 10] = "IN_CAPTION";
  InsertionMode2[InsertionMode2["IN_COLUMN_GROUP"] = 11] = "IN_COLUMN_GROUP";
  InsertionMode2[InsertionMode2["IN_TABLE_BODY"] = 12] = "IN_TABLE_BODY";
  InsertionMode2[InsertionMode2["IN_ROW"] = 13] = "IN_ROW";
  InsertionMode2[InsertionMode2["IN_CELL"] = 14] = "IN_CELL";
  InsertionMode2[InsertionMode2["IN_SELECT"] = 15] = "IN_SELECT";
  InsertionMode2[InsertionMode2["IN_SELECT_IN_TABLE"] = 16] = "IN_SELECT_IN_TABLE";
  InsertionMode2[InsertionMode2["IN_TEMPLATE"] = 17] = "IN_TEMPLATE";
  InsertionMode2[InsertionMode2["AFTER_BODY"] = 18] = "AFTER_BODY";
  InsertionMode2[InsertionMode2["IN_FRAMESET"] = 19] = "IN_FRAMESET";
  InsertionMode2[InsertionMode2["AFTER_FRAMESET"] = 20] = "AFTER_FRAMESET";
  InsertionMode2[InsertionMode2["AFTER_AFTER_BODY"] = 21] = "AFTER_AFTER_BODY";
  InsertionMode2[InsertionMode2["AFTER_AFTER_FRAMESET"] = 22] = "AFTER_AFTER_FRAMESET";
})(InsertionMode || (InsertionMode = {}));
var TABLE_STRUCTURE_TAGS = /* @__PURE__ */ new Set([TAG_ID.TABLE, TAG_ID.TBODY, TAG_ID.TFOOT, TAG_ID.THEAD, TAG_ID.TR]);
var TABLE_VOID_ELEMENTS = /* @__PURE__ */ new Set([TAG_ID.CAPTION, TAG_ID.COL, TAG_ID.COLGROUP, TAG_ID.TBODY, TAG_ID.TD, TAG_ID.TFOOT, TAG_ID.TH, TAG_ID.THEAD, TAG_ID.TR]);

// site/node_modules/entities/dist/esm/escape.js
var getCodePoint = (
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  String.prototype.codePointAt == null ? (c, index) => (c.charCodeAt(index) & 64512) === 55296 ? (c.charCodeAt(index) - 55296) * 1024 + c.charCodeAt(index + 1) - 56320 + 65536 : c.charCodeAt(index) : (
    // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
    (input, index) => input.codePointAt(index)
  )
);

// site/node_modules/parse5/dist/serializer/index.js
var VOID_ELEMENTS = /* @__PURE__ */ new Set([
  TAG_NAMES.AREA,
  TAG_NAMES.BASE,
  TAG_NAMES.BASEFONT,
  TAG_NAMES.BGSOUND,
  TAG_NAMES.BR,
  TAG_NAMES.COL,
  TAG_NAMES.EMBED,
  TAG_NAMES.FRAME,
  TAG_NAMES.HR,
  TAG_NAMES.IMG,
  TAG_NAMES.INPUT,
  TAG_NAMES.KEYGEN,
  TAG_NAMES.LINK,
  TAG_NAMES.META,
  TAG_NAMES.PARAM,
  TAG_NAMES.SOURCE,
  TAG_NAMES.TRACK,
  TAG_NAMES.WBR
]);

// site/src/lib/public-publication-receipt.ts
var PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION = 1;
var MAX_PUBLICATION_RECEIPT_BYTES = 8 * 1024;
var DIGEST = /^[a-f0-9]{64}$/;
var COMMIT_SHA = /^[a-f0-9]{40}$/;
var SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
var FIRESTORE_RESERVED_IDENTIFIER = /^__.*__$/;
var MAX_ARTIFACT_BYTES = 100 * 1024 * 1024 * 1024;
var PUBLICATION_FIELDS = /* @__PURE__ */ new Set([
  "schemaVersion",
  "digestAlgorithm",
  "buildBatchId",
  "generation",
  "commitSha",
  "artifactDigest",
  "artifactReceiptDigest",
  "mediaManifestDigest"
]);
var PREPARED_FIELDS = /* @__PURE__ */ new Set([
  ...PUBLICATION_FIELDS,
  "publicationReceiptDigest",
  "artifactFileCount",
  "artifactBytes"
]);
var PublicWorkerArtifactError = class extends Error {
  constructor(message = "The prepared public Worker artifact is invalid") {
    super(message);
    this.name = "PublicWorkerArtifactError";
  }
};
function invalid2(message = "The prepared public Worker artifact is invalid") {
  throw new PublicWorkerArtifactError(message);
}
function plainObject5(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function hasExactFields2(value, fields4) {
  return plainObject5(value) && Object.keys(value).length === fields4.size && Object.keys(value).every((field) => fields4.has(field));
}
function canonicalPublicationReceipt(value) {
  if (!hasExactFields2(value, PUBLICATION_FIELDS) || value.schemaVersion !== PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION || value.digestAlgorithm !== "sha256" || typeof value.buildBatchId !== "string" || value.buildBatchId.length < 1 || Buffer.byteLength(value.buildBatchId, "utf8") > 128 || !SAFE_IDENTIFIER.test(value.buildBatchId) || value.buildBatchId === "." || value.buildBatchId === ".." || FIRESTORE_RESERVED_IDENTIFIER.test(value.buildBatchId) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || typeof value.commitSha !== "string" || !COMMIT_SHA.test(value.commitSha) || typeof value.artifactDigest !== "string" || !DIGEST.test(value.artifactDigest) || typeof value.artifactReceiptDigest !== "string" || !DIGEST.test(value.artifactReceiptDigest) || typeof value.mediaManifestDigest !== "string" || !DIGEST.test(value.mediaManifestDigest)) {
    invalid2();
  }
  return {
    schemaVersion: PUBLIC_PUBLICATION_RECEIPT_SCHEMA_VERSION,
    digestAlgorithm: "sha256",
    buildBatchId: value.buildBatchId,
    generation: Number(value.generation),
    commitSha: value.commitSha,
    artifactDigest: value.artifactDigest,
    artifactReceiptDigest: value.artifactReceiptDigest,
    mediaManifestDigest: value.mediaManifestDigest
  };
}

// site/src/lib/retained-public-context.ts
function assertContextMatchesPublication(context, publication) {
  const live = canonicalPublicationReceipt(publication);
  const writtenReceipt = context !== null && typeof context === "object" ? context.receipt : void 0;
  const digest = (0, import_node_crypto6.createHash)("sha256").update(JSON.stringify(writtenReceipt) ?? "").digest("hex");
  const bundle = normalizePublicArtifactBundle(structuredClone(context));
  const receipt = bundle.receipt;
  if (receipt.buildBatchId !== live.buildBatchId || receipt.generation !== live.generation || receipt.commitSha !== live.commitSha || receipt.mediaManifestDigest !== live.mediaManifestDigest || digest !== live.artifactReceiptDigest) {
    throw new Error("Retained public context does not match the current publication");
  }
  return bundle;
}

// site/scripts/cms-current-code-context.ts
var require2 = (0, import_node_module2.createRequire)(__generatedReaderModuleUrl);
var { assertPublicationTarget, assertPublicationDatabase } = require2("./publication-target.js");
var { createCurrentCodeTransport } = require2("./current-public-code-source.js");
function qualifyHistoricalCodeContext(qualified) {
  if (qualified.bytes.length !== qualified.reference.manifest.byteLength || (0, import_node_crypto7.createHash)("sha256").update(qualified.bytes).digest("hex") !== qualified.reference.manifest.sha256) {
    throw new Error("Qualified current CODE bytes differ");
  }
  const original = JSON.parse(qualified.bytes.toString("utf8"));
  const publicContext = assertContextMatchesPublication(original, qualified.reference.publication);
  return {
    publicContext,
    publication: qualified.reference.publication,
    reference: qualified.reference,
    ...original.programImageDescriptors ? { originalProgramImageCatalog: original.programImageDescriptors } : {}
  };
}
function createCurrentCodeContextReader({ target, rendererSha, firestore, request, readSecret }) {
  target = assertPublicationTarget(target);
  assertPublicationDatabase(firestore, target);
  const transport = createCurrentCodeTransport({ target, rendererSha, request, readSecret });
  return {
    readCurrentCodeReference: () => transport.readCurrentCodeReference(),
    async readHistoricalCodeContext() {
      return qualifyHistoricalCodeContext(await transport.readCurrentCode());
    },
    async readCurrentCodeContext() {
      const qualified = await transport.readCurrentCode();
      if ((0, import_node_crypto7.createHash)("sha256").update(qualified.bytes).digest("hex") !== qualified.reference.manifest.sha256) {
        throw new Error("Qualified current CODE bytes differ");
      }
      const publicContext = assertContextMatchesPublication(JSON.parse(qualified.bytes.toString("utf8")), qualified.reference.publication);
      return { publicContext, publication: qualified.reference.publication, reference: qualified.reference };
    }
  };
}

// packages/content-core/src/newsletter-card-data.ts
function bodySummary(record3) {
  const text9 = (node) => {
    if (!node || typeof node !== "object") return "";
    const part = node;
    if (typeof part.text === "string") return part.text;
    return Array.isArray(part.content) ? part.content.map(text9).join(" ") : "";
  };
  return text9(record3.body).replace(/\s+/g, " ").trim().slice(0, 300);
}
function newsletterCardData(record3) {
  if (!record3 || record3.type !== "newsletter" || !record3.title?.trim()) return null;
  const raw = record3.signupUrl?.trim();
  let signupUrl;
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" && url.hostname && !url.username && !url.password && !/[\u0000-\u001F\u007F]/.test(raw)) signupUrl = url.href;
    } catch {
    }
  }
  if (!signupUrl) return null;
  const summary = record3.summary?.trim() || bodySummary(record3);
  return {
    title: record3.title.trim(),
    signupUrl,
    ...record3.frequency?.trim() ? { frequency: record3.frequency.trim() } : {},
    ...summary ? { summary } : {},
    ...record3.imageAssetId?.trim() ? {
      imageAssetId: record3.imageAssetId.trim(),
      imageAlt: record3.imageDecorative === true ? "" : record3.imageAlt ?? "",
      imageDecorative: record3.imageDecorative === true
    } : {}
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createCurrentCodeContextReader,
  newsletterCardData,
  projectHomeNewsletterRecord,
  qualifyHistoricalCodeContext,
  readPageSchedulePacket,
  readPreparedHomeSources,
  readRetainedHomeSources
});
