import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteField, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

// The rules refuse a session 60 days after auth_time, so fixtures sign in recently.
const recentAuthTime = Math.floor(Date.now() / 1000) - 3600;

let environment;
const database = uid => environment.authenticatedContext(uid, { auth_time: recentAuthTime }).firestore();
// Cold rules initialization needs a bounded setup budget.
// loaded CI exceeded the default 10 s. Give only this startup hook 20 s.
beforeAll(async () => {
  environment = await initializeTestEnvironment({ projectId: "demo-home-shortcuts", firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST?.split(":").at(-1) ?? 8080),
    rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
}, 20_000);
afterAll(async () => { await environment?.cleanup(); });
beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context => {
    for (const [uid, role] of [["owner", null], ["other", null], ["admin", "admin"]]) {
      await setDoc(doc(context.firestore(), "users", uid), { role, grants: [{ role: "staff" }], preferences: { display: { controlPresentation: "text" } } });
    }
  });
});

describe("Home shortcut preferences", () => {
  it("lets the owner save and reset recognized unique IDs without changing other preferences", async () => {
    const reference = doc(database("owner"), "users/owner");
    await assertSucceeds(updateDoc(reference, { "preferences.homeShortcuts": ["media", "guide"] }));
    expect((await getDoc(reference)).data().preferences).toEqual({ display: { controlPresentation: "text" }, homeShortcuts: ["media", "guide"] });
    await assertSucceeds(updateDoc(reference, { "preferences.homeShortcuts": deleteField() }));
    expect((await getDoc(reference)).data().preferences).toEqual({ display: { controlPresentation: "text" } });
  });
  it.each([null, "media", ["https://example.test"], ["unknown"], ["guide", "guide"], ["media", "guide", "assigned"], { url: "/content" }])("rejects malformed or unrecognized preference %j", async value => {
    await assertFails(updateDoc(doc(database("owner"), "users/owner"), { "preferences.homeShortcuts": value }));
  });
  it.each(["other", "admin"])("denies %s changing another account's shortcuts", async uid => {
    await assertFails(updateDoc(doc(database(uid), "users/owner"), { "preferences.homeShortcuts": ["media", "guide"] }));
  });
  it("cannot change privileges or read protected content through a preference", async () => {
    const client = database("owner");
    await assertFails(updateDoc(doc(client, "users/owner"), { "preferences.homeShortcuts": ["recent-edits", "assigned"], role: "admin" }));
    await assertSucceeds(updateDoc(doc(client, "users/owner"), { "preferences.homeShortcuts": ["recent-edits", "assigned"] }));
    await assertFails(getDoc(doc(client, "cmsPosts/private-post")));
    expect((await getDoc(doc(client, "users/owner"))).data().role).toBeNull();
  });
});
