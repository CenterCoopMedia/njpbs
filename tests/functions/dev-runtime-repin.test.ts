import { afterAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import owner from "../../scripts/lib/dev-runtime-repin.cjs";
import pointers from "../../functions/lib/public-deployment-pointer.js";
import { parseRepinArguments } from "../../scripts/repin-dev-runtime.mjs";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "dev-runtime-repin-test");
const other = initializeApp({ projectId: "njpbs-site" }, "dev-runtime-repin-production-test");
const db = getFirestore(app);
const from = "a".repeat(40), to = "b".repeat(40);
const runtime = (commitSha = from, phase = "ready") => ({ schemaVersion: 1, phase, commitSha, serializerId: "original-dev-primary",
  cloud: { phase, commitSha, serializerId: "cloudflare-dev-publisher" } });
const pointer = (overrides = {}) => ({ ...pointers.initialPublicDeploymentPointer(), mediaLifecycleReady: true, activeGeneration: 7,
  activeDeploymentId: "33333333-3333-4333-8333-333333333333", activeCommitSha: to, lastReservedGeneration: 7,
  newestEligibleGeneration: 7, newestEligibleBuildBatchId: "cms-00b992b0f89f15397c5a", ...overrides });
const capability = (rendererSha = to) => ({ schemaVersion: 1, rendererSha, generation: 7, servingEnabled: true });
const request = { schemaVersion: 1, operationId: "repin-20261124", environment: "development", projectId: "njpbs-site-dev",
  fromCommitSha: from, toCommitSha: to };
const families = ["Posts", "Pages", "Records"];
const clear = () => clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, db);
const seed = async ({ pins = runtime(), deployment = pointer(), renderer = to } = {}) => {
  await db.doc("system/cmsPublicationRuntime").set(pins);
  await db.doc("system/publicDeployment").set(deployment);
  for (const family of families) await db.doc(`system/publicDeployment/noBuild${family}/capability`).set(capability(renderer));
};
const pins = async () => (await db.doc("system/cmsPublicationRuntime").get()).data();
afterAll(async () => { await deleteApp(app); await deleteApp(other); });
beforeEach(clear);

it("re-pins a ready development runtime to the live pointer commit once, with a receipt and audit row", async () => {
  await seed();
  const result = await owner.repinDevRuntime({ firestore: db, request });
  expect(result).toMatchObject({ committed: true, currentAligned: true });
  expect(await pins()).toEqual(runtime(to));
  expect(result.receipt.before).toEqual(runtime(from));
  const logs = await db.collection("admin_logs").where("action", "==", "public-release.dev-runtime-repin").get();
  expect(logs.size).toBe(1);
  // A repeated apply never writes again.
  await expect(owner.repinDevRuntime({ firestore: db, request })).rejects.toThrow();
  expect((await owner.readDevRuntimeRepin({ firestore: db, request })).currentAligned).toBe(true);
});

it.each([
  ["a paused runtime", { pins: runtime(from, "paused") }],
  ["a runtime at another commit", { pins: runtime("c".repeat(40)) }],
  ["a pointer at another commit", { deployment: pointer({ activeCommitSha: "c".repeat(40) }) }],
  ["an unsettled pointer generation", { deployment: pointer({ lastReservedGeneration: 8 }) }],
  ["a capability at another commit", { renderer: from }],
])("refuses %s without writing", async (_name, state) => {
  await seed(state);
  const before = await pins();
  await expect(owner.repinDevRuntime({ firestore: db, request })).rejects.toThrow();
  expect(await pins()).toEqual(before);
  expect((await db.collection("system/devRuntimeRepins/operations").get()).size).toBe(0);
});

it("refuses while a publication is in flight", async () => {
  await seed();
  await db.collection("cmsPublishQueue").doc("in-flight").set({ status: "publishing" });
  await expect(owner.repinDevRuntime({ firestore: db, request })).rejects.toThrow();
  expect(await pins()).toEqual(runtime(from));
});

it("refuses any project other than development", async () => {
  await expect(owner.repinDevRuntime({ firestore: getFirestore(other), request })).rejects.toThrow();
  expect(() => owner.parseRequest({ ...request, projectId: "njpbs-site" })).toThrow();
  expect(() => owner.parseRequest({ ...request, environment: "production" })).toThrow();
});

it("accepts only explicit arguments with the credential on stdin", () => {
  const args = ["--operation-id", "repin-20261124", "--from", from, "--to", to, "--apply"];
  expect(parseRepinArguments(args, {}, false)).toEqual({ apply: true, request });
  expect(() => parseRepinArguments(args, {}, true)).toThrow("dev_repin_explicit_stdin_required");
  expect(() => parseRepinArguments(args, { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json" }, false)).toThrow("dev_repin_explicit_stdin_required");
  expect(() => parseRepinArguments(args.slice(0, 6), {}, false)).toThrow("dev_repin_arguments_required");
});
