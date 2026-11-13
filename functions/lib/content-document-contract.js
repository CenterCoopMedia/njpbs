"use strict";

// Server mirror of the fields the CMS editor owns in
// packages/content-core/src/editor-admin.ts. Firebase deploys functions/ alone,
// so this CommonJS table cannot import the TypeScript catalog at runtime. The
// parity test compares every editor-visible root and required flag to prevent
// drift. Structural fields that the server supplies or the block editor owns
// are listed beside that mirrored catalog.

const { isRichTextDoc } = require("./content-blocks");
const { bioPlacementError } = require("./bio-profiles");
const { isMediaAssetId } = require("./media-library");
const {
  PUBLISH_BUILD_PENDING_FIELD,
  PUBLISH_BUILD_QUEUE_FIELD,
  PUBLISH_BUILD_SETTLEMENT_FIELD,
  PUBLIC_SOURCE_VERSION_FIELD,
} = require("./publish-build-state");
const {
  SERVER_MANAGED_EDITORIAL_DATE_FIELDS,
} = require("./editorial-dates");
const { normalizeStoryCredits } = require("./story-credits");
const { parseLiveBlogDraft, assertLiveBlogReady } = require("./live-blog");
const { postPresentationTagError } = require("./post-formats");
const { isPostLeadMedia } = require("./post-lead-media");
const { parsePublishInstant } = require("./publish-instant");
const { pageThemeError } = require("./content-metadata");

const SERVER_MANAGED_CONTENT_FIELDS = Object.freeze([
  "id",
  "slug",
  "previousSlugs",
  "locale",
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "assignee",
  // Immutable submit attribution plus the current reviewable version. Lifecycle,
  // save, and assignment boundaries own this envelope; the browser may not
  // manufacture or rewrite a review request.
  "reviewRequest",
  "electionResultsApprovals",
  // The scoped-grant desk (#619). Server-managed for the same reason as createdBy: it is
  // an authorization fact, so a client that could write it through the document overlay
  // could move a record into a desk it holds a grant for. A page takes it from its public
  // area on every save; a record takes it from the create request and keeps it after that.
  "section",
  "unassignedDraft",
  "deleted",
  "deletedAt",
  "deletedBy",
  "published",
  "publiclyVisible",
  PUBLISH_BUILD_PENDING_FIELD,
  PUBLISH_BUILD_QUEUE_FIELD,
  PUBLISH_BUILD_SETTLEMENT_FIELD,
  PUBLIC_SOURCE_VERSION_FIELD,
  // Background public checks can advance without changing the working draft.
  "publicPostProof",
  "version",
  "contentVersion",
  "contentSaveGroup",
  // The accepted future transport cannot be changed by an editor overlay.
  "scheduledPublicationTransport",
  // Exact-attempt receipt for the explicit Home draft conversion. Restore keeps
  // the current receipt; historical editor fields cannot renew an old attempt.
  "homeConversionReceipt",
  // The publication-date facts the server mints and a client may never assert
  // (#1041): when the story first published, who published it, whether its
  // displayed date is derived or deliberately backdated, and when it was last
  // meaningfully updated. The editor's own date controls -- `date`,
  // `recordMeaningfulUpdate`, `showUpdatedDate` -- stay in the post contract below.
  ...SERVER_MANAGED_EDITORIAL_DATE_FIELDS,
]);

const SERVER_MANAGED_CONTENT_FIELD_SET = new Set(SERVER_MANAGED_CONTENT_FIELDS);

function contract(fields, required, structuralRequired = []) {
  return Object.freeze({
    fields: Object.freeze({ ...fields }),
    required: Object.freeze([...required]),
    structuralRequired: Object.freeze([...structuralRequired]),
  });
}

const COMMON_RECORD_FIELDS = {
  type: "type",
  status: "string",
  publishAt: "publishAt",
};

const DISCOVERABILITY_FIELDS = {
  seo: "object",
  social: "object",
};

const CONTENT_DOCUMENT_CONTRACTS = Object.freeze({
  page: contract(
    {
      template: "string",
      title: "text",
      childDirected: "boolean",
      pageTheme: "pageTheme",
      description: "string",
      heroBackgroundImage: "assetId",
      heroBackgroundPosition: "string",
      homeHeroTitle: "text",
      homeHeroSubtitle: "text",
      homeHero: "object",
      dataHubCompositionVersion: "dataHubCompositionVersion",
      dataHubReporting: "object",
      contentLinkMode: "string", contentLinkUrl: "string", contentLinkNewTab: "boolean",
      ...DISCOVERABILITY_FIELDS,
      status: "string",
      publishAt: "publishAt",
      blocks: "blocks",
      homeCompositionVersion: "homeCompositionVersion",
      serviceCompositionVersion: "serviceCompositionVersion",
    },
    ["title"],
    ["blocks"],
  ),
  program: contract(
    {
      ...COMMON_RECORD_FIELDS,
      title: "text",
      genre: "string",
      description: "richText",
      keyArt: "string",
      keyArtAssetId: "assetId",
      keyArtAlt: "string",
      keyArtDecorative: "boolean",
      watchUrl: "string",
      memberOnly: "boolean",
    },
    ["title", "description"],
    ["type"],
  ),
  staff: contract(
    {
      ...COMMON_RECORD_FIELDS,
      name: "text",
      role: "text",
      bio: "richText",
    },
    ["name", "role", "bio"],
    ["type"],
  ),
  event: contract(
    {
      ...COMMON_RECORD_FIELDS,
      title: "text",
      startsAt: "instant",
      endsAt: "instant",
      location: "string",
      venueAddress: "string",
      onlineUrl: "string",
      imageAssetId: "assetId",
      imageAlt: "string",
      imageDecorative: "boolean",
      registrationUrl: "string",
      registrationLabel: "string",
      isFree: "boolean",
      priceText: "string",
      description: "richText",
    },
    ["title", "startsAt", "description"],
    ["type"],
  ),
  sponsor: contract(
    {
      ...COMMON_RECORD_FIELDS,
      name: "text",
      href: "text",
      logoAssetId: "assetId",
      logoAlt: "string",
      logoDecorative: "boolean",
      tier: "string",
      description: "string",
      activeFrom: "calendarDate",
      activeUntil: "calendarDate",
    },
    ["name", "href"],
    ["type"],
  ),
  newsletter: contract(
    {
      ...COMMON_RECORD_FIELDS,
      title: "text",
      body: "richText",
      signupUrl: "string",
      frequency: "string",
      summary: "string",
      imageAssetId: "assetId",
      imageAlt: "string",
      imageDecorative: "boolean",
    },
    ["title", "body"],
    ["type"],
  ),
  post: contract(
    {
      ...COMMON_RECORD_FIELDS,
      spotlightNews: "boolean",
      coverageLabelId: "coverageLabelId",
      showInHomeHero: "boolean",
      disableStoryCtas: "boolean",
      title: "text",
      summary: "string",
      excerpt: "string",
      // Blank on purpose for a post whose date is derived from its first publish.
      date: "calendarDate",
      recordMeaningfulUpdate: "boolean",
      showUpdatedDate: "boolean",
      // The ordered byline (#1040). The single free-text `author` this replaced is
      // deliberately absent from the contract: a stored legacy value round-trips
      // through save.js's unchanged-legacy-field path, and the first byline edit
      // converts it to one custom credit and drops it.
      credits: "storyCredits",
      liveBlog: "liveBlog",
      categories: "stringList",
      tags: "stringList",
      heroBackgroundImage: "assetId",
      heroBackgroundPosition: "string",
      leadMedia: "leadMedia",
      heroImage: "assetId",
      heroImageAlt: "string",
      heroImageDecorative: "boolean",
      heroImageCaption: "string",
      contentLinkMode: "string", contentLinkUrl: "string", contentLinkNewTab: "boolean",
      ...DISCOVERABILITY_FIELDS,
      blocks: "blocks",
    },
    // `date` is deliberately not required. Requiring it made the day an editor
    // started a draft the day the post claimed to have published (#1041); the
    // display date now comes from the moment publication completed, and the field
    // is only filled in to deliberately backdate a story.
    ["title"],
    ["type", "tags", "blocks"],
  ),
});

// Kinds a shipped model once accepted and that this boundary now refuses outright.
// Article was retired in #1039 and generic Staff in #1227. A retired kind is
// rejected by name rather than falling through the unknown-type path, so an editor
// (or an old client still holding the route) is told what happened instead of being
// handed a generic validation failure.
const RETIRED_CONTENT_KINDS = Object.freeze({
  article:
    "The Article type was retired. Create a Post instead; a stored Article is read-only.",
  staff:
    "The generic Staff record was retired. Use Staff profiles instead; a stored Staff record is read-only.",
});

function retiredContentKindError(kind) {
  return typeof kind === "string" &&
    Object.prototype.hasOwnProperty.call(RETIRED_CONTENT_KINDS, kind)
    ? RETIRED_CONTENT_KINDS[kind]
    : null;
}

function contractFor(collection, kind) {
  if (collection === "cmsPages" && kind === "page") {
    return CONTENT_DOCUMENT_CONTRACTS.page;
  }
  if (
    collection === "cmsPosts" &&
    kind !== "page" &&
    typeof kind === "string" &&
    Object.prototype.hasOwnProperty.call(CONTENT_DOCUMENT_CONTRACTS, kind)
  ) {
    return CONTENT_DOCUMENT_CONTRACTS[kind];
  }
  return null;
}

function unsupportedContentFields(collection, kind, document) {
  const selected = contractFor(collection, kind);
  if (!selected || typeof document !== "object" || document === null) return [];
  return Object.keys(document).filter(
    (field) =>
      !Object.prototype.hasOwnProperty.call(selected.fields, field) &&
      !SERVER_MANAGED_CONTENT_FIELD_SET.has(field),
  );
}

function richTextIsEmpty(document) {
  const hasText = (node) =>
    (typeof node?.text === "string" && node.text.trim().length > 0) ||
    (Array.isArray(node?.content) && node.content.some(hasText));
  return !document.content.some(hasText);
}

function realCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function fieldTypeError(field, rule, value, kind) {
  switch (rule) {
    case "coverageLabelId":
      return value === undefined || value === null || require("./cms-settings-contract").isCoverageLabelId(value)
        ? null : `${field} must be a valid coverage label id`;
    case "liveBlog":
      if (value === null) return null;
      try { parseLiveBlogDraft(value); return null; }
      catch (error) { return error.message; }
    case "leadMedia":
      return value === null || isPostLeadMedia(value, false) ? null : "Check the lead media kind, URL, image or video details.";
    case "homeCompositionVersion":
      return value === 1 || value === 2 ? null : "The Home composition version is invalid.";
    case "dataHubCompositionVersion":
      return value === 1 ? null : "The Data Hub composition version is invalid.";
    case "serviceCompositionVersion":
      return value === 1 ? null : "The service composition version is invalid.";
    case "pageTheme":
      return pageThemeError(value);
    case "type":
      return value === kind ? null : `type must be ${kind}`;
    case "text":
    case "string":
      return typeof value === "string" ? null : `${field} must be a string`;
    case "boolean":
      return typeof value === "boolean" ? null : `${field} must be a boolean`;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? null
        : `${field} must be an object`;
    case "stringList":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? null
        : `${field} must be an array of strings`;
    case "assetId":
      return value === "" || isMediaAssetId(value)
        ? null
        : `${field} must be a valid media asset id`;
    case "blocks":
      return Array.isArray(value) ? null : `${field} must be an array`;
    case "storyCredits": {
      // Shape, bounds, and sanitization only. Whether a credited author exists and
      // is active is a Firestore read, so save.js owns that half; this stays a
      // pure field check like every other rule in this table.
      const normalized = normalizeStoryCredits(value);
      return normalized.ok ? null : normalized.errors[0];
    }
    case "richText":
      return isRichTextDoc(value) ? null : `${field} must be a rich-text document`;
    case "calendarDate":
      if (typeof value !== "string") return `${field} must be a string`;
      // Blank means "no deliberate editorial date"; the server derives one.
      if (value.trim() === "") return null;
      return realCalendarDate(value) ? null : `${field} must be a valid date`;
    case "instant":
      return parsePublishInstant(value) !== null
        ? null
        : `${field} must be a valid date`;
    case "publishAt":
      // save.js owns the exact blank-or-ISO normalization contract.
      return value === null || typeof value === "string"
        ? null
        : `${field} must be a valid date`;
    default:
      return `${field} has an unknown validation rule`;
  }
}

function fieldIsMissing(document, field, rule) {
  if (!Object.prototype.hasOwnProperty.call(document, field)) return true;
  const value = document[field];
  if (rule === "text" || rule === "calendarDate" || rule === "instant") {
    return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
  }
  if (rule === "richText") return value === undefined || value === null || (isRichTextDoc(value) && richTextIsEmpty(value));
  return value === undefined || value === null;
}

// Refuses only the contradiction: a decorative image must carry empty alt text. Empty
// alt text on a described image is allowed; the editor warns about it and a nightly
// sweep fills it (#242).
function stationImageAccessibilityError(document, kind) {
  // An explicit lead owns its accessibility; retained legacy fields are inactive.
  if (kind === "post" && document.leadMedia !== undefined) return null;
  const fields =
    kind === "post"
      ? {
          asset: "heroImage",
          alt: "heroImageAlt",
          decorative: "heroImageDecorative",
        }
      : kind === "program"
        ? { asset: "keyArtAssetId", alt: "keyArtAlt", decorative: "keyArtDecorative" }
      : kind === "event"
        ? { asset: "imageAssetId", alt: "imageAlt", decorative: "imageDecorative" }
      : kind === "sponsor"
        ? {
            asset: "logoAssetId",
            alt: "logoAlt",
            decorative: "logoDecorative",
          }
        : kind === "newsletter"
          ? {
              asset: "imageAssetId",
              alt: "imageAlt",
              decorative: "imageDecorative",
            }
        : null;
  if (!fields) return null;
  const assetId = document[fields.asset];
  if (typeof assetId !== "string" || assetId.trim() === "") return null;
  const alt = document[fields.alt];
  if (document[fields.decorative] === true && alt !== "") {
    return `${fields.alt} must be empty when ${fields.decorative} is true`;
  }
  return null;
}

function validateContentFieldValues(
  collection,
  kind,
  document,
  {
    complete = false,
    validateTypes = true,
    validateAccessibility = true,
  } = {},
) {
  // Fail closed before any field work: a retired kind has no contract, so nothing
  // below could admit one, but the caller gets the reason rather than "unknown type".
  const retired = retiredContentKindError(kind);
  if (retired) return retired;
  const selected = contractFor(collection, kind);
  if (!selected) return `Unknown content type ${String(kind)}`;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return "document must be an object";
  }

  if (validateTypes) {
    for (const [field, rule] of Object.entries(selected.fields)) {
      if (!Object.prototype.hasOwnProperty.call(document, field)) continue;
      const error = fieldTypeError(field, rule, document[field], kind);
      if (error) return error;
    }
    if (collection === "cmsPosts" && kind === "sponsor") {
      if (typeof document.tier === "string" && document.tier.length > 80) return "tier must be 80 characters or fewer";
      if (typeof document.description === "string" && document.description.length > 280) return "description must be 280 characters or fewer";
      if (document.activeFrom && document.activeUntil && document.activeFrom > document.activeUntil) return "activeUntil must be on or after activeFrom";
    }
    if (
      collection === "cmsPosts" && kind === "newsletter"
    ) {
      const url = document.signupUrl;
      if (typeof url === "string" && url.trim() !== "") {
        try {
          const parsed = new URL(url);
          const hasControl = Array.from(url).some((char) => {
            const code = char.charCodeAt(0);
            return code < 32 || code === 127;
          });
          if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || hasControl) return "signupUrl must be an HTTPS link";
        } catch { return "signupUrl must be an HTTPS link"; }
      }
      if (typeof document.summary === "string" && document.summary.length > 300) return "summary must be at most 300 characters";
      if (typeof document.frequency === "string" && document.frequency.length > 60) return "frequency must be at most 60 characters";
    }
    if (
      collection === "cmsPosts" &&
      kind === "post" &&
      Object.hasOwn(document, "tags")
    ) {
      const tagError = postPresentationTagError(document.tags);
      if (tagError) return tagError;
    }
  }
  if (complete && kind === "post" && document.leadMedia != null && !isPostLeadMedia(document.leadMedia)) {
    return "Lead media needs a valid selection and alt text, a title or a caption.";
  }
  if (complete && kind === "post" && document.liveBlog != null) {
    try { assertLiveBlogReady(document.liveBlog, document.published?.metadata?.liveBlog); }
    catch (error) { return error.message; }
  }
  if (kind === "sponsor" && typeof document.href === "string" && document.href.trim()) {
    let valid = false;
    try {
      const url = new URL(document.href);
      // Control characters are rejected on purpose, so no-control-regex is disabled here.
      /* eslint-disable no-control-regex */
      valid = ["http:", "https:"].includes(url.protocol) && !!url.hostname &&
        !url.username && !url.password && !/[\u0000-\u001f\u007f]/.test(document.href);
      /* eslint-enable no-control-regex */
    } catch {
      valid = false;
    }
    if (!valid) return "href must be an absolute HTTP or HTTPS URL";
  }
  if (kind === "program" && document.watchUrl !== undefined && document.watchUrl !== "") {
    let valid = false;
    try {
      const url = new URL(document.watchUrl);
      valid = url.protocol === "https:" && url.hostname === "watch.njpbs.org" && !url.username && !url.password && !url.port;
    } catch {
      valid = false;
    }
    if (!valid) return "watchUrl must be a watch.njpbs.org HTTPS URL";
  }
  if (validateAccessibility) {
    const accessibilityError = stationImageAccessibilityError(document, kind);
    if (accessibilityError) return accessibilityError;
  }
  if (kind === "event") {
    for (const field of ["registrationUrl", "onlineUrl"]) {
      const value = document[field];
      if (value === undefined || value === "") continue;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) return `${field} must use HTTPS without credentials`;
      } catch { return `${field} must be an HTTPS URL`; }
    }
    if (document.isFree === true && typeof document.priceText === "string" && document.priceText.trim()) {
      return "priceText must be empty for a free event";
    }
    if (typeof document.startsAt === "string" && typeof document.endsAt === "string" && document.endsAt &&
        parsePublishInstant(document.endsAt) !== null && parsePublishInstant(document.startsAt) !== null &&
        parsePublishInstant(document.endsAt) <= parsePublishInstant(document.startsAt)) {
      return "endsAt must be after startsAt";
    }
  }

  const bioError = bioPlacementError(kind, document);
  if (bioError) return bioError;

  if (!complete) return null;
  for (const field of [...selected.required, ...selected.structuralRequired]) {
    const rule = selected.fields[field];
    if (fieldIsMissing(document, field, rule)) return `${field} is required`;
  }
  if (collection === "cmsPages") {
    for (const field of ["homeHeroTitle", "homeHeroSubtitle"]) {
      if (
        Object.prototype.hasOwnProperty.call(document, field) &&
        fieldIsMissing(document, field, selected.fields[field])
      ) {
        return `${field} must not be blank`;
      }
    }
  }
  return null;
}

module.exports = {
  CONTENT_DOCUMENT_CONTRACTS,
  RETIRED_CONTENT_KINDS,
  SERVER_MANAGED_CONTENT_FIELDS,
  retiredContentKindError,
  stationImageAccessibilityError,
  unsupportedContentFields,
  validateContentFieldValues,
};
