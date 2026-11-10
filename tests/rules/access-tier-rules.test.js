import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, deleteField, doc, getDoc, serverTimestamp, setDoc, Timestamp, updateDoc } from "firebase/firestore";

// The rules refuse a session 60 days after auth_time, so fixtures sign in recently.
const recentAuthTime = Math.floor(Date.now() / 1000) - 3600;

let environment;
const tiers = ["viewer", "contributor", "editor", "publisher", "admin", "owner"];
const port = Number(process.env.FIRESTORE_EMULATOR_HOST?.split(":").at(-1));
beforeAll(async () => {
  if (!Number.isInteger(port)) throw new Error("Local Firestore emulator required");
  environment = await initializeTestEnvironment({ projectId: "demo-access-tier-rules", firestore: {
    host: "127.0.0.1", port, rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
}, 20000);
afterAll(async () => { await environment?.cleanup(); });
beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const database = context.firestore();
    await setDoc(doc(database, "system/staffAccessActivation"), { schema: 1, state: "active", cleanScan: true });
    for (const tier of tiers) await setDoc(doc(database, `users/${tier}`), { accessTier: tier, role: "super_admin", grants: [{ role: "editor" }], active: true, displayName: tier });
    await setDoc(doc(database, "users/invalid"), { accessTier: "not-a-tier", role: "super_admin", grants: [{ role: "editor" }], active: true });
    await setDoc(doc(database, "users/other"), { role: null, active: true });
    await setDoc(doc(database, "admin_logs/receipt"), { action: "roles.set_tier" });
  });
});
function database(uid, verified = true) {
  return environment.authenticatedContext(uid, { auth_time: recentAuthTime, email_verified: verified }).firestore();
}
const leasePath = "cmsEditorLocks/cmsPages:home";
const leaseAddress = { surfaceKey: "cmsPages:home", contentCollection: "cmsPages", contentId: "home" };
const leaseSession = "11111111-1111-4111-8111-111111111111";
function leaseClaim(uid, force = false) {
  return { ...leaseAddress, ownerId: uid, ownerName: uid, sessionId: leaseSession,
    acquiredAt: serverTimestamp(), heartbeatAt: serverTimestamp(),
    ...(force ? { takeoverAt: serverTimestamp() } : {}) };
}
async function seedLeaseContent(ownerId, holderId = null) {
  await environment.withSecurityRulesDisabled(async (context) => {
    const client = context.firestore();
    await setDoc(doc(client, "cmsPages/home"), { createdBy: ownerId });
    if (holderId) await setDoc(doc(client, leasePath), {
      ...leaseClaim(holderId), acquiredAt: Timestamp.now(), heartbeatAt: Timestamp.now(),
    });
  });
}
describe("authoritative tier rules", () => {
  it("a planted Owner or demotion field has no authority before activation", async () => {
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await deleteDoc(doc(db, "system/staffAccessActivation"));
      await setDoc(doc(db, "users/planted-owner"), { accessTier: "owner", role: null, active: true, grants: [{ role: "staff" }] });
      await setDoc(doc(db, "users/planted-demotion"), { accessTier: "viewer", role: "super_admin", active: true });
    });
    await assertFails(getDoc(doc(database("planted-owner"), "users/other")));
    await assertSucceeds(getDoc(doc(database("planted-demotion"), "users/other")));
    await assertSucceeds(getDoc(doc(database("planted-owner"), "users/planted-owner")));
  });
  it.each(tiers)("%s cannot write activation evidence", async tier => {
    await assertFails(setDoc(doc(database(tier), "system/staffAccessActivation"), { schema: 1, state: "active", cleanScan: true }));
  });
  it.each(tiers)("%s can read own profile, and only Admin/Owner can read the roster and audit", async (tier) => {
    const client = database(tier);
    await assertSucceeds(getDoc(doc(client, `users/${tier}`)));
    const check = ["admin", "owner"].includes(tier) ? assertSucceeds : assertFails;
    await check(getDoc(doc(client, "users/other")));
    await check(getDoc(doc(client, "admin_logs/receipt")));
  });
  it.each(tiers)("%s cannot add, replace or remove its own privilege field", async (tier) => {
    const ref = doc(database(tier), `users/${tier}`);
    await assertFails(updateDoc(ref, { accessTier: tier === "owner" ? "viewer" : "owner" }));
    await assertFails(updateDoc(ref, { accessTier: deleteField() }));
    await assertFails(updateDoc(ref, { grants: [{ role: "owner" }] }));
  });
  it("a malformed tier cannot recover stale Owner authority", async () => {
    await assertFails(getDoc(doc(database("invalid"), "users/other")));
    await assertFails(getDoc(doc(database("invalid"), "admin_logs/receipt")));
  });
  it.each([["invalid", "not-a-tier"], ["null-tier", null]])("an active, verified %s profile has no direct staff reads", async (uid, tier) => {
    await environment.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), `users/${uid}`),
      { accessTier: tier, role: "super_admin", grants: [{ role: "editor" }], active: true }));
    for (const path of ["sections/news", "navigationShares/example", "cmsBylineDirectory/example", "system/billing"]) {
      await assertSucceeds(getDoc(doc(database("viewer"), path)));
      await assertFails(getDoc(doc(database(uid), path)));
    }
  });
  it.each(tiers)("an unverified %s session has no direct staff reads", async (tier) => {
    await assertFails(getDoc(doc(database(tier, false), `users/${tier}`)));
  });
  it("receipt and nudge records remain server-only even for Owner", async () => {
    const client = database("owner");
    for (const path of ["accessTierMutationReceipts/example", "bugReportNudges/example", "bugReportFollowupOutbox/example"]) {
      await assertFails(getDoc(doc(client, path)));
      await assertFails(setDoc(doc(client, path), { state: "queued" }));
    }
  });
  it.each(["editor", "publisher", "admin", "owner"])("%s with no legacy grants can claim, heartbeat, release and force a lease", async (tier) => {
    await environment.withSecurityRulesDisabled(context =>
      setDoc(doc(context.firestore(), `users/${tier}`), { accessTier: tier, role: null, grants: [], active: true }));
    await seedLeaseContent("other");
    const lease = doc(database(tier), leasePath);
    await assertSucceeds(getDoc(lease));
    await assertSucceeds(setDoc(lease, leaseClaim(tier)));
    await assertSucceeds(updateDoc(lease, { heartbeatAt: serverTimestamp() }));
    await assertSucceeds(setDoc(lease, { ...leaseAddress, ownerId: tier, sessionId: leaseSession, releasedAt: serverTimestamp() }));
    await seedLeaseContent("other", "other");
    await assertSucceeds(setDoc(lease, leaseClaim(tier, true)));
  });
  it("Contributor with no legacy grants can use an owned lease but cannot force or use another person's record", async () => {
    await environment.withSecurityRulesDisabled(context =>
      setDoc(doc(context.firestore(), "users/contributor"), { accessTier: "contributor", role: null, grants: [], active: true }));
    await seedLeaseContent("contributor");
    const lease = doc(database("contributor"), leasePath);
    await assertSucceeds(setDoc(lease, leaseClaim("contributor")));
    await assertSucceeds(getDoc(lease));
    await assertSucceeds(updateDoc(lease, { heartbeatAt: serverTimestamp() }));
    await assertSucceeds(setDoc(lease, { ...leaseAddress, ownerId: "contributor", sessionId: leaseSession, releasedAt: serverTimestamp() }));
    await seedLeaseContent("contributor", "other");
    await assertFails(setDoc(lease, leaseClaim("contributor", true)));
    await seedLeaseContent("other", "other");
    await assertFails(getDoc(lease));
    await assertFails(setDoc(lease, leaseClaim("contributor", true)));
  });
  it.each(["viewer", "invalid"])("%s cannot recover stale Owner/editor lease authority", async (uid) => {
    await seedLeaseContent(uid);
    const lease = doc(database(uid), leasePath);
    await assertFails(getDoc(lease));
    await assertFails(setDoc(lease, leaseClaim(uid)));
    await seedLeaseContent(uid, "other");
    await assertFails(setDoc(lease, leaseClaim(uid, true)));
    await seedLeaseContent(uid, uid);
    await assertFails(setDoc(lease, { ...leaseAddress, ownerId: uid, sessionId: leaseSession, releasedAt: serverTimestamp() }));
  });
  it.each(tiers)("unverified %s cannot claim a lease", async (tier) => {
    await seedLeaseContent(tier);
    await assertFails(setDoc(doc(database(tier, false), leasePath), leaseClaim(tier)));
  });
});
