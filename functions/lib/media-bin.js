"use strict";

const MEDIA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function purgeAfterFor(timestamp) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) throw new Error("A valid bin timestamp is required");
  return new Date(time + MEDIA_RETENTION_MS).toISOString();
}

function mediaPurgeRef(firestore, assetId) {
  return firestore.collection("mediaPurgeQueue").doc(`asset:${assetId}`);
}

function createImagePurgeEntry(assetId, stored, queuedAt, eligibleAt = purgeAfterFor(queuedAt)) {
  if (stored.kind !== "image") throw new Error("Only images can enter the media bin");
  if (typeof stored.storageKey !== "string" || !stored.storageKey) {
    throw new Error("The image has no stored object key");
  }
  const publicKeys = new Set([stored.storageKey]);
  for (const thumbnail of stored.thumbnails ?? []) {
    if (typeof thumbnail.storageKey !== "string" || !thumbnail.storageKey) {
      throw new Error("An image thumbnail has no stored object key");
    }
    publicKeys.add(thumbnail.storageKey);
  }
  const masterKey = stored.master?.key ?? null;
  if (masterKey !== null && (typeof masterKey !== "string" || !masterKey)) {
    throw new Error("The image master has no stored object key");
  }
  return {
    kind: "image",
    assetId,
    reason: "deleted",
    queuedAt,
    eligibleAt,
    objects: [
      ...[...publicKeys].map((key) => ({ store: "public", key })),
      ...(masterKey ? [{ store: "masters", key: masterKey }] : []),
    ],
    masterKey,
    state: "pending",
    attempts: 0,
    lastError: null,
    leaseExpiresAt: null,
    runId: null,
    purgedAt: null,
  };
}

module.exports = { MEDIA_RETENTION_MS, purgeAfterFor, mediaPurgeRef, createImagePurgeEntry };
