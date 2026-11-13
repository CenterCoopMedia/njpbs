"use strict";

const { isPostLeadMedia } = require("./post-lead-media");
const { parseHomeHero } = require("./home-hero");

const PAGE_THEMES = Object.freeze(["default", "nj-decides"]);
const PAGE_THEME_ERROR = "pageTheme must be default or nj-decides";

function isPageTheme(value) {
  return PAGE_THEMES.includes(value);
}

function pageThemeError(value) {
  return value === undefined || isPageTheme(value) ? null : PAGE_THEME_ERROR;
}

// Validation and normalization for editor-visible page/post metadata. This module checks the
// fields the CMS understands while deliberately allowing unknown siblings inside metadata
// groups: old imports and future integrations can round-trip vendor-specific values without
// weakening the type contract of the fields the admin actually edits.

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STRING_FIELDS = [
  "title",
  "name",
  "summary",
  "excerpt",
  "author",
  "heroImage",
  "heroBackgroundImage",
  "heroImageAlt",
  "heroImageCaption",
  "keyArt",
  "keyArtAssetId",
  "keyArtAlt",
  "watchUrl",
  "logoAlt",
  "homeHeroTitle",
  "homeHeroSubtitle",
];

function validateStringField(owner, key, prefix = "") {
  if (owner[key] !== undefined && typeof owner[key] !== "string") {
    return `${prefix}${key} must be a string`;
  }
  return null;
}

function validateMetadataGroup(document, key, fields) {
  if (document[key] === undefined) return null;
  if (!isPlainObject(document[key])) return `${key} must be an object`;
  for (const field of fields) {
    const error = validateStringField(document[key], field, `${key}.`);
    if (error) return error;
  }
  return null;
}

function validateCalendarDateField(document, key) {
  const typeError = validateStringField(document, key);
  if (typeError || document[key] === undefined) return typeError;
  // Blank is the post whose editorial date is derived from its first publish (#1041).
  if (document[key].trim() === "") return null;
  try {
    assertRealCalendarDate(document[key], key);
    return null;
  } catch (error) {
    return error.message;
  }
}

function validateKnownMetadata(document, { descriptionIsString = true } = {}) {
  if (document.childDirected !== undefined && typeof document.childDirected !== "boolean") {
    return "childDirected must be a boolean";
  }
  const linkError = require("./content-link").contentLinkError(document);
  if (linkError) return linkError;
  const themeError = pageThemeError(document.pageTheme);
  if (themeError) return themeError;
  if (document.serviceCompositionVersion !== undefined && document.serviceCompositionVersion !== 1) {
    return "The service composition version is invalid.";
  }
  if (document.dataHubCompositionVersion !== undefined && document.dataHubCompositionVersion !== 1) {
    return "The Data Hub composition version is invalid.";
  }
  try { require("./data-hub-reporting").parseDataHubReporting(document.dataHubReporting); }
  catch (error) { return error.message; }
  try { parseHomeHero(document.homeHero); }
  catch (error) { return error.message; }
  for (const field of STRING_FIELDS) {
    const error = validateStringField(document, field);
    if (error) return error;
  }
  if (document.heroBackgroundPosition !== undefined &&
      !["", "center", "top", "bottom"].includes(document.heroBackgroundPosition)) {
    return "heroBackgroundPosition must be center, top, or bottom";
  }
  // `date` is the calendar-only editorial field on post records. Legacy pages and
  // other cmsPosts record kinds can carry unrelated root values with the same key,
  // so their values remain opaque to this shared metadata boundary.
  if (document.type === "post") {
    if (document.disableStoryCtas !== undefined && typeof document.disableStoryCtas !== "boolean") {
      return "disableStoryCtas must be a boolean";
    }
    if (document.leadMedia != null && !isPostLeadMedia(document.leadMedia, false)) return "Check the lead media details.";
    if (document.coverageLabelId !== undefined && document.coverageLabelId !== null && !require("./cms-settings-contract").isCoverageLabelId(document.coverageLabelId)) return "coverageLabelId must be a valid coverage label id";
    if (document.spotlightNews !== undefined && typeof document.spotlightNews !== "boolean") {
      return "spotlightNews must be a boolean";
    }
    if (document.showInHomeHero !== undefined && typeof document.showInHomeHero !== "boolean") {
      return "showInHomeHero must be a boolean";
    }
    const editorialDateError = validateCalendarDateField(document, "date");
    if (editorialDateError) return editorialDateError;
    if (
      document.heroImageDecorative !== undefined &&
      typeof document.heroImageDecorative !== "boolean"
    ) {
      return "heroImageDecorative must be a boolean";
    }
  }
  if (
    document.type === "program" &&
    document.keyArtDecorative !== undefined &&
    typeof document.keyArtDecorative !== "boolean"
  ) {
    return "keyArtDecorative must be a boolean";
  }
  if (
    document.type === "sponsor" &&
    document.logoDecorative !== undefined &&
    typeof document.logoDecorative !== "boolean"
  ) {
    return "logoDecorative must be a boolean";
  }
  // Canonical page summaries are plain text. cmsPosts also contains program/event
  // descriptions as TipTap documents, so the save boundary disables this one page-specific
  // check for that collection rather than rejecting valid existing rich text.
  if (descriptionIsString) {
    const descriptionError = validateStringField(document, "description");
    if (descriptionError) return descriptionError;
  }
  const listFields = document.type === "post" ? ["categories", "tags"] : ["tags"];
  for (const field of listFields) {
    if (
      document[field] !== undefined &&
      (!Array.isArray(document[field]) ||
        document[field].some((value) => typeof value !== "string"))
    ) {
      return `${field} must be an array of strings`;
    }
  }
  const seoError = validateMetadataGroup(document, "seo", ["title", "description"]);
  if (seoError) return seoError;
  if (document.seo?.noindex !== undefined && typeof document.seo.noindex !== "boolean") {
    return "seo.noindex must be a boolean";
  }
  return validateMetadataGroup(document, "social", [
    "title",
    "description",
    "imageAssetId",
  ]);
}

// slugBase used to live here. It minted an EditorialBase slug with no reserved-word list and
// no length bound, while the public build judged the stored value against a stricter rule --
// so a post titled "New" saved fine and then failed the whole strict publish build. Minting
// now goes through the shared contract in ./post-slug-contract.js, which the public build
// imports too. Do not reintroduce a second, looser slug minter here.

// EditorialBase stores a true ISO-8601 instant. Date controls submit YYYY-MM-DD, which means
// midnight UTC; a full parseable instant is canonicalized so semantically equal values do not
// drift in format. Blank is the documented “publish now” choice.
// A calendar date is real only if it survives a parse/format round trip. Date rolls a day
// overflow forward instead of rejecting it, so Feb 31 parses fine and comes back as Mar 3.
// Month and hour overflows are caught by the parser itself (NaN); the day is the gap.
function assertRealCalendarDate(datePart, field = "publishAt") {
  const date = new Date(`${datePart}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== datePart) {
    throw new Error(`${field} must be a valid date`);
  }
  return date;
}

// Posts saved before the calendar-only contract can carry their editorial date as an ISO
// instant. Publish paths call this on the server-read working copy before applying any client
// fields, so that legacy value can migrate while a newly submitted instant still reaches the
// strict validator unchanged and is rejected.
function normalizeLegacyPostDate(document) {
  if (document?.type !== "post") return document;
  if (typeof document.date === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(document.date)) return document;
    const datePrefix = document.date.match(/^(\d{4}-\d{2}-\d{2})[T ]/i)?.[1];
    if (datePrefix === undefined) return document;
    try {
      assertRealCalendarDate(datePrefix, "date");
    } catch {
      return document;
    }
    if (Number.isNaN(new Date(document.date).getTime())) return document;
    // The editorial date is the calendar day the source literally recorded. An offset may put
    // that instant on the next UTC day, but migration must not rewrite the authored day.
    return { ...document, date: datePrefix };
  }

  let instant;
  if (document.date instanceof Date) {
    instant = document.date;
  } else if (
    typeof document.date === "object" &&
    document.date !== null &&
    typeof document.date.toDate === "function"
  ) {
    instant = document.date.toDate();
  }
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return document;
  // A Timestamp has no authored offset or literal calendar day, so UTC is the stable convention.
  return { ...document, date: instant.toISOString().slice(0, 10) };
}

// EditorialBase stores a true ISO-8601 instant. Date controls submit YYYY-MM-DD, which means
// midnight UTC; a full parseable instant is canonicalized so semantically equal values do not
// drift in format. Blank is the documented “publish now” choice.
function normalizePublishAt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error("publishAt must be a valid date");
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return assertRealCalendarDate(trimmed).toISOString();
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new Error("publishAt must be a valid date");
  // Validate the date the caller literally wrote, not the canonicalized UTC one. An input
  // carrying an offset can legitimately land on a different UTC day (2026-02-28T20:00-05:00
  // is Mar 1 in UTC), so comparing against the result would reject valid instants; and a
  // rolled-forward Feb 31 would compare equal to itself and slip through.
  // Date also accepts a lowercase ISO separator, so match it before parsing can roll an
  // impossible calendar day forward.
  const isoDatePrefix = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T ]/i);
  if (isoDatePrefix) assertRealCalendarDate(isoDatePrefix[1]);
  return date.toISOString();
}

module.exports = {
  PAGE_THEME_ERROR,
  isPlainObject,
  isPageTheme,
  normalizeLegacyPostDate,
  normalizePublishAt,
  pageThemeError,
  validateKnownMetadata,
};
