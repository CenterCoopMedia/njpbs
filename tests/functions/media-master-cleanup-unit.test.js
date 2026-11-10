import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import sharp from "sharp";
import media from "../../functions/media.js";
import recovery from "../../functions/media-recovery.js";
import masters from "../../functions/lib/r2-media-masters.js";
import cleanup from "../../functions/lib/media-master-cleanup.js";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");

// Transactional document/query boundary; business rules run unchanged. These
// units do not establish Firestore's concurrent transaction serialization.
function database() {
  const rows = new Map();
  let nextId = 0;
  const field = (row, path) => path.split(".").reduce((v, key) => v?.[key], row);
  const doc = (path) => ({ path, id: path.split("/").at(-1),
    collection: (name) => collection(`${path}/${name}`),
    get: async () => snapshot(doc(path)),
  });
  const snapshot = (ref) => ({ ref, id: ref.id, exists: rows.has(ref.path),
    data: () => structuredClone(rows.get(ref.path)) });
  const collection = (path, filters = [], cap = Infinity) => ({
    path, filters, cap,
    doc: (id = `auto-${++nextId}`) => doc(`${path}/${id}`),
    where: (key, op, value) => {
      if (op !== "==") throw new Error(`Unsupported fake query ${op}`);
      return collection(path, [...filters, [key, value]], cap);
    },
    select: () => collection(path, filters, cap),
    limit: (limit) => collection(path, filters, limit),
  });
  const firestore = { doc, collection, async runTransaction(fn) {
    const writes = [];
    const result = await fn({
      async getAll(...refs) {
        if (writes.length) throw new Error("Read after transaction write");
        return refs.map(snapshot);
      },
      async get(ref) {
        if (writes.length) throw new Error("Read after transaction write");
        if (!ref.filters) return snapshot(ref);
        const docs = [...rows.keys()].filter((path) =>
          path.startsWith(`${ref.path}/`) && path.split("/").length === ref.path.split("/").length + 1 &&
          ref.filters.every(([key, value]) => field(rows.get(path), key) === value))
          .slice(0, ref.cap).map((path) => snapshot(doc(path)));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
      set: (ref, value, options) => writes.push(() => rows.set(ref.path,
        options?.merge ? { ...rows.get(ref.path), ...value } : value)),
      update: (ref, value) => writes.push(() => {
        if (!rows.has(ref.path)) throw new Error("Missing update document");
        rows.set(ref.path, { ...rows.get(ref.path), ...value });
      }),
      create: (ref, value) => writes.push(() => {
        if (rows.has(ref.path)) throw new Error("Document already exists");
        rows.set(ref.path, value);
      }),
      delete: (ref) => writes.push(() => rows.delete(ref.path)),
    });
    for (const write of writes) write();
    return result;
  } };
  rows.set("system/billing", { disabled: false });
  rows.set("mediaCategories/news", { id: "news", label: "News", description: "News images", order: 1,
    active: true, version: 1, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    createdBy: "editor", updatedBy: "editor" });
  return { firestore, rows };
}

// Exercise the real R2 adapter with an in-memory S3 transport, including a PUT
// that succeeds remotely but loses its response.
function masterStore() {
  const objects = new Map();
  const state = { failPut: false, failDelete: false, beforeDelete: null };
  const storage = new masters.R2MediaMasterStorage({ bucket: "private-masters", client: {
    async send(command) {
      const { Key, Body, IfNoneMatch } = command.input;
      if (command.constructor.name === "DeleteObjectCommand") {
        await state.beforeDelete?.();
        if (state.failDelete) throw new Error("Delete unavailable");
        objects.delete(Key);
        return {};
      }
      expect(IfNoneMatch).toBe("*");
      if (objects.has(Key)) throw Object.assign(new Error("PreconditionFailed"), {
        name: "PreconditionFailed", $metadata: { httpStatusCode: 412 },
      });
      objects.set(Key, Body);
      if (state.failPut) throw new Error("PUT response lost");
      return {};
    },
  } });
  return { storage, objects, state };
}

async function fixture() {
  const store = database();
  const privateStore = masterStore();
  const buffer = await sharp({ create: { width: 40, height: 20, channels: 3,
    background: "#123456" } }).jpeg().toBuffer();
  const upload = { originalName: "studio.jpg", mimeType: "image/jpeg", buffer,
    fields: { name: "Studio", category: "news", categories: ["news"], description: "Studio",
      altText: "Studio", license: "NJ PBS owned", credit: "NJ PBS", imageProcessing: "webp" } };
  const objects = new Map();
  const publicState = { failFinal: false, occupiedFinal: false, beforeFinal: null };
  const storage = {
    async putStaging({ key, ...object }) { objects.set(key, object); },
    async putFinal({ key, ...object }) {
      await publicState.beforeFinal?.();
      if (publicState.occupiedFinal) {
        objects.set(key, { ...object, metadata: { ...object.metadata, contenthash: "f".repeat(64) } });
        return { created: false };
      }
      objects.set(key, object);
      if (publicState.failFinal) throw new Error("Final PUT response lost");
      return { created: true };
    },
    async head(key) {
      if (publicState.failFinal) throw new Error("HEAD unavailable");
      const object = objects.get(key);
      return { contentLength: object.body.length, contentType: object.mimeType, metadata: object.metadata };
    },
    async deleteStaging(key) { objects.delete(key); },
    async deleteFinal(key) { objects.delete(key); },
  };
  let id = 0;
  async function invoke(overrides = {}) {
    const res = { statusCode: null, set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; this.headersSent = true; return this; } };
    await media.createCmsUploadMediaHandler({
      firestore: store.firestore,
      requirePrincipalFn: async () => ({ uid: "editor", email: "editor@example.test",
        principal: { id: "editor", grants: [{ role: "editor" }] } }),
      parseUploadFn: async () => upload,
      storageFactory: () => storage, masterStorageFactory: () => privateStore.storage,
      maxUploadBytes: 10 * 1024 * 1024,
      mintId: () => `id-${++id}`, now: () => NOW, publicOrigin: "https://media.example.test",
      log: { error: vi.fn(), warn: vi.fn() }, ...overrides,
    })({ method: "POST", headers: { "content-type": "multipart/form-data; boundary=test" },
      rawBody: buffer }, res);
    return res;
  }
  const key = masters.masterObjectKey({ contentHash: hash(buffer), mimeType: "image/jpeg" });
  return { ...store, privateStore, objects, publicState, upload, key, invoke };
}
const owners = (f) => [...f.rows.entries()].filter(([key]) => key.startsWith("system/media/hashOwners/"));
const cleanupArgs = (f) => {
  const [path, claim] = owners(f)[0];
  return { firestore: f.firestore, ref: f.firestore.doc(path),
    attemptId: claim.attemptId, leaseExpiresAt: claim.leaseExpiresAt,
    masterStorageFactory: () => f.privateStore.storage, nowIso: NOW.toISOString() };
};
const intents = (f) => [...f.rows.entries()].filter(([key]) => key.startsWith("mediaMasterCleanup/"));

// #2683: different originals can produce the same web copy. Duplicate detection
// owns the public hash, and must reject before keeping the second original.
describe("rejected upload master cleanup", () => {
  it("keeps duplicate 409 detection without retaining the second original", async () => {
    const f = await fixture();
    const original = f.upload.buffer;
    expect((await f.invoke()).statusCode).toBe(201);
    expect(f.rows.get("media_assets/id-1").master).toMatchObject({ retained: true, key: f.key });
    f.upload.buffer = await sharp(original).withMetadata({ density: 144 }).jpeg().toBuffer();
    expect(hash(f.upload.buffer)).not.toBe(hash(original));
    const rejected = await f.invoke();
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body.duplicateAssetId).toBe("id-1");
    expect([...f.privateStore.objects.keys()]).toEqual([f.key]);
    expect(intents(f)).toEqual([]);
  });

  it("rejects invalid metadata before keeping a master", async () => {
    const f = await fixture();
    f.upload.fields.category = "INVALID";
    expect((await f.invoke()).statusCode).toBe(400);
    expect(f.privateStore.objects.size).toBe(0);
  });

  it.each(["capacity", "category"])("deletes an unshared master after %s refusal", async (reason) => {
    const f = await fixture();
    if (reason === "capacity") {
      for (let i = 0; i < 500; i++) f.rows.set(`media_assets/full-${i}`, { lifecycle: "active" });
    } else {
      f.publicState.beforeFinal = () => { f.rows.get("mediaCategories/news").active = false; };
    }
    const rejected = await f.invoke();
    expect(rejected.statusCode).toBe(reason === "capacity" ? 507 : 400);
    expect(f.privateStore.objects.size).toBe(0);
    expect(owners(f)).toEqual([]);
    expect(intents(f)).toEqual([]);
    expect(f.objects.size).toBe(0);
  });

  it("cleans a partial master PUT even when its response fails", async () => {
    const f = await fixture();
    f.privateStore.state.failPut = true;
    expect((await f.invoke()).statusCode).toBe(201);
    expect(f.privateStore.objects.size).toBe(0);
    expect(f.rows.get("media_assets/id-1").master).toMatchObject({ retained: false, reason: "store-failed" });
  });

  it("keeps a recoverable master and queues its claim expiry after an uncertain public write", async () => {
    const f = await fixture();
    f.publicState.failFinal = true;
    expect((await f.invoke()).statusCode).toBe(503);
    expect(f.privateStore.objects.has(f.key)).toBe(true);
    const claim = owners(f)[0][1];
    expect(claim.recordSeed.master).toMatchObject({ retained: true, key: f.key });
    expect(intents(f)[0][1]).toMatchObject({ key: f.key, eligibleAt: claim.leaseExpiresAt });
    expect(f.rows.has(`system/media/masterLocks/${hash(f.upload.buffer)}`)).toBe(false);
  });

  it("refreshes the cleanup intent when a renewed upload fails again", async () => {
    const f = await fixture();
    f.publicState.failFinal = true;
    expect((await f.invoke()).statusCode).toBe(503);
    const [path, original] = owners(f)[0];
    const retried = await f.invoke({ now: () => new Date("2026-10-09T12:16:00.000Z") });
    expect(retried.statusCode).toBe(503);
    expect(owners(f)[0][1]).toMatchObject({ attemptId: original.attemptId,
      leaseExpiresAt: "2026-10-09T12:31:00.000Z" });
    expect(intents(f)).toHaveLength(1);
    expect(intents(f)[0][1]).toMatchObject({ key: f.key, claimPath: path,
      attemptId: original.attemptId, leaseExpiresAt: "2026-10-09T12:31:00.000Z",
      eligibleAt: "2026-10-09T12:31:00.000Z", queuedAt: "2026-10-09T12:16:00.000Z" });
    expect(f.privateStore.objects.has(f.key)).toBe(true);
  });

  it("returns recovery details and keeps the master when the immutable final key is occupied", async () => {
    const f = await fixture();
    f.publicState.occupiedFinal = true;
    f.privateStore.state.failDelete = true;
    const response = await f.invoke();
    const claim = owners(f)[0][1];
    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: "The upload needs recovery before it can be retried",
      retryable: true, attemptId: claim.attemptId });
    expect(f.privateStore.objects.has(f.key)).toBe(true);
    expect(intents(f)[0][1]).toMatchObject({ key: f.key, leaseExpiresAt: claim.leaseExpiresAt,
      eligibleAt: claim.leaseExpiresAt });
    expect(f.rows.has(`system/media/masterLocks/${hash(f.upload.buffer)}`)).toBe(false);
  });

  it.each(["master write", "quota"])("keeps exact cleanup intent when delete fails after %s", async (reason) => {
    const f = await fixture();
    f.privateStore.state.failDelete = true;
    if (reason === "master write") f.privateStore.state.failPut = true;
    else for (let i = 0; i < 500; i++) f.rows.set(`media_assets/full-${i}`, { lifecycle: "active" });
    expect((await f.invoke()).statusCode).toBe(503);
    expect(f.privateStore.objects.has(f.key)).toBe(true);
    const [path, claim] = owners(f)[0];
    expect(intents(f)[0][1]).toMatchObject({ state: "pending", key: f.key,
      claimPath: path, attemptId: claim.attemptId });
    expect(claim.recordSeed.master.key).toBe(f.key);
    // Retry the durable intent through the same reference-safe cleanup path.
    f.privateStore.state.failDelete = false;
    const retryMs = Date.parse(f.rows.get(`system/media/masterLocks/${hash(f.upload.buffer)}`).deleteLeaseExpiresAt);
    await cleanup.cleanupUploadMaster({ firestore: f.firestore, ref: f.firestore.doc(path),
      attemptId: claim.attemptId, leaseExpiresAt: claim.leaseExpiresAt,
      masterStorageFactory: () => f.privateStore.storage,
      nowIso: new Date(NOW.getTime() + cleanup.DELETE_LEASE_MS).toISOString(),
      clockMs: () => retryMs });
    expect(f.privateStore.objects.size).toBe(0);
    expect(intents(f)).toEqual([]);
    expect(f.rows.has(`system/media/masterLocks/${hash(f.upload.buffer)}`)).toBe(false);
  });

  it.each(["asset", "claim", "version"])("preserves a master referenced by another %s", async (reference) => {
    const f = await fixture();
    const rows = {
      asset: ["media_assets/shared", { lifecycle: "tombstoned", master: { key: f.key } }],
      claim: ["system/media/hashOwners/shared", { state: "reserved", recordSeed: { master: { key: f.key } } }],
      version: ["mediaPurgeQueue/version:shared", { state: "pending", masterKey: f.key }],
    };
    f.rows.set(...rows[reference]);
    f.publicState.beforeFinal = () => { f.rows.get("mediaCategories/news").active = false; };
    expect((await f.invoke()).statusCode).toBe(400);
    expect(f.privateStore.objects.has(f.key)).toBe(true);
    expect(intents(f)).toEqual([]);
  });



  it("stale recovery commits a retained original after a lost public PUT response", async () => {
    const f = await fixture();
    f.publicState.failFinal = true;
    expect((await f.invoke()).statusCode).toBe(503);
    const [path] = owners(f)[0];
    const result = await recovery.recoverOneUpload({
      firestore: f.firestore, contentHash: path.split("/").at(-1),
      user: { uid: "editor", principal: { id: "editor", grants: [{ role: "editor" }] } },
      nowDate: new Date(NOW.getTime() + 16 * 60_000), publicOrigin: "https://media.example.test",
      storage: {
        async headIfExists(key) {
          const object = f.objects.get(key);
          return object ? { contentLength: object.body.length,
            contentType: object.mimeType, metadata: object.metadata } : null;
        },
        async deleteStaging(key) { f.objects.delete(key); },
      },
    });
    expect(result.state).toBe("committed");
    expect(f.rows.get("media_assets/id-1").master).toMatchObject({ retained: true, key: f.key });
    expect(f.privateStore.objects.has(f.key)).toBe(true);
    await cleanup.cleanupUploadMaster(cleanupArgs(f));
    expect(f.privateStore.objects.has(f.key)).toBe(true);
  });

  it("records cleanup without a purge fence when the store is unavailable", async () => {
    const f = await fixture();
    f.publicState.failFinal = true;
    expect((await f.invoke()).statusCode).toBe(503);
    await expect(cleanup.cleanupUploadMaster({ ...cleanupArgs(f),
      masterStorageFactory: () => null })).rejects.toThrow("store is unavailable");
    expect(intents(f)[0][1]).toMatchObject({ key: f.key });
    expect(f.rows.has(`system/media/masterLocks/${hash(f.upload.buffer)}`)).toBe(false);
    expect(f.privateStore.objects.has(f.key)).toBe(true);
  });

  it("never deletes a committed master or a different lease's master", async () => {
    const f = await fixture();
    expect((await f.invoke()).statusCode).toBe(201);
    const [path, claim] = owners(f)[0];
    const args = { firestore: f.firestore, ref: f.firestore.doc(path),
      attemptId: claim.attemptId, leaseExpiresAt: claim.leaseExpiresAt,
      masterStorageFactory: () => f.privateStore.storage, nowIso: NOW.toISOString() };
    await cleanup.cleanupUploadMaster(args);
    expect(f.privateStore.objects.has(f.key)).toBe(true);
    f.rows.set(path, { ...claim, state: "reserved", leaseExpiresAt: "2026-10-10T00:00:00.000Z" });
    await expect(cleanup.cleanupUploadMaster(args)).rejects.toThrow("changed before");
    expect(f.privateStore.objects.has(f.key)).toBe(true);
    expect(intents(f)).toEqual([]);
  });


  it("refuses a delayed commit during and after master deletion", async () => {
    const f = await fixture();
    f.publicState.failFinal = true;
    let commitArgs;
    f.privateStore.state.beforeDelete = async () => {
      const [path, claim] = owners(f)[0];
      f.rows.set(path, { ...claim, state: "object_ready" });
      const record = media.uploadRecordFromClaim({ contentHash: path.split("/").at(-1),
        claim, publicOrigin: "https://media.example.test", nowIso: NOW.toISOString() });
      commitArgs = { firestore: f.firestore, ref: f.firestore.doc(path),
        attemptId: claim.attemptId, expectedLeaseExpiresAt: claim.leaseExpiresAt,
        record, actor: claim.recordSeed.actor, nowIso: NOW.toISOString() };
      await expect(media.commitUpload(commitArgs)).rejects.toThrow("being purged");
    };
    expect((await f.invoke()).statusCode).toBe(503);
    await cleanup.cleanupUploadMaster(cleanupArgs(f));
    expect(commitArgs).toBeDefined();
    await expect(media.commitUpload(commitArgs)).rejects.toThrow("not ready to commit");
    expect(f.rows.has("media_assets/id-1")).toBe(false);
    expect(f.privateStore.objects.size).toBe(0);
  });

  it("fences a new master reservation while deletion runs", async () => {
    const f = await fixture();
    f.publicState.failFinal = true;
    let observedFence = false;
    f.privateStore.state.beforeDelete = async () => {
      await expect(f.firestore.runTransaction((transaction) => media.requireMasterAvailable(
        transaction, f.firestore, { key: f.key, contentHash: hash(f.upload.buffer) },
      ))).rejects.toThrow("being purged");
      const [path] = owners(f)[0];
      await expect(recovery.acquireRecoveryLease({ firestore: f.firestore,
        contentHash: path.split("/").at(-1), user: { uid: "editor",
          principal: { id: "editor", grants: [{ role: "editor" }] } },
        nowDate: new Date(NOW.getTime() + 16 * 60_000),
      })).rejects.toThrow("being purged");
      observedFence = true;
    };
    expect((await f.invoke()).statusCode).toBe(503);
    await cleanup.cleanupUploadMaster(cleanupArgs(f));
    expect(f.privateStore.objects.size).toBe(0);
    expect(observedFence).toBe(true);
  });
});
