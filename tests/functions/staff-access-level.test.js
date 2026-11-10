import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import levels from "../../functions/staff-access-level.js";
import principal from "../../functions/lib/principal.js";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const actor = { uid: "owner", email: "owner@example.test", emailVerified: true };
const activation = { schema: 1, state: "active", cleanScan: true };
let db;
const ref = (uid) => db.collection("users").doc(uid);
const stored = async (uid = "target") => (await ref(uid).get()).data();
const audit = async () => (await db.collection("admin_logs").get()).docs.map((row) => row.data());

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(host ?? "")) throw new Error("Local Firestore emulator required");
  if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
  db = isolatedFirestore("staff-access-level.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/staffAccessActivation").set(activation);
  await ref("owner").set({ role: "super_admin", active: true });
  await ref("target").set({ role: null, active: true, grants: [{ role: "editor", sections: ["watch"] }] });
});
afterAll(async () => { await Promise.all(admin.apps.map((app) => app.delete())); });

async function call({ body, actorValue = actor, identity = { emailVerified: true, disabled: false }, firestore = db,
  authClient = { getUser: vi.fn(async () => identity) }, method = "POST", log = { error: vi.fn() } } = {}) {
  const response = { status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  const requestBody = body ?? { targetUid: "target", accessTier: "publisher", expectedAccess: principal.accessStateFromUserDoc(await stored()) };
  await levels.createSetStaffAccessLevelHandler({ firestore, authClient,
    requireSuperAdminFn: async () => actorValue, log })({
    method, body: requestBody, headers: {}, ip: "127.0.0.1",
  }, response);
  return response;
}

describe("single staff level replacement", () => {
  it.each(["viewer", "contributor", "editor", "publisher", "admin", "owner"])("atomically replaces legacy roles and scopes with %s and one audit", async (accessTier) => {
    const before = await stored();
    const result = await call({ body: { targetUid: "target", accessTier, expectedAccess: principal.accessStateFromUserDoc(before) } });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ changed: true, accessTier });
    expect(await stored()).toMatchObject({ accessTier, role: null, grants: [] });
    expect(await audit()).toMatchObject([{ action: "staff.level.replace", target: "target",
      before: { role: null, grants: before.grants }, after: { accessTier, role: null, grants: [] } }]);
  });
  it.each([undefined, { ...activation, cleanScan: false }, { ...activation, schema: 2 }])("refuses writes under missing or invalid activation %j", async (receipt) => {
    if (receipt) await db.doc("system/staffAccessActivation").set(receipt);
    else await db.doc("system/staffAccessActivation").delete();
    const before = await stored();
    expect((await call()).statusCode).toBe(409);
    expect(await stored()).toEqual(before);
    expect(await audit()).toEqual([]);
  });
  it.each([
    { role: "admin" }, { accessTier: "admin", role: "super_admin" },
    { accessTier: "invalid", role: "super_admin" }, { role: "super_admin", active: false },
    { role: "super_admin", active: "true" },
  ])("rechecks the current actor in the transaction: %j", async (profile) => {
    await ref("owner").set(profile);
    const before = await stored();
    expect((await call()).statusCode).toBe(403);
    expect(await stored()).toEqual(before);
    expect(await audit()).toEqual([]);
  });
  it("accepts an activated Owner without a legacy role", async () => {
    await ref("owner").set({ accessTier: "owner", role: null, grants: [], active: true });
    expect((await call()).statusCode).toBe(200);
  });
  it("rejects a demotion between request admission and transaction execution", async () => {
    const firestore = { collection: db.collection.bind(db), runTransaction: async (fn) => {
      await ref("owner").set({ accessTier: "viewer", role: "super_admin" });
      return db.runTransaction(fn);
    } };
    expect((await call({ firestore })).statusCode).toBe(403);
    expect(await audit()).toEqual([]);
  });
  it("rechecks activation on transaction retry", async () => {
    let attempts = 0;
    const firestore = { collection: db.collection.bind(db), runTransaction: (fn) => db.runTransaction(async (transaction) => {
      if (attempts++ === 0) {
        await fn(transaction);
        throw Object.assign(new Error("retry"), { code: 10 });
      }
      await db.doc("system/staffAccessActivation").delete();
      return fn(transaction);
    }) };
    expect((await call({ firestore })).statusCode).toBe(409);
    expect(await audit()).toEqual([]);
    expect(await stored()).not.toHaveProperty("accessTier");
  });
  it("refuses a stale reviewed row and keeps its new access", async () => {
    const expectedAccess = principal.accessStateFromUserDoc(await stored());
    await ref("target").update({ grants: [{ role: "contributor" }] });
    expect((await call({ body: { targetUid: "target", accessTier: "owner", expectedAccess } })).statusCode).toBe(409);
    expect((await stored()).grants).toEqual([{ role: "contributor" }]);
    expect(await audit()).toEqual([]);
  });
  it("allows one of two concurrent changes to the same reviewed row", async () => {
    const expectedAccess = principal.accessStateFromUserDoc(await stored());
    const results = await Promise.all(["viewer", "owner"].map((accessTier) => call({ body: { targetUid: "target", accessTier, expectedAccess } })));
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(await audit()).toHaveLength(1);
  });
  it("leaves an Owner after concurrent cross-demotions", async () => {
    await ref("target").set({ accessTier: "owner", role: null, grants: [], active: true });
    const results = await Promise.all([
      call(),
      call({ actorValue: { ...actor, uid: "target" }, body: { targetUid: "owner", accessTier: "viewer", expectedAccess: principal.accessStateFromUserDoc(await stored("owner")) } }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 403]);
    const owners = [await stored("owner"), await stored()].filter((profile) => principal.administrativeRoleFromUserDoc(profile, true) === "super_admin");
    expect(owners).toHaveLength(1);
  });
  it("does not audit an unchanged level again", async () => {
    expect((await call()).statusCode).toBe(200);
    expect((await call()).body.changed).toBe(false);
    expect(await audit()).toHaveLength(1);
  });
  it("refuses a self change and an unverified actor", async () => {
    expect((await call({ body: { targetUid: actor.uid, accessTier: "viewer", expectedAccess: principal.accessStateFromUserDoc(await stored("owner")) } })).statusCode).toBe(403);
    expect((await call({ actorValue: { ...actor, emailVerified: false } })).statusCode).toBe(403);
    expect(await audit()).toEqual([]);
  });
  it("does not look up target identities for an unverified actor", async () => {
    const authClient = { getUser: vi.fn() };
    expect((await call({ actorValue: { ...actor, emailVerified: false }, authClient })).statusCode).toBe(403);
    expect(authClient.getUser).not.toHaveBeenCalled();
  });
  it.each([{ emailVerified: false }, { emailVerified: true, disabled: true }])("refuses an unavailable target identity %j", async (identity) => {
    expect((await call({ identity })).statusCode).toBe(409);
    expect(await audit()).toEqual([]);
  });
  it("refuses inactive or missing profiles without provisioning", async () => {
    await ref("target").update({ active: false });
    expect((await call()).statusCode).toBe(409);
    await ref("target").delete();
    expect((await call({ body: { targetUid: "target", accessTier: "viewer", expectedAccess: "missing" } })).statusCode).toBe(404);
    expect(await audit()).toEqual([]);
  });
  it("refuses malformed active status instead of writing an unusable tier", async () => {
    await ref("target").update({ active: "true" });
    expect((await call()).statusCode).toBe(409);
    expect(await audit()).toEqual([]);
    expect(await stored()).not.toHaveProperty("accessTier");
  });
  it.each([
    { accessTier: "Owner" }, { accessTier: "constructor" }, { accessTier: null }, { targetUid: "users/target" },
    { sections: ["watch"] }, { expectedAccess: null },
  ])("refuses malformed or scoped requests %j", async (extra) => {
    expect((await call({ body: { targetUid: "target", accessTier: "viewer", expectedAccess: "reviewed", ...extra } })).statusCode).toBe(400);
    expect(await audit()).toEqual([]);
  });
  it("rejects GET and hides infrastructure errors", async () => {
    expect((await call({ method: "GET" })).statusCode).toBe(405);
    const result = await call({ authClient: { getUser: async () => { throw new Error("provider-private-detail"); } } });
    expect(result.statusCode).toBe(500);
    expect(result.body.error).not.toContain("provider-private-detail");
  });
  it("records safe provider failure codes without copying raw messages or provider statuses", async () => {
    const log = { error: vi.fn() };
    const result = await call({ log, authClient: { getUser: async () => {
      throw Object.assign(new Error("provider-private-detail"), { code: 13, status: 403 });
    } } });
    expect(result.statusCode).toBe(500);
    expect(result.body.error).not.toContain("provider-private-detail");
    expect(log.error).toHaveBeenCalledWith("setStaffAccessLevel failed", { code: 13 });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("provider-private-detail");
  });
});
