import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import { googleAuthLibrary } from "google-gax";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import contract from "../../functions/lib/video-transcript-contract.js";
import jobs from "../../functions/lib/video-transcript-job.js";
import renditions from "../../functions/lib/source-media-rendition.js";
import processorModule from "../../functions/lib/video-transcript-processor.js";
import handlers from "../../functions/video-transcripts.js";

const project = "demo-njpbs-transcript-storage";
const app = initializeApp({ projectId: project }, "transcript-storage-tests");
const db = getFirestore(app);
const source = { id: "video-library", bucket: "originals", prefix: "", writable: true, access: "active_staff" };
const config = { source, bucket: "renditions", accountId: "123456789012", region: "us-east-2",
  controlRoleArn: "role", dataRoleArn: "data-role" };
const actor = { uid: "staff", email: "staff@example.test", principal: { grants: [{ role: "staff" }] } };
const segment = { text: "Original", speaker: "spk_0", startSeconds: 1, endSeconds: 2,
  words: [{ text: "Original", startSeconds: 1, endSeconds: 2 }] };
let job;
let ref;
let clients = [];

// Intercept only the SDK's HTTP transport. Keep serialization, version IDs and
// version-specific reads/deletes real at the S3 boundary.
function storage({ failPut = 0, afterPut = async () => {}, firestore = db } = {}) {
  const versions = new Map();
  const tags = new Map();
  let puts = 0;
  let next = 0;
  const seed = (key, version, body) => versions.set(`${key}\0${version}`, String(body));
  for (const [format, version] of Object.entries(job.outputs)) {
    seed(processorModule.resultKey(job, format), version,
      format === "segments.json" ? JSON.stringify([segment]) : "Original export");
  }
  const client = new S3Client({ region: config.region, maxAttempts: 1,
    credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    requestHandler: { handle: async (request) => {
      const key = decodeURIComponent(request.path.slice(1));
      const version = request.query.versionId;
      let statusCode = 200;
      let body = "";
      const headers = {};
      if (request.method === "PUT" && request.query.tagging !== undefined) {
        if (!version || !versions.has(`${key}\0${version}`)) throw new Error("A stored version is required for tagging");
        tags.set(`${key}\0${version}`, String(request.body));
      } else if (request.method === "PUT") {
        puts++;
        if (puts === failPut) {
          statusCode = 503;
          body = "<Error><Code>ServiceUnavailable</Code><Message>Unavailable</Message></Error>";
        } else {
          headers["x-amz-version-id"] = `edit-${++next}`;
          seed(key, headers["x-amz-version-id"], request.body);
          await afterPut({ key, version: headers["x-amz-version-id"], puts });
        }
      } else if (request.method === "GET") {
        body = versions.get(`${key}\0${version}`);
        if (body === undefined) {
          statusCode = 404;
          body = "<Error><Code>NoSuchVersion</Code></Error>";
        }
      } else if (request.method === "DELETE") {
        if (!version) throw new Error("An exact version is required for deletion");
        versions.delete(`${key}\0${version}`);
        statusCode = 204;
      } else throw new Error(`Unexpected storage method ${request.method}`);
      return { response: { statusCode, headers, body: Readable.from([body ?? ""]) } };
    } },
  });
  clients.push(client);
  const log = [];
  const processor = processorModule.createVideoTranscriptProcessor(config, {
    firestore, s3: client, credentials: async () => ({}), log: { warn: (message) => log.push(message) },
  });
  return { versions, tags, processor, log, firestore, get puts() { return puts; } };
}

async function call(store, patch, revision = 0) {
  const handler = handlers.createTranscriptHandler("edit", {
    firestore: store.firestore, registryFn: () => new Map([[source.id, source]]), configFn: () => config,
    processor: store.processor, requirePrincipalFn: async () => actor,
    verifyAppCheckFn: async () => {}, log: { warn: (message) => store.log.push(message) },
  });
  const body = { sourceId: source.id, assetId: "asset", revision, ...patch };
  const res = { statusCode: 0, set() {}, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } };
  await handler({ method: "POST", headers: { "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify(body)), body }, res);
  return res;
}

async function rejectLeaseRelease(run) {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!/^127\.0\.0\.1:\d+$/.test(host ?? "")) throw new Error("A loopback Firestore emulator is required");
  let refused = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const data = body.length ? JSON.parse(body.toString()) : {};
    if (new URL(request.url, "http://localhost").pathname.endsWith(":commit") && data.writes?.some(write =>
      write.updateMask?.fieldPaths?.includes("exportWriteLeases") && !write.update?.fields?.exportWriteLeases)) {
      refused++;
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({
        error: { code: 403, status: "PERMISSION_DENIED", message: "Synthetic lease release refusal" },
      }));
      return;
    }
    const upstream = await fetch(`http://${host}${request.url}`, {
      method: request.method, headers: { "content-type": "application/json", authorization: "Bearer owner" },
      ...(body.length ? { body } : {}),
    });
    response.writeHead(upstream.status, { "content-type": "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let firestore;
  try {
    try {
      process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${server.address().port}`;
      firestore = new Firestore({ projectId: project, preferRest: true, authClient: new googleAuthLibrary.PassThroughClient() });
    } finally { process.env.FIRESTORE_EMULATOR_HOST = host; }
    await run(firestore);
    expect(refused).toBe(1);
  } finally {
    await firestore?.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

beforeEach(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("A local Firestore emulator is required");
  const cleared = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  expect(cleared.ok).toBe(true);
  clients.forEach((client) => client.destroy());
  clients = [];
  const asset = { id: "asset", sourceId: source.id, lifecycle: "active", kind: "video", name: "Video",
    originalName: "video.mxf", nameSort: "video", updatedAtSort: "2026-10-08T12:00:00Z",
    mimeType: "application/mxf", version: 1, preview: "download_only", rightsStatus: "complete", tags: [],
    objectKey: "objects/asset.mxf", objectVersionId: "original-v1", sizeBytes: 100 };
  const prefix = `outputs/${renditions.sourceMediaRenditionId(asset)}/attempt/`;
  asset.rendition = { schemaVersion: 1, state: "ready", sourceObjectKey: asset.objectKey,
    sourceObjectVersionId: asset.objectVersionId, sourceSizeBytes: asset.sizeBytes,
    attemptId: "attempt", updatedAt: "2026-10-08T12:00:00Z",
    web: { objectKey: `${prefix}preview.mp4`, objectVersionId: "web-v1", sizeBytes: 50,
      mimeType: "video/mp4", durationSeconds: 60 },
    poster: { objectKey: `${prefix}preview.jpg`, objectVersionId: "poster-v1", sizeBytes: 5, mimeType: "image/jpeg" } };
  const settings = { languageCode: "en-US", maxSpeakers: 10 };
  job = { id: contract.transcriptId(asset, source.bucket, settings), assetId: asset.id, sourceId: source.id,
    sourceBucket: source.bucket, sourceObjectKey: asset.objectKey, sourceObjectVersionId: asset.objectVersionId,
    sourceSizeBytes: asset.sizeBytes, ...settings, phase: "ready", active: false, editRevision: 0,
    totalSegments: 1, input: asset.rendition.web, durationSeconds: 60,
    speakerNames: { spk_0: "Reporter" }, speakerRoles: { spk_0: "Host" },
    outputs: { "segments.json": "original-segments", txt: "original-txt", vtt: "original-vtt" } };
  ref = db.collection(jobs.TRANSCRIPT_JOBS).doc(job.id);
  await Promise.all([ref.set(job), db.collection("mediaSourceAssets").doc(asset.id).set(asset),
    db.collection("users").doc(actor.uid).set({ active: true, grants: [{ role: "staff" }] })]);
});

afterAll(async () => {
  clients.forEach((client) => client.destroy());
  await db.terminate();
  await deleteApp(app);
});

describe("transcript save storage boundary", () => {
  it.each([false, true])("preserves the operation result when lease release fails (source changed: %s)", async sourceChanged => {
    await rejectLeaseRelease(async firestore => {
      const before = Date.now();
      const store = storage({ firestore, afterPut: async ({ puts }) => {
        if (sourceChanged && puts === 3) await db.collection("mediaSourceAssets").doc("asset").update({ lifecycle: "deleted" });
      } });
      const result = await call(store, { segments: [{ index: 0, text: "Corrected" }] });
      expect(result.statusCode).toBe(sourceChanged ? 404 : 200);
      expect(store.log).toEqual(["Transcript write lease release failed"]);
      const saved = (await ref.get()).data();
      const leases = Object.entries(saved.exportWriteLeases);
      expect(leases).toHaveLength(1);
      expect(leases[0][0]).toMatch(/^[a-f0-9-]{36}$/);
      expect(leases[0][1]).toBeGreaterThanOrEqual(before + 15 * 60 * 1000);
      expect(leases[0][1]).toBeLessThanOrEqual(Date.now() + 15 * 60 * 1000);
      expect(saved.editRevision).toBe(sourceChanged ? 0 : 1);
      expect(store.versions.size).toBe(sourceChanged ? 3 : 6);
      expect((await db.collection("admin_logs").get()).size).toBe(sourceChanged ? 0 : 1);
      if (sourceChanged) expect(result.body).toEqual({ error: "Video not found" });
      else expect(result.body.transcript.segments[0].text).toBe("Corrected");
    });
  });

  it.each([
    { segments: [{ index: 0, text: "Original" }] },
    { segments: [{ index: 0, speaker: "spk_0" }] },
    { speakerNames: { spk_0: " Reporter " } },
    { speakerRoles: { spk_0: " Host " } },
    { speakerNames: { spk_1: " " }, speakerRoles: { spk_1: "" } },
  ])("rejects a normalized no-op without new versions or a revision: %j", async (patch) => {
    const store = storage();
    const result = await call(store, patch);
    expect(result.statusCode).toBe(400);
    expect(store.puts).toBe(0);
    expect(store.versions.size).toBe(3);
    expect((await ref.get()).data()).toEqual(job);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it.each([2, 3])("removes exact provisional versions after export write %s fails", async (failPut) => {
    const store = storage({ failPut });
    const result = await call(store, { segments: [{ index: 0, text: "Corrected" }] });
    expect(result.statusCode).toBe(500);
    expect(store.versions.size).toBe(3);
    expect((await ref.get()).data()).toEqual(job);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("removes exports when the source changes before the commit", async () => {
    const store = storage({ afterPut: async ({ puts }) => {
      if (puts === 3) await db.collection("mediaSourceAssets").doc("asset").update({ lifecycle: "deleted" });
    } });
    const result = await call(store, { segments: [{ index: 0, text: "Corrected" }] });
    expect(result.statusCode).toBe(404);
    expect(store.versions.size).toBe(3);
    expect((await ref.get()).data()).toEqual(job);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });

  it("keeps the winning concurrent save's versions and deletes only the losing save", async () => {
    let release;
    const bothWritten = new Promise((resolve) => { release = resolve; });
    let completed = 0;
    const store = storage({ afterPut: async ({ key }) => {
      if (!key.endsWith(".vtt")) return;
      if (++completed === 2) release();
      await bothWritten;
    } });
    const results = await Promise.all([
      call(store, { segments: [{ index: 0, text: "First correction" }] }),
      call(store, { segments: [{ index: 0, text: "Second correction" }] }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const current = (await ref.get()).data();
    expect(current.editRevision).toBe(1);
    expect(store.versions.size).toBe(6);
    for (const [format, version] of Object.entries(current.editedOutputs)) {
      expect(store.versions.has(`${processorModule.editedResultKey(job, format)}\0${version}`)).toBe(true);
    }
    const winner = results.find((result) => result.statusCode === 200);
    expect(await store.processor.read(current)).toEqual(winner.body.transcript.segments.map(({ index, ...value }) => value));
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    const before = [...store.versions];
    expect((await call(store, { segments: [{ index: 0, text: "Stale" }] })).statusCode).toBe(409);
    expect([...store.versions]).toEqual(before);
  });

  it("saves a real correction and then rejects repeating it at the new revision", async () => {
    const store = storage();
    const patch = { segments: [{ index: 0, text: "Corrected" }], speakerNames: { spk_0: "New name" },
      speakerRoles: { spk_0: "New role" } };
    expect((await call(store, patch)).statusCode).toBe(200);
    const current = (await ref.get()).data();
    expect(current).toMatchObject({ editRevision: 1, speakerNames: { spk_0: "New name" },
      speakerRoles: { spk_0: "New role" }, outputs: job.outputs });
    expect(await store.processor.read(current)).toEqual([{ text: "Corrected", speaker: "spk_0", startSeconds: 1, endSeconds: 2 }]);
    const before = [...store.versions];
    expect((await call(store, patch, 1)).statusCode).toBe(400);
    expect([...store.versions]).toEqual(before);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });

  it("marks only replaced committed versions for lifecycle expiry", async () => {
    const store = storage();
    expect((await call(store, { segments: [{ index: 0, text: "First correction" }] })).statusCode).toBe(200);
    const previous = (await ref.get()).data();
    expect((await call(store, { segments: [{ index: 0, text: "Second correction" }] }, 1)).statusCode).toBe(200);
    const current = (await ref.get()).data();
    expect(current.editRevision).toBe(2);
    expect(store.tags.size).toBe(3);
    for (const [format, version] of Object.entries(previous.editedOutputs)) {
      expect(store.tags.get(`${processorModule.editedResultKey(job, format)}\0${version}`)).toContain("<Value>superseded</Value>");
      expect(store.tags.has(`${processorModule.editedResultKey(job, format)}\0${current.editedOutputs[format]}`)).toBe(false);
    }
    for (const [format, version] of Object.entries(job.outputs)) {
      expect(store.tags.has(`${processorModule.resultKey(job, format)}\0${version}`)).toBe(false);
    }
    expect(await store.processor.read(current)).toEqual([{ text: "Second correction", speaker: "spk_0", startSeconds: 1, endSeconds: 2 }]);
  });
});
