import { beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import metadataBatch from "../../functions/source-media-metadata-batch.js";

const db = isolatedFirestore("source-media-metadata-batch.test.js");
const source = { id: "video-library", prefix: "shared/", access: "active_staff", writable: true };
const now = "2026-11-22T18:00:00.000Z";
const actor = { uid: "batch-editor", email: "batch-editor@example.org", principal: { grants: [{ role: "admin" }] } };
const otherActor = { uid: "other-editor", email: "other-editor@example.org", principal: actor.principal };
const assets = db.collection("mediaSourceAssets");
const logs = db.collection("admin_logs");

function video(id) {
  return {
    sourceId: source.id, lifecycle: "active", kind: "video", name: `Video ${id}`,
    originalName: `${id}.mp4`, nameSort: `video ${id}`, updatedAtSort: now,
    mimeType: "video/mp4", sizeBytes: 4, version: 1, preview: "browser", rightsStatus: "pending",
    objectKey: `shared/${id}.mp4`, objectVersionId: "example-object-version", tags: [],
  };
}

const entry = (assetId, changes = { tags: ["Interview"] }) => ({ assetId, expectedVersion: 1, changes });
const start = (entries, operationKey = 1) => ({ action: "start", operationKey, entries });
const advance = (assetId, operationKey = 1) => ({ action: "advance", operationKey, assetId });
const inspect = { action: "inspect" };
const cancel = { action: "cancel", operationKey: 1 };

async function request(action, { currentActor = actor, interruption } = {}) {
  const firestore = interruption ? {
    collection: db.collection.bind(db),
    async runTransaction(callback, options) {
      await db.runTransaction(async transaction => {
        const result = await callback(transaction);
        if (interruption === "before commit") throw new Error("Request ended before commit");
        return result;
      }, options);
      throw new Error("Response lost after commit");
    },
  } : db;
  const handler = metadataBatch.createCmsSourceMediaMetadataBatchHandler({
    firestore, registryFn: () => new Map([[source.id, source]]),
    requirePrincipalFn: async () => currentActor, verifyAppCheckFn: async () => ({}),
    nowFn: () => now, log: { error() {} },
  });
  const body = { sourceId: source.id, ...action };
  const response = { set() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, response);
  return response;
}

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" });
  const seed = db.batch();
  for (const id of ["first", "second", "third"]) seed.set(assets.doc(id), video(id));
  for (const { uid } of [actor, otherActor]) seed.set(db.collection("users").doc(uid), { role: "admin", active: true });
  await seed.commit();
});

it("inspects and resumes after interruptions at creation and item commit without repeating a write", async () => {
  const create = start([entry("first"), entry("second"), entry("third", {})]);
  expect((await request(create, { interruption: "before commit" })).code).toBe(500);
  expect((await request(inspect)).data.batch).toBeNull();
  expect((await request(create, { interruption: "after commit" })).code).toBe(500);
  const batch = { operationKey: 1, status: "active", items: [
    { assetId: "first", name: "Video first", status: "pending" },
    { assetId: "second", name: "Video second", status: "pending" },
    { assetId: "third", name: "Video third", status: "unchanged" },
  ] };
  expect((await request(inspect)).data.batch).toMatchObject(batch);
  expect((await request(create)).data.batch).toMatchObject(batch);
  expect((await request(start([entry("third")]))).code).toBe(409);
  expect((await request(start([entry("third")], 2))).code).toBe(409);

  expect((await request(advance("first"), { interruption: "before commit" })).code).toBe(500);
  expect((await request(inspect)).data.batch).toMatchObject(batch);
  expect((await assets.doc("first").get()).data().version).toBe(1);
  expect((await logs.get()).empty).toBe(true);
  expect((await request(advance("first"), { interruption: "after commit" })).code).toBe(500);
  const settled = (await request(inspect)).data.batch;
  expect(settled.items[0]).toMatchObject({ assetId: "first", status: "saved", savedVersion: 2 });
  expect((await request(advance("first"))).data.batch).toEqual(settled);
  expect((await request(create)).data.batch).toEqual(settled);
  expect((await assets.doc("first").get()).data()).toMatchObject({ version: 2, tags: ["Interview"] });
  expect((await db.doc("mediaSourceSearchShards/first").get()).data()).toMatchObject({ pending: true, tombstone: true });

  const resumed = await Promise.all([request(advance("second")), request(advance("second"))]);
  expect(resumed.map(result => result.code)).toEqual([200, 200]);
  expect(resumed[0].data.batch).toEqual(resumed[1].data.batch);
  expect(resumed[0].data.batch.status).toBe("completed");
  expect((await logs.get()).size).toBe(2);
  expect((await assets.doc("second").get()).data().version).toBe(2);
  expect((await assets.doc("third").get()).data().version).toBe(1);
});

it("records stale and unavailable items while preserving edits made before and during a batch", async () => {
  await assets.doc("first").update({ description: "New first description", version: 2 });
  const created = (await request(start([entry("first"), entry("second"), entry("third")]))).data.batch;
  expect(created.items.map(item => item.status)).toEqual(["stale", "pending", "pending"]);
  await assets.doc("second").update({ tags: ["Other edit"], version: 2 });
  await assets.doc("third").update({ lifecycle: "deleted", version: 2 });
  expect((await request(advance("second"))).data.batch.items[1].status).toBe("stale");
  const completed = (await request(advance("third"))).data.batch;
  expect(completed.status).toBe("completed");
  expect(completed.items.map(item => item.status)).toEqual(["stale", "stale", "unavailable"]);
  expect((await assets.doc("second").get()).data()).toMatchObject({ version: 2, tags: ["Other edit"] });
  expect((await logs.get()).empty).toBe(true);
});

it("replays cancellation after response loss and refuses late requests for a superseded batch", async () => {
  const create = start([entry("first"), entry("second")]);
  await request(create);
  await request(advance("first"));
  expect((await request(cancel, { interruption: "before commit" })).code).toBe(500);
  expect((await request(inspect)).data.batch.items[1].status).toBe("pending");
  expect((await request(cancel, { interruption: "after commit" })).code).toBe(500);
  const canceled = (await request(inspect)).data.batch;
  expect(canceled.status).toBe("canceled");
  expect(canceled.items.map(item => item.status)).toEqual(["saved", "canceled"]);
  expect((await request(cancel)).data.batch).toEqual(canceled);
  expect((await request(advance("second"))).data.batch).toEqual(canceled);
  expect((await assets.doc("second").get()).data().version).toBe(1);

  expect((await request(start([entry("second", { credit: "Example archive" })], 2))).code).toBe(200);
  for (const staleRequest of [create, cancel, advance("second")]) expect((await request(staleRequest)).code).toBe(409);
  expect((await request(advance("second", 2))).data.batch.items[0].status).toBe("saved");
  expect((await assets.doc("second").get()).data()).toMatchObject({ tags: [], credit: "Example archive", version: 2 });
});

it("scopes recovery to the authorized editor and validates the bulk write surface", async () => {
  expect((await request(start([entry("first"), entry("first")]))).code).toBe(400);
  expect((await request(start([entry("first", { name: "New name" })]))).code).toBe(400);
  expect((await request(start(Array.from({ length: 101 }, (_, index) => entry(`video-${index}`))))).code).toBe(400);
  expect((await request(start([entry("first")]))).code).toBe(200);
  expect((await request(inspect, { currentActor: otherActor })).data.batch).toBeNull();
  expect((await request(advance("first"), { currentActor: otherActor })).code).toBe(409);
  expect((await request(advance("second"))).code).toBe(404);
  await db.collection("users").doc(actor.uid).update({ active: false });
  for (const action of [inspect, advance("first"), cancel]) expect((await request(action)).code).toBe(403);
  expect((await assets.doc("first").get()).data().version).toBe(1);
});
