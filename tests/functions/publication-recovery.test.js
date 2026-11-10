import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import recovery from "../../functions/lib/publication-recovery.js";

const { reservePublicationRetry } = recovery;
const actor = { uid: "recovery-editor", principal: { id: "recovery-editor", grants: [{ role: "admin" }] } };
const change = { collection: "cmsPosts", id: "recovery-post", sourceVersion: 4 };
let app;
let db;
const fields = (overrides = {}) => ({ firestore: db, actor, changes: [change], baseVersion: 7, source: null, transport: "serializer", ...overrides });

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("This test requires the Firestore emulator.");
  app = initializeApp({ projectId: "demo-publication-recovery" }, "publication-recovery-test");
  db = getFirestore(app);
});
beforeEach(async () => {
  for (const name of ["cmsPosts", "cmsPublishQueue", "admin_logs"]) {
    const docs = await db.collection(name).listDocuments();
    await Promise.all(docs.map((ref) => ref.delete()));
  }
  await db.collection("cmsPosts").doc(change.id).set({
    type: "post", status: "draft", version: 7, publiclyVisible: true,
    createdBy: actor.uid, published: { sourceVersion: 4, title: "Public snapshot" },
    title: "New working title", publishBuildPending: true, publishBuildQueueId: null,
  });
});
afterAll(async () => { if (app) await deleteApp(app); });

describe("exact publication recovery", () => {
  it("reserves one owned job under concurrent retries without saving the draft", async () => {
    const results = await Promise.all([reservePublicationRetry(fields()), reservePublicationRetry(fields())]);
    expect(results[0].queueId).toBe(results[1].queueId);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
    const stored = (await db.collection("cmsPosts").doc(change.id).get()).data();
    expect(stored).toMatchObject({ version: 7, title: "New working title", status: "draft", publishBuildPending: true,
      publishBuildQueueId: results[0].queueId, published: { sourceVersion: 4, title: "Public snapshot" } });
  });

  it("rejects stale versions and out-of-scope users before reserving a job", async () => {
    await expect(reservePublicationRetry(fields({ baseVersion: 6 }))).rejects.toMatchObject({ status: 409 });
    await expect(reservePublicationRetry(fields({ changes: [{ ...change, sourceVersion: 3 }] }))).rejects.toMatchObject({ status: 409 });
    await expect(reservePublicationRetry(fields({ actor: { uid: "stranger", principal: { id: "stranger", grants: [] } } }))).rejects.toMatchObject({ status: 403 });
    expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  });

  it("retries withdrawal only while the snapshot is withdrawn", async () => {
    const request = fields({ changes: [{ ...change, operation: "withdraw" }] });
    await expect(reservePublicationRetry(request)).rejects.toMatchObject({ status: 409 });
    await db.collection("cmsPosts").doc(change.id).update({ publiclyVisible: false });
    const result = await reservePublicationRetry(request);
    expect((await db.collection("cmsPublishQueue").doc(result.queueId).get()).data().changes)
      .toEqual([{ ...change, operation: "withdraw" }]);
  });

  it("retains the original request identity when another authorized editor resumes its reservation", async () => {
    const original = await reservePublicationRetry(fields());
    const nextActor = { uid: "second-editor", principal: { id: "second-editor", grants: [{ role: "admin" }] } };
    const resumed = await reservePublicationRetry(fields({ actor: nextActor }));
    expect(resumed).toMatchObject({ queueId: original.queueId, reserved: true,
      actor: { uid: actor.uid, email: null } });
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });

  it("keeps a shared reservation owned by its batch without resuming one item", async () => {
    const original = await reservePublicationRetry(fields());
    const changes = [change, { ...change, id: "another-post" }];
    await db.collection("cmsPublishQueue").doc(original.queueId).update({ changes });
    const result = await reservePublicationRetry(fields());
    expect(result).toMatchObject({ queueId: original.queueId, reserved: false, existing: true });
    expect((await db.collection("cmsPublishQueue").doc(original.queueId).get()).data().changes).toEqual(changes);
    expect((await db.collection("cmsPublishQueue").get()).size).toBe(1);
  });
});
