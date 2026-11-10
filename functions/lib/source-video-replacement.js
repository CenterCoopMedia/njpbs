"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { randomUUID } = require("node:crypto");
const { can } = require("./rbac");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const { SourceMediaValidationError, parseSourceMediaAsset, sourceMediaAssetDetail, sourceMediaFileVersion } = require("./source-media-contract");
const { enqueueVideoSearchShard } = require("./video-search-outbox");
const { REQUEST_COLLECTION } = require("./public-video-withdrawal");

const REPLACEMENTS = "mediaSourceReplacements";
const PURGE_QUEUE = "mediaSourceVideoPurgeQueue";
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const BUSY_STATES = ["uploading", "processing", "ready", "promoting"];
const BINARY_FIELDS = ["originalName", "mimeType", "sizeBytes", "checksumSha256", "preview", "objectKey", "objectVersionId", "rendition"];
const replacementRef = (db, id) => db.collection(REPLACEMENTS).doc(id);
const replacementBusy = (record, now) => BUSY_STATES.includes(record?.state) &&
  (record.state !== "uploading" || !(Date.parse(record.expiresAt) <= now));
function refuse(message, status = 409) { throw new SourceMediaValidationError(message, status); }
function binary(asset) {
  return Object.fromEntries(BINARY_FIELDS.map(field => [field, asset[field] ?? null]));
}
function sameBinary(left, right) {
  return left?.objectKey === right?.objectKey && left?.objectVersionId === right?.objectVersionId && left?.sizeBytes === right?.sizeBytes;
}
function requireReplacePermission(actor, source) {
  if (source.id !== "video-library" || !source.writable || !can(actor.principal, "media.video.manage", {})) {
    refuse("You do not have permission to replace video files", 403);
  }
}
// A binary replacement also republishes every live/scheduled use of this stable ID.
// Include these reads in the write transaction so admission and promotion use the
// same scoped content policy as the ordinary publication endpoint.
async function requirePublicationPermission({ firestore, transaction, actor, assetId, publicRecord }) {
  const { publicCopies, scheduledVideoAssetIds } = require("./public-video-references");
  const { contentResource } = require("./content-authorization");
  const rows = await require("./source-video-replacement-publication").contentRows(firestore, transaction);
  let affected = false;
  for (const row of rows) {
    const stored = row.data();
    const live = publicCopies(stored).some(copy => copy.assetId === assetId);
    if (!live && !scheduledVideoAssetIds(stored).includes(assetId)) continue;
    affected = true;
    const resources = [stored, ...(live ? [{ ...stored, ...stored.published?.metadata }] : [])];
    if (resources.some(content => !can(actor.principal, "content.publish", contentResource({
      collection: row.ref.parent.id, documentId: row.id, stored: content })))) {
      refuse("You do not have permission to publish every use of this video", 403);
    }
  }
  if (!affected && publicRecord?.media && !publicRecord.revoked && !can(actor.principal, "content.publish", {})) {
    refuse("You do not have permission to publish this video", 403);
  }
}
function replacementSummary(record) {
  return { state: record.state, requestedAt: record.requestedAt, requestedBy: record.actor.name,
    ...(record.errorCode ? { errorCode: record.errorCode } : {}) };
}

/** Called in the upload-session transaction: one pending binary per stable asset ID. */
async function reserveReplacement({ firestore, transaction, session, actor, source, now }) {
  requireReplacePermission(actor, source);
  const ref = replacementRef(firestore, session.assetId);
  const assetRef = firestore.collection("mediaSourceAssets").doc(session.assetId);
  const [row, pending] = await transaction.getAll(assetRef, ref);
  const asset = row.exists ? parseSourceMediaAsset(row.id, row.data()) : null;
  if (!asset || asset.sourceId !== source.id) refuse("Media asset not found", 404);
  if (asset.version !== session.replacement.expectedVersion) refuse("Media asset changed; reload it and confirm the replacement again");
  const publicRecord = (await transaction.get(firestore.doc(`cmsPublicVideos/${asset.id}`))).data();
  await requirePublicationPermission({ firestore, transaction, actor, assetId: asset.id, publicRecord });
  const existing = pending.data();
  if (existing?.migrationPending && existing.migrationError) {
    refuse("Published players could not all be updated. Restore the previous file, or ask an administrator to repair the published content before replacing again.");
  }
  if (existing?.migrationPending || replacementBusy(existing, Date.parse(now))) {
    refuse("A replacement is already in progress for this video");
  }
  const record = { assetId: asset.id, sourceId: source.id, sessionId: session.id, state: "uploading",
    base: binary(asset), actor: { uid: actor.uid, email: actor.email ?? null, name: actor.displayName || "Staff member" },
    requestedAt: now, expiresAt: session.expiresAt, previousId: existing?.previousId ?? null,
    transcriptPending: Boolean(existing?.transcriptPending), transcriptError: existing?.transcriptError ?? null,
    promotedAt: existing?.promotedAt ?? null, lastAction: existing?.lastAction ?? null };
  transaction.set(ref, record);
  transaction.update(assetRef, { replacement: replacementSummary(record) });
}

async function cancelReplacement({ firestore, session }) {
  if (!session.replacement) return;
  await firestore.runTransaction(async tx => {
    const ref = replacementRef(firestore, session.assetId);
    const current = (await tx.get(ref)).data();
    const assetRef = firestore.collection("mediaSourceAssets").doc(session.assetId);
    const asset = (await tx.get(assetRef)).data();
    if (current?.sessionId !== session.id || current.state !== "uploading") return;
    tx.update(ref, { state: "canceled" });
    if (asset) tx.update(assetRef, { replacement: FieldValue.delete() });
  });
}

async function storeReplacementCandidate({ firestore, session, candidate, actor, audit = adminLogEntry }) {
  const { pendingPreview, PREVIEW_JOBS, renditionState } = require("./video-preview-job");
  const summary = await firestore.runTransaction(async tx => {
    const ref = replacementRef(firestore, session.assetId);
    const assetRef = firestore.collection("mediaSourceAssets").doc(session.assetId);
    const sessionRef = firestore.collection("mediaSourceUploads").doc(session.id);
    const failedId = `failed-${session.id}`;
    const failedRef = ref.collection("versions").doc(failedId);
    const [row, assetRow, sessionRow, holdRow, failedRow] = await tx.getAll(ref, assetRef, sessionRef,
      firestore.collection(PREVIEW_JOBS).doc(`hold-${session.id}`), failedRef);
    const record = row.data(), asset = assetRow.data(), current = sessionRow.data();
    // A concurrent retry may reach this transaction after the first acceptance
    // or refusal. It must not queue an accepted candidate or rewrite purge leases.
    if (current?.status === "completed") {
      const parsed = parseSourceMediaAsset(assetRow.id, asset);
      return parsed ? sourceMediaAssetDetail(parsed) : null;
    }
    if (current?.status === "canceled") return null;
    if (record?.sessionId !== session.id || record.state !== "uploading" || !asset || asset.lifecycle !== "active" ||
        !sameBinary(asset, record.base) || current?.status !== "completing" || !holdRow.data()?.active) {
      const now = Date.now();
      if (holdRow.data()?.active) tx.update(holdRow.ref, { active: false, phase: "released" });
      if (current) tx.update(sessionRef, { status: "canceled", version: current.version + 1, canceledAt: new Date(now).toISOString() });
      if (!failedRow.exists) {
        tx.set(failedRef, { assetId: session.assetId, sourceId: session.sourceId, binary: binary(candidate),
          state: "superseded", expiresAt: now, publicMedia: null });
        tx.set(firestore.collection(PURGE_QUEUE).doc(`${session.assetId}-${failedId}`), {
          assetId: session.assetId, versionId: failedId, expiresAt: now });
      }
      if (record?.sessionId === session.id && record.state === "uploading") {
        tx.update(ref, { state: "failed", errorCode: "replacement_video_changed" });
        if (asset?.lifecycle === "active") tx.update(assetRef, { "replacement.state": "failed", "replacement.errorCode": "replacement_video_changed" });
      }
      return null;
    }
    const job = { ...pendingPreview(candidate), actorUid: actor.uid, replacementSessionId: session.id };
    // Firestore may invoke this callback again; keep the source identity input
    // intact for the next attempt and persist only its binary fields.
    const storedCandidate = { ...binary(candidate), rendition: renditionState(job, "processing") };
    const next = { ...record, state: "processing", candidate: storedCandidate, jobId: job.id };
    tx.create(firestore.collection(PREVIEW_JOBS).doc(job.id), job);
    tx.update(holdRow.ref, { active: false, phase: "consumed" });
    tx.update(ref, next);
    tx.update(assetRef, { replacement: replacementSummary(next) });
    tx.update(sessionRef, { status: "completed", version: current.version + 1, completedAt: new Date().toISOString() });
    const event = { action: "replace.request", at: record.requestedAt, by: record.actor.name,
      originalName: storedCandidate.originalName };
    tx.create(ref.collection("history").doc(session.id), event);
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({ actorUid: actor.uid,
      actorEmail: actor.email ?? null, action: "media.video.replace.request", target: assetRef.path,
      before: binary(asset), after: { sessionId: session.id, originalName: storedCandidate.originalName } }));
    return sourceMediaAssetDetail(parseSourceMediaAsset(assetRow.id, { ...asset, replacement: replacementSummary(next) }));
  });
  // Throw only after the cleanup/terminal state commits. Throwing inside the
  // transaction would roll those writes back and leak the preview quota hold.
  if (!summary) refuse("Replacement upload is no longer active. Reload the video to start again.", 410);
  return summary;
}

/** Processing reads the isolated candidate; every existing reader still sees the old asset. */
async function previewReplacementTarget(tx, db, job, rendition, changes) {
  const assetRef = db.collection("mediaSourceAssets").doc(job.assetId);
  const [row, current] = await tx.getAll(replacementRef(db, job.assetId), assetRef);
  const record = row.data(), asset = current.data();
  if (record?.sessionId !== job.replacementSessionId || record.state !== "processing") return null;
  if (asset?.lifecycle !== "active" || !sameBinary(asset, record.base)) {
    // Let an already submitted workflow settle before cleanup can remove its
    // output prefix. A provider can otherwise recreate bytes after deletion.
    if ((job.phase === "running" || changes?.phase === "running") &&
        !["ready", "failed"].includes(rendition?.state)) {
      return { ...record.candidate, id: job.assetId, sourceId: job.sourceId, lifecycle: "active", replacementUnavailable: true };
    }
    const versionId = `failed-${job.id}`, expiresAt = Date.now();
    const ref = replacementRef(db, job.assetId);
    tx.set(ref.collection("versions").doc(versionId), { assetId: job.assetId, sourceId: job.sourceId,
      binary: binary({ ...record.candidate, ...(rendition ? { rendition } : {}) }),
      state: "superseded", expiresAt, publicMedia: null });
    tx.set(db.collection(PURGE_QUEUE).doc(`${job.assetId}-${versionId}`), { assetId: job.assetId, versionId, expiresAt });
    tx.update(ref, { state: "failed", errorCode: "replacement_video_changed", candidate: FieldValue.delete() });
    if (asset?.lifecycle === "active") tx.update(assetRef, {
      "replacement.state": "failed", "replacement.errorCode": "replacement_video_changed" });
    return null;
  }
  return { ...record.candidate, id: job.assetId, sourceId: job.sourceId, lifecycle: "active" };
}
function saveReplacementPreview(tx, db, job, rendition, candidate) {
  const failed = rendition.state === "failed";
  const state = failed ? "failed" : rendition.state === "ready" ? "ready" : "processing";
  tx.update(replacementRef(db, job.assetId), { "candidate.rendition": rendition, state,
    ...(failed ? { errorCode: rendition.errorCode || "processing_failed" } : {}) });
  tx.update(db.collection("mediaSourceAssets").doc(job.assetId), {
    "replacement.state": state, ...(failed ? { "replacement.errorCode": rendition.errorCode || "processing_failed" } : {}) });
  if (failed) {
    const versionId = `failed-${job.id}`;
    tx.set(replacementRef(db, job.assetId).collection("versions").doc(versionId), {
      assetId: job.assetId, sourceId: job.sourceId, binary: binary({ ...candidate, rendition }),
      state: "superseded", expiresAt: Date.now(), publicMedia: null });
    tx.set(db.collection(PURGE_QUEUE).doc(`${job.assetId}-${versionId}`), {
      assetId: job.assetId, versionId, expiresAt: Date.now() });
  }
}

/** Promotion and rollback change binary pointers only. Staff edits and placements stay intact. */
async function promoteReplacement({ firestore, assetId, sessionId, now = Date.now(), publicCopy, previousChecksum }) {
  return firestore.runTransaction(async tx => {
    const ref = replacementRef(firestore, assetId), assetRef = firestore.collection("mediaSourceAssets").doc(assetId);
    const [row, assetRow] = await tx.getAll(ref, assetRef);
    const record = row.data(), asset = assetRow.data();
    if (!record || asset?.lifecycle !== "active") refuse("Media asset not found", 404);
    if (record.sessionId === sessionId && record.state === "complete") return asset;
    const rollback = Boolean(record.rollbackPreviousId);
    const previousRef = record.previousId ? ref.collection("versions").doc(record.previousId) : null;
    const previous = previousRef ? (await tx.get(previousRef)).data() : null;
    if (rollback && (!previous || previous.state !== "restoring" || previousRef.id !== record.rollbackPreviousId)) refuse("The previous file is no longer available for rollback");
    if (record.sessionId !== sessionId || record.state !== "promoting" || !sameBinary(asset, record.base)) refuse("Replacement changed before promotion");
    const publicRef = firestore.doc(`cmsPublicVideos/${assetId}`);
    const publicRow = (await tx.get(publicRef)).data();
    const withdrawalRef = publicCopy?.record ? firestore.collection(REQUEST_COLLECTION).doc(assetId) : null;
    const withdrawal = withdrawalRef ? (await tx.get(withdrawalRef)).data() : null;
    if (publicCopy ? publicRow?.operation?.id !== publicCopy.operationId : publicRow?.operation || publicRow?.media && !publicRow.revoked) {
      refuse("The public video copy changed during replacement");
    }
    const user = (await tx.get(firestore.doc(`users/${record.actor.uid}`))).data();
    const principal = await require("./principal").registeredPrincipalFromUserDoc(firestore, record.actor.uid, user, tx);
    if (!can(principal, "media.video.manage", {})) refuse("You do not have permission to replace video files", 403);
    await requirePublicationPermission({ firestore, transaction: tx, actor: { principal }, assetId, publicRecord: publicRow });
    const target = rollback ? previous.binary : record.candidate;
    previousChecksum ??= asset.checksumSha256 ? { algorithm: "SHA256", value: asset.checksumSha256 } : null;
    const retainedBinary = { ...binary(asset), checksumSha256: asset.checksumSha256 ?? (previousChecksum?.algorithm === "SHA256" ? previousChecksum.value : null) };
    const id = sourceMediaFileVersion(asset.objectVersionId), at = new Date(now).toISOString();
    if (previous && previous.state !== "deleting" && (!rollback || previousRef.id !== id)) {
      tx.update(previousRef, rollback ? { state: "restored" } : { state: "superseded", expiresAt: now });
    }
    if (previous) {
      if (rollback) tx.delete(firestore.collection(PURGE_QUEUE).doc(`${assetId}-${previousRef.id}`));
      else if (previous.state !== "deleting") tx.set(firestore.collection(PURGE_QUEUE).doc(`${assetId}-${previousRef.id}`), { assetId, versionId: previousRef.id, expiresAt: now });
    }
    tx.set(firestore.collection(PURGE_QUEUE).doc(`${assetId}-${id}`), { assetId, versionId: id, expiresAt: now + RETENTION_MS });
    tx.set(ref.collection("versions").doc(id), { binary: retainedBinary, checksum: previousChecksum, assetId, sourceId: asset.sourceId,
      publicMedia: publicCopy?.previous?.media ?? null,
      state: "retained", retainedAt: at, expiresAt: now + RETENTION_MS });
    const updated = { ...asset, ...binary(target), replacement: { state: "complete", requestedAt: at, requestedBy: record.actor.name },
      version: asset.version + 1, updatedAt: at, updatedAtSort: at, updatedBy: record.actor.uid };
    tx.update(assetRef, updated);
    tx.update(ref, { state: "complete", previousId: id, promotedAt: at, lastAction: rollback ? "rollback" : "replace", candidate: FieldValue.delete(),
      migrationPending: Boolean(publicCopy?.record), transcriptPending: !rollback, errorCode: FieldValue.delete(),
      migrationError: FieldValue.delete(), migrationFailedOwners: FieldValue.delete(),
      rollbackPreviousId: FieldValue.delete(), leaseUntil: 0 });
    if (publicCopy?.record) tx.set(publicRef, publicCopy.record);
    else if (publicCopy?.previous) tx.set(publicRef, publicCopy.previous);
    else if (publicCopy) tx.delete(publicRef);
    if (withdrawal) {
      const media = publicCopy.record.media;
      const remaining = withdrawal.urls.filter(url => url !== media.url && url !== media.posterUrl);
      if (remaining.length) tx.set(withdrawalRef, { ...withdrawal, revision: randomUUID(), urls: remaining });
      else tx.delete(withdrawalRef);
    }
    enqueueVideoSearchShard(tx, firestore, assetId, asset.sourceId);
    const action = rollback ? "rollback" : "replace";
    tx.create(ref.collection("history").doc(), { action, at, by: record.actor.name, originalName: target.originalName,
      previousSizeBytes: asset.sizeBytes, previousChecksumSha256: retainedBinary.checksumSha256, previousChecksum });
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({ actorUid: record.actor.uid,
      actorEmail: record.actor.email, action: `media.video.${action}`, target: assetRef.path,
      before: { ...retainedBinary, checksum: previousChecksum }, after: { ...binary(target), previousExpiresAt: new Date(now + RETENTION_MS).toISOString() } }));
    return updated;
  });
}

/** Permanent admission failures release the candidate/rollback without changing live bytes. */
async function failReplacementPromotion({ firestore, ref, sessionId, now, errorCode, publicMedia }) {
  await firestore.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    const assetRef = firestore.doc(`mediaSourceAssets/${ref.id}`), asset = (await tx.get(assetRef)).data();
    if (current?.sessionId !== sessionId || current.state !== "promoting") return;
    const previousRef = current.rollbackPreviousId ? ref.collection("versions").doc(current.rollbackPreviousId) : null;
    const previous = previousRef ? (await tx.get(previousRef)).data() : null;
    if (previous?.state === "restoring") tx.update(previousRef, { state: "retained" });
    if (!current.rollbackPreviousId && current.candidate) {
      const versionId = `failed-${sessionId}`;
      tx.set(ref.collection("versions").doc(versionId), { assetId: ref.id, sourceId: current.sourceId,
        binary: current.candidate, state: "superseded", expiresAt: now, publicMedia: publicMedia ?? null });
      tx.set(firestore.collection(PURGE_QUEUE).doc(`${ref.id}-${versionId}`), { assetId: ref.id, versionId, expiresAt: now });
    }
    // A refused rollback leaves the completed replacement's owner refresh in
    // progress. Keep its retry owner and the existing rollback controls reachable.
    const resumeMigration = Boolean(current.rollbackPreviousId && current.migrationPending);
    const state = resumeMigration ? "complete" : "failed";
    const visibleError = resumeMigration ? current.migrationError ?? "publication_refresh_failed" : errorCode;
    tx.update(ref, { state, errorCode: resumeMigration ? FieldValue.delete() : errorCode,
      ...(resumeMigration ? { migrationError: visibleError } : {}), candidate: FieldValue.delete(),
      rollbackPreviousId: FieldValue.delete(), leaseUntil: 0 });
    if (asset?.lifecycle === "active") tx.update(assetRef, { "replacement.state": state, "replacement.errorCode": visibleError });
  });
}

async function requestVideoRollback({ firestore, actor, source, assetId, expectedVersion, confirmed, now = Date.now(), sessionId }) {
  requireReplacePermission(actor, source);
  if (confirmed !== true) refuse("Confirm the rollback first", 400);
  return firestore.runTransaction(async tx => {
    const ref = replacementRef(firestore, assetId), assetRef = firestore.collection("mediaSourceAssets").doc(assetId);
    const [row, assetRow] = await tx.getAll(ref, assetRef);
    const record = row.data(), asset = assetRow.data();
    if (asset?.lifecycle !== "active" || asset.sourceId !== "video-library") refuse("Media asset not found", 404);
    if (asset.version !== expectedVersion) refuse("Media asset changed; reload it before rolling back");
    if (replacementBusy(record, now) || record?.migrationPending && !record.migrationError) refuse("Wait for the current replacement to finish");
    const previousRef = record?.previousId ? ref.collection("versions").doc(record.previousId) : null;
    const previous = previousRef ? (await tx.get(previousRef)).data() : null;
    if (!previous || previous.state !== "retained" || previous.expiresAt <= now) refuse("The previous file is no longer available for rollback");
    if (previous.binary?.rendition?.state !== "ready") refuse("The previous file has no ready viewing copy and cannot be restored");
    const publicRecord = (await tx.get(firestore.doc(`cmsPublicVideos/${assetId}`))).data();
    await requirePublicationPermission({ firestore, transaction: tx, actor, assetId, publicRecord });
    const next = { ...record, state: "ready", sessionId, candidate: previous.binary, base: binary(asset),
      rollbackPreviousId: previousRef.id, actor: { uid: actor.uid, email: actor.email ?? null, name: actor.displayName || "Staff member" },
      requestedAt: new Date(now).toISOString(), leaseUntil: 0 };
    tx.update(previousRef, { state: "restoring" });
    tx.set(ref, next);
    tx.update(assetRef, { replacement: replacementSummary(next) });
    return sourceMediaAssetDetail(parseSourceMediaAsset(assetId, { ...asset, replacement: replacementSummary(next) }));
  });
}

module.exports = { REPLACEMENTS, PURGE_QUEUE, RETENTION_MS, BUSY_STATES, BINARY_FIELDS, binary, sameBinary, replacementRef,
  requireReplacePermission, requirePublicationPermission, replacementSummary, reserveReplacement, cancelReplacement, storeReplacementCandidate,
  previewReplacementTarget, saveReplacementPreview, promoteReplacement, failReplacementPromotion, requestVideoRollback };
