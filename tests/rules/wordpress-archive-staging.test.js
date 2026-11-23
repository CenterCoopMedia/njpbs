import { readFileSync } from "node:fs";
import { afterAll, beforeAll, it } from "vitest";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from "firebase/firestore";

const paths = ["wordpressArchiveItems/synthetic", "wordpressArchiveItems/synthetic/archiveImportReceipts/staged"];
let environment;

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!/^127\.0\.0\.1:\d+$/.test(host ?? "")) throw new Error("Use the local Firestore emulator.");
  environment = await initializeTestEnvironment({ projectId: "demo-wordpress-archive-rules", firestore: {
    host: "127.0.0.1", port: Number(host.split(":").at(-1)),
    rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
  await environment.withSecurityRulesDisabled(async context => {
    for (const path of paths) await setDoc(doc(context.firestore(), path), { version: 1 });
    await setDoc(doc(context.firestore(), "users", "admin"), { role: "super_admin", active: true, tokensValidAfter: 0 });
  });
}, 20_000);

afterAll(async () => environment?.cleanup());

it.each(["anonymous", "admin"])("denies direct staging and receipt access for %s", async role => {
  const database = role === "anonymous" ? environment.unauthenticatedContext().firestore() :
    environment.authenticatedContext(role, { auth_time: Math.floor(Date.now() / 1000) - 60 }).firestore();
  for (const path of paths) {
    const ref = doc(database, path);
    await assertFails(getDoc(ref));
    await assertFails(getDocs(collection(database, ref.parent.path)));
    await assertFails(setDoc(ref, { version: 2 }));
    await assertFails(deleteDoc(ref));
  }
});
