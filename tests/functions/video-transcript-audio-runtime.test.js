import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
const contract = require("../../functions/lib/video-transcript-audio-input");
const { createTranscriptAudioRuntime, USES, finalUse } = require("../../functions/lib/video-transcript-audio-runtime");
const { createVideoTranscriptProcessor, inputKey } = require("../../functions/lib/video-transcript-processor");
const ARTIFACT = "a".repeat(64);
const config = { region: "us-east-2", bucket: "renditions", accountId: "123456789012", audioEnabled: true,
  audioFunctionArn: "arn:aws:lambda:us-east-2:123456789012:function:njpbs-boardwalk-transcript-audio-worker",
  audioArtifactSha256: ARTIFACT };
const JOBS = "mediaSourceTranscriptJobs";
const ALIGNMENTS = "mediaSourceTranscriptAlignmentJobs";
const now = 1800000000000;

// Firestore is a network boundary. Transactions serialize and reject reads
// after writes, as the real service does; expected states come from #2149.
function database() {
  const rows = new Map();
  let tail = Promise.resolve();
  const ref = (path) => ({ path, id: path.split("/").at(-1),
    get: async () => snapshot(path), set: async (value) => rows.set(path, structuredClone(value)) });
  const snapshot = (path) => ({ ref: ref(path), id: path.split("/").at(-1), exists: rows.has(path),
    data: () => structuredClone(rows.get(path)) });
  const query = (name, filters = [], after = "", limit = 100, order = "__name__") => ({
    doc: (id) => ref(`${name}/${id}`), where: (key, operator, value) => query(name, [...filters, [key, value]], after, limit, order),
    orderBy: (key) => query(name, filters, after, limit, key), startAfter: (value) => query(name, filters, value, limit, order),
    limit: (value) => query(name, filters, after, value, order),
    get: async () => ({ docs: [...rows.keys()].filter((path) => path.startsWith(`${name}/`) &&
      path.split("/").at(-1) > after && filters.every(([key, value]) => rows.get(path)[key] === value)).sort((left, right) => {
      const a = order === "__name__" ? left : rows.get(left)[order];
      const b = order === "__name__" ? right : rows.get(right)[order];
      return a < b ? -1 : a > b ? 1 : left.localeCompare(right);
    }).slice(0, limit).map(snapshot) }),
  });
  const firestore = { doc: ref, collection: (name) => query(name), runTransaction: (fn) => {
    const run = tail.then(async () => {
      const writes = [];
      const value = await fn({ get: async (reference) => {
        if (writes.length) throw Error("read after write");
        return snapshot(reference.path);
      }, set: (reference, value) => writes.push(() => rows.set(reference.path, structuredClone(value))),
      update: (reference, value) => writes.push(() => rows.set(reference.path, { ...rows.get(reference.path), ...structuredClone(value) })) });
      writes.forEach((write) => write());
      return value;
    });
    tail = run.catch(() => {});
    return run;
  } };
  return { rows, firestore };
}

function job(id = "b".repeat(64)) {
  return { id, active: true, provider: "local", phase: "pending", sourceId: "video-library", assetId: "asset",
    sourceBucket: "originals", sourceObjectKey: "objects/source.mov", sourceObjectVersionId: "original-v1", sourceSizeBytes: 1000,
    input: { objectKey: "outputs/asset/web.mp4", objectVersionId: "web-v1", sizeBytes: 900, durationSeconds: 20 }, durationSeconds: 20 };
}

function receipt(payload) {
  const stream = { codec: "aac", profile: "LC", sampleRate: 48000, channels: 2, startSamples: 0,
    durationSamples: 960000, frameSamples: 1024, packetCount: 938, elementarySha256: "d".repeat(64) };
  return { schemaVersion: 1, preparationId: payload.preparationId, invocationId: payload.invocationId,
    revision: contract.PREPARATION_REVISION, ffmpegArtifactSha256: ARTIFACT, outcome: "ready",
    input: { objectKey: "outputs/asset/web.mp4", objectVersionId: "web-v1", sizeBytes: 900 },
    output: { objectKey: payload.output.audioKey, objectVersionId: "audio-version-1", sizeBytes: 120,
      sha256: "c".repeat(64), mimeType: "audio/x-m4a" }, sourceAudio: stream, outputAudio: { ...stream } };
}

function setup() {
  const db = database();
  const objects = new Map();
  const calls = [];
  const invocations = [];
  const warnings = [];
  let failDelete = false;
  let beforeDelete = async () => {};
  let invokeError;
  let audioHeadError;
  let webHead = {};
  let webHeadError;
  let time = now;
  const s3 = { send: async (command) => {
    const value = command.input;
    calls.push({ type: command.constructor.name, ...value });
    expect(value.Bucket).toBe(config.bucket);
    expect(value.ExpectedBucketOwner).toBe(config.accountId);
    if (command.constructor.name === "HeadObjectCommand" && value.Key === job().input.objectKey) {
      if (webHeadError) throw webHeadError;
      return { VersionId: "web-v1", ContentLength: 900, ...webHead };
    }
    if (command.constructor.name === "HeadObjectCommand" && value.Key.startsWith("transcripts/inputs/audio/") && audioHeadError) {
      throw audioHeadError;
    }
    if (command.constructor.name === "DeleteObjectCommand") {
      await beforeDelete();
      if (failDelete) throw Error("temporary S3 failure");
      objects.delete(`${value.Key}:${value.VersionId}`);
      return {};
    }
    if (command.constructor.name === "CopyObjectCommand") return { VersionId: "amazon-audio-version-1" };
    const object = objects.get(value.VersionId ? `${value.Key}:${value.VersionId}` : value.Key);
    if (!object) throw Object.assign(Error("missing"), { name: "NoSuchKey" });
    return { ...object, ...(object.bytes ? { Body: Readable.from([object.bytes]) } : {}) };
  } };
  const runtime = createTranscriptAudioRuntime(config, { ...db, s3, clock: () => time,
    lambda: { send: async (command) => { invocations.push(JSON.parse(Buffer.from(command.input.Payload)));
      if (invokeError) throw invokeError; return { StatusCode: 202 }; } },
    assertBillingEnabled: () => require("../../functions/lib/billing-state").assertBillingEnabled(db.firestore),
    log: { warn: (...args) => warnings.push(args) } });
  const add = (value) => { db.rows.set(`${JOBS}/${value.id}`, structuredClone(value)); return value; };
  const finishPreparation = () => {
    const output = receipt(invocations.at(-1));
    const bytes = Buffer.from(JSON.stringify(output));
    objects.set(invocations.at(-1).output.receiptKey, { VersionId: "receipt-v1", ContentLength: bytes.length, bytes });
    objects.set(`${output.output.objectKey}:${output.output.objectVersionId}`, { VersionId: output.output.objectVersionId,
      ContentLength: 120, ContentType: "audio/x-m4a", Metadata: { sha256: "c".repeat(64), "preparation-id": output.preparationId,
        "invocation-id": output.invocationId, "artifact-sha256": ARTIFACT } });
    return output;
  };
  return { ...db, runtime, s3, calls, invocations, warnings, add, finishPreparation,
    objects, clock: () => time, webHead: (patch) => { webHead = patch; },
    failAudioHead: (error) => { audioHeadError = error; },
    failWebHead: (error) => { webHeadError = error; },
    rejectInvoke: (error) => { invokeError = error; }, advance: (ms) => { time += ms; },
    failDeletes: (value) => { failDelete = value; }, beforeDelete: (fn) => { beforeDelete = fn; } };
}

async function ready() {
  const s = setup();
  const source = s.add(job());
  await expect(s.runtime.ensure(source)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
  const receipt = s.finishPreparation();
  const bound = await s.runtime.ensure(source);
  return { ...s, source, receipt, bound };
}

function localProcessor(s) {
  const source = { id: "video-library", bucket: "originals", prefix: "" };
  const base = job();
  const asset = { lifecycle: "active", sourceId: source.id, objectKey: base.sourceObjectKey,
    objectVersionId: base.sourceObjectVersionId, sizeBytes: base.sourceSizeBytes,
    rendition: { state: "ready", web: base.input } };
  s.rows.set("mediaSourceAssets/asset", asset);
  return createVideoTranscriptProcessor({ ...config, source }, { firestore: s.firestore, s3: s.s3,
    credentials: async () => ({}), audio: s.runtime, clock: s.clock, transcribe: {}, log: { warn() {} } });
}

describe("shared audio inputs and deletion fencing", () => {
  it("invokes once and waits without any MP4 download or repeated start", async () => {
    const s = setup(); const source = s.add(job());
    await expect(s.runtime.ensure(source)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    await expect(s.runtime.ensure(source)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    expect(s.invocations).toHaveLength(1);
    expect(s.invocations[0].input).toEqual({ bucket: "renditions", ...source.input });
    expect(s.calls.filter((call) => call.type === "GetObjectCommand").every((call) => !call.Key.startsWith("outputs/"))).toBe(true);
  });

  it("keeps the restore guard before preparing or releasing archived viewing audio", async () => {
    const s = setup(); const source = s.add(job());
    s.webHead({ ArchiveStatus: "ARCHIVE_ACCESS" });
    await expect(s.runtime.ensure(source)).rejects.toMatchObject({ code: "original_archived" });
    expect(s.invocations).toHaveLength(0);
    expect([...s.rows.keys()].some((key) => key.startsWith(`${contract.COLLECTION}/`))).toBe(false);
  });

  it("shares one pinned M4A among local, paid and alignment jobs until all are final", async () => {
    const s = await ready();
    const paid = s.add({ ...job("e".repeat(64)), provider: "elevenlabs" });
    const alignment = { id: "f".repeat(64), active: true, phase: "running", transcriptId: s.source.id };
    s.rows.set(`${ALIGNMENTS}/${alignment.id}`, alignment);
    expect(await s.runtime.ensure(paid)).toEqual(s.bound);
    expect(await s.runtime.ensure(s.source, { collection: ALIGNMENTS, id: alignment.id })).toEqual(s.bound);
    Object.assign(s.rows.get(`${JOBS}/${s.source.id}`), { active: false, phase: "ready" });
    expect(await s.runtime.cleanupReceipt(s.receipt)).toBe(false);
    Object.assign(s.rows.get(`${JOBS}/${paid.id}`), { active: false, phase: "needs_reconciliation", submissionIntentAt: "paid start" });
    Object.assign(s.rows.get(`${ALIGNMENTS}/${alignment.id}`), { active: false, phase: "complete" });
    expect(await s.runtime.cleanupReceipt(s.receipt)).toBe(false);
    Object.assign(s.rows.get(`${JOBS}/${paid.id}`), { phase: "ready" });
    expect(await s.runtime.cleanupReceipt(s.receipt)).toBe(true);
    expect(s.calls.filter((call) => call.type === "DeleteObjectCommand")).toEqual([
      expect.objectContaining({ Key: s.receipt.output.objectKey, VersionId: "audio-version-1" }),
    ]);
    expect(s.rows.get(`${contract.COLLECTION}/${s.receipt.preparationId}`).state).toBe("pending");
    expect(s.invocations).toHaveLength(1);
  });

  it("fences a new reader while deletion is in flight, then prepares a new generation", async () => {
    const s = await ready();
    Object.assign(s.rows.get(`${JOBS}/${s.source.id}`), { active: false, phase: "ready" });
    let entered, release;
    const started = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    s.beforeDelete(async () => { entered(); await held; });
    const cleanup = s.runtime.cleanupReceipt(s.receipt);
    await started;
    const next = s.add(job("e".repeat(64)));
    await expect(s.runtime.ensure(next)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    expect(s.rows.get(`${JOBS}/${next.id}`).audioInput).toBeUndefined();
    release(); await cleanup;
    await expect(s.runtime.ensure(next)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    expect(s.invocations).toHaveLength(2);
    expect(s.invocations[1].invocationId).not.toBe(s.invocations[0].invocationId);
  });

  it("retries a failed exact-version delete and keeps the read fence", async () => {
    const s = await ready();
    Object.assign(s.rows.get(`${JOBS}/${s.source.id}`), { active: false, phase: "ready" });
    s.failDeletes(true);
    await expect(s.runtime.cleanupReceipt(s.receipt)).rejects.toThrow("temporary S3 failure");
    expect([...s.rows].find(([key]) => key.startsWith(`${USES}/`))[1].state).toBe("deleting");
    // Alignment retries can reactivate the same deterministic owner ID. That
    // new attempt has no permission to use the fenced old version.
    Object.assign(s.rows.get(`${JOBS}/${s.source.id}`), { active: true, phase: "pending", audioInput: null });
    s.failDeletes(false);
    await s.runtime.cleanup();
    expect(s.calls.filter((call) => call.type === "DeleteObjectCommand").map((call) => call.VersionId))
      .toEqual(["audio-version-1", "audio-version-1"]);
  });

  it("backs off confirmed Lambda rejections without exhausting accepted invocation attempts", async () => {
    const s = setup(); const source = s.add(job());
    s.rejectInvoke(Object.assign(Error("private credential and URL must not be logged"),
      { name: "AccessDeniedException", $metadata: { httpStatusCode: 403 } }));
    await expect(s.runtime.ensure(source)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    await expect(s.runtime.ensure(source)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    expect(s.invocations).toHaveLength(1);
    expect(s.warnings).toEqual([["Transcript audio invocation rejected", {
      preparationId: s.invocations[0].preparationId, invocationId: s.invocations[0].invocationId,
      httpStatus: 403, errorCode: "AccessDeniedException",
    }]]);
    expect(JSON.stringify(s.warnings)).not.toContain("private credential");
    const prep = `${contract.COLLECTION}/${s.invocations[0].preparationId}`;
    expect(s.rows.get(prep)).toMatchObject({ state: "retryable", invocationCount: 0, totalInvocationCount: 1 });
    s.advance(60001); s.rejectInvoke(undefined);
    await expect(s.runtime.ensure(source)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    expect(s.invocations).toHaveLength(2);
    expect(s.rows.get(prep)).toMatchObject({ state: "waiting", invocationCount: 1, totalInvocationCount: 2 });
    s.finishPreparation(); await s.runtime.ensure(source);
    expect(s.rows.get(prep).state).toBe("ready");
  });

  it("recovers a lifecycle-aged private audio version whose HEAD returns 403", async () => {
    const s = await ready();
    s.advance(7 * 86400000 + 1);
    s.failAudioHead(Object.assign(Error("unreadable version"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } }));
    await expect(s.runtime.ensure(s.source)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    expect(s.rows.get(`${contract.COLLECTION}/${s.receipt.preparationId}`)).toMatchObject({ state: "pending", generation: 2 });
    expect(s.calls.some((call) => call.type === "DeleteObjectCommand")).toBe(false);
    await expect(s.runtime.ensure(s.source)).rejects.toMatchObject({ code: "audio_preparation_waiting" });
    expect(s.invocations).toHaveLength(2);
    s.failAudioHead(undefined);
    s.finishPreparation();
    const bound = await s.runtime.ensure(s.source);
    expect(bound.invocationId).not.toBe(s.receipt.invocationId);
  });

  it("does not turn a new audio permission denial into repeated paid preparation", async () => {
    const s = await ready();
    const denied = Object.assign(Error("unreadable version"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } });
    s.failAudioHead(denied);
    await expect(s.runtime.ensure(s.source)).rejects.toBe(denied);
    await expect(s.runtime.ensure(s.source)).rejects.toBe(denied);
    expect(s.rows.get(`${contract.COLLECTION}/${s.receipt.preparationId}`)).toMatchObject({ state: "ready", generation: 1 });
    expect(s.invocations).toHaveLength(1);
  });

  it("prepares the oldest claimable jobs even when their hashes sort last", async () => {
    const s = setup();
    const ordered = Array.from({ length: 10 }, (_, index) => s.add({ ...job((10-index).toString(16).padStart(64, "0")),
      createdAt: new Date(now - 10000 + index * 1000).toISOString() }));
    const processor = localProcessor(s);
    await processor.prepareLocalInputs(); s.finishPreparation();
    await processor.prepareLocalInputs();
    expect(ordered.map((item) => Boolean(s.rows.get(`${JOBS}/${item.id}`).audioInput)))
      .toEqual([true, true, true, true, true, false, false, false, false, false]);
  });

  it("continues preparation for another job after a persistent input verification error", async () => {
    const s = await ready();
    const processor = localProcessor(s);
    const other = s.add({ ...job("e".repeat(64)), assetId: "other" });
    s.rows.set("mediaSourceAssets/other", structuredClone(s.rows.get("mediaSourceAssets/asset")));
    s.objects.get(`${s.receipt.output.objectKey}:${s.receipt.output.objectVersionId}`).Metadata.sha256 = "wrong";
    await processor.prepareLocalInputs();
    expect(s.invocations).toHaveLength(2);
    expect(s.invocations[1].preparationId).toBe(contract.preparationId(other, config.bucket, ARTIFACT));
  });

  it("bounds each alignment audio wait and releases the oldest-five window after persistent errors", async () => {
    const s = await ready();
    s.rows.get(`${JOBS}/${s.source.id}`).active = false;
    const parents = Array.from({ length: 6 }, (_, index) => {
      const parent = s.add({ ...job((index + 1).toString(16).repeat(64)), active: false, phase: "ready",
        alignmentRequestId: (index + 7).toString(16).repeat(64), alignmentState: "queued" });
      s.rows.set(`${ALIGNMENTS}/${parent.alignmentRequestId}`, { id: parent.alignmentRequestId,
        active: true, phase: "queued", transcriptId: parent.id,
        createdAt: new Date(Date.parse("2020-01-01T00:00:00Z") + index).toISOString() });
      return parent;
    });
    const metadata = s.objects.get(`${s.receipt.output.objectKey}:${s.receipt.output.objectVersionId}`).Metadata;
    metadata.sha256 = "wrong";
    const processor = localProcessor(s);
    await processor.prepareLocalInputs();
    expect(parents.map((parent) => s.rows.get(`${ALIGNMENTS}/${parent.alignmentRequestId}`).audioPreparationStartedAt))
      .toEqual([...Array(5).fill(new Date(now).toISOString()), undefined]);
    s.advance(86400001);
    await processor.prepareLocalInputs();
    expect(parents.slice(0, 5).map((parent) => s.rows.get(`${ALIGNMENTS}/${parent.alignmentRequestId}`).phase))
      .toEqual(Array(5).fill("unavailable"));
    expect(parents.slice(0, 5).map((parent) => s.rows.get(`${JOBS}/${parent.id}`).alignmentState))
      .toEqual(Array(5).fill("unavailable"));
    metadata.sha256 = s.receipt.output.sha256;
    await processor.prepareLocalInputs();
    expect(s.rows.get(`${ALIGNMENTS}/${parents[5].alignmentRequestId}`)).toMatchObject({
      active: true, phase: "queued", audioInput: { receipt: { output: { objectVersionId: "audio-version-1" } } },
    });
  });

  it("prepares a retried alignment whose first request is more than a day old", async () => {
    const s = setup();
    const parent = s.add({ ...job(), active: false, phase: "ready", alignmentRequestId: "f".repeat(64), alignmentState: "queued" });
    s.rows.set(`${ALIGNMENTS}/${parent.alignmentRequestId}`, { id: parent.alignmentRequestId,
      active: true, phase: "queued", transcriptId: parent.id,
      createdAt: "2020-01-01T00:00:00.000Z", updatedAt: new Date().toISOString() });
    const processor = localProcessor(s);
    await processor.prepareLocalInputs();
    expect(s.invocations).toHaveLength(1);
    s.finishPreparation();
    await processor.prepareLocalInputs();
    expect(s.rows.get(`${ALIGNMENTS}/${parent.alignmentRequestId}`)).toMatchObject({
      active: true, phase: "queued", audioInput: { receipt: { output: { objectVersionId: "audio-version-1" } } },
    });
    expect(s.rows.get(`${JOBS}/${parent.id}`).alignmentState).toBe("queued");
  });

  it("stops a repeatedly archived preparation after three errors so later work can proceed", async () => {
    const s = setup();
    const bad = s.add({ ...job(), localQueueSlot: true, createdAt: new Date(now).toISOString() });
    s.webHead({ StorageClass: "GLACIER" });
    const processor = localProcessor(s);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await processor.prepareLocalInputs();
      expect(s.rows.get(`${JOBS}/${bad.id}`)).toMatchObject({
        audioPreparationFailures: attempt, active: attempt < 3,
      });
    }
    expect(s.rows.get(`${JOBS}/${bad.id}`)).toMatchObject({ phase: "failed", errorCode: "local_audio_preparation_failed" });
    expect(s.invocations).toHaveLength(0);
    s.webHead({});
    const next = s.add({ ...job("e".repeat(64)), createdAt: new Date(now + 1).toISOString() });
    await processor.prepareLocalInputs();
    expect(s.invocations).toHaveLength(1);
    expect(s.invocations[0].preparationId).toBe(contract.preparationId(next, config.bucket, ARTIFACT));
  });

  it("does not count the billing stop as an unexpected preparation failure", async () => {
    const s = setup();
    const queued = s.add({ ...job(), localQueueSlot: true, createdAt: new Date(now).toISOString() });
    s.rows.set("system/billing", { disabled: true });
    const processor = localProcessor(s);
    for (let attempt = 0; attempt < 3; attempt++) await processor.prepareLocalInputs();
    expect(s.rows.get(`${JOBS}/${queued.id}`)).toMatchObject({ active: true, phase: "pending" });
    expect(s.rows.get(`${JOBS}/${queued.id}`)).not.toHaveProperty("audioPreparationFailures");
    expect(s.invocations).toHaveLength(0);
  });

  it.each([
    { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } },
    { name: "TooManyRequestsException", $metadata: { httpStatusCode: 429 } },
    { name: "SlowDown", $metadata: { httpStatusCode: 400 } },
    { name: "Error", code: "ECONNRESET" },
  ])("keeps a transient storage pause queued: %j", async error => {
    const s = setup();
    const queued = s.add({ ...job(), localQueueSlot: true, createdAt: new Date(now).toISOString() });
    s.failWebHead(Object.assign(Error("temporary storage pause"), error));
    const processor = localProcessor(s);
    for (let attempt = 0; attempt < 3; attempt++) await processor.prepareLocalInputs();
    expect(s.rows.get(`${JOBS}/${queued.id}`)).toMatchObject({ active: true, phase: "pending" });
    expect(s.rows.get(`${JOBS}/${queued.id}`)).not.toHaveProperty("audioPreparationFailures");
  });

  it("keeps a restoring source queued without consuming preparation attempts", async () => {
    const s = setup();
    const queued = s.add({ ...job(), localQueueSlot: true, createdAt: new Date(now).toISOString() });
    s.webHead({ StorageClass: "GLACIER", Restore: 'ongoing-request="true"' });
    const processor = localProcessor(s);
    for (let attempt = 0; attempt < 3; attempt++) await processor.prepareLocalInputs();
    expect(s.rows.get(`${JOBS}/${queued.id}`)).toMatchObject({ active: true, phase: "pending" });
    expect(s.rows.get(`${JOBS}/${queued.id}`)).not.toHaveProperty("audioPreparationFailures");
  });

  it("resets preparation errors on success and preserves prepared work", async () => {
    const s = setup();
    const queued = s.add({ ...job(), localQueueSlot: true, createdAt: new Date(now).toISOString() });
    const processor = localProcessor(s);
    s.webHead({ StorageClass: "GLACIER" });
    await processor.prepareLocalInputs(); await processor.prepareLocalInputs();
    expect(s.rows.get(`${JOBS}/${queued.id}`).audioPreparationFailures).toBe(2);
    s.webHead({});
    await processor.prepareLocalInputs(); s.finishPreparation();
    await processor.prepareLocalInputs();
    expect(s.rows.get(`${JOBS}/${queued.id}`)).toMatchObject({ active: true, audioInput: {}, audioPreparationFailures: 0 });
    s.failAudioHead(Object.assign(Error("temporary unreadable version"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } }));
    for (let attempt = 0; attempt < 3; attempt++) await processor.prepareLocalInputs();
    expect(s.rows.get(`${JOBS}/${queued.id}`)).toMatchObject({ active: true, audioPreparationFailures: 0 });
  });

  it("refreshes lifecycle-expired prepared audio before any GPU claim", async () => {
    const s = await ready();
    s.objects.delete(`${s.receipt.output.objectKey}:${s.receipt.output.objectVersionId}`);
    const processor = localProcessor(s);
    await processor.prepareLocalInputs();
    expect(s.rows.get(`${contract.COLLECTION}/${s.receipt.preparationId}`)).toMatchObject({ state: "pending", generation: 2 });
    await processor.prepareLocalInputs();
    expect(s.invocations).toHaveLength(2);
    s.finishPreparation(); await processor.prepareLocalInputs();
    const saved = s.rows.get(`${JOBS}/${s.source.id}`);
    expect(saved).toMatchObject({ active: true, phase: "pending" });
    expect(saved.audioInput.invocationId).not.toBe(s.receipt.invocationId);
    expect(saved).not.toHaveProperty("localLeaseToken");
  });

  it("defers Firestore contention without consuming a preparation attempt", async () => {
    const s = setup();
    const queued = s.add({ ...job(), localQueueSlot: true, createdAt: new Date(now).toISOString() });
    const processor = localProcessor(s);
    const transaction = s.firestore.runTransaction;
    s.firestore.runTransaction = async () => { throw Object.assign(Error("contention"), { code: 10 }); };
    for (let attempt = 0; attempt < 3; attempt++) await processor.prepareLocalInputs();
    s.firestore.runTransaction = transaction;
    expect(s.rows.get(`${JOBS}/${queued.id}`)).toMatchObject({ active: true, phase: "pending" });
    expect(s.rows.get(`${JOBS}/${queued.id}`)).not.toHaveProperty("audioPreparationFailures");
    await processor.prepareLocalInputs();
    expect(s.invocations).toHaveLength(1);
  });

  it("starts the preparation clock when a long-queued local request reaches preparation", async () => {
    const s = setup();
    const queued = s.add({ ...job(), localQueueSlot: true, createdAt: "2020-01-01T00:00:00.000Z" });
    await localProcessor(s).prepareLocalInputs();
    expect(s.invocations).toHaveLength(1);
    expect(s.rows.get(`${JOBS}/${queued.id}`)).toMatchObject({ active: true, phase: "pending",
      audioPreparationStartedAt: new Date(now).toISOString() });
  });

  it("keeps prepared local audio queued beyond one day without a processing timeout", async () => {
    const s = await ready();
    const row = s.rows.get(`${JOBS}/${s.source.id}`);
    Object.assign(row, { localQueueSlot: true, createdAt: new Date(now).toISOString(),
      audioPreparationStartedAt: new Date(now).toISOString() });
    s.advance(2 * 86400000);
    await localProcessor(s).prepareLocalInputs();
    expect(s.rows.get(`${JOBS}/${s.source.id}`)).toMatchObject({ active: true, phase: "pending", audioInput: {} });
    expect(s.invocations).toHaveLength(1);
  });

  it("retains the one-day processing bound for local transcript preparation", async () => {
    const s = setup();
    const source = s.add({ ...job(), createdAt: "2020-01-01T00:00:00.000Z" });
    await localProcessor(s).prepareLocalInputs();
    expect(s.invocations).toHaveLength(0);
    expect(s.rows.get(`${JOBS}/${source.id}`)).toMatchObject({
      active: false, phase: "failed", errorCode: "processing_timeout",
    });
  });

  it("publishes a terminal alignment preparation failure to the matching transcript", async () => {
    const s = setup();
    const parent = s.add({ ...job(), active: false, phase: "ready", alignmentRequestId: "f".repeat(64), alignmentState: "queued" });
    s.rows.set(`${ALIGNMENTS}/${parent.alignmentRequestId}`, { id: parent.alignmentRequestId,
      active: true, phase: "queued", transcriptId: parent.id });
    const processor = localProcessor(s);
    await processor.prepareLocalInputs();
    const prepared = receipt(s.invocations[0]);
    const { output, sourceAudio, outputAudio, ...base } = prepared;
    void output; void sourceAudio; void outputAudio;
    const bytes = Buffer.from(JSON.stringify({ ...base, outcome: "failed", failureCode: "audio_codec_unsupported" }));
    s.objects.set(s.invocations[0].output.receiptKey, { VersionId: "failure-v1", ContentLength: bytes.length, bytes });
    await processor.prepareLocalInputs();
    expect(s.rows.get(`${ALIGNMENTS}/${parent.alignmentRequestId}`)).toMatchObject({ active: false, phase: "unavailable" });
    expect(s.rows.get(`${JOBS}/${parent.id}`).alignmentState).toBe("unavailable");
  });

  it("keeps uncertain provider jobs and a cancelled reader's unexpired lease", () => {
    expect(finalUse({ active: false, phase: "needs_reconciliation", startIntentAt: "intent" }, now)).toBe(false);
    expect(finalUse({ active: false, phase: "cancelled", audioReadLeaseUntil: now + 1 }, now)).toBe(false);
    expect(finalUse({ active: false, phase: "cancelled", audioReadLeaseUntil: now - 1 }, now)).toBe(true);
    expect(finalUse({ active: true, phase: "ready" }, now)).toBe(false);
    expect(finalUse(undefined, now)).toBe(false);
  });

  it("copies only the shared audio version to Amazon, then deletes both exact temporary versions", async () => {
    const s = await ready();
    const source = s.source;
    source.provider = "amazon-transcribe";
    source.leaseOwner = "00000000-0000-4000-8000-000000000001";
    const paid = [];
    let provider;
    const processor = createVideoTranscriptProcessor(config, { firestore: s.firestore, s3: s.s3,
      credentials: async () => ({}), audio: s.runtime, transcribe: { send: async (command) => {
        if (command.constructor.name === "GetTranscriptionJobCommand") {
          if (!provider) throw Object.assign(Error("job not found"), { name: "BadRequestException" });
          return { TranscriptionJob: provider };
        }
        paid.push(command.input);
        return {};
      } } });
    s.rows.set("system/billing", { disabled: false });
    const save = async (patch) => {
      Object.assign(source, patch);
      Object.assign(s.rows.get(`${JOBS}/${source.id}`), patch);
      return true;
    };
    await processor.process(source, save);
    expect(paid).toHaveLength(1);
    expect(paid[0].MediaFormat).toBe("m4a");
    expect(paid[0].Media.MediaFileUri).toBe(`s3://renditions/${inputKey(source)}`);
    expect(s.calls.find((call) => call.type === "CopyObjectCommand").CopySource)
      .toBe(`renditions/${s.receipt.output.objectKey}?versionId=audio-version-1`);
    provider = { TranscriptionJobName: paid[0].TranscriptionJobName, LanguageCode: source.languageCode,
      Settings: paid[0].Settings, Media: paid[0].Media, MediaFormat: "m4a", TranscriptionJobStatus: "FAILED" };
    await processor.process(source, save);
    await s.runtime.cleanup();
    expect(paid).toHaveLength(1);
    expect(s.calls.filter((call) => call.type === "DeleteObjectCommand").map((call) => call.VersionId))
      .toEqual(["amazon-audio-version-1", "audio-version-1"]);
  });
});

it("uses one private R2 audio binding for fleet and ElevenLabs and revokes it after the cleanup fence", async () => {
  const { createHash } = await import("node:crypto");
  const { createPrivateTranscriptAudio, idFor } = require("../../functions/lib/private-transcript-audio");
  const { createJob } = require("../../functions/lib/video-transcript-byok-job");
  const { createVideoTranscriptByokStorage } = require("../../functions/lib/video-transcript-byok-storage");
  const s = await ready();
  localProcessor(s); // Supplies the current asset through the existing fixture boundary.
  const identity = { audio: s.receipt.output, receipt: s.receipt };
  const id = idFor(s.receipt);
  const generation = "11111111-1111-4111-8111-111111111111";
  const key = `private-audio/${id}/${generation}/input.m4a`;
  const partHash = "c".repeat(64);
  s.rows.set(`mediaPrivateAudioCopies/${id}`, { id, identity, generation, phase: "ready", active: false, revoked: false,
    files: { audio: { phase: "ready", key, etag: '"audio-etag"', fullSha256: s.receipt.output.sha256,
      parts: [{ PartNumber: 1, ETag: '"part"', sha256: partHash }], verifiedParts: 1,
      checksum: createHash("sha256").update(partHash).digest("hex") } } });
  let removed = false;
  const r2 = { send: async command => {
    expect(command.input.Key).toBe(key);
    if (command.constructor.name === "DeleteObjectCommand") { removed = true; return {}; }
    expect(command.constructor.name).toBe("HeadObjectCommand");
    return { ETag: '"audio-etag"', ContentLength: 120, Metadata: { binding: id, generation } };
  } };
  const streamedBytes = Buffer.alloc(120, 7);
  const r2Stream = { send: async command => {
    expect(command.constructor.name).toBe("GetObjectCommand");
    expect(command.input.Key).toBe(key);
    return { ETag: '"audio-etag"', ContentLength: 120, ContentType: "audio/x-m4a",
      Metadata: { binding: id, generation }, Body: Readable.from([streamedBytes]) };
  } };
  let readEnabled = true;
  const privateAudio = createPrivateTranscriptAudio({ firestore: s.firestore, s3: s.s3, config,
    storage: write => write || readEnabled ? { client: r2, bucket: "private-delivery" } : null, clock: () => now,
    streamStorage: () => ({ client: r2Stream, bucket: "private-delivery" }),
    sign: async () => "https://private.example/input" });
  const processor = createVideoTranscriptProcessor(config, { firestore: s.firestore, s3: s.s3,
    credentials: async () => ({}), audio: s.runtime, privateAudio, transcribe: {} });
  const input = await processor.signInput(s.source);
  expect(input).toMatchObject({ storage: "private-r2", versionId: "audio-version-1", sizeBytes: 120,
    sha256: "c".repeat(64), preparationId: s.receipt.preparationId, invocationId: s.receipt.invocationId });

  const credentialId = createHash("sha256").update(JSON.stringify(["credential-v1", "personal", "staff", "elevenlabs"])).digest("hex");
  const paid = { ...createJob({ sourceId: "video-library", assetId: "asset", originalBucket: "originals",
    originalKey: "objects/source.mov", originalVersion: "original-v1", originalSize: 1000,
    renditionBucket: "renditions", renditionKey: "outputs/asset/web.mp4", renditionVersion: "web-v1", renditionSize: 900,
    durationSeconds: 20, credentialScope: "personal", credentialId, credentialRevision: 1,
    languageCode: "en-US", maxSpeakers: 3, inputRevision: "aac-m4a-copy-v1" }, { uid: "staff" }),
  attemptId: "22222222-2222-4222-8222-222222222222", leaseUntil: Date.now() + 720000 };
  s.add(paid);
  const store = createVideoTranscriptByokStorage(config, { s3: s.s3, audio: s.runtime, privateAudio, assertBillingEnabledFn: async () => {} });
  const prepared = await store.prepareInput(paid);
  expect(prepared.input).toMatchObject({ versionId: "audio-version-1", expectedVersionId: "audio-version-1", sizeBytes: 120,
    mimeType: "audio/x-m4a", sha256: "c".repeat(64) });
  const chunks = [];
  for await (const chunk of prepared.input.stream) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(streamedBytes);
  prepared.cleanup();
  const runtime = createTranscriptAudioRuntime(config, { firestore: s.firestore, s3: s.s3,
    lambda: {}, assertBillingEnabled: async () => {}, privateDelivery: privateAudio, clock: () => now });
  expect(await runtime.cleanupReceipt(s.receipt)).toBe(false);
  expect(removed).toBe(false);
  readEnabled = false;
  expect(await privateAudio.signedInput(s.receipt)).toBeNull();
  Object.assign(s.rows.get(`${JOBS}/${s.source.id}`), { active: false, phase: "ready" });
  Object.assign(s.rows.get(`${JOBS}/${paid.id}`), { active: false, phase: "ready" });
  expect(await runtime.cleanupReceipt(s.receipt)).toBe(true);
  expect(removed).toBe(true);
});
