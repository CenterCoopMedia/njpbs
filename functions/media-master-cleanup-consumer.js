"use strict";

// Deliberately absent from index.js, function manifests, and all schedules.
// Calling without enabled:true touches neither Firestore nor storage.
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const logger = require("firebase-functions/logger");
const { FieldPath } = require("firebase-admin/firestore");
const { masterObjectKey } = require("./lib/r2-media-masters");
const { assertMutableOwner } = require("./media-recovery");
const { cleanupUploadMaster, cleanupIntent, masterHasReferences, DELETE_LEASE_MS,
  PENDING_STATES } = require("./lib/media-master-cleanup");

const MAX_ATTEMPTS = 5;
const MAX_PAGE_SIZE = 50;
const RUN_BUDGET_MS = 120_000;
const SHARED_RECHECK_MS = 24 * 60 * 60_000;
const MANUAL_ERRORS = new Set(["fence_conflict", "intent_changed", "invalid_master_key",
  "receipt_changed", "receipt_referenced", "delete_ownership_changed", "invalid_clock"]);
const CONTROL_PATH = "system/mediaMasterCleanup";
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CLAIM_PATTERN = /^system\/media\/hashOwners\/[a-f0-9]{64}$/;

function validTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function validIntent(id, entry) {
  if (!entry || entry.state !== "pending" || !ID_PATTERN.test(id) || entry.attemptId !== id ||
      !CLAIM_PATTERN.test(entry.claimPath) || !validTime(entry.leaseExpiresAt) ||
      !validTime(entry.queuedAt) || !validTime(entry.eligibleAt) ||
      (entry.nextAttemptAt !== undefined && !validTime(entry.nextAttemptAt)) ||
      (entry.manualReview !== undefined && typeof entry.manualReview !== "boolean") ||
      (entry.attempts !== undefined && (!Number.isSafeInteger(entry.attempts) || entry.attempts < 0))) return false;
  try {
    const mimeType = entry.key?.endsWith(".jpg") ? "image/jpeg" : "image/png";
    return entry.key === masterObjectKey({ contentHash: entry.contentHash, mimeType });
  } catch { return false; }
}

function validOwner(ref, owner) {
  try {
    if (!CLAIM_PATTERN.test(ref.path) || owner?.operation === "replacement" ||
        !ID_PATTERN.test(owner?.attemptId)) return false;
    assertMutableOwner(ref.id, owner);
    return true;
  } catch { return false; }
}

function fenceMatches(lock, entry) {
  return lock?.state === "purging" && lock.cleanupId === entry.attemptId && lock.key === entry.key &&
    (lock.claimPath === undefined || lock.claimPath === entry.claimPath) &&
    (lock.leaseExpiresAt === undefined || lock.leaseExpiresAt === entry.leaseExpiresAt);
}

async function prepareIntent({ firestore, queueRef, nowIso }) {
  return firestore.runTransaction(async (transaction) => {
    const entry = (await transaction.get(queueRef)).data();
    if (!entry) return { status: "gone" };
    if (!validIntent(queueRef.id, entry)) return { status: "invalid_intent", alert: true };
    const ref = firestore.doc(entry.claimPath);
    const [claim, fence] = await Promise.all([
      transaction.get(ref), transaction.get(firestore.doc(`system/media/masterLocks/${entry.contentHash}`)),
    ]);
    const owner = claim.data();
    const lock = fence.data();
    if (lock && !fenceMatches(lock, entry)) return { status: "fence_conflict", alert: true };
    if (!validOwner(ref, owner)) return { status: "invalid_claim", alert: true };
    if (owner.attemptId !== entry.attemptId) return { status: "stale_attempt", alert: true };
    const master = owner.recordSeed.master;
    if (master?.key !== entry.key || master.contentHash !== entry.contentHash) {
      return { status: "stale_master", alert: true };
    }
    if (owner.state === "committed") {
      if (lock) return { status: "fenced_committed", alert: true };
      const asset = (await transaction.get(firestore.collection("media_assets").doc(owner.assetId))).data();
      if (!asset || asset.id !== owner.assetId || asset.master?.key !== entry.key ||
          asset.master?.contentHash !== entry.contentHash || asset.master?.retained !== true) {
        return { status: "committed_asset_mismatch", alert: true };
      }
      transaction.delete(queueRef);
      return { status: "retired_committed" };
    }
    if (!PENDING_STATES.has(owner.state)) return { status: "invalid_claim", alert: true };
    if (owner.leaseExpiresAt !== entry.leaseExpiresAt) {
      // Rebind only the same attempt and exact original, with no purge fence.
      // A queue timestamp alone never authorizes deleting a renewed claim.
      if (lock) return { status: "fenced_lease_changed", alert: true };
      transaction.update(queueRef, { leaseExpiresAt: owner.leaseExpiresAt,
        eligibleAt: owner.leaseExpiresAt, lastStatus: "lease_refreshed" });
      return { status: "lease_refreshed" };
    }
    const nowMs = Date.parse(nowIso);
    if (lock?.deleteToken && !validTime(lock.deleteLeaseExpiresAt)) {
      return { status: "invalid_delete_lease", alert: true };
    }
    if (lock && (lock.deleteToken ? Date.parse(lock.deleteLeaseExpiresAt) > nowMs :
      Date.parse(entry.queuedAt) + DELETE_LEASE_MS > nowMs)) return { status: "delete_busy" };
    if (Date.parse(entry.eligibleAt) > nowMs || (!lock && Date.parse(owner.leaseExpiresAt) > nowMs)) {
      return { status: "lease_active" };
    }
    if (entry.manualReview === true) return { status: "manual_review", alert: true };
    if ((entry.attempts ?? 0) >= MAX_ATTEMPTS) return { status: "retry_exhausted", alert: true };
    if (entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > nowMs) return { status: "backoff" };
    if (await masterHasReferences(transaction, firestore, ref, entry.key)) {
      if (lock) return { status: "fenced_reference", alert: true };
      transaction.update(queueRef, { nextAttemptAt: new Date(nowMs + SHARED_RECHECK_MS).toISOString(),
        lastStatus: "shared" });
      return { status: "shared" };
    }
    // Persist the attempt BEFORE any external I/O. A crashed run consumes budget.
    const attempts = (entry.attempts ?? 0) + 1;
    const expectedIntent = { ...entry, attempts, lastAttemptAt: nowIso,
      nextAttemptAt: new Date(nowMs + DELETE_LEASE_MS * 2 ** (attempts - 1)).toISOString(),
      lastStatus: "attempting" };
    transaction.set(queueRef, expectedIntent);
    return { status: "ready", ref, expectedIntent };
  });
}

async function consumeIntent({ firestore, queueRef, masterStorageFactory, nowIso, now }) {
  const prepared = await prepareIntent({ firestore, queueRef, nowIso });
  if (prepared.status !== "ready") return prepared;
  const { ref, expectedIntent } = prepared;
  let result;
  try {
    result = await cleanupUploadMaster({ firestore, ref, masterStorageFactory, nowIso,
      clockMs: () => now().getTime(), attemptId: expectedIntent.attemptId, leaseExpiresAt: expectedIntent.leaseExpiresAt, expectedIntent });
    if (result.status === "fenced_reference") result.alert = true;
  } catch (error) {
    // Only allowlisted internal codes are safe to persist, never provider text.
    if (MANUAL_ERRORS.has(error?.code)) result = { status: error.code, alert: true, manualReview: true };
    else if (error?.code === "claim_changed") result = { status: "claim_changed", alert: true };
    else result = { status: expectedIntent.attempts >= MAX_ATTEMPTS ? "retry_exhausted" : "retry", alert: true };
  }
  if (result.status !== "deleted") {
    await firestore.runTransaction(async (transaction) => {
      const current = (await transaction.get(queueRef)).data();
      if (isDeepStrictEqual(current, expectedIntent)) {
        transaction.update(queueRef, { lastStatus: result.status,
          ...(result.manualReview ? { manualReview: true } : {}) });
      }
    });
  }
  return result;
}

async function discoverClaim({ firestore, ref, nowIso }) {
  return firestore.runTransaction(async (transaction) => {
    const owner = (await transaction.get(ref)).data();
    if (!owner?.recordSeed?.master?.key || owner.state === "committed" ||
        owner.operation === "replacement") return { status: "not_candidate" };
    if (!validOwner(ref, owner)) return { status: "invalid_claim", alert: true };
    if (Date.parse(owner.leaseExpiresAt) > Date.parse(nowIso)) return { status: "lease_active" };
    const queueRef = firestore.collection("mediaMasterCleanup").doc(owner.attemptId);
    const queue = await transaction.get(queueRef);
    if (queue.exists) return { status: "already_queued" };
    // Covers a crash before/after PUT, before its receipt, and before queueing a
    // recoverable failure. Discovery itself never deletes or takes a fence.
    transaction.create(queueRef, cleanupIntent({ ref, owner, nowIso }));
    return { status: "discovered" };
  });
}

async function page(firestore, path, cursor, limit) {
  let query = firestore.collection(path).orderBy(FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  return (await query.limit(limit + 1).get()).docs;
}

async function runMasterCleanupConsumer({
  firestore, masterStorageFactory, enabled = false, pageSize = 25,
  now = () => new Date(), log = logger,
} = {}) {
  if (enabled !== true) return { status: "disabled" };
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error("Master cleanup pageSize must be from 1 to 50");
  }
  const started = now();
  const startedAt = started.toISOString();
  const runId = randomUUID();
  const controlRef = firestore.doc(CONTROL_PATH);
  const acquired = await firestore.runTransaction(async (transaction) => {
    const state = (await transaction.get(controlRef)).data() || {};
    if (state.runId && (!validTime(state.leaseUntil) || Date.parse(state.leaseUntil) > started.getTime())) {
      return null;
    }
    const cursors = { intentCursor: state.intentCursor ?? null, claimCursor: state.claimCursor ?? null };
    transaction.set(controlRef, { ...state, ...cursors, runId, startedAt,
      leaseUntil: new Date(started.getTime() + DELETE_LEASE_MS).toISOString() });
    return cursors;
  });
  if (!acquired) return { status: "busy" };
  const report = { runId, startedAt, status: "complete", entries: [], claims: [], alerts: 0 };
  const cursors = { ...acquired };
  try {
    for (const [path, cursorName, listName, inspect] of [
      ["mediaMasterCleanup", "intentCursor", "entries", consumeIntent],
      ["system/media/hashOwners", "claimCursor", "claims", discoverClaim],
    ]) {
      if (now().getTime() - started.getTime() >= RUN_BUDGET_MS) break;
      const docs = await page(firestore, path, acquired[cursorName], pageSize);
      let processed = 0;
      for (const doc of docs.slice(0, pageSize)) {
        if (now().getTime() - started.getTime() >= RUN_BUDGET_MS) break;
        // An expired/stolen run never admits more work. Per-key leases fence any
        // external delete that began before this check.
        const current = (await controlRef.get()).data();
        if (current?.runId !== runId || Date.parse(current.leaseUntil) <= now().getTime()) {
          throw new Error("Master cleanup run ownership changed");
        }
        let result;
        try {
          result = await inspect({ firestore, ref: doc.ref, queueRef: doc.ref,
            masterStorageFactory, nowIso: now().toISOString(), now });
        } catch { result = { status: "inspection_failed", alert: true }; }
        report[listName].push({ id: doc.id, ...result });
        if (result.alert) report.alerts++;
        cursors[cursorName] = doc.id;
        processed++;
      }
      if (processed === docs.length) cursors[cursorName] = null;
    }
  } catch {
    report.status = "failed";
    report.alerts++;
  }
  report.finishedAt = now().toISOString();
  if (report.alerts) log.warn("media_master_cleanup_attention", {
    runId, alerts: report.alerts, status: report.status,
  });
  // Persist report + cursor + release atomically. A lost report commit leaves a
  // leased run; a later run can safely replay from the old cursor.
  try {
    await firestore.runTransaction(async (transaction) => {
      const current = (await transaction.get(controlRef)).data();
      if (current?.runId !== runId) throw new Error("Master cleanup run ownership changed");
      transaction.create(controlRef.collection("runs").doc(runId), report);
      transaction.set(controlRef, { ...cursors, lastRunId: runId, lastCompletedAt: report.finishedAt,
        lastStatus: report.status, alerts: report.alerts });
    });
  } catch {
    log.error("media_master_cleanup_report_failed", { runId });
    throw new Error("Master cleanup report could not be committed");
  }
  return report;
}

module.exports = { runMasterCleanupConsumer, MAX_ATTEMPTS, MAX_PAGE_SIZE, RUN_BUDGET_MS };
