"use strict";

const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { validJob, MODEL } = require("./video-transcript-byok-job");
const { validateSegments } = require("./video-transcript-worker");
const { transcriptExports, MAX_RESULT_BYTES } = require("./video-transcript-contract");
const IO_TIMEOUT_MS = 15_000;
const INPUT_BODY_TIMEOUT_MS = 600_000;
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = (body) => createHash("sha256").update(body).digest("hex");
const version = (value) => typeof value === "string" && value !== "null" && value.length > 0 && value.length <= 1024 &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function problem(code) { return Object.assign(new Error(code), { code }); }
function binding(job, claim) {
  validJob(job, job?.id);
  if (claim?.id !== job.id || !UUID.test(claim.attemptId ?? "") || claim.attemptId !== job.attemptId) throw problem("byok_storage_identity_invalid");
  // The validated variant ID includes every source/rendition/credential/settings field.
  return digest(JSON.stringify([1, job.id, claim.attemptId, job.requestedBy, job.provider, job.model, job.adapterRevision]));
}
const spoolKey = (job, claim) => `transcripts/results/${job.id}.${claim.attemptId}.normalized.json`;
function spoolEnvelope(job, claim, result) {
  const identityHash = binding(job, claim);
  if (!result || Object.keys(result).some((key) => !["segments", "model", "inputSha256", "transcriptionId"].includes(key)) ||
      result.model !== MODEL || typeof result.inputSha256 !== "string" || !HEX.test(result.inputSha256) ||
      (result.transcriptionId !== undefined && (typeof result.transcriptionId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(result.transcriptionId)))) {
    throw problem("byok_storage_result_invalid");
  }
  let segments;
  try { segments = validateSegments(result.segments, job); }
  catch { throw problem("byok_storage_result_invalid"); }
  if (result.segments.some((segment) => segment.endSeconds > job.durationSeconds)) throw problem("byok_storage_result_invalid");
  return { schemaVersion: 1, jobId: job.id, attemptId: claim.attemptId, identityHash, result: { ...result, segments } };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function boundedJson(value) {
  const Body = JSON.stringify(canonical(value));
  if (Buffer.byteLength(Body) > MAX_RESULT_BYTES) throw problem("byok_storage_result_too_large");
  return Body;
}
function metadata(job, claim, identityHash, sha256) {
  return { "byok-id": job.id, "byok-attempt": claim.attemptId, "byok-identity": identityHash, sha256 };
}
async function readBody(response) {
  const chunks = [];
  let size = 0;
  try {
    if (!(response.Body instanceof Readable) || !Number.isSafeInteger(response.ContentLength) ||
        response.ContentLength < 1 || response.ContentLength > MAX_RESULT_BYTES) throw problem("byok_storage_result_invalid");
    for await (const chunk of response.Body) {
      if (!(chunk instanceof Uint8Array)) throw problem("byok_storage_result_invalid");
      size += chunk.byteLength;
      if (size > MAX_RESULT_BYTES || size > response.ContentLength) throw problem("byok_storage_result_invalid");
      chunks.push(Buffer.from(chunk));
    }
    if (size !== response.ContentLength) throw problem("byok_storage_result_invalid");
    return Buffer.concat(chunks);
  } finally { response.Body?.destroy?.(); }
}

/** No credentials, default S3 client, provider calls or deletes. Caller owns current
 * authorization/source/attempt CAS before and after storage. Billing callback must
 * invoke the canonical billing guard; reads remain available during a billing stop.
 */
function createVideoTranscriptByokStorage(config, { s3, audio, privateAudio, assertBillingEnabledFn, onReceipt, clock = Date.now, ioTimeoutMs = IO_TIMEOUT_MS, inputBodyTimeoutMs = INPUT_BODY_TIMEOUT_MS } = {}) {
  if (!config || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket ?? "") ||
      !/^\d{12}$/.test(config.accountId ?? "") || typeof s3?.send !== "function" || typeof assertBillingEnabledFn !== "function" ||
      (onReceipt !== undefined && typeof onReceipt !== "function") || typeof clock !== "function" ||
      !Number.isInteger(ioTimeoutMs) || ioTimeoutMs < 1 || ioTimeoutMs > IO_TIMEOUT_MS ||
      !Number.isInteger(inputBodyTimeoutMs) || inputBodyTimeoutMs < 1 || inputBodyTimeoutMs > INPUT_BODY_TIMEOUT_MS) throw problem("byok_storage_config_invalid");
  const location = (Key) => ({ Bucket: config.bucket, Key, ExpectedBucketOwner: config.accountId });
  async function recordReceipt(receipt) {
    if (!onReceipt) return;
    try {
      if (await onReceipt(receipt) === false) throw problem("byok_storage_receipt_unavailable");
    } catch { throw problem("byok_storage_receipt_unavailable"); }
  }
  async function send(command, job, input = false, client = s3) {
    // The abort deadline includes SDK retries and response-body consumption.
    // Keep one second for the caller's durable state update before lease expiry.
    const remaining = job.leaseUntil - clock() - 1000;
    if (!Number.isFinite(remaining) || remaining <= 0) throw problem("byok_storage_deadline");
    const controller = new AbortController();
    let response, timer, rejectDeadline;
    const deadline = new Promise((resolve, reject) => { rejectDeadline = reject; });
    const expire = () => {
      controller.abort();
      response?.Body?.destroy?.(problem("byok_storage_deadline"));
      rejectDeadline(problem("byok_storage_deadline"));
    };
    timer = setTimeout(expire, Math.min(ioTimeoutMs, remaining));
    const pending = Promise.resolve().then(() => client.send(command, { abortSignal: controller.signal }));
    // A late adapter response must not retain a private socket after timeout.
    pending.then((late) => { if (controller.signal.aborted) late.Body?.destroy?.(); }, () => {});
    try {
      response = await Promise.race([pending, deadline]);
      if (!(response.Body instanceof Readable)) { clearTimeout(timer); return response; }
      response.Body.once("error", () => {});
      if (input) {
        // Input is consumed by the ten-minute provider call after the preparation
        // lease is renewed at intent. It has its own finite body deadline.
        clearTimeout(timer);
        timer = setTimeout(expire, inputBodyTimeoutMs);
      }
      const clear = () => clearTimeout(timer);
      response.Body.once("end", clear);
      response.Body.once("close", clear);
      return response;
    } catch (error) { clearTimeout(timer); response?.Body?.destroy?.(); throw error; }
  }
  async function get(Key, VersionId, job, input = false) {
    try { return await send(new GetObjectCommand({ ...location(Key), ...(VersionId ? { VersionId } : {}) }), job, input); }
    catch (error) {
      if (!input && ["NoSuchKey", "NoSuchVersion"].includes(error?.name)) {
        if (VersionId) throw problem("byok_storage_spool_missing");
        return null;
      }
      throw problem("byok_storage_unavailable");
    }
  }
  async function write(Key, Body, Metadata, ContentType, job, exclusive = false) {
    try { await assertBillingEnabledFn(); }
    catch { throw problem("byok_storage_billing_unavailable"); }
    let response;
    try {
      response = await send(new PutObjectCommand({ ...location(Key), Body, Metadata, ContentType,
        ContentLength: Buffer.byteLength(Body), ChecksumSHA256: Buffer.from(Metadata.sha256, "hex").toString("base64"),
        ServerSideEncryption: "AES256", CacheControl: "private, no-store", ...(exclusive ? { IfNoneMatch: "*" } : {}) }), job);
    } catch { throw problem("byok_storage_write_uncertain"); }
    if (!version(response.VersionId)) throw problem("byok_storage_write_uncertain");
    return response.VersionId;
  }
  function checkJob(job) {
    validJob(job, job?.id);
    const key = job.input.objectKey;
    if (job.identity.renditionBucket !== config.bucket || !key.startsWith("outputs/") ||
        key.split("/").some((part) => !part || part === "." || part === "..") ||
        !version(key) || !version(job.input.objectVersionId)) throw problem("byok_storage_input_invalid");
  }
  async function readPrivateAudio(job, receipt) {
    const delivery = privateAudio ? await privateAudio.read(receipt, { stream: true }).catch(() => null) : null;
    if (!delivery) return null;
    let response;
    try {
      response = await send(new GetObjectCommand({ Bucket: delivery.bucket, Key: delivery.key, IfMatch: delivery.etag }), job, true, delivery.client);
      if (response.ETag === delivery.etag && response.Metadata?.binding === delivery.id &&
          response.Metadata?.generation === delivery.generation && response.ContentLength === receipt.output.sizeBytes &&
          response.ContentType?.split(";")[0] === receipt.output.mimeType && response.Body instanceof Readable) return response;
      response.Body?.destroy?.();
      await privateAudio.enqueue(receipt, true).catch(() => null);
    } catch (error) {
      response?.Body?.destroy?.();
      if (["NotFound", "NoSuchKey"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) {
        await privateAudio.enqueue(receipt, true).catch(() => null);
      }
    }
    return null;
  }
  async function prepareInput(job) {
    checkJob(job);
    if (job.identity.inputRevision && !audio) throw problem("audio_preparation_waiting");
    if (audio && !job.identity.inputRevision) throw problem("byok_legacy_input_requires_readmission");
    const prepared = audio ? await audio.ensure(job) : null;
    const input = prepared?.receipt.output ?? job.input;
    const mimeType = prepared ? "audio/x-m4a" : "video/mp4";
    const privateResponse = prepared ? await readPrivateAudio(job, prepared.receipt) : null;
    const response = privateResponse ?? await get(input.objectKey, input.objectVersionId, job, true);
    if ((!privateResponse && response.VersionId !== input.objectVersionId) || response.ContentLength !== input.sizeBytes ||
        response.ContentType?.split(";")[0] !== mimeType || !(response.Body instanceof Readable)) {
      response.Body?.destroy?.();
      throw problem("byok_storage_input_changed");
    }
    return { input: { stream: response.Body, sizeBytes: response.ContentLength, versionId: input.objectVersionId,
      expectedVersionId: input.objectVersionId, durationSeconds: job.durationSeconds, mimeType,
      ...(prepared ? { sha256: input.sha256 } : {}) },
    cleanup: () => response.Body.destroy() };
  }
  async function recoverSpool(job, claim, receipt) {
    checkJob(job);
    const identityHash = binding(job, claim);
    const key = spoolKey(job, claim);
    if (receipt && (Object.keys(receipt).some((field) => !["key", "versionId", "sha256", "identityHash"].includes(field)) ||
        receipt.key !== key || !version(receipt.versionId) || !HEX.test(receipt.sha256 ?? "") || receipt.identityHash !== identityHash)) {
      throw problem("byok_storage_receipt_invalid");
    }
    const response = await get(key, receipt?.versionId, job);
    if (!response) return null;
    const Body = await readBody(response);
    const sha256 = digest(Body);
    if (!version(response.VersionId) || (receipt && (receipt.versionId !== response.VersionId || receipt.sha256 !== sha256)) ||
        JSON.stringify(Object.entries(response.Metadata ?? {}).sort()) !== JSON.stringify(Object.entries(metadata(job, claim, identityHash, sha256)).sort())) {
      throw problem("byok_storage_receipt_invalid");
    }
    let envelope;
    try { envelope = JSON.parse(Body.toString("utf8")); }
    catch { throw problem("byok_storage_result_invalid"); }
    const expected = spoolEnvelope(job, claim, envelope?.result);
    if (boundedJson(expected) !== Body.toString("utf8")) throw problem("byok_storage_identity_invalid");
    return { receipt: { key, versionId: response.VersionId, sha256, identityHash }, ...expected.result };
  }
  async function persistSpool(job, claim, result) {
    checkJob(job);
    const envelope = spoolEnvelope(job, claim, result);
    const Body = boundedJson(envelope);
    const sha256 = digest(Body);
    let recovered;
    // Without ListBucket, a missing key can return 403. Save the paid result
    // first; conditional create prevents replacing an existing attempt spool.
    try {
      const versionId = await write(spoolKey(job, claim), Body, metadata(job, claim, envelope.identityHash, sha256), "application/json", job, true);
      recovered = { receipt: { key: spoolKey(job, claim), versionId, sha256, identityHash: envelope.identityHash } };
    } catch (error) {
      if (error.code !== "byok_storage_write_uncertain") throw error;
      // One bounded recovery read covers a collision or lost write response.
      // A missing/denied read remains unresolved; this never restarts a provider.
      recovered = await recoverSpool(job, claim);
      if (!recovered) throw error;
    }
    if (recovered.receipt.sha256 !== sha256) throw problem("byok_storage_spool_conflict");
    await recordReceipt({ kind: "spool", ...recovered.receipt });
    return recovered.receipt;
  }
  async function finalizeExports(job, spool) {
    const claim = { id: job.id, attemptId: job.attemptId };
    // Re-read the pinned durable input rather than trusting a caller's mutable segments.
    if (!spool?.receipt) throw problem("byok_storage_receipt_invalid");
    const recovered = await recoverSpool(job, claim, spool.receipt);
    if (!recovered) throw problem("byok_storage_receipt_invalid");
    const formats = { "segments.json": JSON.stringify(recovered.segments), ...transcriptExports(recovered.segments) };
    if (Object.values(formats).some((body) => Buffer.byteLength(body) > MAX_RESULT_BYTES)) throw problem("byok_storage_result_too_large");
    const outputs = {};
    for (const [format, Body] of Object.entries(formats)) {
      const key = `transcripts/results/${job.id}.${format}`;
      const sha256 = digest(Body);
      const contentType = format === "segments.json" ? "application/json" : format === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8";
      const versionId = await write(key, Body, metadata(job, claim, recovered.receipt.identityHash, sha256), contentType, job);
      outputs[format] = versionId;
      await recordReceipt({ kind: "export", format, key, versionId, sha256, identityHash: recovered.receipt.identityHash });
    }
    return { outputs, totalSegments: recovered.segments.length };
  }
  return { prepareInput, persistSpool, recoverSpool, finalizeExports };
}
module.exports = { createVideoTranscriptByokStorage, spoolKey, IO_TIMEOUT_MS, INPUT_BODY_TIMEOUT_MS };
