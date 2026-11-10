import { describe, expect, it, vi } from "vitest";
import alignment from "../../functions/lib/video-transcript-alignment-job.js";
import processor from "../../functions/lib/video-transcript-processor.js";
import transcriptJobs from "../../functions/lib/video-transcript-job.js";
import transcriptContract from "../../functions/lib/video-transcript-contract.js";
import alignmentHandler from "../../functions/video-transcript-alignment.js";

const now = 1_800_000_000_000;
const source = { id: "video-library", bucket: "originals", prefix: "" };
const transcriptId = transcriptContract.transcriptId({ sourceId: source.id, objectKey: "original.mov",
  objectVersionId: "original-v1", sizeBytes: 1000 }, source.bucket, { languageCode: "es-US", maxSpeakers: 10 });
const config = { bucket: "renditions", alignmentModelRepository: alignment.MODEL_REPOSITORY,
  alignmentModelRevision: alignment.MODEL_REVISION, alignmentCacheSha256: "c".repeat(64) };
const actor = { uid: "staff", email: "staff@example.org" };
const segments = [
  { startSeconds: 1, endSeconds: 4, speaker: "spk_0", text: "Hello María" },
  { startSeconds: 5, endSeconds: 6, speaker: "spk_1", text: "Ready", words: [{ startSeconds: 5, endSeconds: 6, text: "Ready" }] },
];

function memoryStore() {
  const input = { objectKey: "outputs/asset/web.mp4", objectVersionId: "web-v1", sizeBytes: 500, durationSeconds: 20 };
  const job = { id: transcriptId, assetId: "asset", sourceId: source.id, sourceBucket: source.bucket,
    sourceObjectKey: "original.mov", sourceObjectVersionId: "original-v1", sourceSizeBytes: 1000,
    input, durationSeconds: 20, languageCode: "es-US", totalSegments: segments.length,
    maxSpeakers: 10,
    phase: "ready", active: false, editRevision: 2, reviewedRevision: 2,
    editedOutputs: { "segments.json": "segments-v2", txt: "txt-v2", vtt: "vtt-v2" },
    speakerNames: { spk_0: "María" } };
  const asset = { sourceId: source.id, lifecycle: "active", kind: "video", name: "Video",
    originalName: "original.mov", nameSort: "video", updatedAtSort: "2026-09-22T12:00:00.000Z",
    mimeType: "video/quicktime", version: 1, preview: "download_only", rightsStatus: "complete", tags: [],
    objectKey: job.sourceObjectKey, objectVersionId: job.sourceObjectVersionId, sizeBytes: job.sourceSizeBytes,
    rendition: { schemaVersion: 1, state: "ready", sourceObjectKey: job.sourceObjectKey,
      sourceObjectVersionId: job.sourceObjectVersionId, sourceSizeBytes: job.sourceSizeBytes,
      attemptId: "attempt", updatedAt: "2026-09-22T12:00:00.000Z",
      web: { ...input, mimeType: "video/mp4" },
      poster: { objectKey: "outputs/asset/poster.jpg", objectVersionId: "poster-v1",
        sizeBytes: 10, mimeType: "image/jpeg" } } };
  const rows = new Map([[`mediaSourceTranscriptJobs/${transcriptId}`, job], ["mediaSourceAssets/asset", asset]]);
  let generated = 0;
  let tail = Promise.resolve();
  const ref = (collection, id = `generated-${++generated}`) => ({ path: `${collection}/${id}`, id });
  const snapshot = (reference) => ({ id: reference.id, ref: reference, exists: rows.has(reference.path),
    data: () => structuredClone(rows.get(reference.path)) });
  const collection = (name, filters = []) => ({ doc: (id) => ref(name, id),
    where: (key, _operator, value) => collection(name, [...filters, [key, value]]),
    orderBy: () => collection(name, filters), limit: () => collection(name, filters),
    get: async () => ({ docs: [...rows].filter(([path, value]) => path.startsWith(`${name}/`) &&
      filters.every(([key, valueExpected]) => value[key] === valueExpected))
      .map(([path]) => snapshot({ path, id: path.split("/").at(-1) })) }) });
  const firestore = { collection, runTransaction: (callback) => {
    const run = tail.then(async () => {
      const writes = [];
      const result = await callback({ get: async (reference) => snapshot(reference),
        update: (reference, value) => writes.push(() => rows.set(reference.path,
          { ...rows.get(reference.path), ...structuredClone(value) })),
        set: (reference, value) => writes.push(() => rows.set(reference.path, structuredClone(value))),
        create: (reference, value) => writes.push(() => rows.set(reference.path, structuredClone(value))) });
      writes.forEach((write) => write());
      return result;
    });
    tail = run.catch(() => {});
    return run;
  } };
  return { firestore, rows, job, asset };
}

const request = { sourceId: source.id, assetId: "asset", transcriptId, revision: 2 };
const requestJob = (store, extra = {}) => alignment.requestAlignment({ firestore: store.firestore, source,
  job: store.rows.get(`mediaSourceTranscriptJobs/${transcriptId}`), segments: structuredClone(segments),
  config, actor, request: { ...request, ...extra }, now, audit: (value) => value });
const httpResponse = () => ({ code: 0, body: undefined, set() {}, status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; } });

function completion(claim) {
  return { kind: "alignment", jobId: claim.alignment.id, leaseToken: claim.alignment.leaseToken,
    result: { requestId: claim.alignment.id, status: "complete", passages: [{ index: 0, words: [
      { text: "Hello", startSeconds: 1.1, endSeconds: 1.8, aligned: true },
      { text: "María", startSeconds: 2, endSeconds: 3, aligned: true },
    ] }] } };
}

describe("corrected transcript alignment jobs", () => {
  it("admits a source-authorized request through the App Check endpoint", async () => {
    const store = memoryStore();
    const authorize = vi.fn(async () => {});
    const handler = alignmentHandler.createAlignmentHandler("request", { firestore: store.firestore,
      registryFn: () => new Map([[source.id, source]]), configFn: () => ({ ...config, alignmentEnabled: true, source }),
      processor: { readAlignment: async () => structuredClone(segments) }, verifyAppCheckFn: vi.fn(async () => {}),
      requirePrincipalFn: async () => actor, authorizeFn: authorize, audit: (value) => value });
    const res = httpResponse();
    await handler({ method: "POST", headers: { "content-type": "application/json" }, body: request }, res);
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ success: true, cached: false, alignment: {
      state: "queued", timingBasis: "viewing-copy-elapsed", revision: 2,
    } });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ operation: "transcript", actor, source }));
  });

  it("returns the transcript alignment state when request or cancel observes a completed job", async () => {
    const store = memoryStore();
    const built = alignment.buildAlignmentSnapshot(store.job, segments, config);
    Object.assign(store.job, { alignmentRequestId: built.request.id, alignmentRevision: 2,
      alignmentState: "review_required", alignmentEligibleCount: 0, alignmentUnavailableCount: 0 });
    store.rows.set(`${alignment.ALIGNMENT_JOBS}/${built.request.id}`, { id: built.request.id,
      transcriptId, transcriptRevision: 2, phase: "complete", active: false,
      eligibleCount: 1, unavailableCount: 0, updatedAt: new Date(now).toISOString() });
    const dependencies = { firestore: store.firestore, registryFn: () => new Map([[source.id, source]]),
      configFn: () => ({ ...config, alignmentEnabled: true, source }),
      processor: { readAlignment: async () => structuredClone(segments) },
      verifyAppCheckFn: vi.fn(async () => {}), requirePrincipalFn: async () => actor,
      authorizeFn: vi.fn(async () => {}), audit: (value) => value };
    for (const [operation, body] of [["request", request],
      ["cancel", { ...request, requestId: built.request.id }]]) {
      const res = httpResponse();
      await alignmentHandler.createAlignmentHandler(operation, dependencies)(
        { method: "POST", headers: { "content-type": "application/json" }, body }, res);
      expect(res.code).toBe(200);
      expect(res.body.alignment.state).toBe("review_required");
      expect(res.body.alignment.eligiblePassages).toBe(0);
    }
  });

  it("accepts only the reviewed model repository and revision", () => {
    expect(alignment.alignmentEngine(config)).toMatchObject({
      modelRepository: alignment.MODEL_REPOSITORY, modelRevision: alignment.MODEL_REVISION,
    });
    expect(alignment.alignmentEngine({ ...config, alignmentModelRevision: "b".repeat(40) })).toBeNull();
  });

  it("selects only missing eligible words and preserves explicit unavailable passages", () => {
    const selection = alignment.selectedPassages([
      ...segments, { startSeconds: 7, endSeconds: 8, text: "Together", overlappingSpeech: true },
      { startSeconds: 9, endSeconds: 10, text: "", overlappingSpeech: false },
    ]);
    expect(selection.passages.map((passage) => passage.index)).toEqual([0]);
    expect(selection).toMatchObject({ missingCount: 3, unavailableCount: 2 });
  });

  it("does not count a deferred alignment batch as unavailable", () => {
    const selection = alignment.selectedPassages([
      ...Array.from({ length: 101 }, (_, index) => ({ startSeconds: index, endSeconds: index + 0.5,
        text: `Word ${index}`, overlappingSpeech: false })),
      { startSeconds: 102, endSeconds: 103, text: "Together", overlappingSpeech: true },
    ]);
    expect(selection).toMatchObject({ missingCount: 102, unavailableCount: 1, deferredCount: 1 });
    expect(selection.passages).toHaveLength(100);
  });

  it("binds request identity to the exact selected segments version", () => {
    const store = memoryStore();
    const first = alignment.buildAlignmentSnapshot(store.job, segments, config);
    const changed = { ...store.job, editedOutputs: { ...store.job.editedOutputs, "segments.json": "segments-v3" } };
    expect(alignment.buildAlignmentSnapshot(changed, segments, config).request.id).not.toBe(first.request.id);
    expect(first.snapshot.transcript.segmentsVersionId).toBe("segments-v2");
  });

  it("keeps partial alignment output internal until every passage is timed", () => {
    const job = { ...memoryStore().job, alignmentRevision: 2, alignmentRequestId: "d".repeat(64),
      alignedOutputRequestId: "c".repeat(64), alignmentState: "partial",
      alignedOutputs: { "segments.json": "partial-segments", txt: "partial-txt" } };
    expect(processor.selectedTranscriptOutputs(job).outputs["segments.json"]).toBe("segments-v2");
    const partial = processor.selectedTranscriptOutputs(job, { alignmentWork: true });
    expect(partial.outputs["segments.json"]).toBe("partial-segments");
    expect(partial.key("segments.json")).toContain(`.aligned.${"c".repeat(64)}.`);
    expect(processor.selectedTranscriptOutputs({ ...job, alignmentState: "ready" }).outputs["segments.json"]).toBe("partial-segments");
  });

  it("starts the next batch from an immutable partial alignment result", async () => {
    const store = memoryStore();
    Object.assign(store.job, { alignmentRevision: 2, alignmentRequestId: "d".repeat(64),
      alignedOutputRequestId: "d".repeat(64), alignmentState: "partial", alignedOutputs: { "segments.json": "partial-segments",
        txt: "partial-txt", vtt: "partial-vtt" } });
    const queued = await requestJob(store);
    expect(queued.cached).toBe(false);
    expect(queued.job.segmentsVersionId).toBe("partial-segments");
    expect(store.rows.get(`mediaSourceTranscriptJobs/${transcriptId}`)).toMatchObject({
      alignmentRequestId: queued.job.id, alignmentState: "queued",
    });
  });

  it("requires audio-reviewed corrected text before queueing", async () => {
    const store = memoryStore();
    store.job.reviewedRevision = null;
    await expect(requestJob(store)).rejects.toMatchObject({ status: 409 });
    expect([...store.rows.keys()].some((key) => key.startsWith(`${alignment.ALIGNMENT_JOBS}/`))).toBe(false);
  });

  it("matches Firestore engine maps without depending on key order", async () => {
    const store = memoryStore();
    const queued = await requestJob(store);
    const saved = store.rows.get(`${alignment.ALIGNMENT_JOBS}/${queued.job.id}`);
    saved.engine = { cacheSha256: saved.engine.cacheSha256, modelRevision: saved.engine.modelRevision,
      adapterRevision: saved.engine.adapterRevision, modelRepository: saved.engine.modelRepository };
    const claim = await alignment.claimAlignmentJob({ firestore: store.firestore, source, config, now });
    expect(claim.alignment).toMatchObject({ id: queued.job.id, phase: "running", attempt: 1 });
  });

  it("deduplicates requests, recovers one lease and commits only revision-matched output", async () => {
    const store = memoryStore();
    const [first, second] = await Promise.all([requestJob(store), requestJob(store)]);
    expect(first.job.id).toBe(second.job.id);
    expect([first.cached, second.cached].sort()).toEqual([false, true]);
    const [claimOne, claimTwo] = await Promise.all([
      alignment.claimAlignmentJob({ firestore: store.firestore, source, config, now }),
      alignment.claimAlignmentJob({ firestore: store.firestore, source, config, now }),
    ]);
    expect(claimOne.alignment.leaseToken).toBe(claimTwo.alignment.leaseToken);
    const writeAlignment = vi.fn(async () => ({ "segments.json": "aligned-segments", txt: "aligned-txt", vtt: "aligned-vtt" }));
    const args = { firestore: store.firestore, source, config, request: completion(claimOne), now,
      clock: () => now, readSegments: async () => structuredClone(segments), writeAlignment,
      assertBillingEnabled: vi.fn(async () => {}) };
    const completed = await alignment.completeAlignmentJob(args);
    expect(completed).toEqual({ completed: true, available: false, remainingPassages: 0 });
    let saved = store.rows.get(`mediaSourceTranscriptJobs/${transcriptId}`);
    expect(saved).toMatchObject({ alignmentState: "review_required", alignmentRevision: 2,
      reviewedRevision: null, alignedOutputRequestId: claimOne.alignment.id,
      alignedOutputs: { "segments.json": "aligned-segments", txt: "aligned-txt", vtt: "aligned-vtt" } });
    expect(processor.selectedTranscriptOutputs(saved).outputs["segments.json"]).toBe("segments-v2");
    store.rows.set("users/staff", { active: true, grants: [{ role: "staff" }] });
    const reviewed = await transcriptJobs.commitTranscriptEdit({ firestore: store.firestore, source,
      request: { ...request, segments: [], speakerNames: {}, speakerRoles: {}, reviewed: true },
      job: saved, actor: { ...actor, displayName: "Staff" },
      renditionBucket: config.bucket, audit: (value) => value });
    expect(reviewed).toMatchObject({ editRevision: 2, reviewedRevision: 2,
      reviewedAlignmentRequestId: claimOne.alignment.id, alignmentState: "ready" });
    saved = store.rows.get(`mediaSourceTranscriptJobs/${transcriptId}`);
    expect(processor.selectedTranscriptOutputs(saved).outputs["segments.json"]).toBe("aligned-segments");
    expect(await alignment.completeAlignmentJob(args)).toEqual({ completed: true, available: true });
    expect(writeAlignment).toHaveBeenCalledTimes(1);
  });

  it("keeps incomplete model output unavailable and never writes aligned exports", async () => {
    const store = memoryStore();
    await requestJob(store);
    const claim = await alignment.claimAlignmentJob({ firestore: store.firestore, source, config, now });
    const requestWithUncertainWord = completion(claim);
    requestWithUncertainWord.result.passages[0].words[0].aligned = false;
    const writeAlignment = vi.fn();
    const result = await alignment.completeAlignmentJob({ firestore: store.firestore, source, config,
      request: requestWithUncertainWord, now, clock: () => now, readSegments: async () => structuredClone(segments),
      writeAlignment, assertBillingEnabled: vi.fn() });
    expect(result).toEqual({ completed: true, available: false });
    expect(writeAlignment).not.toHaveBeenCalled();
    expect(store.rows.get(`mediaSourceTranscriptJobs/${transcriptId}`).alignmentState).toBe("unavailable");
  });

  it("cancels a leased job and rejects its late completion without changing edits", async () => {
    const store = memoryStore();
    const queued = await requestJob(store);
    const claim = await alignment.claimAlignmentJob({ firestore: store.firestore, source, config, now });
    const cancelled = await alignment.cancelAlignment({ firestore: store.firestore, source, job: store.job,
      request: { ...request, requestId: queued.job.id }, actor, now: now + 1, audit: (value) => value });
    expect(cancelled.job.phase).toBe("cancelled");
    await expect(alignment.completeAlignmentJob({ firestore: store.firestore, source, config,
      request: completion(claim), now: now + 1, readSegments: async () => segments,
      writeAlignment: vi.fn(), assertBillingEnabled: vi.fn() })).rejects.toMatchObject({ status: 409 });
    expect(store.rows.get(`mediaSourceTranscriptJobs/${transcriptId}`).editedOutputs["segments.json"]).toBe("segments-v2");
  });

  it("rejects a completion after the transcript revision changes", async () => {
    const store = memoryStore();
    await requestJob(store);
    const claim = await alignment.claimAlignmentJob({ firestore: store.firestore, source, config, now });
    store.rows.get(`mediaSourceTranscriptJobs/${transcriptId}`).editRevision = 3;
    await expect(alignment.completeAlignmentJob({ firestore: store.firestore, source, config,
      request: completion(claim), now, readSegments: async () => segments,
      writeAlignment: vi.fn(), assertBillingEnabled: vi.fn() })).rejects.toMatchObject({ status: 409 });
  });

  it("stops retrying after three lost worker leases", async () => {
    const store = memoryStore();
    const queued = await requestJob(store);
    for (let attempt = 0; attempt < alignment.MAX_ATTEMPTS; attempt += 1) {
      const claimed = await alignment.claimAlignmentJob({ firestore: store.firestore, source, config,
        now: now + attempt * (alignment.LEASE_MS + 1) });
      expect(claimed.alignment.attempt).toBe(attempt + 1);
    }
    expect(await alignment.claimAlignmentJob({ firestore: store.firestore, source, config,
      now: now + alignment.MAX_ATTEMPTS * (alignment.LEASE_MS + 1) })).toBeNull();
    expect(store.rows.get(`${alignment.ALIGNMENT_JOBS}/${queued.job.id}`)).toMatchObject({
      phase: "needs_reconciliation", active: false, errorCode: "alignment_worker_lost",
    });
    expect(store.rows.get(`mediaSourceTranscriptJobs/${transcriptId}`).alignmentState).toBe("needs_reconciliation");
  });

  it("requires explicit retry after cancellation while retaining the deterministic ID", async () => {
    const store = memoryStore();
    const first = await requestJob(store);
    await alignment.cancelAlignment({ firestore: store.firestore, source, job: store.job,
      request: { ...request, requestId: first.job.id }, actor, now, audit: (value) => value });
    expect((await requestJob(store)).job.phase).toBe("cancelled");
    const retry = await requestJob(store, { retry: true });
    expect(retry.job).toMatchObject({ id: first.job.id, phase: "queued", attempt: 0 });
  });
});
