import { readFileSync } from "node:fs";
import { afterAll, beforeAll, it } from "vitest";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

// The rules refuse a session 60 days after auth_time, so fixtures sign in recently.
const recentAuthTime = Math.floor(Date.now() / 1000) - 3600;

let environment;
const paths = ["cmsElectionResultConnections/synthetic", "cmsElectionResultConnections/synthetic/publications/1",
  "cmsElectionResultConnections/synthetic/configurations/1", "cmsElectionResultEditorialOwners/synthetic"];
beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use the real local Firestore emulator.");
  environment = await initializeTestEnvironment({ projectId: "demo-election-source-rules", firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)),
    rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
  await environment.withSecurityRulesDisabled(async context => {
    for (const path of paths) await setDoc(doc(context.firestore(), path), { lastGoodDigest: "synthetic", paused: false });
    for (const role of ["staff", "contributor", "editor", "admin", "super_admin"]) {
      await setDoc(doc(context.firestore(), "users", role), { role, active: true, tokensValidAfter: 0 });
    }
  });
}, 20_000);
afterAll(async () => environment?.cleanup());
it.each(["anonymous", "staff", "contributor", "editor", "admin", "super_admin"])("refuses direct connection reads and writes for %s", async role => {
  const database = role === "anonymous" ? environment.unauthenticatedContext().firestore()
    : environment.authenticatedContext(role, { auth_time: recentAuthTime }).firestore();
  for (const path of paths) {
    const reference = doc(database, path);
    await assertFails(getDoc(reference));
    await assertFails(getDocs(collection(database, path.split("/").slice(0, -1).join("/"))));
    await assertFails(setDoc(doc(database, `${path}-new`), { forged: true }));
    await assertFails(updateDoc(reference, { paused: false, lastGoodDigest: "forged" }));
    await assertFails(deleteDoc(reference));
  }
});
