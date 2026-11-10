"use strict";

// A signed URL limits when a PUT starts. Allow slow transfers another hour
// before an absent object can be fenced to recover abandoned capacity.
const UPLOAD_TRANSFER_GRACE_MS = 60 * 60 * 1000;

// Parent TTL deletion does not delete subcollections. Keep only the immutable
// storage binding here, without contact data or a TTL. A retained binding also
// prevents an expired request ID from being reused for a different upload.
function quotaEvidenceRef(ref) {
  return ref.collection("quota").doc("storage");
}

function quotaEvidence(record) {
  const quarantineKey = record.quarantineKey || record.quotaKey;
  const uploadExpiresAtMs = record.uploadExpiresAt?.toMillis();
  if (!quarantineKey || !record.clientIpHash || !Number.isSafeInteger(uploadExpiresAtMs)) {
    throw new Error("Missing upload storage binding");
  }
  return { quarantineKey, clientIpHash: record.clientIpHash, uploadExpiresAtMs };
}

// A negative HEAD cannot rule out a PUT that started before URL expiry. Seal
// the empty key with a conditional zero-byte object before releasing its hold.
// The signed client PUT uses If-None-Match: *, so that fence also rejects replay.
async function reconcileQuota(storage, record, now) {
  // Staff rejection removes the quarantine key after deletion, but retains
  // the verified size. Keep those uploaded bytes charged without reading a key.
  if (["pending", "imported"].includes(record.status) ||
      (record.status === "rejected" && !record.quarantineKey && Number.isSafeInteger(record.size) && record.size > 0)) {
    if (!Number.isSafeInteger(record.size) || record.size <= 0) {
      throw new Error("Missing verified upload size");
    }
    return record.size;
  }
  const key = record.quarantineKey || record.quotaKey;
  if (!key) throw new Error("Missing verified upload size or storage key");
  const head = await storage.head(key);
  if (head) return storedBytes(head);
  if (record.status === "uploading" && record.uploadExpiresAt.toMillis() + UPLOAD_TRANSFER_GRACE_MS > now) return null;
  if (!["uploading", "rejected"].includes(record.status)) throw new Error("Unknown upload state");
  if (await storage.sealMissing(key)) return 0;
  // A concurrent conditional PUT won. Its real bytes still consume capacity.
  const winner = await storage.head(key);
  if (!winner) throw new Error("Upload outcome unavailable");
  return storedBytes(winner);
}

function storedBytes(head) {
  if (!Number.isSafeInteger(head.size) || head.size < 0) throw new Error("Invalid stored upload size");
  return head.size;
}

module.exports = { quotaEvidence, quotaEvidenceRef, reconcileQuota, UPLOAD_TRANSFER_GRACE_MS };
