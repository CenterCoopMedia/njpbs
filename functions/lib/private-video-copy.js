"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { parseSourceMediaAsset } = require("./source-media-contract");
const { parseSourceMediaRendition } = require("./source-media-rendition");

const COPIES = "mediaPrivateVideoCopies";
// Longer than the worker's 540-second deadline. A reclaimed writer cannot overlap.
const LEASE_MS = 12 * 60 * 1000;
const PART_BYTES = 64 * 1024 * 1024;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function identityDigest(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return sha256(JSON.stringify(canonical(value)));
}

function deliveryOutput(output) {
  return { objectKey: output.objectKey, objectVersionId: output.objectVersionId,
    sizeBytes: output.sizeBytes, mimeType: output.mimeType };
}

function copyIdentity(source, asset) {
  const rendition = parseSourceMediaRendition(asset?.rendition, asset);
  if (source?.id !== "video-library" || asset?.sourceId !== source.id || rendition?.state !== "ready") return null;
  const identity = { sourceId: source.id, assetId: asset.id, originalBucket: source.bucket,
    originalKey: asset.objectKey, originalVersion: asset.objectVersionId, originalSize: asset.sizeBytes,
    web: deliveryOutput(rendition.web), poster: deliveryOutput(rendition.poster) };
  return { id: identityDigest(identity), identity };
}

function currentIdentity(source, snapshot) {
  const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
  return asset ? copyIdentity(source, asset) : null;
}

function newCopy(binding, now = Date.now()) {
  const generation = randomUUID();
  return { ...binding, generation, phase: "copying", active: true, revoked: false,
    files: Object.fromEntries(["web", "poster"].map((kind) => [kind, {
      key: `private-video/${binding.id}/${generation}/${kind === "web" ? "preview.mp4" : "poster.jpg"}`,
      parts: [], verifiedParts: 0, phase: "pending",
    }])), failures: 0, leaseUntil: 0, createdAt: now, updatedAt: now };
}

async function enqueueCopy({ firestore, source, assetId, repair = false, now = Date.now() }) {
  return firestore.runTransaction(async (tx) => {
    const binding = currentIdentity(source, await tx.get(firestore.collection("mediaSourceAssets").doc(assetId)));
    if (!binding) return null;
    const ref = firestore.collection(COPIES).doc(binding.id);
    const existing = (await tx.get(ref)).data();
    if (!existing || existing.phase === "deleted") tx.set(ref, newCopy(binding, now));
    else if (repair && ["ready", "failed"].includes(existing.phase) && !existing.revoked) {
      // Keep keys until cleanup finishes; a repair always uses a fresh generation.
      tx.update(ref, { phase: "repair", active: true, failures: 0, updatedAt: now });
    }
    return binding.id;
  });
}

async function revokeCopies({ firestore, source, assetId, remove, now = Date.now() }) {
  const snapshots = await firestore.collection(COPIES).where("identity.assetId", "==", assetId).get();
  for (const snapshot of snapshots.docs) {
    const job = await firestore.runTransaction(async (tx) => {
      const current = (await tx.get(snapshot.ref)).data();
      const binding = currentIdentity(source, await tx.get(firestore.collection("mediaSourceAssets").doc(assetId)));
      if (binding?.id === snapshot.id) return null;
      if (!current || current.phase === "deleted") return null;
      tx.update(snapshot.ref, { revoked: true, phase: "revoking", active: true, updatedAt: now });
      return current;
    });
    // Delete ready bytes immediately, even when an old writer still owns a lease.
    // The worker repeats cleanup after that writer's hard deadline.
    if (job && remove) await remove(job);
  }
}

async function claimCopy({ firestore, ref, source, now = Date.now() }) {
  const owner = randomUUID();
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    if (!job?.active || job.leaseUntil > now) return null;
    const current = currentIdentity(source, await tx.get(firestore.collection("mediaSourceAssets").doc(job.identity.assetId)));
    const revoked = job.revoked || current?.id !== job.id;
    tx.update(ref, { revoked, ...(revoked ? { phase: "revoking" } : {}), leaseOwner: owner, leaseUntil: now + LEASE_MS });
    return { ...job, revoked, ...(revoked ? { phase: "revoking" } : {}), leaseOwner: owner };
  });
}

async function saveCopy({ firestore, ref, source, job, changes, now = Date.now() }) {
  return firestore.runTransaction(async (tx) => {
    const stored = (await tx.get(ref)).data();
    if (!stored || stored.leaseOwner !== job.leaseOwner || stored.generation !== job.generation) return false;
    const binding = currentIdentity(source, await tx.get(firestore.collection("mediaSourceAssets").doc(job.identity.assetId)));
    if (stored.revoked || binding?.id !== job.id) {
      tx.update(ref, { revoked: true, phase: "revoking", active: true, updatedAt: now });
      return false;
    }
    tx.update(ref, { ...changes, updatedAt: now });
    Object.assign(job, changes);
    return true;
  });
}

function verifiedFile(job, kind) {
  const file = job?.files?.[kind];
  const output = job?.identity?.[kind];
  if (!job?.identity || identityDigest(job.identity) !== job.id || job?.revoked || job?.phase !== "ready" || file?.phase !== "ready" ||
      !output || (kind === "audio" && file.fullSha256 !== output.sha256) || !file.etag || !file.checksum || file.verifiedParts !== file.parts.length ||
      file.parts.length !== Math.ceil(output.sizeBytes / PART_BYTES) ||
      file.key !== `private-${kind === "audio" ? "audio" : "video"}/${job.id}/${job.generation}/${kind === "audio" ? "input.m4a" : kind === "web" ? "preview.mp4" : "poster.jpg"}`) return null;
  const checksum = sha256(file.parts.map((part) => part.sha256).join(""));
  return checksum === file.checksum ? { ...output, ...file } : null;
}

module.exports = { COPIES, LEASE_MS, PART_BYTES, sha256, identityDigest, copyIdentity, currentIdentity, newCopy,
  enqueueCopy, revokeCopies, claimCopy, saveCopy, verifiedFile };
