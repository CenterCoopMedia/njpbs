import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import alignment from "../../functions/lib/video-transcript-alignment-job.js";
import transcriptJobs from "../../functions/lib/video-transcript-job.js";
import transcriptContract from "../../functions/lib/video-transcript-contract.js";
import worker from "../../functions/lib/video-transcript-worker.js";

const now = 1_800_000_000_000;
const project = "demo-njpbs-alignment-queue";
const source = { id: "video-library", bucket: "originals", prefix: "" };
const config = { bucket: "renditions", alignmentModelRepository: alignment.MODEL_REPOSITORY,
  alignmentModelRevision: alignment.MODEL_REVISION, alignmentCacheSha256: "c".repeat(64) };
const actor = { uid: "staff", email: "staff@example.test" };
const segments = [{ startSeconds: 1, endSeconds: 4, speaker: "spk_0", text: "Hello María" }];

describe("alignment queue persistence", () => {
  let db;
  let app;
  let slotRef;

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the Firestore emulator for alignment queue tests");
    app = initializeApp({ projectId: project }, "alignment-queue-tests");
    db = getFirestore(app);
    slotRef = db.collection(worker.WORKERS).doc(worker.WORKER_ID);
  });
  afterAll(async () => { await db.terminate(); await deleteApp(app); });

  beforeEach(async () => {
    const response = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`,
      { method: "DELETE" });
    expect(response.ok).toBe(true);
    // Transcript edits recheck the editor's current staff record.
    await db.collection("users").doc(actor.uid).set({ active: true, grants: [{ role: "staff" }] });
  });

  async function queue(assetId, order = 0) {
    const input = { objectKey: `outputs/${assetId}/web.mp4`, objectVersionId: "web-v1", sizeBytes: 500,
      durationSeconds: 20 };
    const asset = { id: assetId, sourceId: source.id, lifecycle: "active", kind: "video", name: "Video",
      originalName: `${assetId}.mov`, nameSort: "video", updatedAtSort: "2026-09-22T12:00:00.000Z",
      mimeType: "video/quicktime", version: 1, preview: "download_only", rightsStatus: "complete", tags: [],
      objectKey: `${assetId}.mov`, objectVersionId: "original-v1", sizeBytes: 1000,
      rendition: { schemaVersion: 1, state: "ready", sourceObjectKey: `${assetId}.mov`,
        sourceObjectVersionId: "original-v1", sourceSizeBytes: 1000, attemptId: "attempt",
        updatedAt: "2026-09-22T12:00:00.000Z", web: { ...input, mimeType: "video/mp4" },
        poster: { objectKey: `outputs/${assetId}/poster.jpg`, objectVersionId: "poster-v1", sizeBytes: 10,
          mimeType: "image/jpeg" } } };
    const id = transcriptContract.transcriptId(asset, source.bucket, { languageCode: "es-US", maxSpeakers: 10 });
    const job = { id, assetId, sourceId: source.id, sourceBucket: source.bucket,
      sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
      input, durationSeconds: 20, languageCode: "es-US", maxSpeakers: 10, totalSegments: segments.length,
      phase: "ready", active: false, editRevision: 2, reviewedRevision: 2,
      editedOutputs: { "segments.json": `${assetId}-segments-v2`, txt: `${assetId}-txt-v2`, vtt: `${assetId}-vtt-v2` },
      speakerNames: { spk_0: "María" } };
    const transcriptRef = db.collection(transcriptJobs.TRANSCRIPT_JOBS).doc(id);
    await db.collection("mediaSourceAssets").doc(assetId).set(asset);
    await transcriptRef.set(job);
    const request = { sourceId: source.id, assetId, transcriptId: id, revision: 2 };
    const result = await alignment.requestAlignment({ firestore: db, source, config, job, segments,
      request, actor, now: now + order });
    return { transcriptRef, alignmentRef: db.collection(alignment.ALIGNMENT_JOBS).doc(result.job.id),
      request, job: (await transcriptRef.get()).data() };
  }

  const claim = () => alignment.claimAlignmentJob({ firestore: db, source, config, now });

  it("retires stale audio-less alignments before waiting for preparation", async () => {
    const missing = await queue("missing-transcript");
    const deleted = await queue("deleted-source", 1);
    const notReady = await queue("not-ready", 2);
    const eligible = await queue("eligible-audio", 3);
    await missing.transcriptRef.delete();
    await db.collection("mediaSourceAssets").doc("deleted-source").update({ lifecycle: "deleted" });
    await notReady.transcriptRef.update({ phase: "pending" });

    expect(await alignment.claimAlignmentJob({ firestore: db, source, config: { ...config, audioEnabled: true }, now })).toBeNull();
    for (const item of [missing, deleted, notReady]) {
      expect((await item.alignmentRef.get()).data()).toMatchObject({ active: false, phase: "stale", errorCode: "alignment_stale" });
    }
    expect((await deleted.transcriptRef.get()).data().alignmentState).toBe("stale");
    expect((await eligible.alignmentRef.get()).data()).toMatchObject({ active: true, phase: "queued" });
    const remaining = await db.collection(alignment.ALIGNMENT_JOBS).where("active", "==", true).get();
    expect(remaining.docs.map((doc) => doc.id)).toEqual([eligible.alignmentRef.id]);
  });

  it("requeues a stale job only on explicit retry after the original model is restored", async () => {
    const queued = await queue("retry-stale");
    await queued.alignmentRef.update({ audioPreparationStartedAt: new Date(now - 2 * 86400000).toISOString() });
    const previousClaim = await claim();
    expect(await alignment.claimAlignmentJob({ firestore: db, source, now,
      config: { ...config, alignmentCacheSha256: "d".repeat(64) } })).toBeNull();
    expect((await queued.alignmentRef.get()).data()).toMatchObject({ phase: "stale", active: false });

    const args = { firestore: db, source, config, actor, segments, now: now + 1,
      job: (await queued.transcriptRef.get()).data(), request: queued.request };
    expect(await alignment.requestAlignment(args)).toMatchObject({ cached: true, state: "stale" });

    const retries = await Promise.all([0, 1].map(() => alignment.requestAlignment({ ...args,
      request: { ...queued.request, retry: true } })));
    expect(retries.map((result) => result.cached).sort()).toEqual([false, true]);
    for (const result of retries) {
      expect(result).toMatchObject({ state: "queued", job: { id: queued.alignmentRef.id,
        phase: "queued", active: true, attempt: 0, leaseToken: null, leaseUntil: 0 } });
    }
    const saved = (await queued.alignmentRef.get()).data();
    expect(saved.errorCode).toBeUndefined();
    expect(saved.audioPreparationStartedAt).toBeUndefined();
    expect(saved.createdAt).toBe(new Date(now).toISOString());
    expect((await queued.transcriptRef.get()).data()).toMatchObject({ alignmentState: "queued",
      alignmentRequestId: queued.alignmentRef.id, editRevision: 2, reviewedRevision: 2,
      editedOutputs: queued.job.editedOutputs });

    const nextClaim = await claim();
    expect(nextClaim.alignment).toMatchObject({ id: queued.alignmentRef.id, phase: "running", attempt: 1 });
    expect(nextClaim.alignment.leaseToken).not.toBe(previousClaim.alignment.leaseToken);
    await expect(alignment.heartbeatAlignmentJob({ firestore: db, source, now,
      request: { jobId: queued.alignmentRef.id, leaseToken: previousClaim.alignment.leaseToken,
        stage: "aligning" } })).rejects.toMatchObject({ status: 409 });
  });

  it("retires multiple stale jobs and claims the next eligible job in the same transaction", async () => {
    const first = await queue("stale-first");
    const second = await queue("stale-second", 1);
    const eligible = await queue("eligible", 2);
    await first.transcriptRef.update({ editRevision: 3 });
    await second.transcriptRef.delete();

    expect((await claim())?.alignment.id).toBe(eligible.alignmentRef.id);
    for (const queued of [first, second]) {
      expect((await queued.alignmentRef.get()).data()).toMatchObject({ active: false, phase: "stale",
        leaseToken: null, leaseUntil: 0, errorCode: "alignment_stale" });
    }
    expect((await first.transcriptRef.get()).data().alignmentState).toBe("stale");
    expect((await slotRef.get()).data()).toMatchObject({ kind: "alignment", jobId: eligible.alignmentRef.id });
  });

  it("retires an exhausted job and claims the next job without another worker poll", async () => {
    const exhausted = await queue("exhausted");
    const eligible = await queue("eligible", 1);
    await exhausted.alignmentRef.update({ attempt: alignment.MAX_ATTEMPTS });

    expect((await claim())?.alignment.id).toBe(eligible.alignmentRef.id);
    expect((await exhausted.alignmentRef.get()).data()).toMatchObject({ active: false,
      phase: "needs_reconciliation", errorCode: "alignment_worker_lost" });
  });

  it("replaces a stale live alignment slot with the next eligible claim", async () => {
    const stale = await queue("stale-owner");
    await claim();
    const eligible = await queue("eligible", 1);
    await stale.transcriptRef.update({ editRevision: 3 });

    expect((await claim())?.alignment.id).toBe(eligible.alignmentRef.id);
    expect((await stale.alignmentRef.get()).data()).toMatchObject({ active: false, phase: "stale" });
    expect((await slotRef.get()).data()).toMatchObject({ kind: "alignment", jobId: eligible.alignmentRef.id });
  });

  it("keeps the five-candidate bound while clearing a fully stale page and its slot", async () => {
    const stale = [];
    for (let index = 0; index < 5; index += 1) stale.push(await queue(`stale-${index}`, index));
    const eligible = await queue("eligible", 5);
    await claim();
    for (const queued of stale) await queued.transcriptRef.update({ editRevision: 3 });

    expect(await claim()).toBeNull();
    for (const queued of stale) expect((await queued.alignmentRef.get()).data().active).toBe(false);
    expect((await eligible.alignmentRef.get()).data().phase).toBe("queued");
    expect((await slotRef.get()).data()).toMatchObject({ kind: null, jobId: null, leaseUntil: 0 });
    expect((await claim())?.alignment.id).toBe(eligible.alignmentRef.id);
  });

  it("preserves a live transcription slot", async () => {
    const queued = await queue("queued");
    const slot = { kind: "transcription", jobId: "other-transcript", leaseUntil: now + worker.LEASE_MS, lastSeenAt: now };
    await slotRef.set(slot);

    expect(await claim()).toBeNull();
    expect((await slotRef.get()).data()).toEqual(slot);
    expect((await queued.alignmentRef.get()).data().phase).toBe("queued");
  });

  it("recovers the same live alignment lease across concurrent claims", async () => {
    const owner = await queue("owner");
    const pending = await queue("pending", 1);
    const [first, second] = await Promise.all([claim(), claim()]);

    expect(first.alignment.id).toBe(owner.alignmentRef.id);
    expect(second.alignment.leaseToken).toBe(first.alignment.leaseToken);
    expect(second.alignment.attempt).toBe(1);
    expect((await pending.alignmentRef.get()).data().phase).toBe("queued");
  });

  it.each(["queued", "running"])("deactivates %s alignment atomically when transcript edits replace its revision", async (phase) => {
    const obsolete = await queue("obsolete");
    const previousClaim = phase === "running" ? await claim() : null;
    const eligible = await queue("eligible", 1);
    await transcriptJobs.commitTranscriptEdit({ firestore: db, source, actor, job: obsolete.job,
      request: { ...obsolete.request, segments: [{ index: 0, text: "Corrected text" }], speakerNames: {} },
      editedOutputs: { "segments.json": "corrected-segments", txt: "corrected-txt", vtt: "corrected-vtt" },
      speakerNames: obsolete.job.speakerNames, renditionBucket: config.bucket });

    expect((await obsolete.transcriptRef.get()).data()).toMatchObject({ editRevision: 3,
      alignmentRequestId: null, alignmentState: null, editedOutputs: { "segments.json": "corrected-segments" } });
    expect((await obsolete.alignmentRef.get()).data()).toMatchObject({ active: false, phase: "stale",
      leaseToken: null, leaseUntil: 0, errorCode: "alignment_stale" });
    if (previousClaim) {
      expect((await slotRef.get()).data()).toMatchObject({ kind: null, jobId: null, leaseUntil: 0 });
      await expect(alignment.heartbeatAlignmentJob({ firestore: db, source, now,
        request: { jobId: obsolete.alignmentRef.id, leaseToken: previousClaim.alignment.leaseToken,
          stage: "aligning" } })).rejects.toMatchObject({ status: 409 });
    }
    expect((await claim())?.alignment.id).toBe(eligible.alignmentRef.id);
  });

  it("invalidates queued alignment when an ordinary review advances the transcript revision", async () => {
    const queued = await queue("reviewed");
    await transcriptJobs.commitTranscriptEdit({ firestore: db, source, actor, job: queued.job,
      request: { ...queued.request, segments: [], speakerNames: {}, reviewed: true }, renditionBucket: config.bucket });

    expect((await queued.transcriptRef.get()).data()).toMatchObject({ editRevision: 3, reviewedRevision: 3,
      alignmentRequestId: null, alignmentState: null });
    expect((await queued.alignmentRef.get()).data()).toMatchObject({ active: false, phase: "stale" });
  });

  it("keeps another job's GPU lease when editing a queued transcript", async () => {
    const owner = await queue("owner");
    await claim();
    const slot = (await slotRef.get()).data();
    const queued = await queue("edited", 1);
    await transcriptJobs.commitTranscriptEdit({ firestore: db, source, actor, job: queued.job,
      request: { ...queued.request, segments: [{ index: 0, text: "Corrected" }], speakerNames: {} },
      editedOutputs: { "segments.json": "corrected" }, speakerNames: {}, renditionBucket: config.bucket });

    expect((await queued.alignmentRef.get()).data().active).toBe(false);
    expect((await slotRef.get()).data()).toEqual(slot);
    expect((await owner.alignmentRef.get()).data().phase).toBe("running");
  });

  it("preserves completed alignment and its exports when approving word timing", async () => {
    const completed = await queue("completed");
    await completed.alignmentRef.update({ active: false, phase: "complete" });
    await completed.transcriptRef.update({ alignmentState: "review_required", alignmentRevision: 2,
      alignedOutputRequestId: completed.alignmentRef.id, alignedOutputs: { "segments.json": "aligned-segments" } });
    const job = (await completed.transcriptRef.get()).data();
    await transcriptJobs.commitTranscriptEdit({ firestore: db, source, actor, job,
      request: { ...completed.request, segments: [], speakerNames: {}, reviewed: true }, renditionBucket: config.bucket });

    expect((await completed.alignmentRef.get()).data().phase).toBe("complete");
    expect((await completed.transcriptRef.get()).data()).toMatchObject({ editRevision: 2, reviewedRevision: 2,
      alignmentRequestId: completed.alignmentRef.id, alignmentState: "ready",
      alignedOutputs: { "segments.json": "aligned-segments" } });
  });
});
