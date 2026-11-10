"use strict";
const { isTownLookupData } = require("./town-lookup");
const { isSafeHref } = require("./safe-href");
const { isDataHubSectionData, dataHubCompositionError } = require("./data-hub-composition");
const { isHomeSelectedIds, isHomeSelectionReceipt } = require("./home-source-catalog");

// A CommonJS mirror of the block validation in
// packages/content-core/src/content-model.ts (parseBlocks and its helpers).
// The Cloud Functions runtime is CommonJS and
// cannot import the TypeScript model, but the server must re-validate a saved
// block payload with exactly the model's semantics -- it must not trust the
// client, and it must not fork the contract the renderer and editor share.
//
// This file is that contract, hand-mirrored. It is kept in sync by a
// cross-language parity test (site/tests/content-blocks-parity.test.ts) that
// feeds one shared case table through both this validator and the canonical
// TypeScript parseBlocks and asserts identical { ok, error } results. The mirror
// is behavioral, not byte-for-byte (one file is TS, one is JS), so the parity
// test -- not textual equality -- is what pins them together. Change the
// canonical model and this file together, and let the parity test prove they
// still agree.

const { contentLayoutError, visibleLayoutBlocks, isRowData } = require("./content-layout");

const { isDataFigureData } = require("./data-figure");
const { isCountyComparisonData } = require("./county-comparison");
const { isElectionResultsData } = require("./election-results");
const { isDataTableData } = require("./data-table");
const { isDocumentListData } = require("./document-list");
const { isCalendarDay } = require("./editorial-dates");
const { isBioCardData } = require("./bio-profiles");
const { isHomeNewscastData } = require("./home-newscast-data");
const { isVideoBlockData } = require("./video-block");

const BLOCK_TYPES = [
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
  "divider",
];

const BLOCK_TYPE_SET = new Set(BLOCK_TYPES);
const LINK_CARD_LIMITS = Object.freeze({ title: 250, source: 120, summary: 500, url: 2000 });
const LINK_CARD_DATA_KEY_SET = new Set(["title", "url", "source", "date", "summary"]);
const HTML_BLOCK_LIMITS = Object.freeze({ html: 50000, title: 200 });
const HTML_DATA_KEY_SET = new Set(["html", "title"]);
const EMBED_WIDTH_LIMITS = Object.freeze({ min: 160, max: 4096 });
const EMBED_HEIGHT_LIMITS = Object.freeze({ min: 90, max: 4096 });
const AP_MAP_MOBILE_HEIGHT_LIMITS = Object.freeze({ min: 320, max: 4096 });
const EMBED_ASPECT_RATIO_LIMITS = Object.freeze({ min: 9 / 16, max: 21 / 9 });
const CONTENT_SHELF_SOURCE_SET = new Set([
  "pbs_featured",
  "pbs_more",
  "spotlight_news",
  "station_posts",
]);
const CONTENT_SHELF_ITEM_LIMIT_SET = new Set([3, 4, 6, 8, 12, 16, 24]);
const CONTENT_SHELF_PRESENTATION_SET = new Set(["rail", "grid", "two_features", "list"]);
const CONTENT_SHELF_COLUMN_SET = new Set([2, 3, 4]);
const PROMOTION_PLAYLIST_PLACEMENT_SET = new Set([
  "before_start",
  "before_featured",
  "before_passport",
  "before_more",
  "before_spotlight",
]);
const PROMOTION_PLAYLIST_PRESENTATION_SET = new Set(["rail", "grid", "list"]);
const PROMOTION_PLAYLIST_COLUMN_SET = new Set([2, 3, 4]);
const PROMOTION_PLAYLIST_DATA_KEY_SET = new Set([
  "title",
  "placement",
  "presentation",
  "columns",
  "cards",
]);
const PROMOTION_PLAYLIST_CARD_KEY_SET = new Set([
  "itemId",
  "title",
  "summary",
  "imageAssetId",
  "alt",
  "altDecorative",
  "href",
]);
// The gallery presentations the public renderer has (#1034). Mirrors GALLERY_PRESENTATIONS in
// packages/content-core/src/content-model.ts: accepting a mode here that the site parser refuses
// would store a save the next public build cannot read.
const GALLERY_PRESENTATION_SET = new Set(["grid", "carousel"]);
// The dynamic-shelf vocabularies (#1046). Mirrors dynamic-shelves.ts: the server
// accepting a topic, source, library, cap, or sort the site parser refuses would store a
// query the next public build cannot resolve.
const SHELF_TOPIC_SET = new Set([
  "budget",
  "business",
  "delaney-hall",
  "energy-environment",
  "immigration",
  "social-issues",
]);
const SHELF_SORT_SET = new Set(["newest", "oldest", "curated"]);
const SHELF_ITEM_LIMIT_SET = new Set([3, 4, 6, 8, 12]);
const TOPIC_SHELF_SOURCE_SET = new Set(["njpbs_related_index"]);
const VIDEO_LIBRARY_SET = new Set(["njpbs_watch", "pbs_national"]);
const SHELF_PIN_MAX = 6;
const TOPIC_SHELF_DATA_KEY_SET = new Set([
  "title",
  "topic",
  "source",
  "itemLimit",
  "sort",
  "pinned",
]);
const VIDEO_PLAYLIST_DATA_KEY_SET = new Set([
  "title",
  "topic",
  "library",
  "itemLimit",
  "sort",
  "pinned",
]);
const CONTENT_SHELF_DATA_KEY_SET = new Set([
  "title",
  "source",
  "itemLimit",
  "moreLabel",
  "moreHref",
  "presentation",
  "columns",
  "selectedIds",
  "selectionReceipt",
]);

function isRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOptionalString(value) {
  return value === undefined || typeof value === "string";
}

function isOptionalEmbedDimension(value, limits) {
  return value === undefined || (
    Number.isInteger(value) &&
    value >= limits.min &&
    value <= limits.max
  );
}

function hasValidEmbedAspectRatio(width, height) {
  if (width === undefined || height === undefined) return true;
  if (typeof width !== "number" || typeof height !== "number") return false;
  const ratio = width / height;
  return ratio >= EMBED_ASPECT_RATIO_LIMITS.min && ratio <= EMBED_ASPECT_RATIO_LIMITS.max;
}

function isRichTextNode(value) {
  if (typeof value !== "object" || value === null) return false;
  const node = value;
  if (typeof node.type !== "string" || node.type === "bio") return false;
  if (node.attrs !== undefined && !isRecord(node.attrs)) return false;
  if (node.text !== undefined && typeof node.text !== "string") return false;
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return false;
    for (const child of node.content) if (!isRichTextNode(child)) return false;
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) return false;
    for (const mark of node.marks) {
      if (typeof mark !== "object" || mark === null) return false;
      const candidate = mark;
      if (
        typeof candidate.type !== "string" ||
        (candidate.attrs !== undefined && !isRecord(candidate.attrs))
      ) {
        return false;
      }
      // Inline biographies are not a supported authoring format.
      if (candidate.type === "bio") return false;
    }
  }
  return true;
}

function isRichTextDoc(value) {
  return isRichTextNode(value) && value.type === "doc" && Array.isArray(value.content);
}

function isOptionalCollectionItemId(value) {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

function hasUniqueCollectionItemIds(items) {
  const seen = new Set();
  for (const item of items) {
    if (!isRecord(item)) return false;
    const itemId = item.itemId;
    if (itemId === undefined) continue;
    if (typeof itemId !== "string" || itemId.trim().length === 0) return false;
    if (seen.has(itemId)) return false;
    seen.add(itemId);
  }
  return true;
}

function isImageData(value) {
  if (!isRecord(value)) return false;
  if (!(value.altDecorative === undefined || typeof value.altDecorative === "boolean")) {
    return false;
  }
  // Mirrors the TypeScript parser: decorative and described are opposite claims, and the
  // pair is refused here so a write that never touches the editor cannot publish it.
  if (value.altDecorative === true && value.alt !== "") return false;
  return (
    isOptionalCollectionItemId(value.itemId) &&
    typeof value.assetId === "string" &&
    typeof value.alt === "string" &&
    isOptionalString(value.caption)
  );
}

// Mirrors isImageBlockData in content-model.ts.
function isImageBlockData(value) {
  if (!isImageData(value)) return false;
  if (!isOptionalString(value.href) || !(value.newTab === undefined || typeof value.newTab === "boolean")) {
    return false;
  }
  return !(value.altDecorative === true && typeof value.href === "string" && value.href.trim().length > 0);
}

// Mirrors isValidShelfPins in content-model.ts: pins outrank the query, so an unbounded
// or repeating pin list is refused at the write boundary rather than trimmed at render.
function isValidShelfPins(value) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > SHELF_PIN_MAX) return false;
  const seen = new Set();
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    if (Reflect.ownKeys(entry).some((key) => key !== "id")) return false;
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) return false;
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
  }
  return true;
}

// Mirrors hasValidShelfQuery in content-model.ts. The closed key set is the half that
// matters most on the server: it is what stops a write that never touches the editor from
// storing a free-text query or a baked copy of today's cards inside a dynamic block.
function hasValidShelfQuery(data, keys) {
  return (
    Reflect.ownKeys(data).every((key) => typeof key === "string" && keys.has(key)) &&
    typeof data.title === "string" &&
    typeof data.topic === "string" &&
    SHELF_TOPIC_SET.has(data.topic) &&
    typeof data.itemLimit === "number" &&
    SHELF_ITEM_LIMIT_SET.has(data.itemLimit) &&
    typeof data.sort === "string" &&
    SHELF_SORT_SET.has(data.sort) &&
    isValidShelfPins(data.pinned)
  );
}

const COVERAGE_LIST_LIMITS = Object.freeze({
  title: 250,
  outlet: 120,
  url: 2000,
  entries: 100,
});
const COVERAGE_LIST_DATA_KEY_SET = new Set(["entries"]);
const COVERAGE_ENTRY_KEY_SET = new Set(["title", "outlet", "date", "url"]);

function isCoverageEntry(value) {
  if (!isRecord(value)) return false;
  if (!Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && COVERAGE_ENTRY_KEY_SET.has(key),
  )) {
    return false;
  }
  return (
    typeof value.title === "string" &&
    value.title.length <= COVERAGE_LIST_LIMITS.title &&
    typeof value.outlet === "string" &&
    value.outlet.length <= COVERAGE_LIST_LIMITS.outlet &&
    typeof value.date === "string" &&
    (value.date.length === 0 || isCalendarDay(value.date)) &&
    typeof value.url === "string" &&
    value.url.length <= COVERAGE_LIST_LIMITS.url
  );
}

function isCoverageListData(data) {
  return (
    Reflect.ownKeys(data).every(
      (key) => typeof key === "string" && COVERAGE_LIST_DATA_KEY_SET.has(key),
    ) &&
    Array.isArray(data.entries) &&
    data.entries.length <= COVERAGE_LIST_LIMITS.entries &&
    data.entries.every(isCoverageEntry)
  );
}

function hasValidPromotionPlaylistCard(card, publishable) {
  if (!isRecord(card)) return false;
  const decorative = card.altDecorative === true;
  return (
    Reflect.ownKeys(card).every(
      (key) => typeof key === "string" && PROMOTION_PLAYLIST_CARD_KEY_SET.has(key)
    ) &&
    typeof card.itemId === "string" &&
    card.itemId.trim().length > 0 &&
    typeof card.title === "string" &&
    typeof card.summary === "string" &&
    typeof card.imageAssetId === "string" &&
    typeof card.alt === "string" &&
    (card.altDecorative === undefined || typeof card.altDecorative === "boolean") &&
    (!decorative || card.alt === "") &&
    typeof card.href === "string" &&
    (!publishable ||
      (card.title.trim().length > 0 &&
        card.summary.trim().length > 0 &&
        card.imageAssetId.trim().length > 0 &&
        isSafeHref(card.href)))
  );
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
      return (
        typeof data.text === "string" &&
        (data.level === undefined ||
          (typeof data.level === "number" && Number.isFinite(data.level)))
      );
    case "prose":
      return isRichTextDoc(data.content);
    case "image":
      return isImageBlockData(data);
    case "video":
      return isVideoBlockData(data, publishable);
    case "image_gallery":
      return (
        Array.isArray(data.images) &&
        data.images.every(isImageData) &&
        hasUniqueCollectionItemIds(data.images) &&
        (data.presentation === undefined ||
          (typeof data.presentation === "string" &&
            GALLERY_PRESENTATION_SET.has(data.presentation)))
      );
    case "cta_row":
      return (
        Array.isArray(data.ctas) &&
        data.ctas.every((cta) => {
          if (!isRecord(cta)) return false;
          return (
            typeof cta.label === "string" &&
            typeof cta.href === "string" &&
            (cta.variant === undefined ||
              cta.variant === "primary" ||
              cta.variant === "secondary")
          );
        })
      );
    case "card_grid":
      return (
        Array.isArray(data.cards) &&
        data.cards.every((card) => {
          if (!isRecord(card)) return false;
          return (
            typeof card.title === "string" &&
            isOptionalCollectionItemId(card.itemId) &&
            isOptionalString(card.label) &&
            (card.body === undefined || isRichTextDoc(card.body)) &&
            isOptionalString(card.imageAssetId) &&
            isOptionalString(card.href)
          );
        }) &&
        hasUniqueCollectionItemIds(data.cards)
      );
    case "link_card":
      return (
        Reflect.ownKeys(data).every(
          (key) => typeof key === "string" && LINK_CARD_DATA_KEY_SET.has(key)
        ) &&
        typeof data.title === "string" && data.title.length <= LINK_CARD_LIMITS.title &&
        typeof data.url === "string" && data.url.length <= LINK_CARD_LIMITS.url &&
        isOptionalString(data.source) &&
        (data.source === undefined || data.source.length <= LINK_CARD_LIMITS.source) &&
        isOptionalString(data.date) &&
        (data.date === undefined || data.date.length === 0 || isCalendarDay(data.date)) &&
        isOptionalString(data.summary) &&
        (data.summary === undefined || data.summary.length <= LINK_CARD_LIMITS.summary) &&
        (!publishable || (
          data.title.trim().length > 0 &&
          isSafeHref(data.url)
        ))
      );
    case "faq_item":
      return typeof data.question === "string" && isRichTextDoc(data.answer);
    case "coverage_list":
      return isCoverageListData(data);
    case "data_table":
      return isDataTableData(data, publishable);
    case "embed":
      return (
        typeof data.url === "string" &&
        isOptionalString(data.host) &&
        isOptionalString(data.caption) &&
        isOptionalString(data.heading) &&
        (data.mapSize === undefined || (typeof data.mapSize === "string" && ["small", "medium", "large"].includes(data.mapSize))) &&
        (data.mapWidth === undefined || (typeof data.mapWidth === "string" && ["content", "wide"].includes(data.mapWidth))) &&
        isOptionalEmbedDimension(data.mobileHeight, AP_MAP_MOBILE_HEIGHT_LIMITS) &&
        isOptionalEmbedDimension(data.width, EMBED_WIDTH_LIMITS) &&
        isOptionalEmbedDimension(data.height, EMBED_HEIGHT_LIMITS) &&
        hasValidEmbedAspectRatio(data.width, data.height)
      );
    case "html":
      return (
        Reflect.ownKeys(data).every(
          (key) => typeof key === "string" && HTML_DATA_KEY_SET.has(key)
        ) &&
        typeof data.html === "string" &&
        data.html.length <= HTML_BLOCK_LIMITS.html &&
        (data.title === undefined ||
          (typeof data.title === "string" && data.title.length <= HTML_BLOCK_LIMITS.title)) &&
        (!publishable || data.html.trim().length > 0)
      );
    case "content_shelf":
      return (
        Reflect.ownKeys(data).every(
          (key) => typeof key === "string" && CONTENT_SHELF_DATA_KEY_SET.has(key)
        ) &&
        typeof data.title === "string" &&
        typeof data.source === "string" &&
        CONTENT_SHELF_SOURCE_SET.has(data.source) &&
        typeof data.itemLimit === "number" &&
        CONTENT_SHELF_ITEM_LIMIT_SET.has(data.itemLimit) &&
        typeof data.moreLabel === "string" &&
        typeof data.moreHref === "string" &&
        (data.presentation === undefined || CONTENT_SHELF_PRESENTATION_SET.has(data.presentation)) &&
        (data.columns === undefined || CONTENT_SHELF_COLUMN_SET.has(data.columns)) &&
        (data.selectedIds === undefined && data.selectionReceipt === undefined ||
          isHomeSelectedIds(data.selectedIds, data.itemLimit) && isHomeSelectionReceipt(data.selectionReceipt))
      );
    case "promotion_playlist":
      return (
        Reflect.ownKeys(data).every(
          (key) => typeof key === "string" && PROMOTION_PLAYLIST_DATA_KEY_SET.has(key)
        ) &&
        typeof data.title === "string" &&
        typeof data.placement === "string" &&
        PROMOTION_PLAYLIST_PLACEMENT_SET.has(data.placement) &&
        (data.presentation === undefined ||
          (typeof data.presentation === "string" &&
            PROMOTION_PLAYLIST_PRESENTATION_SET.has(data.presentation))) &&
        (data.columns === undefined ||
          (typeof data.columns === "number" &&
            PROMOTION_PLAYLIST_COLUMN_SET.has(data.columns))) &&
        Array.isArray(data.cards) &&
        hasUniqueCollectionItemIds(data.cards) &&
        data.cards.every((card) => hasValidPromotionPlaylistCard(card, publishable)) &&
        (!publishable ||
          (data.title.trim().length > 0 &&
            data.cards.length >= 1 &&
            data.cards.length <= 12))
      );
    case "home_newscast":
      return isHomeNewscastData(data, false);
    case "newsletter_signup":
      return Reflect.ownKeys(data).every(key => typeof key === "string" && ["newsletterIds", "heading", "intro", "actionLabel", "selectionReceipt", "backgroundImageAssetId"].includes(key))
        && Array.isArray(data.newsletterIds)
        && data.newsletterIds.length <= 4
        && data.newsletterIds.every(id => typeof id === "string" && id.trim().length > 0)
        && new Set(data.newsletterIds).size === data.newsletterIds.length
        && (data.heading === undefined || typeof data.heading === "string")
        && (data.intro === undefined || typeof data.intro === "string")
        && (data.actionLabel === undefined || typeof data.actionLabel === "string")
        && (data.selectionReceipt === undefined || isHomeSelectionReceipt(data.selectionReceipt))
        && (!publishable || homeNewsletter || data.newsletterIds.length >= 1);
    case "topic_shelf":
      return (
        hasValidShelfQuery(data, TOPIC_SHELF_DATA_KEY_SET) &&
        typeof data.source === "string" &&
        TOPIC_SHELF_SOURCE_SET.has(data.source)
      );
    case "video_playlist":
      return (
        hasValidShelfQuery(data, VIDEO_PLAYLIST_DATA_KEY_SET) &&
        typeof data.library === "string" &&
        VIDEO_LIBRARY_SET.has(data.library)
      );
    case "record_card":
      return Reflect.ownKeys(data).every(key =>
        typeof key === "string" && ["recordKind", "recordId", "variant"].includes(key))
        && ["program", "event", "sponsor", "newsletter"].includes(data.recordKind)
        && typeof data.recordId === "string"
        && (!publishable && data.recordId === "" || /^[A-Za-z0-9_-]{1,128}$/.test(data.recordId))
        && (data.variant === undefined || data.variant === "card" || data.variant === "compact");
    case "sponsor_strip":
      return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["heading", "sponsorIds", "layout"].includes(key))
        && (data.heading === undefined || (typeof data.heading === "string" && data.heading.length <= 120))
        && (data.layout === "row" || data.layout === "grid")
        && Array.isArray(data.sponsorIds)
        && data.sponsorIds.length >= (publishable ? 1 : 0)
        && data.sponsorIds.length <= 12
        && data.sponsorIds.every((id) => typeof id === "string" && id.trim().length > 0)
        && new Set(data.sponsorIds).size === data.sponsorIds.length;
    case "row":
      return isRowData(data);
    case "divider":
      return Reflect.ownKeys(data).length === 0;
    default:
      return false;
  }
}

// Validate a stored `blocks` value against the ADR 0013 envelope. Returns
// { ok: true, blocks } or { ok: false, error }; never throws. Mirrors the
// canonical parseBlocks in content-model.ts, including its error strings, so the
// server's rejection reason matches the one the editor and loader would give.
function parseBlocks(input, { complete = true, pageId } = {}) {
  if (!Array.isArray(input)) {
    return { ok: false, error: "blocks must be an array" };
  }
  const seenIds = new Set();
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
    if (block.section !== undefined && typeof block.section !== "string") {
      return { ok: false, error: `blocks[${i}] has a non-string section` };
    }
    if (!isRecord(block.data)) {
      return { ok: false, error: `blocks[${i}] is missing a data object` };
    }
    if (Object.hasOwn(block.data, "backgroundImageAssetId")) {
      const band = block.section === "home-newsletter" && block.type === "newsletter_signup" ||
        block.section === "home-passport-copy" && block.type === "prose" ||
        block.section === "home-donor" && block.type === "card_grid";
      if (!band || pageId !== undefined && pageId !== "home" ||
          typeof block.data.backgroundImageAssetId !== "string" ||
          !/^[A-Za-z0-9_-]{0,128}$/.test(block.data.backgroundImageAssetId)) {
        return { ok: false, error: "Home band background requires a media asset id on its named Home section." };
      }
    }
    if (block.section === "home-newsletter" && pageId !== undefined && pageId !== "home") {
      return { ok: false, error: "The Home Newsletter bar belongs only on Home." };
    }
    if (block.type === "home_newscast" && block.section !== "home-newscast") {
      return { ok: false, error: "Newscast requires its named Home section." };
    }
    if (block.type === "newsletter_signup" && block.section !== "home-newsletter" &&
        (block.data.actionLabel !== undefined || block.data.selectionReceipt !== undefined)) {
      return { ok: false, error: "Home Newsletter fields require the named Home bar." };
    }
    if (!hasValidBlockData(block.type, block.data, block.type === "data_table" ? false : complete && block.visible, block.section === "home-newsletter")) {
      return { ok: false, error: `blocks[${i}] has invalid data for ${block.type}` };
    }
  }
  if (pageId === "kids" && input.some(block => block.type === "record_card" && block.data.recordKind === "newsletter")) {
    return { ok: false, error: "Newsletter record cards are not allowed on the Kids page" };
  }
  const hubError = dataHubCompositionError(input, pageId);
  if (hubError) return { ok: false, error: hubError };
  const layoutError = contentLayoutError(input);
  if (layoutError) return { ok: false, error: layoutError };
  // Completeness follows row visibility after the row grammar is validated.
  for (const block of visibleLayoutBlocks(input)) {
    if (complete && block.type === "data_table" && !isDataTableData(block.data, true)) {
      return { ok: false, error: `blocks[${input.findIndex((entry) => entry.id === block.id)}] has invalid data for data_table` };
    }
  }
  return { ok: true, blocks: input };
}

module.exports = {
  BLOCK_TYPES,
  isRichTextDoc,
  parseBlocks,
};
