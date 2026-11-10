import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import uploads from "../../functions/source-media-uploads.js";
import uploadContract from "../../functions/lib/source-media-upload-contract.js";
import versions from "../../functions/lib/source-video-replacement.js";
import cleanup from "../../functions/lib/source-video-replacement-cleanup.js";
import runtime from "../../functions/source-video-replacement.js";
import previews from "../../functions/video-previews.js";
import previewJob from "../../functions/lib/video-preview-job.js";
import previewProcessor from "../../functions/lib/video-preview-processor.js";
import renditions from "../../functions/lib/source-media-rendition.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import publicVideo from "../../functions/lib/public-video.js";
import withdrawals from "../../functions/lib/public-video-withdrawal.js";
import publication from "../../functions/lib/source-video-replacement-publication.js";
import clips from "../../functions/video-clips.js";
import transcriptJobs from "../../functions/lib/video-transcript-job.js";
import transcriptHandlers from "../../functions/video-transcripts.js";
import transcriptProcessor from "../../functions/lib/video-transcript-processor.js";
import transcriptWorker from "../../functions/lib/video-transcript-worker.js";
import transcriptContract from "../../functions/lib/video-transcript-contract.js";
import paidBudget from "../../functions/lib/video-transcript-paid-budget.js";
import clipContract from "../../functions/lib/video-clip-contract.js";
import { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { importSourcePage } from "../../scripts/import-s3-source-media.mjs";

const db = isolatedFirestore("source-video-replacement.test.js");
// The actual H.264/AAC fixture used by the transcript worker, uploaded through the
// public multipart contract. Only external storage/workflow responses are supplied.
const video = readFileSync(new URL("../../infrastructure/boardwalk-transcription-worker/fixtures/alignment-english-h264-aac.mp4", import.meta.url));
const checksum = createHash("sha256").update(video).digest("base64");
const composite = `${createHash("sha256").update(Buffer.from(checksum, "base64")).digest("base64")}-1`;
const source = { id: "video-library", access: "active_staff", prefix: "shared/", writable: true, bucket: "fixture-originals", expectedBucketOwner: "123456789012" };
const actor = { uid: "replacement-editor", email: "editor@example.test", displayName: "Editor", principal: { id: "replacement-editor", grants: [{ role: "admin" }] } };
const startTime = Date.parse("2026-11-03T14:20:00Z");
let clock, assetId, objects, calls, completeHook;
const assetRef = () => db.doc(`mediaSourceAssets/${assetId}`);
const replacementRef = () => db.doc(`mediaSourceReplacements/${assetId}`);

function fixture(overrides = {}) {
  const asset = { id: assetId, sourceId: source.id, lifecycle: "active", kind: "video", name: "County meeting",
    originalName: "original.mp4", nameSort: "county meeting", updatedAtSort: new Date(clock).toISOString(),
    description: "Keep this description", credit: "NJ PBS", license: "Station owned", tags: ["county"],
    mimeType: "video/mp4", sizeBytes: video.length, checksumSha256: composite, version: 1, preview: "browser", rightsStatus: "complete",
    objectKey: `shared/objects/${assetId}.mp4`, objectVersionId: "original-v1", createdAt: new Date(clock).toISOString(),
    updatedAt: new Date(clock).toISOString(), createdBy: actor.uid, ...overrides };
  const job = previewJob.pendingPreview(asset, clock), prefix = `outputs/${job.id}/${job.attemptId}/`;
  asset.rendition = previewJob.renditionState(job, "ready", {
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: video.length, mimeType: "video/mp4", durationSeconds: 2 },
    poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: "poster-v1", sizeBytes: 4, mimeType: "image/jpeg" },
  });
  return asset;
}
function remember(asset) {
  for (const key of [asset.objectKey, asset.rendition.web.objectKey, asset.rendition.poster.objectKey]) objects.set(key, video);
}
const uploader = {
  async start(_source, session) { calls.push(["start", session.id]); return { uploadId: randomUUID() }; },
  async cancel() {},
  async signParts() { return []; },
  async listParts() { return [{ partNumber: 1, sizeBytes: video.length, checksumSha256: checksum, etag: "fixture-etag" }]; },
  async complete(_source, session) { objects.set(session.objectKey, video); await completeHook?.(session); return { VersionId: session.id }; },
  async head(_source, session) { return { VersionId: session.id, ContentLength: video.length, ChecksumSHA256: composite,
    Metadata: { "boardwalk-session": session.id, "boardwalk-asset": session.assetId } }; },
};
async function call(action, body, currentActor = actor, runtimeCleanup = false, cleanupDeps = {}) {
  const [parse, run, operation] = {
    start: [uploadContract.parseStartUploadRequest, uploads.startUpload, "upload"],
    sign: [uploadContract.parseSignUploadPartsRequest, uploads.signUploadParts, "upload"],
    cancel: [value => uploadContract.parseSessionRequest(value, { requiresVersion: true }), uploads.cancelUpload, "upload"],
    resume: [value => uploadContract.parseSessionRequest(value), uploads.resumeUpload, "upload"],
    complete: [value => uploadContract.parseSessionRequest(value, { requiresVersion: true }), uploads.completeUpload, "upload"],
    rollback: [value => runtime.parseReplacementRequest(value, true), async ({ firestore, actor, source, request }) => ({ asset: await versions.requestVideoRollback({ firestore, actor, source, ...request, now: clock, sessionId: randomUUID() }) }), "metadata"],
  }[action];
  const handler = uploads.makeHandler({ maxBytes: 96 * 1024, parse, run, operation }, {
    firestore: db, registryFn: () => new Map([[source.id, source]]), requirePrincipalFn: async () => currentActor,
    verifyAppCheckFn: async () => ({}), uploader, nowFn: () => new Date(clock).toISOString(), log: { error() {}, warn() {}, info() {} },
    ...(!runtimeCleanup ? { replacementEnabledFn: () => ({ enabled: true }) } : {}),
    ...cleanupDeps,
  });
  const res = { statusCode: 200, headersSent: false, set() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
  return res;
}
async function start(overrides = {}, currentActor = actor) {
  const current = (await assetRef().get()).data();
  return call("start", { sourceId: source.id, requestId: randomUUID(), originalName: "corrected.mp4", mimeType: "video/mp4",
    sizeBytes: video.length, lastModified: 1234, replacement: { assetId, expectedVersion: current.version, confirmed: true }, ...overrides }, currentActor);
}
async function upload() {
  const started = await start();
  expect(started.statusCode, JSON.stringify(started.body)).toBe(200);
  const { sessionId } = started.body.upload;
  const signed = await call("sign", { sourceId: source.id, sessionId, version: 1, parts: [{ partNumber: 1, sizeBytes: video.length, checksumSha256: checksum }] });
  expect(signed.statusCode, JSON.stringify(signed.body)).toBe(200);
  const completed = await call("complete", { sourceId: source.id, sessionId, version: signed.body.version });
  expect(completed.statusCode, JSON.stringify(completed.body)).toBe(200);
  return sessionId;
}
async function processPreview(status = "SUCCEEDED") {
  const processor = previewProcessor.createVideoPreviewProcessor({ source, workflowArn: "arn:aws:states:us-east-2:123456789012:stateMachine:fixture" }, {
    s3: { async send() { const row = (await replacementRef().get()).data(); return { VersionId: row.candidate.objectVersionId, ContentLength: video.length }; } },
    client: { async send(command) {
      if (command.constructor.name === "StartExecutionCommand") return {};
      const row = (await replacementRef().get()).data();
      const job = (await db.doc(`mediaSourcePreviewJobs/${row.jobId}`).get()).data();
      const prefix = `outputs/${job.id}/${job.attemptId}/`;
      const output = { id: job.id, attemptId: job.attemptId,
        web: { objectKey: `${prefix}preview.mp4`, objectVersionId: `${job.id}-web`, sizeBytes: video.length, mimeType: "video/mp4", durationSeconds: 2 },
        poster: { objectKey: `${prefix}preview-poster.0000000.jpg`, objectVersionId: `${job.id}-poster`, sizeBytes: 4, mimeType: "image/jpeg" } };
      return { status, output: JSON.stringify(output) };
    } },
  });
  for (let i = 0; i < 2; i++) await previews.processPreviewTick({ firestore: db, config: { source }, processor, now: () => clock });
}
async function promote(prepareCopy = async () => null) {
  await runtime.processReplacement({ firestore: db, ref: replacementRef(), source, now: clock, prepareCopy,
    requestTranscript: async ({ record }) => { calls.push(["transcript", record.assetId]); }, transcriptConfig: () => ({}) });
  const current = (await assetRef().get()).data(); remember(current); return current;
}
async function replace() { const sessionId = await upload(); await processPreview(); return { sessionId, current: await promote() }; }

// Exercise the real copy and withdrawal owners through actual SDK HTTP boundaries.
function publicCopyProviders() {
  const publicObjects = new Map();
  let firstPut;
  const origin = "https://media.njpbs.org";
  vi.stubEnv("CMS_MEDIA_PUBLIC_ORIGIN", origin);
  const urls = (asset, generation = 0) => {
    const keys = publicVideo.publicVideoKeys(assetId, asset.rendition.web, asset.rendition.poster, generation);
    return { url: `${origin}/${keys.video}`, posterUrl: `${origin}/${keys.poster}`, width: 1920, height: 1080, mimeType: "video/mp4" };
  };
  const s3 = new S3Client({ region: "us-east-2", maxAttempts: 1,
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    requestHandler: { async handle(request) {
      expect(request.method).toBe("GET");
      const bytes = request.path.endsWith(".jpg") ? Buffer.from("jpeg") : video;
      return { response: { statusCode: 200, headers: { "x-amz-version-id": request.query.versionId,
        "content-length": String(bytes.length) }, body: Readable.from([bytes]) } };
    } } });
  const client = new S3Client({ region: "auto", endpoint: "https://r2.example.invalid", forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    requestHandler: { async handle(request) {
      const key = request.path.replace(/^\/public\//, "");
      if (request.method === "HEAD") return { response: { statusCode: publicObjects.has(key) ? 200 : 404,
        headers: publicObjects.has(key) ? { "content-length": String(publicObjects.get(key).length) } : {}, body: Readable.from([]) } };
      if (request.method === "PUT") {
        await firstPut?.();
        firstPut = undefined;
        const chunks = []; for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
        publicObjects.set(key, Buffer.concat(chunks));
      } else { expect(request.method).toBe("DELETE"); publicObjects.delete(key); }
      return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
    } } });
  const r2 = { client, bucket: "public" };
  return { urls, publicObjects, beforeFirstPut(fn) { firstPut = fn; }, close() { s3.destroy(); client.destroy(); vi.unstubAllEnvs(); },
    async seed(asset) {
      const media = urls(asset);
      for (const url of [media.url, media.posterUrl]) publicObjects.set(new URL(url).pathname.slice(1), video);
      await db.doc(`cmsPublicVideos/${assetId}`).set({ schemaVersion: 1, media });
      return media;
    },
    prepareCopy: input => runtime.preparePublicCopy({ ...input, s3, r2,
      config: { renditionBucket: "fixture-derived", renditionExpectedBucketOwner: source.expectedBucketOwner } }),
    recover: (at = Date.now() + 2 * publicVideo.PUBLIC_VIDEO_OPERATION_MS) => withdrawals.createPublicVideoWithdrawalRecoveryHandler({ firestore: db, r2Fn: () => r2,
      purgeConfigFn: () => ({ zoneId: "c".repeat(32), token: "fixture" }), now: () => at,
      fetchImpl: async () => ({ ok: true, json: async () => ({ success: true }) }), log: { info() {}, warn() {}, error() {} } })(),
    withdraw: event => withdrawals.createPublicVideoWithdrawalHandler({ firestore: db, r2Fn: () => r2,
      purgeConfigFn: () => ({ zoneId: "c".repeat(32), token: "fixture" }),
      fetchImpl: async () => ({ ok: true, json: async () => ({ success: true }) }), log: { info() {}, warn() {}, error() {} } })(event),
  };
}

async function purge(now = clock, dryRun = false, remove = async version => {
  calls.push(["delete", version.binary.objectKey]);
  for (const key of [version.binary.objectKey, version.binary.rendition?.web?.objectKey, version.binary.rendition?.poster?.objectKey]) objects.delete(key);
}) {
  const queue = await db.collection(versions.PURGE_QUEUE).get();
  for (const row of queue.docs) await cleanup.cleanupVideoVersion({ firestore: db, queueRef: row.ref, now, dryRun, remove });
}

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  clock = startTime; assetId = `video-${randomUUID()}`; objects = new Map(); calls = []; completeHook = undefined;
  await db.doc(`users/${actor.uid}`).set({ active: true, role: "admin" });
  const asset = fixture(); await assetRef().set(asset); remember(asset);
});

describe("video replacement HTTP contract and processing boundary", () => {
  it("commits a replacement candidate once after the Firestore SDK retries its callback", async () => {
    const started = await start();
    expect(started.statusCode).toBe(200);
    const sessionId = started.body.upload.sessionId;
    const sessionRef = db.doc(`mediaSourceUploads/${sessionId}`);
    await sessionRef.update({ status: "completing" });
    const session = { id: sessionId, ...(await sessionRef.get()).data() };
    const holdRef = db.doc(`mediaSourcePreviewJobs/hold-${sessionId}`);
    await holdRef.set({ active: true, phase: "reserved", assetId, sourceId: source.id });
    const candidate = uploads.completedAsset(session, { VersionId: sessionId, ContentLength: video.length,
      ChecksumSHA256: composite, Metadata: { "boardwalk-session": sessionId, "boardwalk-asset": assetId } }, new Date(clock).toISOString());
    let attempts = 0;
    const retrying = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return callback => target.runTransaction(async transaction => {
        attempts++;
        const result = await callback(transaction);
        // Abort before commit: the real SDK must discard these writes and invoke
        // the same closure again, as it does after transaction contention.
        if (attempts === 1) throw Object.assign(new Error("retryable contention fixture"), { code: 10 });
        return result;
      });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const result = await versions.storeReplacementCandidate({ firestore: retrying, session, candidate, actor });
    expect(attempts).toBe(2);
    expect(result.replacement.state).toBe("processing");
    expect((await sessionRef.get()).data()).toMatchObject({ status: "completed", version: 2 });
    expect((await holdRef.get()).data()).toMatchObject({ active: false, phase: "consumed" });
    const record = (await replacementRef().get()).data();
    expect(record).toMatchObject({ state: "processing", candidate: { objectVersionId: sessionId, originalName: "corrected.mp4" } });
    const jobs = (await db.collection("mediaSourcePreviewJobs").where("assetId", "==", assetId).get()).docs
      .filter(row => row.id !== holdRef.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data()).toMatchObject({ assetId, sourceId: source.id, replacementSessionId: sessionId, active: true });
    expect((await replacementRef().collection("history").get()).size).toBe(1);
    expect((await db.collection("admin_logs").where("action", "==", "media.video.replace.request").get()).size).toBe(1);
  });

  it.each(["deleted", "changed", "superseded"])("releases a refused completed upload when its target is %s and queues exact candidate cleanup", async reason => {
    const started = await start(), sessionId = started.body.upload.sessionId;
    const signed = await call("sign", { sourceId: source.id, sessionId, version: 1,
      parts: [{ partNumber: 1, sizeBytes: video.length, checksumSha256: checksum }] });
    completeHook = async () => {
      if (reason === "deleted") await assetRef().delete();
      else if (reason === "changed") await assetRef().update({ objectVersionId: "external-change" });
      else await replacementRef().update({ sessionId: "newer-session", state: "uploading" });
    };
    const response = await call("complete", { sourceId: source.id, sessionId, version: signed.body.version });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(410);
    const sessionRef = db.doc(`mediaSourceUploads/${sessionId}`);
    expect((await sessionRef.get()).data().status).toBe("canceled");
    expect((await db.doc(`mediaSourcePreviewJobs/hold-${sessionId}`).get()).data()).toMatchObject({ active: false, phase: "released" });
    if (reason === "superseded") expect((await replacementRef().get()).data()).toMatchObject({ sessionId: "newer-session", state: "uploading" });
    else expect((await replacementRef().get()).data().state).toBe("failed");
    expect((await db.collection("mediaSourcePreviewJobs").where("actorUid", "==", actor.uid).where("active", "==", true).get()).empty).toBe(true);
    expect((await call("resume", { sourceId: source.id, sessionId })).statusCode).toBe(410);
    expect((await call("cancel", { sourceId: source.id, sessionId, version: signed.body.version })).statusCode).toBe(200);
    const queue = await db.collection(versions.PURGE_QUEUE).get();
    expect(queue.size).toBe(1);
    const candidateKey = (await sessionRef.get()).data().objectKey;
    const version = await replacementRef().collection("versions").doc(queue.docs[0].data().versionId).get();
    expect(version.data()).toMatchObject({ binary: { objectKey: candidateKey, objectVersionId: sessionId }, state: "superseded" });
    await purge(queue.docs[0].data().expiresAt);
    expect(objects.has(candidateKey)).toBe(false);
    if (reason === "changed") expect((await start()).statusCode).toBe(200);
  });
  it("releases a refused candidate recovered by Resume after the completed-object response was lost", async () => {
    const started = await start(), sessionId = started.body.upload.sessionId;
    const signed = await call("sign", { sourceId: source.id, sessionId, version: 1,
      parts: [{ partNumber: 1, sizeBytes: video.length, checksumSha256: checksum }] });
    const head = uploader.head;
    try {
      uploader.head = async () => { throw Error("S3 response lost"); };
      expect((await call("complete", { sourceId: source.id, sessionId, version: signed.body.version })).statusCode).toBe(500);
    } finally { uploader.head = head; }
    expect((await db.doc(`mediaSourceUploads/${sessionId}`).get()).data().status).toBe("completing");
    await assetRef().delete();
    expect((await call("resume", { sourceId: source.id, sessionId })).statusCode).toBe(410);
    expect((await db.doc(`mediaSourceUploads/${sessionId}`).get()).data().status).toBe("canceled");
    expect((await db.doc(`mediaSourcePreviewJobs/hold-${sessionId}`).get()).data().active).toBe(false);
    expect((await db.collection(versions.PURGE_QUEUE).get()).size).toBe(1);
  });
  it.each([null, "failed", "processing"])("refuses rollback to a retained viewing copy in state %s without locking the video", async state => {
    await replace();
    const record = (await replacementRef().get()).data();
    const previous = replacementRef().collection("versions").doc(record.previousId);
    await previous.update({ "binary.rendition": state ? { ...fixture().rendition, state } : null });
    const response = await call("rollback", { sourceId: source.id, assetId, expectedVersion: 2, confirmed: true });
    expect(response.statusCode).toBe(409);
    expect((await previous.get()).data().state).toBe("retained");
    expect((await replacementRef().get()).data().state).toBe("complete");
    expect((await start()).statusCode).toBe(200);
  });
  it("permanently releases a rollback whose accepted candidate is no longer ready", async () => {
    const { current } = await replace();
    const previous = replacementRef().collection("versions").doc((await replacementRef().get()).data().previousId);
    expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: 2, confirmed: true })).statusCode).toBe(200);
    await replacementRef().update({ "candidate.rendition.state": "failed" });
    await expect(promote()).rejects.toThrow("replacement_candidate_not_ready");
    expect((await replacementRef().get()).data()).toMatchObject({ state: "failed", errorCode: "replacement_candidate_not_ready" });
    expect((await previous.get()).data().state).toBe("retained");
    expect((await assetRef().get()).data().objectKey).toBe(current.objectKey);
    expect((await start()).statusCode).toBe(200);
  });
  it("cancels an expired upload and releases its replacement reservation", async () => {
    const started = await start();
    clock += 25 * 60 * 60 * 1000;
    const response = await call("cancel", { sourceId: source.id, sessionId: started.body.upload.sessionId, version: 1 });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    expect((await replacementRef().get()).data().state).toBe("canceled");
    expect((await assetRef().get()).data()).not.toHaveProperty("replacement");
    expect((await start()).statusCode).toBe(200);
  });
  it.each(["boardwalk", "imported", "metadata-lost"])("rescans a replaced %s asset without reviving retained or candidate keys", async layout => {
    if (layout === "imported") {
      await assetRef().delete();
      const key = "shared/external/master.mp4";
      assetId = createHash("sha256").update(`${source.id}\0${key}`).digest("hex").slice(0, 40);
      await assetRef().set(fixture({ objectKey: key }));
    }
    const old = (await assetRef().get()).data();
    const { current } = await replace();
    const keys = [old.objectKey, current.objectKey, `shared/objects/${assetId}/replacements/in-flight.mp4`];
    const s3 = { async send(command) {
      if (command.constructor.name === "ListObjectVersionsCommand") return { IsTruncated: false,
        Versions: keys.map((Key, index) => ({ Key, VersionId: index === 0 ? old.objectVersionId : current.objectVersionId,
          Size: video.length, IsLatest: true })) };
      return { ContentType: "video/mp4", Metadata: layout === "boardwalk" ? { "boardwalk-asset": assetId } : {} };
    } };
    const result = await importSourcePage({ firestore: db, s3, source, restart: true });
    expect(result).toMatchObject({ indexed: 0, skipped: 3, complete: true });
    const assets = await db.collection("mediaSourceAssets").get();
    expect(assets.size).toBe(1);
    expect(assets.docs[0].data()).toEqual(current);
    // A subsequent replacement must be able to delete the original rollback
    // version; an importer-created duplicate would permanently protect it.
    expect((await start()).statusCode).toBe(200);
  });
  it.each(["claim", "save"])("queues a processing candidate when its target disappears during preview %s", async stage => {
    await upload();
    const record = (await replacementRef().get()).data();
    const jobRef = db.doc(`mediaSourcePreviewJobs/${record.jobId}`);
    const claimed = stage === "save" ? await previewJob.claimPreview(db, jobRef, clock) : null;
    await assetRef().delete();
    if (claimed) await previewJob.savePreview(db, jobRef, claimed, { active: false, phase: "ready" },
      previewJob.renditionState(claimed, "ready", fixture().rendition));
    else await previewJob.claimPreview(db, jobRef, clock);
    expect((await jobRef.get()).data()).toMatchObject({ active: false, phase: "stale" });
    expect((await replacementRef().get()).data()).toMatchObject({ state: "failed", errorCode: "replacement_video_changed" });
    const queue = await db.collection(versions.PURGE_QUEUE).get();
    expect(queue.size).toBe(1);
    const retained = await replacementRef().collection("versions").doc(queue.docs[0].data().versionId).get();
    expect(retained.data()).toMatchObject({ state: "superseded", binary: { objectKey: record.candidate.objectKey } });
    await purge(queue.docs[0].data().expiresAt);
    expect(objects.has(record.candidate.objectKey)).toBe(false);
  });
  it("waits for an already submitted conversion to settle before deleting a missing target's candidate", async () => {
    await upload();
    const record = (await replacementRef().get()).data();
    const jobRef = db.doc(`mediaSourcePreviewJobs/${record.jobId}`);
    const pending = await previewJob.claimPreview(db, jobRef, clock);
    await assetRef().delete();
    await previewJob.savePreview(db, jobRef, pending, { phase: "running", executionArn: "fixture-workflow", leaseUntil: 0 },
      previewJob.renditionState(pending, "processing"));
    expect((await jobRef.get()).data()).toMatchObject({ active: true, phase: "running" });
    expect((await db.collection(versions.PURGE_QUEUE).get()).empty).toBe(true);
    const running = await previewJob.claimPreview(db, jobRef, clock);
    expect(running).not.toBeNull();
    await previewJob.savePreview(db, jobRef, running, { phase: "ready", active: false },
      previewJob.renditionState(running, "ready", fixture().rendition));
    expect((await replacementRef().get()).data().state).toBe("failed");
    expect((await db.collection(versions.PURGE_QUEUE).get()).size).toBe(1);
  });
  it("keeps the cleanup writer fence when a deleted target's conversion needs reconciliation", async () => {
    await upload();
    const record = (await replacementRef().get()).data();
    const jobRef = db.doc(`mediaSourcePreviewJobs/${record.jobId}`);
    const job = await previewJob.claimPreview(db, jobRef, clock);
    await previewJob.savePreview(db, jobRef, job, { phase: "running", executionArn: "fixture-workflow" },
      previewJob.renditionState(job, "processing"));
    await assetRef().delete();
    await previewJob.savePreview(db, jobRef, { ...job, phase: "running" }, { phase: "needs_reconciliation", active: false },
      previewJob.renditionState(job, "failed", { errorCode: "processing_failed" }));
    expect((await jobRef.get()).data()).toMatchObject({ phase: "needs_reconciliation", active: false });
    const queue = await db.collection(versions.PURGE_QUEUE).get();
    expect(queue.size).toBe(1);
    await purge(queue.docs[0].data().expiresAt);
    expect(objects.has(record.candidate.objectKey)).toBe(true);
    expect((await queue.docs[0].ref.get()).data().blocked).toBe("writer_reconciliation_required");
  });
  it("keeps an ordinary original conversion active after replacement until its provider settles", async () => {
    const old = (await assetRef().get()).data();
    const job = { ...previewJob.pendingPreview(old, clock), phase: "running", executionArn: "fixture-original-workflow" };
    await replace();
    const current = (await assetRef().get()).data();
    const jobRef = db.doc(`mediaSourcePreviewJobs/${job.id}`);
    await jobRef.set(job);
    const claimed = await previewJob.claimPreview(db, jobRef, clock);
    expect(claimed).not.toBeNull();
    await previewJob.savePreview(db, jobRef, claimed, { failures: 0, leaseUntil: 0 });
    expect((await jobRef.get()).data()).toMatchObject({ phase: "running", active: true });
    clock += versions.RETENTION_MS;
    await purge();
    expect(objects.has(old.objectKey)).toBe(true);
    const terminal = await previewJob.claimPreview(db, jobRef, clock);
    await previewJob.savePreview(db, jobRef, terminal, { phase: "ready", active: false },
      previewJob.renditionState(terminal, "ready", old.rendition));
    expect((await assetRef().get()).data().rendition).toEqual(current.rendition);
    expect((await jobRef.get()).data()).toMatchObject({ phase: "stale", active: false });
    clock += 15 * 60_000;
    await purge();
    expect(objects.has(old.objectKey)).toBe(false);
  });
  it("preserves an ordinary original's late start and unknown writer fence after promotion", async () => {
    const old = (await assetRef().get()).data();
    const jobRef = db.doc(`mediaSourcePreviewJobs/${previewJob.previewIdentity(old)}`);
    await jobRef.set(previewJob.pendingPreview(old, clock));
    const pending = await previewJob.claimPreview(db, jobRef, clock);
    await replace();
    expect(await previewJob.savePreview(db, jobRef, pending,
      { phase: "running", executionArn: "fixture-original-workflow", leaseUntil: 0 }, previewJob.renditionState(pending, "processing"))).toBe(true);
    const running = await previewJob.claimPreview(db, jobRef, clock);
    expect(running).not.toBeNull();
    await previewJob.savePreview(db, jobRef, running, { phase: "needs_reconciliation", active: false },
      previewJob.renditionState(running, "failed", { errorCode: "processing_failed" }));
    expect((await jobRef.get()).data()).toMatchObject({ phase: "needs_reconciliation", active: false });
    const record = (await replacementRef().get()).data();
    const previousRef = replacementRef().collection("versions").doc(record.previousId);
    const retry = await start();
    expect(retry.statusCode).toBe(200);
    expect((await previousRef.get()).data().state).toBe("retained");
    clock += versions.RETENTION_MS;
    await purge();
    expect(objects.has(old.objectKey)).toBe(true);
  });
  it("keeps a lost original start outcome fenced after its file is replaced", async () => {
    const old = (await assetRef().get()).data();
    await replace();
    const job = { ...previewJob.pendingPreview(old, clock), failures: 1 };
    const jobRef = db.doc(`mediaSourcePreviewJobs/${job.id}`);
    await jobRef.set(job);
    expect(await previewJob.claimPreview(db, jobRef, clock)).toBeNull();
    expect((await jobRef.get()).data()).toMatchObject({ phase: "needs_reconciliation", active: false });
    clock += versions.RETENTION_MS;
    await purge();
    expect(objects.has(old.objectKey)).toBe(true);
  });
  it("requires permission, explicit confirmation and an unchanged asset version before storage writes", async () => {
    const staff = { ...actor, principal: { id: actor.uid, grants: [{ role: "staff" }] } };
    expect((await start({}, staff)).statusCode).toBe(403);
    for (const replacement of [{ assetId, expectedVersion: 1, confirmed: false }, { assetId, expectedVersion: 0, confirmed: true }])
      expect((await start({ replacement })).statusCode).toBe(400);
    expect((await start({ replacement: { assetId, expectedVersion: 99, confirmed: true } })).statusCode).toBe(409);
    expect((await start({ metadata: { name: "overwrite" } })).statusCode).toBe(400);
    expect((await assetRef().get()).data()).toMatchObject({ objectVersionId: "original-v1", version: 1 });
  });
  it("keeps current playback, staff metadata and placements throughout processing, then retains one rollback version and audit hash", async () => {
    const before = (await assetRef().get()).data();
    const placement = db.doc("cmsPosts/fixture-placement");
    await placement.set({ status: "draft", blocks: [{ id: "video-block", order: 0, visible: true, type: "video", data: { sourceId: source.id, assetId } }] });
    await upload();
    await assetRef().update({ name: "Staff edit during processing", credit: "Staff credit", version: 2 });
    await processPreview();
    expect((await assetRef().get()).data()).toMatchObject({ objectVersionId: "original-v1", rendition: before.rendition });
    const current = await promote();
    expect(current).toMatchObject({ name: "Staff edit during processing", credit: "Staff credit", description: before.description, tags: before.tags, version: 3 });
    expect(current.objectVersionId).not.toBe(before.objectVersionId);
    expect((await placement.get()).data().blocks[0].data.assetId).toBe(assetId);
    const retained = await replacementRef().collection("versions").get();
    expect(retained.size).toBe(1);
    expect(retained.docs[0].data()).toMatchObject({ state: "retained", expiresAt: clock + versions.RETENTION_MS, binary: { objectKey: before.objectKey, checksumSha256: composite } });
    expect(objects.has(before.objectKey)).toBe(true);
    const history = await replacementRef().collection("history").where("action", "==", "replace").get();
    expect(history.docs[0].data()).toMatchObject({ by: "Editor", previousSizeBytes: video.length, previousChecksumSha256: composite });
    expect(calls.filter(([kind]) => kind === "transcript")).toHaveLength(1);
    expect((await db.collection("admin_logs").where("action", "==", "media.video.replace").get()).size).toBe(1);
  });
  it("processing failure leaves the old viewing copy live and allows another replacement", async () => {
    const before = (await assetRef().get()).data();
    await upload(); await processPreview("FAILED"); await promote();
    expect((await assetRef().get()).data()).toMatchObject({ objectKey: before.objectKey, rendition: before.rendition, replacement: { state: "failed" } });
    await purge();
    expect(objects.has(before.objectKey)).toBe(true);
    expect((await start()).statusCode).toBe(200);
  });
  it("public copy failure cannot promote, and an idempotent retry promotes the same candidate", async () => {
    await upload(); await processPreview();
    await expect(promote(async () => { throw Error("provider offline"); })).rejects.toThrow("provider offline");
    expect((await assetRef().get()).data().objectVersionId).toBe("original-v1");
    const first = await promote(); await promote();
    expect((await assetRef().get()).data().version).toBe(first.version);
    expect((await replacementRef().collection("versions").get()).size).toBe(1);
  });
  it("three successive promotions queue the oldest bytes and keep one restorable previous file", async () => {
    const first = (await assetRef().get()).data();
    const { current: second } = await replace(); clock++;
    await upload(); await purge();
    expect(objects.has(first.objectKey)).toBe(true);
    expect(objects.has(second.objectKey)).toBe(true);
    await processPreview(); const third = await promote(); await purge(); clock++;
    expect(objects.has(first.objectKey)).toBe(false);
    await upload(); await purge();
    expect(objects.has(second.objectKey)).toBe(true);
    await processPreview(); const fourth = await promote(); await purge();
    const retained = await replacementRef().collection("versions").get();
    expect(retained.docs.filter(row => row.data().state === "retained")).toHaveLength(1);
    expect(objects.has(first.objectKey)).toBe(false); expect(objects.has(second.objectKey)).toBe(false);
    expect(objects.has(third.objectKey)).toBe(true); expect(objects.has(fourth.objectKey)).toBe(true);
  });
  it("rollback restores the previous binary within 14 days and atomically protects it from cleanup", async () => {
    const original = (await assetRef().get()).data();
    await replace(); clock += versions.RETENTION_MS - 1;
    const response = await call("rollback", { sourceId: source.id, assetId, expectedVersion: 2, confirmed: true });
    expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
    await purge(clock + 2);
    expect(objects.has(original.objectKey)).toBe(true);
    await promote();
    expect((await assetRef().get()).data()).toMatchObject({ objectKey: original.objectKey, rendition: original.rendition });
  });
  it("expired rollback disappears with a clear label and cleanup is repeatable and dry-run safe", async () => {
    const original = (await assetRef().get()).data();
    const { current } = await replace(); clock += versions.RETENTION_MS;
    const status = await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock });
    expect(status).toMatchObject({ previous: null, previousDeleted: false, previousCleanupPending: true });
    expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: 2, confirmed: true })).statusCode).toBe(409);
    await purge(clock, true); expect(objects.has(original.objectKey)).toBe(true);
    await purge(); await purge();
    expect(objects.has(original.objectKey)).toBe(false);
    expect(objects.has(current.objectKey)).toBe(true);
    expect((await replacementRef().collection("history").get()).size).toBeGreaterThan(0);
    expect((await db.collection(versions.PURGE_QUEUE).get()).size).toBe(0);
    expect(await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock }))
      .toMatchObject({ previous: null, previousDeleted: true, previousCleanupPending: false });
  });
  it("never deletes a current version even if its purge queue entry is stale", async () => {
    const current = (await assetRef().get()).data(), versionId = "stale-current";
    await replacementRef().collection("versions").doc(versionId).set({ assetId, binary: versions.binary(current), state: "retained", expiresAt: clock });
    await db.collection(versions.PURGE_QUEUE).doc(`${assetId}-${versionId}`).set({ assetId, versionId, expiresAt: clock });
    await purge(); expect(objects.has(current.objectKey)).toBe(true);
    expect(calls.filter(([kind]) => kind === "delete")).toHaveLength(0);
  });
});

describe("publication snapshot guard", () => {
  it("updates only library video bytes, preserving drafts, editorial version and every placement", () => {
    const media = { url: `https://media.njpbs.org/cms-media/video/${assetId}/${"a".repeat(64)}.mp4`, posterUrl: `https://media.njpbs.org/cms-media/video/${assetId}/${"a".repeat(64)}.jpg`, mimeType: "video/mp4", width: 640, height: 360 };
    // Public copies use the exact immutable URL/data schema accepted by players.
    const block = { id: "video-block", order: 0, visible: true, type: "video", data: { sourceId: source.id, assetId, public: media } };
    const before = { version: 9, name: "Draft title", published: { sourceVersion: 3, blocks: [block] } };
    const nextMedia = { ...media, width: 1280 };
    const next = { ...before, published: publication.refreshSnapshot(before.published, { assetId, media: nextMedia }) };
    expect(() => publication.assertVideoReplacementRefresh(before, next, { assetId, media: nextMedia })).not.toThrow();
    expect(() => publication.assertVideoReplacementRefresh(before, { ...next, name: "Changed draft" }, { assetId, media: nextMedia })).toThrow(/editorial/);
  });
});

describe("cleanup reference and retry fences", () => {
  it.each([false, true])("releases only the deleted transcript's paid-budget slot (newer owner %s)", async newerOwner => {
    const original = (await assetRef().get()).data();
    const job = { id: "finished-paid-transcript", assetId, requestedBy: actor.uid, durationSeconds: 30,
      sourceObjectKey: original.objectKey, sourceObjectVersionId: original.objectVersionId, phase: "ready", active: false };
    const jobRef = db.doc(`mediaSourceTranscriptJobs/${job.id}`);
    await db.runTransaction(async tx => {
      const reservation = await paidBudget.admitAmazon({ tx, firestore: db, job, now: clock });
      expect(reservation).toMatchObject({ audioSeconds: 30 });
      tx.set(jobRef, { ...job, amazonBudgetReservation: reservation });
    });
    const slotRef = paidBudget.budgetRefs(db, actor.uid, new Date(clock).toISOString().slice(0, 10)).slot;
    if (newerOwner) {
      await db.doc("mediaSourceTranscriptJobs/newer-paid-transcript").set({ active: true });
      await slotRef.set({ jobId: "newer-paid-transcript" });
    }
    await replace(); clock += versions.RETENTION_MS;
    await purge(clock);
    expect((await jobRef.get()).exists).toBe(false);
    expect((await slotRef.get()).data()).toEqual({ jobId: newerOwner ? "newer-paid-transcript" : null });
    const nextJob = { id: "next-paid-transcript", requestedBy: actor.uid, durationSeconds: 30 };
    const next = await db.runTransaction(tx => paidBudget.admitAmazon({ tx, firestore: db, job: nextJob, now: clock }));
    if (newerOwner) expect(next).toBeNull();
    else {
      expect(next).toMatchObject({ audioSeconds: 30 });
      expect((await slotRef.get()).data()).toEqual({ jobId: nextJob.id });
    }
  });

  it.each(["scan_limit", "read_failure"])("defers failed %s claims without deleting bytes or repeating the scan", async failure => {
    await replace(); clock += versions.RETENTION_MS;
    const record = (await replacementRef().get()).data();
    const versionRef = replacementRef().collection("versions").doc(record.previousId);
    const queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-${record.previousId}`);
    const original = (await versionRef.get()).data(), originalQueue = (await queueRef.get()).data();
    let scans = 0, failing = true;
    const failingReads = new Proxy(db, { get(target, name) {
      if (name === "runTransaction") return fn => target.runTransaction(tx => fn(new Proxy(tx, { get(transaction, key) {
        if (key === "get") return async query => {
          if (query._queryOptions?.collectionId === "cmsPosts") {
            scans++;
            if (failing && failure === "read_failure") throw Error("reference read failed");
            const snapshot = await transaction.get(query);
            if (failing) return { docs: snapshot.docs, size: 5001 };
            return snapshot;
          }
          return transaction.get(query);
        };
        const member = Reflect.get(transaction, key, transaction);
        return typeof member === "function" ? member.bind(transaction) : member;
      } })));
      const member = Reflect.get(target, name, target);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    const remove = vi.fn(), log = { warn: vi.fn() };
    const attempt = (now, dryRun = false) => cleanup.cleanupVideoVersion({ firestore: failingReads, queueRef, now, dryRun, remove, log });
    await expect(attempt(clock, true)).resolves.toMatchObject({ blocked: "cleanup_claim_failed" });
    expect((await queueRef.get()).data()).toEqual(originalQueue);
    scans = 0;
    await expect(attempt(clock)).resolves.toMatchObject({ blocked: "cleanup_claim_failed" });
    const deferred = (await queueRef.get()).data();
    expect(deferred).toMatchObject({ blocked: "cleanup_claim_failed", expiresAt: clock + 15 * 60_000, nextAttemptAt: clock + 15 * 60_000 });
    for (let minute = 1; minute < 15; minute++) await attempt(clock + minute * 60_000);
    expect(scans).toBe(1);
    expect(remove).not.toHaveBeenCalled();
    expect((await versionRef.get()).data()).toEqual(original);
    failing = false;
    await versionRef.update({ leaseUntil: deferred.nextAttemptAt + 1 });
    await attempt(deferred.nextAttemptAt);
    expect(remove).not.toHaveBeenCalled();
    expect((await queueRef.get()).data()).toMatchObject({ blocked: "cleanup_lease_active" });
    await attempt(deferred.nextAttemptAt + 15 * 60_000);
    expect(remove).toHaveBeenCalledOnce();
    expect((await versionRef.get()).exists).toBe(false);
    expect((await queueRef.get()).exists).toBe(false);
  });

  it.each(["published_reference", "writer_reconciliation_required"])("bounds scans during repeated %s ticks and revalidates before deletion", async reason => {
    const old = (await assetRef().get()).data();
    await replace();
    const record = (await replacementRef().get()).data();
    const versionRef = replacementRef().collection("versions").doc(record.previousId);
    const queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-${record.previousId}`);
    const media = { url: `https://media.njpbs.org/cms-media/video/${assetId}/${"b".repeat(64)}.mp4` };
    await versionRef.update({ publicMedia: media });
    const protectionRef = reason === "published_reference" ? db.doc("cmsPosts/protected-player") : db.doc("mediaSourceTranscriptJobs/protected-writer");
    await protectionRef.set(reason === "published_reference"
      ? { status: "published", publishBuildPending: true, published: { previousVideoCopies: [{ assetId, url: media.url }] } }
      : { assetId, sourceObjectKey: old.objectKey, sourceObjectVersionId: old.objectVersionId,
        phase: "needs_reconciliation", active: false });
    const queries = [];
    const counted = new Proxy(db, { get(target, name) {
      if (name === "runTransaction") return fn => target.runTransaction(tx => fn(new Proxy(tx, { get(transaction, key) {
        if (key === "get") return query => {
          if (query._queryOptions) queries.push(query._queryOptions.collectionId);
          return transaction.get(query);
        };
        const member = Reflect.get(transaction, key, transaction);
        return typeof member === "function" ? member.bind(transaction) : member;
      } })));
      const member = Reflect.get(target, name, target);
      return typeof member === "function" ? member.bind(target) : member;
    } });
    const remove = vi.fn();
    clock += versions.RETENTION_MS;
    const at = clock;
    for (let minute = 0; minute < 60; minute++) {
      await cleanup.cleanupVideoVersion({ firestore: counted, queueRef, now: at + minute * 60_000, remove });
    }
    const pending = (await queueRef.get()).data();
    expect(pending).toMatchObject({ blocked: reason, nextAttemptAt: at + 60 * 60_000 });
    // Four eligible attempts, instead of sixty full scans. A known writer
    // refuses deletion before any content scan; neither path caches permission.
    expect(queries.filter(name => name === "mediaSourceTranscriptJobs")).toHaveLength(4);
    expect(queries.filter(name => name === "cmsPosts")).toHaveLength(reason === "published_reference" ? 4 : 0);
    expect(remove).not.toHaveBeenCalled();
    await protectionRef.delete();
    // A new protection appearing during the delay must still defeat deletion.
    await versionRef.update({ leaseUntil: pending.nextAttemptAt + 1 });
    await cleanup.cleanupVideoVersion({ firestore: counted, queueRef, now: pending.nextAttemptAt, remove });
    expect(remove).not.toHaveBeenCalled();
    expect((await queueRef.get()).data()).toMatchObject({ blocked: "cleanup_lease_active", nextAttemptAt: pending.nextAttemptAt + 15 * 60_000 });
    const next = (await queueRef.get()).data().nextAttemptAt;
    await cleanup.cleanupVideoVersion({ firestore: counted, queueRef, now: next, remove });
    expect(remove).toHaveBeenCalledOnce();
    expect((await versionRef.get()).exists).toBe(false);
    expect((await queueRef.get()).exists).toBe(false);
    expect((await assetRef().get()).data().objectVersionId).not.toBe(old.objectVersionId);
  });

  it("uses a fixed deferral delay and leaves dry-run queue records unchanged", async () => {
    const current = (await assetRef().get()).data();
    const versionRef = replacementRef().collection("versions").doc("protected-current");
    const queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-protected-current`);
    await versionRef.set({ assetId, binary: versions.binary(current), state: "retained" });
    await queueRef.set({ assetId, versionId: versionRef.id, expiresAt: clock, blocked: "current_file_or_rollback" });
    const before = (await queueRef.get()).data();
    const remove = vi.fn();
    await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: clock, dryRun: true, remove });
    expect((await queueRef.get()).data()).toEqual(before);
    await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: clock, remove });
    expect((await queueRef.get()).data()).toMatchObject({ blocked: "current_file_or_rollback", nextAttemptAt: clock + 15 * 60_000 });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    "video_cleanup_configuration_missing", "video_cleanup_replication_pending", "video_cleanup_scope_invalid",
    "video_cleanup_inventory_invalid", "video_cleanup_inventory_incomplete", "video_cleanup_public_scope_invalid",
    "video_cleanup_lease_changed", "provider-error", "plain-object", "null",
  ])("scheduled cleanup logs a safe retry code and preserves protected state for %s", async failure => {
    const current = (await assetRef().get()).data();
    const versionRef = replacementRef().collection("versions").doc("expired");
    const queueRef = db.collection(versions.PURGE_QUEUE).doc(assetId);
    await versionRef.set({ assetId, state: "retained", expiresAt: clock,
      binary: { ...versions.binary(current), objectKey: `shared/objects/${assetId}-expired.mp4`, objectVersionId: "expired-v1" } });
    await queueRef.set({ assetId, versionId: "expired", expiresAt: clock });
    const warnings = [];
    const privateDetail = "https://storage.example.test/private?X-Amz-Signature=fixture-only";
    await runtime.processReplacements({ firestore: db, source, now: clock, dryRun: false,
      log: { warn: (...args) => warnings.push(args) }, remove: async version => {
        if (failure === "video_cleanup_lease_changed") { await version.versionRef.update({ leaseOwner: "newer-owner" }); return; }
        if (failure === "null") throw null;
        if (failure === "plain-object") throw { message: privateDetail, credential: "fixture-only" };
        throw Object.assign(Error(failure === "provider-error" ? privateDetail : failure), { response: { body: privateDetail } });
      } });
    expect(warnings).toEqual([["Video version cleanup will retry", { queueId: assetId,
      code: failure.startsWith("video_cleanup_") ? failure : "video_cleanup_failed" }]]);
    expect(JSON.stringify(warnings)).not.toContain(privateDetail);
    expect((await assetRef().get()).data()).toEqual(current);
    expect((await queueRef.get()).exists).toBe(true);
    const retained = (await versionRef.get()).data();
    expect(retained.state).toBe("deleting");
    expect(retained.leaseUntil).toBeGreaterThan(clock);
    if (failure === "video_cleanup_lease_changed") expect(retained.leaseOwner).toBe("newer-owner");
  });

  it("admits another upload while an uncertain old writer remains protected from deletion", async () => {
    const before = (await assetRef().get()).data();
    await replace();
    const record = (await replacementRef().get()).data();
    const previousRef = replacementRef().collection("versions").doc(record.previousId);
    const queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-${record.previousId}`);
    const expiry = (await queueRef.get()).data().expiresAt;
    await db.doc(`mediaSourceTranscriptJobs/${"e".repeat(64)}`).set({ assetId, sourceId: source.id,
      sourceObjectKey: before.objectKey, sourceObjectVersionId: before.objectVersionId, sourceSizeBytes: before.sizeBytes,
      provider: "local", phase: "needs_reconciliation", active: false, leaseUntil: 0 });
    const next = await start();
    expect(next.statusCode).toBe(200);
    expect((await previousRef.get()).data().state).toBe("retained");
    expect((await replacementRef().get()).data().previousId).toBe(record.previousId);
    expect((await queueRef.get()).data().expiresAt).toBe(expiry);
    await purge(clock + versions.RETENTION_MS);
    expect(objects.has(before.objectKey)).toBe(true);
    expect((await queueRef.get()).data().blocked).toBe("writer_reconciliation_required");
  });
  it("deletes only expired versions and defers any still referenced by a published player", async () => {
    await replace();
    await purge(clock + versions.RETENTION_MS - 1);
    expect(calls.some(([kind]) => kind === "delete")).toBe(false);
    const version = (await replacementRef().collection("versions").get()).docs[0];
    const media = { url: `https://media.njpbs.org/cms-media/video/${assetId}/${"b".repeat(64)}.mp4`, posterUrl: `https://media.njpbs.org/cms-media/video/${assetId}/${"b".repeat(64)}.jpg`, width: 640, height: 360, mimeType: "video/mp4" };
    await version.ref.update({ publicMedia: media });
    await db.doc("cmsPosts/live-player").set({ status: "published", published: { blocks: [{ id: "video-block", order: 0, visible: true, type: "video", data: { sourceId: source.id, assetId, public: media } }] } });
    clock += versions.RETENTION_MS;
    await purge(); expect(calls.some(([kind]) => kind === "delete")).toBe(false);
    expect((await version.ref.get()).data().state).toBe("retained");
  });
  it("retries a partial provider deletion after its lease without losing the rollback exclusion", async () => {
    const old = (await assetRef().get()).data(); await replace(); clock += versions.RETENTION_MS;
    await expect(purge(clock, false, async () => { throw Error("storage unavailable"); })).rejects.toThrow("storage unavailable");
    const version = (await replacementRef().collection("versions").get()).docs[0];
    expect(version.data().state).toBe("deleting");
    const rollback = await call("rollback", { sourceId: source.id, assetId, expectedVersion: 2, confirmed: true });
    expect(rollback.statusCode).toBe(409);
    clock += 16 * 60_000; await purge(); await purge();
    expect(objects.has(old.objectKey)).toBe(false);
    expect((await db.collection(versions.PURGE_QUEUE).get()).size).toBe(0);
  });
});

describe("cleanup defense against inconsistent metadata", () => {
  it("protects the current object even if retained metadata has a different size", async () => {
    const current = (await assetRef().get()).data(), versionId = "inconsistent-size";
    await replacementRef().collection("versions").doc(versionId).set({ assetId, binary: { ...versions.binary(current), sizeBytes: 1 }, state: "retained", expiresAt: clock });
    await db.collection(versions.PURGE_QUEUE).doc(`${assetId}-${versionId}`).set({ assetId, versionId, expiresAt: clock });
    await purge(); expect(objects.has(current.objectKey)).toBe(true); expect(calls.some(([kind]) => kind === "delete")).toBe(false);
  });
});

async function seedPublicationOwner() {
  const { seedSwitch } = await import("../helpers/public-release-switch.js");
  const protocol = (await import("../../functions/lib/public-release-pair.js")).default;
  const admission = (await import("../../functions/lib/public-release-admission.js")).default;
  const dbTarget = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  const contract = { schemaVersion: 2, families: ["posts", "pages", "settings", "context"], features: [] };
  await seedSwitch(dbTarget, { admittedContract: contract });
  await db.doc(`${admission.CONTRACTS}/${protocol.publicReleaseDigest(contract)}`).set(contract);
  await db.doc(`${admission.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, enabled: true, revision: 1,
    backgroundBucket: "njpbs-dev-public-artifacts", families: { posts: { mode: "all" }, pages: { mode: "all" } } });
  return dbTarget;
}

describe("replacement through the real publication admission owner", () => {
  it("refreshes a restored public file after a delayed A-to-B withdrawal", async () => {
    const dbTarget = await seedPublicationOwner();
    const providers = publicCopyProviders();
    try {
      const original = (await assetRef().get()).data();
      const oldMedia = await providers.seed(original);
      await upload(); await processPreview(); const current = await promote(providers.prepareCopy);
      const currentMedia = (await db.doc(`cmsPublicVideos/${assetId}`).get()).data().media;
      const block = media => ({ id: "video-block", order: 0, visible: true, type: "video",
        data: { sourceId: source.id, assetId, title: "Meeting", public: media } });
      const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id: "contact", version: 1, title: "Contact", blocks: [] },
        publishedAt: new Date(clock).toISOString(), publishedBy: actor.uid });
      const document = { id: "contact", version: 2, title: "Unpublished staff draft", blocks: [], status: "published", publiclyVisible: true,
        publishAt: published.publishedAt, published: { ...published, blocks: [block(currentMedia)] } };
      const ref = db.doc("cmsPages/contact"); await ref.set(document);
      const old = { ...document, published: { ...published, blocks: [block(oldMedia)] } };
      const event = { data: { before: { data: () => old }, after: { data: () => document, ref } } };
      expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: current.version, confirmed: true })).statusCode).toBe(200);
      const record = (await replacementRef().get()).data(); await replacementRef().update({ state: "promoting" });
      const copy = await providers.prepareCopy({ firestore: db, asset: original, source, actorUid: actor.uid });
      await versions.promoteReplacement({ firestore: db, assetId, sessionId: record.sessionId, now: clock, publicCopy: copy });
      await providers.withdraw(event);
      const restored = (await db.doc(`cmsPublicVideos/${assetId}`).get()).data();
      expect(restored.revoked).not.toBe(true);
      expect(restored.media.url).not.toBe(oldMedia.url);
      for (const url of [restored.media.url, restored.media.posterUrl]) expect(providers.publicObjects.has(new URL(url).pathname.slice(1))).toBe(true);
      const result = await publication.migrateVideoReferences({ firestore: dbTarget, assetId, media: restored.media });
      expect(result).toMatchObject({ changed: 1, failedOwners: [] });
      expect((await ref.get()).data().published.blocks[0].data.public).toEqual(restored.media);
      expect((await ref.get()).data().title).toBe("Unpublished staff draft");
    } finally { providers.close(); }
  });

  it("does not reuse a failed rollback's public generation on its next attempt", async () => {
    const providers = publicCopyProviders();
    try {
      const original = (await assetRef().get()).data(); await providers.seed(original);
      await upload(); await processPreview(); const current = await promote(providers.prepareCopy);
      const currentMedia = (await db.doc(`cmsPublicVideos/${assetId}`).get()).data().media;
      expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: current.version, confirmed: true })).statusCode).toBe(200);
      let failedMedia;
      await expect(promote(async input => {
        const copy = await providers.prepareCopy(input); failedMedia = copy.record.media;
        await db.doc(`users/${actor.uid}`).update({ active: false }); return copy;
      })).rejects.toMatchObject({ status: 403 });
      expect((await db.doc(`cmsPublicVideos/${assetId}`).get()).data().media).toEqual(currentMedia);
      await db.doc(`users/${actor.uid}`).update({ active: true });
      expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: current.version, confirmed: true })).statusCode).toBe(200);
      await promote(providers.prepareCopy);
      const restored = (await db.doc(`cmsPublicVideos/${assetId}`).get()).data();
      expect(restored.media.url).not.toBe(failedMedia.url);
      const before = { status: "published", publiclyVisible: true, published: { blocks: [{ type: "video", visible: true, order: 0,
        data: { sourceId: source.id, assetId, public: failedMedia } }] } };
      await providers.withdraw({ data: { before: { data: () => before }, after: { data: () => null } } });
      expect((await db.doc(`cmsPublicVideos/${assetId}`).get()).data().revoked).not.toBe(true);
      for (const url of [restored.media.url, restored.media.posterUrl]) expect(providers.publicObjects.has(new URL(url).pathname.slice(1))).toBe(true);
    } finally { providers.close(); }
  });
  it.each(["post", "page"])("queues a %s binary refresh without publishing its saved draft", async kind => {
    const dbTarget = await seedPublicationOwner();
    const media = { url: `https://media.njpbs.org/cms-media/video/${assetId}/${"c".repeat(64)}.mp4`, posterUrl: `https://media.njpbs.org/cms-media/video/${assetId}/${"c".repeat(64)}.jpg`, width: 640, height: 360, mimeType: "video/mp4" };
    const newMedia = { ...media, url: media.url.replace("c".repeat(64), "d".repeat(64)), posterUrl: media.posterUrl.replace("c".repeat(64), "d".repeat(64)) };
    let document, documentId, collection;
    if (kind === "post") {
      const post = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
      document = { ...post, type: "post", version: post.published.sourceVersion + 1, title: "Unpublished staff draft", blocks: [] };
      documentId = post.id; collection = "cmsPosts";
    } else {
      documentId = "contact"; collection = "cmsPages";
      const published = snapshots.createPublishedSnapshot({ collection, document: { id: documentId, version: 1, title: "Contact", blocks: [] }, publishedAt: new Date(clock).toISOString(), publishedBy: actor.uid });
      document = { id: documentId, version: 2, title: "Unpublished staff draft", blocks: [], status: "published", publiclyVisible: true, publishAt: published.publishedAt, published };
    }
    document.published.blocks = [{ id: "video-block", order: 0, visible: true, type: "video", data: { sourceId: source.id, assetId, title: "Meeting", public: media } }];
    await db.doc(`${collection}/${documentId}`).set(document);
    await db.doc(`cmsPublicVideos/${assetId}`).set({ media: newMedia });
    const result = await publication.migrateVideoReferences({ firestore: dbTarget, assetId, media: newMedia });
    expect(result.changed).toBe(1); expect(result.pending).toBe(true);
    const updated = (await db.doc(`${collection}/${documentId}`).get()).data();
    expect(updated).toMatchObject({ version: document.version, title: "Unpublished staff draft", blocks: [], publishBuildPending: true,
      published: { sourceVersion: document.published.sourceVersion, blocks: [{ data: { assetId, public: newMedia } }] } });
    expect(updated.published.previousVideoCopies).toContainEqual({ assetId, url: media.url });
    const queue = (await db.doc(`cmsPublishQueue/${updated.publishBuildQueueId}`).get()).data();
    expect(queue).toMatchObject({ status: "pending", transport: "release-pair-publication-v2" });
  });
});

describe("replacement upload admission after failed cleanup", () => {
  it("starts and signs another upload without deleting the previous file", async () => {
    const old = (await assetRef().get()).data();
    await replace(); clock++;
    const record = (await replacementRef().get()).data();
    const previousRef = replacementRef().collection("versions").doc(record.previousId);
    await previousRef.update({ leaseUntil: clock + 15 * 60_000 });
    const before = (await previousRef.get()).data();
    const started = await start(); expect(started.statusCode).toBe(200);
    const { sessionId } = started.body.upload;
    const signed = await call("sign", { sourceId: source.id, sessionId, version: 1,
      parts: [{ partNumber: 1, sizeBytes: video.length, checksumSha256: checksum }] });
    expect(signed.statusCode).toBe(200);
    expect((await assetRef().get()).data().version).toBe(2);
    expect((await previousRef.get()).data()).toEqual(before);
    expect(objects.has(old.objectKey)).toBe(true);
    expect(calls.some(([kind]) => kind === "delete")).toBe(false);
    expect((await call("cancel", { sourceId: source.id, sessionId, version: signed.body.version })).statusCode).toBe(200);
  });
});

it("leaves an existing cleanup lease and retry queue untouched through upload and promotion", async () => {
  const old = (await assetRef().get()).data();
  await replace(); clock += versions.RETENTION_MS;
  await expect(purge(clock, false, async () => { throw Error("storage unavailable"); })).rejects.toThrow("storage unavailable");
  const previousId = (await replacementRef().get()).data().previousId;
  const versionRef = replacementRef().collection("versions").doc(previousId);
  const originalLease = (await versionRef.get()).data();
  const queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-${previousId}`);
  const originalQueue = (await queueRef.get()).data();
  expect(originalLease.state).toBe("deleting");
  await upload();
  expect((await versionRef.get()).data()).toEqual(originalLease);
  expect((await queueRef.get()).data()).toEqual(originalQueue);
  expect(objects.has(old.objectKey)).toBe(true);
  await processPreview(); await promote();
  expect((await versionRef.get()).data()).toEqual(originalLease);
  expect((await queueRef.get()).data()).toEqual(originalQueue);
});

describe("review regressions for cleanup activation and queue fairness", () => {
  it("dry-run rejects a replacement before touching the retained rollback or opening a multipart session", async () => {
    await replace(); const before = (await replacementRef().get()).data(); const previous = await replacementRef().collection("versions").get();
    const starts = calls.filter(([kind]) => kind === "start").length;
    const current = (await assetRef().get()).data();
    const response = await call("start", { sourceId: source.id, requestId: randomUUID(), originalName: "corrected.mp4", mimeType: "video/mp4",
      sizeBytes: video.length, lastModified: 1234, replacement: { assetId, expectedVersion: current.version, confirmed: true } }, actor, true);
    expect(response.statusCode).toBe(503); expect(response.body.code).toBe("replacement_unavailable");
    expect((await replacementRef().get()).data()).toEqual(before);
    expect((await previous.docs[0].ref.get()).data().state).toBe("retained");
    expect(calls.filter(([kind]) => kind === "start")).toHaveLength(starts);
  });
  it("ten protected due entries do not starve a later expired version", async () => {
    const current = (await assetRef().get()).data(), deleted = [];
    for (let i = 0; i < 10; i++) {
      const blockedId = `blocked-${i}`;
      await db.doc(`mediaSourceReplacements/${blockedId}/versions/old`).set({ assetId: blockedId, binary: versions.binary(current), state: "retained", expiresAt: clock - 100 });
      await db.doc(`${versions.PURGE_QUEUE}/${blockedId}`).set({ assetId: blockedId, versionId: "old", expiresAt: clock - 100 });
    }
    await db.doc("mediaSourceReplacements/eligible/versions/old").set({ assetId: "eligible", binary: { ...versions.binary(current), objectKey: "objects/expired.mp4", objectVersionId: "expired" }, state: "retained", expiresAt: clock });
    await db.doc(`${versions.PURGE_QUEUE}/eligible`).set({ assetId: "eligible", versionId: "old", expiresAt: clock });
    const tick = () => runtime.processReplacements({ firestore: db, source, now: clock, dryRun: false, remove: async version => { deleted.push(version.assetId); }, log: { warn() {} } });
    await tick(); expect(deleted).toEqual([]);
    await tick(); expect(deleted).toEqual(["eligible"]);
    expect((await assetRef().get()).data().objectVersionId).toBe(current.objectVersionId);
  });
});

describe("deployment and cancellation boundaries", () => {
  it.each(["cmsStartSourceMediaUpload", "cmsSignSourceMediaUploadParts", "cmsResumeSourceMediaUpload", "cmsCompleteSourceMediaUpload"])("uploads need only the edge secret on %s", name => {
    const names = uploads[name].__endpoint.secretEnvironmentVariables.map(secret => secret.key);
    expect(names).toEqual(["CMS_EDGE_ORIGIN_SECRET"]);
  });
  it("keeps and queues the live file's pending transcript after a later replacement is canceled", async () => {
    const { current } = await replace();
    await replacementRef().update({ transcriptPending: true, transcriptError: "transcription_waiting" });
    const next = await start(); expect(next.statusCode).toBe(200);
    const { sessionId, version } = next.body.upload;
    expect((await call("cancel", { sourceId: source.id, sessionId, version })).statusCode).toBe(200);
    expect((await replacementRef().get()).data().transcriptPending).toBe(true);
    await runtime.processReplacement({ firestore: db, ref: replacementRef(), source, now: clock, transcriptConfig: () => ({ enabled: true, localEnabled: true }) });
    const jobs = await db.collection("mediaSourceTranscriptJobs").where("assetId", "==", assetId).get();
    expect(jobs.size).toBe(1);
    expect(jobs.docs[0].data()).toMatchObject({ sourceObjectKey: current.objectKey, sourceObjectVersionId: current.objectVersionId, active: true });
    const selected = await transcriptJobs.getTranscriptJob({ firestore: db, source,
      request: transcriptContract.parseTranscriptRequest({ sourceId: source.id, assetId }, { read: true }) });
    expect(selected).toMatchObject({ id: jobs.docs[0].id, maxSpeakers: 10, active: true });
    expect((await replacementRef().get()).data().transcriptPending).toBe(false);
  });
  it.each([false, true])("exposes replacement only when the runtime is ready (%s)", async enabled => {
    const sourceMedia = (await import("../../functions/source-media.js")).default;
    const handler = sourceMedia.createCmsListMediaSourcesHandler({ firestore: db, requirePrincipalFn: async () => actor,
      registryFn: () => new Map([[source.id, source]]), replacementEnabledFn: () => enabled, log: { error() {} } });
    const res = { headersSent: false, set() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method: "POST", body: {}, rawBody: Buffer.from("{}"), headers: { "content-type": "application/json" } }, res);
    expect(res.body.sources[0]).toMatchObject({ canEditMetadata: true, canReplace: enabled });
  });
});


describe("review regressions for reference scans and interrupted cancellation", () => {
  it("reads reference fields without fetching unrelated editorial payloads", async () => {
    const ref = db.doc("cmsPosts/reference-scan");
    const block = { id: "source-video", type: "video", visible: true, order: 0, data: { sourceId: source.id, assetId } };
    await ref.set({ type: "post", status: "scheduled", blocks: [block], title: "Unrelated saved draft title",
      internalNotes: "Internal review context", published: { sourceVersion: 3, blocks: [], metadata: { type: "post", title: "Unrelated published title" } } });
    const row = (await publication.contentRows(db)).find(row => row.id === ref.id);
    expect(row.ref.path).toBe(ref.path);
    expect(row.data()).toMatchObject({ type: "post", status: "scheduled", blocks: [block], published: { sourceVersion: 3 } });
    expect(row.data()).not.toHaveProperty("title");
    expect(row.data()).not.toHaveProperty("internalNotes");
    expect(row.data().published.metadata).not.toHaveProperty("title");
  });
  it("reconciles an interrupted cancellation on retry and immediately admits the next replacement", async () => {
    const first = await start(); expect(first.statusCode).toBe(200);
    const { sessionId, version } = first.body.upload;
    // Persist the real interrupted boundary: cancellation committed, replacement lock still held.
    await db.doc(`mediaSourceUploads/${sessionId}`).update({ status: "canceled", version: version + 2, canceledAt: new Date(clock).toISOString() });
    expect((await replacementRef().get()).data().state).toBe("uploading");
    expect((await call("cancel", { sourceId: source.id, sessionId, version })).statusCode).toBe(200);
    expect((await replacementRef().get()).data().state).toBe("canceled");
    expect((await assetRef().get()).data()).not.toHaveProperty("replacement");
    expect((await start()).statusCode).toBe(200);
  });
});


it("promotes a legacy file without a checksum storage read and records missing metadata honestly", async () => {
  const before = (await assetRef().get()).data();
  const { FieldValue } = await import("firebase-admin/firestore");
  await assetRef().update({ checksumSha256: FieldValue.delete() });
  await upload(); await processPreview();
  await promote();
  expect((await assetRef().get()).data().objectVersionId).not.toBe(before.objectVersionId);
  const history = await replacementRef().collection("history").where("action", "==", "replace").get();
  expect(history.docs[0].data()).toMatchObject({ previousSizeBytes: video.length, previousChecksum: null });
  const retained = await replacementRef().collection("versions").get();
  expect(retained.docs[0].data()).toMatchObject({ checksum: null, binary: { checksumSha256: null } });
});


it.each([false, true])("a failed private-version cleanup does not create or lock public copy state (existing: %s)", async existing => {
  await replace();
  const ref = db.doc(`cmsPublicVideos/${assetId}`), currentRecord = { assetId, revoked: false, publicGeneration: 2 };
  if (existing) await ref.set(currentRecord);
  await expect(purge(clock + versions.RETENTION_MS, false, async () => { throw Error("provider unavailable"); })).rejects.toThrow("provider unavailable");
  const after = await ref.get();
  expect(after.exists).toBe(existing);
  if (existing) expect(after.data()).toEqual(currentRecord);
  const copy = await publicVideo.acquirePublicVideoCopy({ firestore: db, assetId, now: clock + versions.RETENTION_MS });
  await copy.release();
  expect((await ref.get()).exists).toBe(existing);
});


it.each([false, true])("releases only its own public cleanup slot after a provider failure (new owner: %s)", async changedOwner => {
  await replace();
  const record = (await replacementRef().get()).data();
  const versionRef = replacementRef().collection("versions").doc(record.previousId);
  const oldMedia = { url: `https://media.njpbs.org/cms-media/video/${assetId}/${"a".repeat(64)}.mp4`,
    posterUrl: `https://media.njpbs.org/cms-media/video/${assetId}/${"a".repeat(64)}.jpg`, width: 640, height: 360, mimeType: "video/mp4" };
  const currentMedia = { ...oldMedia, url: oldMedia.url.replace("a".repeat(64), "b".repeat(64)),
    posterUrl: oldMedia.posterUrl.replace("a".repeat(64), "b".repeat(64)) };
  await versionRef.update({ publicMedia: oldMedia });
  const publicRef = db.doc(`cmsPublicVideos/${assetId}`);
  await publicRef.set({ assetId, media: currentMedia, revoked: false });
  const cleanupNow = clock + versions.RETENTION_MS;
  await expect(purge(cleanupNow, false, async () => {
    expect((await publicRef.get()).data().operation.kind).toBe("withdraw");
    if (changedOwner) await publicRef.update({ operation: { id: "newer-owner", kind: "publish", expiresAt: cleanupNow + 60_000 } });
    throw Error("video_cleanup_replication_pending");
  })).rejects.toThrow("video_cleanup_replication_pending");
  const after = (await publicRef.get()).data();
  expect(after.media).toEqual(currentMedia);
  expect(after.revoked).toBe(false);
  const retained = (await versionRef.get()).data();
  expect(retained.state).toBe("deleting");
  expect(retained.leaseUntil).toBeGreaterThan(cleanupNow);
  if (changedOwner) expect(after.operation.id).toBe("newer-owner");
  else {
    expect(after).not.toHaveProperty("operation");
    const copy = await publicVideo.acquirePublicVideoCopy({ firestore: db, assetId, now: cleanupNow });
    await copy.release();
    expect((await versionRef.get()).data().state).toBe("deleting");
  }
});





it("keeps a lost alignment writer fenced beyond retention while another upload is admitted", async () => {
  const old = (await assetRef().get()).data();
  await replace();
  const transcriptId = "b".repeat(64), alignmentId = "c".repeat(64);
  await db.doc(`mediaSourceTranscriptJobs/${transcriptId}`).set({ id: transcriptId, assetId, sourceId: source.id,
    sourceObjectKey: old.objectKey, sourceObjectVersionId: old.objectVersionId, sourceSizeBytes: old.sizeBytes,
    phase: "ready", active: false, leaseUntil: 0 });
  await db.doc(`mediaSourceTranscriptAlignmentJobs/${alignmentId}`).set({ id: alignmentId, transcriptId,
    phase: "needs_reconciliation", errorCode: "alignment_worker_lost", active: false, leaseUntil: 0, audioReadLeaseUntil: clock - 1 });
  const result = await start();
  expect(result.statusCode).toBe(200);
  clock += versions.RETENTION_MS;
  await purge();
  expect(objects.has(old.objectKey)).toBe(true);
  const queue = await db.collection(versions.PURGE_QUEUE).get();
  expect(queue.docs[0].data().blocked).toBe("writer_reconciliation_required");
});

it("continues past an unrefreshable published owner, reports the failure and admits rollback", async () => {
  const dbTarget = await seedPublicationOwner();
  await replace();
  const media = { url: `https://media.njpbs.org/cms-media/video/${assetId}/${"c".repeat(64)}.mp4`, posterUrl: `https://media.njpbs.org/cms-media/video/${assetId}/${"c".repeat(64)}.jpg`, width: 640, height: 360, mimeType: "video/mp4" };
  const newMedia = { ...media, url: media.url.replace("c".repeat(64), "d".repeat(64)), posterUrl: media.posterUrl.replace("c".repeat(64), "d".repeat(64)) };
  const block = { id: "video-block", order: 0, visible: true, type: "video", data: { sourceId: source.id, assetId, title: "Meeting", public: media } };
  const broken = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
  broken.id = "000-unrefreshable"; delete broken.type; broken.publiclyVisible = true;
  broken.published.blocks = [block];
  await db.doc(`cmsPosts/${broken.id}`).set(broken);
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id: "contact", version: 1, title: "Contact", blocks: [block] }, publishedAt: new Date(clock).toISOString(), publishedBy: actor.uid });
  await db.doc("cmsPages/contact").set({ id: "contact", version: 2, title: "Saved draft", blocks: [], status: "published", publiclyVisible: true, publishAt: published.publishedAt, published });
  await db.doc(`cmsPublicVideos/${assetId}`).set({ media: newMedia });
  await replacementRef().update({ migrationPending: true });
  await runtime.processReplacement({ firestore: dbTarget, ref: replacementRef(), source, now: clock, log: { warn() {} } });
  const state = await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock });
  expect(state).toMatchObject({ state: "complete", migrationPending: true, errorCode: "publication_refresh_failed", asset: { replacement: { errorCode: "publication_refresh_failed" } } });
  expect((await replacementRef().get()).data().migrationFailedOwners).toEqual([`cmsPosts/${broken.id}`]);
  expect((await db.doc("cmsPages/contact").get()).data()).toMatchObject({ publishBuildPending: true, published: { blocks: [{ data: { public: newMedia } }] } });
  const next = await start(); expect(next.statusCode).toBe(409); expect(next.body.error).toContain("Restore the previous file");
  expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: state.asset.version, confirmed: true })).statusCode).toBe(200);
  expect((await replacementRef().get()).data()).toMatchObject({ state: "ready", rollbackPreviousId: state.previous.id });
  await db.doc(`users/${actor.uid}`).update({ active: false });
  await expect(promote(async () => {
    const lease = await publicVideo.acquirePublicVideoCopy({ firestore: db, assetId });
    return { ...lease, record: lease.previous };
  })).rejects.toMatchObject({ status: 403 });
  const refused = await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock });
  expect(refused).toMatchObject({ state: "complete", migrationPending: true, errorCode: "publication_refresh_failed",
    previous: { id: state.previous.id }, asset: { replacement: { state: "complete", errorCode: "publication_refresh_failed" } } });
  await db.doc(`users/${actor.uid}`).update({ active: true });
  await db.doc(`cmsPosts/${broken.id}`).delete();
  await runtime.processReplacement({ firestore: dbTarget, ref: replacementRef(), source, now: clock, log: { warn() {} } });
  expect(await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock }))
    .toMatchObject({ state: "complete", migrationPending: true, errorCode: null });
  // The refresh has recovered; the separate publication owner must finish its queued work.
  await db.doc("cmsPages/contact").update({ publishBuildPending: false });
  await runtime.processReplacement({ firestore: dbTarget, ref: replacementRef(), source, now: clock, log: { warn() {} } });
  const recovered = await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock });
  expect(recovered).toMatchObject({ state: "complete", migrationPending: false, errorCode: null });
  expect((await start()).statusCode).toBe(200);
});


it.each(["failed", "cancelled", "public_unconfirmed", "retry"].flatMap(status => [
  [status, false], [status, true],
]))("keeps rollback available after a %s owner publication (already refreshed: %s)", async (status, refreshed) => {
  const dbTarget = await seedPublicationOwner();
  await replace();
  const media = { url: `https://media.njpbs.org/cms-media/video/${assetId}/${"c".repeat(64)}.mp4`,
    posterUrl: `https://media.njpbs.org/cms-media/video/${assetId}/${"c".repeat(64)}.jpg`, width: 640, height: 360, mimeType: "video/mp4" };
  const oldMedia = { ...media, url: media.url.replace("c".repeat(64), "d".repeat(64)) };
  const published = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id: "contact", version: 1,
    title: "Contact", blocks: [{ id: "video", order: 0, visible: true, type: "video",
      data: { sourceId: source.id, assetId, public: refreshed ? media : oldMedia } }] },
    publishedAt: new Date(clock).toISOString(), publishedBy: actor.uid });
  await db.doc("cmsPages/contact").set({ id: "contact", version: 2, title: "Saved draft", blocks: [], publiclyVisible: true,
    status: "published", published, publishBuildPending: true, publishBuildQueueId: status === "retry" ? "active-retry" : null,
    publishBuildSettlement: { status: status === "retry" ? "failed" : status, sourceVersion: 1, operation: "publish" } });
  if (status === "retry") await db.doc("cmsPublishQueue/active-retry").set({ status: "pending" });
  await db.doc(`cmsPublicVideos/${assetId}`).set({ media });
  await replacementRef().update({ migrationPending: true });
  await runtime.processReplacement({ firestore: dbTarget, ref: replacementRef(), source, now: clock, log: { warn() {} } });
  if (status === "retry") {
    expect(await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock }))
      .toMatchObject({ migrationPending: true, errorCode: null });
    expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: (await assetRef().get()).data().version, confirmed: true })).statusCode).toBe(409);
    await db.doc("cmsPublishQueue/active-retry").update({ status: "failed" });
    await runtime.processReplacement({ firestore: dbTarget, ref: replacementRef(), source, now: clock, log: { warn() {} } });
  }
  const state = await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock });
  expect(state).toMatchObject({ state: "complete", migrationPending: true, errorCode: "publication_refresh_failed" });
  expect((await replacementRef().get()).data().migrationFailedOwners).toEqual(["cmsPages/contact"]);
  expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: state.asset.version, confirmed: true })).statusCode).toBe(200);
});

it.each(["promotions", "migrations", "transcripts"])("rotates %s past a full persistently blocked batch and wraps", async kind => {
  if (kind === "promotions") { await upload(); await processPreview(); }
  else {
    await replace();
    await replacementRef().update(kind === "migrations" ? { migrationPending: true } : { transcriptPending: true });
  }
  const batch = db.batch();
  for (let index = 0; index < 100; index++) {
    const id = `a-blocked-${String(index).padStart(3, "0")}`;
    batch.set(db.doc(`mediaSourceReplacements/${id}`), { assetId: id, sourceId: source.id, sessionId: id,
      state: "ready", leaseUntil: clock + 60_000,
      ...(kind === "migrations" ? { migrationPending: true } : kind === "transcripts" ? { transcriptPending: true } : {}) });
  }
  await batch.commit();
  const pending = record => kind === "promotions" ? record.state === "ready" : record[kind === "migrations" ? "migrationPending" : "transcriptPending"];
  const tick = () => runtime.processReplacements({ firestore: db, source, now: clock, dryRun: true,
    prepareCopy: async () => null, transcriptConfig: () => ({}), requestTranscript: async () => {}, log: { warn() {} } });
  await tick();
  expect(pending((await replacementRef().get()).data())).toBe(true);
  await tick();
  expect(pending((await replacementRef().get()).data())).toBe(false);
  expect((await db.doc("mediaSourceReplacements/a-blocked-000").get()).data().state).toBe("ready");
  clock += 60_001;
  await tick();
  // The cursor wraps and retries earlier IDs once their lease ends. Their missing
  // asset is a terminal refusal, proving work ran rather than inspecting cursors.
  expect((await db.doc("mediaSourceReplacements/a-blocked-000").get()).data().state).toBe("failed");
});

it.each(["promotions", "migrations", "transcripts"])("processes %s past five protected records in one tick", async kind => {
  if (kind === "promotions") { await upload(); await processPreview(); }
  else {
    await replace();
    await replacementRef().update(kind === "migrations" ? { migrationPending: true } : { transcriptPending: true });
  }
  for (let index = 0; index < 5; index++) {
    const blocked = `a-blocked-${index}`;
    const record = { assetId: blocked, sourceId: source.id, sessionId: blocked, state: kind === "promotions" ? "ready" : "canceled",
      actor: { uid: actor.uid, name: "Staff", email: null }, leaseUntil: clock + 60_000 };
    if (kind === "promotions") {
      const asset = fixture({ id: blocked, objectKey: `shared/objects/${blocked}.mp4` });
      await db.doc(`mediaSourceAssets/${blocked}`).set(asset);
      record.base = versions.binary(asset);
      record.candidate = versions.binary(fixture({ id: blocked, objectKey: `shared/objects/${blocked}/candidate.mp4`, objectVersionId: "candidate" }));
    }
    if (kind === "migrations") {
      record.state = "complete"; record.migrationPending = true;
      const media = { url: `https://media.njpbs.org/cms-media/video/${blocked}/${"a".repeat(64)}.mp4`, posterUrl: `https://media.njpbs.org/cms-media/video/${blocked}/${"a".repeat(64)}.jpg`, width: 640, height: 360, mimeType: "video/mp4" };
      await db.doc(`cmsPublicVideos/${blocked}`).set({ media: { ...media, width: 1280 } });
      await db.doc(`cmsPosts/${blocked}`).set({ publiclyVisible: true, status: "published", published: { sourceVersion: 1,
        metadata: { type: "post", slug: blocked }, blocks: [{ id: "video", visible: true, order: 0, type: "video", data: { sourceId: source.id, assetId: blocked, public: media } }] } });
    }
    if (kind === "transcripts") record.transcriptPending = true;
    await db.doc(`mediaSourceReplacements/${blocked}`).set(record);
  }
  const tick = () => runtime.processReplacements({ firestore: db, source, now: clock, dryRun: true,
    prepareCopy: async () => null, transcriptConfig: () => ({ enabled: true, localEnabled: true }), log: { warn() {} } });
  await tick();
  const after = (await replacementRef().get()).data();
  expect(kind === "promotions" ? after.state === "complete" : after[kind === "migrations" ? "migrationPending" : "transcriptPending"] === false).toBe(true);
  for (let index = 0; index < 5; index++) {
    const blocked = (await db.doc(`mediaSourceReplacements/a-blocked-${index}`).get()).data();
    expect(kind === "promotions" ? blocked.state === "ready" : blocked[kind === "migrations" ? "migrationPending" : "transcriptPending"]).toBe(true);
  }
});


describe("replacement publication authorization", () => {
  it.each([false, true])("fences transcript edits through a committed PUT (lost response: %s)", async lostResponse => {
    const request = transcriptContract.parseTranscriptRequest({ sourceId: source.id, assetId });
    const { job } = await transcriptJobs.requestTranscript({ firestore: db, source, request, actor, now: clock });
    const jobRef = db.doc(`${transcriptJobs.TRANSCRIPT_JOBS}/${job.id}`);
    await jobRef.update({ phase: "ready", active: false, totalSegments: 1, editRevision: 0, outputs: { "segments.json": "segments-v1" } });
    const segments = [{ speaker: "spk_0", startSeconds: 0, endSeconds: 1, text: "Hello.",
      words: [{ startSeconds: 0, endSeconds: 1, text: "Hello." }] }];
    const stored = new Map();
    let entered, release, puts = 0;
    const writing = new Promise(resolve => { entered = resolve; });
    const finish = new Promise(resolve => { release = resolve; });
    const client = new S3Client({ region: "us-east-2", maxAttempts: 1,
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" }, requestHandler: { async handle(request) {
        if (request.method === "GET") return { response: { statusCode: 200, headers: {}, body: Readable.from([JSON.stringify(segments)]) } };
        if (request.method === "DELETE") { stored.delete(request.path); return { response: { statusCode: 204, headers: {}, body: Readable.from([]) } }; }
        expect(request.method).toBe("PUT");
        const index = puts++, chunks = []; for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
        if (index === 0) { entered(); await finish; }
        stored.set(request.path, Buffer.concat(chunks));
        if (index === 0 && lostResponse) throw Object.assign(Error("fixture committed PUT response lost"), { code: "ECONNRESET" });
        return { response: { statusCode: 200, headers: { "x-amz-version-id": `edit-${index}` }, body: Readable.from([]) } };
      } } });
    const config = { source, bucket: "fixture-derived", region: "us-east-2", accountId: source.expectedBucketOwner,
      controlRoleArn: "arn:aws:iam::123456789012:role/fixture-control", dataRoleArn: "arn:aws:iam::123456789012:role/fixture-data" };
    const processor = transcriptProcessor.createVideoTranscriptProcessor(config, { firestore: db, s3: client });
    const handler = transcriptHandlers.createTranscriptHandler("edit", { firestore: db, registryFn: () => new Map([[source.id, source]]),
      configFn: () => config, processor, requirePrincipalFn: async () => actor, verifyAppCheckFn: async () => ({}), log: { warn() {} } });
    const body = { sourceId: source.id, assetId, transcriptId: job.id, revision: 0,
      segments: [{ index: 0, text: "Edited.", speaker: "spk_0" }], speakerNames: {} };
    const res = { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    const editing = handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
    try {
      await Promise.race([writing, editing.then(() => { throw Error(`Edit ended before PUT: ${JSON.stringify(res.body)}`); })]);
      await replace(); const previousId = (await replacementRef().get()).data().previousId;
      const next = await start(), queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-${previousId}`);
      let removals = 0; const remove = async () => { removals++; stored.clear(); };
      await queueRef.update({ expiresAt: Date.now(), nextAttemptAt: 0 });
      const claim = await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: Date.now(), remove });
      release(); await editing;
      expect(next.statusCode).toBe(200);
      expect(claim).toMatchObject({ blocked: "writer_or_public_copy" });
      expect(removals).toBe(0); expect((await jobRef.get()).exists).toBe(true);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      if (lostResponse) expect(stored.size).toBe(1);
      await queueRef.update({ expiresAt: Date.now(), nextAttemptAt: 0 });
      await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: Date.now(), remove });
      expect(removals).toBe(1); expect(stored.size).toBe(0);
      expect((await jobRef.get()).exists).toBe(false); expect((await queueRef.get()).exists).toBe(false);
    } finally { release(); await editing; client.destroy(); }
  });
  it.each(["srt", "vtt", "tsv", "avid", "premiere"])("fences retained cleanup until an in-flight %s export finishes writing", async format => {
    const request = transcriptContract.parseTranscriptRequest({ sourceId: source.id, assetId });
    const { job } = await transcriptJobs.requestTranscript({ firestore: db, source, request, actor, now: clock });
    const jobRef = db.doc(`${transcriptJobs.TRANSCRIPT_JOBS}/${job.id}`);
    await jobRef.update({ phase: "ready", active: false, totalSegments: 1, outputs: { "segments.json": "segments-v1" } });
    const segments = [{ speaker: "spk_0", startSeconds: 0, endSeconds: 1, text: "Hello.",
      words: [{ startSeconds: 0, endSeconds: 1, text: "Hello." }] }];
    const exports = new Map();
    const entered = [], release = [];
    const startedWriting = [0, 1].map(i => new Promise(resolve => { entered[i] = resolve; }));
    const mayFinish = [0, 1].map(i => new Promise(resolve => { release[i] = resolve; }));
    let writeCount = 0;
    const client = new S3Client({ region: "us-east-2", maxAttempts: 1,
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
      requestHandler: { async handle(request) {
        if (request.method === "GET") return { response: { statusCode: 200,
          headers: { "x-amz-version-id": "segments-v1" }, body: Readable.from([JSON.stringify(segments)]) } };
        expect(request.method).toBe("PUT");
        const chunks = []; for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
        const writer = writeCount++;
        entered[writer](); await mayFinish[writer];
        exports.set(request.path, Buffer.concat(chunks));
        return { response: { statusCode: 200, headers: { "x-amz-version-id": "export-v1" }, body: Readable.from([]) } };
      } } });
    const config = { source, bucket: "fixture-derived", region: "us-east-2", accountId: source.expectedBucketOwner,
      controlRoleArn: "arn:aws:iam::123456789012:role/fixture-control", dataRoleArn: "arn:aws:iam::123456789012:role/fixture-data" };
    const processor = transcriptProcessor.createVideoTranscriptProcessor(config, { firestore: db, s3: client });
    const handler = transcriptHandlers.createTranscriptHandler("download", { firestore: db,
      registryFn: () => new Map([[source.id, source]]), configFn: () => config, processor,
      requirePrincipalFn: async () => actor, verifyAppCheckFn: async () => ({}), log: { warn() {} } });
    const body = { sourceId: source.id, assetId, transcriptId: job.id, format,
      ...(format === "avid" ? { frameRate: "30/1", frameOffset: 0 } : {}) };
    const response = () => ({ statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });
    const res = response(), secondRes = response();
    const downloadRequest = result => handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, result);
    const download = downloadRequest(res);
    let secondDownload;
    try {
      await Promise.race([startedWriting[0], download.then(() => { throw Error(`Export ended before its write: ${JSON.stringify(res.body)}`); })]);
      secondDownload = downloadRequest(secondRes);
      await Promise.race([startedWriting[1], secondDownload.then(() => { throw Error(`Second export ended before its write: ${JSON.stringify(secondRes.body)}`); })]);
      await replace();
      const previousId = (await replacementRef().get()).data().previousId;
      const nextUpload = await start();
      expect(nextUpload.statusCode).toBe(200);
      expect(JSON.stringify(nextUpload.body)).not.toContain("https://");
      const queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-${previousId}`);
      await queueRef.update({ expiresAt: Date.now(), nextAttemptAt: 0 });
      let removals = 0;
      const remove = async () => { removals++; exports.clear(); };
      const result = await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: Date.now(), remove });
      expect(result).toMatchObject({ blocked: "writer_or_public_copy" });
      expect(removals).toBe(0);
      expect((await jobRef.get()).exists).toBe(true);
      release[0](); await download;
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("https://");
      await queueRef.update({ expiresAt: Date.now(), nextAttemptAt: 0 });
      expect(await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: Date.now(), remove })).toMatchObject({ blocked: "writer_or_public_copy" });
      expect(removals).toBe(0);
      release[1](); await secondDownload;
      expect(secondRes.statusCode).toBe(404);
      expect(JSON.stringify(secondRes.body)).not.toContain("https://");
      expect(exports.size).toBe(1);
      await queueRef.update({ expiresAt: Date.now(), nextAttemptAt: 0 });
      await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: Date.now(), remove });
      expect(removals).toBe(1); expect(exports.size).toBe(0);
      expect((await jobRef.get()).exists).toBe(false);
      expect((await replacementRef().collection("versions").doc(previousId).get()).exists).toBe(false);
    } finally { release.forEach(finish => finish()); await Promise.all([download, secondDownload]); client.destroy(); }
  });
  it("owns cleanup before the first public write and releases only promoted URLs atomically", async () => {
    const providers = publicCopyProviders();
    try {
      await providers.seed((await assetRef().get()).data());
      await upload(); await processPreview();
      const media = providers.urls((await replacementRef().get()).data().candidate, 1);
      const requestRef = db.doc(`cmsPublicVideoWithdrawals/${assetId}`);
      const older = `https://media.njpbs.org/cms-media/video/${assetId}/${"a".repeat(64)}.mp4`;
      await requestRef.set({ revision: "older", urls: [older], nextAttemptAt: Date.now() });
      let checked = false;
      providers.beforeFirstPut(async () => {
        expect((await requestRef.get()).data().urls).toEqual(expect.arrayContaining([older, media.url, media.posterUrl]));
        await requestRef.update({ nextAttemptAt: 0 });
        await providers.recover(Date.now());
        expect((await requestRef.get()).data().urls).toContain(media.url);
        checked = true;
      });
      await promote(providers.prepareCopy);
      expect(checked).toBe(true);
      expect((await requestRef.get()).data().urls).toEqual([older]);
      await providers.recover();
      for (const url of [media.url, media.posterUrl]) expect(providers.publicObjects.has(new URL(url).pathname.slice(1))).toBe(true);
    } finally { providers.close(); }
  });
  it("withdraws a prepared public copy after a retry ends permanently before preparing again", async () => {
    const providers = publicCopyProviders();
    try {
      const original = (await assetRef().get()).data();
      const originalMedia = await providers.seed(original);
      await upload(); await processPreview();
      const candidateMedia = providers.urls((await replacementRef().get()).data().candidate, 1);
      await expect(promote(async input => {
        const copy = await providers.prepareCopy(input);
        await db.doc(`cmsPublicVideos/${assetId}`).update({ "operation.id": "changed-copy-owner", "operation.expiresAt": 0 });
        return copy;
      })).rejects.toThrow(/public video copy changed/);
      expect((await replacementRef().get()).data().state).toBe("ready");
      await assetRef().delete();
      await expect(promote(providers.prepareCopy)).rejects.toMatchObject({ status: 404 });
      expect((await db.doc(`cmsPublicVideoWithdrawals/${assetId}`).get()).data()?.urls).toEqual(expect.arrayContaining([candidateMedia.url, candidateMedia.posterUrl]));
      await providers.recover();
      for (const url of [candidateMedia.url, candidateMedia.posterUrl]) expect(providers.publicObjects.has(new URL(url).pathname.slice(1))).toBe(false);
      for (const url of [originalMedia.url, originalMedia.posterUrl]) expect(providers.publicObjects.has(new URL(url).pathname.slice(1))).toBe(true);
      expect((await db.doc(`cmsPublicVideoWithdrawals/${assetId}`).get()).exists).toBe(false);
    } finally { providers.close(); }
  });
  it("withdraws a refused rollback's newly public copy while retaining its private file and current playback", async () => {
    const providers = publicCopyProviders();
    try {
      const original = (await assetRef().get()).data();
      const { current } = await replace();
      const previousId = (await replacementRef().get()).data().previousId;
      expect((await replacementRef().collection("versions").doc(previousId).get()).data().publicMedia).toBeNull();
      const currentMedia = await providers.seed(current), rollbackMedia = providers.urls(original, 1);
      expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: current.version, confirmed: true })).statusCode).toBe(200);
      await expect(promote(async input => {
        const copy = await providers.prepareCopy(input);
        await db.doc(`users/${actor.uid}`).update({ active: false });
        return copy;
      })).rejects.toMatchObject({ status: 403 });
      expect((await replacementRef().collection("versions").doc(previousId).get()).data()).toMatchObject({ state: "retained", publicMedia: null });
      expect((await assetRef().get()).data().objectVersionId).toBe(current.objectVersionId);
      expect((await db.doc(`cmsPublicVideoWithdrawals/${assetId}`).get()).data()?.urls).toEqual(expect.arrayContaining([rollbackMedia.url, rollbackMedia.posterUrl]));
      await providers.recover();
      for (const url of [rollbackMedia.url, rollbackMedia.posterUrl]) expect(providers.publicObjects.has(new URL(url).pathname.slice(1))).toBe(false);
      for (const url of [currentMedia.url, currentMedia.posterUrl]) expect(providers.publicObjects.has(new URL(url).pathname.slice(1))).toBe(true);
      expect(objects.has(original.objectKey)).toBe(true);
    } finally { providers.close(); }
  });
  const scoped = section => ({ ...actor, principal: { id: actor.uid, grants: [{ role: "editor", sections: [section], registeredMediaSections: [section] }] } });
  async function scheduled(section) {
    await db.doc("cmsPosts/scheduled-use").set({ type: "post", status: "scheduled", section, blocks: [
      { id: "video", type: "video", visible: true, order: 0, data: { sourceId: source.id, assetId } }] });
  }
  it("permits a manager's private replacement but requires publish authority for scheduled uses", async () => {
    const manager = { ...actor, principal: { id: actor.uid, grants: [{ tier: "contributor" }] } };
    const first = await start({}, manager); expect(first.statusCode).toBe(200);
    await call("cancel", { sourceId: source.id, sessionId: first.body.upload.sessionId, version: 1 });
    await scheduled("news");
    expect((await start({}, manager)).statusCode).toBe(403);
    expect(calls.filter(call => call[0] === "start")).toHaveLength(1);
  });
  it("requires the actor's publish scope to cover every use", async () => {
    await scheduled("news");
    expect((await start({}, scoped("arts"))).statusCode).toBe(403);
    expect((await start({}, scoped("news"))).statusCode).toBe(200);
  });
  it.each(["scope", "inactive"])("ends a permanently refused promotion (%s), purges its candidate and admits an authorized retry", async reason => {
    const before = (await assetRef().get()).data();
    await upload(); await processPreview();
    const candidate = (await replacementRef().get()).data().candidate;
    if (reason === "scope") {
      await db.doc(`users/${actor.uid}`).set({ active: true, grants: [{ role: "editor", sections: ["arts"] }] });
      await db.doc("sections/arts").set({ name: "Arts" }); await scheduled("news");
    } else await db.doc(`users/${actor.uid}`).set({ active: false, role: "admin" });
    await expect(promote()).rejects.toMatchObject({ status: 403 });
    expect((await assetRef().get()).data().objectVersionId).toBe(before.objectVersionId);
    expect((await replacementRef().get()).data()).toMatchObject({ state: "failed", errorCode: "replacement_permission_changed" });
    expect((await replacementRef().get()).data()).not.toHaveProperty("candidate");
    await purge();
    expect(objects.has(candidate.objectKey)).toBe(false); expect(objects.has(before.objectKey)).toBe(true);
    await db.doc(`users/${actor.uid}`).set({ active: true, role: "admin" });
    expect((await start()).statusCode).toBe(200);
  });
  it("releases a refused rollback's previous version for retry and eventual expiry", async () => {
    const { current } = await replace();
    const previousId = (await replacementRef().get()).data().previousId;
    expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: current.version, confirmed: true })).statusCode).toBe(200);
    await db.doc(`users/${actor.uid}`).update({ active: false });
    await expect(promote()).rejects.toMatchObject({ status: 403 });
    expect((await replacementRef().get()).data()).toMatchObject({ state: "failed", previousId });
    expect((await replacementRef().get()).data()).not.toHaveProperty("rollbackPreviousId");
    expect((await replacementRef().collection("versions").doc(previousId).get()).data().state).toBe("retained");
    expect((await assetRef().get()).data().objectVersionId).toBe(current.objectVersionId);
    await db.doc(`users/${actor.uid}`).update({ active: true });
    expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: current.version, confirmed: true })).statusCode).toBe(200);
    expect((await promote()).objectVersionId).toBe("original-v1");
  });
  it("cleans up a ready candidate when its asset disappears", async () => {
    await upload(); await processPreview();
    const candidate = (await replacementRef().get()).data().candidate;
    await assetRef().delete();
    await expect(promote()).rejects.toMatchObject({ status: 404 });
    expect((await replacementRef().get()).data()).toMatchObject({ state: "failed", errorCode: "replacement_video_changed" });
    await purge(); expect(objects.has(candidate.objectKey)).toBe(false);
  });
});

describe("first-publication serialization", () => {
  it("cannot promote across a first public copy operation without a media record", async () => {
    const before = (await assetRef().get()).data();
    await upload(); await processPreview();
    const first = await publicVideo.acquirePublicVideoCopy({ firestore: db, assetId });
    expect((await db.doc(`cmsPublicVideos/${assetId}`).get()).data()).not.toHaveProperty("media");
    await expect(promote()).rejects.toThrow(/public video copy changed/);
    await expect(promote(runtime.preparePublicCopy)).rejects.toThrow(/public copy is changing/);
    expect((await assetRef().get()).data().objectVersionId).toBe(before.objectVersionId);
    await first.release();
    await promote(runtime.preparePublicCopy);
    expect((await assetRef().get()).data().objectVersionId).not.toBe(before.objectVersionId);
    expect((await db.doc(`cmsPublicVideos/${assetId}`).get()).exists).toBe(false);
    // A publisher that loaded v1 before promotion cannot acquire a slot later
    // and create an untracked public copy of the retired binary.
    await expect(publicVideo.acquirePublicVideoCopy({ firestore: db, assetId, asset: before })).rejects.toThrow(/video changed/);
    expect((await db.doc(`cmsPublicVideos/${assetId}`).get()).exists).toBe(false);
  });
});

describe("completed exports retain their independent seven-day lifecycle", () => {
  async function savedExport(scope = "clip", overrides = {}) {
    const request = clipContract.parseClipRequest({ sourceId: source.id, assetId,
      ...(scope === "source" ? { scope, format: "prores_mov", frameRateMode: "source" } : { inMs: 0, outMs: 1000 }) }, "request");
    const summary = await clips.requestClip({ firestore: db, source, actor, now: clock, request });
    const ref = db.doc(`${clipContract.CLIP_JOBS}/${summary.id}`);
    const job = (await ref.get()).data();
    const editor = scope === "source";
    const output = { objectKey: `outputs/clips/${job.id}/${job.attemptId}/${editor ? "prores.mov" : "preview.mp4"}`,
      objectVersionId: "saved-export", sizeBytes: video.length, mimeType: editor ? "video/quicktime" : "video/mp4",
      durationSeconds: editor ? 2 : 1, ...(editor ? { container: "quicktime", videoCodec: "prores", profile: "prores_422_hq",
        width: 1920, height: 1080, scanType: "progressive", frameRateNumerator: 30, frameRateDenominator: 1,
        sourceFrameRateNumerator: 30, sourceFrameRateDenominator: 1, conversionMethod: "none", timecodeMode: "embedded_or_zero_based",
        audioChannels: 2, audioTracks: 2, audioCodec: "pcm", audioSampleRate: 48000, audioBitDepth: 24,
        sourceStartSeconds: 0, sourceEndSeconds: 2, sourceFrameDurationSeconds: 1 / 30 } : {}) };
    await ref.update({ phase: "ready", active: false, output: clipContract.validateClipOutput(job, {
      id: job.id, attemptId: job.attemptId, [editor ? "prores" : "web"]: output }), ...overrides });
    return (await ref.get()).data();
  }
  it.each(["clip", "source"])("keeps a completed %s export and its history across replacement", async scope => {
    const saved = await savedExport(scope);
    expect((await clips.recentClips(db, source, { sourceId: source.id, assetId, scope }, actor, clock)).clips[0])
      .toMatchObject({ id: saved.id, matchesCurrentFile: true });
    await replace();
    const request = { sourceId: source.id, assetId, clipId: saved.id };
    expect((await clips.getClip(db, source, request, clock)).job.id).toBe(saved.id);
    const history = await clips.recentClips(db, source, { sourceId: source.id, assetId, scope }, actor, clock);
    expect(history.clips.map(job => job.id)).toEqual([saved.id]);
    expect(history.clips[0].matchesCurrentFile).toBe(false);
    expect((await clips.recentClips(db, source, { sourceId: source.id, assetId, scope }, { uid: "other" }, clock)).clips).toEqual([]);
    await expect(clips.getClip(db, { ...source, prefix: "other/" }, request, clock)).rejects.toMatchObject({ status: 404 });
    const expired = Date.parse(saved.expiresAt) + 1;
    await expect(clips.getClip(db, source, request, expired)).rejects.toMatchObject({ status: 404 });
    expect((await clips.recentClips(db, source, { sourceId: source.id, assetId, scope }, actor, expired)).clips).toEqual([]);
  });
  it("advances a bounded history cursor past expired old-version jobs", async () => {
    const saved = await savedExport();
    for (let index = 1; index <= 50; index++) {
      const job = { ...saved, inMs: index * 10, outMs: index * 10 + 500,
        requestedAt: new Date(clock + index * 1000).toISOString(), expiresAt: new Date(clock - 1).toISOString() };
      job.id = clipContract.clipIdentity(job);
      await db.doc(`${clipContract.CLIP_JOBS}/${job.id}`).set(job);
    }
    await replace();
    const request = { sourceId: source.id, assetId, scope: "clip" };
    const first = await clips.recentClips(db, source, request, actor, clock);
    expect(first.clips).toEqual([]); expect(first.nextCursor).toBeTruthy();
    const next = clipContract.parseClipRequest({ ...request, cursor: first.nextCursor }, "get");
    const second = await clips.recentClips(db, source, next, actor, clock);
    expect(second.clips.map(job => job.id)).toEqual([saved.id]); expect(second.nextCursor).toBeNull();
  });
  it.each(["clip", "source"])("downloads the exact completed %s export after replacement through the actual S3 SDK", async scope => {
    const saved = await savedExport(scope); await replace();
    const job = (await clips.getClip(db, source, { assetId, clipId: saved.id }, clock)).job;
    const client = new S3Client({ region: "us-east-2", credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
      requestHandler: { async handle(request) {
        expect(request.method).toBe("HEAD"); expect(request.query.versionId).toBe("saved-export");
        return { response: { statusCode: 200, headers: { "x-amz-version-id": "saved-export", "content-length": String(video.length) }, body: Readable.from([]) } };
      } } });
    try {
      const access = await clips.clipRead({ region: "us-east-2", renditionBucket: "fixture-derived" }, source, job, clock, { client });
      expect(new URL(access.url).searchParams.get("versionId")).toBe("saved-export");
    } finally { client.destroy(); }
  });
  it("does not expose an unfinished, forged or different-asset export after replacement", async () => {
    const saved = await savedExport("clip", { phase: "running", active: true }); await replace();
    const request = { assetId, clipId: saved.id }, ref = db.doc(`${clipContract.CLIP_JOBS}/${saved.id}`);
    await expect(clips.getClip(db, source, request, clock)).rejects.toMatchObject({ status: 404 });
    await ref.update({ phase: "ready", active: false, sourceObjectKey: "shared/forged.mp4" });
    await expect(clips.getClip(db, source, request, clock)).rejects.toMatchObject({ status: 404 });
    await ref.set({ ...saved, phase: "ready", assetId: "other-asset" });
    await expect(clips.getClip(db, source, request, clock)).rejects.toMatchObject({ status: 404 });
  });
});


it("promotes after scheduled expiry cleanup has already removed the prior rollback row", async () => {
  await replace();
  const retiredId = (await replacementRef().get()).data().previousId;
  clock += versions.RETENTION_MS;
  await purge();
  expect((await replacementRef().collection("versions").doc(retiredId).get()).exists).toBe(false);
  await upload(); await processPreview(); await promote();
  expect((await replacementRef().get()).data().state).toBe("complete");
  expect((await replacementRef().collection("versions").get()).size).toBe(1);
  expect((await db.collection(versions.PURGE_QUEUE).get()).size).toBe(1);
});

it.each(["stale", "cancelled"].flatMap(phase => ["startIntentAt", "submissionIntentAt"].map(intent => [phase, intent])))(
  "keeps a %s transcript's %s fenced until the provider is confirmed terminal", async (phase, intent) => {
    const request = transcriptContract.parseTranscriptRequest({ sourceId: source.id, assetId });
    const { job } = await transcriptJobs.requestTranscript({ firestore: db, source, request, actor, now: clock });
    const jobRef = db.doc(`${transcriptJobs.TRANSCRIPT_JOBS}/${job.id}`);
    await jobRef.update({ phase: "running", [intent]: new Date(clock).toISOString() });
    const original = (await assetRef().get()).data();
    await replace();
    expect(await transcriptJobs.claimTranscript(db, jobRef, source, clock)).toBeNull();
    expect((await jobRef.get()).data()).toMatchObject({ phase: "stale", active: false, leaseUntil: 0 });
    if (phase === "cancelled") await jobRef.update({ phase });
    clock += versions.RETENTION_MS;
    const previousId = (await replacementRef().get()).data().previousId;
    const queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-${previousId}`);
    let removals = 0;
    const remove = async version => { removals++; objects.delete(version.binary.objectKey); };
    expect(await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: clock, remove }))
      .toMatchObject({ blocked: "writer_reconciliation_required" });
    expect(removals).toBe(0);
    expect(objects.has(original.objectKey)).toBe(true);
    expect((await jobRef.get()).exists).toBe(true);
    await jobRef.update({ audioProviderTerminal: true });
    await queueRef.update({ expiresAt: clock, nextAttemptAt: 0 });
    await cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: clock, remove });
    expect(removals).toBe(1);
    expect(objects.has(original.objectKey)).toBe(false);
    expect((await jobRef.get()).exists).toBe(false);
  });

describe("local transcript failure at retained version cleanup", () => {
  // The job and receipt come from the real worker writer. Only the fail-safe
  // cases below edit them.
  async function failedLocalTranscript() {
    const original = (await assetRef().get()).data();
    const request = transcriptContract.parseTranscriptRequest({ sourceId: source.id, assetId });
    const { job } = await transcriptJobs.requestTranscript({ firestore: db, source, request, actor, now: clock, localEnabled: true });
    const claimed = await transcriptWorker.claimLocalJob({ firestore: db, source, now: clock });
    await transcriptWorker.failLocalJob({ firestore: db, source, now: clock, fallbackEnabled: false,
      request: { jobId: job.id, leaseToken: claimed.localLeaseToken, errorCode: "local_processing_failed" } });
    const jobRef = db.doc(`${transcriptJobs.TRANSCRIPT_JOBS}/${job.id}`);
    await replace();
    clock += versions.RETENTION_MS;
    const previousId = (await replacementRef().get()).data().previousId;
    const queueRef = db.doc(`${versions.PURGE_QUEUE}/${assetId}-${previousId}`);
    let removals = 0;
    const run = async () => cleanup.cleanupVideoVersion({ firestore: db, queueRef, now: clock,
      remove: async version => { removals++; objects.delete(version.binary.objectKey); } });
    return { original, jobRef, run, removals: () => removals };
  }
  const expectRetained = async ({ original, jobRef, removals }) => {
    expect(removals()).toBe(0);
    expect(objects.has(original.objectKey)).toBe(true);
    expect((await jobRef.get()).exists).toBe(true);
  };

  it("deletes the retained version once the local writer recorded its failure", async () => {
    const failed = await failedLocalTranscript();
    expect((await failed.jobRef.get()).data()).toMatchObject({ phase: "needs_reconciliation", active: false,
      provider: "local", cleanupWriterSettlement: { status: "FAILED" } });
    expect(await failed.run()).toMatchObject({ deleted: true });
    expect(failed.removals()).toBe(1);
    expect(objects.has(failed.original.objectKey)).toBe(false);
    expect((await failed.jobRef.get()).exists).toBe(false);
  });

  it.each([
    ["an absent receipt", (_receipt, { cleanupWriterSettlement: _removed, ...job }) => job],
    ["a mismatched attempt", receipt => ({ cleanupWriterSettlement: { ...receipt, attemptId: "f".repeat(64) } })],
    ["a newer stored attempt", () => ({ localAttemptId: "f".repeat(64) })],
    ["a missing attempt on both sides", ({ attemptId: _removed, ...receipt }, { localAttemptId: _attempt, ...job }) =>
      ({ ...job, cleanupWriterSettlement: receipt })],
    ["a mismatched worker", receipt => ({ cleanupWriterSettlement: { ...receipt, workerId: "other" } })],
    ["a mismatched job", receipt => ({ cleanupWriterSettlement: { ...receipt, jobId: "f".repeat(64) } })],
    ["another provider", receipt => ({ cleanupWriterSettlement: { ...receipt, provider: "amazon-transcribe" } })],
    ["a non-FAILED status", receipt => ({ cleanupWriterSettlement: { ...receipt, status: "SUCCEEDED" } })],
    ["a partial receipt", ({ at: _removed, ...receipt }) => ({ cleanupWriterSettlement: receipt })],
  ])("keeps the writer fence for %s", async (_name, change) => {
    const failed = await failedLocalTranscript();
    const job = (await failed.jobRef.get()).data();
    const changed = change(job.cleanupWriterSettlement, job);
    await failed.jobRef.set("phase" in changed ? changed : { ...job, ...changed });
    expect(await failed.run()).toMatchObject({ blocked: "writer_reconciliation_required" });
    await expectRetained(failed);
  });

  it("does not extend a transcript receipt to an uncertain alignment writer", async () => {
    const failed = await failedLocalTranscript();
    await db.doc(`mediaSourceTranscriptAlignmentJobs/${"c".repeat(64)}`).set({ id: "c".repeat(64), transcriptId: failed.jobRef.id,
      phase: "needs_reconciliation", errorCode: "alignment_worker_lost", active: false, leaseUntil: 0 });
    expect(await failed.run()).toMatchObject({ blocked: "writer_reconciliation_required" });
    await expectRetained(failed);
  });

  it("still waits for an open audio read on a settled job", async () => {
    const failed = await failedLocalTranscript();
    await failed.jobRef.update({ audioReadLeaseUntil: clock + 1 });
    expect(await failed.run()).toMatchObject({ blocked: "writer_or_public_copy" });
    await expectRetained(failed);
  });
});

it("keeps cleanup-owned audio preparations valid and refuses new preparation work during a delete retry", async () => {
  const audio = (await import("../../functions/lib/video-transcript-audio-input.js")).default;
  const request = transcriptContract.parseTranscriptRequest({ sourceId: source.id, assetId });
  const { job } = await transcriptJobs.requestTranscript({ firestore: db, source, request, actor, now: clock });
  const args = { firestore: db, job, renditionBucket: "fixture-derived", ffmpegArtifactSha256: "a".repeat(64), now: clock };
  const claim = await audio.claimPreparation(args);
  const stream = { codec: "aac", profile: "LC", sampleRate: 48000, channels: 2, startSamples: 0,
    durationSamples: 96000, frameSamples: 1024, packetCount: 94, elementarySha256: "d".repeat(64) };
  const receipt = { schemaVersion: 1, preparationId: claim.id, invocationId: claim.invocationId,
    revision: audio.PREPARATION_REVISION, ffmpegArtifactSha256: args.ffmpegArtifactSha256, outcome: "ready",
    input: { objectKey: job.input.objectKey, objectVersionId: job.input.objectVersionId, sizeBytes: job.input.sizeBytes },
    output: { objectKey: claim.keys.audioKey, objectVersionId: "audio-v1", sizeBytes: 120,
      sha256: "c".repeat(64), mimeType: "audio/x-m4a" }, sourceAudio: stream, outputAudio: stream };
  await audio.acceptPreparation({ firestore: db, id: claim.id, invocationId: claim.invocationId,
    receipt, verifiedOutput: receipt.output, now: clock });
  await db.doc(`mediaSourceTranscriptJobs/${job.id}`).update({ phase: "ready", active: false, audioProviderTerminal: true });
  const preparationRef = db.doc(`${audio.COLLECTION}/${claim.id}`);
  const useRef = db.doc(`mediaTranscriptAudioUses/${claim.id}-${claim.invocationId}`);
  await useRef.set({ state: "active", receipt, owners: [{ collection: transcriptJobs.TRANSCRIPT_JOBS, id: job.id }] });
  await replace(); clock += versions.RETENTION_MS;
  await expect(purge(clock, false, async () => { throw Error("provider unavailable"); })).rejects.toThrow("provider unavailable");
  expect((await preparationRef.get()).data().state).toBe("deleting");
  expect((await useRef.get()).data().state).toBe("deleting");
  await expect(audio.claimPreparation({ ...args, now: clock })).resolves.toMatchObject({ outcome: "backoff", id: claim.id });
  // This is the exact audio-sweep collaborator that formerly rejected the state.
  await expect(audio.invalidatePreparation({ firestore: db, id: claim.id, receipt,
    reason: "output_missing", now: clock })).resolves.toBe(false);
  expect((await preparationRef.get()).data()).toMatchObject({ state: "deleting", receipt });
  clock += 16 * 60_000;
  await purge();
  expect((await preparationRef.get()).exists).toBe(false);
  expect((await useRef.get()).exists).toBe(false);
});

it("admits rollback after an abandoned upload expires while a live upload remains excluded", async () => {
  await replace();
  const pending = await start();
  expect(pending.statusCode).toBe(200);
  const current = (await assetRef().get()).data();
  expect((await call("rollback", { sourceId: source.id, assetId, expectedVersion: current.version, confirmed: true })).statusCode).toBe(409);
  clock = Date.parse(pending.body.upload.expiresAt);
  const restored = await call("rollback", { sourceId: source.id, assetId, expectedVersion: current.version, confirmed: true });
  expect(restored.statusCode).toBe(200);
  expect((await assetRef().get()).data().objectVersionId).toBe(current.objectVersionId);
  await promote();
  expect((await assetRef().get()).data().objectVersionId).toBe("original-v1");
});

it("preserves the last successful promotion history after a follow-up upload is cancelled", async () => {
  await replace();
  const pending = await start();
  expect(pending.statusCode).toBe(200);
  const { sessionId, version } = pending.body.upload;
  expect((await call("cancel", { sourceId: source.id, sessionId, version })).statusCode).toBe(200);
  const status = await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock });
  expect(status).toMatchObject({ lastAction: "replace", previousDeleted: false, previous: { originalName: "original.mp4" } });
  // A later cleanup layer owns physical deletion; the read contract must still
  // distinguish its confirmed missing row after a cancelled follow-up attempt.
  const { previousId } = (await replacementRef().get()).data();
  await replacementRef().collection("versions").doc(previousId).delete();
  await replacementRef().update({ previousId: null });
  expect(await runtime.getReplacement({ firestore: db, request: { sourceId: source.id, assetId }, now: clock }))
    .toMatchObject({ lastAction: "replace", previousDeleted: true, previousCleanupPending: false });
});
