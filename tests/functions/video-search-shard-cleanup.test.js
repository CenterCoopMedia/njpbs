import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import cleanup from "../../functions/lib/video-search-shard-cleanup.js";
import shards from "../../functions/lib/video-search-shards.js";
import outbox from "../../functions/lib/video-search-outbox.js";
import { cleanupConfig, parseArguments, cleanupDiagnostic } from "../../scripts/cleanup-video-search-shard.mjs";

const environment = { CMS_MEDIA_AWS_RENDITION_BUCKET: "fixture-derived", CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID: "123456789012" };
const config = cleanupConfig(environment);
const db = isolatedFirestore("video-search-shard-cleanup.test.js");
const descriptor = { digest: "a".repeat(64), objectVersion: "old-version+with/slash" };
let server, s3, remove, requests, failDelete, loseResponse, deleteMarker;
beforeAll(async () => {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    requests.push({ method: request.method, path: url.pathname, version: url.searchParams.get("versionId"), owner: request.headers["x-amz-expected-bucket-owner"] });
    if (loseResponse) { request.socket.destroy(); return; }
    response.statusCode = failDelete ? 503 : 204;
    if (deleteMarker) response.setHeader("x-amz-delete-marker", "true");
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  s3 = new S3Client({ region: "us-east-2", endpoint: `http://127.0.0.1:${server.address().port}`, forcePathStyle: true,
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" }, maxAttempts: 1 });
  remove = cleanup.shardDeleter(s3, config);
});
afterAll(async () => { s3.destroy(); await new Promise(resolve => server.close(resolve)); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  requests = []; failDelete = false; loseResponse = false; deleteMarker = false;
});
const run = options => cleanup.cleanupSearchShard({ firestore: db, descriptor, config, remove, ...options });

it("reports bounded refusal codes without exposing credential/parser/provider text", () => {
  expect(cleanupDiagnostic(Error("search_shard_referenced"))).toBe("search_shard_referenced");
  expect(cleanupDiagnostic(Error("Separate cleanup role required"))).toBe("cleanup_role_required");
  expect(cleanupDiagnostic(Object.assign(Error("private fixture text"), { name: "AccessDenied" }))).toBe("storage_access_denied");
  expect(cleanupDiagnostic(new SyntaxError("private fixture text"))).toBe("cleanup_unconfirmed");
});

it("requires reviewed evidence, deletes only the exact version and records physical success idempotently", async () => {
  const dry = await run();
  expect(dry.state).toBe("eligible"); expect(requests).toEqual([]);
  expect((await cleanup.deletionRef(db, descriptor).get()).exists).toBe(false);
  await expect(run({ apply: true, expectedFingerprint: "b".repeat(64) })).rejects.toThrow("fingerprint");
  expect(requests).toEqual([]);
  expect(await run({ apply: true, expectedFingerprint: dry.fingerprint })).toMatchObject({ state: "deleted" });
  expect(requests).toEqual([{ method: "DELETE", path: `/${config.bucket}/transcripts/results/search-v1/${descriptor.digest}.json`, version: descriptor.objectVersion, owner: config.accountId }]);
  expect((await cleanup.deletionRef(db, descriptor).get()).data().state).toBe("deleted");
  expect(await run()).toMatchObject({ state: "deleted" });
  expect(await run({ apply: true, expectedFingerprint: dry.fingerprint })).toMatchObject({ state: "deleted", alreadyDeleted: true });
  expect(requests).toHaveLength(1);
  expect((await db.collection("admin_logs").get()).size).toBe(2);
});

it.each([false, true])("protects referenced descriptors even when pending is %s and rechecks after dry run", async pending => {
  const dry = await run();
  await db.doc("mediaSourceSearchShards/another-video").set({ ...descriptor, pending });
  await expect(run()).rejects.toThrow("referenced");
  await expect(run({ apply: true, expectedFingerprint: dry.fingerprint })).rejects.toThrow("referenced");
  expect(requests).toEqual([]);
});

it("retains a failed-delete fence and retries without claiming that a tombstone erased bytes", async () => {
  const dry = await run(); failDelete = true;
  await expect(run({ apply: true, expectedFingerprint: dry.fingerprint })).rejects.toThrow();
  expect((await cleanup.deletionRef(db, descriptor).get()).data().state).toBe("deleting");
  expect(await run()).toMatchObject({ state: "deleting" });
  expect((await db.collection("admin_logs").get()).size).toBe(1);
  failDelete = false;
  expect(await run({ apply: true, expectedFingerprint: dry.fingerprint })).toMatchObject({ state: "deleted" });
  expect(requests).toHaveLength(2);
});

it("keeps an uncertain DELETE response fenced until an exact-version retry succeeds", async () => {
  const dry = await run(); loseResponse = true;
  await expect(run({ apply: true, expectedFingerprint: dry.fingerprint })).rejects.toThrow();
  expect((await cleanup.deletionRef(db, descriptor).get()).data().state).toBe("deleting");
  loseResponse = false;
  expect(await run({ apply: true, expectedFingerprint: dry.fingerprint })).toMatchObject({ state: "deleted" });
  expect(requests.map(request => request.version)).toEqual([descriptor.objectVersion, descriptor.objectVersion]);
});

it("blocks a builder paused after PUT from promoting a claimed version, then permits a new version", async () => {
  const source = { id: "video-library", bucket: "private", prefix: "" };
  const asset = { sourceId: source.id, lifecycle: "active", kind: "video", name: "Meeting", originalName: "meeting.mp4",
    nameSort: "meeting", updatedAtSort: "2026-11-04T12:00:00Z", mimeType: "video/mp4", sizeBytes: 10,
    version: 1, preview: "browser", rightsStatus: "complete", objectKey: "objects/asset.mp4", objectVersionId: "source-v1", tags: [] };
  await db.doc("mediaSourceAssets/asset").set(asset);
  await db.runTransaction(async tx => outbox.enqueueVideoSearchShard(tx, db, "asset"));
  const ref = db.doc("mediaSourceSearchShards/asset");
  const args = { firestore: db, ref, source, config, readCorpus: async () => ({ asset: { ...asset, id: "asset" }, chunks: [], revision: null }),
    storage: { put: async () => {
      const dry = await run();
      await run({ apply: true, expectedFingerprint: dry.fingerprint });
      return descriptor;
    } } };
  await expect(shards.buildVideoSearchShard(args)).rejects.toThrow("cleanup claimed");
  expect((await ref.get()).data().pending).toBe(true);
  expect(await shards.buildVideoSearchShard({ ...args, storage: { put: async () => ({ ...descriptor, objectVersion: "new-version" }) } })).toBe(true);
  expect((await ref.get()).data()).toMatchObject({ pending: false, objectVersion: "new-version" });
  // A different immutable version with identical bytes is independently safe.
  expect(await run()).toMatchObject({ state: "deleted" });
});

it.each(["", "null", "v\n1"])("rejects ambiguous version %j and arbitrary buckets before any SDK request", async objectVersion => {
  expect(() => parseArguments(["--digest", descriptor.digest, "--object-version", objectVersion])).toThrow();
  expect(() => cleanup.shardDeleter(s3, { ...config, bucket: "other" })).toThrow("scope");
  expect(requests).toEqual([]);
});


it("refuses a delete-marker response and every later apply without claiming shard erasure", async () => {
  const dry = await run(); deleteMarker = true;
  await expect(run({ apply: true, expectedFingerprint: dry.fingerprint })).rejects.toThrow("search_shard_delete_marker");
  expect(await run()).toMatchObject({ state: "delete-marker", fingerprint: dry.fingerprint });
  expect((await db.collection("admin_logs").get()).size).toBe(1);
  expect((await cleanup.deletionRef(db, descriptor).get()).data().deletedAt).toBeUndefined();
  deleteMarker = false;
  await expect(run({ apply: true, expectedFingerprint: dry.fingerprint })).rejects.toThrow("search_shard_delete_marker");
  expect(requests).toHaveLength(1);
  expect((await db.collection("admin_logs").get()).size).toBe(1);
  expect(cleanupDiagnostic(Error("search_shard_delete_marker"))).toBe("search_shard_delete_marker");
});


it("keeps a delete-marker refusal when an earlier apply finishes its provider call later", async () => {
  const dry = await run();
  let resume, reached;
  const paused = new Promise(resolve => { resume = resolve; });
  const sent = new Promise(resolve => { reached = resolve; });
  const early = run({ apply: true, expectedFingerprint: dry.fingerprint, remove: async value => {
    const response = await remove(value); reached(); await paused; return response;
  } });
  await sent;
  try {
    deleteMarker = true;
    await expect(run({ apply: true, expectedFingerprint: dry.fingerprint })).rejects.toThrow("search_shard_delete_marker");
  } finally { resume(); }
  await expect(early).rejects.toThrow("search_shard_delete_marker");
  expect(await run()).toMatchObject({ state: "delete-marker" });
  expect((await db.collection("admin_logs").get()).size).toBe(1);
  expect(requests).toHaveLength(2);
});
