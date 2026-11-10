"use strict";

const { enqueueVideoSearchShard } = require("./video-search-outbox");

const { createHash, randomUUID } = require("node:crypto");
const { SourceMediaValidationError } = require("./source-media-contract");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const { alignmentRequest, validateAlignmentCompletion } = require("./video-transcript-alignment");
const { sourceMatches, WORKERS, WORKER_ID } = require("./video-transcript-worker");
const { transcriptSegmentsVersion } = require("./video-transcript-processor");

const ALIGNMENT_JOBS = "mediaSourceTranscriptAlignmentJobs";
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const MAX_PASSAGE_SECONDS = 180;
const ADAPTER_REVISION = "qwen3-forced-aligner-adapter-v1";
const MODEL_REPOSITORY = "Qwen/Qwen3-ForcedAligner-0.6B";
const MODEL_REVISION = "c7cbfc2048c462b0d63a45797104fc9db3ad62b7";
const FAILURES = new Set(["alignment_processing_failed", "alignment_model_unavailable", "alignment_input_failed"]);
const STAGES = new Set(["downloading", "aligning", "finalizing"]);
const invalid = (message = "Alignment worker request is invalid", status = 400) => Object.assign(new Error(message), { status });
const slotRef = (firestore) => firestore.collection(WORKERS).doc(WORKER_ID);
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const ENGINE_FIELDS = ["adapterRevision", "modelRepository", "modelRevision", "cacheSha256"];
const PUBLIC_STATES = new Set(["queued", "processing", "partial", "review_required", "ready",
  "unavailable", "needs_reconciliation", "cancelled", "stale"]);

function responseFields(job, transcript) {
  const current = transcript?.alignmentRequestId === job.id && PUBLIC_STATES.has(transcript.alignmentState);
  return {
    state: current ? transcript.alignmentState : job.phase === "running" ? "processing" :
      job.phase === "complete" ? "needs_reconciliation" : job.phase,
    eligibleCount: current && Number.isSafeInteger(transcript.alignmentEligibleCount)
      ? transcript.alignmentEligibleCount : job.eligibleCount,
    unavailableCount: current && Number.isSafeInteger(transcript.alignmentUnavailableCount)
      ? transcript.alignmentUnavailableCount : job.unavailableCount,
    updatedAt: current ? transcript.alignmentUpdatedAt ?? job.updatedAt : job.updatedAt,
  };
}

function alignmentEngine(config) {
  if (config.alignmentModelRepository !== MODEL_REPOSITORY ||
      config.alignmentModelRevision !== MODEL_REVISION) return null;
  const engine = {
    adapterRevision: ADAPTER_REVISION,
    modelRepository: config.alignmentModelRepository,
    modelRevision: config.alignmentModelRevision,
    cacheSha256: config.alignmentCacheSha256,
  };
  if (typeof engine.modelRepository !== "string" || !engine.modelRepository || engine.modelRepository.length > 256 ||
      typeof engine.modelRevision !== "string" || !/^[a-f0-9]{40}$/.test(engine.modelRevision) ||
      typeof engine.cacheSha256 !== "string" || !/^[a-f0-9]{64}$/.test(engine.cacheSha256)) return null;
  return engine;
}

function sameAlignmentEngine(expected, stored) {
  return stored && typeof stored === "object" && !Array.isArray(stored) &&
    Object.keys(stored).length === ENGINE_FIELDS.length &&
    ENGINE_FIELDS.every((field) => stored[field] === expected[field]);
}

function hasAlignedWords(segment) {
  const normalized = (value) => value.trim().replace(/\s+/gu, " ");
  if (!Array.isArray(segment?.words) || !segment.words.length ||
      normalized(segment.words.map((word) => typeof word?.text === "string" ? word.text.trim() : "").join(" ")) !== normalized(segment.text ?? "")) return false;
  let previous = segment.startSeconds;
  return segment.words.every((word) => {
    const valid = typeof word.text === "string" && word.text.trim() &&
      Number.isFinite(word.startSeconds) && Number.isFinite(word.endSeconds) &&
      word.startSeconds >= previous && word.startSeconds >= segment.startSeconds &&
      word.endSeconds > word.startSeconds && word.endSeconds <= segment.endSeconds;
    previous = word.startSeconds;
    return Boolean(valid);
  });
}

function selectedPassages(segments) {
  let missingCount = 0;
  let unavailableCount = 0;
  let eligibleCount = 0;
  const eligible = [];
  for (const [index, segment] of segments.entries()) {
    if (hasAlignedWords(segment)) continue;
    missingCount += 1;
    if (segment?.overlappingSpeech === true || typeof segment?.text !== "string" || !segment.text.trim() ||
        !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) ||
        segment.endSeconds <= segment.startSeconds || segment.endSeconds - segment.startSeconds > MAX_PASSAGE_SECONDS) {
      unavailableCount += 1;
      continue;
    }
    eligibleCount += 1;
    if (eligible.length < 100) eligible.push({ index, text: segment.text,
      startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, overlappingSpeech: false });
  }
  return { passages: eligible, missingCount, unavailableCount,
    deferredCount: eligibleCount - eligible.length };
}

function buildAlignmentSnapshot(job, segments, config) {
  const engine = alignmentEngine(config);
  const versionId = transcriptSegmentsVersion(job, { alignmentWork: true });
  if (!engine || !versionId || !Array.isArray(segments) || segments.length !== job.totalSegments) {
    throw new SourceMediaValidationError("Transcript alignment is unavailable", 503);
  }
  const selection = selectedPassages(segments);
  if (!selection.passages.length) {
    if (selection.missingCount) throw new SourceMediaValidationError("No corrected passages can be aligned automatically", 409);
    throw new SourceMediaValidationError("This transcript already has word timing", 409);
  }
  const snapshot = {
    source: { sourceId: job.sourceId, assetId: job.assetId, bucket: job.sourceBucket,
      objectKey: job.sourceObjectKey, objectVersionId: job.sourceObjectVersionId, sizeBytes: job.sourceSizeBytes },
    input: { bucket: config.bucket, objectKey: job.input.objectKey, objectVersionId: job.input.objectVersionId,
      sizeBytes: job.input.sizeBytes, durationSeconds: job.durationSeconds },
    transcript: { id: job.id, editRevision: job.editRevision ?? 0,
      languageCode: job.languageCode, segmentsVersionId: versionId },
    engine,
    passages: selection.passages,
  };
  return { snapshot, request: alignmentRequest(snapshot), ...selection };
}

function parseAlignmentRequest(value, { cancel = false } = {}) {
  const allowed = new Set(["sourceId", "assetId", "transcriptId", "revision", ...(cancel ? ["requestId"] : ["retry"])]);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key)) ||
      value.sourceId !== "video-library" || typeof value.assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.assetId) ||
      typeof value.transcriptId !== "string" || !/^[a-f0-9]{64}$/.test(value.transcriptId) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER ||
      (cancel ? typeof value.requestId !== "string" || !/^[a-f0-9]{64}$/.test(value.requestId)
        : value.retry !== undefined && value.retry !== true)) {
    throw new SourceMediaValidationError("Transcript alignment request is invalid");
  }
  return { sourceId: value.sourceId, assetId: value.assetId, transcriptId: value.transcriptId,
    revision: value.revision, ...(cancel ? { requestId: value.requestId } : value.retry ? { retry: true } : {}) };
}

async function requestAlignment({ firestore, source, job, segments, config, actor, request,
  now = Date.now(), audit = adminLogEntry }) {
  if (job.phase !== "ready" || job.id !== request.transcriptId || (job.editRevision ?? 0) !== request.revision) {
    throw new SourceMediaValidationError("Transcript changed. Reload it before aligning", 409);
  }
  if (job.reviewedRevision !== (job.editRevision ?? 0)) {
    throw new SourceMediaValidationError("Review the corrected transcript against the audio before aligning words", 409);
  }
  const built = buildAlignmentSnapshot(job, segments, config);
  const id = built.request.id;
  return firestore.runTransaction(async (tx) => {
    const transcriptRef = firestore.collection("mediaSourceTranscriptJobs").doc(job.id);
    const alignmentRef = firestore.collection(ALIGNMENT_JOBS).doc(id);
    const assetRef = firestore.collection("mediaSourceAssets").doc(job.assetId);
    const current = (await tx.get(transcriptRef)).data();
    const asset = (await tx.get(assetRef)).data();
    if (!current || !sourceMatches(asset, current, source) || current.phase !== "ready" ||
        (current.editRevision ?? 0) !== request.revision ||
        transcriptSegmentsVersion(current, { alignmentWork: true }) !== built.snapshot.transcript.segmentsVersionId) {
      throw new SourceMediaValidationError("Transcript changed. Reload it before aligning", 409);
    }
    const previous = (await tx.get(alignmentRef)).data();
    if (previous && !(request.retry && ["cancelled", "unavailable", "needs_reconciliation", "stale"].includes(previous.phase))) {
      return { job: previous, ...responseFields(previous, current), cached: true };
    }
    const at = new Date(now).toISOString();
    const alignment = { id, transcriptId: current.id, transcriptRevision: request.revision,
      segmentsVersionId: built.snapshot.transcript.segmentsVersionId, assetId: current.assetId,
      sourceId: current.sourceId, engine: built.snapshot.engine,
      passageIndexes: built.request.passages.map((passage) => passage.index),
      eligibleCount: built.request.passages.length, unavailableCount: built.unavailableCount,
      phase: "queued", active: true, attempt: 0, leaseToken: null, leaseUntil: 0,
      requestedBy: actor.uid, createdAt: previous?.createdAt ?? at, updatedAt: at };
    if (previous) tx.set(alignmentRef, alignment);
    else tx.create(alignmentRef, alignment);
    tx.update(transcriptRef, { alignmentRequestId: id, alignmentRevision: request.revision,
      alignmentState: "queued", alignmentEligibleCount: built.request.passages.length,
      alignmentUnavailableCount: built.unavailableCount, alignmentUpdatedAt: at });
    enqueueVideoSearchShard(tx, firestore, current.assetId, current.sourceId);
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({ actorUid: actor.uid,
      actorEmail: actor.email ?? null, action: "media.transcript.align.request",
      target: `${ALIGNMENT_JOBS}/${id}`, after: { transcriptId: current.id,
        revision: request.revision, eligiblePassages: built.request.passages.length,
        unavailablePassages: built.unavailableCount, retry: request.retry === true } }));
    return { job: alignment, ...responseFields(alignment, { ...current,
      alignmentRequestId: id, alignmentState: "queued",
      alignmentEligibleCount: built.request.passages.length,
      alignmentUnavailableCount: built.unavailableCount, alignmentUpdatedAt: at }), cached: false };
  });
}

function validLease(alignment, request, slot, now) {
  return alignment?.active && alignment.leaseToken === request.leaseToken && alignment.leaseUntil > now &&
    slot?.jobId === alignment.id && slot.kind === "alignment" && slot.leaseUntil > now;
}

async function claimAlignmentJob({ firestore, source, config, now = Date.now() }) {
  const candidates = await firestore.collection(ALIGNMENT_JOBS).where("active", "==", true)
    .orderBy("createdAt", "asc").limit(5).get();
  return firestore.runTransaction(async (tx) => {
    const slotReference = slotRef(firestore);
    const slot = (await tx.get(slotReference)).data();
    if (slot?.jobId && slot.leaseUntil > now && slot.kind !== "alignment") return null;
    const refs = slot?.jobId && slot.leaseUntil > now
      ? [firestore.collection(ALIGNMENT_JOBS).doc(slot.jobId),
        ...candidates.docs.filter((doc) => doc.id !== slot.jobId).map((doc) => doc.ref)]
      : candidates.docs.map((doc) => doc.ref);
    const records = [];
    for (const ref of refs) {
      const alignment = (await tx.get(ref)).data();
      if (!alignment?.active) continue;
      const transcriptRef = firestore.collection("mediaSourceTranscriptJobs").doc(alignment.transcriptId);
      const transcript = (await tx.get(transcriptRef)).data();
      const asset = transcript ? (await tx.get(firestore.collection("mediaSourceAssets").doc(transcript.assetId))).data() : null;
      records.push({ ref, alignment, transcriptRef, transcript, asset });
    }
    const engine = alignmentEngine(config);
    // Firestore requires all candidate reads before retiring or claiming jobs.
    for (const { ref, alignment, transcriptRef, transcript, asset } of records) {
      if (!engine || !transcript || transcript.phase !== "ready" || !sourceMatches(asset, transcript, source) ||
          (transcript.editRevision ?? 0) !== alignment.transcriptRevision ||
          transcriptSegmentsVersion(transcript, { alignmentWork: true }) !== alignment.segmentsVersionId ||
          !sameAlignmentEngine(engine, alignment.engine)) {
        const at = new Date(now).toISOString();
        tx.update(ref, { active: false, phase: "stale", leaseToken: null, leaseUntil: 0,
          errorCode: "alignment_stale", updatedAt: at });
        if (transcript?.alignmentRequestId === alignment.id) tx.update(transcriptRef,
          { alignmentState: "stale", alignmentUpdatedAt: at });
        continue;
      }
      if (config.audioEnabled && !alignment.audioInput) continue;
      if (alignment.leaseToken && alignment.leaseUntil > now &&
          slot?.kind === "alignment" && slot.jobId === alignment.id) {
        return { alignment, transcript };
      }
      if ((alignment.attempt ?? 0) >= MAX_ATTEMPTS) {
        const at = new Date(now).toISOString();
        tx.update(ref, { active: false, phase: "needs_reconciliation", leaseToken: null,
          leaseUntil: 0, errorCode: "alignment_worker_lost", updatedAt: at });
        if (transcript.alignmentRequestId === alignment.id) tx.update(transcriptRef,
          { alignmentState: "needs_reconciliation", alignmentUpdatedAt: at });
        continue;
      }
      const changes = { phase: "running", leaseToken: randomUUID(), leaseUntil: now + LEASE_MS,
        ...(alignment.audioInput ? { audioReadLeaseUntil: now + LEASE_MS } : {}),
        attempt: (alignment.attempt ?? 0) + 1, stage: "downloading", updatedAt: new Date(now).toISOString() };
      tx.update(ref, changes);
      if (transcript.alignmentRequestId === alignment.id) tx.update(transcriptRef,
        { alignmentState: "processing", alignmentUpdatedAt: changes.updatedAt });
      tx.set(slotReference, { kind: "alignment", jobId: alignment.id, leaseUntil: changes.leaseUntil, lastSeenAt: now });
      return { alignment: { ...alignment, ...changes }, transcript };
    }
    if (slot?.kind === "alignment") {
      tx.set(slotReference, { kind: null, jobId: null, leaseUntil: 0, lastSeenAt: now });
    }
    return null;
  });
}

async function withAlignmentLease({ firestore, source, request, now = Date.now(), mutate }) {
  return firestore.runTransaction(async (tx) => {
    const ref = firestore.collection(ALIGNMENT_JOBS).doc(request.jobId);
    const alignment = (await tx.get(ref)).data();
    const transcriptRef = alignment ? firestore.collection("mediaSourceTranscriptJobs").doc(alignment.transcriptId) : null;
    const transcript = transcriptRef ? (await tx.get(transcriptRef)).data() : null;
    const asset = transcript ? (await tx.get(firestore.collection("mediaSourceAssets").doc(transcript.assetId))).data() : null;
    const slot = (await tx.get(slotRef(firestore))).data();
    if (alignment?.phase === "complete" && alignment.completedLeaseHash === tokenHash(request.leaseToken)) {
      return { alignment, transcript, completed: true };
    }
    if (!alignment || !transcript || !sourceMatches(asset, transcript, source) ||
        (transcript.editRevision ?? 0) !== alignment.transcriptRevision ||
        transcriptSegmentsVersion(transcript, { alignmentWork: true }) !== alignment.segmentsVersionId) throw invalid("Transcript alignment changed", 409);
    if (!validLease(alignment, request, slot, now)) throw invalid("Alignment worker lease expired", 409);
    return mutate({ tx, ref, alignment, transcriptRef, transcript, now });
  });
}

async function heartbeatAlignmentJob(args) {
  return withAlignmentLease({ ...args, mutate: ({ tx, ref, alignment, transcriptRef, transcript, now }) => {
    const leaseUntil = now + LEASE_MS;
    const updatedAt = new Date(now).toISOString();
    tx.update(ref, { leaseUntil, stage: args.request.stage, updatedAt,
      ...(alignment.audioInput ? { audioReadLeaseUntil: leaseUntil } : {}) });
    if (transcript.alignmentRequestId === alignment.id) tx.update(transcriptRef,
      { alignmentState: "processing", alignmentUpdatedAt: updatedAt });
    tx.set(slotRef(args.firestore), { kind: "alignment", jobId: alignment.id, leaseUntil, lastSeenAt: now });
    return { leaseUntil };
  } });
}

async function finishAlignment(args, { phase, state, errorCode }) {
  return withAlignmentLease({ ...args, mutate: ({ tx, ref, alignment, transcriptRef, transcript, now }) => {
    const updatedAt = new Date(now).toISOString();
    tx.update(ref, { active: false, phase, errorCode, leaseToken: null, leaseUntil: 0, updatedAt });
    if (transcript.alignmentRequestId === alignment.id) tx.update(transcriptRef,
      { alignmentState: state, alignmentUpdatedAt: updatedAt });
    tx.set(slotRef(args.firestore), { kind: null, jobId: null, leaseUntil: 0, lastSeenAt: now });
    return { completed: true, available: false };
  } });
}

async function failAlignmentJob(args) {
  return finishAlignment(args, { phase: "unavailable", state: "unavailable", errorCode: args.request.errorCode });
}

async function completeAlignmentJob(args) {
  const checked = await withAlignmentLease({ ...args, mutate: ({ alignment, transcript }) => ({ alignment, transcript }) });
  if (checked.completed) return { completed: true,
    available: checked.transcript?.alignmentRequestId === checked.alignment.id &&
      checked.transcript.alignmentState === "ready" };
  const built = buildAlignmentSnapshot(checked.transcript, await args.readSegments(checked.transcript), args.config);
  if (built.request.id !== checked.alignment.id ||
      built.request.passages.map((passage) => passage.index).join(",") !== checked.alignment.passageIndexes.join(",")) {
    throw invalid("Transcript alignment changed", 409);
  }
  let candidate;
  try { candidate = validateAlignmentCompletion(built.snapshot, args.request.result); }
  catch (error) {
    if (error?.code === "alignment_unavailable") {
      return finishAlignment(args, { phase: "unavailable", state: "unavailable", errorCode: "alignment_uncertain" });
    }
    if (error?.code === "alignment_stale") throw invalid("Transcript alignment changed", 409);
    throw invalid();
  }
  const segments = await args.readSegments(checked.transcript);
  for (const passage of candidate.passages) segments[passage.index] = { ...segments[passage.index], words: passage.words };
  const remaining = selectedPassages(segments);
  await args.assertBillingEnabled();
  const outputs = await args.writeAlignment(checked.transcript, segments,
    checked.transcript.speakerNames ?? {}, checked.alignment.id);
  return withAlignmentLease({ ...args, now: args.clock?.() ?? Date.now(), mutate: ({ tx, ref, alignment, transcriptRef, transcript, now }) => {
    const updatedAt = new Date(now).toISOString();
    const state = remaining.deferredCount || remaining.passages.length ? "partial" :
      remaining.unavailableCount ? "unavailable" : "review_required";
    tx.update(ref, { active: false, phase: "complete", errorCode: null, leaseToken: null, leaseUntil: 0,
      completedLeaseHash: tokenHash(args.request.leaseToken), completedAt: updatedAt, updatedAt });
    if (transcript.alignmentRequestId === alignment.id) tx.update(transcriptRef,
      { alignedOutputs: outputs, alignedOutputRequestId: alignment.id,
        alignmentState: state, alignmentUnavailableCount: remaining.unavailableCount,
        alignmentEligibleCount: remaining.passages.length + remaining.deferredCount,
        alignmentUpdatedAt: updatedAt,
        ...(state === "review_required" ? { reviewedRevision: null, reviewedAt: null,
          reviewedBy: null, reviewedByName: null, reviewedAlignmentRequestId: null } : {}) });
    enqueueVideoSearchShard(tx, args.firestore, transcript.assetId, transcript.sourceId);
    tx.set(slotRef(args.firestore), { kind: null, jobId: null, leaseUntil: 0, lastSeenAt: now });
    return { completed: true, available: false, remainingPassages: remaining.missingCount };
  } });
}

async function cancelAlignment({ firestore, source, job, request, actor, now = Date.now(), audit = adminLogEntry }) {
  return firestore.runTransaction(async (tx) => {
    const transcriptRef = firestore.collection("mediaSourceTranscriptJobs").doc(job.id);
    const current = (await tx.get(transcriptRef)).data();
    const asset = current ? (await tx.get(firestore.collection("mediaSourceAssets").doc(current.assetId))).data() : null;
    if (!current || !sourceMatches(asset, current, source) || current.id !== request.transcriptId ||
        (current.editRevision ?? 0) !== request.revision || current.alignmentRequestId !== request.requestId) {
      throw new SourceMediaValidationError("Transcript alignment changed", 409);
    }
    const ref = firestore.collection(ALIGNMENT_JOBS).doc(request.requestId);
    const alignment = (await tx.get(ref)).data();
    const slot = (await tx.get(slotRef(firestore))).data();
    if (!alignment || alignment.transcriptId !== current.id) throw new SourceMediaValidationError("Transcript alignment was not found", 404);
    if (["complete", "unavailable", "cancelled", "stale", "needs_reconciliation"].includes(alignment.phase)) {
      return { job: alignment, ...responseFields(alignment, current), cached: true };
    }
    const at = new Date(now).toISOString();
    tx.update(ref, { active: false, phase: "cancelled", leaseToken: null, leaseUntil: 0,
      errorCode: "alignment_cancelled", updatedAt: at });
    tx.update(transcriptRef, { alignmentState: "cancelled", alignmentUpdatedAt: at });
    enqueueVideoSearchShard(tx, firestore, current.assetId, current.sourceId);
    if (slot?.kind === "alignment" && slot.jobId === alignment.id) {
      tx.set(slotRef(firestore), { kind: null, jobId: null, leaseUntil: 0, lastSeenAt: now });
    }
    tx.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), audit({ actorUid: actor.uid,
      actorEmail: actor.email ?? null, action: "media.transcript.align.cancel",
      target: `${ALIGNMENT_JOBS}/${alignment.id}`, before: { phase: alignment.phase }, after: { phase: "cancelled" } }));
    const cancelled = { ...alignment, active: false, phase: "cancelled", updatedAt: at };
    return { job: cancelled, ...responseFields(cancelled, { ...current,
      alignmentState: "cancelled", alignmentUpdatedAt: at }), cached: false };
  });
}

function parseAlignmentWorkerRequest(operation, body) {
  const fields = { heartbeat: ["kind", "jobId", "leaseToken", "stage"],
    complete: ["kind", "jobId", "leaseToken", "result"], fail: ["kind", "jobId", "leaseToken", "errorCode"] }[operation];
  if (!fields || !body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== fields.length || !fields.every((field) => Object.hasOwn(body, field)) ||
      body.kind !== "alignment" || typeof body.jobId !== "string" || !/^[a-f0-9]{64}$/.test(body.jobId) ||
      typeof body.leaseToken !== "string" || !/^[a-f0-9-]{36}$/.test(body.leaseToken) ||
      (operation === "heartbeat" && !STAGES.has(body.stage)) ||
      (operation === "fail" && !FAILURES.has(body.errorCode)) ||
      (operation === "complete" && (!body.result || typeof body.result !== "object" || Array.isArray(body.result)))) throw invalid();
  return body;
}

module.exports = { ALIGNMENT_JOBS, LEASE_MS, MAX_ATTEMPTS, MAX_PASSAGE_SECONDS, ADAPTER_REVISION,
  MODEL_REPOSITORY, MODEL_REVISION, alignmentEngine, hasAlignedWords, selectedPassages, buildAlignmentSnapshot,
  parseAlignmentRequest, requestAlignment, claimAlignmentJob, withAlignmentLease, heartbeatAlignmentJob,
  failAlignmentJob, completeAlignmentJob, cancelAlignment, parseAlignmentWorkerRequest };
