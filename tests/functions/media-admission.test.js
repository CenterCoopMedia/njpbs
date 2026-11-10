import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import admin from "../helpers/firebase-admin.js";
import discovery from "../../functions/lib/media-discovery.js";
const { readMediaAdmission, writeMediaAdmission, prepareMediaAdmissionRelease, bumpMediaDiscoveryRevision, reconcileMediaAdmission } = discovery;
let db;
beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
  db = isolatedFirestore("media-admission.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

describe("media admission ledger", () => {
  it("bootstraps transactionally, excludes inactive records and preserves the indexed cap", async () => {
    await Promise.all([
      db.doc("media_assets/one").set({ lifecycle: "active" }),
      db.doc("media_assets/two").set({ lifecycle: "tombstoned" }),
      db.doc("system/mediaDiscovery").set({ schema: 1, state: "ready", revision: 4 }),
    ]);
    expect(await reconcileMediaAdmission(db)).toEqual({ activeCount: 1, limit: 5000, revision: 4, applied: false });
    expect((await db.doc("system/mediaDiscovery").get()).data()).not.toHaveProperty("admission");
    expect(await reconcileMediaAdmission(db, { apply: true })).toEqual({ activeCount: 1, limit: 5000, revision: 4, applied: true });
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({ revision: 4, admission: { schema: 1, activeCount: 1 } });
  });
  it("preserves a known count for metadata and invalidates it for an unknown bulk writer", async () => {
    await db.doc("media_assets/one").set({ lifecycle: "active" });
    await reconcileMediaAdmission(db, { apply: true });
    await db.runTransaction(async tx => { bumpMediaDiscoveryRevision(tx, db, { preserveAdmission: true }); });
    expect((await db.doc("system/mediaDiscovery").get()).data().admission.activeCount).toBe(1);
    await db.runTransaction(async tx => {
      tx.create(db.doc("media_assets/two"), { lifecycle: "active" });
      bumpMediaDiscoveryRevision(tx, db);
    });
    expect((await db.doc("system/mediaDiscovery").get()).data()).not.toHaveProperty("admission");
    await db.runTransaction(async tx => {
      const admission = await readMediaAdmission(tx, db);
      expect(admission.activeCount).toBe(2);
      writeMediaAdmission(tx, db, admission.activeCount, admission.revision);
    });
  });
  it("reconciles corrupted state and rejects an underflow without writing", async () => {
    await db.doc("system/mediaDiscovery").set({ admission: { schema: 1, activeCount: -1 } });
    expect(await reconcileMediaAdmission(db, { apply: true })).toMatchObject({ activeCount: 0 });
    await expect(db.runTransaction(async tx => { writeMediaAdmission(tx, db, -1, 0); })).rejects.toMatchObject({ status: 503 });
    expect((await db.doc("system/mediaDiscovery").get()).data().admission.activeCount).toBe(0);
  });
  it("measures a warm admission read at one state document with no active-record query", async () => {
    let docs = 0, queries = 0;
    const fake = { doc: path => ({ path }), collection: () => { throw new Error("Warm admission scanned the library"); } };
    const tx = { async get(ref) { docs += 1; expect(ref.path).toBe("system/mediaDiscovery"); return {
      exists: true, data: () => ({ schema: 1, state: "ready", admission: { schema: 1, activeCount: 4999, revision: 0 } }),
    }; } };
    expect(await readMediaAdmission(tx, fake)).toEqual({ activeCount: 4999, limit: 5000, revision: 0 });
    expect({ docs, queries }).toEqual({ docs: 1, queries: 0 });
  });
  it("bounds reconciliation at 5,001 records and fails closed on overflow", async () => {
    let bound;
    const query = { where() { return this; }, select() { return this; }, limit(n) { bound = n; return this; } };
    const fake = { doc: () => ({}), collection: () => query };
    const tx = { async get(ref) { return ref === query ? { size: 5001 } : { exists: false }; } };
    await expect(readMediaAdmission(tx, fake)).rejects.toMatchObject({ status: 503 });
    expect(bound).toBe(5001);
  });
  it("rejects stale counts left by an older deployed writer and reconciles at the current revision", async () => {
    await db.doc("system/mediaDiscovery").set({ revision: 1, admission: { schema: 1, activeCount: 1, revision: 1 } });
    await db.doc("media_assets/one").set({ lifecycle: "active" });
    await db.runTransaction(async tx => {
      tx.create(db.doc("media_assets/two"), { lifecycle: "active" });
      tx.set(db.doc("system/mediaDiscovery"), { revision: admin.firestore.FieldValue.increment(1) }, { merge: true });
    });
    const result = await db.runTransaction(tx => readMediaAdmission(tx, db));
    expect(result).toMatchObject({ activeCount: 2, revision: 2 });
    expect(await reconcileMediaAdmission(db, { apply: true })).toMatchObject({ activeCount: 2, revision: 2 });
  });
  it.each([undefined, { schema: 1, activeCount: 0, revision: 1 }, { schema: 1, activeCount: 5000, revision: 0 }])(
    "invalidates an unavailable release ledger without a collection scan (%j)", async admission => {
      await db.doc("system/mediaDiscovery").set({ revision: 1, ...(admission ? { admission } : {}) });
      await db.runTransaction(async tx => {
        const release = await prepareMediaAdmissionRelease(tx, db);
        expect(release).toEqual({});
        bumpMediaDiscoveryRevision(tx, db, { withdrawal: true, ...release });
      });
      expect((await db.doc("system/mediaDiscovery").get()).data()).not.toHaveProperty("admission");
    });

  it.each([-1, 1.5, "invalid", Number.MAX_SAFE_INTEGER, NaN])("repairs a malformed discovery revision atomically (%j)", async revision => {
    await db.doc("media_assets/one").set({ lifecycle: "active" });
    await db.doc("system/mediaDiscovery").set({ revision, admission: { schema: 1, activeCount: 4999, revision: 0 } });
    expect(await reconcileMediaAdmission(db)).toMatchObject({ activeCount: 1, revision: 0, applied: false });
    expect((await db.doc("system/mediaDiscovery").get()).data().revision).toEqual(revision);
    expect(await reconcileMediaAdmission(db, { apply: true })).toMatchObject({ activeCount: 1, revision: 0, applied: true });
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({ revision: 0, admission: { activeCount: 1, revision: 0 } });
    const guarded = { doc: path => db.doc(path), collection() { throw new Error("Repaired admission scanned again"); } };
    expect(await db.runTransaction(tx => readMediaAdmission(tx, guarded))).toMatchObject({ activeCount: 1, revision: 0 });
  });
  it("normalizes a malformed revision when allocating in the asset transaction", async () => {
    await db.doc("system/mediaDiscovery").set({ revision: -3 });
    await db.runTransaction(async tx => {
      const admission = await readMediaAdmission(tx, db);
      tx.create(db.doc("media_assets/one"), { lifecycle: "active" });
      bumpMediaDiscoveryRevision(tx, db, { admissionCount: admission.activeCount + 1, admissionRevision: admission.revision + 1 });
    });
    expect((await db.doc("system/mediaDiscovery").get()).data()).toMatchObject({ revision: 1, admission: { activeCount: 1, revision: 1 } });
  });

});
