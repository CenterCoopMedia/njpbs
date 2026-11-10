// Generated from packages/content-core/src/home-hero.ts.
// Regenerate with: node scripts/generate-home-hero.mjs
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

// packages/content-core/src/home-hero.ts
var home_hero_exports = {};
__export(home_hero_exports, {
  HOME_HERO_ACTION_MAX_LENGTH: () => HOME_HERO_ACTION_MAX_LENGTH,
  HOME_HERO_HEADING_MAX_LENGTH: () => HOME_HERO_HEADING_MAX_LENGTH,
  HOME_HERO_LIMIT: () => HOME_HERO_LIMIT,
  HOME_HERO_PIN_LIMIT: () => HOME_HERO_PIN_LIMIT,
  HOME_HERO_PRESENTATIONS: () => HOME_HERO_PRESENTATIONS,
  HOME_HERO_SOURCES: () => HOME_HERO_SOURCES,
  HOME_HERO_SOURCE_CAPABILITIES: () => HOME_HERO_SOURCE_CAPABILITIES,
  HOME_HERO_SUPPORTING_COUNTS: () => HOME_HERO_SUPPORTING_COUNTS,
  HOME_HERO_TAG_LIMIT: () => HOME_HERO_TAG_LIMIT,
  HOME_HERO_TAG_MAX_LENGTH: () => HOME_HERO_TAG_MAX_LENGTH,
  homeHeroAssetIds: () => homeHeroAssetIds,
  homeHeroHref: () => homeHeroHref,
  homeHeroIsVideo: () => homeHeroIsVideo,
  homeHeroNeedsPageRefresh: () => homeHeroNeedsPageRefresh,
  parseHomeHero: () => parseHomeHero,
  readHomeHeroCatalog: () => readHomeHeroCatalog,
  resolveHomeHero: () => resolveHomeHero
});
module.exports = __toCommonJS(home_hero_exports);

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

// packages/content-core/src/home-hero.ts
var HOME_HERO_LIMIT = 10;
var HOME_HERO_PIN_LIMIT = 3;
var HOME_HERO_TAG_LIMIT = 20;
var HOME_HERO_TAG_MAX_LENGTH = 200;
var HOME_HERO_SOURCES = ["cms_posts", "media_manager", "spotlight"];
var HOME_HERO_PRESENTATIONS = ["carousel", "editorial"];
var HOME_HERO_SUPPORTING_COUNTS = [1, 2, 3];
var HOME_HERO_HEADING_MAX_LENGTH = 120;
var HOME_HERO_ACTION_MAX_LENGTH = 80;
var HOME_HERO_SOURCE_CAPABILITIES = {
  cms_posts: { label: "Published posts", category: true, tag: true },
  media_manager: { label: "PBS Media Manager", category: false, tag: false },
  spotlight: { label: "NJ Spotlight News", category: true, tag: false }
};
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Home hero must be an object.");
  return value;
}
function text(value, field, maximum, required = false) {
  if (value === void 0 && !required) return void 0;
  if (typeof value !== "string" || value.length > maximum || required && !value.trim()) throw new Error(`Home hero ${field} is invalid.`);
  return value;
}
function keys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Home hero has unsupported fields.");
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
function homeHeroIsVideo(item) {
  if (item.source === "media_manager") return true;
  return homeHeroHref(item.href) && new URL(item.href, "https://njpbs.org").hostname === "watch.njpbs.org";
}
function parseHomeHero(value) {
  if (value === void 0) return void 0;
  const config = object(value);
  keys(config, ["mode", "source", "value", "values", "limit", "items", "pins", "presentation", "supportingCount", "leadHeading", "supportingHeading", "overflowHeading"]);
  if (!["manual", "category", "tag"].includes(String(config.mode))) throw new Error("Choose a Home hero selection mode.");
  if (config.presentation !== void 0 && !HOME_HERO_PRESENTATIONS.includes(config.presentation)) throw new Error("Choose a supported Home hero presentation.");
  if (config.supportingCount !== void 0 && !HOME_HERO_SUPPORTING_COUNTS.includes(config.supportingCount)) throw new Error("Choose one, two or three supporting stories.");
  text(config.leadHeading, "lead heading", HOME_HERO_HEADING_MAX_LENGTH);
  text(config.supportingHeading, "supporting heading", HOME_HERO_HEADING_MAX_LENGTH);
  text(config.overflowHeading, "overflow heading", HOME_HERO_HEADING_MAX_LENGTH);
  if (config.limit !== void 0 && (!Number.isInteger(config.limit) || Number(config.limit) < 1 || Number(config.limit) > HOME_HERO_LIMIT)) throw new Error("Home hero supports one to ten slides.");
  if (config.mode !== "manual") {
    if (config.pins !== void 0) {
      if (!Array.isArray(config.pins) || config.pins.length > HOME_HERO_PIN_LIMIT) throw new Error("Home hero supports up to three pins.");
      const seen2 = /* @__PURE__ */ new Set();
      for (const value2 of config.pins) {
        const pin = object(value2);
        keys(pin, ["source", "sourceId", "endsAt"]);
        if (!["cms_posts", "cms_pages"].includes(String(pin.source)) || typeof pin.sourceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(pin.sourceId) || pin.source === "cms_pages" && pin.sourceId === "home") {
          throw new Error("Home hero pins must reference a Post or Page.");
        }
        const identity = `${pin.source}:${pin.sourceId}`;
        if (seen2.has(identity)) throw new Error("Home hero pins must be unique.");
        seen2.add(identity);
        if (pin.endsAt !== void 0 && (typeof pin.endsAt !== "string" || parsePublishInstant(pin.endsAt) === null)) throw new Error("Home hero pin end time must be a UTC instant.");
      }
    }
    if (!HOME_HERO_SOURCES.includes(config.source) || config.items !== void 0) throw new Error("Home hero source is invalid.");
    const source = config.source;
    if (!HOME_HERO_SOURCE_CAPABILITIES[source][config.mode]) throw new Error("This Home hero source does not provide that classification.");
    if (config.mode === "tag" && config.values !== void 0) {
      if (config.value !== void 0) throw new Error("Home hero tags cannot use both a list and a single value.");
      if (!Array.isArray(config.values) || config.values.length < 1 || config.values.length > HOME_HERO_TAG_LIMIT) {
        throw new Error(`Home hero tags: Add one to ${HOME_HERO_TAG_LIMIT} tags.`);
      }
      const seen2 = /* @__PURE__ */ new Set();
      for (const tag of config.values) {
        if (typeof tag !== "string" || !tag || tag !== tag.trim() || tag.length > HOME_HERO_TAG_MAX_LENGTH || seen2.has(tag)) {
          throw new Error(`Home hero tags must be unique, trimmed text of one to ${HOME_HERO_TAG_MAX_LENGTH} characters.`);
        }
        seen2.add(tag);
      }
    } else {
      if (config.values !== void 0) throw new Error("Home hero tag lists belong only to tag mode.");
      text(config.value, "classification", 200, true);
    }
    return { ...config };
  }
  if (config.pins !== void 0 || config.source !== void 0 || config.value !== void 0 || config.values !== void 0 || !Array.isArray(config.items) || config.items.length > HOME_HERO_LIMIT) throw new Error("Home hero manual selection is invalid.");
  const seen = /* @__PURE__ */ new Set();
  const items = config.items.map((value2) => {
    const item = object(value2);
    keys(item, ["itemId", "title", "summary", "href", "imageAssetId", "alt", "altDecorative", "source", "sourceId", "actionLabel"]);
    const id = text(item.itemId, "slide id", 200, true);
    if (seen.has(id)) throw new Error("Home hero slide ids must be unique.");
    seen.add(id);
    const bound = item.source !== void 0 || item.sourceId !== void 0;
    if (bound) {
      if (!HOME_HERO_SOURCES.includes(item.source)) throw new Error("Home hero slide source is invalid.");
      text(item.sourceId, "source item", item.source === "cms_posts" ? 128 : 2048, true);
      if (item.source === "cms_posts" && !/^[A-Za-z0-9_-]+$/.test(String(item.sourceId))) throw new Error("Home hero Post source id is invalid.");
    }
    text(item.title, "title", 300, !bound);
    text(item.summary, "summary", 2e3);
    text(item.actionLabel, "button text", HOME_HERO_ACTION_MAX_LENGTH);
    if (typeof item.actionLabel === "string" && /[<>\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(item.actionLabel)) {
      throw new Error("Home hero button text must be plain text on one line.");
    }
    const href = text(item.href, "destination", 2048, !bound) ?? "";
    if (href.trim() && !homeHeroHref(href)) throw new Error("Home hero destination must be a web address or site path.");
    text(item.imageAssetId, "image", 128);
    if (item.imageAssetId && !/^[A-Za-z0-9_-]+$/.test(String(item.imageAssetId))) throw new Error("Home hero image must be a station media id.");
    text(item.alt, "image description", 1e3);
    if (item.altDecorative !== void 0 && typeof item.altDecorative !== "boolean") throw new Error("Home hero decorative image choice is invalid.");
    if (item.altDecorative && item.alt) throw new Error("A decorative Home hero image must have an empty description.");
    return { ...item, title: item.title ?? "", summary: item.summary ?? "", href };
  });
  return {
    mode: "manual",
    ...config.limit === void 0 ? {} : { limit: Number(config.limit) },
    ...config.presentation === void 0 ? {} : { presentation: config.presentation },
    ...config.supportingCount === void 0 ? {} : { supportingCount: config.supportingCount },
    ...config.leadHeading === void 0 ? {} : { leadHeading: config.leadHeading },
    ...config.supportingHeading === void 0 ? {} : { supportingHeading: config.supportingHeading },
    ...config.overflowHeading === void 0 ? {} : { overflowHeading: config.overflowHeading },
    items
  };
}
function homeHeroAssetIds(value) {
  return [...new Set((parseHomeHero(value)?.items ?? []).map((item) => item.imageAssetId).filter((id) => Boolean(id)))];
}
function homeHeroNeedsPageRefresh(value, changedPageIds, now) {
  const config = parseHomeHero(value);
  return (config?.pins ?? []).some((pin) => pin.source === "cms_pages" && changedPageIds.includes(pin.sourceId) || pin.endsAt !== void 0 && parsePublishInstant(pin.endsAt) <= now);
}
function resolveHomeHero(value, catalog, assets = {}, now = Date.now()) {
  const config = parseHomeHero(value);
  if (!config) return [];
  const sources = catalog.map((card) => card.source === "spotlight" ? { ...card, byline: spotlightCardByline(card) } : card);
  const limit = config.limit ?? HOME_HERO_LIMIT;
  const cards = config.mode === "manual" ? (config.items ?? []).flatMap((item) => {
    const source = item.source ? sources.find((card) => card.source === item.source && card.id === item.sourceId) : void 0;
    if (item.source === "cms_posts" && !source) return [];
    const nativePost = sources.find((card) => card.source === "cms_posts" && card.href === item.href);
    const datedSource = source ?? nativePost;
    const creditedSource = item.source === "cms_posts" || !item.href.trim() || source?.href === item.href ? source : nativePost;
    const image = item.imageAssetId ? assets[item.imageAssetId] : source?.image;
    const destination = source?.contentLinkMode === "custom" ? source : nativePost;
    const href = destination?.contentLinkMode === "custom" ? contentLink(destination, destination.href).href : item.href.trim() ? item.href : source?.href ?? item.href;
    const actionLabel = item.actionLabel?.trim() || (homeHeroIsVideo({ source: item.source, href }) ? "Watch the report" : void 0);
    return [{
      id: item.itemId,
      title: item.title.trim() ? item.title : source?.title ?? item.title,
      summary: item.summary.trim() ? item.summary : source?.summary ?? item.summary,
      href,
      ...destination || source ? contentLinkMetadata(destination ?? source) : {},
      ...creditedSource?.byline ? { byline: creditedSource.byline } : {},
      ...datedSource?.displayDate ? { displayDate: datedSource.displayDate } : {},
      ...source?.eyebrow ? { eyebrow: source.eyebrow } : {},
      ...actionLabel ? { actionLabel } : {},
      ...(item.source === "cms_posts" ? source : nativePost)?.coverageLabelId ? { coverageLabelId: (item.source === "cms_posts" ? source : nativePost).coverageLabelId } : {},
      ...(item.source === "cms_posts" ? source : nativePost)?.spotlightNews === true ? { spotlightNews: true } : {},
      ...image ? { image: { ...image, ...item.imageAssetId ? { alt: item.altDecorative ? "" : item.alt ?? "" } : {} } } : {}
    }];
  }) : [...(config.pins ?? []).flatMap((pin) => {
    if (pin.endsAt !== void 0 && parsePublishInstant(pin.endsAt) <= now) return [];
    const card = sources.find((item) => item.source === pin.source && item.id === pin.sourceId);
    return card ? [card] : [];
  }), ...sources.filter((item) => {
    if (item.source !== config.source) return false;
    if (config.mode === "category") return item.categories.includes(config.value);
    return item.source === "cms_posts" && item.showInHomeHero === true || (config.values ?? [config.value]).some((tag) => item.tags.includes(tag));
  })];
  const seen = /* @__PURE__ */ new Set();
  return cards.map((card) => ({ ...card, href: contentLink(card, card.href).href })).filter((card) => {
    if (!card.title.trim() || !homeHeroHref(card.href) || seen.has(card.href)) return false;
    seen.add(card.href);
    return true;
  }).slice(0, limit).map(({ id, title, summary, href, eyebrow, image, displayDate, spotlightNews, coverageLabelId, byline, actionLabel, ...linkSettings }) => ({
    id,
    title,
    summary,
    href,
    ...contentLinkMetadata(linkSettings),
    ...byline?.trim() ? { byline } : {},
    ...actionLabel ? { actionLabel } : {},
    ...spotlightNews === true ? { spotlightNews: true } : {},
    ...isCoverageLabelId(coverageLabelId) ? { coverageLabelId } : {},
    ...isCalendarDay(displayDate) ? { displayDate } : {},
    ...eyebrow ? { eyebrow } : {},
    ...image && homeHeroHref(image.url) ? { image } : {}
  }));
}
function readHomeHeroCatalog(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || value.length > 500) throw new Error("Home hero source catalog is invalid.");
  return value.map((value2) => {
    const item = object(value2);
    if (item.source !== "cms_pages" && !HOME_HERO_SOURCES.includes(item.source)) throw new Error("Home hero catalog source is invalid.");
    const id = text(item.id, "source id", 2048, true);
    const title = text(item.title, "source title", 300, true);
    const summary = text(item.summary, "source summary", 1e4) ?? "";
    const href = text(item.href, "source destination", 2048, true);
    if (item.showInHomeHero !== void 0 && typeof item.showInHomeHero !== "boolean") throw new Error("Home hero source selection must be a boolean.");
    if (!homeHeroHref(href)) throw new Error("Home hero source destination is invalid.");
    const labels = (value3) => {
      if (!Array.isArray(value3) || value3.length > 100) throw new Error("Home hero source classification is invalid.");
      return value3.map((label) => text(label, "source classification", 200, true));
    };
    let image;
    if (item.image !== void 0) {
      const raw = object(item.image);
      if (item.source === "spotlight") {
        image = spotlightStoryImage({
          image: raw.url,
          fallbackImage: raw.fallbackUrl,
          topicSlug: Array.isArray(item.categories) ? item.categories[0] : void 0,
          href
        });
      } else {
        const url = text(raw.url, "source image", 2048, true);
        if (!homeHeroHref(url)) throw new Error("Home hero source image is invalid.");
        const thumbnails = cmsImageThumbnails(raw);
        image = {
          url,
          alt: text(raw.alt, "source image description", 1e3) ?? "",
          ...Number.isSafeInteger(raw.width) && Number(raw.width) > 0 ? { width: Number(raw.width) } : {},
          ...Number.isSafeInteger(raw.height) && Number(raw.height) > 0 ? { height: Number(raw.height) } : {},
          ...thumbnails.length ? { thumbnails } : {}
        };
      }
    }
    return {
      id,
      title,
      summary,
      href,
      source: item.source,
      ...contentLinkMetadata(item),
      categories: labels(item.categories),
      tags: labels(item.tags),
      ...item.source === "cms_posts" && item.showInHomeHero === true ? { showInHomeHero: true } : {},
      ...item.byline === void 0 ? {} : { byline: text(item.byline, "source byline", 2e3) },
      ...item.source === "spotlight" && item.bylineSource === "coauthors-plus" ? { bylineSource: "coauthors-plus" } : {},
      ...item.source === "cms_posts" && isCoverageLabelId(item.coverageLabelId) ? { coverageLabelId: item.coverageLabelId } : {},
      ...item.source === "cms_posts" && item.spotlightNews === true ? { spotlightNews: true } : {},
      ...isCalendarDay(item.displayDate) ? { displayDate: item.displayDate } : {},
      ...item.eyebrow === void 0 ? {} : { eyebrow: text(item.eyebrow, "source name", 200) },
      ...image ? { image } : {}
    };
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HOME_HERO_ACTION_MAX_LENGTH,
  HOME_HERO_HEADING_MAX_LENGTH,
  HOME_HERO_LIMIT,
  HOME_HERO_PIN_LIMIT,
  HOME_HERO_PRESENTATIONS,
  HOME_HERO_SOURCES,
  HOME_HERO_SOURCE_CAPABILITIES,
  HOME_HERO_SUPPORTING_COUNTS,
  HOME_HERO_TAG_LIMIT,
  HOME_HERO_TAG_MAX_LENGTH,
  homeHeroAssetIds,
  homeHeroHref,
  homeHeroIsVideo,
  homeHeroNeedsPageRefresh,
  parseHomeHero,
  readHomeHeroCatalog,
  resolveHomeHero
});
