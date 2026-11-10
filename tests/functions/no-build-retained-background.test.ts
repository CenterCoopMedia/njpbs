import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { noBuildPostMaintenance } from "../../site/scripts/no-build-post-background";
import context from "../../functions/lib/public-context-revision.js";

const commitSha = "a".repeat(40);
const operationId = "R1e2T3a4I5n6E7d8J9o0";
const postId = "retained-background-post";
const runtime = { owner: "cloudflare" as const, release: commitSha };
const contextDigest = context.publicContextDigest(1);
const preparationPath = `cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`;
const taskPath = `cmsPublishQueue/${operationId}/backgroundOutputs/listings`;
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let firestore: ReturnType<typeof firebaseAdminRuntime.getFirestore>;

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use a local demo Firestore emulator");
  app = firebaseAdminRuntime.initializeApp({ projectId: process.env.GCLOUD_PROJECT }, "retained-background-admission-test");
  firestore = firebaseAdminRuntime.getFirestore(app);
});
afterAll(async () => { if (app) await firebaseAdminRuntime.deleteApp(app); });
beforeEach(async () => {
  await firestore.recursiveDelete(firestore.doc("system/publicDeployment"));
  await firestore.recursiveDelete(firestore.collection("cmsBackgroundOutputs"));
  await firestore.recursiveDelete(firestore.collection("cmsPublishQueue"));
  await firestore.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  await firestore.doc("system/publicDeployment").set({ state: "idle", activeCommitSha: commitSha,
    activeGeneration: 278, activeDeploymentId: "deployed-generation-278" });
  await firestore.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2,
    rendererSha: commitSha, servingEnabled: true, generation: 278 });
  await firestore.doc(`system/publicDeployment/noBuildPostOwners/${postId}`).set({ schemaVersion: 1,
    mode: "dynamic", runtime, servingEnabled: true, postId, operationId, sourceVersion: 3,
    slug: "retained-background-post", visible: true, rendererSha: commitSha, ownedSlugs: ["retained-background-post"], generation: 278 });
  await firestore.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await firestore.doc(`cmsPublishQueue/${operationId}`).set({ status: "pending", transport: "post-no-build-v1",
    runtime, backgroundRuntime: runtime, noBuildPost: { postId, operationId, sourceVersion: 3, admissionRevision: 1 } });
  await firestore.doc(taskPath).set({ schemaVersion: 1, owner: "post-background-v1", runtime, postId,
    revision: 1, output: "listings", contextDigest, status: "pending", attempts: 0, nextAttemptAt: 0 });
  await firestore.doc("cmsBackgroundOutputs/listings").set({ schemaVersion: 1, owner: "post-background-v1", runtime,
    postId, revision: 1, contextDigest, status: "pending", taskPath });
});

function maintain() {
  // Missing durable-storage app is the real storage availability boundary. No
  // renderer/build can run, but an accepted claim must record bounded failure.
  return noBuildPostMaintenance({ firestore, runtime, commitSha,
    stateDirectory: "/tmp/njpbs-retained-background-proof", distDirectory: "/tmp/njpbs-retained-background-proof/dist",
    buildEnvironment: {} })();
}

it.each(["paused", "narrowed"])("attempts the accepted pending operation after valid schema2 admission is %s", async mode => {
  const queueBefore = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data();
  const taskBefore = (await firestore.doc(taskPath).get()).data();
  await firestore.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 2, enabled: mode !== "paused",
    families: { posts: mode === "narrowed" ? { mode: "ids", ids: ["another-post"] } : { mode: "all" } },
    backgroundBucket: "fixture-bucket" });
  await expect(maintain()).resolves.toBeUndefined();
  const stored = (await firestore.doc(preparationPath).get()).data()!;
  expect(stored).toMatchObject({ runtime, contextDigest, backgroundBucket: "fixture-bucket", admissionRevision: 2,
    attempts: 1, claim: null, status: "failed", error: "background_preparation_failed",
    reservation: { schemaVersion: 1, buildBatchId: `post-background-${operationId}-${contextDigest}`,
      commitSha, generation: 279, reservedAgainstGeneration: 278,
      reservedAgainstDeploymentId: "deployed-generation-278", reservedAgainstCommitSha: commitSha } });
  expect(stored.reservation.cutoffAt).toBeInstanceOf(firebaseAdminRuntime.Timestamp);
  expect(stored.reservation.reservedAt.isEqual(stored.reservation.cutoffAt)).toBe(true);
  expect(stored.nextAttemptAt).toBeGreaterThan(stored.reservation.cutoffAt.toMillis());
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()).toEqual(queueBefore);
  expect((await firestore.doc(taskPath).get()).data()).toEqual(taskBefore);
  await maintain();
  expect((await firestore.doc(preparationPath).get()).data()).toEqual(stored);
});

it.each(["wrong owner", "wrong queue owner", "different queue operation", "different active source", "leased pointer"])(
  "retains the %s fence while admission is paused", async mode => {
    await firestore.doc("system/noBuildPostAdmission").update({ enabled: false, revision: 2 });
    if (mode === "wrong owner") await firestore.doc(`system/publicDeployment/noBuildPostOwners/${postId}`).update({
      runtime: { owner: "node-compute", release: commitSha } });
    if (mode === "wrong queue owner") await firestore.doc(`cmsPublishQueue/${operationId}`).update({
      backgroundRuntime: { owner: "node-compute", release: commitSha } });
    if (mode === "different queue operation") await firestore.doc(`cmsPublishQueue/${operationId}`).update({
      "noBuildPost.operationId": "Z1y2X3w4V5u6T7s8R9q0" });
    if (mode === "different active source") await firestore.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
    if (mode === "leased pointer") await firestore.doc("system/publicDeployment").update({ state: "reconciling" });
    await expect(maintain()).resolves.toBeUndefined();
    expect((await firestore.doc(preparationPath).get()).exists).toBe(false);
  });

it("retains an existing preparation's exact release under paused admission", async () => {
  await firestore.doc("system/noBuildPostAdmission").update({ enabled: false, revision: 2 });
  const retained = { schemaVersion: 1, runtime: { owner: "cloudflare", release: "b".repeat(40) }, contextDigest,
    backgroundBucket: "fixture-bucket", admissionRevision: 1, status: "failed", attempts: 1, claim: null, nextAttemptAt: 0 };
  await firestore.doc(preparationPath).set(retained);
  await expect(maintain()).resolves.toBeUndefined();
  expect((await firestore.doc(preparationPath).get()).data()).toEqual(retained);
});

it("refuses unavailable public context before any retained preparation claim", async () => {
  await firestore.doc("system/noBuildPostAdmission").update({ enabled: false, revision: 2 });
  await firestore.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 0 });
  await expect(maintain()).rejects.toThrow("Public context identity is unavailable");
  expect((await firestore.doc(preparationPath).get()).exists).toBe(false);
  expect((await firestore.collection(`cmsPublishQueue/${operationId}/backgroundPreparation`).get()).empty).toBe(true);
});
