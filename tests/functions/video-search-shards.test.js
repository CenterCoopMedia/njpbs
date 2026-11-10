import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import outbox from "../../functions/lib/video-search-outbox.js";
import shards from "../../functions/lib/video-search-shards.js";
import delivery from "../../functions/lib/video-search-delivery.js";
import storageModule from "../../functions/lib/video-search-shard-storage.js";
import transcriptContract from "../../functions/lib/video-transcript-contract.js";
import corpus from "../../functions/video-search-corpus.js";
import worker from "../../functions/video-search-shards.js";

const source = { id: "video-library", bucket: "private", prefix: "", access: "active_staff", writable: true };
// Direct handler tests own this project; deployed triggers use demo-njpbs.
const project = "demo-njpbs-search-shards";
const config = { bucket: "renditions", accountId: "123456789012" };
const asset = (id = "asset", fields = {}) => ({ sourceId: source.id, lifecycle: "active", kind: "video", name: "Council meeting",
  originalName: "meeting.mp4", nameSort: "council meeting", updatedAtSort: "2026-09-16T12:00:00Z", mimeType: "video/mp4", sizeBytes: 10,
  version: 1, preview: "browser", rightsStatus: "complete", objectKey: `objects/${id}.mp4`, objectVersionId: "original-v1", tags: [], ...fields });
let app, firestore, objects, storage, processor;
const ref = id => firestore.collection(outbox.SEARCH_SHARDS).doc(id);
async function commit(id = "asset", fields = {}) {
  await firestore.runTransaction(async tx => {
    tx.set(firestore.collection("mediaSourceAssets").doc(id), asset(id, fields));
    outbox.enqueueVideoSearchShard(tx, firestore, id);
  });
}
async function transcript(id = "asset") {
  const value = asset(id);
  const settings = { languageCode: "en-US", maxSpeakers: 10 };
  const job = { id: transcriptContract.transcriptId({ ...value, id }, source.bucket, settings),
    assetId: id, sourceId: source.id, sourceBucket: source.bucket,
    sourceObjectKey: value.objectKey, sourceObjectVersionId: value.objectVersionId, sourceSizeBytes: value.sizeBytes,
    ...settings, phase: "ready", editRevision: 0, createdAt: "2026-09-16T12:00:00Z" };
  await firestore.collection("mediaSourceTranscriptJobs").doc(job.id).set(job);
  return job;
}
const build = (id = "asset", fields = {}) => shards.buildVideoSearchShard({ firestore, ref: ref(id), source, config,
  storage, processor, readCorpus: corpus.readAssetCorpus, ...fields });
const manifest = () => shards.videoSearchManifest({ firestore, source, config });
const deliver = (wanted, fields = {}) => delivery.deliverVideoSearchShards({ firestore, source, config, storage,
  actor: { uid: "staff" }, reauthorize: async () => {}, request: { action: "shards", sourceId: source.id, shards: wanted }, ...fields });
beforeAll(() => {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use the local Firestore emulator");
  app = initializeApp({ projectId: project }, "video-search-shards"); firestore = getFirestore(app);
});
beforeEach(async () => {
  const response = await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  expect(response.ok).toBe(true);
  objects = new Map();
  storage = { put: vi.fn(async content => {
    const digest = storageModule.hash(JSON.stringify(content)); objects.set(digest, structuredClone(content)); return { digest, objectVersion: "v1" };
  }), read: vi.fn(async descriptor => structuredClone(objects.get(descriptor.digest))) };
  processor = { read: vi.fn(async () => [{ text: "Funding schools", startSeconds: 1, endSeconds: 2 }]) };
});
afterAll(async () => { await firestore.terminate(); await deleteApp(app); });

describe("private search outbox and authenticated delivery", () => {
  it("commits invalidation with the catalog and leaves no partial outbox on rollback", async () => {
    await expect(firestore.runTransaction(async tx => {
      tx.set(firestore.collection("mediaSourceAssets").doc("asset"), asset());
      outbox.enqueueVideoSearchShard(tx, firestore, "asset"); throw new Error("abort");
    })).rejects.toThrow("abort");
    expect((await ref("asset").get()).exists).toBe(false);
    await commit(); expect((await ref("asset").get()).data()).toMatchObject({ pending: true, tombstone: true });
    expect((await manifest()).tombstones).toEqual(["asset"]);
  });
  it("publishes safe bounded shards, then reads no source transcript in a manifest or delivery", async () => {
    await commit(); await build();
    expect((await manifest()).shards).toHaveLength(1);
    const wanted = (await manifest()).shards;
    const response = await deliver(wanted);
    expect(response.items[0].asset).not.toHaveProperty("objectKey");
    expect(response.items[0]).not.toHaveProperty("generation");
    expect(response.items[0].coverage.assetsWithoutTranscript).toBe(1);
    expect(processor.read).not.toHaveBeenCalled();
    expect(storage.read).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("presents uploader names without account fields unless users.view is %s", async (canViewUsers) => {
    await commit("asset", { createdBy: "uploader-1" });
    await firestore.collection("users").doc("uploader-1").set({ displayName: " Alex Rivera ", email: "private@example.org" });
    await build();
    const response = await deliver((await manifest()).shards, {
      actor: { uid: "staff", principal: { id: "staff", grants: [{ role: canViewUsers ? "admin" : "editor" }] } },
    });
    expect(response.items[0].asset.uploadedBy).toEqual(canViewUsers
      ? { uid: "uploader-1", name: "Alex Rivera" } : { name: "Alex Rivera" });
    expect(JSON.stringify(response)).not.toContain("private@example.org");
    if (!canViewUsers) expect(JSON.stringify(response)).not.toContain("uploader-1");
  });

  it("builds corrected transcript bytes once and reuses only materialized shards", async () => {
    await commit(); const job = await transcript(); await build();
    expect(processor.read).toHaveBeenCalledTimes(1);
    const wanted = (await manifest()).shards;
    expect((await deliver(wanted)).items[0].chunks[0]).toMatchObject({ text: "Funding schools", transcriptId: job.id });
    await manifest(); await deliver(wanted);
    expect(processor.read).toHaveBeenCalledTimes(1);
    expect(storage.read).toHaveBeenCalledTimes(2);
  });
  it("does not publish a transcript changed during its private read", async () => {
    await commit(); const job = await transcript();
    processor.read.mockImplementationOnce(async () => {
      await firestore.collection("mediaSourceTranscriptJobs").doc(job.id).update({ editRevision: 1 });
      return [{ text: "Old private words", startSeconds: 0, endSeconds: 1 }];
    });
    await expect(build()).rejects.toMatchObject({ status: 409 });
    expect((await ref("asset").get()).data().pending).toBe(true);
    expect(storage.put).not.toHaveBeenCalled();
  });
  it("retains pending tombstones on storage failure and retries the same generation", async () => {
    await commit(); const before = (await ref("asset").get()).data().generation;
    storage.put.mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(build()).rejects.toThrow("S3 unavailable");
    expect((await ref("asset").get()).data()).toMatchObject({ generation: before, pending: true });
    await build(); expect((await ref("asset").get()).data()).toMatchObject({ generation: before, pending: false });
    expect(await build()).toBe(false);
  });
  it("never restores an old generation when a newer commit overtakes S3 work", async () => {
    await commit();
    const put = storage.put.getMockImplementation();
    storage.put.mockImplementationOnce(async content => { await commit("asset", { version: 2, name: "New title" }); return put(content); });
    expect(await build()).toBe(false);
    expect((await ref("asset").get()).data()).toMatchObject({ pending: true, tombstone: true });
    await build(); const response = await deliver((await manifest()).shards);
    expect(response.items[0].asset.name).toBe("New title");
  });
  it("withholds deleted text immediately, then prunes its finished tombstone", async () => {
    await commit(); await build(); const old = (await manifest()).shards;
    await commit("asset", { lifecycle: "deleted", version: 2 });
    await expect(deliver(old)).rejects.toMatchObject({ status: 409 });
    expect((await manifest()).shards).toEqual([]);
    await build(); expect((await ref("asset").get()).exists).toBe(false);
  });
  it("rechecks the whole batch after S3 and refuses a deletion during delivery", async () => {
    await commit(); await build(); const wanted = (await manifest()).shards;
    const read = storage.read.getMockImplementation();
    storage.read.mockImplementationOnce(async descriptor => { await commit("asset", { lifecycle: "deleted", version: 2 }); return read(descriptor); });
    await expect(deliver(wanted)).rejects.toMatchObject({ status: 409 });
  });
  it("checks current source authorization after storage work", async () => {
    await commit(); await build();
    await expect(deliver((await manifest()).shards, { reauthorize: async () => { throw Object.assign(new Error("revoked"), { status: 403 }); } })).rejects.toMatchObject({ status: 403 });
  });
  it("catches direct catalog deletion without waiting for a trigger", async () => {
    await commit(); await build(); await firestore.collection("mediaSourceAssets").doc("asset").delete();
    expect((await manifest()).shards).toEqual([]);
    expect((await ref("asset").get()).data()).toMatchObject({ pending: true, tombstone: true });
  });
  it("clears the old source realm before rebuilding it", async () => {
    await commit(); await build();
    const changed = await shards.videoSearchManifest({ firestore, source: { ...source, bucket: "different" }, config });
    expect(changed.shards).toEqual([]); expect(changed.tombstones).toEqual(["asset"]);
  });
  it("bootstraps existing assets in bounded pages and retains prior pending generations", async () => {
    const batch = firestore.batch();
    for (let i = 0; i < 102; i++) batch.set(firestore.collection("mediaSourceAssets").doc(`a${String(i).padStart(3, "0")}`), asset());
    await batch.commit();
    expect(await shards.bootstrapSearchShards(firestore)).toMatchObject({ complete: false });
    const generation = (await ref("a000").get()).data().generation;
    expect(await shards.bootstrapSearchShards(firestore)).toMatchObject({ complete: true });
    expect((await firestore.collection(outbox.SEARCH_SHARDS).get()).size).toBe(102);
    expect((await ref("a000").get()).data().generation).toBe(generation);
  });
  it("reconciles direct imports against current state and ignores duplicate or delayed events", async () => {
    await firestore.collection("mediaSourceAssets").doc("asset").set(asset());
    const event = { data: { after: await firestore.collection("mediaSourceAssets").doc("asset").get() } };
    await worker.reconcileSearchAsset(event, firestore); await build();
    const before = (await ref("asset").get()).data();
    await worker.reconcileSearchAsset(event, firestore);
    expect((await ref("asset").get()).data()).toEqual(before);
  });
  it("reawakens old pending work without replacing its generation", async () => {
    await commit(); const before = (await ref("asset").get()).data().generation;
    await ref("asset").update({ requestedAt: "2026-01-01T00:00:00Z" });
    await manifest(); const current = (await ref("asset").get()).data();
    expect(current.generation).toBe(before); expect(current.pending).toBe(true); expect(current.wakeAt).toBeTypeOf("string");
    await build(); expect((await ref("asset").get()).data().pending).toBe(false);
  });
  it("bumps the source epoch once for a 50-video batch", async () => {
    let epochWrites = 0;
    await firestore.runTransaction(async tx => {
      const writer = { set(reference, data, options) {
        if (reference.path === `${outbox.SEARCH_STATE}/video-library`) epochWrites++;
        tx.set(reference, data, options);
      } };
      const ids = Array.from({ length: 50 }, (_, i) => `batch-${i}`);
      for (const id of ids) tx.set(firestore.collection("mediaSourceAssets").doc(id), asset(id));
      outbox.enqueueVideoSearchShards(writer, firestore, ids);
    });
    expect(epochWrites).toBe(1); expect((await firestore.collection(outbox.SEARCH_SHARDS).get()).size).toBe(50);
  });
  it("publishes metadata-only coverage for permanent transcript errors", async () => {
    await commit(); await transcript(); processor.read.mockRejectedValueOnce(new Error("transcript_cache_invalid"));
    await build(); const page = await manifest(); expect(page.pending).toBe(0);
    const response = await deliver(page.shards);
    expect(response.items[0]).toMatchObject({ chunks: [], revision: null, coverage: { assetsUnavailable: 1, assetsWithoutTranscript: 0 } });
    expect(response.items[0].asset.name).toBe("Council meeting");
  });
  it("requires a separate manifest after missing, malformed, incomplete or unreadable epoch checks", async () => {
    await commit(); await build(); const initial = await manifest();
    const request = { sourceId: source.id, action: "check", epoch: initial.epoch, identity: initial.identity, usersView: false };
    const response = await delivery.deliverVideoSearchShards({ request, firestore, source, config, storage, actor: { uid: "staff" }, reauthorize: async () => {} });
    expect(response.unchanged).toBe(true);
    const stateRef = firestore.collection(outbox.SEARCH_STATE).doc("video-library");
    for (const state of [null, { epoch: "invalid", complete: true }, { epoch: initial.epoch, complete: false }, "unreadable"]) {
      if (state === null) await stateRef.delete();
      else if (state !== "unreadable") await stateRef.set(state);
      let reads = 0, authorized = 0;
      // The database boundary permits exactly the state read, no corpus query.
      const stateOnly = { collection(name) {
        expect(name).toBe(outbox.SEARCH_STATE);
        return { doc: () => ({ get: async () => {
          reads++;
          if (state === "unreadable") throw new Error("unreadable");
          return stateRef.get();
        } }) };
      } };
      const result = await delivery.deliverVideoSearchShards({ request, firestore: stateOnly, source, config, storage,
        actor: { uid: "staff" }, reauthorize: async () => { authorized++; } });
      expect(result).toEqual({ success: true, schema: 1, unchanged: false, freshnessMs: 60_000 });
      expect(reads).toBe(1); expect(authorized).toBe(1);
    }
  });
  it("measures legacy versus materialized corpus reads for 16 ready videos", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `video-${String(i).padStart(2, "0")}`);
    for (const id of ids) { await commit(id); await transcript(id); await build(id); }
    await shards.bootstrapSearchShards(firestore);
    let reads = 0;
    const count = result => { reads += result.docs ? Math.max(1, result.docs.length) : 1; return wrap(result); };
    const wrap = target => new Proxy(target, { get(value, property) {
      if (property === "docs") return value.docs.map(wrap);
      if (property === "ref") return wrap(value.ref);
      if (property === "get") return async (...args) => count(await value.get(...args));
      if (["collection", "doc", "where", "orderBy", "startAfter", "limit"].includes(property)) return (...args) => wrap(value[property](...args));
      const member = Reflect.get(value, property, value);
      return typeof member === "function" ? member.bind(value) : member;
    } });
    const counted = { collection: name => wrap(firestore.collection(name)),
      getAll: async (...refs) => { const result = await firestore.getAll(...refs); reads += result.length; return result.map(wrap); },
      runTransaction: fn => firestore.runTransaction(tx => fn(wrap(tx))) };
    const handler = corpus.createVideoSearchCorpusHandler({ firestore: counted, shardStorage: storage, configFn: () => config, processor,
      registryFn: () => new Map([[source.id, source]]), verifyAppCheckFn: async () => {}, requirePrincipalFn: async () => ({ uid: "staff" }), authorizeFn: async () => {} });
    const run = async body => {
      const response = { set() {}, status(value) { this.code = value; return this; }, json(body) { this.body = body; } };
      await handler({ method: "POST", headers: { "content-type": "application/json" }, body: { sourceId: source.id, ...body } }, response);
      expect(response.code).toBe(200); return response.body;
    };
    reads = 0; processor.read.mockClear();
    let cursor, legacyRequests = 0;
    do { const page = await run({ limit: 8, ...(cursor ? { cursor } : {}) }); cursor = page.nextCursor; legacyRequests++; } while (cursor);
    const legacy = { reads, requests: legacyRequests, transcriptGets: processor.read.mock.calls.length };
    reads = 0; storage.read.mockClear(); processor.read.mockClear();
    const current = await run({ action: "manifest" });
    for (let i = 0; i < current.shards.length; i += 8) await run({ action: "shards", shards: current.shards.slice(i, i + 8).map(({ id, version }) => ({ id, version })) });
    const cold = { reads, requests: 3, shardGets: storage.read.mock.calls.length, transcriptGets: processor.read.mock.calls.length };
    reads = 0; storage.read.mockClear(); await run({ action: "manifest" });
    const warm = { reads, requests: 1, shardGets: storage.read.mock.calls.length, transcriptGets: processor.read.mock.calls.length };
    reads = 0; const lease = await run({ action: "check", epoch: current.epoch, identity: current.identity, usersView: false });
    expect(lease.unchanged).toBe(true); expect(reads).toBe(1);
    expect(legacy).toEqual({ reads: 145, requests: 2, transcriptGets: 16 });
    expect(cold).toEqual({ reads: 81, requests: 3, shardGets: 16, transcriptGets: 0 });
    expect(warm).toEqual({ reads: 33, requests: 1, shardGets: 0, transcriptGets: 0 });
    console.log(JSON.stringify({ fixture: "16 ready transcripts", legacy, cold, warm }));
  });
  it("requires App Check and source authorization before returning a manifest", async () => {
    const handler = corpus.createVideoSearchCorpusHandler({ firestore, shardStorage: storage, configFn: () => config,
      registryFn: () => new Map([[source.id, source]]), verifyAppCheckFn: async () => { throw Object.assign(new Error("denied"), { status: 401 }); } });
    const response = { set() {}, status(value) { this.code = value; return this; }, json(body) { this.body = body; } };
    await handler({ method: "POST", headers: { "content-type": "application/json" }, body: { sourceId: source.id, action: "manifest" } }, response);
    expect(response.code).toBe(401); expect(storage.read).not.toHaveBeenCalled();
  });
});
