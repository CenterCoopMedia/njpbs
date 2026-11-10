"use strict";
const { liveBlogMediaAssetIds } = require("./live-blog");
const { leadMediaAssetIds } = require("./post-lead-media");

const { createHash } = require("node:crypto");
const { parseBlocks, isRichTextDoc } = require("./content-blocks");
const { visibleLayoutBlocks } = require("./content-layout");
const { homeCompositionError } = require("./home-composition-contract");
const { serviceCompositionError } = require("./service-composition");
const { validateSection } = require("./editor-section-contract");
const { isPageTheme, validateKnownMetadata } = require("./content-metadata");
const { editorTemplateForPage } = require("./public-page-contract");
const { recordKindHasPublicRoute } = require("./public-record-kinds");
const { createPublishedSnapshot } = require("./publish-snapshot");
const { resolveDisplayDate } = require("./editorial-dates");
const { parseHomeHero, homeHeroAssetIds } = require("./home-hero");

function copyJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function referencedPreviewAssetIds(snapshot) {
  const ids = new Set();
  for (const block of visibleLayoutBlocks(snapshot.blocks)) {
    // Empty draft image slots have no asset to freeze. Non-empty invalid IDs
    // still fail below, and selected assets still require a media snapshot.
    if (block.data.backgroundImageAssetId) ids.add(block.data.backgroundImageAssetId);
    if (block.type === "bio_card" && block.data.image?.assetId) ids.add(block.data.image.assetId);
    if (block.type === "election_results") {
      for (const race of block.data.races) for (const candidate of race.candidates) if (candidate.photo) ids.add(candidate.photo.assetId);
    }
    if (block.type === "image" && block.data.assetId !== "") ids.add(block.data.assetId);
    if (block.type === "document_list") {
      for (const item of block.data.documents) if (item.assetId) ids.add(item.assetId);
    }
    if (block.type === "image_gallery") {
      for (const image of block.data.images) {
        if (image.assetId !== "") ids.add(image.assetId);
      }
    }
    if (block.type === "card_grid") {
      for (const card of block.data.cards) {
        if (card.imageAssetId) ids.add(card.imageAssetId);
      }
    }
    if (block.type === "promotion_playlist") {
      for (const card of block.data.cards) {
        if (card.imageAssetId) ids.add(card.imageAssetId);
      }
    }
  }
  if (snapshot.heroBackgroundImage) ids.add(snapshot.heroBackgroundImage);
  for (const assetId of homeHeroAssetIds(snapshot.homeHero)) ids.add(assetId);
  if (snapshot.social?.imageAssetId) {
    ids.add(snapshot.social.imageAssetId);
  }
  const post = snapshot.published?.metadata;
  if (post?.heroBackgroundImage) ids.add(post.heroBackgroundImage);
  if (post?.leadMedia === undefined && post?.heroImage) ids.add(post.heroImage);
  for (const assetId of leadMediaAssetIds(post?.leadMedia)) ids.add(assetId);
  if (post?.type === "post") for (const assetId of liveBlogMediaAssetIds(post.liveBlog)) ids.add(assetId);
  if (post?.type === "event" && post.imageAssetId) ids.add(post.imageAssetId);
  if (post?.type === "program" && post.keyArtAssetId) ids.add(post.keyArtAssetId);
  if (post?.social?.imageAssetId) ids.add(post.social.imageAssetId);
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id.includes("/")) {
      throw new Error(`Page ${snapshot.id} references an invalid media asset id`);
    }
  }
  return [...ids].sort();
}

function createPreviewAssetSnapshot(assetId, document, { pdf = false } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`Media asset ${assetId} is missing`);
  }
  if (typeof document.url !== "string") {
    throw new Error(`Media asset ${assetId} has no URL`);
  }
  let url;
  try {
    url = new URL(document.url);
  } catch {
    throw new Error(`Media asset ${assetId} has an invalid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Media asset ${assetId} URL must use https`);
  }
  if (
    typeof document.mimeType !== "string" ||
    (pdf ? document.mimeType !== "application/pdf" : !document.mimeType.startsWith("image/"))
  ) {
    throw new Error(`Media asset ${assetId} is not an image`);
  }
  for (const dimension of pdf ? [] : ["width", "height"]) {
    if (
      document[dimension] !== undefined &&
      (!Number.isInteger(document[dimension]) || document[dimension] <= 0)
    ) {
      throw new Error(`Media asset ${assetId} has invalid dimensions`);
    }
  }
  return copyJson({
    id: assetId,
    url: document.url,
    mimeType: document.mimeType,
    ...(!pdf && document.width !== undefined ? { width: document.width } : {}),
    ...(!pdf && document.height !== undefined ? { height: document.height } : {}),
  });
}

function createPreviewSnapshot(pageId, document) {
  const expectedTemplate = editorTemplateForPage(pageId);
  if (!expectedTemplate) {
    throw new Error(`Unknown preview page ${pageId}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`Page ${pageId} is missing`);
  }
  if (document.deleted === true || document.status === "archived") {
    throw new Error(`Page ${pageId} is archived`);
  }
  if (
    !Number.isInteger(document.version) ||
    Number(document.version) < 1
  ) {
    throw new Error(`Page ${pageId} has no saved version`);
  }
  if (
    document.template !== undefined &&
    document.template !== expectedTemplate
  ) {
    throw new Error(
      `Page ${pageId} requires the ${expectedTemplate} editor template`,
    );
  }
  const title = typeof document.title === "string" && document.title.trim() !== ""
    ? document.title : "Untitled page";

  const pageTheme = isPageTheme(document.pageTheme) ? document.pageTheme : undefined;
  // Old optional metadata must not make a preview unrenderable. New saves still
  // reject this value at the content-document boundary.
  const metadataForRender = document.pageTheme === undefined || pageTheme !== undefined
    ? document
    : { ...document, pageTheme: undefined };
  const metadataError = validateKnownMetadata(metadataForRender);
  const serviceError = serviceCompositionError(pageId, document.serviceCompositionVersion);
  if (serviceError) throw new Error(serviceError);
  if (metadataError) {
    throw new Error(`Page ${pageId} metadata is invalid: ${metadataError}`);
  }
  const hubError = require("./data-hub-composition").dataHubPageError(pageId, document.dataHubCompositionVersion, document.blocks);
  if (hubError) throw new Error(hubError);
  const parsed = parseBlocks(document.blocks, { complete: false, pageId });
  if (!parsed.ok) {
    throw new Error(`Page ${pageId} blocks are invalid: ${parsed.error}`);
  }
  const sectionError = validateSection(expectedTemplate, parsed.blocks);
  const homeError = homeCompositionError(pageId, document.homeCompositionVersion, parsed.blocks, { complete: false });
  if (homeError) throw new Error(homeError);
  if (sectionError) {
    throw new Error(
      `Page ${pageId} blocks are invalid for ${expectedTemplate}: ${sectionError.detail}`,
    );
  }

  return copyJson({
    id: pageId,
    ...(document.childDirected !== undefined ? { childDirected: document.childDirected } : {}),
    ...([1, 2].includes(document.homeCompositionVersion) ? { homeCompositionVersion: document.homeCompositionVersion } : {}),
    ...(document.serviceCompositionVersion === 1 ? { serviceCompositionVersion: 1 } : {}),
    title,
    ...(pageTheme !== undefined ? { pageTheme } : {}),
    ...(document.dataHubCompositionVersion === 1 ? { dataHubCompositionVersion: 1 } : {}),
    ...(document.dataHubReporting !== undefined ? { dataHubReporting: require("./data-hub-reporting").parseDataHubReporting(document.dataHubReporting) } : {}),
    ...(document.homeHero !== undefined ? { homeHero: parseHomeHero(document.homeHero) } : {}),
    ...(document.slug !== undefined ? { slug: document.slug } : {}),
    ...(document.previousSlugs !== undefined ? { previousSlugs: document.previousSlugs } : {}),
    ...(document.heroBackgroundImage !== undefined ? { heroBackgroundImage: document.heroBackgroundImage } : {}),
    ...(document.heroBackgroundPosition !== undefined ? { heroBackgroundPosition: document.heroBackgroundPosition } : {}),
    ...(document.description !== undefined
      ? { description: document.description }
      : {}),
    ...(document.homeHeroTitle !== undefined
      ? { homeHeroTitle: document.homeHeroTitle }
      : {}),
    ...(document.homeHeroSubtitle !== undefined
      ? { homeHeroSubtitle: document.homeHeroSubtitle }
      : {}),
    ...(document.seo !== undefined ? { seo: document.seo } : {}),
    ...(document.social !== undefined ? { social: document.social } : {}),
    template: expectedTemplate,
    blocks: parsed.blocks,
    version: Number(document.version),
  });
}

// Reuse the public post projection, but keep it only in the private queue. A
// first-publication date is provisional in a preview and never saved to the post.
function createPostPreviewSnapshot(id, document, now = Date.now()) {
  if (!recordKindHasPublicRoute(document?.type) || document.deleted || document.status === "archived") {
    throw new Error("Only active routed records can be previewed");
  }
  const structured = document.type === "event" || document.type === "program";
  const parsed = parseBlocks(structured && document.blocks === undefined ? [] : document.blocks, { complete: false });
  if (!parsed.ok) throw new Error(`Post ${id} blocks are invalid: ${parsed.error}`);
  const timestamp = new Date(now).toISOString();
  const isEvent = document.type === "event";
  const hasDescription = isRichTextDoc(document.description) &&
    document.description.content.some(function hasText(node) {
      return (typeof node?.text === "string" && node.text.trim() !== "") ||
        (Array.isArray(node?.content) && node.content.some(hasText));
    });
  const eventStart = typeof document.startsAt === "string" && !Number.isNaN(Date.parse(document.startsAt))
    ? document.startsAt : timestamp;
  const content = {
    ...document,
    title: typeof document.title === "string" && document.title.trim() !== ""
      ? document.title : structured ? `Untitled ${document.type}` : "Untitled post",
    blocks: parsed.blocks,
    slug: document.slug || `draft-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`,
    ...(structured ? {
      previousSlugs: Array.isArray(document.previousSlugs) ? document.previousSlugs : [],
      locale: typeof document.locale === "string" && document.locale ? document.locale : "en",
      description: hasDescription ? document.description : { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: isEvent ? "Event details are not ready yet." : "Program synopsis is not ready yet." }] },
      ] },
    } : {}),
    ...(isEvent ? {
      startsAt: eventStart,
      endsAt: document.endsAt && Date.parse(document.endsAt) > Date.parse(eventStart) ? document.endsAt : undefined,
    } : {}),
    ...(document.type === "post" && resolveDisplayDate(document) === null ? { firstPublishedAt: timestamp } : {}),
  };
  const published = createPublishedSnapshot({
    collection: "cmsPosts", document: content,
    publishedAt: timestamp, publishedBy: "private-preview",
    allowIncompletePresentation: true,
  });
  delete published.publishedBy;
  delete published.metadata.firstPublishedBy;
  delete published.metadata.meaningfulUpdatedBy;
  return copyJson({ id, version: document.version, blocks: parsed.blocks, published });
}

module.exports = {
  createPreviewSnapshot,
  createPostPreviewSnapshot,
  referencedPreviewAssetIds,
  createPreviewAssetSnapshot,
};
