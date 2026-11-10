"use strict";

const { createHash, randomUUID } = require("node:crypto");

const COLLECTION = "mediaTranscriptAudioPreparations";
const PREPARATION_REVISION = "aac-m4a-copy-v1";
const MAX_INPUT_BYTES = 2_000_000_000;
const MAX_DURATION_SECONDS = 7200;
const MAX_INVOCATIONS_PER_GENERATION = 2;
const MAX_DURATION_DRIFT_SECONDS = 0.5;
const EVENT_MAX_AGE_MS = 900_000;
const EXECUTION_TIMEOUT_MS = 900_000;
const LEASE_MS = EVENT_MAX_AGE_MS + EXECUTION_TIMEOUT_MS + 30_000;
const HEX = /^[a-f0-9]{64}$/;
const INVOCATION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PREPARATION_STATES = new Set(["pending", "waiting", "ready", "failed", "retryable"]);
const TERMINAL_FAILURE_CODES = Object.freeze([
  "input_changed",
  "audio_track_missing",
  "audio_codec_unsupported",
  "audio_timeline_unsupported",
  "audio_duration_unsupported",
  "audio_output_invalid",
]);
const TERMINAL_FAILURES = new Set(TERMINAL_FAILURE_CODES);

function problem(code) {
  return Object.assign(new Error(code), { code });
}

function exactFields(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function opaque(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw problem("audio_preparation_time_invalid");
  return value;
}

function inputIdentity(job, renditionBucket, ffmpegArtifactSha256) {
  if ((job?.identity?.renditionBucket !== undefined && job.identity.renditionBucket !== renditionBucket) ||
      (job?.renditionBucket !== undefined && job.renditionBucket !== renditionBucket)) {
    throw problem("audio_preparation_identity_invalid");
  }
  const identity = {
    sourceId: job?.sourceId,
    assetId: job?.assetId,
    originalBucket: job?.sourceBucket,
    originalKey: job?.sourceObjectKey,
    originalVersion: job?.sourceObjectVersionId,
    originalSize: job?.sourceSizeBytes,
    renditionBucket,
    renditionKey: job?.input?.objectKey,
    renditionVersion: job?.input?.objectVersionId,
    renditionSize: job?.input?.sizeBytes,
    durationSeconds: job?.durationSeconds,
    revision: PREPARATION_REVISION,
    ffmpegArtifactSha256,
  };
  if (identity.sourceId !== "video-library" || !opaque(identity.assetId) ||
      !opaque(identity.originalBucket) || !opaque(identity.originalKey) || !opaque(identity.originalVersion) ||
      !Number.isSafeInteger(identity.originalSize) || identity.originalSize < 1 ||
      !opaque(identity.renditionBucket) || !/^outputs\//.test(identity.renditionKey ?? "") ||
      !opaque(identity.renditionKey) || !opaque(identity.renditionVersion) ||
      !Number.isSafeInteger(identity.renditionSize) || identity.renditionSize < 1 ||
      identity.renditionSize > MAX_INPUT_BYTES || !Number.isFinite(identity.durationSeconds) ||
      identity.durationSeconds < 0.1 || identity.durationSeconds > MAX_DURATION_SECONDS ||
      job?.input?.durationSeconds !== identity.durationSeconds ||
      !HEX.test(ffmpegArtifactSha256 ?? "")) throw problem("audio_preparation_identity_invalid");
  return identity;
}

function preparationId(job, renditionBucket, ffmpegArtifactSha256) {
  return digest(inputIdentity(job, renditionBucket, ffmpegArtifactSha256));
}

function preparationKeys(id, invocationId) {
  if (!HEX.test(id ?? "") || !INVOCATION.test(invocationId ?? "")) {
    throw problem("audio_preparation_key_invalid");
  }
  const prefix = `transcripts/inputs/audio/${id}`;
  return {
    audioKey: `${prefix}/attempts/${invocationId}/input.m4a`,
    receiptKey: `${prefix}/receipts/${invocationId}.json`,
  };
}

function audioStream(value) {
  const fields = ["codec", "profile", "sampleRate", "channels", "startSamples", "durationSamples", "frameSamples", "packetCount", "elementarySha256"];
  if (!exactFields(value, fields) || value.codec !== "aac" || value.profile !== "LC" ||
      !Number.isSafeInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 48000 ||
      !Number.isSafeInteger(value.channels) || value.channels < 1 || value.channels > 2 ||
      !Number.isSafeInteger(value.startSamples) || Math.abs(value.startSamples) > 1 ||
      !Number.isSafeInteger(value.durationSamples) || value.durationSamples < Math.ceil(value.sampleRate / 10) ||
      value.durationSamples > value.sampleRate * MAX_DURATION_SECONDS || value.frameSamples !== 1024 ||
      !Number.isSafeInteger(value.packetCount) || value.packetCount < 1 ||
      !HEX.test(value.elementarySha256 ?? "")) throw problem("audio_preparation_receipt_invalid");
  return value;
}

function validateReceiptBase(identity, id, invocationId, receipt, fields) {
  if (!exactFields(receipt, fields) || receipt.schemaVersion !== 1 || receipt.preparationId !== id ||
      receipt.invocationId !== invocationId || receipt.revision !== PREPARATION_REVISION ||
      receipt.ffmpegArtifactSha256 !== identity.ffmpegArtifactSha256 ||
      !exactFields(receipt.input, ["objectKey", "objectVersionId", "sizeBytes"]) ||
      receipt.input.objectKey !== identity.renditionKey || receipt.input.objectVersionId !== identity.renditionVersion ||
      receipt.input.sizeBytes !== identity.renditionSize) throw problem("audio_preparation_receipt_invalid");
}

function validateReceipt(identity, id, invocationId, receipt) {
  const base = ["schemaVersion", "preparationId", "invocationId", "revision", "ffmpegArtifactSha256", "outcome", "input"];
  if (receipt?.outcome === "failed") {
    validateReceiptBase(identity, id, invocationId, receipt, [...base, "failureCode"]);
    if (!TERMINAL_FAILURES.has(receipt.failureCode)) throw problem("audio_preparation_receipt_invalid");
    return structuredClone(receipt);
  }
  validateReceiptBase(identity, id, invocationId, receipt, [...base, "output", "sourceAudio", "outputAudio"]);
  if (receipt.outcome !== "ready" ||
      !exactFields(receipt.output, ["objectKey", "objectVersionId", "sizeBytes", "sha256", "mimeType"]) ||
      receipt.output.objectKey !== preparationKeys(id, invocationId).audioKey || !opaque(receipt.output.objectVersionId) ||
      !Number.isSafeInteger(receipt.output.sizeBytes) || receipt.output.sizeBytes < 1 ||
      receipt.output.sizeBytes > identity.renditionSize || !HEX.test(receipt.output.sha256 ?? "") ||
      receipt.output.mimeType !== "audio/x-m4a") throw problem("audio_preparation_receipt_invalid");
  const source = audioStream(receipt.sourceAudio);
  const output = audioStream(receipt.outputAudio);
  if (source.sampleRate !== output.sampleRate || source.channels !== output.channels ||
      Math.abs(source.startSamples - output.startSamples) > 1 ||
      source.frameSamples !== output.frameSamples || source.packetCount !== output.packetCount ||
      source.elementarySha256 !== output.elementarySha256 ||
      Math.abs(source.durationSamples - output.durationSamples) > source.frameSamples) {
    throw problem("audio_preparation_receipt_invalid");
  }
  const duration = source.durationSamples / source.sampleRate;
  if (Math.abs(duration - identity.durationSeconds) > MAX_DURATION_DRIFT_SECONDS) {
    throw problem("audio_preparation_receipt_invalid");
  }
  return structuredClone(receipt);
}

function validRecord(record, id) {
  if (record?.state === "deleting") {
    // Version cleanup freezes the existing record without changing its receipt.
    // Validate its original shape; the audio sweep may finish the same deletion.
    const state = record.receipt ? record.receipt.outcome === "ready" ? "ready" : "failed"
      : record.failureCode ? "failed" : record.nextInvocationAt ? "retryable" : record.invocationId ? "waiting" : "pending";
    validRecord({ ...record, state }, id);
    return record;
  }
  const state = record?.state;
  const base = ["schemaVersion", "id", "identity", "state", "generation", "invocationCount",
    "totalInvocationCount", "leaseUntil", "createdAt", "updatedAt"];
  const fields = state === "ready" ? [...base, "invocationId", "receipt"]
    : state === "waiting" ? [...base, "invocationId"]
      : state === "failed" ? [...base, "invocationId", "failureCode", ...(record?.receipt ? ["receipt"] : [])]
        : state === "retryable" ? [...base, "nextInvocationAt"] : base;
  if (!exactFields(record, fields) ||
      record.schemaVersion !== 1 || record.id !== id || !PREPARATION_STATES.has(state) ||
      digest(record.identity) !== id || !Number.isSafeInteger(record.invocationCount) ||
      record.invocationCount < 0 || record.invocationCount > MAX_INVOCATIONS_PER_GENERATION ||
      !Number.isSafeInteger(record.generation) || record.generation < 1 ||
      !Number.isSafeInteger(record.totalInvocationCount) || record.totalInvocationCount < record.invocationCount ||
      (["waiting", "ready"].includes(state) && record.invocationCount < 1) ||
      (state === "failed" && (record.invocationCount < 1 ||
        !["attempts_exhausted", ...TERMINAL_FAILURES].includes(record.failureCode))) ||
      (state === "pending" && record.invocationCount !== 0) ||
      (state === "retryable" && (!Number.isSafeInteger(record.nextInvocationAt) || record.nextInvocationAt <= record.updatedAt)) ||
      !Number.isSafeInteger(record.leaseUntil) || !Number.isSafeInteger(record.createdAt) ||
      !Number.isSafeInteger(record.updatedAt) || Math.min(record.leaseUntil, record.createdAt, record.updatedAt) < 0 ||
      record.updatedAt < record.createdAt || ["waiting", "ready", "failed"].includes(state) !== INVOCATION.test(record.invocationId ?? "") ||
      (state === "waiting" && record.leaseUntil <= record.updatedAt) ||
      (state !== "waiting" && record.leaseUntil !== 0)) throw problem("audio_preparation_record_invalid");
  if (state === "ready" && validateReceipt(record.identity, id, record.invocationId, record.receipt).outcome !== "ready") {
    throw problem("audio_preparation_record_invalid");
  }
  if (state === "failed" && ((record.receipt &&
      (validateReceipt(record.identity, id, record.invocationId, record.receipt).outcome !== "failed" ||
       record.receipt.failureCode !== record.failureCode)) ||
      (!record.receipt && (record.failureCode !== "attempts_exhausted" ||
       record.invocationCount !== MAX_INVOCATIONS_PER_GENERATION)))) {
    throw problem("audio_preparation_record_invalid");
  }
  return record;
}

function refFor(firestore, id) {
  if (!HEX.test(id ?? "")) throw problem("audio_preparation_id_invalid");
  return firestore.collection(COLLECTION).doc(id);
}

function waitingRecord(identity, id, previous, now, invocationId) {
  const totalInvocationCount = (previous?.totalInvocationCount ?? 0) + 1;
  if (!Number.isSafeInteger(totalInvocationCount)) throw problem("audio_preparation_record_invalid");
  return {
    schemaVersion: 1,
    id,
    identity,
    state: "waiting",
    invocationId,
    generation: previous?.generation ?? 1,
    invocationCount: (previous?.invocationCount ?? 0) + 1,
    totalInvocationCount,
    leaseUntil: now + LEASE_MS,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

async function claimPreparation({ firestore, job, renditionBucket, ffmpegArtifactSha256, now = Date.now(), uuid = randomUUID }) {
  timestamp(now);
  const identity = inputIdentity(job, renditionBucket, ffmpegArtifactSha256);
  const id = digest(identity);
  return firestore.runTransaction(async (tx) => {
    const ref = refFor(firestore, id);
    const previous = (await tx.get(ref)).data();
    if (previous) validRecord(previous, id);
    if (previous?.state === "deleting") return { outcome: "backoff", id, leaseUntil: previous.leaseUntil };
    if (previous?.state === "ready") return { outcome: "ready", id, receipt: structuredClone(previous.receipt) };
    if (previous?.state === "failed") return { outcome: "failed", id, failureCode: previous.failureCode };
    if (previous?.state === "retryable" && previous.nextInvocationAt > now) {
      return { outcome: "backoff", id, leaseUntil: previous.nextInvocationAt };
    }
    if (previous?.state === "waiting" && previous.leaseUntil > now) {
      return { outcome: "waiting", id, invocationId: previous.invocationId, leaseUntil: previous.leaseUntil };
    }
    if ((previous?.invocationCount ?? 0) >= MAX_INVOCATIONS_PER_GENERATION) {
      const failed = { schemaVersion: 1, id, identity, state: "failed", generation: previous.generation,
        invocationId: previous.invocationId, invocationCount: previous.invocationCount,
        totalInvocationCount: previous.totalInvocationCount, failureCode: "attempts_exhausted",
        leaseUntil: 0, createdAt: previous.createdAt, updatedAt: now };
      tx.set(ref, failed);
      return { outcome: "failed", id, failureCode: failed.failureCode };
    }
    const invocationId = uuid();
    if (!INVOCATION.test(invocationId ?? "")) throw problem("audio_preparation_invocation_invalid");
    const next = waitingRecord(identity, id, previous, now, invocationId);
    tx.set(ref, next);
    return { outcome: "invoke", id, invocationId, leaseUntil: next.leaseUntil,
      keys: preparationKeys(id, invocationId), identity: structuredClone(identity) };
  });
}

async function rejectInvocation({ firestore, id, invocationId, now = Date.now() }) {
  timestamp(now);
  return firestore.runTransaction(async (tx) => {
    const ref = refFor(firestore, id);
    const record = (await tx.get(ref)).data();
    validRecord(record, id);
    if (record.state !== "waiting" || record.invocationId !== invocationId) return false;
    // A confirmed API rejection queued no event. Keep the count of accepted or
    // uncertain invocations, with a one-minute infrastructure retry backoff.
    const { invocationId: rejectedId, ...rest } = record;
    void rejectedId;
    tx.set(ref, { ...rest, state: "retryable", invocationCount: record.invocationCount - 1,
      leaseUntil: 0, nextInvocationAt: now + 60_000, updatedAt: now });
    return true;
  });
}

function verifyAcceptedOutput(receipt, verifiedOutput) {
  if (receipt.outcome === "failed") {
    if (verifiedOutput !== undefined) throw problem("audio_preparation_output_unverified");
    return;
  }
  if (!exactFields(verifiedOutput, ["objectKey", "objectVersionId", "sizeBytes", "sha256", "mimeType"]) ||
      digest(verifiedOutput) !== digest(receipt.output)) throw problem("audio_preparation_output_unverified");
}

async function acceptPreparation({ firestore, id, invocationId, receipt, verifiedOutput, now = Date.now() }) {
  timestamp(now);
  return firestore.runTransaction(async (tx) => {
    const ref = refFor(firestore, id);
    const record = (await tx.get(ref)).data();
    validRecord(record, id);
    if (["ready", "failed"].includes(record.state)) {
      if (record.invocationId !== invocationId) return { outcome: "stale" };
      const accepted = validateReceipt(record.identity, id, record.invocationId, receipt);
      verifyAcceptedOutput(accepted, verifiedOutput);
      return record.receipt && digest(accepted) === digest(record.receipt)
        ? { outcome: accepted.outcome, ...(accepted.outcome === "ready" ? { receipt: accepted } : { failureCode: accepted.failureCode }) }
        : { outcome: "stale" };
    }
    if (record.state !== "waiting" || record.invocationId !== invocationId || record.leaseUntil <= now) return { outcome: "stale" };
    const accepted = validateReceipt(record.identity, id, invocationId, receipt);
    verifyAcceptedOutput(accepted, verifiedOutput);
    if (accepted.outcome === "failed") {
      tx.set(ref, { ...record, state: "failed", failureCode: accepted.failureCode,
        leaseUntil: 0, updatedAt: now, receipt: accepted });
      return { outcome: "failed", failureCode: accepted.failureCode };
    }
    const ready = { ...record, state: "ready", leaseUntil: 0, updatedAt: now, receipt: accepted };
    tx.set(ref, ready);
    return { outcome: "ready", receipt: accepted };
  });
}

async function invalidatePreparation({ firestore, id, receipt, reason, now = Date.now() }) {
  timestamp(now);
  if (!["output_missing", "output_unreadable"].includes(reason) || !receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw problem("audio_preparation_invalidation_invalid");
  }
  return firestore.runTransaction(async (tx) => {
    const ref = refFor(firestore, id);
    const record = (await tx.get(ref)).data();
    validRecord(record, id);
    if (record.state !== "ready" || digest(record.receipt) !== digest(receipt)) return false;
    if (record.generation >= Number.MAX_SAFE_INTEGER) throw problem("audio_preparation_invalidation_invalid");
    tx.set(ref, { schemaVersion: 1, id, identity: record.identity, state: "pending",
      generation: record.generation + 1, invocationCount: 0, totalInvocationCount: record.totalInvocationCount,
      leaseUntil: 0, createdAt: record.createdAt, updatedAt: now });
    return true;
  });
}

module.exports = {
  COLLECTION,
  PREPARATION_REVISION,
  MAX_INPUT_BYTES,
  MAX_DURATION_SECONDS,
  MAX_INVOCATIONS_PER_GENERATION,
  MAX_DURATION_DRIFT_SECONDS,
  EVENT_MAX_AGE_MS,
  EXECUTION_TIMEOUT_MS,
  LEASE_MS,
  TERMINAL_FAILURE_CODES,
  inputIdentity,
  preparationId,
  preparationKeys,
  validateReceipt,
  claimPreparation,
  acceptPreparation,
  invalidatePreparation,
  rejectInvocation,
};
