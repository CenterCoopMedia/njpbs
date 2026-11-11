// Generated from packages/content-core/src/home-source-catalog.ts.
// Regenerate with: node scripts/generate-home-source-catalog.mjs
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

// packages/content-core/src/home-source-catalog.ts
var home_source_catalog_exports = {};
__export(home_source_catalog_exports, {
  boundHomeNewsletterCatalog: () => boundHomeNewsletterCatalog,
  homeCatalogJson: () => homeCatalogJson,
  homePostPlacements: () => homePostPlacements,
  homeSectionsUsingPost: () => homeSectionsUsingPost,
  homeSelectedPostIds: () => homeSelectedPostIds,
  isHomeSelectedIds: () => isHomeSelectedIds,
  isHomeSelectionReceipt: () => isHomeSelectionReceipt,
  readHomeEditorialCatalog: () => readHomeEditorialCatalog,
  readHomeEditorialSourceReceipt: () => readHomeEditorialSourceReceipt,
  resolveHomeNewsletter: () => resolveHomeNewsletter,
  resolveHomeShelf: () => resolveHomeShelf
});
module.exports = __toCommonJS(home_source_catalog_exports);

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
var CONTENT_LINK_DIRECTORY_MAX_BYTES = 1024 * 1024;

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
function stationCalendarDay(value, timeZone = STATION_TIME_ZONE) {
  const local = instantToStationLocal(value, timeZone);
  return local === "" ? null : local.slice(0, 10);
}

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
function topicVariantIndex(topicSlug, publishedAt, seed) {
  const publishedDate = new Date(publishedAt ?? "");
  if (!Number.isNaN(publishedDate.getTime())) {
    const publishedDay = Math.floor(publishedDate.getTime() / MILLISECONDS_PER_DAY);
    return (publishedDay + stableHash(topicSlug)) % TOPIC_IMAGE_SUFFIXES.length;
  }
  return stableHash(seed) % TOPIC_IMAGE_SUFFIXES.length;
}
function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash ^ hash >>> 16) >>> 0;
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
function sourceHref(source, href) {
  if (source === "station_posts") return typeof href === "string" && /^\/posts\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(href);
  if (!isExactHttpsUrl(href, 2048) || href.includes("\\")) return false;
  const url = new URL(href);
  return !url.search && !url.hash && url.origin === (source === "spotlight_news" ? "https://www.njspotlightnews.org" : "https://watch.njpbs.org") && url.pathname !== "/";
}
function publicCard(value, source, cutoff) {
  if (!homeSourceObject(value) || value.source !== source || !homeSourceText(value.id, 2048) || !homeSourceText(value.title, 300) || !(sourceHref(source, value.href) || source === "station_posts" && value.contentLinkMode === "custom" && !contentLinkError(value) && value.href === new URL(value.contentLinkUrl).href)) return null;
  if (value.publishedAt !== void 0 && (homeSourceInstant(value.publishedAt) === null || homeSourceInstant(value.publishedAt) > cutoff)) return null;
  const image = source === "spotlight_news" ? spotlightStoryImage({
    image: homeSourceObject(value.image) ? value.image.url : void 0,
    fallbackImage: homeSourceObject(value.image) ? value.image.fallbackUrl : void 0
  }) : homeSourceImage(value.image);
  return {
    id: value.id,
    source,
    title: value.title,
    href: value.href,
    ...source === "station_posts" ? contentLinkMetadata(value) : {},
    ...homeSourceText(value.summary, 1e4) ? { summary: value.summary } : {},
    ...source === "station_posts" && isCoverageLabelId(value.coverageLabelId) ? { coverageLabelId: value.coverageLabelId } : {},
    ...homeSourceText(value.sourceLabel, 200) ? { sourceLabel: value.sourceLabel } : {},
    ...homeSourceText(value.byline, 2e3) ? { byline: value.byline } : {},
    ...source === "spotlight_news" && value.bylineSource === "coauthors-plus" ? { bylineSource: "coauthors-plus" } : {},
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
  if (!lock || cutoff === null || Object.keys(selection).some((key) => !["cutoffAt", "selectedIds", "limit"].includes(key))) {
    throw new Error("Home source selection is invalid.");
  }
  const limit = selection.limit ?? lock.cap;
  if (![3, 4, 6, 8, 12, 16, 24].includes(limit) || limit > lock.cap) throw new Error("Home source limit is invalid.");
  const ids = selection.selectedIds;
  if (ids !== void 0 && (!Array.isArray(ids) || ids.length > limit || ids.some((id) => !homeSourceText(id, 2048)) || new Set(ids).size !== ids.length)) {
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
  const selected = ids === void 0 ? eligible : ids.flatMap((id) => byId.has(id) ? [byId.get(id)] : []);
  return {
    section,
    source: lock.source,
    browseHref: lock.browseHref,
    cutoffAt: selection.cutoffAt,
    checkedAt: snapshot.checkedAt,
    cards: selected.slice(0, limit),
    missingIds: ids?.filter((id) => !byId.has(id)) ?? [],
    emptyReason: selected.length ? null : ids !== void 0 ? "selection_unavailable" : "source_empty"
  };
}

// packages/content-core/src/home-source-selection.ts
function isHomeSelectionReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value;
  return Object.keys(receipt).length === 4 && typeof receipt.buildBatchId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(receipt.buildBatchId) && Number.isSafeInteger(receipt.generation) && Number(receipt.generation) > 0 && typeof receipt.commitSha === "string" && /^[a-f0-9]{40}$/.test(receipt.commitSha) && typeof receipt.digest === "string" && /^[a-f0-9]{64}$/.test(receipt.digest);
}
function isHomeSelectedIds(value, maximum) {
  return Array.isArray(value) && value.length <= maximum && value.every((id) => typeof id === "string" && !!id.trim() && id.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(id)) && new Set(value).size === value.length;
}
function homeCatalogJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(homeCatalogJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${homeCatalogJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Home catalog contains invalid data.");
}

// packages/content-core/src/partner-player.ts
function extractPartnerPlayerSrc(playerCode) {
  if (!playerCode) return null;
  const source = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(playerCode)?.[1] ?? playerCode;
  let url;
  try {
    const value = source.trim().replaceAll("&amp;", "&");
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
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return isCalendarDay(date) ? date : null;
}
function isNewscastTitle(value) {
  return value === "NJ PBS News with Rob Nelson" || newscastTitleDate(value) !== null;
}

// packages/content-core/src/home-newscast-published.ts
function closed(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every((key) => typeof key === "string" && keys.includes(key));
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

// packages/content-core/src/datasets.ts
var MAX_DATASET_BYTES = 200 * 1024;

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
var PROMOTION_PLAYLIST_PLACEMENTS = [
  "before_start",
  "before_featured",
  "before_passport",
  "before_more",
  "before_spotlight"
];
var CONTENT_SHELF_SOURCE_SET = new Set(CONTENT_SHELF_SOURCES);
var CONTENT_SHELF_ITEM_LIMIT_SET = new Set(CONTENT_SHELF_ITEM_LIMITS);
var PROMOTION_PLAYLIST_PLACEMENT_SET = new Set(
  PROMOTION_PLAYLIST_PLACEMENTS
);
var SHELF_SORT_SET = new Set(SHELF_SORTS);
var SHELF_ITEM_LIMIT_SET = new Set(SHELF_ITEM_LIMITS);
var TOPIC_SHELF_SOURCE_SET = new Set(TOPIC_SHELF_SOURCES);
var VIDEO_LIBRARY_SET = new Set(VIDEO_LIBRARIES);

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

// packages/content-core/src/launch-fallback.ts
var passportLookupUrl = "https://www.pbs.org/passport/lookup/";
var donateUrl = "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport";
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

// packages/content-core/src/home-newsletter-source.ts
function adaptHomeNewsletter(settings, snapshot, cutoffAt) {
  const cutoff = homeSourceInstant(cutoffAt);
  if (cutoff === null || !homeSourceObject(settings) || Object.keys(settings).some((key) => !["newsletterIds", "actionLabel", "heading", "intro"].includes(key)) || !Array.isArray(settings.newsletterIds) || settings.newsletterIds.length > 4 || settings.newsletterIds.some((id) => !homeSourceText(id, 128)) || new Set(settings.newsletterIds).size !== settings.newsletterIds.length || !homeSourceText(settings.actionLabel, 120) || settings.heading !== void 0 && !homeSourceText(settings.heading, 120) || settings.intro !== void 0 && !homeSourceText(settings.intro, 2e3)) throw new Error("Home Newsletter settings are invalid.");
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
  const cards = [];
  for (const id of settings.newsletterIds) {
    const matches = snapshot.records.filter((record2) => homeSourceObject(record2) && record2.kind === "newsletter" && record2.id === id);
    const record = matches.length === 1 ? matches[0] : null;
    if (!homeSourceObject(record) || record.href !== null || !Number.isSafeInteger(record.sourceVersion) || Number(record.sourceVersion) < 1 || !homeSourceObject(record.newsletter) || !homeSourceObject(record.newsletter.card)) continue;
    const card = record.newsletter.card;
    if (!homeSourceText(card.title, 300) || !isExactHttpsUrl(card.signupUrl, 2048) || card.signupUrl.includes("\\")) continue;
    const image = homeSourceImage(record.newsletter.image && homeSourceObject(record.newsletter.image) ? { url: record.newsletter.image.url, alt: card.imageDecorative === true ? "" : card.imageAlt ?? "" } : void 0);
    cards.push({
      id,
      sourceVersion: Number(record.sourceVersion),
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
    cards,
    missingIds: settings.newsletterIds.filter((id) => !cards.some((card) => card.id === id)),
    emptyReason: cards.length ? null : "selection_unavailable"
  };
}

// packages/content-core/src/home-service-sources.ts
function projectHomeNewsletterRecord(record, checkedAt, cutoffAt) {
  if (!homeSourceObject(record) || typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id)) return null;
  const source = adaptHomeNewsletter(
    { newsletterIds: [record.id], actionLabel: "Sign up by email" },
    { status: "ready", checkedAt, records: [record] },
    cutoffAt
  );
  const card = source.cards[0];
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
function readHomeServiceSources(value, cutoffAt) {
  if (!homeSourceObject(value) || Object.keys(value).length !== (Object.hasOwn(value, "newscast") ? 2 : 1) || Object.keys(value).some((key) => !["newsletters", "newscast"].includes(key)) || !Object.hasOwn(value, "newsletters") || !homeSourceObject(value.newsletters)) {
    throw new Error("Home service sources are invalid.");
  }
  const newscast = Object.hasOwn(value, "newscast") ? readPublishedHomeNewscast(value.newscast) : void 0;
  if (newscast && newscast.cutoffAt !== cutoffAt) throw new Error("Newscast and Home catalog cutoffs differ.");
  const optional = newscast ? { newscast } : {};
  const snapshot = value.newsletters;
  if (snapshot.status === "error" && Object.keys(snapshot).length === 1 && Object.hasOwn(snapshot, "status")) return { newsletters: { status: "error" }, ...optional };
  const cutoff = homeSourceInstant(cutoffAt), checked = homeSourceInstant(snapshot.checkedAt);
  if (snapshot.status !== "ready" || Object.keys(snapshot).length !== 3 || Object.keys(snapshot).some((key) => !["status", "checkedAt", "records"].includes(key)) || cutoff === null || checked === null || checked > cutoff || !Array.isArray(snapshot.records) || snapshot.records.length > 200) throw new Error("Published Home Newsletters are invalid.");
  const records = snapshot.records.map((record) => projectHomeNewsletterRecord(record, String(snapshot.checkedAt), cutoffAt));
  if (records.some((record) => record === null) || homeCatalogJson(records) !== homeCatalogJson(snapshot.records) || new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error("Published Home Newsletters are invalid.");
  }
  return { newsletters: { status: "ready", checkedAt: String(snapshot.checkedAt), records }, ...optional };
}

// packages/content-core/src/home-source-catalog.ts
var sections = Object.keys(HOME_SOURCE_LOCKS);
var MAX_HOME_CATALOG_BYTES = 4e5;
function readHomeEditorialCatalog(value) {
  if (!homeSourceObject(value) || Object.keys(value).some((key) => !["schemaVersion", "cutoffAt", "sources", "services"].includes(key)) || Object.keys(value).length !== (Object.hasOwn(value, "services") ? 4 : 3) || value.schemaVersion !== 1 || homeSourceInstant(value.cutoffAt) === null || !homeSourceObject(value.sources) || Object.keys(value.sources).length !== sections.length) throw new Error("Home source catalog is invalid.");
  const sources = {};
  for (const section of sections) {
    const snapshot = value.sources[section];
    if (!homeSourceObject(snapshot)) throw new Error("Home source catalog is invalid.");
    if (snapshot.status === "error" && Object.keys(snapshot).length === 1) {
      sources[section] = { status: "error" };
      continue;
    }
    if (snapshot.status !== "ready" || Object.keys(snapshot).length !== 3 || !Array.isArray(snapshot.cards) || snapshot.cards.length > 200 || homeSourceInstant(snapshot.checkedAt) === null) throw new Error("Home source catalog is invalid.");
    const cards = snapshot.cards.flatMap((card) => curateHomeSource(
      section,
      { status: "ready", checkedAt: String(snapshot.checkedAt), cards: [card] },
      { cutoffAt: String(value.cutoffAt) }
    ).cards);
    if (homeCatalogJson(cards) !== homeCatalogJson(snapshot.cards) || new Set(cards.map((card) => card.id)).size !== cards.length) throw new Error("Home source catalog cards are invalid.");
    sources[section] = { status: "ready", checkedAt: String(snapshot.checkedAt), cards };
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
  for (const record of sorted) {
    const size = bytes(record) + (records.length ? 1 : 0);
    if (used + size > MAX_HOME_CATALOG_BYTES) continue;
    records.push(record);
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
function resolveHomeShelf(block, catalog) {
  const section = block.section;
  const lock = Object.hasOwn(HOME_SOURCE_LOCKS, section) ? HOME_SOURCE_LOCKS[section] : void 0;
  if (!lock || block.data.source !== lock.source || block.data.moreHref !== lock.browseHref) {
    throw new Error("Keep the Home shelf's assigned source and approved destination.");
  }
  return curateHomeSource(section, catalog.sources[section], {
    cutoffAt: catalog.cutoffAt,
    limit: block.data.itemLimit,
    ...block.data.selectedIds === void 0 ? {} : { selectedIds: block.data.selectedIds }
  });
}
function homeSectionsUsingPost(blocks, postId) {
  return blocks.flatMap((block) => block.visible !== false && block.type === "content_shelf" && block.section === "home-posts" && homeSourceObject(block.data) && block.data.source === "station_posts" && (block.data.selectedIds === void 0 || Array.isArray(block.data.selectedIds) && block.data.selectedIds.includes(postId)) ? [{ blockId: block.id, section: "home-posts", title: String(block.data.title) }] : []);
}
function homePostPlacements(snapshot, postId, slugs = [], metadata) {
  const blocks = snapshot.blocks ?? [];
  const canonical = blocks.filter((block) => typeof block.id === "string" && typeof block.type === "string" && block.data !== void 0);
  const placements = homeSectionsUsingPost(canonical, postId).map((section) => ({ ...section, refreshable: true }));
  const paths = new Set(slugs.map((slug) => `/posts/${slug}`));
  function mentions(value) {
    if (typeof value === "string") {
      if (value === postId) return true;
      const links = [value, ...[...value.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])];
      return links.some((link) => {
        try {
          const url = new URL(link, "https://njpbs.org");
          return url.origin === "https://njpbs.org" && paths.has(url.pathname.replace(/\/index\.html\/?$/, "/").replace(/\/$/, ""));
        } catch {
          return false;
        }
      });
    }
    return Array.isArray(value) ? value.some(mentions) : homeSourceObject(value) ? Object.values(value).some(mentions) : false;
  }
  for (const [index, block] of blocks.entries()) {
    const blockId = block.id ?? `legacy-block-${index}`;
    if (block.visible !== false && !placements.some((placement) => placement.blockId === blockId) && mentions(block)) {
      placements.push({ blockId, section: block.section ?? "content", title: block.section ?? "Home content", refreshable: false });
    }
  }
  const hero = snapshot.homeHero;
  if (homeSourceObject(hero)) {
    const labels = hero.mode === "category" ? metadata?.categories : metadata?.tags;
    const pinned = hero.mode !== "manual" && Array.isArray(hero.pins) && hero.pins.some((pin) => homeSourceObject(pin) && pin.source === "cms_posts" && pin.sourceId === postId);
    if (hero.mode === "manual" && Array.isArray(hero.items)) {
      const bound = hero.items.some((item) => homeSourceObject(item) && item.source === "cms_posts" && item.sourceId === postId);
      const legacy = hero.items.some((item) => homeSourceObject(item) && !item.sourceId && mentions(item));
      if (bound || legacy) placements.push({ blockId: "hero", section: "hero", title: "Home hero", refreshable: !legacy });
    } else if (pinned || hero.source === "cms_posts" && ["category", "tag"].includes(String(hero.mode)) && (!Array.isArray(labels) || hero.mode === "tag" && metadata?.showInHomeHero === true || (hero.mode === "tag" && Array.isArray(hero.values) ? hero.values : [hero.value]).some((value) => labels.includes(value)))) {
      placements.push({ blockId: "hero", section: "hero", title: "Home hero", refreshable: true });
    }
  }
  return placements;
}
function homeSelectedPostIds(snapshot) {
  const ids = (snapshot.blocks ?? []).flatMap((block) => block.section === "home-posts" && homeSourceObject(block.data) && Array.isArray(block.data.selectedIds) ? block.data.selectedIds.filter((id) => typeof id === "string") : []);
  const hero = snapshot.homeHero;
  if (homeSourceObject(hero) && hero.mode === "manual" && Array.isArray(hero.items)) {
    for (const item of hero.items) if (homeSourceObject(item) && item.source === "cms_posts" && typeof item.sourceId === "string") ids.push(item.sourceId);
  }
  if (homeSourceObject(hero) && hero.mode !== "manual" && Array.isArray(hero.pins)) {
    for (const pin of hero.pins) if (homeSourceObject(pin) && pin.source === "cms_posts" && typeof pin.sourceId === "string") ids.push(pin.sourceId);
  }
  return [...new Set(ids)];
}
function resolveHomeNewsletter(block, catalog) {
  const { selectionReceipt: _receipt, ...settings } = block.data;
  return adaptHomeNewsletter(
    {
      newsletterIds: settings.newsletterIds,
      actionLabel: settings.actionLabel?.trim() ? settings.actionLabel : "Sign up by email",
      ...settings.heading?.trim() ? { heading: settings.heading } : {},
      ...settings.intro?.trim() ? { intro: settings.intro } : {}
    },
    catalog.services?.newsletters ?? { status: "error" },
    catalog.cutoffAt
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  boundHomeNewsletterCatalog,
  homeCatalogJson,
  homePostPlacements,
  homeSectionsUsingPost,
  homeSelectedPostIds,
  isHomeSelectedIds,
  isHomeSelectionReceipt,
  readHomeEditorialCatalog,
  readHomeEditorialSourceReceipt,
  resolveHomeNewsletter,
  resolveHomeShelf
});
