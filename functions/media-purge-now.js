"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { hasGlobalCapability } = require("./lib/rbac");
const { principalFromStoredUserDoc } = require("./lib/principal");
const { JsonRequestError, requestHeader, validateBoundedJsonRequest } = require("./lib/http-json");
const { isMediaAssetId, parseMediaIfMatch } = require("./lib/media-library");
const { MEDIA_PURGE_CONTROL_PATH, createImagePurgeEntry, isImmediatePurgeDelegate, mediaPurgeRef } = require("./lib/media-bin");
const { claimEntry, executeClaim } = require("./lib/media-purge-executor");
const { createMediaCacheRetirement } = require("./lib/media-purge-cache");
const { REAL_DELETES_ENABLED, PURGE_SERVICE_ACCOUNT, PURGE_WRITE_SECRETS, defaultStorage,
  inspectEntry, readConfig } = require("./media-purge-sweep");

const DENIED = "You do not have permission to permanently delete images.";
const UNAVAILABLE = "Permanent image deletion is unavailable. Try again later.";
const IN_USE = "This image may still be in use. It cannot be permanently deleted.";

class PurgeRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assertConfirmedImage({ asset, entry, assetId, version, cache }) {
  if (asset.lifecycle !== "tombstoned" || entry.state !== "pending" || entry.reason !== "deleted") {
    throw new PurgeRequestError(409, "This image is no longer available for permanent deletion.");
  }
  if (asset.version !== version) throw new PurgeRequestError(412, "This image changed. Refresh the bin and confirm again.");
  let expected;
  try {
    expected = createImagePurgeEntry(assetId, asset, entry.queuedAt);
    if (asset.url !== cache.url(asset.storageKey) ||
        (asset.thumbnails ?? []).some(item => item.url !== cache.url(item.storageKey))) throw new Error();
  } catch {
    throw new PurgeRequestError(409, "The stored image files could not be verified.");
  }
  if (!isDeepStrictEqual(entry.objects, expected.objects) || entry.masterKey !== expected.masterKey) {
    throw new PurgeRequestError(409, "The stored image files could not be verified.");
  }
}

function createCmsPurgeBinnedImageHandler({ firestore = db, requirePrincipalFn = requirePrincipal,
  realDeletesEnabled = REAL_DELETES_ENABLED, storageFactory = defaultStorage,
  cacheFactory = createMediaCacheRetirement, clock = Date.now, log = logger } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 4096);
      const actor = await requirePrincipalFn(req, { cacheRevocation: false });
      const configRef = firestore.doc(MEDIA_PURGE_CONTROL_PATH);
      if (!hasGlobalCapability(actor.principal, "users.manage")) throw new PurgeRequestError(403, DENIED);
      const control = (await configRef.get()).data();
      if (!isImmediatePurgeDelegate(actor, control)) throw new PurgeRequestError(403, DENIED);

      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
          !isMediaAssetId(body.assetId) || body.confirmAssetId !== body.assetId) {
        throw new PurgeRequestError(400, "Confirm the exact image to delete permanently.");
      }
      const { assetId } = body;
      const etag = requestHeader(req, "if-match");
      if (etag === undefined) throw new PurgeRequestError(428, "If-Match is required for permanent deletion.");
      const version = parseMediaIfMatch(etag, assetId);
      if (version === null) throw new PurgeRequestError(400, "If-Match must be one strong ETag for this image.");
      const config = readConfig(control);
      if (!realDeletesEnabled || !config.enabled || config.dryRun) throw new PurgeRequestError(503, UNAVAILABLE);

      const storage = storageFactory();
      const cache = cacheFactory();
      const entryRef = mediaPurgeRef(firestore, assetId);
      const nowMs = clock();
      const runId = randomUUID();
      const checked = await inspectEntry({ firestore, entryRef, nowMs, config,
        confirm: async ({ transaction, asset, entry }) => {
          const [currentControl, currentUser] = await Promise.all([
            transaction.get(configRef), transaction.get(firestore.collection("users").doc(actor.uid)),
          ]);
          const principal = await principalFromStoredUserDoc(firestore, actor.uid, currentUser.data(), transaction);
          if (!isImmediatePurgeDelegate({ uid: actor.uid, principal }, currentControl.data())) {
            throw new PurgeRequestError(403, DENIED);
          }
          assertConfirmedImage({ asset, entry, assetId, version, cache });
        },
        prepare: async (context) => {
          const result = await claimEntry({ ...context, runId, clock, configRef, readConfig,
            runDeadlineMs: nowMs + 90_000, immediate: { actorUid: actor.uid } });
          if (result.claim) context.transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
            adminLogEntry({ actorUid: actor.uid, action: "media.purge.request", target: `media_assets/${assetId}`,
              before: { version, lifecycle: "tombstoned" }, after: { runId, lifecycle: "purging", cacheRetirement: "pending" } }));
          return result;
        },
      });
      if (!checked.claim) {
        if (checked.deferred === "disabled_or_lease_lost" || checked.deferred === "run_budget") throw new PurgeRequestError(503, UNAVAILABLE);
        if (checked.skips.some(({ reason }) => reason.endsWith("_usage") || reason.startsWith("pair-") ||
          ["capture-gap", "public_build_in_progress", "public_key_referenced", "public_projection_present", "public_release_unproven"].includes(reason))) {
          throw new PurgeRequestError(409, IN_USE);
        }
        throw new PurgeRequestError(409, "This image is unavailable for permanent deletion. Refresh the bin and try again.");
      }
      const result = await executeClaim({ firestore, entryRef, claim: checked.claim, configRef, runId,
        storage, clock, readConfig, retirePublicCopies: cache.retire });
      return res.status(result.outcome === "purged" ? 200 : 202).json({ success: true, outcome: result.outcome });
    } catch (error) {
      if (error instanceof PurgeRequestError || error instanceof JsonRequestError || error.status === 401 || error.status === 403) {
        return res.status(error.status).json({ error: error.message });
      }
      // Storage and cache provider exceptions can contain credentials.
      log.error("Immediate media purge unavailable");
      return res.status(503).json({ error: UNAVAILABLE });
    }
  };
}

const cmsPurgeBinnedImage = cmsOnRequest({ cors: true, maxInstances: 2, timeoutSeconds: 120,
  serviceAccount: REAL_DELETES_ENABLED ? PURGE_SERVICE_ACCOUNT : undefined,
  secrets: REAL_DELETES_ENABLED ? PURGE_WRITE_SECRETS : [] }, createCmsPurgeBinnedImageHandler());

module.exports = { cmsPurgeBinnedImage, createCmsPurgeBinnedImageHandler };
