import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { runPublicWorkerActivationOperator } from
  "../../site/scripts/activate-public-worker-candidate";
import { reconcilePublicWorkerDeployment } from
  "../../site/scripts/reconcile-public-worker-deployment";
import { createPublicArtifactInventoryReceipt } from
  "../../site/src/lib/public-artifact-inventory";

const requireModule = createRequire(import.meta.url);
const { acquirePublicDeploymentLease, reservePublicBuildBatch } = requireModule(
  "../../functions/lib/public-deployment-coordinator.js",
);
const { createPublicMediaManifest } = requireModule(
  "../../functions/lib/public-media-manifest.js",
);
const {
  markPublicMediaManifestReady,
  stagePublicMediaManifest,
} = requireModule("../../functions/lib/public-media-manifest-store.js");
const { recordPublicWorkerCandidate } = requireModule(
  "../../functions/lib/public-worker-candidate-store.js",
);
const { publicWorkerCandidateTag } = requireModule(
  "../../functions/lib/public-worker-candidate.js",
);

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const TOKEN = "t".repeat(40);
const COMMIT_SHA = "a".repeat(40);
const WORKER_TAG = "d".repeat(32);
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const DISABLED_SUBDOMAIN = {
  success: true,
  result: { enabled: false, previews_enabled: false },
};
let db: Firestore;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function readyCandidate() {
  const { batch } = await reservePublicBuildBatch({
    firestore: db,
    buildBatchId: "operator-store",
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

  const publication = {
    schemaVersion: 1 as const,
    digestAlgorithm: "sha256" as const,
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    artifactDigest: "b".repeat(64),
    artifactReceiptDigest: "c".repeat(64),
    mediaManifestDigest: manifest.mediaManifestDigest,
  };
  const publicationBytes = `${JSON.stringify(publication, null, 2)}\n`;
  const prepared = {
    ...publication,
    publicationReceiptDigest: createHash("sha256")
      .update(publicationBytes)
      .digest("hex"),
    artifactFileCount: 2,
    artifactBytes: 1_000,
  };
  await recordPublicWorkerCandidate({
    firestore: db,
    candidate: {
      schemaVersion: 1,
      buildBatchId: prepared.buildBatchId,
      generation: prepared.generation,
      commitSha: prepared.commitSha,
      workerName: "njpbs-production",
      workerVersionId: VERSION_ID,
      workerVersionTag: publicWorkerCandidateTag(prepared),
      versionCreatedOn: "2026-08-27T20:00:00.000Z",
      artifactDigest: prepared.artifactDigest,
      artifactReceiptDigest: prepared.artifactReceiptDigest,
      publicationReceiptDigest: prepared.publicationReceiptDigest,
      mediaManifestDigest: prepared.mediaManifestDigest,
      artifactFileCount: prepared.artifactFileCount,
      artifactBytes: prepared.artifactBytes,
      wranglerVersion: "4.123.0",
    },
  });
  return { prepared, publicationBytes };
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("public-worker-activation-operator-store.test.ts");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("public Worker activation operator store integration", () => {
  it("acquires, activates, verifies, and settles the exact ready generation", async () => {
    const { prepared, publicationBytes } = await readyCandidate();
    const responses = [
      {
        success: true,
        result: [{ id: "njpbs-production", tag: WORKER_TAG }],
      },
      {
        success: true,
        result: [{
          trigger_uuid: "11111111-1111-4111-8111-111111111111",
          external_script_id: WORKER_TAG,
          deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
          root_directory: "/",
          branch_includes: ["production"],
          branch_excludes: [],
        }],
      },
      {
        success: true,
        result: [{
          trigger_uuid: "11111111-1111-4111-8111-111111111111",
          external_script_id: WORKER_TAG,
          deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
          root_directory: "/",
          branch_includes: ["production"],
          branch_excludes: [],
        }],
      },
      DISABLED_SUBDOMAIN,
      { success: true, result: { id: DEPLOYMENT_ID } },
      {
        success: true,
        result: {
          deployments: [{
            id: DEPLOYMENT_ID,
            source: "api",
            strategy: "percentage",
            annotations: { "workers/triggered_by": "deployment" },
            versions: [{ version_id: VERSION_ID, percentage: 100 }],
            created_on: "2026-08-27T20:01:00.000Z",
          }],
        },
      },
      {
        success: true,
        result: [{
          trigger_uuid: "11111111-1111-4111-8111-111111111111",
          external_script_id: WORKER_TAG,
          deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
          root_directory: "/",
          branch_includes: ["production"],
          branch_excludes: [],
        }],
      },
    ];
    const requestJson = vi.fn();
    for (const response of responses) {
      requestJson.mockResolvedValueOnce(response);
    }

    const result = await runPublicWorkerActivationOperator({
      firestore: db,
      cloudflareApiToken: TOKEN,
      preparedArtifact: prepared,
      requestJson,
      requestPublication: vi.fn(async () => publicationBytes),
    });

    expect(result).toMatchObject({
      outcome: "deployed",
      idempotent: false,
      receipt: {
        buildBatchId: prepared.buildBatchId,
        generation: prepared.generation,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
      },
    });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "idle",
        mediaLifecycleReady: false,
        activeGeneration: prepared.generation,
        activeDeploymentId: DEPLOYMENT_ID,
        activeCommitSha: COMMIT_SHA,
        newestEligibleGeneration: prepared.generation,
        newestEligibleBuildBatchId: prepared.buildBatchId,
      });
    expect((await db.collection("system").doc("publicDeployment")
      .collection("buildBatches").doc(prepared.buildBatchId).get()).data())
      .toMatchObject({
        status: "deployed",
        deploymentId: DEPLOYMENT_ID,
        deploymentVersionId: VERSION_ID,
      });
  });

  it("recovers an ambiguous activation from the exact stored lease", async () => {
    const { prepared, publicationBytes } = await readyCandidate();
    const trigger = {
      success: true,
      result: [{
        trigger_uuid: "11111111-1111-4111-8111-111111111111",
        external_script_id: WORKER_TAG,
        deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
        root_directory: "/",
        branch_includes: ["production"],
        branch_excludes: [],
      }],
    };
    const workers = {
      success: true,
      result: [{ id: "njpbs-production", tag: WORKER_TAG }],
    };
    const deployment = (deploymentId: string, versionId: string) => ({
      success: true,
      result: {
        deployments: [{
          id: deploymentId,
          source: "api",
          strategy: "percentage",
          annotations: { "workers/triggered_by": "deployment" },
          versions: [{ version_id: versionId, percentage: 100 }],
          created_on: "2026-08-27T20:01:00.000Z",
        }],
      },
    });
    const activationRequest = vi.fn();
    for (const response of [
      workers,
      trigger,
      trigger,
      DISABLED_SUBDOMAIN,
      { success: true, result: { id: DEPLOYMENT_ID } },
      deployment(
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
      ),
    ]) {
      activationRequest.mockResolvedValueOnce(response);
    }

    await expect(runPublicWorkerActivationOperator({
      firestore: db,
      cloudflareApiToken: TOKEN,
      preparedArtifact: prepared,
      requestJson: activationRequest,
      requestPublication: vi.fn(async () => publicationBytes),
    })).resolves.toMatchObject({ outcome: "reconciling" });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "reconciling",
        candidateBuildBatchId: prepared.buildBatchId,
        activeGeneration: 0,
      });

    const reconciliationRequest = vi.fn();
    for (const response of [
      workers,
      trigger,
      deployment(DEPLOYMENT_ID, VERSION_ID),
      trigger,
    ]) {
      reconciliationRequest.mockResolvedValueOnce(response);
    }
    await expect(reconcilePublicWorkerDeployment({
      firestore: db,
      cloudflareApiToken: TOKEN,
      requestJson: reconciliationRequest,
      requestPublication: vi.fn(async () => publicationBytes),
    })).resolves.toMatchObject({
      outcome: "deployed",
      receipt: {
        buildBatchId: prepared.buildBatchId,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
      },
    });
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "idle",
        activeGeneration: prepared.generation,
        activeDeploymentId: DEPLOYMENT_ID,
        activeCommitSha: COMMIT_SHA,
      });
  });

  it("recovers a deploying lease without creating another deployment", async () => {
    const { prepared, publicationBytes } = await readyCandidate();
    await expect(acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: prepared.buildBatchId,
      commitSha: prepared.commitSha,
    })).resolves.toMatchObject({
      outcome: "acquired",
      idempotent: false,
      lease: { buildBatchId: prepared.buildBatchId },
    });
    const requestJson = vi.fn();
    for (const response of [
      {
        success: true,
        result: [{ id: "njpbs-production", tag: WORKER_TAG }],
      },
      {
        success: true,
        result: [{
          trigger_uuid: "11111111-1111-4111-8111-111111111111",
          external_script_id: WORKER_TAG,
          deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
          root_directory: "/",
          branch_includes: ["production"],
          branch_excludes: [],
        }],
      },
      {
        success: true,
        result: {
          deployments: [{
            id: DEPLOYMENT_ID,
            source: "api",
            strategy: "percentage",
            annotations: { "workers/triggered_by": "deployment" },
            versions: [{ version_id: VERSION_ID, percentage: 100 }],
            created_on: "2026-08-27T20:01:00.000Z",
          }],
        },
      },
      {
        success: true,
        result: [{
          trigger_uuid: "11111111-1111-4111-8111-111111111111",
          external_script_id: WORKER_TAG,
          deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
          root_directory: "/",
          branch_includes: ["production"],
          branch_excludes: [],
        }],
      },
    ]) {
      requestJson.mockResolvedValueOnce(response);
    }

    await expect(reconcilePublicWorkerDeployment({
      firestore: db,
      cloudflareApiToken: TOKEN,
      requestJson,
      requestPublication: vi.fn(async () => publicationBytes),
    })).resolves.toMatchObject({ outcome: "deployed" });
    expect(requestJson.mock.calls.every(
      ([request]) => request.method === "GET",
    )).toBe(true);
    expect((await db.collection("system").doc("publicDeployment").get()).data())
      .toMatchObject({
        state: "idle",
        activeGeneration: prepared.generation,
        activeDeploymentId: DEPLOYMENT_ID,
      });
  });

  it("rejects a tampered pointer lease before any provider request", async () => {
    const { prepared } = await readyCandidate();
    await acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: prepared.buildBatchId,
      commitSha: prepared.commitSha,
    });
    await db.collection("system").doc("publicDeployment").update({
      leaseToken: "tampered-lease",
    });
    const requestJson = vi.fn();

    await expect(reconcilePublicWorkerDeployment({
      firestore: db,
      cloudflareApiToken: TOKEN,
      requestJson,
      requestPublication: vi.fn(),
    })).rejects.toThrow(/reconciliation lease is invalid/i);
    expect(requestJson).not.toHaveBeenCalled();
  });
});
