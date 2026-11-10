import { readFileSync } from "node:fs";
import { afterAll, beforeAll, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteField, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

let environment;
const collections = ["cmsUsageEvents", "cmsUsagePresence", "cmsUsageDaily", "cmsUsageWeekly"];
beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the real Firestore rules emulator.");
  environment = await initializeTestEnvironment({ projectId: "demo-boardwalk-usage-rules", firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)),
    rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
  await environment.withSecurityRulesDisabled(async context => {
    for (const name of collections) await setDoc(doc(context.firestore(), name, "private-row"), { uid: "staff-1" });
    for (const role of ["staff", "admin", "super_admin"]) await setDoc(doc(context.firestore(), "users", role), { role, active: true });
  });
});

it.each(["staff", "admin", "super_admin"])("keeps usage exclusions server-only for %s", async role => {
  const database = environment.authenticatedContext(role, { auth_time: Math.floor(Date.now() / 1000), email_verified: true }).firestore();
  const profile = doc(database, "users", role);
  await assertSucceeds(updateDoc(profile, { displayName: "Staff name" }));
  await assertFails(updateDoc(profile, { usageAnalyticsExcluded: true }));
  await assertFails(setDoc(doc(database, "users", `${role}-forged`), { usageAnalyticsExcluded: true }));
  await environment.withSecurityRulesDisabled(context =>
    updateDoc(doc(context.firestore(), "users", role), { usageAnalyticsExcluded: true }));
  await assertFails(updateDoc(profile, { usageAnalyticsExcluded: false }));
  await assertFails(updateDoc(profile, { usageAnalyticsExcluded: deleteField() }));
  await assertSucceeds(updateDoc(profile, { displayName: "Updated name" }));
});
afterAll(async () => environment?.cleanup());

it.each(["anonymous", "staff", "admin", "super_admin"])("refuses direct usage reads and writes even for %s", async role => {
  const database = role === "anonymous" ? environment.unauthenticatedContext().firestore()
    : environment.authenticatedContext(role, { auth_time: Math.floor(Date.now() / 1000), email_verified: true }).firestore();
  for (const name of collections) {
    await assertFails(getDoc(doc(database, name, "private-row")));
    await assertFails(getDocs(collection(database, name)));
    await assertFails(setDoc(doc(database, name, "forged"), { uid: "forged" }));
  }
});
