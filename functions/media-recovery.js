"use strict";

// This is an inert recovery foundation. It is intentionally absent from
// functions/index.js until its caller, deployment schedule, and alert path are
// reviewed together. The bounded handler remains testable without making a live
// Cloud Function reachable.

const { isDeepStrictEqual } = require("node:util");
const { FieldPath } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const {
  DISCARD_REASONS,
  appendDiscardReceipt,
} = require("./lib/media-discard-audit");
const {
  MediaCategoryValidationError,
} = require("./lib/media-categories");
const { assertBillingEnabled } = require("./lib/billing-state");
const { can, hasCapability } = require("./lib/rbac");
const {
  JsonRequestError,
  validateBoundedJsonRequest,
} = require("./lib/http-json");
const {
  MAX_CONFIGURED_UPLOAD_BYTES,
  MAX_IMAGE_PIXELS,
  finalObjectKey,
  mediaProjection,
  mediaType,
  normalizeOriginalName,
  normalizeUploadMetadata,
  stagingObjectKey,
} = require("./lib/media-contract");
const {
  MASTER_EXTENSIONS,
  masterObjectKey,
} = require("./lib/r2-media-masters");
const {
  MediaCapacityError,
  MEDIA_PUBLIC_ORIGIN,
  RESERVATION_LEASE_MS,
  commitUpload,
  committedUpload,
  createDefaultStorage,
  discardCategoryRejectedUpload,
  ownerRef,
  requireMasterAvailable,
  storedObjectMatches,
  uploadRecordFromClaim,
} = require("./media");

const MAX_MEDIA_RECOVERY_ATTEMPTS = 10;
const MAX_MEDIA_RECOVERY_JSON_BYTES = 1024;
const MEDIA_RECOVERY_FORBIDDEN_MESSAGE =
  "You do not have permission to recover media uploads.";
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const MASTER_NOT_RETAINED_REASONS = new Set([
  "not-configured",
  "store-failed",
  "unsupported",
]);
const ABANDONED_REASONS = new Set([
  "final_object_mismatch",
]);
const PENDING_STATES = new Set([
  "reserved",
  "object_ready",
  "capacity_cleanup",
]);
const COMMON_OWNER_FIELDS = Object.freeze([
  "state",
  "attemptId",
  "assetId",
  "category",
  "finalKey",
  "stagingKey",
  "sizeBytes",
  "mimeType",
  "recordSeed",
  "createdAt",
  "updatedAt",
  "leaseExpiresAt",
]);
const MUTABLE_OWNER_OPTIONAL_FIELDS = Object.freeze([
  "capacityCleanupAt",
  "resumedAt",
  "recoveryCount",
]);
const ABANDONED_OWNER_FIELDS = Object.freeze([
  "schemaVersion",
  "state",
  "contentHash",
  "attemptId",
  "assetId",
  "category",
  "finalKey",
  "stagingKey",
  "sizeBytes",
  "mimeType",
  "recordSeed",
  "createdAt",
  "previousState",
  "abandonedAt",
  "abandonedReason",
  "abandonedBy",
]);

class MediaRecoveryError extends Error {
  constructor(message, status = 400, details = {}, recoveryCode = null) {
    super(message);
    this.name = "MediaRecoveryError";
    this.status = status;
    this.details = details;
    this.recoveryCode = recoveryCode;
  }
}

function invalidOwner() {
  return new MediaRecoveryError(
    "This media upload claim has invalid recovery metadata",
    503,
    {},
    "invalid_claim",
  );
}

function assertPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidOwner();
  }
  return value;
}

function assertFields(value, required, optional = []) {
  assertPlainObject(value);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((field) => !allowed.has(field))
  ) {
    throw invalidOwner();
  }
}

function assertExactFields(value, fields) {
  assertFields(value, fields);
  if (Object.keys(value).length !== fields.length) throw invalidOwner();
}

function assertBoundedString(value, maxBytes, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw invalidOwner();
  }
}

function assertIsoTimestamp(value) {
  assertBoundedString(value, 64);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalidOwner();
  }
}

function assertActor(value) {
  assertExactFields(value, ["uid", "email"]);
  assertBoundedString(value.uid, 128);
  assertBoundedString(value.email, 320, { nullable: true });
}

function assertMaster(master) {
  const common = ["contentHash", "mimeType", "sizeBytes", "width", "height", "retained"];
  if (master?.retained === true) {
    assertExactFields(master, [...common, "key"]);
  } else if (master?.retained === false && master.reason === "pending") {
    assertFields(master, [...common, "reason"], ["key"]);
  } else {
    assertExactFields(master, [...common, "reason"]);
    if (master.retained !== false || !MASTER_NOT_RETAINED_REASONS.has(master.reason)) {
      throw invalidOwner();
    }
  }
  if (
    !CONTENT_HASH_PATTERN.test(master.contentHash) ||
    typeof master.mimeType !== "string" ||
    !Number.isSafeInteger(master.sizeBytes) ||
    master.sizeBytes < 1 ||
    master.sizeBytes > MAX_CONFIGURED_UPLOAD_BYTES ||
    !Number.isInteger(master.width) ||
    master.width < 1 ||
    !Number.isInteger(master.height) ||
    master.height < 1 ||
    master.width * master.height > MAX_IMAGE_PIXELS
  ) {
    throw invalidOwner();
  }
  if (master.retained) {
    if (
      !Object.hasOwn(MASTER_EXTENSIONS, master.mimeType) ||
      master.key !== masterObjectKey(master)
    ) {
      throw invalidOwner();
    }
  } else if (!mediaType(master.mimeType)) {
    throw invalidOwner();
  }
  if (
    master.reason === "pending" &&
    Object.hasOwn(MASTER_EXTENSIONS, master.mimeType) &&
    master.key !== masterObjectKey(master)
  ) {
    throw invalidOwner();
  }
}

function assertRecordSeed(seed, owner) {
  assertFields(
    seed,
    ["metadata", "originalName", "dimensions", "actor", "source"],
    ["animated", "master"],
  );
  if (Object.hasOwn(seed, "master")) assertMaster(seed.master);
  if (Object.hasOwn(seed, "animated") && typeof seed.animated !== "boolean") {
    throw invalidOwner();
  }
  assertFields(
    seed.metadata,
    [
      "name",
      "category",
      "description",
      "altText",
      "license",
      "credit",
      "tags",
    ],
    ["categories", "metadataUpdateRequested"],
  );
  assertExactFields(seed.dimensions, ["width", "height"]);
  assertActor(seed.actor);
  assertBoundedString(seed.source, 512, { nullable: true });

  let normalizedMetadata;
  let originalName;
  try {
    originalName = normalizeOriginalName(seed.originalName);
    normalizedMetadata = normalizeUploadMetadata(seed.metadata, originalName);
  } catch {
    throw invalidOwner();
  }
  const canonicalMetadata = Object.hasOwn(seed.metadata, "categories")
    ? seed.metadata
    : {
        ...seed.metadata,
        categories: [seed.metadata.category],
      };
  if (
    originalName !== seed.originalName ||
    !isDeepStrictEqual(normalizedMetadata, canonicalMetadata) ||
    seed.metadata.category !== owner.category
  ) {
    throw invalidOwner();
  }

  const type = mediaType(owner.mimeType);
  if (!type) throw invalidOwner();
  const { width, height } = seed.dimensions;
  if (type.kind !== "image") {
    if (width !== null || height !== null) throw invalidOwner();
  } else if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw invalidOwner();
  }
}

function assertCommonOwner(contentHash, value) {
  if (!CONTENT_HASH_PATTERN.test(contentHash)) throw invalidOwner();
  assertBoundedString(value.attemptId, 128);
  assertBoundedString(value.assetId, 128);
  assertBoundedString(value.category, 60);
  assertBoundedString(value.finalKey, 512);
  assertBoundedString(value.stagingKey, 256);
  if (
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1 ||
    value.sizeBytes > MAX_CONFIGURED_UPLOAD_BYTES
  ) {
    throw invalidOwner();
  }
  if (!mediaType(value.mimeType)) throw invalidOwner();
  assertIsoTimestamp(value.createdAt);

  let expectedFinalKey;
  let expectedStagingKey;
  try {
    expectedFinalKey = finalObjectKey({
      category: value.category,
      assetId: value.assetId,
      contentHash,
      mimeType: value.mimeType,
    });
    expectedStagingKey = stagingObjectKey(value.attemptId);
  } catch {
    throw invalidOwner();
  }
  if (
    value.finalKey !== expectedFinalKey ||
    value.stagingKey !== expectedStagingKey
  ) {
    throw invalidOwner();
  }
  assertRecordSeed(value.recordSeed, value);
}

function assertMutableOwner(contentHash, value) {
  assertPlainObject(value);
  const state = value.state;
  const required = [...COMMON_OWNER_FIELDS];
  if (state === "object_ready" || state === "capacity_cleanup") {
    required.push("objectReadyAt");
  }
  if (state === "capacity_cleanup") required.push("capacityCleanupAt");
  if (state === "committed") required.push("objectReadyAt", "committedAt");
  const optional = [
    ...MUTABLE_OWNER_OPTIONAL_FIELDS,
    ...(state === "reserved" ? [] : ["objectReadyAt"]),
  ];
  assertFields(value, required, optional);
  if (!PENDING_STATES.has(state) && state !== "committed") {
    throw invalidOwner();
  }
  assertCommonOwner(contentHash, value);
  assertIsoTimestamp(value.updatedAt);
  assertIsoTimestamp(value.leaseExpiresAt);
  if (Object.hasOwn(value, "objectReadyAt")) {
    assertIsoTimestamp(value.objectReadyAt);
  }
  if (state === "capacity_cleanup") {
    assertIsoTimestamp(value.capacityCleanupAt);
  } else if (
    Object.hasOwn(value, "capacityCleanupAt") &&
    value.capacityCleanupAt !== null
  ) {
    throw invalidOwner();
  }
  const hasResumedAt = Object.hasOwn(value, "resumedAt");
  const hasRecoveryCount = Object.hasOwn(value, "recoveryCount");
  if (hasResumedAt !== hasRecoveryCount) throw invalidOwner();
  if (hasResumedAt) {
    assertIsoTimestamp(value.resumedAt);
    if (!Number.isSafeInteger(value.recoveryCount) || value.recoveryCount < 1) {
      throw invalidOwner();
    }
  }
  if (state === "committed") assertIsoTimestamp(value.committedAt);
  return value;
}

function assertAbandonedOwner(contentHash, value) {
  assertExactFields(value, ABANDONED_OWNER_FIELDS);
  if (
    value.schemaVersion !== 1 ||
    value.state !== "abandoned" ||
    value.contentHash !== contentHash ||
    !PENDING_STATES.has(value.previousState) ||
    !ABANDONED_REASONS.has(value.abandonedReason)
  ) {
    throw invalidOwner();
  }
  assertCommonOwner(contentHash, value);
  assertIsoTimestamp(value.abandonedAt);
  assertActor(value.abandonedBy);
  return value;
}

function parseMediaRecoveryRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new MediaRecoveryError("The request body must be a JSON object");
  }
  const allowed = new Set(["cursor", "limit"]);
  if (Object.keys(body).some((field) => !allowed.has(field))) {
    throw new MediaRecoveryError("The recovery request has an unknown field");
  }
  const cursor = body.cursor ?? null;
  if (cursor !== null && !CONTENT_HASH_PATTERN.test(cursor)) {
    throw new MediaRecoveryError(
      "The recovery cursor must be a lowercase SHA-256 hash",
    );
  }
  const limit = body.limit ?? MAX_MEDIA_RECOVERY_ATTEMPTS;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_MEDIA_RECOVERY_ATTEMPTS
  ) {
    throw new MediaRecoveryError(
      `The recovery limit must be from 1 to ${MAX_MEDIA_RECOVERY_ATTEMPTS}`,
    );
  }
  return { cursor, limit };
}

function mayRecoverUploads(principal) {
  return can(principal, "media.upload");
}

function isReplacementOwner(value) {
  return value?.operation === "replacement";
}

function assertRecoveryOwner(contentHash, stored, user) {
  if (isReplacementOwner(stored)) {
    throw new MediaRecoveryError(
      "A media replacement claim cannot be recovered as an upload",
      409,
      {},
      "not_upload",
    );
  }
  const owner =
    stored?.state === "abandoned"
      ? assertAbandonedOwner(contentHash, stored)
      : assertMutableOwner(contentHash, stored);
  if (owner.recordSeed.actor.uid !== user.uid) {
    throw new MediaRecoveryError(MEDIA_RECOVERY_FORBIDDEN_MESSAGE, 403);
  }
  if (!mayRecoverUploads(user.principal)) {
    throw new MediaRecoveryError(MEDIA_RECOVERY_FORBIDDEN_MESSAGE, 403);
  }
  return owner;
}

async function readOwnerRecoveryPage(firestore, uid, { cursor, limit }) {
  let query = firestore
    .collection("system")
    .doc("media")
    .collection("hashOwners")
    .where("recordSeed.actor.uid", "==", uid)
    .orderBy(FieldPath.documentId());
  if (cursor !== null) query = query.startAfter(cursor);
  const snapshot = await query.limit(limit + 1).get();
  const overflow = snapshot.docs.length > limit;
  const docs = overflow ? snapshot.docs.slice(0, limit) : snapshot.docs;
  return {
    docs,
    nextCursor: overflow ? docs.at(-1).id : null,
  };
}

function resultFor(contentHash, owner, state, idempotent, reason = null) {
  return {
    contentHash,
    attemptId: owner.attemptId,
    state,
    ...(reason === null ? {} : { reason }),
    idempotent,
  };
}

async function acquireRecoveryLease({
  firestore,
  contentHash,
  user,
  nowDate,
}) {
  const ref = ownerRef(firestore, contentHash);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      throw new MediaRecoveryError(
        "This media upload claim no longer exists",
        409,
        { retryable: true },
      );
    }
    const current = assertRecoveryOwner(contentHash, snapshot.data(), user);
    if (current.state === "abandoned" || current.state === "committed") {
      return { kind: current.state, owner: current, ref };
    }
    await requireMasterAvailable(transaction, firestore, current.recordSeed.master);
    if (Date.parse(current.leaseExpiresAt) > nowDate.getTime()) {
      return { kind: "live", owner: current, ref };
    }
    const nowIso = nowDate.toISOString();
    const leaseExpiresAt = new Date(
      nowDate.getTime() + RESERVATION_LEASE_MS,
    ).toISOString();
    const acquired = {
      ...current,
      updatedAt: nowIso,
      leaseExpiresAt,
      resumedAt: nowIso,
      recoveryCount: (current.recoveryCount ?? 0) + 1,
    };
    transaction.set(ref, acquired);
    return { kind: "acquired", owner: acquired, ref, leaseExpiresAt };
  });
}

async function markRecoveredObjectReady({
  firestore,
  contentHash,
  ref,
  attemptId,
  leaseExpiresAt,
  nowIso,
}) {
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists
      ? assertMutableOwner(contentHash, snapshot.data())
      : null;
    if (
      !current ||
      !PENDING_STATES.has(current.state) ||
      current.attemptId !== attemptId ||
      current.leaseExpiresAt !== leaseExpiresAt
    ) {
      throw new MediaRecoveryError(
        "The media upload recovery lease changed",
        409,
        { retryable: true },
      );
    }
    const ready = {
      ...current,
      state: "object_ready",
      objectReadyAt: current.objectReadyAt ?? nowIso,
      updatedAt: nowIso,
      ...(Object.hasOwn(current, "capacityCleanupAt")
        ? { capacityCleanupAt: null }
        : {}),
    };
    if (ready.recordSeed.master?.reason === "pending") {
      const { contentHash, mimeType, sizeBytes, width, height } = ready.recordSeed.master;
      ready.recordSeed = {
        ...ready.recordSeed,
        // An interrupted store attempt is not proof that the original was kept.
        master: { contentHash, mimeType, sizeBytes, width, height,
          retained: false, reason: "store-failed" },
      };
    }
    transaction.set(ref, ready);
    return ready;
  });
}

async function releaseRecoveryLease({
  firestore,
  contentHash,
  ref,
  attemptId,
  leaseExpiresAt,
  nowIso,
  adminLogEntryFn = adminLogEntry,
  source = null,
  // Set only by the caller that found the finished object gone. A release after
  // a capacity rejection leaves the object in place for the retry, so it must
  // not claim anything was destroyed.
  finishedDiscard = false,
}) {
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists
      ? assertMutableOwner(contentHash, snapshot.data())
      : null;
    if (
      !current ||
      !PENDING_STATES.has(current.state) ||
      current.attemptId !== attemptId ||
      current.leaseExpiresAt !== leaseExpiresAt
    ) {
      throw new MediaRecoveryError(
        "The media upload recovery lease changed",
        409,
        { retryable: true },
        "retryable",
      );
    }
    // A claim that had reached a finished object and no longer has one was
    // destroyed by a discard that did not live to write its own row (#205), so
    // this pass finishes it. A reserved attempt never had an object and nothing
    // was destroyed, so it gets no receipt. The keyed create means the discard
    // path and this one cannot both leave a row for the same attempt.
    if (
      finishedDiscard &&
      (current.state === "object_ready" || current.state === "capacity_cleanup")
    ) {
      await appendDiscardReceipt(transaction, firestore, {
        adminLogEntryFn,
        contentHash,
        owner: current,
        attemptId,
        finalKey: current.finalKey,
        reason: DISCARD_REASONS.objectMissing,
        source,
      });
    }
    const released = {
      ...current,
      updatedAt: nowIso,
      leaseExpiresAt: nowIso,
    };
    transaction.set(ref, released);
    return released;
  });
}

function abandonedReceipt({ contentHash, owner, user, nowIso, reason }) {
  return {
    schemaVersion: 1,
    state: "abandoned",
    contentHash,
    attemptId: owner.attemptId,
    assetId: owner.assetId,
    category: owner.category,
    finalKey: owner.finalKey,
    stagingKey: owner.stagingKey,
    sizeBytes: owner.sizeBytes,
    mimeType: owner.mimeType,
    recordSeed: owner.recordSeed,
    createdAt: owner.createdAt,
    previousState: owner.state,
    abandonedAt: nowIso,
    abandonedReason: reason,
    abandonedBy: {
      uid: user.uid,
      email: user.email ?? null,
    },
  };
}

async function abandonRecoveryLease({
  firestore,
  contentHash,
  ref,
  attemptId,
  leaseExpiresAt,
  user,
  nowIso,
  reason,
  source,
  adminLogEntryFn,
}) {
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists
      ? assertMutableOwner(contentHash, snapshot.data())
      : null;
    if (
      !current ||
      !PENDING_STATES.has(current.state) ||
      current.attemptId !== attemptId ||
      current.leaseExpiresAt !== leaseExpiresAt ||
      current.recordSeed.actor.uid !== user.uid
    ) {
      throw new MediaRecoveryError(
        "The media upload recovery lease changed",
        409,
        { retryable: true },
      );
    }
    if (!mayRecoverUploads(user.principal)) {
      throw new MediaRecoveryError(MEDIA_RECOVERY_FORBIDDEN_MESSAGE, 403);
    }
    const receipt = abandonedReceipt({
      contentHash,
      owner: current,
      user,
      nowIso,
      reason,
    });
    assertAbandonedOwner(contentHash, receipt);
    transaction.set(ref, receipt);
    transaction.create(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      adminLogEntryFn({
        actorUid: user.uid,
        actorEmail: user.email ?? null,
        action: "media.upload.abandon",
        target: `system/media/hashOwners/${contentHash}`,
        before: {
          state: current.state,
          attemptId: current.attemptId,
        },
        after: {
          state: "abandoned",
          attemptId: current.attemptId,
          reason,
        },
        source,
      }),
    );
    return receipt;
  });
}

async function removeAttemptStaging(storage, owner) {
  await storage.deleteStaging(owner.stagingKey);
}

async function recoverOneUpload({
  firestore,
  storage = null,
  getStorage = null,
  contentHash,
  user,
  nowDate,
  publicOrigin,
  source,
  adminLogEntryFn = adminLogEntry,
  commitUploadFn = commitUpload,
  committedUploadFn = committedUpload,
}) {
  const acquired = await acquireRecoveryLease({
    firestore,
    contentHash,
    user,
    nowDate,
  });
  if (acquired.kind === "live") {
    return resultFor(contentHash, acquired.owner, "live", true);
  }
  const activeStorage = storage ??
    (typeof getStorage === "function" ? await getStorage() : null);
  if (!activeStorage) {
    throw new Error("The media recovery storage is unavailable");
  }
  if (acquired.kind === "committed") {
    const record = uploadRecordFromClaim({
      contentHash,
      claim: acquired.owner,
      publicOrigin,
      nowIso: acquired.owner.committedAt,
    });
    if (
      !(await committedUploadFn(firestore, {
        contentHash,
        attemptId: acquired.owner.attemptId,
        record,
        projection: mediaProjection(record),
        allowTombstoned: true,
      }))
    ) {
      throw new Error("The committed media upload records do not match");
    }
    await removeAttemptStaging(activeStorage, acquired.owner);
    return resultFor(contentHash, acquired.owner, "committed", true);
  }
  if (acquired.kind === "abandoned") {
    await removeAttemptStaging(activeStorage, acquired.owner);
    return resultFor(
      contentHash,
      acquired.owner,
      "abandoned",
      true,
      acquired.owner.abandonedReason,
    );
  }

  const { owner, ref, leaseExpiresAt } = acquired;
  const stored = await activeStorage.headIfExists(owner.finalKey);
  if (stored === null) {
    await removeAttemptStaging(activeStorage, owner);
    const released = await releaseRecoveryLease({
      firestore,
      contentHash,
      ref,
      attemptId: owner.attemptId,
      leaseExpiresAt,
      nowIso: nowDate.toISOString(),
      adminLogEntryFn,
      source,
      finishedDiscard: true,
    });
    return resultFor(
      contentHash,
      released,
      "pending",
      false,
      "final_object_missing",
    );
  }
  if (!storedObjectMatches(stored, {
    contentHash,
    assetId: owner.assetId,
    attemptId: owner.attemptId,
    sizeBytes: owner.sizeBytes,
    mimeType: owner.mimeType,
  })) {
    const reason = "final_object_mismatch";
    const receipt = await abandonRecoveryLease({
      firestore,
      contentHash,
      ref,
      attemptId: owner.attemptId,
      leaseExpiresAt,
      user,
      nowIso: nowDate.toISOString(),
      reason,
      source,
      adminLogEntryFn,
    });
    await removeAttemptStaging(activeStorage, receipt);
    return resultFor(contentHash, receipt, "abandoned", false, reason);
  }

  const nowIso = nowDate.toISOString();
  const ready = await markRecoveredObjectReady({
    firestore,
    contentHash,
    ref,
    attemptId: owner.attemptId,
    leaseExpiresAt,
    nowIso,
  });
  const record = uploadRecordFromClaim({
    contentHash,
    claim: ready,
    publicOrigin,
    nowIso,
  });
  const projection = mediaProjection(record);
  try {
    await commitUploadFn({
      firestore,
      ref,
      attemptId: ready.attemptId,
      record,
      projection,
      actor: ready.recordSeed.actor,
      source: ready.recordSeed.source,
      nowIso,
      expectedLeaseExpiresAt: leaseExpiresAt,
      adminLogEntryFn,
    });
  } catch (error) {
    if (error instanceof MediaCategoryValidationError) {
      await discardCategoryRejectedUpload({
        firestore,
        storage: activeStorage,
        ref,
        attemptId: ready.attemptId,
        finalKey: ready.finalKey,
        stagingKeys: [ready.stagingKey],
        nowIso,
        leaseExpiresAt,
        adminLogEntryFn,
      });
      return resultFor(
        contentHash,
        ready,
        "abandoned",
        false,
        "invalid_category",
      );
    }
    if (error instanceof MediaCapacityError) {
      await removeAttemptStaging(activeStorage, ready);
      const released = await releaseRecoveryLease({
        firestore,
        contentHash,
        ref,
        attemptId: ready.attemptId,
        leaseExpiresAt,
        nowIso,
      });
      return resultFor(
        contentHash,
        released,
        "pending",
        false,
        "capacity_limit",
      );
    }
    if (
      !(await committedUploadFn(firestore, {
        contentHash,
        attemptId: ready.attemptId,
        record,
        projection,
        allowTombstoned: true,
      }))
    ) {
      throw error;
    }
  }
  await removeAttemptStaging(activeStorage, ready);
  return resultFor(contentHash, ready, "committed", false);
}

function getClientIp(req) {
  return (
    req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null
  );
}

function recoveryAttemptError(contentHash, error) {
  if (error instanceof MediaRecoveryError) {
    const code = error.recoveryCode ??
      (error.status === 403 ? "forbidden" : "retryable");
    return {
      contentHash,
      state: "error",
      code,
      retryable: code === "retryable",
    };
  }
  return {
    contentHash,
    state: "error",
    code: "retryable",
    retryable: true,
  };
}

function createCmsRecoverMediaUploadsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    assertBillingEnabledFn = assertBillingEnabled,
    storageFactory = createDefaultStorage,
    publicOrigin = () => MEDIA_PUBLIC_ORIGIN.value(),
    now = () => new Date(),
    adminLogEntryFn = adminLogEntry,
    readOwnerRecoveryPageFn = readOwnerRecoveryPage,
    recoverOneUploadFn = recoverOneUpload,
    log = logger,
  } = deps;

  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_MEDIA_RECOVERY_JSON_BYTES);
      const request = parseMediaRecoveryRequest(req.body);
      const user = await requirePrincipalFn(req);
      if (!hasCapability(user.principal, "media.upload")) {
        throw new MediaRecoveryError(MEDIA_RECOVERY_FORBIDDEN_MESSAGE, 403);
      }
      try {
        await assertBillingEnabledFn(firestore);
      } catch (error) {
        if (error?.code === "failed-precondition") {
          throw new MediaRecoveryError(error.message, 503);
        }
        throw error;
      }
      const nowDate = now();
      if (!(nowDate instanceof Date) || !Number.isFinite(nowDate.getTime())) {
        throw new Error("The media recovery clock is invalid");
      }
      const page = await readOwnerRecoveryPageFn(
        firestore,
        user.uid,
        request,
      );
      let storagePromise = null;
      const getStorage = () => {
        if (storagePromise === null) {
          storagePromise = Promise.resolve().then(() => storageFactory());
        }
        return storagePromise;
      };
      const attempts = [];
      for (const document of page.docs) {
        if (isReplacementOwner(document.data())) continue;
        try {
          attempts.push(await recoverOneUploadFn({
            firestore,
            getStorage,
            contentHash: document.id,
            user,
            nowDate,
            publicOrigin:
              typeof publicOrigin === "function"
                ? publicOrigin()
                : publicOrigin,
            source: getClientIp(req),
            adminLogEntryFn,
          }));
        } catch (error) {
          if (
            !(error instanceof MediaRecoveryError) ||
            (error.status ?? 500) >= 500
          ) {
            log.error("cmsRecoverMediaUploads attempt failed", {
              contentHash: document.id,
              error: error?.message || String(error),
            });
          }
          attempts.push(recoveryAttemptError(document.id, error));
        }
      }
      res.status(200).json({
        success: true,
        scanned: page.docs.length,
        nextCursor: page.nextCursor,
        attempts,
      });
    } catch (error) {
      if (res.headersSent) return;
      const expected =
        error instanceof MediaRecoveryError ||
        error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      if (!expected || (error?.status ?? 500) >= 500) {
        log.error("cmsRecoverMediaUploads failed", {
          error: error?.message || String(error),
        });
      }
      const status = expected ? (error.status ?? 500) : 503;
      res.status(status).json({
        error: expected
          ? error.message
          : "The media upload recovery could not be completed",
        ...(error instanceof MediaRecoveryError ? error.details : {}),
        ...(!expected ? { retryable: true } : {}),
      });
    }
  };
}

module.exports = {
  ABANDONED_OWNER_FIELDS,
  ABANDONED_REASONS,
  MAX_MEDIA_RECOVERY_ATTEMPTS,
  MAX_MEDIA_RECOVERY_JSON_BYTES,
  MEDIA_RECOVERY_FORBIDDEN_MESSAGE,
  MediaRecoveryError,
  abandonRecoveryLease,
  abandonedReceipt,
  acquireRecoveryLease,
  assertAbandonedOwner,
  assertMutableOwner,
  createCmsRecoverMediaUploadsHandler,
  markRecoveredObjectReady,
  parseMediaRecoveryRequest,
  readOwnerRecoveryPage,
  recoveryAttemptError,
  recoverOneUpload,
  releaseRecoveryLease,
};
