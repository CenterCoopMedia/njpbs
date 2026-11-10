"use strict";

const { enqueueVideoSearchShard } = require("./video-search-outbox");

const { randomUUID, createHash } = require("node:crypto");
const { sameOriginal } = require("./video-preview-job");
const { objectKeyWithinSource } = require("./media-sources");
const { processingChanges } = require("./video-processing-status");
const { PAID_FALLBACK_POLICY } = require("./video-transcript-fallback-policy");

const { releaseLocalQueue } = require("./video-transcript-local-queue");
const JOBS = "mediaSourceTranscriptJobs";
const WORKERS = "mediaTranscriptWorkers";
const WORKER_ID = "node-gpu-b";
const LOCAL_ENGINE = "faster-whisper-large-v3-pyannote-community-1-v1";
const LEASE_MS = 120_000;
const MAX_LOCAL_FAILURES = 3;
const STAGES = new Set(["downloading", "preparing", "transcribing", "aligning", "diarizing", "finalizing"]);
const FAILURES = new Set(["local_processing_failed", "local_model_unavailable", "local_input_failed"]);
const invalid = (message = "Worker request is invalid", status = 400) => Object.assign(new Error(message), { status });
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const slotRef = (firestore) => firestore.collection(WORKERS).doc(WORKER_ID);

function sourceMatches(asset, job, source) {
  const web = asset?.rendition?.web;
  return sameOriginal(asset, job) && source?.id === job.sourceId && source.bucket === job.sourceBucket &&
    objectKeyWithinSource(source, job.sourceObjectKey) && asset.rendition?.state === "ready" &&
    web?.objectKey === job.input?.objectKey && web?.objectVersionId === job.input?.objectVersionId &&
    web?.sizeBytes === job.input?.sizeBytes;
}
function validLease(job, request, now) {
  return job?.active && job.provider === "local" && job.workerId === WORKER_ID &&
    job.localLeaseToken === request.leaseToken && job.localLeaseUntil > now;
}
function parseWorkerRequest(operation, body) {
  const fields = { claim: ["capabilities"], heartbeat: ["jobId", "leaseToken", "stage", "processedSeconds"],
    complete: ["jobId", "leaseToken", "engineRevision", "segments"], fail: ["jobId", "leaseToken", "errorCode"] }[operation];
  if (!fields || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) throw invalid();
  if (operation === "claim") {
    // A worker lists the extra job kinds it can run; older workers send {}.
    const capabilities = body.capabilities ?? [];
    if (!Array.isArray(capabilities) || capabilities.length > 1 || capabilities.some((value) => value !== "orientation")) throw invalid();
    return { capabilities };
  }
  if (typeof body.jobId !== "string" || !/^[a-f0-9]{64}$/.test(body.jobId) ||
      typeof body.leaseToken !== "string" || !/^[a-f0-9-]{36}$/.test(body.leaseToken)) throw invalid();
  if (operation === "heartbeat" && (!STAGES.has(body.stage) || (body.processedSeconds !== undefined &&
      (!Number.isFinite(body.processedSeconds) || body.processedSeconds < 0)))) throw invalid();
  if (operation === "fail" && !FAILURES.has(body.errorCode)) throw invalid();
  if (operation === "complete" && (body.engineRevision !== LOCAL_ENGINE || !Array.isArray(body.segments))) throw invalid();
  return body;
}
function validateSegments(segments, job) {
  if (!Array.isArray(segments) || segments.length > 50000) throw invalid("Transcript result is invalid");
  let previous = -1;
  let wordCount = 0;
  const normalized = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment) ||
        Object.keys(segment).some((key) => !["startSeconds", "endSeconds", "speaker", "text", "words", "speakerUncertain", "overlappingSpeech"].includes(key)) ||
        !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) ||
        segment.startSeconds < previous || segment.startSeconds < 0 || segment.startSeconds >= job.durationSeconds || segment.endSeconds <= segment.startSeconds ||
        segment.endSeconds > job.durationSeconds + 0.1 ||
        (segment.speaker !== "unknown" && (!/^spk_(?:0|[1-9]\d?)$/.test(segment.speaker) || Number(segment.speaker.slice(4)) >= job.maxSpeakers)) ||
        ["speakerUncertain", "overlappingSpeech"].some((key) => segment[key] !== undefined && typeof segment[key] !== "boolean") ||
        (segment.speaker === "unknown" && segment.speakerUncertain !== true) || typeof segment.text !== "string" ||
        !segment.text.trim() || segment.text.length > 16000 || [...segment.text].some((character) => { const code = character.charCodeAt(0); return (code < 32 && ![9, 10, 13].includes(code)) || code === 127; })) throw invalid("Transcript result is invalid");
    wordCount += validateWords(segment);
    if (wordCount > 200000) throw invalid("Transcript result is invalid");
    if (segment.words?.some((word) => word.startSeconds > job.durationSeconds)) throw invalid("Transcript word timing is invalid");
    // Small model rounding at EOF must not create saved timings outside the
    // viewing copy. Preserve text and reject words that start beyond its end.
    normalized.push({ ...segment, endSeconds: Math.min(segment.endSeconds, job.durationSeconds),
      ...(segment.words ? { words: segment.words.map((word) => ({ ...word,
        endSeconds: Math.min(word.endSeconds, job.durationSeconds) })) } : {}) });
    previous = segment.startSeconds;
  }
  return normalized;
}
function validateWords(segment) {
  if (segment.words === undefined) return 0;
  if (!Array.isArray(segment.words) || !segment.words.length || segment.words.length > 4000) throw invalid("Transcript word timing is invalid");
  let previous = segment.startSeconds;
  for (const word of segment.words) {
    if (!word || typeof word !== "object" || Array.isArray(word) ||
        Object.keys(word).some((key) => !["startSeconds", "endSeconds", "text", "confidence"].includes(key)) ||
        !Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds) ||
        word.startSeconds < previous || word.endSeconds < word.startSeconds || word.endSeconds > segment.endSeconds ||
        (word.confidence !== undefined && (!Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1)) ||
        typeof word.text !== "string" || !word.text.trim() || word.text.length > 16000 || Array.from(word.text).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw invalid("Transcript word timing is invalid");
    }
    previous = word.startSeconds;
  }
  return segment.words.length;
}
async function claimLocalJob({ firestore, source, audioRequired = false, now = Date.now() }) {
  const candidates = await firestore.collection(JOBS).where("active", "==", true)
    .where("provider", "==", "local").orderBy("createdAt", "asc").limit(5).get();
  return firestore.runTransaction(async (tx) => {
    const slot = (await tx.get(slotRef(firestore))).data();
    if (slot?.jobId && slot.leaseUntil > now && slot.kind && slot.kind !== "transcription") return null;
    const refs = slot?.jobId && slot.leaseUntil > now
      ? [firestore.collection(JOBS).doc(slot.jobId)] : candidates.docs.map((doc) => doc.ref);
    const records = [];
    for (const ref of refs) {
      const job = (await tx.get(ref)).data();
      const asset = job ? (await tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId))).data() : null;
      records.push({ ref, job, asset });
    }
    let claimed = null;
    for (const { ref, job, asset } of records) {
      if (!job?.active || job.provider !== "local") continue;
      if (!sourceMatches(asset, job, source)) {
        releaseLocalQueue(tx, firestore, job);
        tx.update(ref, processingChanges(job, { active: false, phase: "stale", errorCode: "source_unavailable" }, now));
        continue;
      }
      if (audioRequired && !job.audioInput) break;
      // A lost claim response may be recovered, but an expired lease is never revived.
      if (job.localLeaseToken) {
        if (job.localLeaseUntil > now && job.workerId === WORKER_ID && slot?.jobId === job.id) claimed = job;
        break;
      }
      const leaseToken = randomUUID();
      const changes = processingChanges(job, { phase: "running", processingStage: "preparing", workerId: WORKER_ID,
        ...(job.audioInput ? { audioReadLeaseUntil: now + LEASE_MS } : {}),
        localLeaseToken: leaseToken, localAttemptId: tokenHash(leaseToken), localLeaseUntil: now + LEASE_MS, localStage: "downloading" }, now);
      tx.update(ref, changes);
      claimed = { ...job, ...changes };
      break;
    }
    tx.set(slotRef(firestore), { kind: claimed ? "transcription" : null,
      lastSeenAt: now, jobId: claimed?.id ?? null, leaseUntil: claimed?.localLeaseUntil ?? 0 });
    return claimed;
  });
}
async function withLocalLease({ firestore, source, request, now = Date.now(), mutate }) {
  return firestore.runTransaction(async (tx) => {
    const ref = firestore.collection(JOBS).doc(request.jobId);
    const job = (await tx.get(ref)).data();
    const asset = job ? (await tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId))).data() : null;
    const slot = (await tx.get(slotRef(firestore))).data();
    if (!job || !sourceMatches(asset, job, source)) throw invalid("Video is no longer available", 409);
    if (job.phase === "ready" && job.completedLocalLeaseHash === tokenHash(request.leaseToken)) return { job, completed: true };
    if (!validLease(job, request, now) || slot?.jobId !== job.id || slot.leaseUntil <= now ||
        (slot.kind !== undefined && slot.kind !== "transcription")) throw invalid("Worker lease expired", 409);
    return mutate({ tx, ref, job, now });
  });
}
async function heartbeatLocalJob(args) {
  return withLocalLease({ ...args, mutate: ({ tx, ref, job, now }) => {
    if (args.request.processedSeconds > job.durationSeconds) throw invalid();
    const changes = processingChanges(job, { localLeaseUntil: now + LEASE_MS, localStage: args.request.stage,
      ...(job.audioInput ? { audioReadLeaseUntil: now + LEASE_MS } : {}),
      processingStage: args.request.stage === "finalizing" ? "finalizing" : ["downloading", "preparing"].includes(args.request.stage) ? "preparing" : "processing",
      ...(args.request.processedSeconds === undefined ? {} : { localProcessedSeconds: args.request.processedSeconds }) }, now);
    tx.update(ref, changes);
    tx.set(slotRef(args.firestore), { kind: "transcription", lastSeenAt: now, jobId: job.id, leaseUntil: now + LEASE_MS });
    return { job: { ...job, ...changes } };
  } });
}
function fallbackChanges(job, reason, now, enabled) {
  return processingChanges(job, { provider: enabled ? "amazon-transcribe" : "local", phase: enabled ? "pending" : "needs_reconciliation",
    ...(enabled && job.processingPolicy === PAID_FALLBACK_POLICY ? { paidFallbackState: "pending" } : {}),
    active: enabled, processingStage: enabled ? "queued" : "needs_attention", fallbackReason: reason,
    fallbackAt: new Date(now).toISOString(), errorCode: enabled ? null : reason,
    localLeaseToken: null, localLeaseUntil: 0, leaseOwner: null, leaseUntil: 0 }, now);
}
async function failLocalJob(args) {
  return withLocalLease({ ...args, mutate: ({ tx, ref, job, now }) => {
    const localFailureCount = (job.localFailureCount ?? 0) + 1;
    const fallback = args.fallbackEnabled && job.requestedProvider !== "local" && localFailureCount < MAX_LOCAL_FAILURES;
    if (!fallback) releaseLocalQueue(tx, args.firestore, job);
    tx.update(ref, { ...fallbackChanges(job, args.request.errorCode, now, fallback), localFailureCount,
      ...(!fallback ? { localAttemptId: tokenHash(job.localLeaseToken), cleanupWriterSettlement: {
        provider: "local", jobId: job.id, attemptId: tokenHash(job.localLeaseToken), workerId: WORKER_ID,
        status: "FAILED", at: new Date(now).toISOString() } } : {}) });
    tx.set(slotRef(args.firestore), { kind: null, lastSeenAt: now, jobId: null, leaseUntil: 0 });
    return { fallback };
  } });
}
async function completeLocalJob(args) {
  const checked = await withLocalLease({ ...args, mutate: ({ job }) => ({ job }) });
  if (checked.completed) return { completed: true };
  const segments = validateSegments(args.request.segments, checked.job);
  await args.assertBillingEnabled();
  const outputs = await args.writeExports(checked.job, segments);
  return withLocalLease({ ...args, now: args.clock?.() ?? Date.now(), mutate: ({ tx, ref, job, now }) => {
    releaseLocalQueue(tx, args.firestore, job);
    tx.update(ref, processingChanges(job, { phase: "ready", active: false, outputs, totalSegments: segments.length,
      actualEngineRevision: LOCAL_ENGINE, completedLocalLeaseHash: tokenHash(args.request.leaseToken),
      localLeaseToken: null, localLeaseUntil: 0, errorCode: null }, now));
    enqueueVideoSearchShard(tx, args.firestore, job.assetId, job.sourceId);
    tx.set(slotRef(args.firestore), { kind: null, lastSeenAt: now, jobId: null, leaseUntil: 0 });
    return { completed: true };
  } });
}
async function routeLocalFallback({ firestore, ref, source, fallbackEnabled, audioRequired = false, now = Date.now() }) {
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    if (!job?.active || job.provider !== "local") return Boolean(job?.active && (job.provider === undefined || job.provider === "amazon-transcribe"));
    if (job.requestedProvider === "local") fallbackEnabled = false;
    const slot = (await tx.get(slotRef(firestore))).data();
    const asset = (await tx.get(firestore.collection("mediaSourceAssets").doc(job.assetId))).data();
    if (!sourceMatches(asset, job, source)) {
      releaseLocalQueue(tx, firestore, job);
      tx.update(ref, processingChanges(job, { active: false, phase: "stale", errorCode: "source_unavailable" }, now));
      return false;
    }
    // Preparation has a separate bounded lease. It is not a GPU outage.
    if (audioRequired && !job.audioInput && !job.localLeaseToken) return false;
    if (job.localLeaseToken && job.localLeaseUntil > now) return false;
    if (!job.localLeaseToken && (slot?.lastSeenAt > now - LEASE_MS || Date.parse(job.localQueuedAt ?? job.createdAt) > now - LEASE_MS)) return false;
    if (!fallbackEnabled) releaseLocalQueue(tx, firestore, job);
    tx.update(ref, fallbackChanges(job, "local_worker_unavailable", now, fallbackEnabled));
    return fallbackEnabled;
  });
}
module.exports = { JOBS, WORKERS, WORKER_ID, LOCAL_ENGINE, LEASE_MS, sourceMatches, parseWorkerRequest,
  validateSegments, claimLocalJob, withLocalLease, heartbeatLocalJob, failLocalJob, completeLocalJob, routeLocalFallback };
