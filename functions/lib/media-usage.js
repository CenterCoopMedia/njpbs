"use strict";
const { liveBlogMediaAssetIds } = require("./live-blog");
const { leadMediaAssetIds } = require("./post-lead-media");

// One content record owns one bounded usage document for each mutable state.
// The list stays on the content record instead of growing an asset document with
// every reuse. Lifecycle operations can therefore find users with one
// collection-group query while each content mutation has a constant write count.

const { isDeepStrictEqual } = require("node:util");
const { parseHomeHero } = require("./home-hero");
const { mediaProjection } = require("./media-contract");
const { isMediaAssetId } = require("./media-library");
const { mediaReplacementRef } = require("./media-replacement");
const {
  assertMediaLifecycleDeploymentFence,
} = require("./public-deployment-pointer");
const {
  CMS_SETTINGS_SCHEMAS,
  CmsSettingsContractError,
  cmsSettingsSchemaFor,
  collectCmsSettingsAssetOccurrences,
  projectPublishedCmsSettings,
} = require("./cms-settings-contract");

const MAX_MEDIA_USAGE_ASSETS = 100;
const MAX_MEDIA_OCCURRENCES = 200;
const MEDIA_USAGE_COLLECTIONS = new Set([
  "cmsPostTemplates",
  "cmsPages",
  "cmsPosts",
  "cmsSettings",
  "cmsAuthorProfilesPublic",
]);

// The author snapshots are read-only as far as media usage goes. They are
// produced by the profile boundary, which writes no working/published usage
// document, so only the published (artifact) collector accepts them; the
// working collector refuses, rather than inventing a usage state nothing writes.
const PUBLISHED_ONLY_MEDIA_USAGE_COLLECTIONS = new Set([
  "cmsAuthorProfilesPublic",
]);
const MEDIA_USAGE_STATES = new Set(["working", "published"]);

class MediaUsageError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = "MediaUsageError";
    this.status = status;
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function addAsset(occurrences, value, label = "Media field") {
  // Optional image controls use an empty string to mean that no asset is set.
  if (value === undefined || value === null || value === "") return;
  if (!isMediaAssetId(value)) {
    throw new MediaUsageError(`${label} must contain a valid media asset id`);
  }
  occurrences.push(value);
  if (occurrences.length > MAX_MEDIA_OCCURRENCES) {
    throw new MediaUsageError(
      `Content can contain at most ${MAX_MEDIA_OCCURRENCES} occurrences of media assets`,
    );
  }
}

function addBlockAssets(occurrences, blocks, { visibleOnly, documentOccurrences = [] }) {
  if (blocks === undefined) return;
  if (!Array.isArray(blocks)) {
    throw new MediaUsageError("Content blocks must be an array");
  }
  const hiddenRows = new Set(blocks.filter(block =>
    plainObject(block) && block.type === "row" && block.visible !== true).map(block => block.id));
  for (const block of blocks) {
    if (!plainObject(block)) {
      throw new MediaUsageError("Each content block must be an object");
    }
    if (visibleOnly && (block.visible !== true || hiddenRows.has(block.layout?.rowId))) continue;
    addAsset(occurrences, block.data?.backgroundImageAssetId, block.type === "support_appeal" ? "Support appeal image" : "Home band background");
    if (block.type === "document_list") {
      if (!Array.isArray(block.data?.documents)) throw new MediaUsageError("PDF notices must contain a document list");
      for (const item of block.data.documents) addAsset(documentOccurrences, item?.assetId, "PDF notice");
    } else if (block.type === "bio_card") {
      addAsset(occurrences, block.data?.image?.assetId, "Bio card image");
    } else if (block.type === "election_results") {
      for (const race of block.data?.races ?? []) {
        for (const candidate of race.candidates ?? []) addAsset(occurrences, candidate.photo?.assetId, "Election candidate photo");
      }
    } else if (block.type === "image") {
      addAsset(occurrences, block.data?.assetId);
    } else if (block.type === "image_gallery") {
      if (!Array.isArray(block.data?.images)) {
        throw new MediaUsageError(
          "An image gallery must contain an image list",
        );
      }
      for (const image of block.data.images) {
        addAsset(occurrences, image?.assetId);
      }
    } else if (block.type === "card_grid") {
      if (!Array.isArray(block.data?.cards)) {
        throw new MediaUsageError("A card set must contain a card list");
      }
      for (const card of block.data.cards) {
        addAsset(occurrences, card?.imageAssetId);
      }
    } else if (block.type === "promotion_playlist") {
      if (!Array.isArray(block.data?.cards)) {
        throw new MediaUsageError("A promotion playlist must contain a program list");
      }
      for (const card of block.data.cards) {
        addAsset(occurrences, card?.imageAssetId);
      }
    }
  }
}

function addMetadataAssets(occurrences, collection, metadata) {
  if (!plainObject(metadata)) return;
  if (collection === "cmsPages") {
    try {
      for (const item of parseHomeHero(metadata.homeHero)?.items ?? []) addAsset(occurrences, item.imageAssetId, "Home hero image");
    } catch (error) { throw new MediaUsageError(error.message); }
  }
  addAsset(occurrences, metadata.social?.imageAssetId);
  if (collection === "cmsPages" || metadata.type === "post") {
    addAsset(occurrences, metadata.heroBackgroundImage, "Hero background image");
  }
  if (collection !== "cmsPosts" && collection !== "cmsPostTemplates") return;

  // Station media used by records counts toward usage. Legacy Program keyArt
  // remains a Media Manager id and is intentionally excluded.
  if (metadata.type === "post") {
    if (metadata.leadMedia === undefined) addAsset(occurrences, metadata.heroImage, "Post lead image");
    for (const id of leadMediaAssetIds(metadata.leadMedia)) addAsset(occurrences, id, "Post lead media");
    for (const id of liveBlogMediaAssetIds(metadata.liveBlog)) addAsset(occurrences, id, "Live update media");
  }
  if (metadata.type === "program") {
    addAsset(occurrences, metadata.keyArtAssetId, "Program key art");
  }
  if (metadata.type === "sponsor") {
    addAsset(occurrences, metadata.logoAssetId, "Sponsor logo");
  }
  if (metadata.type === "event") {
    addAsset(occurrences, metadata.imageAssetId, "Event image");
  }
  if (metadata.type === "newsletter") {
    addAsset(occurrences, metadata.imageAssetId, "Newsletter image");
  }
}

function boundedUsage(occurrences, documentOccurrences = []) {
  const imageAssetIds = [...new Set(occurrences)].sort();
  const documentAssetIds = [...new Set(documentOccurrences)].sort();
  occurrences = [...occurrences, ...documentOccurrences];
  if (occurrences.length > MAX_MEDIA_OCCURRENCES) {
    throw new MediaUsageError(
      `Content can contain at most ${MAX_MEDIA_OCCURRENCES} occurrences of media assets`,
    );
  }
  const assetIds = [...new Set(occurrences)].sort();
  if (assetIds.length > MAX_MEDIA_USAGE_ASSETS) {
    throw new MediaUsageError(
      `Content can reference at most ${MAX_MEDIA_USAGE_ASSETS} unique media assets`,
    );
  }
  return { assetIds, occurrenceCount: occurrences.length,
    ...(documentAssetIds.length ? { documentAssetIds, imageAssetIds } : {}) };
}

function settingsSchema(documentId, schemaVersion, schemas) {
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new MediaUsageError("The CMS settings document id is invalid");
  }
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new MediaUsageError("The CMS settings schema version is invalid");
  }
  const schema = cmsSettingsSchemaFor(documentId, schemaVersion, schemas);
  if (!schema) {
    throw new MediaUsageError("The CMS settings schema is not available");
  }
  return schema;
}

function settingsOccurrences(schema, values) {
  try {
    return collectCmsSettingsAssetOccurrences(schema, values);
  } catch (error) {
    if (error instanceof CmsSettingsContractError) {
      throw new MediaUsageError(error.message);
    }
    throw error;
  }
}

function collectWorkingMediaUsage({
  collection,
  documentId,
  document,
  // Dependency injection keeps fixture schemas out of the production catalog.
  // A handler must never derive this catalog from request data.
  settingsSchemas = CMS_SETTINGS_SCHEMAS,
}) {
  if (
    !MEDIA_USAGE_COLLECTIONS.has(collection) ||
    PUBLISHED_ONLY_MEDIA_USAGE_COLLECTIONS.has(collection) ||
    !plainObject(document)
  ) {
    throw new MediaUsageError("The media usage source is invalid");
  }
  if (collection === "cmsSettings") {
    const schema = settingsSchema(
      documentId,
      document.schemaVersion,
      settingsSchemas,
    );
    return boundedUsage(settingsOccurrences(schema, document.values));
  }
  const occurrences = [];
  const documentOccurrences = [];
  addBlockAssets(occurrences, document.blocks, { visibleOnly: false, documentOccurrences });
  addMetadataAssets(occurrences, collection, document);
  return boundedUsage(occurrences, documentOccurrences);
}

function collectPublishedMediaUsage({
  collection,
  documentId,
  documentVersion,
  snapshot,
  settingsSchemas = CMS_SETTINGS_SCHEMAS,
}) {
  if (!MEDIA_USAGE_COLLECTIONS.has(collection) || !plainObject(snapshot)) {
    throw new MediaUsageError("The published media usage source is invalid");
  }
  if (collection === "cmsAuthorProfilesPublic") {
    // An author snapshot is not block content. Its whole media surface is the
    // one profile photograph, and the snapshot carries the asset id directly.
    const occurrences = [];
    addAsset(occurrences, snapshot.photo?.assetId, "Profile photo");
    return boundedUsage(occurrences);
  }
  if (collection === "cmsSettings") {
    let projected;
    try {
      projected = projectPublishedCmsSettings({
        documentId,
        schemas: settingsSchemas,
        document: { version: documentVersion, published: snapshot },
      });
    } catch (error) {
      if (error instanceof CmsSettingsContractError) {
        throw new MediaUsageError(error.message);
      }
      throw error;
    }
    const schema = settingsSchema(
      documentId,
      projected.schemaVersion,
      settingsSchemas,
    );
    return boundedUsage(settingsOccurrences(schema, projected.values));
  }
  const occurrences = [];
  const documentOccurrences = [];
  addBlockAssets(occurrences, snapshot.blocks, { visibleOnly: true, documentOccurrences });
  addMetadataAssets(occurrences, collection, snapshot.metadata);
  return boundedUsage(occurrences, documentOccurrences);
}

function mediaUsageDocument({ state, sourceVersion, usage }) {
  if (!MEDIA_USAGE_STATES.has(state)) {
    throw new MediaUsageError("The media usage state is invalid", 500);
  }
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    throw new MediaUsageError("The media usage source version is invalid", 500);
  }
  if (!plainObject(usage) || !Array.isArray(usage.assetIds)) {
    throw new MediaUsageError("The media usage list is invalid", 500);
  }
  const assetIds = [...usage.assetIds];
  if (
    assetIds.some((assetId) => !isMediaAssetId(assetId)) ||
    new Set(assetIds).size !== assetIds.length ||
    assetIds.length > MAX_MEDIA_USAGE_ASSETS ||
    !Number.isSafeInteger(usage.occurrenceCount) ||
    usage.occurrenceCount < assetIds.length ||
    usage.occurrenceCount > MAX_MEDIA_OCCURRENCES ||
    (assetIds.length === 0 && usage.occurrenceCount !== 0)
  ) {
    throw new MediaUsageError("The media usage list is invalid", 500);
  }
  return {
    state,
    sourceVersion,
    assetIds: assetIds.sort(),
    occurrenceCount: usage.occurrenceCount,
  };
}

async function prepareMediaUsageWrites({
  firestore,
  transaction,
  collection,
  documentId,
  states,
  releaseSelector,
}) {
  if (
    !MEDIA_USAGE_COLLECTIONS.has(collection) ||
    typeof documentId !== "string" ||
    documentId.length === 0
  ) {
    throw new MediaUsageError("The media usage owner is invalid", 500);
  }
  if (!Array.isArray(states) || states.length < 1 || states.length > 2) {
    throw new MediaUsageError("The media usage states are invalid", 500);
  }

  const prepared = {};
  for (const stateInput of states) {
    const document = mediaUsageDocument(stateInput ?? {});
    if (Object.hasOwn(prepared, document.state)) {
      throw new MediaUsageError("The media usage states are invalid", 500);
    }
    prepared[document.state] = {
      ref: firestore
        .collection(`${collection}/${documentId}/mediaUsage`)
        .doc(document.state),
      document,
      ...(stateInput.usage.documentAssetIds?.length ? { requirements: {
        documentAssetIds: stateInput.usage.documentAssetIds,
        imageAssetIds: stateInput.usage.imageAssetIds,
      } } : {}),
    };
  }

  // Working and published commonly contain the same assets. Read each lifecycle
  // triplet once for the union so a maximum-size repair stays below the deliberate
  // 603-read owner budget instead of reading shared assets twice.
  const assetIds = [
    ...new Set(
      Object.values(prepared).flatMap(({ document }) => document.assetIds),
    ),
  ].sort();
  const publishedAssetIds = new Set(
    prepared.published?.document.assetIds ?? [],
  );

  const snapshots = await Promise.all(
    assetIds.flatMap((assetId) => [
      transaction.get(firestore.collection("media_assets").doc(assetId)),
      transaction.get(firestore.collection("media_assets_public").doc(assetId)),
      transaction.get(mediaReplacementRef(firestore, assetId)),
    ]),
  );
  let uploadedPublishedAssetId = null;
  for (const [index, assetId] of assetIds.entries()) {
    const privateSnapshot = snapshots[index * 3];
    const publicSnapshot = snapshots[index * 3 + 1];
    const replacementSnapshot = snapshots[index * 3 + 2];
    const privateRecord = privateSnapshot?.data();
    if (!privateSnapshot?.exists || privateRecord?.lifecycle !== "active") {
      throw new MediaUsageError(
        `Media asset ${assetId} is not available. Choose another asset.`,
        409,
      );
    }
    if (
      publishedAssetIds.has(assetId) &&
      privateRecord.source !== "site_seed" &&
      privateRecord.source !== "upload"
    ) {
      throw new MediaUsageError(
        `Media asset ${assetId} has an unsupported source and cannot be published.`,
        409,
      );
    }
    if (
      publishedAssetIds.has(assetId) &&
      privateRecord.source === "upload"
    ) {
      uploadedPublishedAssetId ??= assetId;
    }
    if (replacementSnapshot?.exists) {
      throw new MediaUsageError(
        `A file replacement is in progress for media asset ${assetId}. Try again.`,
        409,
      );
    }
    const requiresPdf = Object.values(prepared).some(state => state.requirements?.documentAssetIds.includes(assetId));
    const requiresImage = Object.values(prepared).some(state =>
      (state.requirements?.imageAssetIds ?? state.document.assetIds).includes(assetId));
    if ((requiresPdf && privateRecord.mimeType !== "application/pdf") ||
      (requiresImage && (typeof privateRecord.mimeType !== "string" || !privateRecord.mimeType.startsWith("image/")))) {
      throw new MediaUsageError(
        `Media asset ${assetId} must be ${requiresPdf ? "a PDF" : "an image"}. Choose another asset.`,
        409,
      );
    }
    if (
      !publicSnapshot?.exists ||
      !isDeepStrictEqual(publicSnapshot.data(), mediaProjection(privateRecord))
    ) {
      throw new MediaUsageError(
        `Media asset ${assetId} is not ready for use. Try again.`,
        409,
      );
    }
  }

  if (uploadedPublishedAssetId !== null) {
    const deploymentSnapshot = await transaction.get(
      firestore.collection("system").doc("publicDeployment"),
    );
    try {
      if (releaseSelector !== undefined) await require("./public-release-media-fence").assertPairMediaFenceInTransaction({
        firestore, transaction, selector: releaseSelector });
      else assertMediaLifecycleDeploymentFence(deploymentSnapshot?.data());
    } catch (error) {
      if (releaseSelector !== undefined && !(error instanceof require("./public-release-pair").PublicReleaseProtocolError)) throw error;
      throw new MediaUsageError(
        `Media asset ${uploadedPublishedAssetId} cannot be published until public deployment coordination is active.`,
        409,
        "media_publication_unavailable",
      );
    }
  }

  return prepared;
}

async function prepareMediaUsageWrite({
  firestore,
  transaction,
  collection,
  documentId,
  state,
  sourceVersion,
  usage,
  releaseSelector,
}) {
  const prepared = await prepareMediaUsageWrites({
    firestore,
    transaction,
    collection,
    documentId,
    releaseSelector,
    states: [{ state, sourceVersion, usage }],
  });
  return prepared[state];
}

module.exports = {
  MAX_MEDIA_OCCURRENCES,
  MAX_MEDIA_USAGE_ASSETS,
  MEDIA_USAGE_COLLECTIONS,
  MEDIA_USAGE_STATES,
  MediaUsageError,
  collectPublishedMediaUsage,
  collectWorkingMediaUsage,
  mediaUsageDocument,
  prepareMediaUsageWrite,
  prepareMediaUsageWrites,
};
