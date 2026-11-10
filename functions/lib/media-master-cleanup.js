"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { masterObjectKey } = require("./r2-media-masters");

// The fence NEVER expires. This lease only controls deletion executions; each
// executor also checks ownership and its absolute deadline immediately before I/O.
const DELETE_LEASE_MS = 15 * 60_000;
const DELETE_MARGIN_MS = 30_000;
const PENDING_STATES = new Set(["reserved", "object_ready", "capacity_cleanup"]);

function cleanupError(code) {
  const error = new Error(`Master cleanup: ${code}`);
  error.code = code;
  return error;
}

function cleanupIntent({ ref, owner, nowIso, eligibleAt = owner.leaseExpiresAt }) {
  const master = owner.recordSeed.master;
  if (master.key !== masterObjectKey(master)) throw cleanupError("invalid_master_key");
  return {
    state: "pending", key: master.key, contentHash: master.contentHash,
    claimPath: ref.path, attemptId: owner.attemptId,
    leaseExpiresAt: owner.leaseExpiresAt, queuedAt: nowIso, eligibleAt,
  };
}

async function queueUploadMasterCleanup({
  firestore, ref, attemptId, leaseExpiresAt, nowIso, eligibleAt = leaseExpiresAt,
}) {
  const queueRef = firestore.collection("mediaMasterCleanup").doc(attemptId);
  await firestore.runTransaction(async (transaction) => {
    const [snapshot, queued] = await Promise.all([
      transaction.get(ref), transaction.get(queueRef),
    ]);
    const owner = snapshot.data();
    if (!owner || owner.state === "committed" || !owner.recordSeed?.master?.key) return;
    if (owner.attemptId !== attemptId || owner.leaseExpiresAt !== leaseExpiresAt) {
      throw new Error("The upload changed before queuing master cleanup");
    }
    const intent = cleanupIntent({ ref, owner, nowIso, eligibleAt });
    const previous = queued.data();
    // Preserve terminal eligibility on this lease, and preserve the consumer's
    // retry budget across renewals. Never replace an in-flight deletion intent.
    if (queued.exists && previous.leaseExpiresAt === leaseExpiresAt) return;
    if (queued.exists) {
      const lock = await transaction.get(firestore.doc(`system/media/masterLocks/${intent.contentHash}`));
      if (lock.exists || previous.state !== "pending" || previous.key !== intent.key ||
          previous.contentHash !== intent.contentHash || previous.claimPath !== ref.path ||
          previous.attemptId !== attemptId) throw cleanupError("intent_changed");
    }
    transaction.set(queueRef, { ...previous, ...intent });
  });
}

async function masterHasReferences(transaction, firestore, ref, key) {
  // Existence is sufficient: bounded reads also protect malformed/unknown states.
  const [assets, claims, versions] = await Promise.all([
    transaction.get(firestore.collection("media_assets").where("master.key", "==", key).limit(1)),
    transaction.get(firestore.collection("system/media/hashOwners")
      .where("recordSeed.master.key", "==", key).limit(2)),
    transaction.get(firestore.collection("mediaPurgeQueue").where("masterKey", "==", key).limit(1)),
  ]);
  return !assets.empty || claims.docs.some((doc) => doc.ref.path !== ref.path) || !versions.empty;
}

// Shared by immediate rejection and the disabled consumer. A queue snapshot is
// required for a consumer: all authorization checks are repeated under the same
// transaction that takes the fence, after obtaining the storage client.
async function cleanupUploadMaster({
  firestore, ref, attemptId, leaseExpiresAt, masterStorageFactory, nowIso,
  expectedIntent = null, clockMs = () => Date.now(),
}) {
  const initial = (await ref.get()).data();
  if (!initial?.recordSeed?.master?.key || initial.state === "committed") return { status: "changed" };
  let storage;
  try {
    storage = await masterStorageFactory();
    if (!storage) throw new Error("The master cleanup store is unavailable");
  } catch (error) {
    if (!expectedIntent) await queueUploadMasterCleanup({ firestore, ref, attemptId, leaseExpiresAt,
      nowIso, eligibleAt: nowIso });
    throw error;
  }
  const queueRef = firestore.collection("mediaMasterCleanup").doc(attemptId);
  const deleteToken = randomUUID();
  const queued = await firestore.runTransaction(async (transaction) => {
    const [snapshot, queue] = await Promise.all([transaction.get(ref), transaction.get(queueRef)]);
    const owner = snapshot.data();
    if (!owner || owner.state === "committed") return { status: "changed" };
    if (owner.attemptId !== attemptId || owner.leaseExpiresAt !== leaseExpiresAt ||
        !PENDING_STATES.has(owner.state) || owner.operation === "replacement") {
      const error = cleanupError("claim_changed");
      error.message = "The upload changed before master cleanup";
      throw error;
    }
    const master = owner.recordSeed?.master;
    if (!master?.key) return { status: "changed" };
    if (master.key !== masterObjectKey(master)) throw cleanupError("invalid_master_key");
    const lockRef = firestore.doc(`system/media/masterLocks/${master.contentHash}`);
    const lock = (await transaction.get(lockRef)).data();
    if (lock && (lock.state !== "purging" || lock.cleanupId !== attemptId || lock.key !== master.key ||
        (lock.claimPath !== undefined && lock.claimPath !== ref.path) ||
        (lock.leaseExpiresAt !== undefined && lock.leaseExpiresAt !== leaseExpiresAt))) {
      throw cleanupError("fence_conflict");
    }
    const checkedAt = clockMs();
    if (!Number.isFinite(checkedAt)) throw cleanupError("invalid_clock");
    if (lock?.deleteToken && (!Number.isFinite(Date.parse(lock.deleteLeaseExpiresAt)) ||
        Date.parse(lock.deleteLeaseExpiresAt) > checkedAt)) {
      return { status: "busy" };
    }
    if (expectedIntent) {
      if (!isDeepStrictEqual(queue.data(), expectedIntent) || expectedIntent.state !== "pending" ||
          expectedIntent.claimPath !== ref.path || expectedIntent.attemptId !== attemptId ||
          expectedIntent.leaseExpiresAt !== leaseExpiresAt || expectedIntent.key !== master.key ||
          expectedIntent.contentHash !== master.contentHash) throw cleanupError("intent_changed");
      if (Date.parse(expectedIntent.eligibleAt) > checkedAt ||
          (!lock && Date.parse(leaseExpiresAt) > checkedAt)) return { status: "deferred" };
      // Legacy producers need a grace window. Activation also requires verifying
      // that old executors drained; request timeout alone does not prove it.
      if (lock && !lock.deleteToken &&
          Date.parse(expectedIntent.queuedAt) + DELETE_LEASE_MS > checkedAt) {
        return { status: "busy" };
      }
    }
    if (await masterHasReferences(transaction, firestore, ref, master.key)) {
      return { status: lock ? "fenced_reference" : "shared" };
    }
    const intent = queue.exists ? queue.data() : cleanupIntent({ ref, owner, nowIso, eligibleAt: nowIso });
    if (queue.exists && (intent.key !== master.key || intent.contentHash !== master.contentHash ||
        intent.claimPath !== ref.path || intent.attemptId !== attemptId ||
        intent.leaseExpiresAt !== leaseExpiresAt)) throw cleanupError("intent_changed");
    // Use the live clock after all reads, not the request-start/queue timestamp.
    const deleteDeadlineMs = clockMs() + DELETE_LEASE_MS - DELETE_MARGIN_MS;
    transaction.set(queueRef, intent);
    transaction.set(lockRef, { state: "purging", cleanupId: attemptId, key: master.key,
      claimPath: ref.path, leaseExpiresAt, deleteToken,
      deleteLeaseExpiresAt: new Date(deleteDeadlineMs + DELETE_MARGIN_MS).toISOString() });
    return { status: "acquired", master, lockRef, intent, deleteDeadlineMs };
  });
  if (queued.status !== "acquired") {
    if (!expectedIntent && ["busy", "fenced_reference"].includes(queued.status)) {
      throw cleanupError(queued.status);
    }
    return queued;
  }
  // DeleteObject is idempotent for an absent key. Replaying under the SAME fence
  // repairs a successful R2 delete whose final Firestore transaction never landed.
  const activeLock = (await queued.lockRef.get()).data();
  if (activeLock?.deleteToken !== deleteToken || activeLock?.state !== "purging" ||
      activeLock?.key !== queued.master.key || activeLock?.cleanupId !== attemptId) {
    throw cleanupError("delete_ownership_changed");
  }
  if (!Number.isFinite(clockMs()) || clockMs() >= queued.deleteDeadlineMs) {
    throw cleanupError("delete_deadline_elapsed");
  }
  await storage.delete(queued.master.key, { deadlineMs: queued.deleteDeadlineMs });
  await firestore.runTransaction(async (transaction) => {
    const [snapshot, lock, queue] = await Promise.all([
      transaction.get(ref), transaction.get(queued.lockRef), transaction.get(queueRef),
    ]);
    const owner = snapshot.data();
    if (!owner || owner.attemptId !== attemptId || owner.leaseExpiresAt !== leaseExpiresAt ||
        !PENDING_STATES.has(owner.state) ||
        !isDeepStrictEqual(owner.recordSeed?.master, queued.master) ||
        lock.data()?.state !== "purging" || lock.data()?.key !== queued.master.key ||
        lock.data()?.deleteToken !== deleteToken || lock.data()?.cleanupId !== attemptId ||
        !isDeepStrictEqual(queue.data(), queued.intent)) {
      throw cleanupError("receipt_changed");
    }
    if (await masterHasReferences(transaction, firestore, ref, queued.master.key)) {
      throw cleanupError("receipt_referenced");
    }
    const master = { ...queued.master };
    delete master.key;
    transaction.update(ref, { recordSeed: { ...owner.recordSeed,
      master: { ...master, retained: false, reason: "store-failed" } } });
    transaction.delete(queueRef);
    transaction.delete(queued.lockRef);
  });
  return { status: "deleted" };
}

module.exports = { cleanupUploadMaster, queueUploadMasterCleanup, cleanupIntent,
  masterHasReferences, DELETE_LEASE_MS, PENDING_STATES };
