import { readFileSync } from "node:fs";
import { afterAll, beforeAll, it } from "vitest";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

// The rules refuse a session 60 days after auth_time, so fixtures sign in recently.
const recentAuthTime = Math.floor(Date.now() / 1000) - 3600;

let environment;
const paths = ["cmsDatasetUses/synthetic-use", "cmsDatasetRefreshJobs/synthetic-job", "cmsDatasetRefreshJobs/synthetic-job/owners/synthetic-owner", "cmsDatasets/synthetic", "cmsDatasets/synthetic/releases/september",
  "cmsDatasets/synthetic/releases/september/revisions/1", "cmsDatasets/synthetic/requests/synthetic-request"];
beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Use the real Firestore rules emulator.");
  environment = await initializeTestEnvironment({ projectId: "demo-datasets-rules", firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(":").at(-1)),
    rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
  await environment.withSecurityRulesDisabled(async context => {
    for (const path of paths) await setDoc(doc(context.firestore(), path), { private: "Synthetic rights evidence" });
    for (const role of ["staff", "contributor", "editor", "admin", "super_admin"]) await setDoc(doc(context.firestore(), "users", role), { role, active: true, tokensValidAfter: 0 });
  });
}, 20_000);
afterAll(async () => environment?.cleanup());
it.each(["anonymous", "staff", "contributor", "editor", "admin", "super_admin"])("refuses every direct dataset read and write for %s", async role => {
  const database = role === "anonymous" ? environment.unauthenticatedContext().firestore()
    : environment.authenticatedContext(role, { auth_time: recentAuthTime }).firestore();
  for (const path of paths) {
    const reference = doc(database, path);
    await assertFails(getDoc(reference));
    await assertFails(getDocs(collection(database, path.split("/").slice(0, -1).join("/"))));
    await assertFails(setDoc(doc(database, `${path}-new`), { forged: true }));
    await assertFails(updateDoc(reference, { forged: true }));
    await assertFails(deleteDoc(reference));
  }
});
