import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import artifactModule from "../../functions/lib/cms-publish-artifact.js";
import serializerModule from
  "../../functions/lib/cms-publication-serializer.js";
import writebackModule from
  "../../functions/lib/cms-public-deployment-writeback.js";
import coordinatorModule from
  "../../functions/lib/public-deployment-coordinator.js";
import outcomeModule from
  "../../functions/lib/public-deployment-outcome-store.js";
import mediaActivationModule from
  "../../functions/lib/public-media-lifecycle-activation.js";
import manifestModule from "../../functions/lib/public-media-manifest.js";
import manifestStoreModule from
  "../../functions/lib/public-media-manifest-store.js";
import candidateModule from "../../functions/lib/public-worker-candidate.js";
import candidateStoreModule from
  "../../functions/lib/public-worker-candidate-store.js";
import { firebaseAdminRuntime } from
  "../../site/scripts/firebase-admin-runtime";
import { createPublicArtifactInventoryReceipt } from
  "../../site/src/lib/public-artifact-inventory";

const PROJECT = "demo-njpbs-publisher-runtime";
const QUEUE_ID = "11111111111111111111";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const COMMIT_SHA = "a".repeat(40);
const SERIALIZER_ID = "node-compute-primary";
const CLAIM_TOKEN = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_DIGEST = "b".repeat(64);
const PUBLICATION_RECEIPT_DIGEST = "c".repeat(64);

const { reserveCmsPublishArtifact } = artifactModule;
const { claimCmsPublishQueue } = serializerModule;
const {
  recordCmsPublishArtifactInclusion,
  settleCmsPublishQueueFromPublicDeployment,
} = writebackModule;
const { acquirePublicDeploymentLease, reservePublicBuildBatch } =
  coordinatorModule;
const { settlePublicDeploymentOutcome } = outcomeModule;
const { PUBLIC_RECEIPT_URL, activatePublicMediaLifecycle } =
  mediaActivationModule;
const { createPublicMediaManifest } = manifestModule;
const { markPublicMediaManifestReady, stagePublicMediaManifest } =
  manifestStoreModule;
const { publicWorkerCandidateTag } = candidateModule;
const { recordPublicWorkerCandidate } = candidateStoreModule;

let app;
let db;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

beforeAll(() => {
  app = firebaseAdminRuntime.initializeApp(
    { projectId: PROJECT },
    `${PROJECT}-publisher-runtime`,
  );
  db = firebaseAdminRuntime.getFirestore(app);
});

beforeEach(clearFirestore);

afterAll(async () => {
  await firebaseAdminRuntime.deleteApp(app);
});

describe("CMS publication Firebase runtime composition", () => {
  it("persists the full serializer and activation chain across two installs", async () => {
    const siteRequire = createRequire(
      new URL("../../site/package.json", import.meta.url),
    );
    const functionsRequire = createRequire(
      new URL("../../functions/package.json", import.meta.url),
    );
    const siteFirestoreModule = siteRequire("firebase-admin/firestore");
    const functionsFirestoreModule = functionsRequire(
      "firebase-admin/firestore",
    );
    expect(siteRequire.resolve("firebase-admin/firestore")).not.toBe(
      functionsRequire.resolve("firebase-admin/firestore"),
    );
    expect(firebaseAdminRuntime.FieldValue).toBe(
      functionsFirestoreModule.FieldValue,
    );
    expect(firebaseAdminRuntime.FieldValue).not.toBe(
      siteFirestoreModule.FieldValue,
    );

    await db.collection("cmsPublishQueue").doc(QUEUE_ID).set({
      status: "pending",
      transport: "serializer",
      triggeredAt: firebaseAdminRuntime.Timestamp.fromMillis(1_787_000_000_000),
      completedAt: null,
      error: null,
      changes: [],
      commitSha: COMMIT_SHA,
    });

    await claimCmsPublishQueue({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
      serializerId: SERIALIZER_ID,
      claimToken: CLAIM_TOKEN,
    });
    const artifactBuild = await reserveCmsPublishArtifact({
      firestore: db,
      queueId: QUEUE_ID,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
    });
    expect(artifactBuild).not.toBeNull();
    const { batch } = await reservePublicBuildBatch({
      firestore: db,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
    });
    const artifactReceipt = createPublicArtifactInventoryReceipt({
      reservation: batch,
      pages: [],
      posts: [],
      programs: [],
      authors: [],
      settings: [],
    });
    await recordCmsPublishArtifactInclusion({
      firestore: db,
      queueId: QUEUE_ID,
      artifactReceipt,
    });

    const manifest = createPublicMediaManifest({
      reservation: batch,
      artifactInventory: artifactReceipt.families.map((family) => ({
        collection: family.collection,
        complete: true,
        documentIds: family.artifacts.map(({ documentId }) => documentId),
      })),
      owners: artifactReceipt.owners,
    });
    await stagePublicMediaManifest({ firestore: db, manifest });
    await markPublicMediaManifestReady({ firestore: db, manifest });
    await recordPublicWorkerCandidate({
      firestore: db,
      candidate: {
        schemaVersion: 1,
        buildBatchId: BUILD_BATCH_ID,
        generation: batch.generation,
        commitSha: COMMIT_SHA,
        workerName: "njpbs-production",
        workerVersionId: VERSION_ID,
        workerVersionTag: publicWorkerCandidateTag({
          generation: batch.generation,
          artifactDigest: ARTIFACT_DIGEST,
        }),
        versionCreatedOn: "2026-09-02T20:00:00.000Z",
        artifactDigest: ARTIFACT_DIGEST,
        artifactReceiptDigest: createHash("sha256")
          .update(JSON.stringify(artifactReceipt))
          .digest("hex"),
        publicationReceiptDigest: PUBLICATION_RECEIPT_DIGEST,
        mediaManifestDigest: manifest.mediaManifestDigest,
        artifactFileCount: 2,
        artifactBytes: 1_000,
        wranglerVersion: "4.123.0",
      },
    });
    const acquisition = await acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: BUILD_BATCH_ID,
      commitSha: COMMIT_SHA,
    });
    if (acquisition.outcome !== "acquired") {
      throw new Error("The test deployment lease was not acquired");
    }
    await settlePublicDeploymentOutcome({
      firestore: db,
      lease: acquisition.lease,
      evidence: {
        action: "activate",
        buildBatchId: BUILD_BATCH_ID,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
        commitSha: COMMIT_SHA,
      },
    });
    await settleCmsPublishQueueFromPublicDeployment({
      firestore: db,
      queueId: QUEUE_ID,
    });
    await activatePublicMediaLifecycle({
      firestore: db,
      proof: {
        schemaVersion: 1,
        buildBatchId: BUILD_BATCH_ID,
        generation: batch.generation,
        commitSha: COMMIT_SHA,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
        publicationReceiptDigest: PUBLICATION_RECEIPT_DIGEST,
        publicReceiptUrl: PUBLIC_RECEIPT_URL,
      },
    });

    expect((await db.collection("cmsPublishQueue").doc(QUEUE_ID).get()).data())
      .toMatchObject({
        status: "success",
        gitCommitSha: COMMIT_SHA,
      });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "idle",
        activeGeneration: batch.generation,
        activeDeploymentId: DEPLOYMENT_ID,
        mediaLifecycleReady: true,
      });
  });
});
