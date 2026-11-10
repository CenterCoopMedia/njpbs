import { beforeEach, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "../../functions/lib/firebase.js";
import context from "../../functions/lib/public-context-revision.js";
import aggregates from "../../functions/lib/public-context-publication.js";
import deployment from "../../functions/lib/public-deployment.js";
import { readEditorialPreviewSelection } from "../../site/scripts/cms-preview-editorial-context";

const originalId = "A".repeat(20);
const aliasId = "B".repeat(20);
const commitSha = "a".repeat(40);
const runtime = { owner: "cloudflare", release: commitSha };
const contextDigest = context.publicContextDigest(1);
const preparationPath = `cmsPublishQueue/${originalId}/backgroundPreparation/${contextDigest}`;
const publication = { schemaVersion: 1 as const, digestAlgorithm: "sha256" as const,
  buildBatchId: "cms-11111111111111111111", generation: 1, commitSha,
  mediaManifestDigest: "b".repeat(64), artifactDigest: "c".repeat(64), artifactReceiptDigest: "d".repeat(64) };
const reservation = { buildBatchId: `post-background-${originalId}-${contextDigest}`, generation: 2, commitSha,
  cutoffAt: Timestamp.fromMillis(1_780_000_000_000) };

async function enqueue(operationId: string) {
  await db.runTransaction(async transaction => {
    const accepted = await aggregates.enqueuePublicContextInTransaction({ transaction, firestore: db,
      operationId, runtime, reason: "context", contextRevision: 1 });
    accepted.write();
  });
}
const select = () => db.runTransaction(transaction => readEditorialPreviewSelection(transaction, db, publication, aliasId));
beforeEach(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
    !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) throw new Error("Use demo Firestore emulators");
  await db.recursiveDelete(db.doc("system/publicDeployment"));
  await db.recursiveDelete(db.collection("cmsPublishQueue"));
  await db.recursiveDelete(db.collection("cmsBackgroundOutputs"));
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 1, activeCommitSha: commitSha, activeDeploymentId: "11111111-1111-4111-8111-111111111111",
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: publication.buildBatchId });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await enqueue(originalId);
  const batch = db.batch();
  for (const output of aggregates.OUTPUTS) {
    batch.update(db.doc(`cmsBackgroundOutputs/${output}`), { status: "verified", receipt: {
      rendererSha: commitSha, contextDigest, revision: 1, verifiedAt: 1_780_000_000_000,
      digest: "f".repeat(64), routeSetDigest: "e".repeat(64) } });
    batch.update(db.doc(`cmsPublishQueue/${originalId}/backgroundOutputs/${output}`), { status: "verified" });
  }
  batch.set(db.doc(preparationPath), { schemaVersion: 1, runtime, status: "verified", contextDigest,
    preparedDigest: "e".repeat(64), admissionRevision: null, reservation });
  await batch.commit();
  expect(await aggregates.settlePublicContext({ firestore: db, operationId: originalId, runtime })).toBe(true);
  await enqueue(aliasId);
  expect(await aggregates.settlePublicContext({ firestore: db, operationId: aliasId, runtime })).toBe(true);
});

it("selects complete-byte alias B through verified original A without relabeling the checkpoint", async () => {
  const original = await db.doc(preparationPath).get();
  expect((await db.doc(`cmsPublishQueue/${aliasId}/backgroundPreparation/${contextDigest}`).get()).exists).toBe(false);
  const selected = await select();
  expect(selected).toMatchObject({ operationId: aliasId, contextRevision: 1, contextDigest,
    checkpointIdentity: { operationId: originalId, contextDigest, commitSha, owner: "cloudflare",
      cutoffMillis: 1_780_000_000_000, admissionRevision: null },
    source: { buildBatchId: reservation.buildBatchId, generation: 2, commitSha }, publication });
  const retained = await db.doc(preparationPath).get();
  expect(retained.data()).toEqual(original.data());
  expect(retained.updateTime).toEqual(original.updateTime);
});

it.each(["missing", "unverified", "foreign-source", "foreign-context", "missing-field"])("refuses alias selection with %s original evidence", async kind => {
  if (kind === "missing") await db.doc(preparationPath).delete();
  if (kind === "unverified") await db.doc(preparationPath).update({ status: "building" });
  if (kind === "foreign-source") await db.doc(preparationPath).update({ runtime: { ...runtime, release: "f".repeat(40) } });
  if (kind === "foreign-context") await db.doc(preparationPath).update({ contextDigest: "f".repeat(64) });
  if (kind === "missing-field") {
    const row = (await db.doc(`cmsPublishQueue/${aliasId}`).get()).data()!;
    const current = db.doc("system/publicDeployment/aggregateContexts/current");
    const value = (await current.get()).data()!;
    delete value.preparationOperationId;
    await current.set(value);
    await db.doc(`cmsPublishQueue/${aliasId}`).set(row);
    await expect(select()).rejects.toMatchObject({ code: "editorial_preparation_reference_missing" });
  }
  await expect(select()).rejects.toThrow("Editorial preview context is unavailable");
});

it("selects the retained original preparation when Post work completes families at the same context", async () => {
  const postOperationId = "C".repeat(20);
  await db.doc(`cmsPublishQueue/${postOperationId}`).set({ transport: "post-no-build-v1", status: "success", runtime });
  for (const output of aggregates.OUTPUTS.filter(output => output !== "contentApi")) {
    await db.doc(`cmsBackgroundOutputs/${output}`).update({ taskPath: `cmsPublishQueue/${postOperationId}/backgroundOutputs/${output}` });
  }
  expect(await aggregates.settlePublicContext({ firestore: db, operationId: aliasId, runtime })).toBe(true);
  const seal = (await db.doc(`cmsPublishQueue/${aliasId}`).get()).data()!.aggregateReceipt;
  expect(seal.outputs.search.taskPath).toBe(`cmsPublishQueue/${postOperationId}/backgroundOutputs/search`);
  expect(seal.outputs.contentApi.taskPath).toBe(`cmsPublishQueue/${originalId}/backgroundOutputs/contentApi`);
  expect(seal.preparationOperationId).toBe(originalId);
  expect(await select()).toMatchObject({ operationId: aliasId, checkpointIdentity: { operationId: originalId } });
});
