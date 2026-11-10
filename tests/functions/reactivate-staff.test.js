import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import reactivation from "../../functions/reactivate-staff.js";
import deactivation from "../../functions/deactivate-staff.js";
import store from "../../functions/lib/author-profile-store.js";
import authSync from "../../functions/lib/staff-auth-sync.js";

const host = process.env.FIRESTORE_EMULATOR_HOST;
const actor = { uid: "owner", email: "owner@example.test", emailVerified: true };
const activation = { schema: 1, state: "active", cleanScan: true };
const NOW = "2026-10-27T15:00:00.000Z";
let db;
const ref = (uid) => db.collection("users").doc(uid);
const stored = async (uid = "target") => (await ref(uid).get()).data();
const audit = async () => (await db.collection("admin_logs").get()).docs.map((row) => row.data());
const response = () => ({ status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });

// Firebase Auth is the system boundary here; Firestore is the real emulator.
function fakeAuth({ disabled = true, emailVerified = true, enableFailure = null, beforeEnable = null } = {}) {
  const user = { disabled, emailVerified, tokensValidAfterTime: "2026-10-01T00:00:00.000Z" };
  return {
    user,
    getUser: vi.fn(async () => ({ ...user })),
    updateUser: vi.fn(async (_uid, change) => {
      if (change.disabled === false && enableFailure) throw enableFailure;
      if (change.disabled === false && beforeEnable) await beforeEnable();
      Object.assign(user, change);
    }),
    revokeRefreshTokens: vi.fn(async () => { user.tokensValidAfterTime = NOW; }),
  };
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(host ?? "")) throw new Error("Local Firestore emulator required");
  if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
  db = isolatedFirestore("reactivate-staff.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/staffAccessActivation").set(activation);
  await ref("owner").set({ accessTier: "owner", role: null, grants: [], active: true });
  await ref("target").set({ accessTier: "publisher", role: null, grants: [], active: true, email: "target@example.test", displayName: "Target person" });
});
afterAll(async () => { await Promise.all(admin.apps.map((app) => app.delete())); });

async function reactivate({ body = { targetUid: "target", accessTier: "contributor" }, actorValue = actor,
  authClient = fakeAuth(), firestore = db, method = "POST", log = { error: vi.fn() } } = {}) {
  const res = response();
  await reactivation.createReactivateStaffHandler({ firestore, authClient, log, nowIso: () => NOW,
    requireSuperAdminFn: async () => actorValue })({ method, body, headers: {}, ip: "127.0.0.1" }, res);
  return res;
}

async function deactivate(authClient) {
  const res = response();
  await deactivation.createDeactivateStaffHandler({ firestore: db, authClient, log: { error: vi.fn() },
    now: () => NOW, nowIso: () => NOW, requireSuperAdminFn: async () => actor,
  })({ method: "POST", body: { targetUid: "target" }, headers: {}, ip: null }, res);
  return res;
}

describe("staff reactivation", () => {
  it("persists an unfinished shutdown across requests and completes it once without a second audit", async () => {
    const authClient = fakeAuth({ disabled: false });
    authClient.revokeRefreshTokens.mockRejectedValueOnce(new Error("Auth unavailable"));
    expect((await deactivate(authClient)).statusCode).toBe(503);
    expect(await stored()).toMatchObject({ active: false, offboarding: { step: "sign_in_and_sessions" } });
    const failedId = (await stored()).offboarding.id;
    expect((await deactivate(authClient)).statusCode).toBe(200);
    expect(await stored()).toMatchObject({ offboarding: { step: "complete" } });
    expect((await stored()).offboarding.id).not.toBe(failedId);
    expect((await audit()).filter(row => row.action === "staff.deactivate")).toHaveLength(1);
    expect((await reactivate({ authClient })).statusCode).toBe(200);
    expect(await stored()).not.toHaveProperty("offboarding");
  });
  it("does not let an older offboarding overwrite the latest shutdown progress", async () => {
    const authClient = fakeAuth({ disabled: false });
    let latestId;
    authClient.updateUser.mockImplementationOnce(async (_uid, change) => {
      Object.assign(authClient.user, change);
      expect((await deactivate(authClient)).statusCode).toBe(200);
      latestId = (await stored()).offboarding.id;
    });
    expect((await deactivate(authClient)).statusCode).toBe(409);
    expect(await stored()).toMatchObject({ offboarding: { id: latestId, step: "complete" } });
  });
  it("restores sign-in and one chosen level after a real deactivation, with one audit", async () => {
    const { staff } = await store.ensureAuthorIdentity({ firestore: db, uid: "target", nowIso: NOW,
      actorUid: "target", randomHex: "0".repeat(31) + "1" });
    const authClient = fakeAuth({ disabled: false });
    expect((await deactivate(authClient)).statusCode).toBe(200);
    expect(authClient.user.disabled).toBe(true);
    expect(await stored()).toMatchObject({ active: false, role: null, grants: [] });
    expect(await stored()).not.toHaveProperty("accessTier");
    const auditCount = (await audit()).length;

    const result = await reactivate({ authClient });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ success: true, accessTier: "contributor", alreadyActive: false });
    expect(authClient.user.disabled).toBe(false);
    expect(await stored()).toMatchObject({ active: true, accessTier: "contributor", role: null, grants: [],
      tokensValidAfter: Date.parse(NOW) / 1000 });
    const linkage = (await db.collection("cmsStaffRecords").doc("target").get()).data();
    expect(linkage).toMatchObject({ status: "active", authorId: staff.authorId });
    expect((await db.collection("cmsBylineSelf").doc("target").get()).data()).toEqual({ authorId: staff.authorId });
    expect((await db.collection("staffReactivations").doc("target").get()).exists).toBe(false);
    const reactivations = (await audit()).filter((row) => row.action === "staff.reactivate");
    expect(reactivations).toMatchObject([{ target: "target", actorUid: "owner",
      before: { active: false, role: null, grants: [], staffStatus: "inactive" },
      after: { active: true, accessTier: "contributor", role: null, grants: [], staffStatus: "active" } }]);
    expect((await audit()).length).toBe(auditCount + 1);
  });

  it("leaves the record active with sign-in off when Auth fails, and a same-level retry finishes without a second audit", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    const authClient = fakeAuth({ enableFailure: Object.assign(new Error("provider-private-detail"), { code: "auth/internal-error" }) });
    const failed = await reactivate({ authClient });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).toMatchObject({ cmsAccessRestored: true });
    expect(JSON.stringify(failed.body)).not.toContain("provider-private-detail");
    expect(await stored()).toMatchObject({ active: true, accessTier: "contributor" });
    expect(authClient.user.disabled).toBe(true);

    expect((await reactivate({ authClient, body: { targetUid: "target", accessTier: "owner" } })).statusCode).toBe(409);
    const retryAuth = fakeAuth();
    const retried = await reactivate({ authClient: retryAuth });
    expect(retried.statusCode).toBe(200);
    expect(retried.body.alreadyActive).toBe(true);
    expect(retryAuth.user.disabled).toBe(false);
    expect((await audit()).filter((row) => row.action === "staff.reactivate")).toHaveLength(1);
  });

  it("refuses an account whose offboarding stopped before Auth was disabled", async () => {
    const offboarding = fakeAuth({ disabled: false });
    offboarding.updateUser.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "auth/internal-error" }));
    expect((await deactivate(offboarding)).statusCode).toBe(503);
    expect(await stored()).toMatchObject({ active: false });
    const authClient = fakeAuth({ disabled: false });
    expect((await reactivate({ authClient })).statusCode).toBe(409);
    expect(authClient.updateUser).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({ active: false });
    expect((await audit()).filter((row) => row.action === "staff.reactivate")).toEqual([]);
  });

  it("turns sign-in off again when a deactivation commits during the Auth step", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    const authClient = fakeAuth({ beforeEnable: () => ref("target").update({ active: false }) });
    const result = await reactivate({ authClient });
    expect(result.statusCode).toBe(409);
    expect(authClient.user.disabled).toBe(true);
    expect(authClient.revokeRefreshTokens).toHaveBeenCalledTimes(2);
  });

  it("removes navigation shares left from before offboarding", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    const share = db.collection("navigationShares").doc("share-1");
    await share.set({ ownerUid: "target", status: "active" });
    await db.collection("navigationShares").doc("other").set({ ownerUid: "someone", status: "active" });
    expect((await reactivate()).statusCode).toBe(200);
    expect((await share.get()).data()).toMatchObject({ status: "removed", removedReason: "owner_removed" });
    expect((await db.collection("navigationShares").doc("other").get()).data().status).toBe("active");
  });

  it("refuses a separately disabled active account that has no pending reactivation", async () => {
    await ref("target").set({ accessTier: "contributor", role: null, grants: [], active: true });
    const authClient = fakeAuth();
    expect((await reactivate({ authClient })).statusCode).toBe(409);
    expect(authClient.updateUser).not.toHaveBeenCalled();
    expect(await audit()).toEqual([]);
  });

  it("revokes sessions itself after an offboarding whose revocation failed", async () => {
    const offboarding = fakeAuth({ disabled: false });
    offboarding.revokeRefreshTokens.mockRejectedValueOnce(Object.assign(new Error("down"), { code: "auth/internal-error" }));
    expect((await deactivate(offboarding)).statusCode).toBe(503);
    expect(offboarding.user.disabled).toBe(true);
    expect((await reactivate({ authClient: offboarding })).statusCode).toBe(200);
    expect(offboarding.revokeRefreshTokens).toHaveBeenCalledTimes(2);
    expect(await stored()).toMatchObject({ active: true, tokensValidAfter: Date.parse(NOW) / 1000 });
  });

  it("lets a reactivation win over a delayed offboarding Auth step", async () => {
    const shared = fakeAuth({ disabled: false });
    const disable = shared.updateUser.getMockImplementation();
    shared.updateUser.mockImplementationOnce(async (uid, change) => {
      await disable(uid, change);
      expect((await reactivate({ authClient: shared })).statusCode).toBe(200);
    });
    const offboarding = await deactivate(shared);
    expect(offboarding.statusCode).toBe(409);
    expect(await stored()).toMatchObject({ active: true, accessTier: "contributor" });
    expect(shared.user.disabled).toBe(false);
  });

  it("reports an unconfirmed reactivation accurately and finishes it on retry", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    // The second transaction is the marker release after sign-in is enabled.
    let calls = 0;
    const firestore = { collection: db.collection.bind(db), runTransaction: (fn) => ++calls === 2
      ? Promise.reject(Object.assign(new Error("unavailable"), { code: 14 })) : db.runTransaction(fn) };
    const authClient = fakeAuth();
    const failed = await reactivate({ authClient, firestore });
    expect(failed.statusCode).toBe(503);
    expect(failed.body.error).toMatch(/may still be off/);
    expect(authClient.user.disabled).toBe(false);
    const retried = await reactivate({ authClient });
    expect(retried.statusCode).toBe(200);
    expect(retried.body.alreadyActive).toBe(true);
    expect((await db.collection("staffReactivations").doc("target").get()).exists).toBe(false);
    expect((await audit()).filter((row) => row.action === "staff.reactivate")).toHaveLength(1);
  });

  it("refuses a pending retry after the access level changed", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    const authClient = fakeAuth({ enableFailure: Object.assign(new Error("down"), { code: "auth/internal-error" }) });
    expect((await reactivate({ authClient, body: { targetUid: "target", accessTier: "viewer" } })).statusCode).toBe(503);
    await ref("target").update({ accessTier: "owner" });
    expect((await reactivate({ authClient: fakeAuth(), body: { targetUid: "target", accessTier: "viewer" } })).statusCode).toBe(409);
  });

  it("never moves the stored session watermark backward", async () => {
    await ref("target").update({ tokensValidAfter: Date.parse(NOW) / 1000 + 600 });
    expect((await deactivate(fakeAuth({ disabled: false }))).statusCode).toBe(200);
    expect((await stored()).tokensValidAfter).toBe(Date.parse(NOW) / 1000 + 600);
  });

  it("keeps a delayed offboarding withdrawal from undoing a reactivated linkage", async () => {
    await store.ensureAuthorIdentity({ firestore: db, uid: "target", nowIso: NOW, actorUid: "target", randomHex: "0".repeat(31) + "2" });
    const result = await store.withdrawProfileForDeactivation({ firestore: db, uid: "target", requireInactiveAccount: true,
      nowIso: NOW, actorUid: "owner" });
    expect(result).toMatchObject({ accountActive: true, linkageDeactivated: false });
    expect((await db.collection("cmsStaffRecords").doc("target").get()).data().status).toBe("active");
  });

  it("stores the newer watermark when a same-level retry revokes again", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    const first = fakeAuth({ enableFailure: Object.assign(new Error("down"), { code: "auth/internal-error" }) });
    expect((await reactivate({ authClient: first })).statusCode).toBe(503);
    const later = fakeAuth();
    later.revokeRefreshTokens.mockImplementation(async () => { later.user.tokensValidAfterTime = "2026-10-27T16:00:00.000Z"; });
    expect((await reactivate({ authClient: later })).statusCode).toBe(200);
    expect((await stored()).tokensValidAfter).toBe(Date.parse("2026-10-27T16:00:00.000Z") / 1000);
  });

  it("keeps a delayed offboarding withdrawal from taking down a republished profile", async () => {
    const { profile } = await store.ensureAuthorIdentity({ firestore: db, uid: "target", nowIso: NOW, actorUid: "target", randomHex: "0".repeat(31) + "3" });
    const result = await store.withdrawProfile({ firestore: db, authorId: profile.authorId, reason: "deactivation",
      enforceVersion: false, nowIso: NOW, actorUid: "owner", requireInactiveUid: "target" });
    expect(result.accountActive).toBe(true);
    expect((await db.collection("cmsAuthorProfiles").doc(profile.authorId).get()).data().visibility).toBe(profile.visibility);
  });

  it("restores sign-in when a stale offboarding fails after a newer reactivation", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    const authClient = fakeAuth({ disabled: false });
    authClient.revokeRefreshTokens.mockImplementationOnce(async () => {
      await ref("target").update({ active: true, accessTier: "viewer" });
      throw Object.assign(new Error("down"), { code: "auth/internal-error" });
    });
    await expect(authSync.syncStaffAuth({ firestore: db, authClient, uid: "target", now: () => NOW })).resolves.toBe(true);
    expect(authClient.user.disabled).toBe(false);
  });

  it("confirms the stored state after recovering from a failed revocation", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    const authClient = fakeAuth({ disabled: false });
    let flips = 0;
    authClient.revokeRefreshTokens.mockImplementation(async () => {
      // A reactivation commits, then a newer offboarding commits.
      if (flips++ === 0) {
        await ref("target").update({ active: true });
        throw Object.assign(new Error("down"), { code: "auth/internal-error" });
      }
    });
    const enable = authClient.updateUser.getMockImplementation();
    authClient.updateUser.mockImplementation(async (uid, change) => {
      await enable(uid, change);
      if (change.disabled === false && flips === 1) await ref("target").update({ active: false });
    });
    await expect(authSync.syncStaffAuth({ firestore: db, authClient, uid: "target", now: () => NOW })).resolves.toBe(false);
    expect(authClient.user.disabled).toBe(true);
  });

  it("refuses an active account with sign-in on", async () => {
    await ref("target").set({ accessTier: "contributor", role: null, grants: [], active: true });
    const authClient = fakeAuth({ disabled: false });
    expect((await reactivate({ authClient })).statusCode).toBe(409);
    expect(authClient.updateUser).not.toHaveBeenCalled();
    expect(await audit()).toEqual([]);
  });

  it("refuses a legacy account without an explicit active field", async () => {
    await ref("target").set({ role: "admin", grants: [] });
    expect((await reactivate()).statusCode).toBe(409);
    expect(await audit()).toEqual([]);
  });

  it("refuses self-reactivation before reading the identity", async () => {
    const authClient = fakeAuth();
    expect((await reactivate({ authClient, body: { targetUid: "owner", accessTier: "viewer" } })).statusCode).toBe(403);
    expect(authClient.getUser).not.toHaveBeenCalled();
    expect(await audit()).toEqual([]);
  });

  it.each([undefined, { ...activation, cleanScan: false }])("refuses before tier readers are activated %j", async (receipt) => {
    await ref("target").set({ active: false, role: null, grants: [] });
    if (receipt) await db.doc("system/staffAccessActivation").set(receipt);
    else await db.doc("system/staffAccessActivation").delete();
    const authClient = fakeAuth();
    expect((await reactivate({ authClient })).statusCode).toBe(409);
    expect(await stored()).toMatchObject({ active: false });
    expect(authClient.updateUser).not.toHaveBeenCalled();
    expect(await audit()).toEqual([]);
  });

  it.each([
    { role: "admin", active: true }, { accessTier: "admin", active: true },
    { accessTier: "owner", active: false }, { accessTier: "owner", active: "true" },
  ])("rechecks the current actor in the transaction: %j", async (profile) => {
    await ref("target").set({ active: false, role: null, grants: [] });
    await ref("owner").set(profile);
    const authClient = fakeAuth();
    expect((await reactivate({ authClient })).statusCode).toBe(403);
    expect(await stored()).toMatchObject({ active: false });
    expect(authClient.updateUser).not.toHaveBeenCalled();
  });

  it("refuses an unverified actor without looking up the target", async () => {
    const authClient = fakeAuth();
    expect((await reactivate({ authClient, actorValue: { ...actor, emailVerified: false } })).statusCode).toBe(403);
    expect(authClient.getUser).not.toHaveBeenCalled();
  });

  it("refuses an unverified or missing target identity and a missing profile", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    expect((await reactivate({ authClient: fakeAuth({ emailVerified: false }) })).statusCode).toBe(409);
    const missing = { getUser: vi.fn(async () => { throw Object.assign(new Error("gone"), { code: "auth/user-not-found" }); }), updateUser: vi.fn() };
    expect((await reactivate({ authClient: missing })).statusCode).toBe(404);
    await ref("target").delete();
    expect((await reactivate()).statusCode).toBe(404);
    expect(await audit()).toEqual([]);
  });

  it.each([
    { accessTier: "Owner" }, { accessTier: null }, { targetUid: "users/target" },
    { grants: [{ role: "editor" }] }, { restoreProfile: true },
  ])("refuses malformed requests %j", async (extra) => {
    expect((await reactivate({ body: { targetUid: "target", accessTier: "viewer", ...extra } })).statusCode).toBe(400);
  });

  it("allows one of two concurrent reactivations", async () => {
    await ref("target").set({ active: false, role: null, grants: [] });
    const results = await Promise.all(["viewer", "editor"].map((accessTier) =>
      reactivate({ body: { targetUid: "target", accessTier } })));
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect((await audit()).filter((row) => row.action === "staff.reactivate")).toHaveLength(1);
  });

  it("rejects GET and hides infrastructure errors", async () => {
    expect((await reactivate({ method: "GET" })).statusCode).toBe(405);
    const log = { error: vi.fn() };
    const result = await reactivate({ log, authClient: { getUser: async () => { throw new Error("provider-private-detail"); } } });
    expect(result.statusCode).toBe(500);
    expect(result.body.error).not.toContain("provider-private-detail");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("provider-private-detail");
  });
});
