import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteField, doc, setDoc, updateDoc } from "firebase/firestore";

// The rules refuse a session 60 days after auth_time, so fixtures sign in recently.
const recentAuthTime = Math.floor(Date.now() / 1000) - 3600;

let environment;
beforeAll(async () => {
  const port = Number(process.env.FIRESTORE_EMULATOR_HOST?.split(":").at(-1));
  if (!Number.isInteger(port)) throw new Error("Local Firestore emulator required");
  environment = await initializeTestEnvironment({ projectId: "demo-access-tier-protection", firestore: {
    host: "127.0.0.1", port, rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
}, 20_000);
afterAll(async () => { await environment?.cleanup(); });
beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "system/staffAccessActivation"), { schema: 1, state: "active", cleanScan: true });
    await setDoc(doc(db, "users/staff"), { active: true, accessTier: "viewer" });
    await setDoc(doc(db, "users/admin"), { active: true, accessTier: "admin" });
    await setDoc(doc(db, "users/untiered"), { active: true });
  });
});
function profile(actor, target) {
  return doc(environment.authenticatedContext(actor, { auth_time: recentAuthTime, email_verified: true }).firestore(), `users/${target}`);
}
describe("server-owned access tier", () => {
  it.each([["staff", "staff"], ["admin", "staff"]])("%s cannot plant a tier on %s", async (actor, target) => {
    await assertFails(updateDoc(profile(actor, target), { accessTier: "owner" }));
    await assertSucceeds(updateDoc(profile(actor, target), { displayName: "Fixture staff" }));
  });
  it("admin cannot plant a tier on a profile without one", async () => {
    await assertFails(updateDoc(profile("admin", "untiered"), { accessTier: "viewer" }));
    await assertFails(updateDoc(profile("admin", "untiered"), { accessTier: "owner", displayName: "Fixture staff" }));
    await assertSucceeds(updateDoc(profile("admin", "untiered"), { displayName: "Fixture staff" }));
  });
  it.each([["staff", "staff"], ["admin", "staff"]])("%s cannot replace or delete the protected tier on %s", async (actor, target) => {
    await assertSucceeds(updateDoc(profile(actor, target), { displayName: "Fixture staff" }));
    await assertFails(updateDoc(profile(actor, target), { accessTier: "owner" }));
    await assertFails(updateDoc(profile(actor, target), { accessTier: deleteField() }));
  });
  it.each([["staff", "staff"], ["admin", "staff"]])("%s can only touch client-owned profile keys on %s", async (actor, target) => {
    await environment.withSecurityRulesDisabled(context => updateDoc(doc(context.firestore(), `users/${target}`), { serverOwned: "stored" }));
    await assertFails(updateDoc(profile(actor, target), { newServerField: "planted" }));
    await assertFails(updateDoc(profile(actor, target), { serverOwned: "changed" }));
    await assertFails(updateDoc(profile(actor, target), { serverOwned: deleteField() }));
    await assertFails(updateDoc(profile(actor, target), { displayName: "Fixture staff", newServerField: "planted" }));
    await assertSucceeds(updateDoc(profile(actor, target), { displayName: "Fixture staff", jobTitle: "Producer" }));
    await assertSucceeds(updateDoc(profile(actor, target), { "preferences.display.controlPresentation": "icons" }));
  });
});
