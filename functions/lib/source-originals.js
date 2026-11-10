"use strict";

const { createHash } = require("node:crypto");
const { S3Client, RestoreObjectCommand } = require("@aws-sdk/client-s3");
const { FieldValue } = require("firebase-admin/firestore");
const { createAwsRoleCredentialProvider } = require("./aws-workload-credentials");
const { originalTarget, objectRequest, verifyTarget } = require("./s3-media-source");
const { ORIGINAL_BUCKETS, stateFromHead, originalAvailability, mapOriginalStorageError, safeStorageDiagnostic } = require("./source-original-state");
const { parseSourceMediaAsset } = require("./source-media-contract");
const { objectKeyWithinSource } = require("./media-sources");
const { can } = require("./rbac");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./audit");
const { assertBillingEnabled } = require("./billing-state");

const { originalStatusRef, readOriginalStatuses } = require("./source-original-status");

const RESTORES = "mediaSourceOriginalRestores";
const CACHE_MS = 15 * 60 * 1000;
const CHECK_MS = 15 * 60 * 1000;
// Staff text in Boardwalk and the staff guide says "at least 7 days". Change them together.
const DEEP_ARCHIVE_RESTORE_DAYS = 7;
const MAX_WAIT_MS = 72 * 60 * 60 * 1000;
const problem = (status, message) => Object.assign(new Error(message), { status });

function sameOriginal(left, right) {
  return left?.lifecycle === "active" && left.sourceId === right.sourceId &&
    left.objectKey === right.objectKey && left.objectVersionId === right.objectVersionId &&
    left.sizeBytes === right.sizeBytes;
}

function boundState(asset, original) {
  return { ...original, sourceId: asset.sourceId, objectKey: asset.objectKey, objectVersionId: asset.objectVersionId, sizeBytes: asset.sizeBytes };
}

function restoreId(asset) {
  return createHash("sha256").update(JSON.stringify([asset.sourceId, asset.id, asset.objectKey,
    asset.objectVersionId, asset.sizeBytes])).digest("hex");
}

function noticesFor(firestore, uid) {
  return firestore.collection("mediaSourceOriginalNotices").doc(uid).collection("items");
}

// Intelligent-Tiering Standard retrieval is free. A DEEP_ARCHIVE retrieval and its copy are charged.
async function assertRestoreBillable(firestore, storageClass) {
  if (storageClass !== "DEEP_ARCHIVE") return;
  try { await assertBillingEnabled(firestore); }
  catch (error) {
    if (error?.code !== "failed-precondition") throw error;
    throw problem(409, "Restore is paused while billing is stopped. Ask a CMS administrator.");
  }
}

function createOriginalStorage(config, deps = {}) {
  const clients = new Map();
  function clientFor(source) {
    if (!clients.has(source.roleArn)) {
      clients.set(source.roleArn, deps.client ?? new S3Client({ region: config.region, maxAttempts: 2,
        credentials: createAwsRoleCredentialProvider({ roleArn: source.roleArn, audience: config.audience, region: config.region }) }));
    }
    return clients.get(source.roleArn);
  }
  return {
    async head(source, asset, { timeoutMs = 2500 } = {}) {
      return verifyTarget(clientFor(source), originalTarget(source, asset), { abortSignal: AbortSignal.timeout(timeoutMs) });
    },
    async restore(source, asset, storageClass) {
      // Intelligent-Tiering moves the exact version back to Frequent Access. Days is invalid here.
      // A DEEP_ARCHIVE version stays in that class. S3 makes a copy that it removes after Days.
      const RestoreRequest = storageClass === "DEEP_ARCHIVE"
        ? { Days: DEEP_ARCHIVE_RESTORE_DAYS, GlacierJobParameters: { Tier: "Standard" } } : { Tier: "Standard" };
      try {
        await clientFor(source).send(new RestoreObjectCommand({ ...objectRequest(originalTarget(source, asset)), RestoreRequest }),
          { abortSignal: AbortSignal.timeout(5000) });
      } catch (error) {
        if (error?.name !== "RestoreAlreadyInProgress") throw mapOriginalStorageError(error);
      }
    },
  };
}

async function saveOriginalState(firestore, asset, original) {
  const ref = firestore.collection("mediaSourceAssets").doc(asset.id);
  return firestore.runTransaction(async tx => {
    const statusRef = originalStatusRef(firestore, asset.id);
    const [snapshot, status] = await Promise.all([tx.get(ref), tx.get(statusRef)]);
    const current = snapshot.data();
    if (!sameOriginal(current, asset)) throw problem(409, "The original changed. Reopen the video and try again.");
    const previous = originalAvailability(status.data(), current);
    if (previous && Date.parse(previous.checkedAt) > Date.parse(original.checkedAt)) return previous;
    tx.set(statusRef, boundState(asset, original));
    return original;
  });
}

async function refreshOriginal({ firestore, storage, source, asset, now = Date.now(), fresh = false, cached }) {
  const previous = cached === undefined
    ? originalAvailability((await originalStatusRef(firestore, asset.id).get()).data(), asset) : cached;
  if (!fresh && previous && now - Date.parse(previous.checkedAt) < CACHE_MS) return previous;
  const head = await storage.head(source, asset);
  let original = stateFromHead(head, previous, now);
  if (original.state === "archived" && previous?.state === "restoring") {
    const pending = (await firestore.collection(RESTORES).doc(restoreId(asset)).get()).data();
    if (pending?.active) original = { ...original, state: "restoring" };
  }
  return saveOriginalState(firestore, asset, original);
}

async function refreshListedOriginals({ firestore, storage, source, assets, records, log }) {
  if (!ORIGINAL_BUCKETS.has(source.bucket)) return records;
  const originals = await readOriginalStatuses(firestore, assets);
  const deadline = Date.now() + 1500;
  const boundedStorage = { ...storage, head: (itemSource, asset) => storage.head(itemSource, asset,
    { timeoutMs: Math.max(1, deadline - Date.now()) }) };
  let next = 0;
  async function worker() {
    while (next < assets.length && Date.now() < deadline) {
      const asset = assets[next++];
      try { originals.set(asset.id, await refreshOriginal({ firestore, storage: boundedStorage, source, asset, cached: originals.get(asset.id) })); }
      catch (error) { log.warn("Original status check failed", { assetId: asset.id, ...safeStorageDiagnostic(error) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, assets.length) }, worker));
  return records.map(record => ({ ...record, ...(originals.get(record.id) ? { original: originals.get(record.id) } : {}) }));
}

async function requestOriginalRestore({ firestore, storage, source, asset, actor, now = Date.now() }) {
  if (!ORIGINAL_BUCKETS.has(source.bucket)) throw problem(409, "This source does not support original restoration.");
  const head = await storage.head(source, asset);
  const previous = originalAvailability((await originalStatusRef(firestore, asset.id).get()).data(), asset);
  const original = stateFromHead(head, previous, now);
  if (["available", "restored"].includes(original.state)) return saveOriginalState(firestore, asset, original);
  if (!["INTELLIGENT_TIERING", "DEEP_ARCHIVE"].includes(head.StorageClass)) throw problem(409, "Ask a CMS administrator to restore this storage class.");
  // A DEEP_ARCHIVE restore can cost real money per request, so it needs video management.
  // HeadObject is the only source of the class, and a Viewer status check already runs it.
  const paid = head.StorageClass === "DEEP_ARCHIVE";
  if (paid && !can(actor?.principal, "media.video.manage", {})) throw problem(403, "Ask a person who manages video to restore this original.");
  await assertRestoreBillable(firestore, head.StorageClass);
  const approval = paid ? { deepArchiveApprovedBy: actor.uid } : {};
  const id = restoreId(asset);
  const ref = firestore.collection(RESTORES).doc(id);
  const assetRef = firestore.collection("mediaSourceAssets").doc(asset.id);
  const start = await firestore.runTransaction(async tx => {
    const [current, existing] = await Promise.all([tx.get(assetRef), tx.get(ref)]);
    if (!sameOriginal(current.data(), asset)) throw problem(409, "The original changed. Reopen the video and try again.");
    const job = existing.data();
    const requesters = [...new Set([...(job?.active ? job.requesters : []), actor.uid])];
    if (requesters.length > 30) throw problem(429, "This restore has enough requests. Check its status later.");
    if (job?.active) {
      if (job.bucket !== source.bucket || job.expectedBucketOwner !== source.expectedBucketOwner) {
        throw problem(409, "The source storage changed. Ask a CMS administrator to check this restore.");
      }
      tx.update(ref, { requesters, ...approval });
      return false;
    }
    tx.set(ref, { id, assetId: asset.id, sourceId: asset.sourceId, objectKey: asset.objectKey,
      objectVersionId: asset.objectVersionId, sizeBytes: asset.sizeBytes, name: asset.name,
      bucket: source.bucket, expectedBucketOwner: source.expectedBucketOwner,
      active: true, phase: "requesting", requesters, requestedAt: now, nextCheckAt: now + 60_000, ...approval });
    tx.set(originalStatusRef(firestore, asset.id), boundState(asset, { ...original, state: "restoring" }));
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: actor.uid,
      actorEmail: actor.email ?? null, action: "media.original.restore", target: `mediaSourceAssets/${asset.id}`,
      after: { sourceId: source.id, restoreId: id, retrievalTier: "Standard" } }));
    return true;
  });
  // A durable request survives an interrupted/lost S3 response. The bounded checker reconciles it.
  if (start && original.state !== "restoring") await storage.restore(source, asset, head.StorageClass);
  return { ...original, state: "restoring" };
}

async function finishRestore(firestore, ref, job, original, outcome, { unlessApproved = false } = {}) {
  return firestore.runTransaction(async tx => {
    const [current, snapshot] = await Promise.all([tx.get(ref), tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId))]);
    if (!current.data()?.active || current.data().requestedAt !== job.requestedAt) return;
    if (unlessApproved && current.data().deepArchiveApprovedBy) return;
    const asset = snapshot.data();
    const resumePreview = outcome === "restored" && sameOriginal(asset, job) && asset.rendition?.errorCode === "original_archived";
    let pending;
    if (resumePreview) {
      const { pendingPreview, PREVIEW_JOBS } = require("./video-preview-job");
      pending = pendingPreview({ ...asset, id: job.assetId });
      const currentPreview = (await tx.get(firestore.collection(PREVIEW_JOBS).doc(pending.id))).data();
      if (currentPreview?.active) pending = null;
    }
    const matches = sameOriginal(asset, job);
    tx.update(ref, { active: false, phase: matches ? outcome : "stale", nextCheckAt: FieldValue.delete() });
    if (matches && original) tx.set(originalStatusRef(firestore, job.assetId), boundState(job, original));
    if (pending) {
      const { PREVIEW_JOBS, renditionState } = require("./video-preview-job");
      tx.set(firestore.collection(PREVIEW_JOBS).doc(pending.id), pending);
      tx.update(snapshot.ref, { rendition: renditionState(pending, "processing") });
    }
    for (const uid of current.data().requesters) {
      tx.set(noticesFor(firestore, uid).doc(job.id), { id: job.id, sourceId: job.sourceId,
        assetId: job.assetId, name: job.name, outcome: matches ? outcome : "stale", completedAt: new Date().toISOString() });
    }
  });
}

async function processOriginalRestores({ firestore, storage, registry, now = Date.now(), log }) {
  // One indexed, bounded due-work query; completed jobs leave the index.
  const due = await firestore.collection(RESTORES).where("nextCheckAt", "<=", now).orderBy("nextCheckAt").limit(10).get();
  for (const snapshot of due.docs) {
    const job = await firestore.runTransaction(async tx => {
      const current = (await tx.get(snapshot.ref)).data();
      if (!current?.active || current.nextCheckAt > now) return null;
      tx.update(snapshot.ref, { nextCheckAt: now + CHECK_MS });
      return current;
    });
    if (!job) continue;
    try {
      const source = registry.get(job.sourceId);
      const assetSnapshot = await firestore.collection("mediaSourceAssets").doc(job.assetId).get();
      const asset = assetSnapshot.exists ? parseSourceMediaAsset(assetSnapshot.id, assetSnapshot.data()) : null;
      if (!asset || !sameOriginal({ ...asset, lifecycle: "active" }, job)) {
        await finishRestore(firestore, snapshot.ref, job, null, "stale");
        continue;
      }
      if (now - job.requestedAt > MAX_WAIT_MS) {
        await finishRestore(firestore, snapshot.ref, job, null, "failed");
        continue;
      }
      if (!source || !ORIGINAL_BUCKETS.has(source.bucket) || source.bucket !== job.bucket ||
          source.expectedBucketOwner !== job.expectedBucketOwner || !objectKeyWithinSource(source, asset.objectKey)) continue;
      const head = await storage.head(source, asset);
      const original = stateFromHead(head, { state: "restoring" }, now);
      if (["available", "restored"].includes(original.state)) {
        await finishRestore(firestore, snapshot.ref, job, { ...original, state: "restored" }, "restored");
      } else if (job.phase === "requesting") {
        if (original.state === "archived") {
          // The class can change after a free request. That request never starts a paid restore.
          if (head.StorageClass === "DEEP_ARCHIVE" && !job.deepArchiveApprovedBy) {
            // A manager can approve during this check. The next check then starts the restore.
            await finishRestore(firestore, snapshot.ref, job, original, "failed", { unlessApproved: true });
            continue;
          }
          // A stopped request stays in the requesting phase and retries on a later check.
          await assertRestoreBillable(firestore, head.StorageClass);
          await storage.restore(source, asset, head.StorageClass);
        }
        await snapshot.ref.update({ phase: "restoring" });
      }
    } catch (error) {
      log.warn("Original restore check failed", { restoreId: job.id, ...safeStorageDiagnostic(error) });
    }
  }
  return due.size;
}

module.exports = { RESTORES, CACHE_MS, CHECK_MS, sameOriginal, restoreId, noticesFor, createOriginalStorage,
  refreshOriginal, refreshListedOriginals, requestOriginalRestore, processOriginalRestores, finishRestore };
