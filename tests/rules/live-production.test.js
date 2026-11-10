import { readFileSync } from "node:fs";
import { afterAll, beforeAll, it } from "vitest";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { LIVE_PRODUCTION_COLLECTION } from "../../packages/content-core/src/live-production";

// The rules refuse a session 60 days after auth_time, so fixtures sign in recently.
const recentAuthTime = Math.floor(Date.now() / 1000) - 3600;

let environment;
const paths = [
  `${LIVE_PRODUCTION_COLLECTION}/fixture-session`,
  `${LIVE_PRODUCTION_COLLECTION}/fixture-session/banners/fixture-banner`,
  `${LIVE_PRODUCTION_COLLECTION}/fixture-session/mappings/3`,
  `${LIVE_PRODUCTION_COLLECTION}/fixture-session/commands/fixture-command`,
  `${LIVE_PRODUCTION_COLLECTION}/fixture-session/commands/fixture-command/receipts/fixture-receipt`,
  `${LIVE_PRODUCTION_COLLECTION}/fixture-session/observations/7`,
  `${LIVE_PRODUCTION_COLLECTION}/fixture-session/audit/fixture-event`,
];

beforeAll(async () => {
  environment = await initializeTestEnvironment({ projectId: "demo-live-production", firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST?.split(":").at(-1) ?? 18080),
    rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
  await environment.withSecurityRulesDisabled(async context => {
    for (const path of paths) await setDoc(doc(context.firestore(), path), { private: "Synthetic studio text" });
    for (const role of ["staff", "admin", "super_admin"]) await setDoc(doc(context.firestore(), "users", `fixture-${role}`), {
      role, active: true, tokensValidAfter: 0, grants: [{ role: "editor" }],
    });
  });
}, 20_000);
afterAll(async () => { await environment?.cleanup(); });

it.each(["anonymous", "staff", "admin", "super_admin"])("keeps every production path server-only for %s", async role => {
  const database = role === "anonymous" ? environment.unauthenticatedContext().firestore()
    : environment.authenticatedContext(`fixture-${role}`, { auth_time: recentAuthTime }).firestore();
  for (const path of paths) {
    const reference = doc(database, path);
    await assertFails(getDoc(reference));
    await assertFails(getDocs(collection(database, path.split("/").slice(0, -1).join("/"))));
    await assertFails(setDoc(doc(database, `${path}-new`), { private: "New synthetic text" }));
    await assertFails(updateDoc(reference, { private: "Changed synthetic text" }));
    await assertFails(deleteDoc(reference));
  }
});
