import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import admin from "../helpers/firebase-admin.js";
import principal from "../../functions/lib/principal.js";
import activation from "../../functions/lib/access-tier-activation.js";
import { activateStaffTierReaders, inspectStaffTierReaders, scanUsersForExistingTiers, verifyProtectedLiveRules } from "../../scripts/activate-staff-tier-readers.mjs";

let database;
const host = process.env.FIRESTORE_EMULATOR_HOST;
const receipt = { schema: 1, state: "active", cleanScan: true };
const expectedRules = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
const rulesOptions = {
  projectId: "demo-njpbs", expectedRules,
  credential: { getAccessToken: async () => ({ access_token: "synthetic-token" }) },
  fetchFn: async url => new Response(JSON.stringify(url.includes("/releases/")
    ? { rulesetName: "projects/demo-njpbs/rulesets/protected" }
    : { source: { files: [{ name: "firestore.rules", content: expectedRules }] } }), { status: 200 }),
};
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(host ?? "")) throw new Error("Local Firestore emulator required");
  if (!admin.apps.length) admin.initializeApp({ projectId: "demo-njpbs" });
  database = isolatedFirestore("access-tier-activation.test.js");
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, database);
});
describe("server-only tier reader activation", () => {
  it("the read-only operator performs the full scan and rules fence without creating activation evidence", async () => {
    await database.doc("users/legacy").set({ role: "admin" });
    const result = await inspectStaffTierReaders({ firestore: database, ...rulesOptions });
    expect(result).toMatchObject({ ready: true, complete: true, scannedUsers: 1, documentIds: [], rulesetName: "projects/demo-njpbs/rulesets/protected" });
    expect((await database.doc(activation.ACCESS_TIER_ACTIVATION_PATH).get()).exists).toBe(false);
    expect((await database.doc("users/legacy").get()).data()).toEqual({ role: "admin" });
  });
  it("a planted tier cannot increase or remove legacy authority without the receipt", async () => {
    for (const profile of [
      { accessTier: "owner", grants: [{ role: "staff" }] },
      { accessTier: "viewer", role: "super_admin" },
      { accessTier: null, role: "admin" },
    ]) {
      const legacy = { ...profile };
      delete legacy.accessTier;
      expect(await principal.principalFromStoredUserDoc(database, "fixture", profile)).toEqual(principal.principalFromUserDoc("fixture", legacy));
    }
    for (const invalid of [{ ...receipt, schema: 2 }, { ...receipt, cleanScan: false }, { ...receipt, state: "pending" }]) {
      await database.doc(activation.ACCESS_TIER_ACTIVATION_PATH).set(invalid);
      expect(await principal.administrativeRoleFromStoredUserDoc(database, { accessTier: "owner", grants: [{ role: "staff" }] })).toBeNull();
    }
  });
  it("a valid receipt enables tier authority and invalid tiers lose stale roles", async () => {
    await database.doc(activation.ACCESS_TIER_ACTIVATION_PATH).set(receipt);
    expect(await principal.administrativeRoleFromStoredUserDoc(database, { accessTier: "owner" })).toBe("super_admin");
    expect(await principal.administrativeRoleFromStoredUserDoc(database, { accessTier: "viewer", role: "super_admin" })).toBeNull();
    expect(await principal.principalFromStoredUserDoc(database, "fixture", { accessTier: "invalid", role: "super_admin" })).toEqual({ id: "fixture", grants: [] });
  });
  it("reports ids only and does not change a document that has the field", async () => {
    const profile = { accessTier: null, email: "private@example.test", displayName: "Private fixture" };
    await database.doc("users/field-present").set(profile);
    const result = await activateStaffTierReaders({ firestore: database, ...rulesOptions });
    expect(result).toEqual({ activated: false, complete: true, scannedUsers: 1, documentIds: ["field-present"] });
    expect((await database.doc("users/field-present").get()).data()).toEqual(profile);
    expect((await database.doc(activation.ACCESS_TIER_ACTIVATION_PATH).get()).exists).toBe(false);
  });
  it("a scan ceiling fails closed rather than activating from a partial page", async () => {
    const batch = database.batch();
    for (let index = 0; index < 201; index++) batch.set(database.doc(`users/fixture-${String(index).padStart(3, "0")}`), { role: null });
    await batch.commit();
    const result = await scanUsersForExistingTiers(database, 200);
    expect(result).toEqual({ complete: false, scannedUsers: 201, documentIds: [] });
    expect((await database.doc(activation.ACCESS_TIER_ACTIVATION_PATH).get()).exists).toBe(false);
  });
  it("a complete clean scan creates the evidence once and later tier writes do not require another scan", async () => {
    await database.doc("users/legacy").set({ role: "admin", email: "private@example.test" });
    expect(await activateStaffTierReaders({ firestore: database, ...rulesOptions }))
      .toEqual({ activated: true, complete: true, scannedUsers: 1, documentIds: [] });
    const stored = (await database.doc(activation.ACCESS_TIER_ACTIVATION_PATH).get()).data();
    expect(activation.validAccessTierActivation(stored)).toBe(true);
    await database.doc("users/legacy").update({ accessTier: "viewer" });
    await expect(activateStaffTierReaders({ firestore: database, ...rulesOptions })).rejects.toThrow("already exists");
    expect((await database.doc(activation.ACCESS_TIER_ACTIVATION_PATH).get()).data()).toEqual(stored);
    expect(await principal.administrativeRoleFromStoredUserDoc(database, (await database.doc("users/legacy").get()).data())).toBeNull();
  });
  it("a live rules change during the scan leaves activation absent", async () => {
    let request = 0;
    await expect(activateStaffTierReaders({ firestore: database,
      ...rulesOptions, fetchFn: async url => new Response(JSON.stringify(url.includes("/releases/")
        ? { rulesetName: `projects/demo-njpbs/rulesets/${request++}` }
        : { source: { files: [{ content: expectedRules }] } }), { status: 200 }) }))
      .rejects.toThrow("changed during the scan");
    expect((await database.doc(activation.ACCESS_TIER_ACTIVATION_PATH).get()).exists).toBe(false);
  });
  it("checks the deployed release source against the reviewed protection", async () => {
    const expectedRules = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
    const rulesetName = "projects/demo-njpbs/rulesets/protected";
    const credential = { getAccessToken: async () => ({ access_token: "synthetic-token" }) };
    const fetchRules = content => async url => new Response(JSON.stringify(url.includes("/releases/")
      ? { rulesetName } : { source: { files: [{ name: "firestore.rules", content }] } }), { status: 200 });
    await expect(verifyProtectedLiveRules({ projectId: "demo-njpbs", credential, expectedRules, fetchFn: fetchRules(expectedRules) }))
      .resolves.toMatchObject({ rulesetName });
    await expect(verifyProtectedLiveRules({ projectId: "demo-njpbs", credential, expectedRules, fetchFn: fetchRules(expectedRules.replace(", 'accessTier'", "")) }))
      .rejects.toThrow("differ from the reviewed protected checkout");
    await expect(verifyProtectedLiveRules({ projectId: "demo-njpbs", credential, expectedRules: "unprotected" }))
      .rejects.toThrow("does not contain access tier field protection");
  });
});
