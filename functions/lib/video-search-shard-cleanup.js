"use strict";

const { createHash } = require("node:crypto");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const CLAIMS = "mediaSourceSearchShardDeletes";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function deletionRef(firestore, descriptor) {
  if (!/^[a-f0-9]{64}$/.test(descriptor?.digest ?? "") ||
      typeof descriptor.objectVersion !== "string" || !descriptor.objectVersion.trim() ||
      descriptor.objectVersion === "null" || descriptor.objectVersion.length > 1024 ||
      [...descriptor.objectVersion].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) throw Error("search_shard_invalid");
  return firestore.collection(CLAIMS).doc(hash([descriptor.digest, descriptor.objectVersion]));
}

// The caller supplies the separate cleanup-role client; this operation cannot
// list a prefix, read text, delete a key without a version, or select a bucket.
function shardDeleter(s3, config) {
  if (!/^[0-9]{12}$/.test(config.accountId ?? "") ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket ?? "") ||
      config.bucket !== process.env.CMS_MEDIA_AWS_RENDITION_BUCKET ||
      config.accountId !== process.env.CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID) {
    throw Error("search_shard_cleanup_scope_invalid");
  }
  return descriptor => s3.send(new DeleteObjectCommand({ Bucket: config.bucket,
    ExpectedBucketOwner: config.accountId, Key: `transcripts/results/search-v1/${descriptor.digest}.json`,
    VersionId: descriptor.objectVersion }));
}

async function cleanupSearchShard({ firestore, descriptor, config, remove, apply = false, expectedFingerprint, now = Date.now() }) {
  const ref = deletionRef(firestore, descriptor);
  const identity = { digest: descriptor.digest, objectVersion: descriptor.objectVersion,
    bucket: config.bucket, accountId: config.accountId };
  const fingerprint = hash(identity);
  const check = async tx => {
    const claim = (await tx.get(ref)).data();
    const references = await tx.get(firestore.collection("mediaSourceSearchShards").where("digest", "==", descriptor.digest));
    // Protect any stored descriptor, including a malformed/pending one. Source
    // authorization and tombstones are never evidence of physical erasure.
    if (references.docs.some(row => row.data().objectVersion === descriptor.objectVersion)) throw Error("search_shard_referenced");
    if (claim && claim.fingerprint !== fingerprint) throw Error("search_shard_scope_changed");
    return claim;
  };
  const claim = await firestore.runTransaction(async tx => {
    const previous = await check(tx);
    if (apply) {
      if (expectedFingerprint !== fingerprint) throw Error("search_shard_reviewed_fingerprint_required");
      if (!previous) {
        tx.create(ref, { ...identity, fingerprint, state: "deleting", requestedAt: new Date(now).toISOString() });
        tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
          actorUid: "system:video-search-shard-cleanup", action: "media.video.search.delete.claim",
          target: ref.path, after: { ...identity, fingerprint } }));
      }
    }
    return previous;
  });
  if (!apply) return { state: claim?.state ?? "eligible", fingerprint };
  if (claim?.state === "deleted") return { state: "deleted", fingerprint, alreadyDeleted: true };
  if (claim?.state === "delete-marker") throw Error("search_shard_delete_marker");
  // A failed or lost response retains the fence. An exact-version DELETE is
  // idempotent, so retry completes only after a successful provider response.
  const response = await remove(descriptor);
  const state = await firestore.runTransaction(async tx => {
    const current = await check(tx);
    if (current?.state === "delete-marker" || response?.DeleteMarker === true) {
      tx.update(ref, { state: "delete-marker" });
      return "delete-marker";
    }
    tx.update(ref, { state: "deleted", deletedAt: new Date(now).toISOString() });
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
      actorUid: "system:video-search-shard-cleanup", action: "media.video.search.delete.complete",
      target: ref.path, after: { ...identity, fingerprint } }));
    return "deleted";
  });
  if (state === "delete-marker") throw Error("search_shard_delete_marker");
  return { state: "deleted", fingerprint };
}

module.exports = { deletionRef, shardDeleter, cleanupSearchShard };
