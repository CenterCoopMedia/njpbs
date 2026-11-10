import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import outcomeStore from "../../functions/lib/public-deployment-outcome-store.js";
import writebackStore from "../../functions/lib/cms-public-deployment-writeback.js";

const admin = adminPkg;
const { settlePublicDeploymentOutcome } = outcomeStore;
const {
  recordCmsPublishArtifactInclusion,
  settleCmsPublishQueueFromPublicDeployment,
} = writebackStore;

const PROJECT = "demo-njpbs";
const QUEUE_ID = "11111111111111111111";
const BUILD_BATCH_ID = "cms-11111111111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_TOKEN = "44444444-4444-4444-8444-444444444444";
const COMMIT_SHA = "a".repeat(40);
const MANIFEST_DIGEST = "b".repeat(64);
const ARTIFACT_DIGEST = "c".repeat(64);

const triggeredAt = admin.firestore.Timestamp.fromMillis(1_787_000_000_000);
const cutoffAt = admin.firestore.Timestamp.fromMillis(1_787_000_001_000);
const reservedAt = admin.firestore.Timestamp.fromMillis(1_787_000_002_000);
const verifiedAt = admin.firestore.Timestamp.fromMillis(1_787_000_003_000);
const readyAt = admin.firestore.Timestamp.fromMillis(1_787_000_004_000);
const leaseAcquiredAt = admin.firestore.Timestamp.fromMillis(1_787_000_005_000);

let db;

function artifactReceipt(overrides = {}) {
  return {
    buildBatchId: BUILD_BATCH_ID,
    generation: 1,
    commitSha: COMMIT_SHA,
    cutoffAt: {
      seconds: cutoffAt.seconds,
      nanoseconds: cutoffAt.nanoseconds,
    },
    families: [
      {
        collection: "cmsPages",
        complete: true,
        artifacts: [{ documentId: "home", sourceVersion: 4 }],
      },
      { collection: "cmsPosts", complete: true, artifacts: [] },
      { collection: "cmsSettings", complete: true, artifacts: [] },
    ],
    ...overrides,
  };
}

function artifactReceiptDigest(receipt = artifactReceipt()) {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}

function coverage() {
  return ["cmsPages", "cmsPosts", "cmsSettings", "cmsAuthorProfilesPublic"]
    .map((collection, index) => ({
      collection,
      complete: true,
      ownerCount: 0,
      ownerIdsDigest: String(index + 1).repeat(64),
    }));
}

function lease() {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: 1,
    commitSha: COMMIT_SHA,
    leaseToken: LEASE_TOKEN,
    leaseAcquiredAt,
    predecessorGeneration: 0,
    predecessorDeploymentId: null,
    predecessorCommitSha: null,
  };
}

function refs() {
  const pointerRef = db.collection("system").doc("publicDeployment");
  const batchRef = pointerRef.collection("buildBatches").doc(BUILD_BATCH_ID);
  const manifestRef = batchRef.collection("manifests").doc("publicMedia");
  return {
    pointerRef,
    batchRef,
    manifestRef,
    verificationRef: manifestRef.collection("verifications").doc("complete"),
    candidateRef: batchRef.collection("candidates").doc("worker"),
    queueRef: db.collection("cmsPublishQueue").doc(QUEUE_ID),
    pageRef: db.collection("cmsPages").doc("home"),
  };
}

async function seedDeploying({ includeQueue = true } = {}) {
  const state = refs();
  const writes = [
    state.pointerRef.set({
      schemaVersion: 1,
      mediaLifecycleReady: false,
      state: "deploying",
      activeGeneration: 0,
      activeDeploymentId: null,
      activeCommitSha: null,
      lastReservedGeneration: 1,
      newestEligibleGeneration: 1,
      newestEligibleBuildBatchId: BUILD_BATCH_ID,
      leaseToken: LEASE_TOKEN,
      leaseAcquiredAt,
      candidateGeneration: 1,
      candidateBuildBatchId: BUILD_BATCH_ID,
      candidateCommitSha: COMMIT_SHA,
      predecessorGeneration: 0,
      predecessorDeploymentId: null,
      predecessorCommitSha: null,
    }),
    state.batchRef.set({
      schemaVersion: 1,
      buildBatchId: BUILD_BATCH_ID,
      generation: 1,
      status: "deploying",
      commitSha: COMMIT_SHA,
      reservedAgainstGeneration: 0,
      reservedAgainstDeploymentId: null,
      reservedAgainstCommitSha: null,
      cutoffAt,
      reservedAt,
      readyAt,
      ...lease(),
    }),
    state.manifestRef.set({
      schemaVersion: 1,
      digestAlgorithm: "sha256",
      buildBatchId: BUILD_BATCH_ID,
      generation: 1,
      commitSha: COMMIT_SHA,
      cutoffAt,
      coverage: coverage(),
      ownerCount: 0,
      maxOwnerWritesPerChunk: 200,
      maxChunkBytes: 2 * 1024 * 1024,
      maxVerificationBytes: 2 * 1024 * 1024,
      chunkCount: 0,
      mediaManifestDigest: MANIFEST_DIGEST,
    }),
    state.verificationRef.set({
      schemaVersion: 1,
      buildBatchId: BUILD_BATCH_ID,
      generation: 1,
      mediaManifestDigest: MANIFEST_DIGEST,
      ownerCount: 0,
      chunkCount: 0,
      verifiedAt,
    }),
    state.candidateRef.set({
      schemaVersion: 1,
      buildBatchId: BUILD_BATCH_ID,
      generation: 1,
      commitSha: COMMIT_SHA,
      workerName: "njpbs-production",
      workerVersionId: VERSION_ID,
      workerVersionTag: `cms-g1-${ARTIFACT_DIGEST.slice(0, 16)}`,
      versionCreatedOn: "2026-08-27T20:00:00.000Z",
      artifactDigest: ARTIFACT_DIGEST,
      artifactReceiptDigest: artifactReceiptDigest(),
      publicationReceiptDigest: "d".repeat(64),
      mediaManifestDigest: MANIFEST_DIGEST,
      artifactFileCount: 100,
      artifactBytes: 1_000_000,
      wranglerVersion: "4.123.0",
      recordedAt: readyAt,
    }),
    state.pageRef.set({
      status: "published",
      publishBuildPending: true,
      publishBuildQueueId: QUEUE_ID,
      published: { sourceVersion: 4 },
    }),
  ];
  if (includeQueue) {
    writes.push(state.queueRef.set({
      status: "publishing",
      triggeredAt,
      completedAt: null,
      error: null,
      changes: [{ collection: "cmsPages", id: "home", sourceVersion: 4 }],
      artifactBuild: {
        buildBatchId: BUILD_BATCH_ID,
        generation: 1,
        commitSha: COMMIT_SHA,
        cutoffAt,
      },
    }));
  }
  await Promise.all(writes);
}

async function activate() {
  return settlePublicDeploymentOutcome({
    firestore: db,
    lease: lease(),
    evidence: {
      action: "activate",
      buildBatchId: BUILD_BATCH_ID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
    },
  });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("cms-public-deployment-writeback.test.js");
});

beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("CMS public deployment writeback", () => {
  it("preserves production late success for a non-timeout failed queue with exact terminal evidence", async () => {
    await seedDeploying();
    await recordCmsPublishArtifactInclusion({ firestore: db, queueId: QUEUE_ID, artifactReceipt: artifactReceipt() });
    await refs().queueRef.update({ status: "failed", error: "A different production workflow failure" });
    await activate();
    await expect(settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: QUEUE_ID,
      devQueueMode: "timeout" })).rejects.toThrow("development queue recovery state");
    const result = await settleCmsPublishQueueFromPublicDeployment({ firestore: db, queueId: QUEUE_ID });
    expect(result).toMatchObject({ outcome: "success", receipt: { publicUrl: "https://njpbs.org/", versionId: VERSION_ID } });
    expect((await refs().queueRef.get()).data()).toMatchObject({ status: "success", deploymentReceipt: result.receipt });
  });

  it("settles only an included queue against the exact deployed Worker candidate", async () => {
    await seedDeploying();
    const inclusion = await recordCmsPublishArtifactInclusion({
      firestore: db,
      queueId: QUEUE_ID,
      artifactReceipt: artifactReceipt(),
    });
    expect(inclusion).toMatchObject({
      idempotent: false,
      receipt: {
        buildBatchId: BUILD_BATCH_ID,
        generation: 1,
        commitSha: COMMIT_SHA,
        artifactReceiptDigest: artifactReceiptDigest(),
      },
    });

    await activate();
    const result = await settleCmsPublishQueueFromPublicDeployment({
      firestore: db,
      queueId: QUEUE_ID,
    });
    const queue = (await refs().queueRef.get()).data();
    const page = (await refs().pageRef.get()).data();

    expect(result).toMatchObject({
      outcome: "success",
      idempotent: false,
      receipt: {
        provider: "cloudflare-workers",
        queueId: QUEUE_ID,
        buildBatchId: BUILD_BATCH_ID,
        generation: 1,
        commitSha: COMMIT_SHA,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
        publicUrl: "https://njpbs.org/",
      },
    });
    expect(queue).toMatchObject({
      status: "success",
      gitCommitSha: COMMIT_SHA,
      deploymentReceipt: result.receipt,
    });
    expect(queue.completedAt).toBeDefined();
    expect(queue.error).toBeUndefined();
    expect(result.receipt.visibleAt.toMillis()).toBeGreaterThanOrEqual(
      leaseAcquiredAt.toMillis(),
    );
    expect(result.receipt.publishToVisibleMs).toBe(
      result.receipt.visibleAt.toMillis() - triggeredAt.toMillis(),
    );
    expect(page).toMatchObject({
      publishBuildPending: false,
      publishBuildQueueId: null,
    });
  });

  it("records the exact inclusion once and refuses a conflicting artifact", async () => {
    await seedDeploying();
    const first = await recordCmsPublishArtifactInclusion({
      firestore: db,
      queueId: QUEUE_ID,
      artifactReceipt: artifactReceipt(),
    });
    const retry = await recordCmsPublishArtifactInclusion({
      firestore: db,
      queueId: QUEUE_ID,
      artifactReceipt: artifactReceipt(),
    });

    expect(retry).toEqual({ ...first, idempotent: true });
    await expect(recordCmsPublishArtifactInclusion({
      firestore: db,
      queueId: QUEUE_ID,
      artifactReceipt: artifactReceipt({
        families: [
          { collection: "cmsPages", complete: true, artifacts: [] },
          { collection: "cmsPosts", complete: true, artifacts: [] },
          { collection: "cmsSettings", complete: true, artifacts: [] },
        ],
      }),
    })).rejects.toThrow(/artifact receipt does not include/i);
  });

  it("refuses queue success when the durable inclusion proof is absent", async () => {
    await seedDeploying();
    await activate();

    await expect(settleCmsPublishQueueFromPublicDeployment({
      firestore: db,
      queueId: QUEUE_ID,
    })).rejects.toThrow(/inclusion receipt/i);
    expect((await refs().queueRef.get()).data().status).toBe("publishing");
    expect((await refs().pageRef.get()).data()).toMatchObject({
      publishBuildPending: true,
      publishBuildQueueId: QUEUE_ID,
    });
  });

  it("refuses a queue whose artifact binding changes after inclusion", async () => {
    await seedDeploying();
    await recordCmsPublishArtifactInclusion({
      firestore: db,
      queueId: QUEUE_ID,
      artifactReceipt: artifactReceipt(),
    });
    await activate();
    await refs().queueRef.update({
      "artifactBuild.cutoffAt": admin.firestore.Timestamp.fromMillis(
        cutoffAt.toMillis() + 1,
      ),
    });

    await expect(settleCmsPublishQueueFromPublicDeployment({
      firestore: db,
      queueId: QUEUE_ID,
    })).rejects.toThrow(/terminal evidence/i);
    expect((await refs().queueRef.get()).data().status).toBe("publishing");
  });

  it("refuses an impossible publish-to-visible interval", async () => {
    await seedDeploying();
    await recordCmsPublishArtifactInclusion({
      firestore: db,
      queueId: QUEUE_ID,
      artifactReceipt: artifactReceipt(),
    });
    await activate();
    await refs().queueRef.update({
      triggeredAt: admin.firestore.Timestamp.fromMillis(Date.now() + 60_000),
    });

    await expect(settleCmsPublishQueueFromPublicDeployment({
      firestore: db,
      queueId: QUEUE_ID,
    })).rejects.toThrow(/timing receipt/i);
    expect((await refs().queueRef.get()).data().status).toBe("publishing");
  });

  it("returns the stored receipt on a terminal queue retry", async () => {
    await seedDeploying();
    await recordCmsPublishArtifactInclusion({
      firestore: db,
      queueId: QUEUE_ID,
      artifactReceipt: artifactReceipt(),
    });
    await activate();
    const first = await settleCmsPublishQueueFromPublicDeployment({
      firestore: db,
      queueId: QUEUE_ID,
    });
    const retry = await settleCmsPublishQueueFromPublicDeployment({
      firestore: db,
      queueId: QUEUE_ID,
    });

    expect(retry).toEqual({ ...first, idempotent: true });
  });
});
