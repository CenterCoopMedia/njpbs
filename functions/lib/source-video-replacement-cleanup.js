"use strict";

const { randomUUID } = require("node:crypto");
const { DeleteObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } = require("@aws-sdk/client-s3");
const { createAwsRoleCredentialProvider } = require("./aws-workload-credentials");
const { sourceMediaRenditionId } = require("./source-media-rendition");
const { REPLACEMENTS } = require("./source-video-replacement");
const { contentRows } = require("./source-video-replacement-publication");
const { publicCopies, scheduledVideoAssetIds } = require("./public-video-references");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const { budgetRefs } = require("./video-transcript-paid-budget");

const LEASE_MS = 15 * 60_000;
const DEFERRAL_MS = 15 * 60_000;
const keyMatches = (job, binary) => job.sourceObjectKey === binary.objectKey && job.sourceObjectVersionId === binary.objectVersionId;
const identityMatches = (job, binary) => job.identity?.originalKey === binary.objectKey && job.identity?.originalVersion === binary.objectVersionId;
const pointsTo = (value, binary) => value?.objectKey === binary.objectKey && value?.objectVersionId === binary.objectVersionId;
const unresolvedWriter = job => (job.phase ?? job.state) === "needs_reconciliation" ||
  job.active === false && ["starting", "running"].includes(job.phase ?? job.state);
// A receipt only proves that one attempt stopped. It must name this job and the
// attempt the job still records, so an older or partial receipt stays unresolved.
const settledLocalFailure = row => {
  const job = row.data(), receipt = job.cleanupWriterSettlement;
  return job.phase === "needs_reconciliation" && job.active === false && job.provider === "local" &&
    receipt?.status === "FAILED" && receipt.provider === "local" && receipt.jobId === row.id && Boolean(receipt.at) &&
    Boolean(job.localAttemptId) && receipt.attemptId === job.localAttemptId &&
    Boolean(job.workerId) && receipt.workerId === job.workerId;
};

async function relatedRows(tx, db, version) {
  const { assetId, binary } = version;
  const query = (collection, field) => tx.get(db.collection(collection).where(field, "==", assetId));
  const [previews, transcripts, preparations, videos, audio, uploads] = await Promise.all([
    query("mediaSourcePreviewJobs", "assetId"), query("mediaSourceTranscriptJobs", "assetId"),
    query("mediaTranscriptAudioPreparations", "identity.assetId"), query("mediaPrivateVideoCopies", "identity.assetId"),
    query("mediaPrivateAudioCopies", "assetId"), query("mediaSourceUploads", "assetId"),
  ]);
  const selectedPreparations = preparations.docs.filter(row => identityMatches(row.data(), binary));
  const preparationIds = new Set(selectedPreparations.map(row => row.id));
  const selectedTranscripts = transcripts.docs.filter(row => keyMatches(row.data(), binary));
  const alignments = await Promise.all(selectedTranscripts.map(row => tx.get(db.collection("mediaSourceTranscriptAlignmentJobs").where("transcriptId", "==", row.id))));
  const uses = await Promise.all(selectedPreparations.map(row => tx.get(db.collection("mediaTranscriptAudioUses").where("receipt.preparationId", "==", row.id))));
  return {
    previews: previews.docs.filter(row => keyMatches(row.data(), binary)),
    transcripts: selectedTranscripts, preparations: selectedPreparations,
    alignments: alignments.flatMap(rows => rows.docs), uses: uses.flatMap(rows => rows.docs),
    privateCopies: [...videos.docs.filter(row => identityMatches(row.data(), binary)),
      ...audio.docs.filter(row => preparationIds.has(row.data().identity?.receipt?.preparationId))],
    uploads: uploads.docs.filter(row => row.data().objectKey === binary.objectKey),
  };
}

/** Claim and freeze the rollback pointer before any destructive provider operation. */
async function claimVideoVersionCleanup({ firestore, queueRef, now = Date.now(), dryRun = false }) {
  return firestore.runTransaction(async tx => {
    const request = (await tx.get(queueRef)).data();
    if (!request) return null;
    const deferred = blocked => ({ blocked, assetId: request.assetId, versionId: request.versionId });
    if (request.expiresAt > now || request.nextAttemptAt > now) return null;
    const defer = blocked => {
      // A refusal never authorizes deletion. Recheck authoritative state after
      // the fixed delay, including any protection that appeared in the meantime.
      const nextAttemptAt = now + DEFERRAL_MS;
      if (!dryRun) tx.update(queueRef, { expiresAt: nextAttemptAt, nextAttemptAt, blocked });
      return deferred(blocked);
    };
    const ref = firestore.collection(REPLACEMENTS).doc(request.assetId);
    const versionRef = ref.collection("versions").doc(request.versionId);
    const versionRow = await tx.get(versionRef);
    const [replacementRow, publicRow, owners] = await Promise.all([
      tx.get(ref), tx.get(firestore.doc(`cmsPublicVideos/${request.assetId}`)),
      tx.get(firestore.collection("mediaSourceAssets").where("objectKey", "==", versionRow.data()?.binary?.objectKey ?? "")),
    ]);
    const version = versionRow.data(), replacement = replacementRow.data(), publicRecord = publicRow.data();
    if (!version || version.state === "restored") { if (!dryRun) tx.delete(queueRef); return null; }
    if (version.state === "restoring" || replacement?.rollbackPreviousId === request.versionId || version.leaseUntil > now ||
        owners.docs.some(row => row.data().lifecycle === "active" && pointsTo(row.data(), version.binary)) ||
        ["uploading", "processing", "ready", "promoting"].includes(replacement?.state) && pointsTo(replacement.candidate, version.binary)) {
      return defer(version.leaseUntil > now ? "cleanup_lease_active" : "current_file_or_rollback");
    }
    const urls = [version.publicMedia?.url, version.publicMedia?.posterUrl].filter(Boolean);
    const related = await relatedRows(tx, firestore, version);
    // A stale worker cannot recreate bytes after this deletion. Its existing owner
    // releases admission/leases through the ordinary stale-job path first.
    const writers = [...related.previews, ...related.transcripts, ...related.alignments, ...related.privateCopies, ...related.preparations];
    const unsettledTranscript = related.transcripts.some(row => {
      const job = row.data();
      return ["stale", "cancelled"].includes(job.phase) &&
        (job.startIntentAt || job.submissionIntentAt) && job.audioProviderTerminal !== true;
    });
    const settled = new Set(related.transcripts.filter(settledLocalFailure));
    const repairRequired = unsettledTranscript || writers.some(row => !settled.has(row) && unresolvedWriter(row.data()));
    const writing = repairRequired || writers
      .some(row => {
        const job = row.data(), phase = job.phase ?? job.state;
        const finished = ["ready", "complete", "failed", "rejected", "unavailable"].includes(phase);
        return job.active || job.audioReadLeaseUntil > now || Object.values(job.exportWriteLeases ?? {}).some(until => until > now) || !finished && job.leaseUntil > now ||
          !settled.has(row) && ["starting", "running", "needs_reconciliation"].includes(phase);
      });
    if (writing || urls.length > 0 && publicRecord?.operation?.expiresAt > now) {
      return defer(repairRequired ? "writer_reconciliation_required" : "writer_or_public_copy");
    }
    const blocked = (await contentRows(firestore, tx)).some(row => {
      const content = row.data();
      return publicCopies(content).some(copy => urls.includes(copy.url)) ||
        scheduledVideoAssetIds(content).includes(request.assetId) && urls.includes(publicRecord?.media?.url);
    });
    if (blocked) return defer("published_reference");
    if (dryRun) return { wouldDelete: true, assetId: request.assetId, versionId: request.versionId };
    const leaseOwner = randomUUID();
    tx.update(versionRef, { state: "deleting", leaseOwner, leaseUntil: now + LEASE_MS });
    for (const row of related.preparations) tx.update(row.ref, { state: "deleting" });
    for (const row of related.uses) tx.update(row.ref, { state: "deleting" });
    const operation = { id: leaseOwner, kind: "withdraw", urls, expiresAt: now + LEASE_MS };
    if (urls.length) tx.set(publicRow.ref, { ...publicRecord, operation,
      ...(urls.includes(publicRecord?.media?.url) ? { revoked: true } : {}) });
    // Cleanup and rollback read the same version document; once deleting, it can
    // never be selected for a rollback or promoted into the current file.
    return { ...version, assetId: request.assetId, versionId: request.versionId, versionRef, queueRef,
      leaseOwner, publicRef: urls.length ? publicRow.ref : null, related };
  });
}

function createVideoVersionStorage(config, { s3, replica, readSource, privateStorage, publicStorage, purge } = {}) {
  const credentials = createAwsRoleCredentialProvider({ ...config, roleArn: config.cleanupRoleArn });
  s3 ??= new S3Client({ region: config.region, credentials });
  replica ??= new S3Client({ region: config.replicaRegion, credentials });
  readSource ??= new S3Client({ region: config.region, credentials: createAwsRoleCredentialProvider({ ...config, roleArn: config.source.roleArn }) });
  async function removePrefix(client, bucket, prefix) {
    if (!bucket || !prefix || prefix.startsWith("/")) throw Error("video_cleanup_scope_invalid");
    let markers = {}, page;
    do {
      page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix,
        ExpectedBucketOwner: config.renditionExpectedBucketOwner, ...markers }));
      for (const object of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
        if (!object.Key?.startsWith(prefix) || !object.VersionId) throw Error("video_cleanup_inventory_invalid");
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key, VersionId: object.VersionId,
          ExpectedBucketOwner: config.renditionExpectedBucketOwner }));
      }
      if (!page.IsTruncated) break;
      if (!page.NextKeyMarker || page.NextKeyMarker === markers.KeyMarker && page.NextVersionIdMarker === markers.VersionIdMarker) throw Error("video_cleanup_inventory_incomplete");
      markers = { KeyMarker: page.NextKeyMarker, VersionIdMarker: page.NextVersionIdMarker };
    } while (page.IsTruncated);
  }
  return async function remove(version) {
    const asset = { id: version.assetId, sourceId: "video-library", ...version.binary };
    if (!asset.objectKey || !asset.objectVersionId || !config.cleanupRoleArn || !config.replicaBucket) throw Error("video_cleanup_configuration_missing");
    // A still-running replication could recreate the replica after its delete.
    // Read with the existing read role; the cleanup role remains delete-only.
    try {
      const head = await readSource.send(new HeadObjectCommand({ Bucket: config.source.bucket, Key: asset.objectKey,
        VersionId: asset.objectVersionId, ExpectedBucketOwner: config.renditionExpectedBucketOwner }));
      if (head.ReplicationStatus === "PENDING") throw Error("video_cleanup_replication_pending");
    } catch (error) {
      if (!["NoSuchKey", "NoSuchVersion", "NotFound"].includes(error.name) && error?.$metadata?.httpStatusCode !== 404) throw error;
    }
    const prefixes = [`outputs/${sourceMediaRenditionId(asset)}/`, `staging/${sourceMediaRenditionId(asset)}/`];
    for (const row of version.related.transcripts) {
      prefixes.push(`transcripts/results/${row.id}.`, `transcripts/inputs/${row.id}/`, `transcripts/inputs/amazon/${row.id}/`);
    }
    for (const row of version.related.preparations) prefixes.push(`transcripts/inputs/audio/${row.id}/`);
    for (const prefix of prefixes) await removePrefix(s3, config.renditionBucket, prefix);
    for (const row of version.related.privateCopies) {
      const storage = privateStorage();
      await require("./private-video-transfer").createPrivateVideoTransfer({ r2: storage.client, bucket: storage.bucket, config }).remove(row.data());
    }
    const urls = [version.publicMedia?.url, version.publicMedia?.posterUrl].filter(Boolean);
    if (urls.length) {
      const storage = publicStorage();
      for (const url of urls) {
        const parsed = new URL(url);
        const key = parsed.pathname.slice(1);
        if (parsed.origin !== (config.publicOrigin ?? "https://media.njpbs.org") || !key.startsWith(`cms-media/video/${version.assetId}/`)) throw Error("video_cleanup_public_scope_invalid");
        await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
      }
      await purge(urls);
    }
    // A version-specific source delete is permanent and does not propagate to
    // the replica. S3 replicas retain the original version ID; remove both.
    const exact = { Key: asset.objectKey, VersionId: asset.objectVersionId, ExpectedBucketOwner: config.renditionExpectedBucketOwner };
    await replica.send(new DeleteObjectCommand({ ...exact, Bucket: config.replicaBucket }));
    await s3.send(new DeleteObjectCommand({ ...exact, Bucket: config.source.bucket }));
  };
}

async function cleanupVideoVersion({ firestore, queueRef, remove, now = Date.now(), log, dryRun = false }) {
  let version;
  try { version = await claimVideoVersionCleanup({ firestore, queueRef, now, dryRun }); }
  catch {
    // The failed claim committed no deletion authority. Defer in a fresh
    // transaction so a failed reference scan cannot consume every minute tick.
    version = await firestore.runTransaction(async tx => {
      const request = (await tx.get(queueRef)).data();
      if (!request || request.expiresAt > now || request.nextAttemptAt > now) return null;
      const blocked = "cleanup_claim_failed", nextAttemptAt = now + DEFERRAL_MS;
      if (!dryRun) tx.update(queueRef, { expiresAt: nextAttemptAt, nextAttemptAt, blocked });
      return { blocked, assetId: request.assetId, versionId: request.versionId };
    });
  }
  if (!version) return;
  if (version.blocked) { log?.warn?.("Video version cleanup deferred", version); return version; }
  if (version.wouldDelete) { log?.info?.("Video version cleanup dry run", version); return version; }
  try {
    await remove(version);
    const related = Object.values(version.related).flat();
    const transcriptPaths = new Set(version.related.transcripts.map(row => row.ref.path));
    // Keep the deletion lease and rollback exclusion until every object and worker
    // receipt is gone. Retrying any partial deletion is safe.
    // A transcript can add one slot write; 200 rows stay below the write limit.
    for (let offset = 0; offset < related.length; offset += 200) {
      const rows = related.slice(offset, offset + 200);
      const transcriptIds = new Set(rows.filter(row => transcriptPaths.has(row.ref.path)).map(row => row.id));
      const requesters = new Set(rows.filter(row => transcriptPaths.has(row.ref.path)).map(row => row.data().requestedBy).filter(Boolean));
      await firestore.runTransaction(async tx => {
        const slots = await Promise.all([...requesters].map(uid => tx.get(budgetRefs(firestore, uid, new Date(now).toISOString().slice(0, 10)).slot)));
        for (const row of rows) tx.delete(row.ref);
        for (const slot of slots) if (transcriptIds.has(slot.data()?.jobId)) tx.set(slot.ref, { jobId: null });
      });
    }
    await firestore.runTransaction(async tx => {
      const current = (await tx.get(version.versionRef)).data();
      const publicRecord = version.publicRef ? (await tx.get(version.publicRef)).data() : null;
      const ref = firestore.collection(REPLACEMENTS).doc(version.assetId), record = (await tx.get(ref)).data();
      if (current?.leaseOwner !== version.leaseOwner) throw Error("video_cleanup_lease_changed");
      tx.delete(version.versionRef); tx.delete(queueRef);
      if (record?.previousId === version.versionId) tx.update(ref, { previousId: null });
      if (publicRecord?.operation?.id === version.leaseOwner) {
        const next = { ...publicRecord }; delete next.operation;
        tx.set(version.publicRef, next);
      }
      tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: "system:video-replacement-cleanup",
        action: "media.video.version.delete", target: `mediaSourceAssets/${version.assetId}`,
        after: { versionId: version.versionId, deletedAt: new Date(now).toISOString() } }));
    });
    return { deleted: true, assetId: version.assetId, versionId: version.versionId };
  } catch (error) {
    // Deleting still excludes rollback and retains its storage lease. The
    // public slot must not block unrelated publication between provider retries.
    if (version.publicRef) {
      try {
        await firestore.runTransaction(async tx => {
          const current = (await tx.get(version.publicRef)).data();
          if (current?.operation?.id !== version.leaseOwner) return;
          const next = { ...current }; delete next.operation;
          tx.set(version.publicRef, next);
        });
      } catch {
        log?.warn?.("Video cleanup public slot release failed", {
          assetId: version.assetId, versionId: version.versionId, code: "public_cleanup_release_failed" });
      }
    }
    throw error;
  }
}

module.exports = { createVideoVersionStorage, claimVideoVersionCleanup, cleanupVideoVersion };
