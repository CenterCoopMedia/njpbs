"use strict";
const { liveBlogVideoBlocks } = require("./live-blog");
const { approvedElectionBlocks } = require("./election-results-approval");

// The immutable public projection written beside a page/post's mutable working
// copy. Publishing never points the static build at the top-level document:
// blocks and every viewer-visible metadata field are copied here together so a
// later draft edit cannot partially leak into the live page.

const { resolveDisplayDate } = require("./editorial-dates");
const { parseHomeHero } = require("./home-hero");
const { isRichTextDoc, parseBlocks } = require("./content-blocks");
const { bioPlacementError, containsBio } = require("./bio-profiles");
const { homeCompositionError } = require("./home-composition-contract");
const { postPresentationError } = require("./post-formats");
const { recordKindHasPublicRoute } = require("./public-record-kinds");
const { registeredAuthorIds, resolveStoryCredits } = require("./story-credits");
const { parsePublishInstant } = require("./publish-instant");
const { serviceCompositionError } = require("./service-composition");
const { isPostLeadMedia, leadVideoBlocks } = require("./post-lead-media");
const { videoCopies, previousVideoCopies } = require("./public-video-references");
const { pageThemeError } = require("./content-metadata");

const PAGE_HERO_FIELDS = ["homeHeroTitle", "homeHeroSubtitle"];
const PAGE_METADATA_FIELDS = [
  "title",
  "childDirected",
  "pageTheme",
  "slug",
  "previousSlugs",
  "description",
  "heroBackgroundImage",
  "heroBackgroundPosition",
  ...PAGE_HERO_FIELDS,
  "homeHero",
  "dataHubCompositionVersion",
  "dataHubReporting",
  "contentLinkMode", "contentLinkUrl", "contentLinkNewTab",
  "seo",
  "social",
  "homeCompositionVersion",
  "serviceCompositionVersion",
];
// A Program has one synopsis and no block layout. Its station media-library
// key art is frozen by asset id; the old Media Manager id is retained only so
// an existing record can be read without a data migration.
const PROGRAM_METADATA_FIELDS = [
  "type",
  "title",
  "genre",
  "description",
  "keyArt",
  "keyArtAssetId",
  "keyArtAlt",
  "keyArtDecorative",
  "watchUrl",
  "memberOnly",
  "slug",
  "previousSlugs",
  "locale",
];
const EVENT_METADATA_FIELDS = [
  "type", "title", "slug", "previousSlugs", "locale", "startsAt", "endsAt",
  "location", "venueAddress", "onlineUrl", "description", "imageAssetId",
  "imageAlt", "imageDecorative", "registrationUrl", "registrationLabel",
  "isFree", "priceText",
];
const POST_METADATA_FIELDS = [
  "type",
  "spotlightNews",
  "coverageLabelId",
  "showInHomeHero",
  "title",
  // The publication-date contract (#1041), frozen with the body so the public page,
  // the structured data, and the listing sort read one set of dates and cannot pick
  // up a later draft edit. `publishedAt` below is when THIS revision went out, which
  // is a different fact from when the story first ran.
  "date",
  "editorialDateSource",
  "firstPublishedAt",
  "firstPublishedBy",
  "meaningfulUpdatedAt",
  "meaningfulUpdatedBy",
  "showUpdatedDate",
  "categories",
  "tags",
  "summary",
  "excerpt",
  // The ordered byline (#1040), frozen here with the display names resolved at
  // this publish so a later rename or deactivation cannot change what an already
  // published page says. `author` stays in the list only so snapshots taken
  // before this contract keep rendering; nothing writes it any more.
  "credits",
  "liveBlog",
  "author",
  "leadMedia",
  "heroImage",
  "heroBackgroundImage",
  "heroBackgroundPosition",
  "heroImageAlt",
  "heroImageDecorative",
  "heroImageCaption",
  "contentLinkMode", "contentLinkUrl", "contentLinkNewTab",
  "seo",
  "social",
  "slug",
  "previousSlugs",
  "locale",
];

class PublishSnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublishSnapshotError";
    this.status = 400;
  }
}

function clone(value) {
  return structuredClone(value);
}

function selectFields(document, fields) {
  const selected = {};
  for (const field of fields) {
    if (document[field] !== undefined) selected[field] = clone(document[field]);
  }
  return selected;
}

/**
 * True when a record carries the routing metadata the public build needs.
 *
 * The save boundary mints `slug`, `previousSlugs`, and `locale` for every
 * cmsPosts record, whatever its kind, so this is a re-check of trusted state
 * rather than a new requirement on editors: a record that somehow lost it cannot
 * be frozen into a snapshot claiming a route it has no address for.
 */
function hasCanonicalRouting(document) {
  return (
    typeof document.slug === "string" &&
    document.slug.length > 0 &&
    Array.isArray(document.previousSlugs) &&
    !document.previousSlugs.some((slug) => typeof slug !== "string") &&
    typeof document.locale === "string" &&
    document.locale.length > 0
  );
}

/** True when a structurally valid rich-text document contains no readable text. */
function richTextIsEmpty(document) {
  const hasText = (node) =>
    (typeof node?.text === "string" && node.text.trim().length > 0) ||
    (Array.isArray(node?.content) && node.content.some(hasText));
  return !document.content.some(hasText);
}

function metadataFieldsFor(collection, kind) {
  if (collection === "cmsPages") return PAGE_METADATA_FIELDS;
  return kind === "program" ? PROGRAM_METADATA_FIELDS : kind === "event" ? EVENT_METADATA_FIELDS : POST_METADATA_FIELDS;
}

function createPublishedSnapshot({
  collection,
  document,
  publishedAt,
  publishedBy,
  allowIncompletePresentation = false,
}) {
  if (collection !== "cmsPages" && collection !== "cmsPosts") {
    throw new PublishSnapshotError(`Unknown publish collection ${String(collection)}`);
  }
  // Which kinds may be frozen at all is the shared routed-kind contract's answer,
  // not a local string comparison. A kind with no public route must never become
  // an immutable public snapshot: the Admin hides Publish now and Schedule for it,
  // and this is the boundary that holds when something calls the function anyway.
  const kind = collection === "cmsPages" ? "page" : document?.type;
  if (collection === "cmsPages") {
    const hubError = require("./data-hub-composition").dataHubPageError(document.id, document.dataHubCompositionVersion, document.blocks);
    if (hubError) throw new PublishSnapshotError(hubError);
    const error = serviceCompositionError(document.id, document.serviceCompositionVersion);
    if (error) throw new PublishSnapshotError(error);
  }
  if (collection === "cmsPages" && document?.homeCompositionVersion !== undefined) {
    const parsed = parseBlocks(document.blocks, { pageId: document.id });
    if (!parsed.ok) throw new PublishSnapshotError(parsed.error);
    const error = homeCompositionError(document.id, document.homeCompositionVersion, parsed.blocks);
    if (error) throw new PublishSnapshotError(error);
  }
  if (collection === "cmsPosts" && !recordKindHasPublicRoute(kind)) {
    throw new PublishSnapshotError(
      `${String(kind)} records cannot be published: they have no public route`,
    );
  }
  const linkError = require("./content-link").contentLinkError(document);
  if (linkError) throw new PublishSnapshotError(linkError);
  // A Program carries no block layout, so requiring one would refuse every valid
  // program. Every other publishable document is a block document and keeps the
  // array requirement.
  const isBlockDocument = kind !== "program" && kind !== "event";
  if (isBlockDocument && !Array.isArray(document?.blocks)) {
    throw new PublishSnapshotError("Published content requires a blocks array");
  }
  if (typeof document.title !== "string" || document.title.trim() === "") {
    throw new PublishSnapshotError("Published content requires a title");
  }
  if (kind === "page") {
    if (document.childDirected !== undefined && typeof document.childDirected !== "boolean") {
      throw new PublishSnapshotError("childDirected must be a boolean");
    }
    const themeError = pageThemeError(document.pageTheme);
    if (themeError) throw new PublishSnapshotError(themeError);
    try { require("./data-hub-reporting").parseDataHubReporting(document.dataHubReporting); }
    catch (error) { throw new PublishSnapshotError(error.message); }
    try { parseHomeHero(document.homeHero); }
    catch (error) { throw new PublishSnapshotError(error.message); }
    for (const field of PAGE_HERO_FIELDS) {
      if (
        document[field] !== undefined &&
        (typeof document[field] !== "string" || document[field].trim() === "")
      ) {
        throw new PublishSnapshotError(
          `Published content requires a non-blank ${field}`,
        );
      }
    }
  }
  if (kind === "program") {
    if (!isRichTextDoc(document.description) || richTextIsEmpty(document.description)) {
      throw new PublishSnapshotError("Published programs require a synopsis");
    }
    if (document.keyArtAssetId && document.keyArtDecorative === true && document.keyArtAlt !== "") {
      throw new PublishSnapshotError("Decorative program key art must have empty alt text");
    }
    if (document.watchUrl) {
      try {
        const url = new URL(document.watchUrl);
        if (url.protocol !== "https:" || url.hostname !== "watch.njpbs.org" || url.username || url.password || url.port) throw new Error("invalid");
      } catch { throw new PublishSnapshotError("Program watch URL must use watch.njpbs.org over HTTPS"); }
    }
    if (!hasCanonicalRouting(document)) {
      throw new PublishSnapshotError(
        "Published programs require canonical routing metadata",
      );
    }
  }
  if (kind === "event") {
    if (!allowIncompletePresentation && (!isRichTextDoc(document.description) || richTextIsEmpty(document.description))) throw new PublishSnapshotError("Published events require details");
    if (!allowIncompletePresentation && !hasCanonicalRouting(document)) throw new PublishSnapshotError("Published events require canonical routing metadata");
    const eventStart = parsePublishInstant(document.startsAt);
    const eventEnd = document.endsAt ? parsePublishInstant(document.endsAt) : null;
    if (!allowIncompletePresentation && eventStart === null) throw new PublishSnapshotError("Published events require a start time");
    if (document.startsAt && eventStart === null) throw new PublishSnapshotError("Event start must be a valid stored instant");
    if (document.endsAt && (eventEnd === null || (eventStart !== null && eventEnd <= eventStart))) throw new PublishSnapshotError("Event end must be after the start");
    for (const field of ["registrationUrl", "onlineUrl"]) {
      if (!document[field]) continue;
      try { const url = new URL(document[field]); if (url.protocol !== "https:" || url.username || url.password) throw new Error(); }
      catch { throw new PublishSnapshotError(`${field} must use HTTPS`); }
    }
    if (document.imageAssetId && document.imageDecorative === true && document.imageAlt !== "") throw new PublishSnapshotError("Decorative event images require empty alt text");
    if (document.isFree === true && typeof document.priceText === "string" && document.priceText.trim()) throw new PublishSnapshotError("Free events cannot have a price");
  }
  if (kind === "post") {
    if (document.liveBlog !== undefined) {
      try {
        const project = allowIncompletePresentation ? require("./live-blog").previewLiveBlogData : require("./live-blog").publicLiveBlogData;
        project(document.liveBlog, publishedAt);
      }
      catch (error) { throw new PublishSnapshotError(error.message); }
    }
    if (document.leadMedia != null && !isPostLeadMedia(document.leadMedia, !allowIncompletePresentation)) {
      throw new PublishSnapshotError("Lead media needs a valid selection and alt text, a title or a caption.");
    }
    if (document.showInHomeHero !== undefined && typeof document.showInHomeHero !== "boolean") {
      throw new PublishSnapshotError("showInHomeHero must be a boolean");
    }
    if (document.coverageLabelId !== undefined && !require("./cms-settings-contract").isCoverageLabelId(document.coverageLabelId)) throw new PublishSnapshotError("coverageLabelId must be a valid coverage label id");
    if (document.spotlightNews !== undefined && typeof document.spotlightNews !== "boolean") {
      throw new PublishSnapshotError("spotlightNews must be a boolean");
    }
    // A published post needs a date a reader can see, but not necessarily one an
    // editor typed: an ordinary post derives it from the instant this publish
    // completes. Check the resolved display date rather than the raw field, so a
    // post whose date is derived passes and a post with no date at all still fails.
    if (resolveDisplayDate(document) === null) {
      throw new PublishSnapshotError("Published posts require a date");
    }
    if (
      document.categories !== undefined &&
      (!Array.isArray(document.categories) ||
        document.categories.some((category) => typeof category !== "string"))
    ) {
      throw new PublishSnapshotError("Published posts require string categories");
    }
    if (
      !Array.isArray(document.tags) ||
      document.tags.some((tag) => typeof tag !== "string")
    ) {
      throw new PublishSnapshotError("Published posts require string tags");
    }
    const presentationError = postPresentationError({
      tags: document.tags,
      blocks: document.blocks,
      heroImage: document.heroImage,
      leadMedia: document.leadMedia,
    });
    if (presentationError && !allowIncompletePresentation) throw new PublishSnapshotError(presentationError);
    if (
      typeof document.slug !== "string" ||
      document.slug.length === 0 ||
      !Array.isArray(document.previousSlugs) ||
      document.previousSlugs.some((slug) => typeof slug !== "string") ||
      typeof document.locale !== "string" ||
      document.locale.length === 0
    ) {
      throw new PublishSnapshotError("Published posts require canonical routing metadata");
    }
  }
  if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) {
    throw new PublishSnapshotError("Published content requires a valid publish time");
  }
  if (typeof publishedBy !== "string" || publishedBy.length === 0) {
    throw new PublishSnapshotError("Published content requires an actor");
  }
  if (!Number.isInteger(document.version) || document.version < 1) {
    throw new PublishSnapshotError("Published content requires a source version");
  }

  const bioError = bioPlacementError(kind, document);
  if (bioError) throw new PublishSnapshotError(bioError);
  if (containsBio(document?.blocks)) {
    const parsedBios = parseBlocks(document.blocks, { complete: !allowIncompletePresentation });
    if (!parsedBios.ok) throw new PublishSnapshotError(parsedBios.error);
  }

  const previousCopies = [...new Map([
    ...previousVideoCopies(document.published),
    ...videoCopies([...(document.published?.blocks ?? []), ...leadVideoBlocks(document.published?.metadata?.leadMedia),
      ...liveBlogVideoBlocks(document.published?.metadata?.type === "post" ? document.published.metadata.liveBlog : undefined)]),
  ].map(copy => [copy.url, copy])).values()];
  let blocks = [];
  if (isBlockDocument) {
    try { blocks = clone(approvedElectionBlocks(document, { preview: allowIncompletePresentation })); }
    catch (error) {
      if (error.status === 400) throw new PublishSnapshotError(error.message);
      throw error;
    }
  }
  return {
    // A blockless kind still carries the field, as an empty list: every reader of
    // a snapshot -- the loader, the media collector, the artifact inventory --
    // then sees one shape instead of branching on whether `blocks` exists.
    blocks,
    // Retained in the same publish transaction: a pending static deployment can
    // still serve these earlier URLs, even if the new body has no video block.
    ...(previousCopies.length ? { previousVideoCopies: previousCopies } : {}),
    metadata: selectFields(document, metadataFieldsFor(collection, kind)),
    ...(kind === "post"
      ? { authorIds: registeredAuthorIds(resolveStoryCredits(document)) }
      : {}),
    publishedAt,
    publishedBy,
    sourceVersion: document.version,
    contentVersion: document.contentVersion ?? document.version,
  };
}

module.exports = {
  PAGE_METADATA_FIELDS,
  POST_METADATA_FIELDS,
  PROGRAM_METADATA_FIELDS,
  EVENT_METADATA_FIELDS,
  PublishSnapshotError,
  createPublishedSnapshot,
};
