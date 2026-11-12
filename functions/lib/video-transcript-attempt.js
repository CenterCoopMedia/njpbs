"use strict";

const { SourceMediaValidationError } = require("./source-media-contract");
const { sourceMatches } = require("./video-transcript-worker");
const { createHash } = require("node:crypto");
const { PAID_FALLBACK_POLICY } = require("./video-transcript-fallback-policy");

const TERMINAL_PHASES = new Set(["ready", "failed", "needs_reconciliation", "cancelled", "stale"]);
const FREE_RETRY_LIMITS = "mediaSourceTranscriptFreeRetryLimits";
const FREE_RETRY_DAILY_LIMIT = 5;
const JOB_ID = /^[a-f0-9]{64}$/;

function parseNewAttempt(value, attemptKey) {
  if (value !== undefined && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new SourceMediaValidationError("Previous transcript is invalid");
  }
  if (attemptKey !== undefined && (!value || typeof attemptKey !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attemptKey))) {
    throw new SourceMediaValidationError("Transcript attempt key is invalid");
  }
  return value === undefined ? {} : { newAttemptOf: value, ...(attemptKey ? { attemptKey } : {}) };
}

async function transcriptAttempt(tx, firestore, asset, source, newAttemptOf, attemptKey) {
  if (!newAttemptOf) return {};
  const previous = (await tx.get(firestore.collection("mediaSourceTranscriptJobs").doc(newAttemptOf))).data();
  if (!previous || previous.id !== newAttemptOf || previous.assetId !== asset.id || !sourceMatches(asset, previous, source)) {
    throw new SourceMediaValidationError("Previous transcript is not available for this video", 409);
  }
  if (previous.active !== false || !TERMINAL_PHASES.has(previous.phase)) {
    throw new SourceMediaValidationError("Wait for the previous transcript request to finish", 409);
  }
  const generation = (previous.attemptGeneration ?? previous.identity?.attemptGeneration ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new SourceMediaValidationError("Transcript attempt is unavailable", 409);
  }
  return { attemptGeneration: generation, previousTranscriptId: newAttemptOf, ...(attemptKey ? { attemptKey } : {}) };
}

async function readAttemptSlot(tx, firestore, asset, source, request) {
  const id = createHash("sha256").update(JSON.stringify(["transcript-attempt-slot-v1", source.id, source.bucket,
    asset.id, asset.objectKey, asset.objectVersionId, asset.sizeBytes, request.languageCode, request.maxSpeakers])).digest("hex");
  const ref = firestore.collection("mediaSourceTranscriptAttempts").doc(id);
  const activeId = (await tx.get(ref)).data()?.activeId;
  const job = activeId ? (await tx.get(firestore.collection("mediaSourceTranscriptJobs").doc(activeId))).data() : null;
  if (activeId && (!job || job.id !== activeId)) {
    throw new SourceMediaValidationError("Transcript request history needs an administrator's check", 503);
  }
  if (job?.active) return { ref, job };
  // Adopt in-flight work admitted before attempt slots existed, without resetting it.
  const page = await tx.get(firestore.collection("mediaSourceTranscriptJobs")
    .where("assetId", "==", asset.id).where("active", "==", true).limit(20));
  const existing = page.docs.map(row => row.data()).find(value => value.languageCode === request.languageCode &&
    value.maxSpeakers === request.maxSpeakers && sourceMatches(asset, value, source));
  if (!existing && page.docs.length === 20) {
    throw new SourceMediaValidationError("Transcript request history needs an administrator's check", 503);
  }
  return { ref, job: existing ?? null };
}

function assertAttemptProvider(job, provider, credential) {
  const samePolicy = provider === "local" ? job.requestedProvider === "local"
    : provider !== "amazon-transcribe" || job.processingPolicy !== PAID_FALLBACK_POLICY || job.paidFallbackState === "amazon";
  if (!samePolicy || job.provider !== provider || (credential && (job.identity?.credentialId !== credential.id ||
      job.identity?.credentialRevision !== credential.revision))) {
    throw new SourceMediaValidationError("Another transcript request is processing for this video. Check saved transcripts", 409);
  }
}

function validUtcDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const value = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === day;
}

function limitError() {
  return new SourceMediaValidationError("Free transcript retry limits need an administrator's check", 503);
}

async function pointedRetryJob(tx, firestore, record, expected) {
  if (!record) return null;
  const job = (await tx.get(firestore.collection("mediaSourceTranscriptJobs").doc(record.activeId))).data();
  if (!job || job.id !== record.activeId || job.provider !== "local" || job.requestedProvider !== "local" ||
      (expected.previousTranscriptId && job.previousTranscriptId !== expected.previousTranscriptId) ||
      (expected.requestedBy && job.requestedBy !== expected.requestedBy) || typeof job.active !== "boolean" ||
      job.active === TERMINAL_PHASES.has(job.phase)) {
    throw limitError();
  }
  return job;
}

async function readFreeRetryLimits(tx, firestore, previousTranscriptId, actorUid, day) {
  const predecessorRef = firestore.collection(FREE_RETRY_LIMITS).doc(createHash("sha256")
    .update(JSON.stringify(["free-transcript-retry-predecessor-v1", previousTranscriptId])).digest("hex"));
  const actorRef = firestore.collection(FREE_RETRY_LIMITS).doc(createHash("sha256")
    .update(JSON.stringify(["free-transcript-retry-actor-v1", actorUid])).digest("hex"));
  const [predecessorSnapshot, actorSnapshot] = await Promise.all([tx.get(predecessorRef), tx.get(actorRef)]);
  const predecessor = predecessorSnapshot.data();
  const actor = actorSnapshot.data();
  if (predecessorSnapshot.exists && (!predecessor || Object.keys(predecessor).sort().join(",") !== "activeId,kind,previousTranscriptId" ||
      predecessor.kind !== "predecessor" || predecessor.previousTranscriptId !== previousTranscriptId || !JOB_ID.test(predecessor.activeId))) {
    throw limitError();
  }
  if (actorSnapshot.exists && (!actor || Object.keys(actor).sort().join(",") !== "activeId,count,day,kind" ||
      actor.kind !== "actor" || !validUtcDay(actor.day) || !Number.isSafeInteger(actor.count) ||
      actor.count < 1 || actor.count > FREE_RETRY_DAILY_LIMIT || !JOB_ID.test(actor.activeId))) {
    throw limitError();
  }
  const [predecessorJob, actorJob] = await Promise.all([
    pointedRetryJob(tx, firestore, predecessor, { previousTranscriptId }),
    pointedRetryJob(tx, firestore, actor, { requestedBy: actorUid }),
  ]);
  if (predecessorJob?.active) {
    throw new SourceMediaValidationError("A free transcript retry is already active for this earlier request", 429);
  }
  if (actorJob?.active) {
    throw new SourceMediaValidationError("You already have an active free transcript retry", 429);
  }
  const count = actor?.day === day ? actor.count : 0;
  if (count >= FREE_RETRY_DAILY_LIMIT) {
    throw new SourceMediaValidationError("You have reached five free transcript retries today", 429);
  }
  return { predecessorRef, actorRef, day, count };
}

function reserveFreeRetryLimits(tx, limits, previousTranscriptId, id) {
  tx.set(limits.predecessorRef, { kind: "predecessor", previousTranscriptId, activeId: id });
  tx.set(limits.actorRef, { kind: "actor", day: limits.day, count: limits.count + 1, activeId: id });
}

module.exports = { parseNewAttempt, transcriptAttempt, readAttemptSlot, assertAttemptProvider,
  readFreeRetryLimits, reserveFreeRetryLimits };
