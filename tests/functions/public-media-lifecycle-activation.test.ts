import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import activationModule from
  "../../functions/lib/public-media-lifecycle-activation.js";
import coordinatorModule from
  "../../functions/lib/public-deployment-coordinator.js";
import manifestModule from "../../functions/lib/public-media-manifest.js";
import manifestStoreModule from
  "../../functions/lib/public-media-manifest-store.js";
import candidateStoreModule from
  "../../functions/lib/public-worker-candidate-store.js";
import candidateModule from "../../functions/lib/public-worker-candidate.js";
import outcomeModule from
  "../../functions/lib/public-deployment-outcome-store.js";
import recoveryModule from "../../functions/lib/cms-publication-baseline-recovery.js";
import { createPublicArtifactInventoryReceipt } from
  "../../site/src/lib/public-artifact-inventory";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const BUILD_BATCH_ID = "media-lifecycle-baseline";
const COMMIT_SHA = "a".repeat(40);
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const {
  PUBLIC_RECEIPT_URL,
  activatePublicMediaLifecycle,
  publicMediaLifecycleActivationRef,
} = activationModule;
const {
  acquirePublicDeploymentLease,
  reservePublicBuildBatch,
} = coordinatorModule;
const { createPublicMediaManifest } = manifestModule;
const { markPublicMediaManifestReady, stagePublicMediaManifest } =
  manifestStoreModule;
const { recordPublicWorkerCandidate } = candidateStoreModule;
const { publicWorkerCandidateTag } = candidateModule;
const { settlePublicDeploymentOutcome } = outcomeModule;

let db;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function deployCoordinatedBaseline(buildBatchId = BUILD_BATCH_ID) {
  const { batch } = await reservePublicBuildBatch({
    firestore: db,
    buildBatchId,
    commitSha: COMMIT_SHA,
  });
  const artifact = createPublicArtifactInventoryReceipt({
    reservation: batch,
    pages: [],
    posts: [],
    programs: [],
    authors: [],
    settings: [],
  });
  const manifest = createPublicMediaManifest({
    reservation: batch,
    artifactInventory: artifact.families.map((family) => ({
      collection: family.collection,
      complete: true,
      documentIds: family.artifacts.map(({ documentId }) => documentId),
    })),
    owners: artifact.owners,
  });
  await stagePublicMediaManifest({ firestore: db, manifest });
  await markPublicMediaManifestReady({ firestore: db, manifest });
  const publicationBytes = `${JSON.stringify({
    schemaVersion: 1,
    digestAlgorithm: "sha256",
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    artifactDigest: "b".repeat(64),
    artifactReceiptDigest: "c".repeat(64),
    mediaManifestDigest: manifest.mediaManifestDigest,
  }, null, 2)}\n`;
  const publicationReceiptDigest = createHash("sha256")
    .update(publicationBytes)
    .digest("hex");
  await recordPublicWorkerCandidate({
    firestore: db,
    candidate: {
      schemaVersion: 1,
      buildBatchId: batch.buildBatchId,
      generation: batch.generation,
      commitSha: batch.commitSha,
      workerName: "njpbs-production",
      workerVersionId: VERSION_ID,
      workerVersionTag: publicWorkerCandidateTag({
        generation: batch.generation,
        artifactDigest: "b".repeat(64),
      }),
      versionCreatedOn: "2026-09-02T20:00:00.000Z",
      artifactDigest: "b".repeat(64),
      artifactReceiptDigest: "c".repeat(64),
      publicationReceiptDigest,
      mediaManifestDigest: manifest.mediaManifestDigest,
      artifactFileCount: 2,
      artifactBytes: 1_000,
      wranglerVersion: "4.123.0",
    },
  });
  const acquisition = await acquirePublicDeploymentLease({
    firestore: db,
    buildBatchId: batch.buildBatchId,
    commitSha: batch.commitSha,
  });
  if (acquisition.outcome !== "acquired") {
    throw new Error("The fixture deployment lease was not acquired");
  }
  await settlePublicDeploymentOutcome({
    firestore: db,
    lease: acquisition.lease,
    evidence: {
      action: "activate",
      buildBatchId: batch.buildBatchId,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
    },
  });
  return {
    schemaVersion: 1,
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    deploymentId: DEPLOYMENT_ID,
    versionId: VERSION_ID,
    publicationReceiptDigest,
    publicReceiptUrl: PUBLIC_RECEIPT_URL,
  };
}

const RECOVERY_QUEUE = "RecoveryMedia0000001";
async function completedRecovery() {
  const original = await deployCoordinatedBaseline();
  await activatePublicMediaLifecycle({ firestore: db, proof: original });
  const previous = (await publicMediaLifecycleActivationRef(db).get()).data();
  // Ordinary deployments do not replace the original activation receipt.
  await deployCoordinatedBaseline("ordinary-content-build");
  await reservePublicBuildBatch({ firestore: db, buildBatchId: "external-reservation", commitSha: COMMIT_SHA });
  const pointer = (await db.doc("system/publicDeployment").get()).data();
  const expected = Object.fromEntries(["activeGeneration", "activeDeploymentId", "activeCommitSha", "lastReservedGeneration"]
    .map(key => [key, pointer[key]]));
  await recoveryModule.recoverCmsPublicationBaseline({ firestore: db, queueId: RECOVERY_QUEUE, commitSha: COMMIT_SHA, expected });
  const proof = await deployCoordinatedBaseline(`cms-${RECOVERY_QUEUE}`);
  const batchRef = db.doc(`system/publicDeployment/buildBatches/${proof.buildBatchId}`);
  const batch = (await batchRef.get()).data();
  const candidate = (await batchRef.collection("candidates").doc("worker").get()).data();
  const queueRef = db.doc(`cmsPublishQueue/${RECOVERY_QUEUE}`);
  const build = { buildBatchId: proof.buildBatchId, generation: proof.generation, commitSha: proof.commitSha, cutoffAt: batch.cutoffAt };
  await queueRef.update({
    status: "success", completedAt: batch.deployedAt,
    artifactBuild: build,
    artifactInclusion: { schemaVersion: 1, ...build, artifactReceiptDigest: candidate.artifactReceiptDigest, recordedAt: batch.deployedAt },
    deploymentReceipt: { provider: "cloudflare-workers", queueId: RECOVERY_QUEUE,
      buildBatchId: proof.buildBatchId, generation: proof.generation, commitSha: proof.commitSha,
      deploymentId: proof.deploymentId, versionId: proof.versionId, publicUrl: "https://njpbs.org/",
      visibleAt: batch.deployedAt, publishToVisibleMs: 0 },
  });
  return { proof, previous, queueRef, batchRef };
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("public-media-lifecycle-activation.test.ts");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("public media lifecycle activation", () => {
  it("reactivates only a completed recovery, preserving prior evidence and serializing exact retries", async () => {
    const { proof, previous } = await completedRecovery();
    const results = await Promise.all([
      activatePublicMediaLifecycle({ firestore: db, proof }),
      activatePublicMediaLifecycle({ firestore: db, proof }),
    ]);
    expect(results.map(result => result.idempotent).sort()).toEqual([false, true]);
    expect((await db.doc("system/publicDeployment").get()).data()).toMatchObject({ mediaLifecycleReady: true, activeGeneration: 4 });
    expect((await publicMediaLifecycleActivationRef(db).get()).data()).toMatchObject(proof);
    expect((await db.doc(`system/publicDeployment/mediaLifecycleActivations/generation-${previous.generation}`).get()).data()).toEqual(previous);
    const logs = await db.collection("admin_logs").where("action", "==", "public-media-lifecycle.activate").get();
    expect(logs.docs).toHaveLength(2);
    expect(logs.docs.find(doc => doc.data().before.recoveryQueueId === RECOVERY_QUEUE)?.data().before.activation).toEqual(previous);
  }, 20_000);

  it.each(["missing recovery", "wrong predecessor", "wrong counter", "pending queue", "wrong deployment", "wrong artifact", "wrong inclusion", "new reservation"])("refuses reactivation with %s without changing readiness or old evidence", async (failure) => {
    const { proof, previous, queueRef } = await completedRecovery();
    const recoveryRef = queueRef.collection("recovery").doc("baseline");
    if (failure === "missing recovery") await recoveryRef.delete();
    if (failure === "wrong predecessor") await recoveryRef.update({ "expected.activeCommitSha": "f".repeat(40) });
    if (failure === "wrong counter") await recoveryRef.update({ "expected.lastReservedGeneration": 4 });
    if (failure === "pending queue") await queueRef.update({ status: "publishing" });
    if (failure === "wrong deployment") await queueRef.update({ "deploymentReceipt.versionId": "99999999-9999-4999-8999-999999999999" });
    if (failure === "wrong artifact") await queueRef.update({ "artifactBuild.generation": 3 });
    if (failure === "wrong inclusion") await queueRef.update({ "artifactInclusion.artifactReceiptDigest": "f".repeat(64) });
    if (failure === "new reservation") await reservePublicBuildBatch({ firestore: db, buildBatchId: "later-reservation", commitSha: COMMIT_SHA });
    await expect(activatePublicMediaLifecycle({ firestore: db, proof })).rejects.toThrow();
    expect((await db.doc("system/publicDeployment").get()).data().mediaLifecycleReady).toBe(false);
    expect((await publicMediaLifecycleActivationRef(db).get()).data()).toEqual(previous);
    expect((await db.doc(`system/publicDeployment/mediaLifecycleActivations/generation-${previous.generation}`).get()).exists).toBe(false);
  });

  it("opens the fence only for the exact current deployment and records one audit", async () => {
    const proof = await deployCoordinatedBaseline();

    const first = await activatePublicMediaLifecycle({ firestore: db, proof });
    const retry = await activatePublicMediaLifecycle({ firestore: db, proof });
    const pointer = (await db.collection("system").doc("publicDeployment").get())
      .data();
    const receipt = (await publicMediaLifecycleActivationRef(db).get()).data();
    const logs = await db.collection("admin_logs")
      .where("action", "==", "public-media-lifecycle.activate")
      .get();

    expect(first).toMatchObject({
      idempotent: false,
      receipt: proof,
    });
    expect(retry).toEqual({ ...first, idempotent: true });
    expect(pointer).toMatchObject({
      mediaLifecycleReady: true,
      state: "idle",
      activeGeneration: proof.generation,
      activeDeploymentId: DEPLOYMENT_ID,
    });
    expect(receipt).toMatchObject(proof);
    expect(logs.docs).toHaveLength(1);
    expect(logs.docs[0].data()).toMatchObject({
      actorUid: "system:public-deployment",
      action: "public-media-lifecycle.activate",
      proof: {
        buildBatchId: BUILD_BATCH_ID,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
      },
    });
  });

  it("refuses a stale deployment after a newer generation is reserved", async () => {
    const proof = await deployCoordinatedBaseline();
    await reservePublicBuildBatch({
      firestore: db,
      buildBatchId: "newer-build",
      commitSha: "d".repeat(40),
    });

    await expect(activatePublicMediaLifecycle({ firestore: db, proof }))
      .rejects.toThrow(/not the current deployment/i);
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({ mediaLifecycleReady: false });
    expect((await publicMediaLifecycleActivationRef(db).get()).exists)
      .toBe(false);
  });

  it("refuses a receipt that does not match the stored Worker candidate", async () => {
    const proof = await deployCoordinatedBaseline();

    await expect(activatePublicMediaLifecycle({
      firestore: db,
      proof: { ...proof, publicationReceiptDigest: "f".repeat(64) },
    })).rejects.toThrow(/not the current deployment/i);
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({ mediaLifecycleReady: false });
  });
});
