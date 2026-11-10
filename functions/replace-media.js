"use strict";

const { preparePublicMediaChangeInTransaction } = require("./lib/public-release-producer");

// This boundary changes only the binary fields behind one stable uploaded AssetId. It writes a
// new content-addressed R2 object, retains every old final object and owner receipt, and commits
// the private version, exact public projection, new owner receipt, and audit row atomically.

const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { assertBillingEnabled } = require("./lib/billing-state");
const { can, hasCapability } = require("./lib/rbac");
const { requestHeader } = require("./lib/http-json");
const {
  MediaValidationError,
  finalObjectKey,
  mediaProjection,
  mediaType,
  normalizeOriginalName,
  publicMediaUrl,
  stagingObjectKey,
} = require("./lib/media-contract");
const {
  MediaLibraryValidationError,
  formatMediaEtag,
  isMediaAssetId,
  mediaAssetSummary,
  parseMediaIfMatch,
} = require("./lib/media-library");
const { AUTHOR_PHOTO_CATEGORY, AUTHOR_PROFILE_COLLECTIONS } = require("./lib/author-profile-contract");
const { createImagePurgeEntry } = require("./lib/media-bin");
const { mediaReplacementRef } = require("./lib/media-replacement");
const {
  bumpMediaDiscoveryRevision,
  withMediaDiscovery,
} = require("./lib/media-discovery");
const { MASTER_EXTENSIONS, masterObjectKey } = require("./lib/r2-media-masters");
const { addMediaThumbnails } = require("./lib/media-thumbnails");
const { assertPublicDeploymentPointer } = require("./lib/public-deployment");
const { publicDeploymentRef } = require("./lib/public-deployment-coordinator");
const { readRetainedPairMediaHoldInTransaction } = require("./lib/public-release-media-retention");
const { parseStoredPublicReleaseSelector } = require("./lib/public-release-pair");
const {
  MEDIA_ALLOWED_ORIGINS,
  MEDIA_PUBLIC_ORIGIN,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  RESERVATION_LEASE_MS,
  MediaRequestError,
  createDefaultStorage,
  createDefaultMasterStorage,
  prepareMediaUpload,
  processUploadImage,
  retainMaster,
  masterIntent,
  recordMasterResult,
  requireMasterAvailable,
  mayDiscloseDuplicate,
  inspectUpload,
  objectMetadata,
  parseMultipartUpload,
  putOrConfirm,
  readMaxUploadBytes,
  validateUploadRequest,
} = require("./media");

const REPLACEMENT_FIELDS = new Set(["assetId", "imageProcessing"]);
const NOT_FOUND_MESSAGE = "This media asset is not available.";
const DEPLOYMENT_REQUIRED_MESSAGE =
  "This media asset cannot be replaced until coordinated media deployment is active.";

class MediaReplacementRejection extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "MediaReplacementRejection";
    this.status = status;
    this.details = details;
  }
}

function sourceIp(req) {
  return requestHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
    req.ip || null;
}

function ownerRef(firestore, contentHash) {
  return firestore
    .collection("system")
    .doc("media")
    .collection("hashOwners")
    .doc(contentHash);
}

function replacementRef(firestore, assetId) {
  return mediaReplacementRef(firestore, assetId);
}

function usageQuery(firestore, state, assetId, generation = null) {
  let query = firestore
    .collectionGroup("mediaUsage")
    .where("state", "==", state);
  if (generation !== null) query = query.where("generation", "==", generation);
  return query.where("assetIds", "array-contains", assetId).limit(1);
}

async function assertNoProtectedWorkingUsage(firestore, transaction, assetId) {
  // A draft may be the first match. Check every working owner, and read its
  // current status in the transaction because approval need not rewrite usage.
  const usage = await transaction.get(firestore.collectionGroup("mediaUsage")
    .where("state", "==", "working")
    .where("assetIds", "array-contains", assetId));
  for (const document of usage.docs) {
    const ownerRef = document.ref.parent.parent;
    const owner = await transaction.get(ownerRef);
    const current = owner.data();
    // Profiles keep an attested photo URL even while unpublished. Replacing its
    // asset would leave that old photograph available for a later publication.
    if (owner.exists && ownerRef.parent.id === AUTHOR_PROFILE_COLLECTIONS.workingProfiles &&
        current.lifecycle !== "archived") {
      throw new MediaReplacementRejection(
        409,
        "This image is used by an author profile. Remove it from the affected profile before replacing this file, or upload a new image.",
      );
    }
    const status = current?.status;
    if (status === "approved" || status === "scheduled") {
      throw new MediaReplacementRejection(
        409,
        "This image is used by approved or scheduled content. Upload a new image, or reopen the affected content as drafts before replacing this file.",
      );
    }
  }
}

function activeDeploymentGeneration(snapshot) {
  if (!snapshot.exists) return null;
  try {
    if (snapshot.data()?.schemaVersion === 2) return parseStoredPublicReleaseSelector(snapshot.data()).activeGeneration;
    return assertPublicDeploymentPointer(snapshot.data()).activeGeneration;
  } catch {
    throw new MediaReplacementRejection(
      503,
      "This media asset needs operator recovery before its file can be replaced.",
    );
  }
}

function pendingStagingCleanup(owner) {
  if (
    owner?.stagingCleanupPending !== true ||
    typeof owner.attemptId !== "string" ||
    typeof owner.stagingKey !== "string"
  ) {
    return null;
  }
  return { attemptId: owner.attemptId, stagingKey: owner.stagingKey };
}

function binaryVersion(record) {
  return {
    originalName: record.originalName,
    mimeType: record.mimeType,
    kind: record.kind,
    sizeBytes: record.sizeBytes,
    width: record.width,
    height: record.height,
    contentHash: record.contentHash,
    storageKey: record.storageKey,
    url: record.url,
    version: record.version,
    master: record.master ?? null,
  };
}

function validUploadedBinary(record, assetId, publicOrigin = null) {
  if (
    !record ||
    record.id !== assetId ||
    record.source !== "upload" ||
    record.lifecycle !== "active" ||
    typeof record.category !== "string" ||
    typeof record.originalName !== "string" ||
    !Number.isSafeInteger(record.version) ||
    record.version < 1 ||
    !/^[a-f0-9]{64}$/.test(record.contentHash ?? "") ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 1
  ) {
    return false;
  }
  try {
    const expectedKey = finalObjectKey({
      category: record.category,
      assetId,
      contentHash: record.contentHash,
      mimeType: record.mimeType,
    });
    return (
      record.storageKey === expectedKey &&
      (publicOrigin === null ||
        record.url === publicMediaUrl(publicOrigin, expectedKey))
    );
  } catch {
    return false;
  }
}

function validActor(value) {
  return Boolean(
    value &&
    typeof value.uid === "string" &&
    value.uid.length > 0 &&
    (value.email === null || typeof value.email === "string"),
  );
}

function validReplacementClaim(
  claim,
  { assetId, contentHash, stored, publicOrigin },
) {
  if (
    !claim ||
    claim.operation !== "replacement" ||
    claim.assetId !== assetId ||
    claim.contentHash !== contentHash ||
    claim.category !== stored.category ||
    claim.baseVersion !== stored.version ||
    !isDeepStrictEqual(claim.before, binaryVersion(stored)) ||
    !["reserved", "object_ready"].includes(claim.state) ||
    typeof claim.attemptId !== "string" ||
    !Number.isSafeInteger(claim.sizeBytes) ||
    claim.sizeBytes < 1 ||
    !mediaType(claim.mimeType) ||
    (claim.finalObjectAttemptId !== undefined && !isMediaAssetId(claim.finalObjectAttemptId)) ||
    !validActor(claim.recordSeed?.actor)
  ) {
    return false;
  }
  try {
    const expectedKey = finalObjectKey({
      category: stored.category,
      assetId,
      contentHash,
      mimeType: claim.mimeType,
    });
    const type = mediaType(claim.mimeType);
    const dimensions = claim.recordSeed.dimensions;
    const validDimensions = type.kind === "image"
      ? Number.isSafeInteger(dimensions?.width) &&
        dimensions.width > 0 &&
        Number.isSafeInteger(dimensions?.height) &&
        dimensions.height > 0
      : dimensions?.width === null && dimensions?.height === null;
    return (
      claim.finalKey === expectedKey &&
      claim.publicUrl === publicMediaUrl(publicOrigin, expectedKey) &&
      claim.stagingKey === stagingObjectKey(claim.attemptId) &&
      normalizeOriginalName(claim.recordSeed.originalName) ===
        claim.recordSeed.originalName &&
      validDimensions &&
      (claim.recordSeed.source === null ||
        typeof claim.recordSeed.source === "string")
    );
  } catch {
    return false;
  }
}

function ownerMirrorsClaim(owner, claim) {
  return Boolean(
    owner &&
    owner.operation === "replacement" &&
    owner.assetId === claim.assetId &&
    owner.attemptId === claim.attemptId &&
    owner.contentHash === claim.contentHash &&
    owner.category === claim.category &&
    owner.state === claim.state &&
    owner.baseVersion === claim.baseVersion &&
    owner.finalObjectAttemptId === claim.finalObjectAttemptId &&
    owner.finalKey === claim.finalKey &&
    owner.publicUrl === claim.publicUrl &&
    owner.stagingKey === claim.stagingKey &&
    owner.mimeType === claim.mimeType &&
    owner.sizeBytes === claim.sizeBytes &&
    isDeepStrictEqual(owner.before, claim.before) &&
    isDeepStrictEqual(owner.recordSeed, claim.recordSeed),
  );
}

function uploadedOwnerMatches(owner, stored) {
  return Boolean(
    owner &&
    owner.state === "committed" &&
    owner.assetId === stored.id &&
    owner.category === stored.category &&
    owner.finalKey === stored.storageKey,
  );
}

function masterConfirmsRetry(master, sourceMaster) {
  if (!sourceMaster) return true;
  return master?.contentHash === sourceMaster.contentHash &&
    (master.retained !== true || master.key === sourceMaster.key);
}

function committedOwnerConfirmsRetry(
  owner,
  { stored, baseVersion, upload, dimensions, sourceMaster },
) {
  return Boolean(
    owner.operation === "replacement" &&
    owner.contentHash === stored.contentHash &&
    owner.previousVersion === baseVersion &&
    owner.committedVersion === stored.version &&
    stored.version === baseVersion + 1 &&
    owner.mimeType === upload.mimeType &&
    owner.sizeBytes === upload.buffer.length &&
    owner.recordSeed?.originalName === upload.originalName &&
    isDeepStrictEqual(owner.recordSeed?.dimensions, dimensions) &&
    masterConfirmsRetry(owner.recordSeed?.master, sourceMaster) &&
    (!sourceMaster || isDeepStrictEqual(owner.recordSeed?.master, stored.master)),
  );
}

async function reserveReplacement({
  firestore,
  assetId,
  baseVersion,
  upload,
  contentHash,
  dimensions,
  animated = false,
  master = null,
  sourceMaster = null,
  actor,
  attemptId,
  nowDate,
  publicOrigin,
}) {
  const claimRef = replacementRef(firestore, assetId);
  const nextOwnerRef = ownerRef(firestore, contentHash);
  return firestore.runTransaction(async (transaction) => {
    await requireMasterAvailable(transaction, firestore, master);
    const assetRef = firestore.collection("media_assets").doc(assetId);
    const publicRef = firestore.collection("media_assets_public").doc(assetId);
    const [
      assetSnapshot,
      publicSnapshot,
      claimSnapshot,
      nextOwnerSnapshot,
      revivedVersionSnapshot,
      publishedUsage,
      deploymentSnapshot,
    ] = await Promise.all([
      transaction.get(assetRef),
      transaction.get(publicRef),
      transaction.get(claimRef),
      transaction.get(nextOwnerRef),
      transaction.get(firestore.collection("mediaPurgeQueue").doc(`version:${assetId}:${contentHash}`)),
      transaction.get(usageQuery(firestore, "published", assetId)),
      transaction.get(publicDeploymentRef(firestore)),
    ]);
    if (!assetSnapshot.exists) {
      throw new MediaReplacementRejection(404, NOT_FOUND_MESSAGE);
    }
    const stored = assetSnapshot.data();
    if (
      stored?.lifecycle !== "active" ||
      typeof stored.category !== "string" ||
      !can(actor.principal, "media.manage")
    ) {
      throw new MediaReplacementRejection(404, NOT_FOUND_MESSAGE);
    }
    if (stored.kind !== "image" || mediaType(upload.mimeType)?.kind !== "image") {
      throw new MediaReplacementRejection(400, "Only an image can replace an image.");
    }
    if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
      throw new MediaReplacementRejection(
        409,
        "This media asset has no current version.",
      );
    }
    const summary = mediaAssetSummary(assetId, stored);
    if (
      !summary ||
      !validUploadedBinary(stored, assetId, publicOrigin) ||
      !publicSnapshot.exists ||
      !isDeepStrictEqual(publicSnapshot.data(), mediaProjection(stored))
    ) {
      throw new MediaReplacementRejection(
        stored.source === "site_seed" ? 409 : 503,
        stored.source === "site_seed"
          ? DEPLOYMENT_REQUIRED_MESSAGE
          : "This media asset needs operator recovery before its file can be replaced.",
      );
    }
    const activeGeneration = activeDeploymentGeneration(deploymentSnapshot);
    const deployedUsage = activeGeneration === null
      ? null
      : await transaction.get(
        usageQuery(firestore, "deployed", assetId, activeGeneration),
      );
    if (
      !publishedUsage.empty ||
      (deployedUsage && !deployedUsage.empty)
    ) {
      throw new MediaReplacementRejection(409, DEPLOYMENT_REQUIRED_MESSAGE);
    }
    await assertNoProtectedWorkingUsage(firestore, transaction, assetId);

    const currentOwnerSnapshot = await transaction.get(
      ownerRef(firestore, stored.contentHash),
    );
    const currentOwner = currentOwnerSnapshot.exists
      ? currentOwnerSnapshot.data()
      : null;
    if (!uploadedOwnerMatches(currentOwner, stored)) {
      throw new MediaReplacementRejection(
        503,
        "This media asset needs operator recovery before its file can be replaced.",
      );
    }

    const activeClaim = claimSnapshot.exists ? claimSnapshot.data() : null;
    let nextOwner = nextOwnerSnapshot.exists ? nextOwnerSnapshot.data() : null;
    const purgedOwner = nextOwner?.state === "purged" ? nextOwner : null;
    if (purgedOwner) nextOwner = null;
    let supersededOwner = null;
    if (stored.version !== baseVersion) {
      if (
        !activeClaim &&
        contentHash === stored.contentHash &&
        committedOwnerConfirmsRetry(currentOwner, {
          stored,
          baseVersion,
          upload,
          dimensions,
          sourceMaster,
        })
      ) {
        return {
          changed: false,
          asset: summary,
          recovered: true,
          cleanup: pendingStagingCleanup(currentOwner),
        };
      }
      throw new MediaReplacementRejection(
        412,
        "This media asset changed since you opened it. Reload before replacing the file.",
        { etag: formatMediaEtag(assetId, stored.version) },
      );
    }
    if (contentHash === stored.contentHash) {
      if (activeClaim) {
        throw new MediaReplacementRejection(
          503,
          "This media replacement needs operator recovery.",
        );
      }
      return {
        changed: false,
        asset: summary,
        cleanup: pendingStagingCleanup(currentOwner),
      };
    }
    if (revivedVersionSnapshot.exists && revivedVersionSnapshot.data().state === "purging") {
      throw new MediaReplacementRejection(503, "This historical version is being purged.");
    }
    if (!activeClaim && nextOwner?.state === "committed") {
      if (/^[a-f0-9]{64}$/.test(nextOwner.supersededByContentHash ?? "") &&
          typeof nextOwner.assetId === "string" && nextOwner.attemptId) {
        const supersedingAsset = await transaction.get(
          firestore.collection("media_assets").doc(nextOwner.assetId),
        );
        if (!supersedingAsset.exists ||
            !/^[a-f0-9]{64}$/.test(supersedingAsset.data().contentHash ?? "") ||
            supersedingAsset.data().contentHash === contentHash) {
          throw new MediaReplacementRejection(503, "This historical media receipt needs operator recovery.");
        }
        // Later replacements can move the asset beyond the immediate successor.
        supersededOwner = nextOwner;
        nextOwner = null;
      } else {
        const disclose = await mayDiscloseDuplicate(transaction, firestore, {
          owner: nextOwner, principal: actor.principal,
        });
        throw new MediaReplacementRejection(409, "This file is already in the media library.", {
          duplicateAssetId: disclose ? nextOwner.assetId : null,
        });
      }
    }
    if (activeClaim || nextOwner) {
      if (
        !activeClaim ||
        !nextOwner ||
        !validReplacementClaim(activeClaim, {
          assetId,
          contentHash,
          stored,
          publicOrigin,
        }) ||
        !ownerMirrorsClaim(nextOwner, activeClaim) ||
        activeClaim.mimeType !== upload.mimeType ||
        activeClaim.sizeBytes !== upload.buffer.length ||
        activeClaim.recordSeed.originalName !== upload.originalName ||
        !isDeepStrictEqual(activeClaim.recordSeed.dimensions, dimensions) ||
        !masterConfirmsRetry(activeClaim.recordSeed.master, sourceMaster)
      ) {
        throw new MediaReplacementRejection(
          503,
          "This media replacement needs operator recovery.",
        );
      }
      const leaseExpiresAt = Date.parse(activeClaim.leaseExpiresAt);
      if (!Number.isFinite(leaseExpiresAt)) {
        throw new MediaReplacementRejection(
          503,
          "This media replacement has an invalid recovery lease.",
        );
      }
      if (leaseExpiresAt > nowDate.getTime()) {
        throw new MediaReplacementRejection(
          409,
          "This media replacement is already being recovered. Try again later.",
          { retryable: true, attemptId: activeClaim.attemptId },
        );
      }
      if ((activeClaim.recordSeed.master?.contentHash ?? null) !== (master?.contentHash ?? null)) {
        throw new MediaReplacementRejection(409, "The pending replacement uses a different original.");
      }
      const renewed = {
        ...activeClaim,
        recordSeed: {
          ...activeClaim.recordSeed,
          ...(master && activeClaim.recordSeed.master?.retained !== true ? { master } : {}),
          ...(typeof activeClaim.recordSeed?.animated === "boolean"
            ? {}
            : { animated: animated === true }),
        },
        updatedAt: nowDate.toISOString(),
        leaseExpiresAt: new Date(
          nowDate.getTime() + RESERVATION_LEASE_MS,
        ).toISOString(),
        resumedAt: nowDate.toISOString(),
        recoveryCount: Number.isInteger(activeClaim.recoveryCount)
          ? activeClaim.recoveryCount + 1
          : 1,
      };
      transaction.set(claimRef, renewed);
      transaction.set(nextOwnerRef, renewed);
      return { changed: true, claim: renewed, stored, resumed: true };
    }

    const finalKey = finalObjectKey({
      category: stored.category,
      assetId,
      contentHash,
      mimeType: upload.mimeType,
    });
    const nowIso = nowDate.toISOString();
    const publicUrl = publicMediaUrl(publicOrigin, finalKey);
    const claim = {
      operation: "replacement",
      state: "reserved",
      assetId,
      attemptId,
      contentHash,
      category: stored.category,
      finalObjectAttemptId: supersededOwner?.assetId === assetId
        ? (supersededOwner.finalObjectAttemptId ?? supersededOwner.attemptId) : attemptId,
      baseVersion: stored.version,
      before: binaryVersion(stored),
      finalKey,
      publicUrl,
      stagingKey: stagingObjectKey(attemptId),
      mimeType: upload.mimeType,
      sizeBytes: upload.buffer.length,
      recordSeed: {
        originalName: upload.originalName,
        dimensions,
        animated: animated === true,
        master,
        actor: { uid: actor.uid, email: actor.email ?? null },
        source: upload.source,
      },
      createdAt: nowIso,
      updatedAt: nowIso,
      leaseExpiresAt: new Date(
        nowDate.getTime() + RESERVATION_LEASE_MS,
      ).toISOString(),
    };
    transaction.create(claimRef, claim);
    if (purgedOwner) {
      transaction.set(nextOwnerRef.collection("superseded").doc(purgedOwner.attemptId), purgedOwner);
      transaction.set(nextOwnerRef, claim);
    } else if (supersededOwner) {
      transaction.create(nextOwnerRef.collection("superseded").doc(supersededOwner.attemptId), supersededOwner);
      transaction.set(nextOwnerRef, claim);
    } else {
      transaction.create(nextOwnerRef, claim);
    }
    return { changed: true, claim, stored, resumed: false };
  });
}

async function markReplacementObjectReady({
  firestore,
  claimRef,
  nextOwnerRef,
  attemptId,
  nowIso,
}) {
  await firestore.runTransaction(async (transaction) => {
    const [claimSnapshot, ownerSnapshot] = await Promise.all([
      transaction.get(claimRef),
      transaction.get(nextOwnerRef),
    ]);
    const claim = claimSnapshot.exists ? claimSnapshot.data() : null;
    const owner = ownerSnapshot.exists ? ownerSnapshot.data() : null;
    if (
      !claim ||
      !owner ||
      claim.attemptId !== attemptId ||
      !ownerMirrorsClaim(owner, claim)
    ) {
      throw new MediaRequestError(
        "The media replacement reservation changed before the object was ready",
        503,
        { retryable: true, attemptId },
      );
    }
    if (claim.state === "object_ready") return;
    if (claim.state !== "reserved") {
      throw new MediaRequestError(
        "The media replacement reservation is not recoverable",
        503,
      );
    }
    const ready = {
      ...claim,
      state: "object_ready",
      objectReadyAt: nowIso,
      updatedAt: nowIso,
    };
    transaction.set(claimRef, ready);
    transaction.set(nextOwnerRef, ready);
  });
}

function replacementRecord(stored, claim, nowIso) {
  const record = {
    ...stored,
    id: claim.assetId,
    originalName: claim.recordSeed.originalName,
    mimeType: claim.mimeType,
    kind: mediaType(claim.mimeType).kind,
    sizeBytes: claim.sizeBytes,
    width: claim.recordSeed.dimensions.width,
    height: claim.recordSeed.dimensions.height,
    ...(typeof claim.recordSeed.animated === "boolean"
      ? { animated: claim.recordSeed.animated }
      : {}),
    contentHash: claim.contentHash,
    storageKey: claim.finalKey,
    url: claim.publicUrl,
    master: claim.recordSeed.master ?? null,
    thumbnails: [],
    version: stored.version + 1,
    updatedAt: nowIso,
    updatedBy: claim.recordSeed.actor.uid,
  };
  // Reset the old binary's state before the new synchronous thumbnail attempt.
  if (record.kind === "image") record.thumbnailStatus = "retryable";
  else delete record.thumbnailStatus;
  if (!mediaAssetSummary(claim.assetId, record)) {
    throw new MediaRequestError("The replacement media record is invalid", 503, {
      retryable: true,
      attemptId: claim.attemptId,
    });
  }
  try {
    return withMediaDiscovery(claim.assetId, record);
  } catch {
    throw new MediaRequestError("The replacement media record is invalid", 503, {
      retryable: true,
      attemptId: claim.attemptId,
    });
  }
}

async function commitReplacement({
  firestore,
  claimRef,
  nextOwnerRef,
  claim,
  record,
  actor,
  source,
  nowIso,
  adminLogEntryFn = adminLogEntry,
}) {
  await firestore.runTransaction(async (transaction) => {
    const assetRef = firestore.collection("media_assets").doc(claim.assetId);
    const publicRef = firestore
      .collection("media_assets_public")
      .doc(claim.assetId);
    const previousOwnerRef = ownerRef(firestore, claim.before.contentHash);
    const [
      claimSnapshot,
      ownerSnapshot,
      assetSnapshot,
      publicSnapshot,
      previousOwnerSnapshot,
      deploymentSnapshot,
      publishedUsage,
    ] = await Promise.all([
        transaction.get(claimRef),
        transaction.get(nextOwnerRef),
        transaction.get(assetRef),
        transaction.get(publicRef),
        transaction.get(previousOwnerRef),
        transaction.get(publicDeploymentRef(firestore)),
        transaction.get(usageQuery(firestore, "published", claim.assetId)),
      ]);
    const currentClaim = claimSnapshot.exists ? claimSnapshot.data() : null;
    const owner = ownerSnapshot.exists ? ownerSnapshot.data() : null;
    const stored = assetSnapshot.exists ? assetSnapshot.data() : null;
    const previousOwner = previousOwnerSnapshot.exists
      ? previousOwnerSnapshot.data()
      : null;
    const activeGeneration = activeDeploymentGeneration(deploymentSnapshot);
    const pairHold = deploymentSnapshot.data()?.schemaVersion === 2
      ? await readRetainedPairMediaHoldInTransaction({ firestore, transaction,
        root: deploymentSnapshot.data(), assetId: claim.assetId }) : null;
    const deployedUsage = activeGeneration === null
      ? null
      : await transaction.get(
        usageQuery(firestore, "deployed", claim.assetId, activeGeneration),
      );
    await assertNoProtectedWorkingUsage(firestore, transaction, claim.assetId);
    if (
      !publishedUsage.empty ||
      !currentClaim ||
      currentClaim.state !== "object_ready" ||
      currentClaim.attemptId !== claim.attemptId ||
      !ownerMirrorsClaim(owner, currentClaim) ||
      !validUploadedBinary(stored, claim.assetId) ||
      !uploadedOwnerMatches(previousOwner, stored) ||
      previousOwner?.supersededByContentHash !== undefined ||
      stored.version !== claim.baseVersion ||
      !isDeepStrictEqual(binaryVersion(stored), claim.before) ||
      !publicSnapshot.exists ||
      !isDeepStrictEqual(publicSnapshot.data(), mediaProjection(stored)) ||
      (deployedUsage && !deployedUsage.empty) ||
      !isDeepStrictEqual(record, replacementRecord(stored, currentClaim, nowIso))
    ) {
      throw new MediaRequestError(
        "The media replacement needs recovery before it can be committed",
        503,
        { retryable: true, attemptId: claim.attemptId },
      );
    }
    const purgeEntryId = `version:${claim.assetId}:${stored.contentHash}`;
    const revivedVersionRef = firestore.collection("mediaPurgeQueue")
      .doc(`version:${claim.assetId}:${claim.contentHash}`);
    const revivedVersion = await transaction.get(revivedVersionRef);
    if (revivedVersion.exists && revivedVersion.data().state === "purging") {
      throw new MediaRequestError("This historical version is being purged", 503);
    }
    const writeReleaseChange = await preparePublicMediaChangeInTransaction({ firestore, transaction,
      id: record.id, version: record.version, before: publicSnapshot.data(), after: mediaProjection(record), mediaSource: record });
    writeReleaseChange();
    if (revivedVersion.exists && ["pending", "blocked"].includes(revivedVersion.data().state)) {
      transaction.update(revivedVersionRef, { state: "cancelled" });
    }
    transaction.set(firestore.collection("mediaPurgeQueue").doc(purgeEntryId), {
      ...createImagePurgeEntry(claim.assetId, stored, nowIso),
      reason: "superseded",
    });
    transaction.set(assetRef, record);
    transaction.set(publicRef, mediaProjection(record));
    bumpMediaDiscoveryRevision(transaction, firestore, { preserveAdmission: true });
    transaction.set(nextOwnerRef, {
      ...owner,
      state: "committed",
      previousContentHash: claim.before.contentHash,
      previousFinalKey: claim.before.storageKey,
      previousVersion: claim.before.version,
      committedVersion: record.version,
      committedAt: nowIso,
      updatedAt: nowIso,
      stagingCleanupPending: true,
      stagingCleanupPendingAt: nowIso,
    });
    transaction.set(previousOwnerRef, {
      ...previousOwner,
      supersededByContentHash: claim.contentHash,
      supersededByFinalKey: claim.finalKey,
      supersededAt: nowIso,
    });
    transaction.delete(claimRef);
    transaction.create(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      adminLogEntryFn({
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        action: "media.binary.replace",
        target: `media_assets/${claim.assetId}`,
        before: claim.before,
        after: { ...binaryVersion(record), purgeEntryId,
          ...(pairHold ? { retainedReleaseBytes: pairHold } : {}) },
        source,
      }),
    );
  });
}

async function clearReplacementStagingCleanup({
  firestore,
  nextOwnerRef,
  claim,
}) {
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(nextOwnerRef);
    const owner = snapshot.exists ? snapshot.data() : null;
    if (
      !owner ||
      owner.state !== "committed" ||
      owner.operation !== "replacement" ||
      owner.assetId !== claim.assetId ||
      owner.attemptId !== claim.attemptId ||
      owner.contentHash !== claim.contentHash ||
      owner.stagingCleanupPending !== true
    ) {
      return;
    }
    const updated = { ...owner };
    delete updated.stagingCleanupPending;
    delete updated.stagingCleanupPendingAt;
    transaction.set(nextOwnerRef, updated);
  });
}

async function cleanupReplacementStaging({
  firestore,
  storage,
  nextOwnerRef,
  claim,
}) {
  await storage.deleteStaging(claim.stagingKey);
  await clearReplacementStagingCleanup({ firestore, nextOwnerRef, claim });
}

async function committedReplacement(firestore, { claim, record }) {
  const claimRef = replacementRef(firestore, claim.assetId);
  const [claimSnapshot, ownerSnapshot, assetSnapshot, publicSnapshot] =
    await Promise.all([
      claimRef.get(),
      ownerRef(firestore, claim.contentHash).get(),
      firestore.collection("media_assets").doc(claim.assetId).get(),
      firestore.collection("media_assets_public").doc(claim.assetId).get(),
    ]);
  if (
    claimSnapshot.exists ||
    !ownerSnapshot.exists ||
    !assetSnapshot.exists ||
    !publicSnapshot.exists
  ) {
    return false;
  }
  const owner = ownerSnapshot.data();
  const stored = assetSnapshot.data();
  return Boolean(
    owner.state === "committed" &&
    owner.operation === "replacement" &&
    owner.assetId === claim.assetId &&
    owner.attemptId === claim.attemptId &&
    owner.contentHash === claim.contentHash &&
    owner.committedVersion === record.version &&
    isDeepStrictEqual(stored, record) &&
    isDeepStrictEqual(publicSnapshot.data(), mediaProjection(record)),
  );
}

function validateReplacementUpload(upload) {
  const fields = upload?.fields;
  if (
    !fields ||
    Object.keys(fields).some((field) => !REPLACEMENT_FIELDS.has(field)) ||
    !Object.hasOwn(fields, "assetId") ||
    !isMediaAssetId(fields.assetId)
  ) {
    throw new MediaReplacementRejection(
      400,
      "assetId must be one bounded media asset id",
    );
  }
  return fields.assetId;
}

function createCmsReplaceMediaBinaryHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    parseUploadFn = (req, limit) =>
      parseMultipartUpload(req, limit, REPLACEMENT_FIELDS),
    inspectUploadFn = inspectUpload,
    processUploadImageFn = processUploadImage,
    masterStorageFactory = createDefaultMasterStorage,
    assertBillingEnabledFn = assertBillingEnabled,
    storageFactory = createDefaultStorage,
    mintId = randomUUID,
    now = () => new Date(),
    maxUploadBytes = readMaxUploadBytes,
    publicOrigin = () => MEDIA_PUBLIC_ORIGIN.value(),
    adminLogEntryFn = adminLogEntry,
    reserveReplacementFn = reserveReplacement,
    markObjectReadyFn = markReplacementObjectReady,
    commitReplacementFn = commitReplacement,
    committedReplacementFn = committedReplacement,
    log = logger,
  } = deps;

  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    let context = null;
    let storage = null;
    try {
      const actor = await requirePrincipalFn(req);
      if (!hasCapability(actor.principal, "media.manage")) {
        throw new MediaReplacementRejection(404, NOT_FOUND_MESSAGE);
      }
      try {
        await assertBillingEnabledFn(firestore);
      } catch (error) {
        if (error?.code === "failed-precondition") {
          throw new MediaRequestError(error.message, 503);
        }
        throw error;
      }
      const limit = typeof maxUploadBytes === "function"
        ? maxUploadBytes()
        : maxUploadBytes;
      validateUploadRequest(req, limit);
      let upload = await parseUploadFn(req, limit);
      const assetId = validateReplacementUpload(upload);
      const ifMatch = requestHeader(req, "if-match");
      if (ifMatch === undefined) {
        res.status(428).json({
          error: "If-Match is required for a media binary replacement",
        });
        return;
      }
      const baseVersion = parseMediaIfMatch(ifMatch, assetId);
      if (baseVersion === null) {
        res.status(400).json({
          error: "If-Match must be one strong ETag for this media asset",
        });
        return;
      }
      if (upload.buffer.length > limit) {
        throw new MediaRequestError(
          `The file exceeds the ${limit} byte upload limit`,
          413,
        );
      }
      upload.originalName = normalizeOriginalName(upload.originalName);
      // Authorize the stored category before processing or retaining any original.
      const assetSnapshot = await firestore.collection("media_assets").doc(assetId).get();
      const asset = assetSnapshot.data();
      if (!asset || asset.lifecycle !== "active" ||
          !can(actor.principal, "media.manage")) {
        throw new MediaReplacementRejection(404, NOT_FOUND_MESSAGE);
      }
      if (asset.kind !== "image" || mediaType(upload.mimeType)?.kind !== "image") {
        throw new MediaReplacementRejection(400, "Only an image can replace an image.");
      }
      const profilePhoto = asset.category === AUTHOR_PHOTO_CATEGORY;
      if (profilePhoto && upload.fields.imageProcessing !== undefined &&
          upload.fields.imageProcessing !== "") {
        throw new MediaValidationError("Profile photos must keep the original file");
      }
      const { storedUpload, dimensions, animated, processed, sourceDimensions } =
        await prepareMediaUpload({
          upload, limit, inspectUploadFn, processUploadImageFn, profilePhoto,
        });
      // Derive retry identity from the incoming original, independently of a storage write.
      const sourceHash = processed
        ? createHash("sha256").update(upload.buffer).digest("hex") : null;
      const sourceMaster = processed ? {
        contentHash: sourceHash,
        key: Object.hasOwn(MASTER_EXTENSIONS, upload.mimeType)
          ? masterObjectKey({ contentHash: sourceHash, mimeType: upload.mimeType }) : null,
      } : null;
      const sourceUpload = upload;
      const master = processed ? masterIntent(upload, sourceDimensions) : null;
      upload = { ...upload, buffer: storedUpload.buffer, mimeType: storedUpload.mimeType };
      const contentHash = createHash("sha256")
        .update(upload.buffer)
        .digest("hex");
      const nowDate = now();
      const nowIso = nowDate.toISOString();
      const resolvedPublicOrigin = typeof publicOrigin === "function"
        ? publicOrigin()
        : publicOrigin;
      const proposedAttemptId = mintId();
      context = { assetId, attemptId: proposedAttemptId, contentHash };
      const reservation = await reserveReplacementFn({
        firestore,
        assetId,
        baseVersion,
        upload: { ...upload, source: sourceIp(req) },
        contentHash,
        dimensions,
        animated,
        master,
        sourceMaster,
        actor,
        attemptId: proposedAttemptId,
        nowDate,
        publicOrigin: resolvedPublicOrigin,
      });
      if (!reservation.changed) {
        if (reservation.cleanup) {
          const cleanupClaim = {
            assetId,
            contentHash,
            ...reservation.cleanup,
          };
          try {
            storage = await storageFactory();
            await cleanupReplacementStaging({
              firestore,
              storage,
              nextOwnerRef: ownerRef(firestore, contentHash),
              claim: cleanupClaim,
            });
          } catch (error) {
            log.warn("cmsReplaceMediaBinary could not remove staging object", {
              error: error?.message || String(error),
              assetId,
              attemptId: cleanupClaim.attemptId,
              contentHash,
              stagingKey: cleanupClaim.stagingKey,
            });
          }
        }
        res.set("ETag", reservation.asset.etag);
        res.status(200).json({
          success: true,
          changed: false,
          asset: reservation.asset,
        });
        return;
      }

      const { claim, stored } = reservation;
      const claimRef = replacementRef(firestore, assetId);
      const nextOwnerRef = ownerRef(firestore, contentHash);
      if (processed && claim.recordSeed.master?.retained !== true) {
        claim.recordSeed.master = await retainMaster({
          masterStorageFactory, upload: sourceUpload, dimensions: sourceDimensions, log,
        });
        await recordMasterResult({ firestore, refs: [claimRef, nextOwnerRef],
          attemptId: claim.attemptId, leaseExpiresAt: claim.leaseExpiresAt, master: claim.recordSeed.master });
      }
      context = {
        assetId,
        attemptId: claim.attemptId,
        contentHash,
        finalKey: claim.finalKey,
      };
      storage = await storageFactory();
      const expectedObject = {
        assetId,
        attemptId: claim.attemptId,
        contentHash,
        sizeBytes: claim.sizeBytes,
        mimeType: claim.mimeType,
      };
      const metadata = objectMetadata(expectedObject);
      try {
        await putOrConfirm({
          storage,
          method: "putStaging",
          key: claim.stagingKey,
          body: upload.buffer,
          mimeType: claim.mimeType,
          metadata,
          expected: expectedObject,
        });
        await putOrConfirm({
          storage,
          method: "putFinal",
          key: claim.finalKey,
          body: upload.buffer,
          mimeType: claim.mimeType,
          metadata: objectMetadata({
            ...expectedObject, attemptId: claim.finalObjectAttemptId ?? claim.attemptId,
          }),
          expected: {
            ...expectedObject, attemptId: claim.finalObjectAttemptId ?? claim.attemptId,
          },
        });
      } catch (error) {
        log.error("cmsReplaceMediaBinary object needs recovery", {
          error: error?.message || String(error),
          ...context,
        });
        throw new MediaRequestError(
          "The media replacement needs recovery before it can be retried",
          503,
          { retryable: true, attemptId: claim.attemptId },
        );
      }
      await markObjectReadyFn({
        firestore,
        claimRef,
        nextOwnerRef,
        attemptId: claim.attemptId,
        nowIso,
      });
      const record = replacementRecord(
        stored,
        claim,
        nowIso,
      );
      try {
        await commitReplacementFn({
          firestore,
          claimRef,
          nextOwnerRef,
          claim,
          record,
          actor: claim.recordSeed.actor,
          source: claim.recordSeed.source,
          nowIso,
          adminLogEntryFn,
        });
      } catch (error) {
        if (!(await committedReplacementFn(firestore, { claim, record }))) {
          log.error("cmsReplaceMediaBinary commit needs recovery", {
            error: error?.message || String(error),
            ...context,
          });
          throw new MediaRequestError(
            "The media replacement needs recovery before it can be retried",
            503,
            { retryable: true, attemptId: claim.attemptId },
          );
        }
      }
      try {
        await cleanupReplacementStaging({
          firestore,
          storage,
          nextOwnerRef,
          claim,
        });
      } catch (error) {
        log.warn("cmsReplaceMediaBinary could not remove staging object", {
          error: error?.message || String(error),
          ...context,
          stagingKey: claim.stagingKey,
        });
      }
      const finalRecord = await addMediaThumbnails({
        firestore,
        storage,
        record,
        buffer: upload.buffer,
        publicOrigin: resolvedPublicOrigin,
        log,
      });
      const responseAsset = mediaAssetSummary(assetId, finalRecord);
      res.set("ETag", responseAsset.etag);
      res.status(200).json({
        success: true,
        changed: true,
        asset: responseAsset,
      });
    } catch (error) {
      if (res.headersSent) return;
      const expected =
        error instanceof MediaReplacementRejection ||
        error instanceof MediaRequestError ||
        error instanceof MediaValidationError ||
        error instanceof MediaLibraryValidationError;
      let responseError = error;
      if (!expected && context) {
        responseError = new MediaRequestError(
          "The media replacement needs recovery before it can be retried",
          503,
          { retryable: true, attemptId: context.attemptId },
        );
      }
      const safeResponse =
        expected || responseError instanceof MediaRequestError;
      const status = responseError?.status ?? 500;
      if (responseError?.details?.etag) {
        res.set("ETag", responseError.details.etag);
      }
      if (!expected || status >= 500) {
        log.error("cmsReplaceMediaBinary failed", {
          error: error?.message || String(error),
          ...context,
        });
      }
      res.status(status).json({
        error: safeResponse
          ? responseError.message
          : "The media file could not be replaced",
        ...(Object.hasOwn(responseError?.details ?? {}, "duplicateAssetId")
          ? { duplicateAssetId: responseError.details.duplicateAssetId } : {}),
        ...(responseError?.details?.retryable
          ? {
              retryable: true,
              attemptId:
                responseError.details.attemptId ?? context?.attemptId ?? null,
            }
          : {}),
      });
    }
  };
}

const cmsReplaceMediaBinary = cmsOnRequest(
  {
    cors: MEDIA_ALLOWED_ORIGINS,
    memory: "1GiB",
    concurrency: 1,
    maxInstances: 5,
    timeoutSeconds: 120,
    secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY],
  },
  createCmsReplaceMediaBinaryHandler(),
);

module.exports = {
  DEPLOYMENT_REQUIRED_MESSAGE,
  MediaReplacementRejection,
  NOT_FOUND_MESSAGE,
  REPLACEMENT_FIELDS,
  binaryVersion,
  cmsReplaceMediaBinary,
  commitReplacement,
  committedReplacement,
  createCmsReplaceMediaBinaryHandler,
  markReplacementObjectReady,
  replacementRecord,
  replacementRef,
  reserveReplacement,
  validateReplacementUpload,
};
