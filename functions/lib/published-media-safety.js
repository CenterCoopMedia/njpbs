"use strict";

// Until public deployment coordination is active, an uploaded R2 asset must not
// enter any static public build. New snapshots are fenced by media-usage writes.
// This bounded dispatch preflight also covers snapshots stored before that fence.

const {
  collectPublishedMediaUsage,
  MediaUsageError,
} = require("./media-usage");
const { isDeepStrictEqual } = require("node:util");
const { mediaProjection } = require("./media-contract");
const { PAGE_EDITOR_TEMPLATES, editorTemplateForPage } = require("./public-page-contract");
const { assertMediaLifecycleDeploymentFence } = require("./public-deployment");
const { recordKindHasPublicRoute } = require("./public-record-kinds");
const { parsePublishInstant } = require("./publish-instant");

const MAX_GET_ALL_REFS = 100;
const PUBLIC_PAGE_IDS = Object.freeze(Object.keys(PAGE_EDITOR_TEMPLATES));

class PublishedMediaSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PublishedMediaSafetyError";
    this.status = 409;
    this.details = { code: "media_publication_unavailable" };
  }
}

function assertPublishedAssetProjection({
  assetId,
  owner,
  privateSnapshot,
  publicSnapshot,
  uploadedMediaReady = false,
  requiresPdf = false,
  requiresImage = !requiresPdf,
}) {
  const record = privateSnapshot?.data();
  if (
    !privateSnapshot?.exists ||
    record?.lifecycle !== "active" ||
    !["site_seed", "upload"].includes(record?.source) ||
    (record.source === "upload" && !uploadedMediaReady) ||
    typeof record?.mimeType !== "string" ||
    (requiresImage && !record.mimeType.startsWith("image/")) ||
    (requiresPdf && record?.mimeType !== "application/pdf")
  ) {
    throw new PublishedMediaSafetyError(
      `Media asset ${assetId} on ${owner} cannot enter public content until public deployment coordination is active.`,
    );
  }
  const projection = mediaProjection(record);
  if (
    !publicSnapshot?.exists ||
    !isDeepStrictEqual(publicSnapshot.data(), projection)
  ) {
    throw new PublishedMediaSafetyError(
      `Media asset ${assetId} public projection is not ready for public content.`,
    );
  }
  const thumbnails = record.animated === false
    ? require("./cms-image-variants").cmsImageThumbnails(record)
    : [];
  return { ...projection, ...(thumbnails.length ? { thumbnails } : {}) };
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLegacyBlockOnlySnapshot(document) {
  return (
    plainObject(document?.published) &&
    document.published.metadata === undefined &&
    document.published.sourceVersion === undefined
  );
}

function hasPotentialPublicSnapshot(document) {
  if (!plainObject(document)) return false;
  const visible =
    document.publiclyVisible === true ||
    (document.publiclyVisible === undefined && document.status === "published");
  if (!visible || document.deleted || isLegacyBlockOnlySnapshot(document)) {
    return false;
  }
  const snapshotTime =
    document.status !== "published" &&
    plainObject(document.published) &&
    Object.prototype.hasOwnProperty.call(document.published, "publishedAt")
      ? document.published.publishedAt
      : document.publishAt;
  // Include valid future instants. The build has a later clock and can cross a
  // due boundary after this request without any intervening Firestore write.
  return parsePublishInstant(snapshotTime) !== null;
}

async function getAllBounded(firestore, refs) {
  const snapshots = [];
  for (let index = 0; index < refs.length; index += MAX_GET_ALL_REFS) {
    snapshots.push(
      ...(await firestore.getAll(
        ...refs.slice(index, index + MAX_GET_ALL_REFS),
      )),
    );
  }
  return snapshots;
}

function addOwnerMedia(assetOwners, { collection, snapshot, owner }, requirements) {
  let usage;
  try {
    usage = collectPublishedMediaUsage({ collection, snapshot });
  } catch (error) {
    if (error instanceof MediaUsageError) {
      throw new PublishedMediaSafetyError(
        `Public media owner ${owner} has invalid media references: ${error.message}`,
      );
    }
    throw error;
  }
  for (const assetId of usage.assetIds) {
    if (!assetOwners.has(assetId)) assetOwners.set(assetId, owner);
    const prior = requirements.get(assetId) ?? { requiresPdf: false, requiresImage: false };
    requirements.set(assetId, {
      requiresPdf: prior.requiresPdf || (usage.documentAssetIds ?? []).includes(assetId),
      requiresImage: prior.requiresImage || (usage.imageAssetIds ?? usage.assetIds).includes(assetId),
    });
  }
}

function collectPublishedArtifactMediaOwners({
  pageSnapshots,
  postSnapshots,
  authorSnapshots,
}) {
  const assetOwners = new Map();
  const requirements = new Map();
  let candidatePageCount = 0;

  for (const snapshot of pageSnapshots) {
    if (!snapshot.exists || editorTemplateForPage(snapshot.id) === null) continue;
    const document = snapshot.data();
    if (!hasPotentialPublicSnapshot(document)) continue;
    candidatePageCount += 1;
    addOwnerMedia(assetOwners, {
      collection: "cmsPages",
      snapshot: document.published,
      owner: `published page ${snapshot.id}`,
    }, requirements);
  }

  for (const snapshot of postSnapshots) {
    if (!snapshot.exists) continue;
    const document = snapshot.data();
    if (
      !hasPotentialPublicSnapshot(document) ||
      !recordKindHasPublicRoute(document.published?.metadata?.type)
    ) {
      continue;
    }
    addOwnerMedia(assetOwners, {
      collection: "cmsPosts",
      snapshot: document.published,
      owner: `published post ${snapshot.id}`,
    }, requirements);
  }

  for (const snapshot of authorSnapshots) {
    if (!snapshot.exists) continue;
    addOwnerMedia(assetOwners, {
      collection: "cmsAuthorProfilesPublic",
      snapshot: snapshot.data(),
      owner: `public author ${snapshot.id}`,
    }, requirements);
  }

  return { assetOwners, candidatePageCount, requirements };
}

async function readPublishedMediaAssets({ firestore, transaction = null }) {
  if (!firestore || typeof firestore.getAll !== "function") {
    throw new PublishedMediaSafetyError(
      "Published media safety cannot read the content store.",
    );
  }
  const [pageSnapshot, postSnapshot, authorSnapshot] = await Promise.all([
    transaction ? transaction.get(firestore.collection("cmsPages")) : firestore.collection("cmsPages").get(),
    transaction ? transaction.get(firestore.collection("cmsPosts")) : firestore.collection("cmsPosts").get(),
    transaction ? transaction.get(firestore.collection("cmsAuthorProfilesPublic")) : firestore.collection("cmsAuthorProfilesPublic").get(),
  ]);
  const { assetOwners, candidatePageCount, requirements } =
    collectPublishedArtifactMediaOwners({
      pageSnapshots: pageSnapshot.docs,
      postSnapshots: postSnapshot.docs,
      authorSnapshots: authorSnapshot.docs,
    });

  const assetIds = [...assetOwners.keys()].sort();
  const assetRefs = assetIds.flatMap((assetId) => [
    firestore.collection("media_assets").doc(assetId),
    firestore.collection("media_assets_public").doc(assetId),
  ]);
  const assetSnapshots = await getAllBounded(
    transaction ?? firestore,
    assetRefs,
  );
  return { assetIds, assetOwners, assetSnapshots, candidatePageCount, requirements };
}

async function assertPublishedMediaSafe({ firestore, transaction = null }) {
  const { assetIds, assetOwners, assetSnapshots, candidatePageCount, requirements } =
    await readPublishedMediaAssets({ firestore, transaction });
  const uploadedMediaAssetId = assetIds.find(
    (_assetId, index) => assetSnapshots[index * 2]?.data()?.source === "upload",
  );
  let uploadedMediaReady = false;
  if (uploadedMediaAssetId !== undefined) {
    const [deploymentSnapshot] = await getAllBounded(transaction ?? firestore, [
      firestore.collection("system").doc("publicDeployment"),
    ]);
    try {
      assertMediaLifecycleDeploymentFence(deploymentSnapshot?.data());
      uploadedMediaReady = true;
    } catch {
      throw new PublishedMediaSafetyError(
        `Media asset ${uploadedMediaAssetId} cannot enter public content until public deployment coordination is active.`,
      );
    }
  }
  for (const [index, assetId] of assetIds.entries()) {
    const privateSnapshot = assetSnapshots[index * 2];
    const publicSnapshot = assetSnapshots[index * 2 + 1];
    assertPublishedAssetProjection({
      assetId,
      owner: assetOwners.get(assetId),
      privateSnapshot,
      publicSnapshot,
      uploadedMediaReady,
      ...requirements.get(assetId),
    });
  }

  return { pageCount: candidatePageCount, assetCount: assetIds.length };
}

module.exports = {
  MAX_GET_ALL_REFS,
  PUBLIC_PAGE_IDS,
  PublishedMediaSafetyError,
  assertPublishedAssetProjection,
  assertPublishedMediaSafe,
  collectPublishedArtifactMediaOwners,
  hasPotentialPublicSnapshot,
  readPublishedMediaAssets,
};
