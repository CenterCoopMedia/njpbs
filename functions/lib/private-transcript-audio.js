"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual: same } = require("node:util");
const { HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { LEASE_MS, identityDigest, newCopy, verifiedFile } = require("./private-video-copy");
const { createPrivateVideoTransfer } = require("./private-video-transfer");
const logger = require("firebase-functions/logger");

const AUDIO_COPIES = "mediaPrivateAudioCopies";
const USES = "mediaTranscriptAudioUses";
const PREPARATIONS = "mediaTranscriptAudioPreparations";
const idFor = (receipt) => identityDigest({ audio: receipt.output, receipt });

async function currentAudio(tx, firestore, job) {
  const receipt = job.identity.receipt;
  const uses = (await tx.get(firestore.collection(USES).doc(`${receipt.preparationId}-${receipt.invocationId}`))).data();
  const preparation = (await tx.get(firestore.collection(PREPARATIONS).doc(receipt.preparationId))).data();
  if (uses?.state !== "active" || preparation?.state !== "ready" ||
      !same(uses.receipt, receipt) || !same(preparation.receipt, receipt)) return false;
  const asset = (await tx.get(firestore.collection("mediaSourceAssets").doc(preparation.identity.assetId))).data();
  const identity = preparation.identity;
  return asset?.lifecycle === "active" && asset.sourceId === "video-library" &&
    asset.objectKey === identity.originalKey && asset.objectVersionId === identity.originalVersion &&
    asset.sizeBytes === identity.originalSize && asset.rendition?.state === "ready" &&
    same(receipt.input, { objectKey: asset.rendition.web?.objectKey,
      objectVersionId: asset.rendition.web?.objectVersionId, sizeBytes: asset.rendition.web?.sizeBytes });
}

function createPrivateTranscriptAudio({ firestore, storage, streamStorage = storage, s3, config, clock = Date.now, sign = getSignedUrl }) {
  const transfer = (r2) => createPrivateVideoTransfer({ s3, r2: r2.client, bucket: r2.bucket,
    config: { renditionBucket: config.bucket, renditionExpectedBucketOwner: config.accountId } });

  async function enqueue(receipt, repair = false) {
    const identity = { audio: receipt.output, receipt };
    const id = idFor(receipt);
    const ref = firestore.collection(AUDIO_COPIES).doc(id);
    return firestore.runTransaction(async (tx) => {
      const preparation = (await tx.get(firestore.collection(PREPARATIONS).doc(receipt.preparationId))).data();
      const candidate = newCopy({ id, identity }, clock());
      if (!await currentAudio(tx, firestore, candidate)) return null;
      const old = (await tx.get(ref)).data();
      if (!old || old.phase === "deleted") {
        candidate.assetId = preparation.identity.assetId;
        candidate.files = { audio: { key: `private-audio/${id}/${candidate.generation}/input.m4a`,
          parts: [], verifiedParts: 0, phase: "pending" } };
        tx.set(ref, candidate);
      } else if (repair && ["ready", "failed"].includes(old.phase) && !old.revoked) {
        tx.update(ref, { phase: "repair", active: true });
      }
      return id;
    });
  }

  async function read(receipt, { stream = false } = {}) {
    let r2;
    try { r2 = storage(); } catch { return null; }
    if (!r2) return null;
    const id = idFor(receipt);
    const job = (await firestore.collection(AUDIO_COPIES).doc(id).get()).data();
    const file = verifiedFile(job, "audio");
    let repair = job?.phase === "ready" && !file;
    if (file) {
      try {
        const head = await r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: file.key }));
        if (head.ContentLength === receipt.output.sizeBytes && head.ETag === file.etag &&
            head.Metadata?.binding === id && head.Metadata?.generation === job.generation &&
            await firestore.runTransaction(tx => currentAudio(tx, firestore, job))) {
          const inputStorage = stream ? streamStorage() : r2;
          if (!inputStorage || inputStorage.bucket !== r2.bucket) return null;
          return { client: inputStorage.client, bucket: r2.bucket, key: file.key, etag: file.etag, id, generation: job.generation };
        }
        repair = true;
      } catch (error) {
        if (["NotFound", "NoSuchKey"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) repair = true;
      }
    }
    await enqueue(receipt, repair);
    return null;
  }

  async function signedInput(receipt) {
    const delivery = await read(receipt);
    if (!delivery) return null;
    const url = await sign(delivery.client, new GetObjectCommand({ Bucket: delivery.bucket, Key: delivery.key }), { expiresIn: 300 });
    return { url, expiresAt: new Date(clock() + 300000).toISOString(), sizeBytes: receipt.output.sizeBytes,
      versionId: receipt.output.objectVersionId, sha256: receipt.output.sha256, mimeType: receipt.output.mimeType,
      preparationId: receipt.preparationId, invocationId: receipt.invocationId,
      storage: "private-r2", objectKey: delivery.key, bindingId: delivery.id, generation: delivery.generation };
  }

  async function revoke({ receipt, assetId, onlyStale = false }) {
    const snapshots = receipt ? [await firestore.collection(AUDIO_COPIES).doc(idFor(receipt)).get()]
      : (await firestore.collection(AUDIO_COPIES).where("assetId", "==", assetId).get()).docs;
    for (const snapshot of snapshots) {
      const job = await firestore.runTransaction(async tx => {
        const current = (await tx.get(snapshot.ref)).data();
        if (!current || current.phase === "deleted" || (onlyStale && await currentAudio(tx, firestore, current))) return null;
        tx.update(snapshot.ref, { revoked: true, phase: "revoking", active: true });
        return current;
      });
      if (job) {
        const r2 = storage(true);
        if (!r2) throw Error("private_audio_cleanup_configuration_missing");
        await transfer(r2).remove(job);
      }
    }
  }

  async function tick({ copyEnabled = true } = {}) {
    const query = copyEnabled ? firestore.collection(AUDIO_COPIES).where("active", "==", true)
      : firestore.collection(AUDIO_COPIES).where("phase", "==", "revoking");
    const snapshots = await query.limit(20).get();
    if (!snapshots.docs.length) return { idle: true };
    const r2 = storage(true);
    if (!r2) throw Error("private_audio_cleanup_configuration_missing");
    for (const snapshot of snapshots.docs) {
      const job = await firestore.runTransaction(async tx => {
        const current = (await tx.get(snapshot.ref)).data();
        if (!current?.active || current.leaseUntil > clock()) return null;
        const revoked = current.revoked || !await currentAudio(tx, firestore, current);
        const next = { ...current, revoked, ...(revoked ? { phase: "revoking" } : {}), leaseOwner: randomUUID(), leaseUntil: clock() + LEASE_MS };
        tx.set(snapshot.ref, next);
        return next;
      });
      if (!job) continue;
      const save = async changes => firestore.runTransaction(async tx => {
        const current = (await tx.get(snapshot.ref)).data();
        if (!current || current.generation !== job.generation || current.leaseOwner !== job.leaseOwner) return false;
        if (current.revoked || !await currentAudio(tx, firestore, job)) {
          tx.update(snapshot.ref, { revoked: true, phase: "revoking", active: true });
          return false;
        }
        tx.update(snapshot.ref, changes);
        Object.assign(job, changes);
        return true;
      });
      try {
        if (job.revoked || job.phase === "repair") {
          await transfer(r2).remove(job);
          await firestore.runTransaction(async tx => {
            const current = (await tx.get(snapshot.ref)).data();
            if (current?.generation === job.generation && current.leaseOwner === job.leaseOwner) {
              tx.update(snapshot.ref, { phase: "deleted", active: false, revoked: true, leaseUntil: 0 });
            }
          });
          // Repair is queued by the next authorized read, using a new invocation/generation.
        } else {
          for (let step = 0; step < 12 && job.active; step++) {
            if (!await save({ leaseUntil: clock() + LEASE_MS })) break;
            await transfer(r2).step(job, save);
          }
          await save({ leaseUntil: 0 });
        }
      } catch {
        const failures = (job.failures ?? 0) + 1;
        await save({ failures, leaseUntil: 0, ...(failures >= 5 ? { phase: "failed", active: false } : {}) });
        logger.warn("Private audio copy step failed", { copyId: job.id, failures });
      }
      return { copyId: job.id, phase: job.phase };
    }
    return { idle: true };
  }
  return { read, enqueue, signedInput, revoke, tick };
}

module.exports = { AUDIO_COPIES, currentAudio, idFor, createPrivateTranscriptAudio };
