"use strict";

const { enqueueVideoSearchShard } = require("./video-search-outbox");

const { randomUUID } = require("node:crypto");
const { sourceMediaRenditionId } = require("./source-media-rendition");

const PREVIEW_JOBS = "mediaSourcePreviewJobs";
const LEASE_MS = 5 * 60 * 1000;

const previewIdentity = sourceMediaRenditionId;

function sameOriginal(asset, job) {
  return asset?.lifecycle === "active" && asset.sourceId === job.sourceId &&
    asset.objectKey === job.sourceObjectKey &&
    asset.objectVersionId === job.sourceObjectVersionId && asset.sizeBytes === job.sourceSizeBytes;
}

function renditionState(job, state, extra = {}) {
  return {
    schemaVersion: 1, state, sourceObjectKey: job.sourceObjectKey,
    sourceObjectVersionId: job.sourceObjectVersionId, sourceSizeBytes: job.sourceSizeBytes,
    attemptId: job.attemptId, updatedAt: new Date().toISOString(), ...extra,
  };
}

function pendingPreview(asset, now = Date.now()) {
  return {
    id: previewIdentity(asset), assetId: asset.id, sourceId: asset.sourceId,
    sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, attemptId: randomUUID(), phase: "pending", active: true,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), leaseUntil: 0,
  };
}

async function claimPreview(db, ref, now = Date.now()) {
  const owner = randomUUID();
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const job = snapshot.data();
    if (!job?.active || job.phase === "reserved" || job.leaseUntil > now) return null;
    const asset = job.replacementSessionId
      ? await require("./source-video-replacement").previewReplacementTarget(tx, db, job)
      : (await tx.get(db.collection("mediaSourceAssets").doc(job.assetId))).data();
    if (!sameOriginal(asset, job) && job.phase !== "running") {
      // A lost start response may have left a remote writer behind. Never turn
      // that unknown attempt into a stale job merely because its file changed.
      const uncertain = job.executionArn || job.failures > 0 || job.phase === "starting";
      tx.update(ref, { active: false, phase: uncertain ? "needs_reconciliation" : "stale", leaseUntil: 0 });
      return null;
    }
    tx.update(ref, { leaseOwner: owner, leaseUntil: now + LEASE_MS });
    return { ...job, leaseOwner: owner };
  });
}

async function savePreview(db, ref, job, changes, rendition) {
  return db.runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data();
    if (!current?.active || current.leaseOwner !== job.leaseOwner ||
        current.attemptId !== job.attemptId) return false;
    const assetRef = db.collection("mediaSourceAssets").doc(job.assetId);
    const asset = job.replacementSessionId
      ? await require("./source-video-replacement").previewReplacementTarget(tx, db, job, rendition, changes)
      : (await tx.get(assetRef)).data();
    if (!sameOriginal(asset, job)) {
      const terminal = ["ready", "failed"].includes(rendition?.state);
      // Ordinary originals can still be converting after a replacement is
      // promoted. Keep polling their exact execution, without publishing its
      // rendition onto the new file, until the provider settles.
      if ((job.phase === "running" || changes.phase === "running") &&
          changes.phase !== "needs_reconciliation" && !terminal) {
        tx.update(ref, { ...changes, updatedAt: new Date().toISOString() });
        return true;
      }
      // A failed status/start read is not proof that remote writes stopped.
      // This applies to the original as well as an isolated candidate.
      const uncertain = changes.phase === "needs_reconciliation" ||
        !terminal && (job.phase === "pending" || job.executionArn || current.executionArn);
      tx.update(ref, { ...changes, phase: uncertain ? "needs_reconciliation" : "stale", active: false, leaseUntil: 0 });
      return false;
    }
    tx.update(ref, { ...changes, updatedAt: new Date().toISOString() });
    // Background processing must not overwrite staff metadata or its edit version.
    if (rendition && !asset.replacementUnavailable) {
      if (job.replacementSessionId) require("./source-video-replacement").saveReplacementPreview(tx, db, job, rendition, asset);
      else {
        tx.update(assetRef, { rendition });
        enqueueVideoSearchShard(tx, db, job.assetId, job.sourceId);
      }
    }
    return true;
  });
}

module.exports = { PREVIEW_JOBS, LEASE_MS, previewIdentity, sameOriginal, renditionState,
  pendingPreview, claimPreview, savePreview };
