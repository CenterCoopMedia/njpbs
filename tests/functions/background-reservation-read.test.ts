import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { readPublicArtifactContentFromDatabase } from "../../site/src/lib/cms-loader";

const commitSha = "a".repeat(40);
const operationId = "11111111111111111111";
const contextDigest = "b".repeat(64);
const buildBatchId = `post-background-${operationId}-${contextDigest}`;
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>;
let firestore: ReturnType<typeof firebaseAdminRuntime.getFirestore>;
let cutoffAt: InstanceType<typeof firebaseAdminRuntime.Timestamp>;
let reservation: Record<string, unknown>;

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) {
    throw new Error("Use a local demo Firestore emulator");
  }
  app = firebaseAdminRuntime.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? "demo-njpbs" }, "background-retained-cutoff");
  firestore = firebaseAdminRuntime.getFirestore(app);
});
afterAll(async () => { if (app) await firebaseAdminRuntime.deleteApp(app); });
beforeEach(async () => {
  await firestore.recursiveDelete(firestore.collection("cmsPages"));
  const created = await firestore.doc("cmsPages/home").set({ title: "Retained source", status: "draft", version: 7, blocks: [] });
  cutoffAt = created.writeTime;
  reservation = { schemaVersion: 1, buildBatchId, generation: 279, commitSha, status: "reserved",
    reservedAgainstGeneration: 278, reservedAgainstDeploymentId: "generation-278", reservedAgainstCommitSha: commitSha,
    cutoffAt, reservedAt: cutoffAt };
  await firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).set({
    schemaVersion: 1, contextDigest, status: "building", reservation,
  });
});
const readBackground = (ageMillis: number) => readPublicArtifactContentFromDatabase(firestore as never,
  { buildBatchId, commitSha, batchMode: "background" }, new Date(cutoffAt.toMillis() + ageMillis));

it.each([60_001, 10 * 60_000, 60 * 60_000])("reads the same background reservation at wall-clock age %i ms", async age => {
  const read = await readBackground(age);
  expect(read.reservation.cutoffAt).toEqual(cutoffAt);
  expect(read.reservation).toMatchObject({ buildBatchId, generation: 279, commitSha });
  expect(read.pages).toEqual([{ id: "home", title: "Retained source", status: "draft", version: 7, blocks: [] }]);
  const retained = (await firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`).get()).data()!;
  expect(retained.reservation.cutoffAt.isEqual(cutoffAt)).toBe(true);
});

it("refuses an expired or future background cutoff", async () => {
  await expect(readBackground(60 * 60_000 + 1)).rejects.toThrow("cutoff is stale");
  await expect(readBackground(-1)).rejects.toThrow("cutoff is in the future");
});

it("keeps the normal code-build reservation freshness limit at 60 seconds", async () => {
  const codeBuildId = "retained-cutoff-code-control";
  await firestore.doc(`system/publicDeployment/buildBatches/${codeBuildId}`).set({ ...reservation, buildBatchId: codeBuildId });
  await expect(readPublicArtifactContentFromDatabase(firestore as never,
    { buildBatchId: codeBuildId, commitSha }, new Date(cutoffAt.toMillis() + 60_001))).rejects.toThrow("cutoff is stale");
  const fresh = await readPublicArtifactContentFromDatabase(firestore as never,
    { buildBatchId: codeBuildId, commitSha }, new Date(cutoffAt.toMillis() + 60_000));
  expect(fresh.reservation.cutoffAt).toEqual(cutoffAt);
});

it("retains the source, batch and preparation identity checks for the longer window", async () => {
  const preparation = firestore.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${contextDigest}`);
  await preparation.update({ "reservation.commitSha": "c".repeat(40) });
  await expect(readBackground(120_000)).rejects.toThrow("reservation is unavailable");
  await preparation.update({ "reservation.commitSha": commitSha, "reservation.buildBatchId": "other-batch" });
  await expect(readBackground(120_000)).rejects.toThrow("build batch is invalid");
  await preparation.update({ "reservation.buildBatchId": buildBatchId, contextDigest: "d".repeat(64) });
  await expect(readBackground(120_000)).rejects.toThrow("reservation is unavailable");
});
