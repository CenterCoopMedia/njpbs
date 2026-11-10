import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import {
  collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, updateDoc,
} from "firebase/firestore";

// The rules refuse a session 60 days after auth_time, so fixtures sign in recently.
const recentAuthTime = Math.floor(Date.now() / 1000) - 3600;

// The marker switches on the automation lock and version rules (#4717). If any client could
// remove it, an agent account could turn those rules off for itself.
let environment;
const roles = ["staff", "editor", "admin", "super_admin", "agent"];
beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the real Firestore rules emulator.");
  environment = await initializeTestEnvironment({ projectId: "demo-automation-rules", firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)),
    rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "cmsAutomationAccounts", "agent"), { label: "Synthetic agent" });
    for (const role of roles) {
      await setDoc(doc(context.firestore(), "users", role), {
        role: role === "agent" ? "editor" : role, active: true, tokensValidAfter: 0,
      });
    }
  });
}, 20_000);
afterAll(async () => environment?.cleanup());
it.each(["anonymous", ...roles])("refuses every direct automation marker read and write for %s", async role => {
  const database = role === "anonymous" ? environment.unauthenticatedContext().firestore()
    : environment.authenticatedContext(role, { auth_time: recentAuthTime, email_verified: true }).firestore();
  const marker = doc(database, "cmsAutomationAccounts", "agent");
  await assertFails(getDoc(marker));
  await assertFails(getDocs(collection(database, "cmsAutomationAccounts")));
  await assertFails(updateDoc(marker, { label: "changed" }));
  await assertFails(deleteDoc(marker));
  await assertFails(setDoc(doc(database, "cmsAutomationAccounts", role), { label: "forged" }));
});

// A forced takeover replaces a person's live lease, and that lease is what automationWriteRefusal
// trusts. A marked account must never force one, whichever path gave it site-wide authority.
describe("forced editing lease takeover", () => {
  const lockPath = "cmsEditorLocks/cmsPages:lease-page";
  const address = { surfaceKey: "cmsPages:lease-page", contentCollection: "cmsPages", contentId: "lease-page" };
  const personSession = "person-session-0123456789";
  const staffContext = uid => environment.authenticatedContext(uid, { auth_time: recentAuthTime, email_verified: true }).firestore();
  const claim = (uid, force = false) => ({
    ...address, ownerId: uid, ownerName: uid, sessionId: `${uid}-session-0123456789`,
    acquiredAt: serverTimestamp(), heartbeatAt: serverTimestamp(),
    ...(force ? { takeoverAt: serverTimestamp() } : {}),
  });

  async function seed({ marked, profile, holder = "person", ageMs = 1_000, tiersActive = false }) {
    await environment.withSecurityRulesDisabled(async context => {
      const database = context.firestore();
      const heartbeat = Timestamp.fromMillis(Date.now() - ageMs);
      await setDoc(doc(database, "users/actor"), { active: true, tokensValidAfter: 0, ...profile });
      await setDoc(doc(database, "cmsPages/lease-page"), { createdBy: "person" });
      await setDoc(doc(database, lockPath), {
        ...address, ownerId: holder, ownerName: holder, sessionId: personSession,
        acquiredAt: heartbeat, heartbeatAt: heartbeat,
      });
      const marker = doc(database, "cmsAutomationAccounts/actor");
      await (marked ? setDoc(marker, { label: "Synthetic agent" }) : deleteDoc(marker));
      const activation = doc(database, "system/staffAccessActivation");
      await (tiersActive
        ? setDoc(activation, { schema: 1, state: "active", cleanScan: true })
        : deleteDoc(activation));
    });
  }

  async function storedOwner() {
    let ownerId;
    await environment.withSecurityRulesDisabled(async context => {
      ownerId = (await getDoc(doc(context.firestore(), lockPath))).data().ownerId;
    });
    return ownerId;
  }

  const authorities = [
    ["an editor grant", { role: "staff", grants: [{ role: "editor" }] }, false],
    ["an administrator role", { role: "super_admin" }, false],
    ["a publisher tier", { accessTier: "publisher" }, true],
  ];

  it.each(authorities)("refuses a marked account with %s", async (_label, profile, tiersActive) => {
    await seed({ marked: true, profile, tiersActive });
    await assertFails(setDoc(doc(staffContext("actor"), lockPath), claim("actor", true)));
    expect(await storedOwner()).toBe("person");
  });

  it.each(authorities)("keeps a forced takeover for staff with %s", async (_label, profile, tiersActive) => {
    await seed({ marked: false, profile, tiersActive });
    await assertSucceeds(setDoc(doc(staffContext("actor"), lockPath), claim("actor", true)));
    expect(await storedOwner()).toBe("actor");
  });

  it("lets a marked account replace its own live lease", async () => {
    await seed({ marked: true, profile: { role: "staff", grants: [{ role: "editor" }] }, holder: "actor" });
    await assertSucceeds(setDoc(doc(staffContext("actor"), lockPath), claim("actor", true)));
  });

  it("lets a marked account claim an expired lease without forcing it", async () => {
    await seed({ marked: true, profile: { role: "staff", grants: [{ role: "editor" }] }, ageMs: 121_000 });
    await assertSucceeds(setDoc(doc(staffContext("actor"), lockPath), claim("actor")));
    expect(await storedOwner()).toBe("actor");
  });
});
