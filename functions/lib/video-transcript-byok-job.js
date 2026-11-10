"use strict";

const { enqueueVideoSearchShard } = require("./video-search-outbox");

const { createHash, randomUUID } = require("node:crypto");
const { processingChanges, requesterName } = require("./video-processing-status");
const { parseNewAttempt } = require("./video-transcript-attempt");
const PROVIDER = "elevenlabs";
const MODEL = "scribe_v2";
const ADAPTER_REVISION = "elevenlabs-transcript-v1";
const AUDIO_ADAPTER_REVISION = "elevenlabs-transcript-m4a-v1";
const MAX_INPUT_BYTES = 2_000_000_000;
const MIN_DURATION_SECONDS = 0.1;
const MAX_DURATION_SECONDS = 7200;
const COLLECTION = "mediaSourceTranscriptJobs";
const LEASE_MS = 300_000;
const INTENT_LEASE_MS = 720_000;
const HEX = /^[a-f0-9]{64}$/;
const opaque = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\r\n]/.test(value);
function problem(code) { return Object.assign(new Error(code), { code }); }

function variantId(identity) {
  if (!identity || Object.keys(identity).some((key) => !["sourceId", "assetId", "originalBucket", "originalKey", "originalVersion", "originalSize", "renditionBucket", "renditionKey", "renditionVersion", "renditionSize", "durationSeconds", "credentialScope", "credentialId", "credentialRevision", "languageCode", "maxSpeakers", "inputRevision", "attemptGeneration", "previousTranscriptId", "attemptKey"].includes(key)) || identity.sourceId !== "video-library" || !opaque(identity.assetId) ||
      (identity.attemptGeneration !== undefined && (!Number.isSafeInteger(identity.attemptGeneration) || identity.attemptGeneration < 1 || !HEX.test(identity.previousTranscriptId ?? ""))) ||
      (identity.previousTranscriptId !== undefined && identity.attemptGeneration === undefined) ||
      (identity.inputRevision !== undefined && identity.inputRevision !== "aac-m4a-copy-v1") ||
      !["originalBucket", "originalKey", "originalVersion", "renditionBucket", "renditionKey", "renditionVersion"].every((key) => opaque(identity[key])) ||
      !Number.isSafeInteger(identity.originalSize) || identity.originalSize <= 0 ||
      !Number.isSafeInteger(identity.renditionSize) || identity.renditionSize <= 0 || identity.renditionSize > MAX_INPUT_BYTES ||
      !Number.isFinite(identity.durationSeconds) || identity.durationSeconds < MIN_DURATION_SECONDS || identity.durationSeconds > MAX_DURATION_SECONDS ||
      !["en-US", "es-US"].includes(identity.languageCode) ||
      !Number.isInteger(identity.maxSpeakers) || identity.maxSpeakers < 2 || identity.maxSpeakers > 10 ||
      !["personal", "organization"].includes(identity.credentialScope) || !HEX.test(identity.credentialId ?? "") ||
      !Number.isSafeInteger(identity.credentialRevision) || identity.credentialRevision < 1 || identity.credentialRevision >= Number.MAX_SAFE_INTEGER) {
    throw problem("byok_identity_invalid");
  }
  try { parseNewAttempt(identity.previousTranscriptId, identity.attemptKey); }
  catch { throw problem("byok_identity_invalid"); }
  return createHash("sha256").update(JSON.stringify([identity.inputRevision ? AUDIO_ADAPTER_REVISION : ADAPTER_REVISION, identity.sourceId, identity.assetId,
    identity.originalBucket, identity.originalKey, identity.originalVersion, identity.originalSize,
    identity.renditionBucket, identity.renditionKey, identity.renditionVersion, identity.renditionSize, identity.durationSeconds,
    PROVIDER, MODEL, identity.languageCode, identity.maxSpeakers, identity.credentialScope, identity.credentialId, identity.credentialRevision,
    ...(identity.attemptGeneration ? [identity.attemptGeneration, identity.previousTranscriptId] : []),
    ...(identity.attemptKey ? [identity.attemptKey] : [])])).digest("hex");
}

function createJob(identity, requester, now = Date.now()) {
  const id = variantId(identity);
  if (!opaque(requester?.uid) || !Number.isFinite(now)) throw problem("byok_requester_invalid");
  const credentialId = createHash("sha256").update(JSON.stringify(["credential-v1", identity.credentialScope,
    identity.credentialScope === "personal" ? requester.uid : null, PROVIDER])).digest("hex");
  if (identity.credentialId !== credentialId) throw problem("byok_credential_owner_invalid");
  return processingChanges({}, { id, identity: { ...identity }, provider: PROVIDER, model: MODEL,
    adapterRevision: identity.inputRevision ? AUDIO_ADAPTER_REVISION : ADAPTER_REVISION,
    sourceId: identity.sourceId, assetId: identity.assetId, sourceBucket: identity.originalBucket,
    sourceObjectKey: identity.originalKey, sourceObjectVersionId: identity.originalVersion, sourceSizeBytes: identity.originalSize,
    input: { objectKey: identity.renditionKey, objectVersionId: identity.renditionVersion, sizeBytes: identity.renditionSize, durationSeconds: identity.durationSeconds },
    durationSeconds: identity.durationSeconds, languageCode: identity.languageCode, maxSpeakers: identity.maxSpeakers,
    requestedBy: requester.uid, requesterDisplayName: requesterName(requester.displayName), phase: "pending", processingStage: "queued", active: true, createdAt: new Date(now).toISOString(),
    leaseOwner: null, leaseUntil: 0, submissionIntentAt: null }, now);
}
function validJob(job, id) {
  if (!job || job.provider !== PROVIDER || job.id !== id || variantId(job.identity) !== id) throw problem("byok_job_identity_invalid");
  const expected = createJob(job.identity, { uid: job.requestedBy }, 0);
  for (const field of ["sourceId", "assetId", "sourceBucket", "sourceObjectKey", "sourceObjectVersionId", "sourceSizeBytes", "durationSeconds", "model", "adapterRevision", "languageCode", "maxSpeakers"]) {
    if (job[field] !== expected[field]) throw problem("byok_job_identity_invalid");
  }
  if (!job.input || Object.keys(job.input).length !== Object.keys(expected.input).length ||
      Object.keys(expected.input).some((field) => job.input[field] !== expected.input[field])) throw problem("byok_job_identity_invalid");
}
function refFor(firestore, id) {
  if (!HEX.test(id ?? "")) throw problem("byok_job_id_invalid");
  return firestore.collection(COLLECTION).doc(id);
}
async function checkCurrent(validateCurrent, tx, job, stage) {
  // Integration must read authorization, credential revision, media and billing/quota records
  // in this transaction. External Auth checks occur immediately before it. No default bypass.
  if (typeof validateCurrent !== "function" || await validateCurrent(tx, job, stage) !== true) throw problem("byok_current_state_denied");
}
// Only the admission handler creates reservations. Settlement shares the job CAS
// transaction, so retries cannot consume or release a reservation twice.
async function settleBudget(tx, firestore, job, operation) {
  const reservation = job.budgetReservation;
  const owner = createHash("sha256").update(JSON.stringify(job.requestedBy)).digest("hex");
  if (!reservation || !/^\d{4}-\d{2}-\d{2}$/.test(reservation.day) ||
      reservation.audioSeconds !== Math.ceil(job.durationSeconds) ||
      reservation.requesterRecord !== `user-${owner}-${reservation.day}` ||
      reservation.globalRecord !== `global-${reservation.day}` || reservation.slotRecord !== `slot-${owner}` ||
      !["reserved", "consumed", "released"].includes(reservation.state)) throw problem("byok_budget_invalid");
  const collection = firestore.collection("mediaTranscriptionBudgets");
  const refs = [collection.doc(reservation.requesterRecord), collection.doc(reservation.globalRecord)];
  const slotRef = collection.doc(reservation.slotRecord);
  const [personal, global, slot] = await Promise.all([...refs.map((ref) => tx.get(ref)), tx.get(slotRef)]);
  const records = [personal.data(), global.data()];
  for (const record of records) {
    if (!record || ["reservedSubmissions", "reservedAudioSeconds", "consumedSubmissions", "consumedAudioSeconds"].some((key) => !Number.isSafeInteger(record[key]) || record[key] < 0)) throw problem("byok_budget_invalid");
  }
  if (operation === "consume" && (reservation.state !== "reserved" || slot.data()?.jobId !== job.id)) throw problem("byok_budget_invalid");
  if (operation === "release" && (job.submissionIntentAt || reservation.state !== "reserved")) throw problem("byok_budget_invalid");
  if (operation === "terminal" && reservation.state !== "consumed") throw problem("byok_budget_invalid");
  if (operation !== "terminal") {
    for (const record of records) if (record.reservedSubmissions < 1 || record.reservedAudioSeconds < reservation.audioSeconds) throw problem("byok_budget_invalid");
    for (const [index, record] of records.entries()) tx.set(refs[index], { ...record,
      reservedSubmissions: record.reservedSubmissions - 1, reservedAudioSeconds: record.reservedAudioSeconds - reservation.audioSeconds,
      consumedSubmissions: record.consumedSubmissions + (operation === "consume" ? 1 : 0),
      consumedAudioSeconds: record.consumedAudioSeconds + (operation === "consume" ? reservation.audioSeconds : 0) });
  }
  if (operation !== "consume" && slot.data()?.jobId === job.id) tx.set(slotRef, { jobId: null });
  return { ...reservation, state: operation === "consume" ? "consumed" : operation === "release" ? "released" : reservation.state };
}
async function cancelBeforeIntent({ firestore, claim, now = Date.now() }) {
  const ref = refFor(firestore, claim.id);
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    validJob(job, claim.id);
    if (!owns(job, claim, now) || job.submissionIntentAt || job.phase !== "pending") return false;
    const budgetReservation = await settleBudget(tx, firestore, job, "release");
    tx.update(ref, processingChanges(job, { budgetReservation, active: false, phase: "failed", processingStage: "failed", errorCode: "byok_admission_invalid",
      leaseOwner: null, leaseUntil: 0 }, now));
    return true;
  });
}
async function requestJob({ firestore, job, validateCurrent }) {
  validJob(job, job?.id);
  const ref = refFor(firestore, job.id);
  return firestore.runTransaction(async (tx) => {
    const previous = (await tx.get(ref)).data();
    await checkCurrent(validateCurrent, tx, job, "request");
    if (previous) { validJob(previous, job.id); return { job: previous, cached: true }; }
    if (job.phase !== "pending" || job.submissionIntentAt || job.leaseOwner) throw problem("byok_new_job_invalid");
    tx.create(ref, job);
    return { job, cached: false };
  });
}
async function claimJob({ firestore, id, validateCurrent, now = Date.now() }) {
  const ref = refFor(firestore, id);
  const owner = randomUUID();
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    validJob(job, id);
    if (!job.active || job.leaseUntil > now) return null;
    if (job.submissionIntentAt) {
      await settleBudget(tx, firestore, job, "terminal");
      tx.update(ref, processingChanges(job, { phase: "needs_reconciliation", processingStage: "needs_attention", active: false, leaseOwner: null, leaseUntil: 0, errorCode: "elevenlabs_submission_uncertain" }, now));
      return null;
    }
    if (job.phase !== "pending") return null;
    await checkCurrent(validateCurrent, tx, job, "claim");
    const changes = processingChanges(job, { leaseOwner: owner, leaseUntil: now + LEASE_MS, attemptId: randomUUID(), processingStage: "preparing", errorCode: null }, now);
    tx.update(ref, changes);
    return { ...job, ...changes };
  });
}
async function deferPreparation({ firestore, claim, now = Date.now() }) {
  const ref = refFor(firestore, claim.id);
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    validJob(job, claim.id);
    if (!owns(job, claim, now) || job.submissionIntentAt || job.phase !== "pending") return false;
    const attempts = job.preparationFailures ?? 0;
    if (!Number.isSafeInteger(attempts) || attempts < 0) throw problem("byok_preparation_invalid");
    if (attempts >= 2) {
      const budgetReservation = await settleBudget(tx, firestore, job, "release");
      tx.update(ref, processingChanges(job, { budgetReservation, preparationFailures: attempts + 1, active: false, phase: "failed", processingStage: "failed", errorCode: "byok_preparation_failed", leaseOwner: null, leaseUntil: 0 }, now));
    } else tx.update(ref, processingChanges(job, { preparationFailures: attempts + 1, nextAttemptAt: now + 60_000 * (attempts + 1), leaseOwner: null, leaseUntil: 0, processingStage: "queued", errorCode: null }, now));
    return attempts >= 2 ? "failed" : "deferred";
  });
}
async function waitForAudio({ firestore, claim, now = Date.now() }) {
  const ref = refFor(firestore, claim.id);
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    validJob(job, claim.id);
    if (!owns(job, claim, now) || job.submissionIntentAt || job.phase !== "pending") return false;
    tx.update(ref, processingChanges(job, { leaseOwner: null, leaseUntil: 0,
      nextAttemptAt: now + 30000, processingStage: "preparing", errorCode: null }, now));
    return true;
  });
}
async function claimRecovery({ firestore, id, now = Date.now() }) {
  const ref = refFor(firestore, id);
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    validJob(job, id);
    if (!job.active || job.phase !== "running" || !job.submissionIntentAt || !job.attemptId || job.leaseUntil > now) return null;
    const recoveryAttempts = job.recoveryAttempts ?? 0;
    if (!Number.isSafeInteger(recoveryAttempts) || recoveryAttempts < 0) throw problem("byok_recovery_invalid");
    if (recoveryAttempts >= 3) {
      await settleBudget(tx, firestore, job, "terminal");
      tx.update(ref, processingChanges(job, { active: false, phase: "needs_reconciliation", processingStage: "needs_attention", leaseOwner: null, leaseUntil: 0, errorCode: "elevenlabs_submission_uncertain" }, now));
      return null;
    }
    const changes = processingChanges(job, { leaseOwner: randomUUID(), leaseUntil: now + INTENT_LEASE_MS, recoveryAttempts: recoveryAttempts + 1, processingStage: "finalizing", errorCode: null }, now);
    tx.update(ref, changes);
    return { ...job, ...changes };
  });
}
async function attachSpool({ firestore, claim, receipt, now = Date.now() }) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      Object.keys(receipt).some((key) => !["key", "versionId", "sha256", "identityHash"].includes(key)) ||
      !opaque(receipt.key) || !opaque(receipt.versionId) || !HEX.test(receipt.sha256 ?? "") || !HEX.test(receipt.identityHash ?? "")) throw problem("byok_spool_invalid");
  const ref = refFor(firestore, claim.id);
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    validJob(job, claim.id);
    if (!owns(job, claim, now) || job.phase !== "running" || !job.submissionIntentAt) return false;
    if (job.spoolReceipt && ["key", "versionId", "sha256", "identityHash"].some((key) => job.spoolReceipt[key] !== receipt[key])) throw problem("byok_spool_changed");
    tx.update(ref, processingChanges(job, { spoolReceipt: receipt, processingStage: "finalizing", errorCode: null }, now));
    return true;
  });
}
function owns(job, claim, now) {
  return job.active && job.leaseOwner === claim.leaseOwner && job.attemptId === claim.attemptId && job.leaseUntil > now;
}
async function recordIntent({ firestore, claim, validateCurrent, now = Date.now() }) {
  const ref = refFor(firestore, claim.id);
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    validJob(job, claim.id);
    if (!owns(job, claim, now) || job.phase !== "pending" || job.submissionIntentAt) return null;
    await checkCurrent(validateCurrent, tx, job, "submission");
    // Input and key preparation may consume the initial claim lease. Give the
    // bounded provider call and export writes a fresh window at the paid boundary.
    const budgetReservation = await settleBudget(tx, firestore, job, "consume");
    const changes = processingChanges(job, { budgetReservation, submissionIntentAt: new Date(now).toISOString(), phase: "running", processingStage: "processing", errorCode: null, leaseUntil: now + INTENT_LEASE_MS }, now);
    tx.update(ref, changes);
    return { ...job, ...changes };
  });
}
async function finishJob({ firestore, claim, result, validateCurrent, now = Date.now() }) {
  const ref = refFor(firestore, claim.id);
  if (!["ready", "rejected", "needs_reconciliation"].includes(result?.outcome)) throw problem("byok_outcome_invalid");
  if (result.recoveryError !== undefined && (result.outcome !== "needs_reconciliation" ||
      !["byok_spool_missing", "byok_spool_invalid"].includes(result.recoveryError))) throw problem("byok_outcome_invalid");
  if (result.outcome === "ready" && (!result.outputs || !["segments.json", "txt", "vtt"].every((format) => opaque(result.outputs[format])) ||
      Object.keys(result.outputs).length !== 3 || !Number.isSafeInteger(result.totalSegments) || result.totalSegments < 0 || result.totalSegments > 50_000)) throw problem("byok_outputs_invalid");
  return firestore.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    validJob(job, claim.id);
    if (!owns(job, claim, now) || !job.submissionIntentAt || job.phase !== "running") return false;
    if (result.outcome === "ready") await checkCurrent(validateCurrent, tx, job, "publication");
    await settleBudget(tx, firestore, job, "terminal");
    const ready = result.outcome === "ready";
    tx.update(ref, processingChanges(job, { phase: ready ? "ready" : result.outcome === "rejected" ? "failed" : "needs_reconciliation",
      active: false, leaseOwner: null, leaseUntil: 0, processingStage: ready ? "ready" : result.outcome === "rejected" ? "failed" : "needs_attention",
      errorCode: ready ? null : result.outcome === "rejected" ? "elevenlabs_request_rejected" : result.recoveryError ?? "elevenlabs_submission_uncertain",
      ...(ready ? { outputs: result.outputs, totalSegments: result.totalSegments } : {}) }, now));
    if (ready) enqueueVideoSearchShard(tx, firestore, job.assetId, job.sourceId);
    return true;
  });
}
module.exports = { PROVIDER, MODEL, ADAPTER_REVISION, AUDIO_ADAPTER_REVISION, MAX_INPUT_BYTES, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS, COLLECTION, LEASE_MS, INTENT_LEASE_MS, variantId, createJob, validJob, deferPreparation, waitForAudio, claimRecovery, attachSpool, cancelBeforeIntent, requestJob, claimJob, recordIntent, finishJob };
