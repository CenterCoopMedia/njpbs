"use strict";

const { randomUUID } = require("node:crypto");
const { curatedLifecycleFailureMessage, lifecycleErrorDiagnostic } = require("./lib/lifecycle-error");

const { preparePublicMediaChangeInTransaction } = require("./lib/public-release-producer");
const { readRetainedPairMediaHoldInTransaction } = require("./lib/public-release-media-retention");
const { parseStoredPublicReleaseSelector } = require("./lib/public-release-pair");

// This server-only boundary withdraws or restores a media projection. It never deletes the
// immutable R2 object. Only the restore-only handler is exported by Firebase;
// the general lifecycle handler retains its deployment fence and stays private.

const { cmsOnRequest } = require("./lib/cms-edge");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { can, hasCapability, withRegisteredMediaSections } = require("./lib/rbac");
const { principalFromStoredUserDoc } = require("./lib/principal");
const { readRegisteredSectionIds } = require("./lib/content-sections");
const {
  requestHeader,
  validateBoundedJsonRequest,
} = require("./lib/http-json");
const { finalObjectKey, mediaProjection } = require("./lib/media-contract");
const {
  formatMediaEtag,
  isMediaAssetId,
  mediaAssetSummary,
  parseMediaIfMatch,
} = require("./lib/media-library");
const {
  assertMediaLifecycleDeploymentFence,
} = require("./lib/public-deployment");
const { mediaReplacementRef } = require("./lib/media-replacement");
const {
  readMediaAdmission,
  writeMediaAdmission,
  prepareMediaAdmissionRelease,
  bumpMediaDiscoveryRevision,
  withMediaDiscovery,
} = require("./lib/media-discovery");
const { mediaPurgeRef } = require("./lib/media-bin");
const { normalizeMediaCategoryAssignments } = require("./lib/media-contract");
const { requireManagedMediaCategories } = require("./lib/media-categories");
const { R2MediaStorage } = require("./lib/r2-media");
const { setPrivateNoStore } = require("./list-media");
const {
  MEDIA_ALLOWED_ORIGINS,
  R2_ACCESS_KEY_ID,
  R2_BUCKET,
  R2_ENDPOINT,
  R2_SECRET_ACCESS_KEY,
  storedObjectMatches,
} = require("./media");

const REQUEST_FIELDS = new Set(["assetId", "action"]);
const LIFECYCLE_ACTIONS = new Set(["tombstone", "reactivate"]);
const NOT_FOUND_MESSAGE = "This media asset is not available.";
const JSON_LIMIT_BYTES = 4 * 1024;

class MediaLifecycleRejection extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "MediaLifecycleRejection";
    this.status = status;
    this.details = details;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateMediaLifecycleRequest(body) {
  if (!plainObject(body)) return "The media lifecycle request must be an object";
  const unknown = Object.keys(body).find((field) => !REQUEST_FIELDS.has(field));
  if (unknown) return `Unknown request field ${unknown}`;
  if (!isMediaAssetId(body.assetId)) {
    return "assetId must be a bounded media asset id";
  }
  if (!LIFECYCLE_ACTIONS.has(body.action)) {
    return "action must be tombstone or reactivate";
  }
  return null;
}

function sourceIp(req) {
  return requestHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
    req.ip || null;
}

function deploymentRef(firestore) {
  return firestore.collection("system").doc("publicDeployment");
}

function ownerRef(firestore, contentHash) {
  return firestore
    .collection("system")
    .doc("media")
    .collection("hashOwners")
    .doc(contentHash);
}

function usageQuery(firestore, state, assetId, generation = null) {
  let query = firestore
    .collectionGroup("mediaUsage")
    .where("state", "==", state);
  if (generation !== null) query = query.where("generation", "==", generation);
  return query.where("assetIds", "array-contains", assetId).limit(1);
}

function lifecycleResult(assetId, lifecycle, version, changed) {
  return {
    success: true,
    changed,
    asset: {
      id: assetId,
      lifecycle,
      version,
      etag: formatMediaEtag(assetId, version),
    },
  };
}

function assertStoredAsset(stored, assetId, principal, baseVersion) {
  if (
    !plainObject(stored) ||
    typeof stored.category !== "string" ||
    !can(principal, "media.manage")
  ) {
    throw new MediaLifecycleRejection(404, NOT_FOUND_MESSAGE);
  }
  if (!Number.isSafeInteger(stored.version) || stored.version < 1) {
    throw new MediaLifecycleRejection(
      409,
      "This media asset has no current version.",
    );
  }
  if (stored.version !== baseVersion) {
    throw new MediaLifecycleRejection(
      412,
      "This media asset changed since you opened it. Reload before saving.",
      { etag: formatMediaEtag(assetId, stored.version) },
    );
  }
  if (stored.lifecycle !== "active" && stored.lifecycle !== "tombstoned") {
    throw new MediaLifecycleRejection(
      409,
      ["purging", "purged"].includes(stored.lifecycle)
        ? "This image is being removed or has already been removed."
        : "This media asset has an invalid lifecycle state.",
    );
  }
}

function assertCommittedOwner(owner, stored, assetId) {
  if (
    !plainObject(owner) ||
    owner.state !== "committed" ||
    owner.assetId !== assetId ||
    owner.finalKey !== stored.storageKey ||
    typeof owner.attemptId !== "string" ||
    !isMediaAssetId(owner.attemptId) ||
    (owner.finalObjectAttemptId !== undefined && !isMediaAssetId(owner.finalObjectAttemptId))
  ) {
    throw new MediaLifecycleRejection(
      409,
      "The stored media object cannot be verified.",
    );
  }
  return owner.finalObjectAttemptId ?? owner.attemptId;
}

function expectedStoredObject(stored, assetId, attemptId) {
  if (
    typeof stored.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(stored.contentHash) ||
    typeof stored.storageKey !== "string" ||
    stored.storageKey.length === 0 ||
    typeof stored.mimeType !== "string" ||
    !Number.isSafeInteger(stored.sizeBytes) ||
    stored.sizeBytes < 1
  ) {
    throw new MediaLifecycleRejection(
      409,
      "The stored media object cannot be verified.",
    );
  }
  let expectedKey;
  try {
    expectedKey = finalObjectKey({
      category: stored.category,
      assetId,
      contentHash: stored.contentHash,
      mimeType: stored.mimeType,
    });
  } catch {
    throw new MediaLifecycleRejection(
      409,
      "The stored media object cannot be verified.",
    );
  }
  if (stored.storageKey !== expectedKey) {
    throw new MediaLifecycleRejection(
      409,
      "The stored media object cannot be verified.",
    );
  }
  return {
    contentHash: stored.contentHash,
    assetId,
    attemptId,
    sizeBytes: stored.sizeBytes,
    mimeType: stored.mimeType,
  };
}

function sameExpectedStoredObject(current, expected) {
  return current.contentHash === expected.contentHash &&
    current.assetId === expected.assetId &&
    current.attemptId === expected.attemptId &&
    current.sizeBytes === expected.sizeBytes &&
    current.mimeType === expected.mimeType;
}

function createDefaultStorage() {
  let accessKeyId;
  let secretAccessKey;
  try {
    accessKeyId = R2_ACCESS_KEY_ID.value().trim();
    secretAccessKey = R2_SECRET_ACCESS_KEY.value().trim();
  } catch {
    throw new MediaLifecycleRejection(
      503,
      "The media store credentials are not configured.",
    );
  }
  const endpoint = R2_ENDPOINT.value().trim();
  const bucket = R2_BUCKET.value().trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new MediaLifecycleRejection(
      503,
      "The media store is not configured.",
    );
  }
  return new R2MediaStorage({ endpoint, bucket, accessKeyId, secretAccessKey });
}

function auditEntry({ adminLogEntryFn, user, action, assetId, before, after, req }) {
  const code = action === "restore" ? "media.library.restore" : `media.lifecycle.${action}`;
  return adminLogEntryFn({
    actorUid: user.uid,
    actorEmail: user.email ?? null,
    action: code,
    target: `media_assets/${assetId}`,
    before,
    after,
    source: sourceIp(req),
  });
}

function createCmsSetMediaLifecycleHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    storageFactory = createDefaultStorage,
    adminLogEntryFn = adminLogEntry,
    now = () => new Date().toISOString(),
    log = logger,
    restoreOnly = false,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      validateBoundedJsonRequest(req, JSON_LIMIT_BYTES);
      const validationError = restoreOnly
        ? (!plainObject(req.body) || Object.keys(req.body).some((key) => key !== "assetId")
          ? "The restore request accepts only assetId"
          : validateMediaLifecycleRequest({ ...req.body, action: "reactivate" }))
        : validateMediaLifecycleRequest(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      const { assetId } = req.body;
      const action = restoreOnly ? "reactivate" : req.body.action;
      const ifMatch = requestHeader(req, "if-match");
      if (ifMatch === undefined) {
        res.status(428).json({
          error: "If-Match is required for a media lifecycle change",
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

      const user = await requirePrincipalFn(req);
      if (!hasCapability(user.principal, "media.manage")) {
        throw new MediaLifecycleRejection(404, NOT_FOUND_MESSAGE);
      }

      if (action === "tombstone") {
        const result = await firestore.runTransaction(async (transaction) => {
          const assetRef = firestore.collection("media_assets").doc(assetId);
          const [deploymentSnapshot, assetSnapshot, replacementSnapshot] =
            await Promise.all([
            transaction.get(deploymentRef(firestore)),
            transaction.get(assetRef),
            transaction.get(mediaReplacementRef(firestore, assetId)),
          ]);
          const deployment = deploymentSnapshot.exists ? deploymentSnapshot.data() : null;
          const selector = deployment?.schemaVersion === 2 ? parseStoredPublicReleaseSelector(deployment) : null;
          const receipt = selector ? { generation: selector.activeGeneration,
            deploymentId: selector.activeDeploymentId, commitSha: selector.activeCommitSha }
            : assertMediaLifecycleDeploymentFence(deployment);
          if (!assetSnapshot.exists) {
            throw new MediaLifecycleRejection(404, NOT_FOUND_MESSAGE);
          }
          const stored = assetSnapshot.data();
          assertStoredAsset(stored, assetId, user.principal, baseVersion);
          if (replacementSnapshot.exists) {
            throw new MediaLifecycleRejection(
              409,
              "A file replacement is in progress. Try again after it finishes.",
            );
          }
          if (stored.lifecycle === "tombstoned") {
            return lifecycleResult(assetId, stored.lifecycle, stored.version, false);
          }

          // Tombstoning withdraws metadata; it never deletes the old immutable
          // keys. The sweep retains them whenever this proof is incomplete.
          const pairHold = selector ? await readRetainedPairMediaHoldInTransaction({ firestore, transaction,
            root: deployment, assetId }) : null;

          const [working, published, deployed] = await Promise.all([
            transaction.get(usageQuery(firestore, "working", assetId)),
            transaction.get(usageQuery(firestore, "published", assetId)),
            transaction.get(usageQuery(
              firestore,
              "deployed",
              assetId,
              receipt.generation,
            )),
          ]);
          if (!working.empty || !published.empty || !deployed.empty) {
            throw new MediaLifecycleRejection(
              409,
              "This media asset is still used by content.",
            );
          }

          const timestamp = now();
          const updatedRecord = { ...stored };
          delete updatedRecord.reactivatedAt;
          delete updatedRecord.reactivatedBy;
          Object.assign(updatedRecord, {
            id: assetId,
            lifecycle: "tombstoned",
            version: stored.version + 1,
            updatedAt: timestamp,
            updatedBy: user.uid,
            tombstonedAt: timestamp,
            tombstonedBy: user.uid,
          });
          const updated = withMediaDiscovery(assetId, updatedRecord);
          const admission = await prepareMediaAdmissionRelease(transaction, firestore);
          const writeReleaseChange = await preparePublicMediaChangeInTransaction({ firestore, transaction,
            id: assetId, version: updated.version, before: mediaProjection(stored), after: null });
          writeReleaseChange();
          transaction.set(assetRef, updated);
          bumpMediaDiscoveryRevision(transaction, firestore, { withdrawal: true, ...admission });
          transaction.delete(
            firestore.collection("media_assets_public").doc(assetId),
          );
          transaction.set(
            firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
            auditEntry({
              adminLogEntryFn,
              user,
              action,
              assetId,
              before: { lifecycle: stored.lifecycle, version: stored.version },
              after: {
                lifecycle: updated.lifecycle,
                version: updated.version,
                deploymentId: receipt.deploymentId,
                generation: receipt.generation,
                ...(pairHold ? { retainedReleaseBytes: pairHold } : {}),
              },
              req,
            }),
          );
          return lifecycleResult(assetId, updated.lifecycle, updated.version, true);
        });
        res.set("ETag", result.asset.etag);
        res.status(200).json(result);
        return;
      }

      const assetRef = firestore.collection("media_assets").doc(assetId);
      const initialDeploymentRef = deploymentRef(firestore);
      const [deploymentSnapshot, assetSnapshot, initialQueue] = await Promise.all([
        restoreOnly ? Promise.resolve(null) : initialDeploymentRef.get(),
        assetRef.get(),
        mediaPurgeRef(firestore, assetId).get(),
      ]);
      if (!restoreOnly) assertMediaLifecycleDeploymentFence(
        deploymentSnapshot.exists ? deploymentSnapshot.data() : null,
      );
      if (!assetSnapshot.exists) {
        throw new MediaLifecycleRejection(404, NOT_FOUND_MESSAGE);
      }
      const stored = assetSnapshot.data();
      assertStoredAsset(stored, assetId, user.principal, baseVersion);
      if (restoreOnly || stored.kind === "image") assertRestorableImage(stored, initialQueue);
      if (stored.lifecycle === "active") {
        const result = lifecycleResult(assetId, stored.lifecycle, stored.version, false);
        res.set("ETag", result.asset.etag);
        res.status(200).json(result);
        return;
      }

      if (
        typeof stored.contentHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(stored.contentHash)
      ) {
        throw new MediaLifecycleRejection(
          409,
          "The stored media object cannot be verified.",
        );
      }
      const initialOwnerRef = ownerRef(firestore, stored.contentHash);
      const ownerSnapshot = await initialOwnerRef.get();
      const owner = ownerSnapshot.exists ? ownerSnapshot.data() : null;
      const attemptId = assertCommittedOwner(owner, stored, assetId);
      const expectedObject = expectedStoredObject(stored, assetId, attemptId);
      const storage = await storageFactory();
      let object;
      try {
        object = await storage.head(stored.storageKey);
      } catch {
        throw new MediaLifecycleRejection(
          409,
          "The stored media object cannot be verified.",
        );
      }
      if (!storedObjectMatches(object, expectedObject)) {
        throw new MediaLifecycleRejection(
          409,
          "The stored media object cannot be verified.",
        );
      }

      const result = await firestore.runTransaction(async (transaction) => {
        const currentUser = await transaction.get(firestore.collection("users").doc(user.uid));
        let currentPrincipal = await principalFromStoredUserDoc(firestore, user.uid, currentUser.exists ? currentUser.data() : null, transaction);
        if (currentPrincipal.grants.some((grant) => Array.isArray(grant.sections) && grant.sections.length > 0)) {
          currentPrincipal = withRegisteredMediaSections(currentPrincipal,
            await readRegisteredSectionIds(firestore, transaction));
        }
        if (!hasCapability(currentPrincipal, "media.manage")) {
          throw new MediaLifecycleRejection(404, NOT_FOUND_MESSAGE);
        }
        const [currentDeployment, currentAsset, currentOwner, currentQueue] = await Promise.all([
          restoreOnly ? Promise.resolve(null) : transaction.get(initialDeploymentRef),
          transaction.get(assetRef),
          transaction.get(initialOwnerRef),
          transaction.get(mediaPurgeRef(firestore, assetId)),
        ]);
        const receipt = restoreOnly ? null : assertMediaLifecycleDeploymentFence(
          currentDeployment.exists ? currentDeployment.data() : null,
        );
        if (!currentAsset.exists) {
          throw new MediaLifecycleRejection(404, NOT_FOUND_MESSAGE);
        }
        const current = currentAsset.data();
        assertStoredAsset(current, assetId, currentPrincipal, baseVersion);
        if (restoreOnly || current.kind === "image") assertRestorableImage(current, currentQueue);
        if (restoreOnly) {
          try {
            await requireManagedMediaCategories(transaction, firestore,
              [...new Set([current.category,
                ...normalizeMediaCategoryAssignments(current.categories, current.category)])]);
          } catch (error) {
            if (!Number.isInteger(error.status)) throw error;
            throw new MediaLifecycleRejection(409,
              "Restore the image's primary and assigned categories before restoring this image.");
          }
        }
        if (current.lifecycle !== "tombstoned") {
          throw new MediaLifecycleRejection(
            409,
            "This media asset is no longer tombstoned.",
          );
        }
        const currentAttemptId = assertCommittedOwner(
          currentOwner.exists ? currentOwner.data() : null,
          current,
          assetId,
        );
        if (currentAttemptId !== attemptId) {
          throw new MediaLifecycleRejection(
            409,
            "The stored media object cannot be verified.",
          );
        }
        const currentExpected = expectedStoredObject(current, assetId, attemptId);
        if (
          current.storageKey !== stored.storageKey ||
          !sameExpectedStoredObject(currentExpected, expectedObject)
        ) {
          throw new MediaLifecycleRejection(
            409,
            "The stored media object cannot be verified.",
          );
        }

        const rest = { ...current };
        delete rest.tombstonedAt;
        delete rest.tombstonedBy;
        delete rest.purgeAfter;
        const timestamp = now();
        const updatedRecord = {
          ...rest,
          id: assetId,
          lifecycle: "active",
          version: current.version + 1,
          updatedAt: timestamp,
          updatedBy: user.uid,
          reactivatedAt: timestamp,
          reactivatedBy: user.uid,
        };
        if (!mediaAssetSummary(assetId, updatedRecord)) {
          throw new MediaLifecycleRejection(
            409,
            "This media asset record is invalid.",
          );
        }
        let updated;
        try {
          updated = withMediaDiscovery(assetId, updatedRecord);
        } catch {
          throw new MediaLifecycleRejection(
            409,
            "This media asset record is invalid.",
          );
        }
        let admission;
        try {
          admission = await readMediaAdmission(transaction, firestore);
        } catch (error) {
          if (error.code === "media-admission-overflow") {
            throw new MediaLifecycleRejection(409, "The active media library is full.");
          }
          throw error;
        }
        if (admission.activeCount >= admission.limit) {
          // Commit the exact count before refusing, so a later attempt is warm.
          writeMediaAdmission(transaction, firestore, admission.activeCount, admission.revision);
          return new MediaLifecycleRejection(409, "The active media library is full.");
        }
        const writeReleaseChange = await preparePublicMediaChangeInTransaction({ firestore, transaction,
          id: assetId, version: updated.version, before: null, after: mediaProjection(updated), mediaSource: updated });
        writeReleaseChange();
        transaction.set(assetRef, updated);
        bumpMediaDiscoveryRevision(transaction, firestore, {
          admissionCount: admission.activeCount + 1, admissionRevision: admission.revision + 1,
        });
        if (currentQueue.exists) {
          transaction.update(mediaPurgeRef(firestore, assetId), {
            state: "cancelled", cancelledAt: timestamp, cancelledBy: user.uid,
          });
        }
        transaction.set(
          firestore.collection("media_assets_public").doc(assetId),
          mediaProjection(updated),
        );
        transaction.set(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          auditEntry({
            adminLogEntryFn,
            user,
            action: restoreOnly ? "restore" : action,
            assetId,
            before: { lifecycle: current.lifecycle, version: current.version },
            after: {
              lifecycle: updated.lifecycle,
              version: updated.version,
              ...(receipt ? { deploymentId: receipt.deploymentId, generation: receipt.generation } :
                { purgeEntryId: `asset:${assetId}` }),
            },
            req,
          }),
        );
        return lifecycleResult(assetId, updated.lifecycle, updated.version, true);
      });

      if (result instanceof MediaLifecycleRejection) throw result;
      res.set("ETag", result.asset.etag);
      res.status(200).json(result);
    } catch (error) {
      if (res.headersSent) return;
      const status = error?.status ||
        (error?.code === "failed-precondition" || error?.code === 9 ? 503 : 500);
      const expected = Number.isInteger(error?.status) && status >= 400 && status < 500;
      if (error?.details?.etag) res.set("ETag", error.details.etag);
      const errorId = expected ? null : randomUUID();
      if (errorId) {
        log.error("cmsSetMediaLifecycle failed", {
          errorId, status: Number.isInteger(status) ? status : null, ...lifecycleErrorDiagnostic(error),
        });
      }
      res.status(status).json({
        error: expected
          ? error.message
          : curatedLifecycleFailureMessage(error, status) ?? "Failed to change media lifecycle",
        ...(errorId ? { errorId } : {}),
      });
    }
  };
}

const cmsSetMediaLifecycle = cmsOnRequest(
  {
    cors: MEDIA_ALLOWED_ORIGINS,
    maxInstances: 10,
    timeoutSeconds: 30,
    secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY],
  },
  createCmsSetMediaLifecycleHandler(),
);

function assertRestorableImage(stored, queue) {
  if (stored.kind !== "image") {
    throw new MediaLifecycleRejection(404, NOT_FOUND_MESSAGE);
  }
  if (["purging", "purged"].includes(stored.lifecycle) ||
      ["purging", "purged"].includes(queue.exists ? queue.data().state : null)) {
    throw new MediaLifecycleRejection(409, "This image is being removed or has already been removed.");
  }
}

function createCmsRestoreMediaHandler(deps = {}) {
  return createCmsSetMediaLifecycleHandler({ ...deps, restoreOnly: true });
}

const cmsRestoreMedia = cmsOnRequest(
  { cors: MEDIA_ALLOWED_ORIGINS, maxInstances: 10, timeoutSeconds: 30,
    secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY] },
  createCmsRestoreMediaHandler(),
);

module.exports = {
  JSON_LIMIT_BYTES,
  LIFECYCLE_ACTIONS,
  MediaLifecycleRejection,
  NOT_FOUND_MESSAGE,
  cmsSetMediaLifecycle,
  cmsRestoreMedia,
  createCmsRestoreMediaHandler,
  createCmsSetMediaLifecycleHandler,
  createDefaultStorage,
  sameExpectedStoredObject,
  validateMediaLifecycleRequest,
};
