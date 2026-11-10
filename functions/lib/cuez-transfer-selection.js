"use strict";

const { createHash } = require("node:crypto");
const { parseExportRequest, transferError, SAFE_ERROR_CODES } = require("./cuez-transfer-contract");
const { ID_PATTERN, parseSourceMediaAsset, sourceMediaFileVersion } = require("./source-media-contract");
const { authorizeMediaSource, objectKeyWithinSource } = require("./media-sources");
const { clipIdentity, sameClipSource, clipSummary, jobScope, jobFormat, CLIP_JOBS } = require("./video-clip-contract");
const { getTranscriptJob, assertTranscriptRevision, assertSameTranscriptOutputs } = require("./video-transcript-job");
const { selectedTranscriptOutputs } = require("./video-transcript-processor");
const { mediaAssetSummary } = require("./media-library");
const { mediaReplacementRef } = require("./media-replacement");
const { mayUseMedia, isAudioReadAdmitted } = require("./media-access");
const { registeredPrincipalFromUserDoc } = require("./principal");
const { hasCapability } = require("./rbac");
const { authorizeContentWrite, contentResource } = require("./content-authorization");

function documentRevision(snapshot) {
  const time = snapshot?.updateTime;
  if (!time || !Number.isSafeInteger(time.seconds) || !Number.isInteger(time.nanoseconds)) {
    throw transferError("selection_changed");
  }
  return `${time.seconds}:${time.nanoseconds}`;
}

function requireSelected(snapshot, expectedUpdateTime, expectedVersion) {
  if (!snapshot.exists || documentRevision(snapshot) !== expectedUpdateTime ||
      (expectedVersion !== undefined && snapshot.data()?.version !== expectedVersion)) {
    throw transferError("selection_changed");
  }
  return snapshot.data();
}

function privateKey(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || !value.isWellFormed() ||
      value.trim() !== value || value.includes("://") || /\p{Cc}/u.test(value)) {
    throw transferError("output_unavailable");
  }
  return value;
}

function originMarker(value) {
  if (value == null) return null;
  if (!value || !["boardwalk", "external"].includes(value.system) ||
      !/^[a-f0-9]{64}$/.test(value.operationId ?? "") ||
      (value.mappingId != null && !/^[a-f0-9]{64}$/.test(value.mappingId))) {
    throw transferError("invalid_request");
  }
  return { system: value.system, operationId: value.operationId, mappingId: value.mappingId ?? null };
}

async function readActor(firestore, tx, uid) {
  if (typeof uid !== "string" || !ID_PATTERN.test(uid)) throw transferError("not_authorized");
  const user = (await tx.get(firestore.collection("users").doc(uid))).data();
  if (!user || user.active === false) throw transferError("not_authorized");
  return { uid, email: typeof user.email === "string" ? user.email : null,
    approvedActive: true, emailVerified: user.emailVerified === true,
    principal: await registeredPrincipalFromUserDoc(firestore, uid, user, tx) };
}

function recordIdentity(snapshot, version) {
  return { collection: snapshot.ref.parent.id, recordId: snapshot.id, updateTime: documentRevision(snapshot),
    ...(version === undefined ? {} : { version }) };
}

async function resolveVideo({ firestore, tx, selection: s, actor, source, now, renditionBucket }) {
  await authorizeMediaSource({ firestore, actor, source, operation: "browse", isApprovedActiveAccountFn: async () => true });
  const snapshot = await tx.get(firestore.collection("mediaSourceAssets").doc(s.assetId));
  const stored = requireSelected(snapshot, s.expectedUpdateTime, s.expectedVersion);
  const asset = parseSourceMediaAsset(snapshot.id, stored);
  if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey) ||
      sourceMediaFileVersion(asset.objectVersionId) !== s.fileVersion) throw transferError("selection_changed");
  const resolved = { record: recordIdentity(snapshot, asset.version),
    original: { bucket: source.bucket, objectKey: privateKey(asset.objectKey),
      objectVersionId: privateKey(asset.objectVersionId), sizeBytes: asset.sizeBytes } };
  if (s.kind === "video" && asset.rendition?.state !== "ready") throw transferError("output_unavailable");
  if (s.kind === "clip") {
    const jobSnapshot = await tx.get(firestore.collection(CLIP_JOBS).doc(s.clipId));
    const job = requireSelected(jobSnapshot, s.expectedJobUpdateTime);
    if (job.id !== s.clipId || clipIdentity(job) !== job.id || !sameClipSource(asset, job)) {
      throw transferError("selection_changed");
    }
    if (jobScope(job) !== "clip" || jobFormat(job) !== "web_mp4" ||
        clipSummary(job, now).state !== "ready" || !Number.isFinite(Date.parse(job.expiresAt))) {
      throw transferError("output_unavailable");
    }
    const output = { attemptId: job.attemptId, objectKey: job.output?.objectKey,
      objectVersionId: job.output?.objectVersionId, sizeBytes: job.output?.sizeBytes };
    if (Object.keys(output).some(field => output[field] !== s.expectedClipOutput[field]) ||
        !privateKey(output.objectKey).startsWith(`outputs/clips/${job.id}/${job.attemptId}/`) ||
        !privateKey(output.objectVersionId)) {
      throw transferError("selection_changed");
    }
    resolved.clip = { jobId: job.id, updateTime: documentRevision(jobSnapshot), ...output,
      inMs: job.inMs, outMs: job.outMs, durationSeconds: job.output.durationSeconds, expiresAt: job.expiresAt };
  }
  if (s.kind === "transcript") {
    const transcriptJob = await getTranscriptJob({ firestore, source,
      request: { sourceId: s.sourceId, assetId: s.assetId, transcriptId: s.transcriptId }, renditionBucket });
    if (!transcriptJob) throw transferError("output_unavailable");
    const jobSnapshot = await tx.get(firestore.collection("mediaSourceTranscriptJobs").doc(transcriptJob.id));
    const job = requireSelected(jobSnapshot, s.expectedJobUpdateTime);
    // The owner's independent read validates provider variants; both reads must agree.
    if (JSON.stringify(job) !== JSON.stringify(transcriptJob)) throw transferError("selection_changed");
    assertTranscriptRevision(job, s.expectedEditRevision, transcriptJob.id);
    assertSameTranscriptOutputs(job, transcriptJob);
    const selected = selectedTranscriptOutputs(job);
    if (!selected.outputs["segments.json"] || !selected.outputs.txt) throw transferError("output_unavailable");
    resolved.transcript = { jobId: job.id, updateTime: documentRevision(jobSnapshot), editRevision: s.expectedEditRevision,
      segments: { objectKey: privateKey(selected.key("segments.json")), objectVersionId: privateKey(selected.outputs["segments.json"]) },
      text: { objectKey: privateKey(selected.key("txt")), objectVersionId: privateKey(selected.outputs.txt) } };
  }
  return { resolved, origin: originMarker(stored.cuezOrigin) };
}

async function resolveImage({ firestore, tx, selection: s, actor }) {
  const snapshot = await tx.get(firestore.collection("media_assets").doc(s.assetId));
  const stored = requireSelected(snapshot, s.expectedUpdateTime, s.expectedVersion);
  const summary = mediaAssetSummary(snapshot.id, stored);
  if (!summary || summary.kind !== "image") throw transferError("output_unavailable");
  if (!mayUseMedia(actor.principal, summary.category, "image", isAudioReadAdmitted(actor))) throw transferError("not_authorized");
  if ((await tx.get(mediaReplacementRef(firestore, s.assetId))).exists) throw transferError("selection_changed");
  return { resolved: { record: recordIdentity(snapshot, summary.version), image: {
    storageKey: privateKey(stored.storageKey), sizeBytes: summary.sizeBytes, mimeType: summary.mimeType,
  } }, origin: originMarker(stored.cuezOrigin) };
}

function validateAroundNj(stored, recordId, now) {
  // #2295 defines this schema; its ingestion owner is absent from this base.
  let url;
  try { url = new URL(stored.canonicalUrl); } catch { throw transferError("output_unavailable"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      !stored.headline || typeof stored.headline !== "string" || stored.headline.length > 250 ||
      !stored.outlet || typeof stored.outlet !== "string" || stored.outlet.length > 120 ||
      typeof stored.partner !== "boolean" ||
      createHash("sha256").update(stored.canonicalUrl).digest("hex") !== recordId ||
      !Number.isFinite(Date.parse(stored.lastSeenAt)) || Date.parse(stored.lastSeenAt) > now ||
      Date.parse(stored.lastSeenAt) < now - 180 * 86400000) throw transferError("output_unavailable");
}

async function resolveEditorial({ firestore, tx, selection: s, actor, now }) {
  const collection = s.kind === "post" ? "cmsPosts" : "aroundNjStories";
  const snapshot = await tx.get(firestore.collection(collection).doc(s.recordId));
  const stored = requireSelected(snapshot, s.expectedUpdateTime, s.expectedVersion);
  if (s.kind === "post") {
    const resource = contentResource({ collection, documentId: s.recordId, stored });
    if (!authorizeContentWrite(actor.principal, { creating: false, publishing: false,
      storedStatus: stored.status, nextStatus: stored.status, resource }).allowed) throw transferError("not_authorized");
    if (stored.deleted === true || stored.status === "archived") throw transferError("output_unavailable");
  } else {
    if (!hasCapability(actor.principal, "guide.view")) throw transferError("not_authorized");
    validateAroundNj(stored, s.recordId, now);
  }
  return { resolved: { record: recordIdentity(snapshot, s.expectedVersion) }, origin: originMarker(stored.cuezOrigin) };
}

async function prepareExportSelection({ firestore, request, actorUid, newsdeskId, registry = new Map(),
  renditionBucket, now = Date.now() }) {
  const selectionSnapshot = parseExportRequest(request);
  if (!newsdeskId || selectionSnapshot.workspaceId !== newsdeskId) throw transferError("not_configured");
  const s = selectionSnapshot.selection;
  const source = registry.get(s.sourceId);
  if (["video", "clip", "transcript"].includes(s.kind) && !source) throw transferError("not_configured");
  try {
    return await firestore.runTransaction(async tx => {
      const actor = await readActor(firestore, tx, actorUid);
      const context = { firestore, tx, selection: s, actor, source, now, renditionBucket };
      let result;
      if (["video", "clip", "transcript"].includes(s.kind)) result = await resolveVideo(context);
      else if (s.kind === "image") result = await resolveImage(context);
      else result = await resolveEditorial(context);
      // The owner may resolve a paid-fallback parent to its selected child.
      const snapshot = s.kind === "transcript" ? { ...selectionSnapshot,
        selection: { ...s, transcriptId: result.resolved.transcript.jobId } } : selectionSnapshot;
      return { direction: "export", selectionSnapshot: snapshot, resolvedSelection: result.resolved,
        initiatedBy: actor.uid, origin: result.origin };
    });
  } catch (error) {
    if (SAFE_ERROR_CODES.includes(error?.code)) throw transferError(error.code);
    if (error?.status === 403) throw transferError("not_authorized");
    if ([400, 404, 409].includes(error?.status)) throw transferError("selection_changed");
    throw transferError("transient_failure");
  }
}

module.exports = { prepareExportSelection, documentRevision, originMarker, readActor };
