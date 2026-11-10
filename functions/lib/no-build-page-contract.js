"use strict";

const { PAGE_METADATA_FIELDS } = require("./publish-snapshot");
const { publicPageDefinition, publicPagePath, isAvailablePageSlug } = require("./public-page-contract");
const { publicAssetRequirementsForDocument, PublicContentProjectionError } = require("./public-content-projection");
const { visibleLayoutBlocks } = require("./content-layout");
const { homeSelectedPostIds } = require("./home-source-catalog");
const { previousVideoCopies } = require("./public-video-references");
const { parsePublishInstant } = require("./publish-instant");

const PAGE_OWNER_COLLECTION = "system/publicDeployment/noBuildPageOwners";
const MAX_PAGE_INPUT_BYTES = 512 * 1024;
const MAX_PAGE_BLOCKS = 200;
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function fail(message) { throw new PublicContentProjectionError(`Build-free Page: ${message}`); }
function record(value) {
  if (!value || typeof value !== "object") return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}
function fields(value, allowed, label) {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key))) {
    fail(`${label} has unsupported fields`);
  }
}
function noBuildPageOwnerPath(pageId) {
  if (typeof pageId !== "string" || !publicPageDefinition(pageId)) fail("unknown Page identity");
  return `${PAGE_OWNER_COLLECTION}/${pageId}`;
}

// Firestore content is a bounded JSON tree. Check it before recursive rich-text
// parsing or serialization so typed objects, cycles and huge inputs fail closed.
function assertInputTree(value) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(value, depth) {
    if (++nodes > 20_000 || depth > 40) fail("input is too complex");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string" && value.length <= MAX_PAGE_INPUT_BYTES) return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !record(value)) fail("input must contain only JSON values");
    if (Array.isArray(value) && (value.length > 20_000 || Object.keys(value).length !== value.length ||
        Object.keys(value).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) fail("input arrays must be dense");
    if (ancestors.has(value)) fail("input must not contain cycles");
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("input must contain only JSON fields");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PAGE_INPUT_BYTES) fail("input is too large");
}

/** Validate a frozen snapshot, never the mutable Page document. No data writes. */
function validateNoBuildPageSnapshot({ pageId, snapshot }) {
  const definition = typeof pageId === "string" ? publicPageDefinition(pageId) : null;
  if (!definition) fail("unknown Page identity");
  assertInputTree(snapshot);
  require("./dataset-dependencies").validateFrozenDatasetFigures(snapshot);
  fields(snapshot, ["metadata", "blocks", "sourceVersion", "contentVersion", "publishedAt", "publishedBy", "previousVideoCopies", "datasetFigures"], "snapshot");
  fields(snapshot.metadata, PAGE_METADATA_FIELDS, "metadata");
  // The save contract retains vendor siblings inside these groups. The shared
  // public projector validates known fields and selects them explicitly; extra
  // bounded JSON values cannot reach the template or change its behavior.
  for (const key of ["seo", "social"]) {
    if (snapshot.metadata[key] !== undefined && !record(snapshot.metadata[key])) fail(`${key} must be a plain map`);
  }
  if (!Number.isSafeInteger(snapshot.sourceVersion) || snapshot.sourceVersion < 1 ||
      (snapshot.contentVersion !== undefined && (!Number.isSafeInteger(snapshot.contentVersion) || snapshot.contentVersion < 1)) ||
      parsePublishInstant(snapshot.publishedAt) === null || typeof snapshot.publishedBy !== "string" || !snapshot.publishedBy.trim()) {
    fail("snapshot identity is invalid");
  }
  if (!Array.isArray(snapshot.blocks) || snapshot.blocks.length > MAX_PAGE_BLOCKS) fail("blocks exceed the Page limit");
  for (const block of snapshot.blocks) fields(block, ["id", "type", "section", "layout", "order", "visible", "data"], "block");
  if (pageId === "home" && ![1, 2].includes(snapshot.metadata.homeCompositionVersion)) fail("Home requires a complete versioned composition");
  if (pageId !== "home" && snapshot.metadata.homeHero !== undefined) fail("Home hero belongs only to Home");
  if (snapshot.metadata.dataHubReporting !== undefined && pageId !== "data-hub") fail("reporting belongs only to Data Hub");
  const hubError = require("./data-hub-composition").dataHubPageError(pageId, snapshot.metadata.dataHubCompositionVersion, snapshot.blocks);
  if (hubError) fail(hubError);
  if (pageId === "data-hub" && (snapshot.metadata.previousSlugs?.length ?? 0)) fail("The Data Hub address stays fixed");
  const path = publicPagePath(pageId, snapshot.metadata);
  if (!path) fail("Page URL is invalid");
  const aliases = snapshot.metadata.previousSlugs ?? [];
  if (!Array.isArray(aliases) || aliases.length > 100 || new Set(aliases).size !== aliases.length ||
      [...aliases].some(slug => !isAvailablePageSlug(pageId, slug))) fail("retained Page slugs are invalid");
  if (snapshot.previousVideoCopies !== undefined && (!Array.isArray(snapshot.previousVideoCopies) ||
      previousVideoCopies(snapshot).length !== snapshot.previousVideoCopies.length)) fail("retained video copies are invalid");

  // Reuse the exact public projector's complete block/template/row/Home grammar,
  // media bounds and metadata validation instead of inventing another palette.
  const requirements = publicAssetRequirementsForDocument({ pageId, now: new Date(snapshot.publishedAt),
    document: { template: definition.template, status: "published", publiclyVisible: true,
      publishAt: snapshot.publishedAt, published: snapshot } });
  const recordIds = new Set();
  for (const block of visibleLayoutBlocks(snapshot.blocks)) {
    const ids = block.type === "record_card" ? [block.data.recordId] :
      block.type === "newsletter_signup" ? pageId === "home" && block.section === "home-newsletter" ? [] : block.data.newsletterIds :
      block.type === "sponsor_strip" ? block.data.sponsorIds : [];
    for (const id of ids) {
      if (!validId(id)) fail("joined record ID is invalid");
      recordIds.add(id);
    }
  }
  if (recordIds.size > 100) fail("too many joined records");
  const homePostIds = pageId === "home" ? homeSelectedPostIds({ blocks: snapshot.blocks, homeHero: snapshot.metadata.homeHero }) : [];
  if (homePostIds.some(id => !validId(id))) fail("Home Post ID is invalid");
  return { pageId, path, previousSlugs: [...aliases], ...requirements, recordIds: [...recordIds].sort(), homePostIds,
    homeSources: pageId === "home" };
}

module.exports = { PAGE_OWNER_COLLECTION, MAX_PAGE_INPUT_BYTES, MAX_PAGE_BLOCKS,
  assertInputTree, noBuildPageOwnerPath, validateNoBuildPageSnapshot };
