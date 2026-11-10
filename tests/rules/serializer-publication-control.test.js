import { readFileSync } from "node:fs";
import { afterAll, beforeAll, it } from "vitest";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
let environment;
beforeAll(async () => {
  environment = await initializeTestEnvironment({ projectId: "demo-serializer-control", firestore: {
    host: "127.0.0.1", port: Number(process.env.FIRESTORE_EMULATOR_HOST?.split(":").at(-1) ?? 8080),
    rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
  } });
}, 20_000);
afterAll(async () => { await environment?.cleanup(); });
it.each(["staff", "admin", "super_admin"])("denies serializer control writes by %s clients", async role => {
  const uid = `fixture-${role}`;
  await environment.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), "users", uid), {
    role, grants: [{ role }],
  }));
  const database = environment.authenticatedContext(uid, { role }).firestore();
  await assertFails(setDoc(doc(database, "system/publicDeployment/controls/serializer"), { schemaVersion: 1, enabled: false }));
});
