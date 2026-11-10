import { describe, expect, it } from "vitest";
import activationModule from
  "../../functions/lib/public-worker-activation.js";
import cloudflareEvidenceModule from
  "../../functions/lib/public-deployment-cloudflare.js";

const {
  planPublicWorkerActivationEvidence,
  projectApiDeploymentStatus,
  projectWranglerDeploymentStatus,
} = activationModule;
const { projectPublicDeploymentCloudflareEvidence } = cloudflareEvidenceModule;

const BUILD_BATCH_ID = "build-one";
const COMMIT_SHA = "a".repeat(40);
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const timestamp = { toMillis: () => Date.parse("2026-08-27T20:00:00.000Z") };

function lease(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: 8,
    commitSha: COMMIT_SHA,
    leaseToken: "lease-one",
    leaseAcquiredAt: timestamp,
    predecessorGeneration: 0,
    predecessorDeploymentId: null,
    predecessorCommitSha: null,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: 8,
    commitSha: COMMIT_SHA,
    workerName: "njpbs-production",
    workerVersionId: VERSION_ID,
    workerVersionTag: `cms-g8-${"b".repeat(16)}`,
    versionCreatedOn: "2026-08-27T19:59:00.000Z",
    artifactDigest: "b".repeat(64),
    artifactReceiptDigest: "c".repeat(64),
    publicationReceiptDigest: "d".repeat(64),
    mediaManifestDigest: "e".repeat(64),
    artifactFileCount: 100,
    artifactBytes: 1_000_000,
    wranglerVersion: "4.123.0",
    recordedAt: timestamp,
    ...overrides,
  };
}

function status(overrides = {}) {
  return {
    id: DEPLOYMENT_ID,
    source: "wrangler",
    strategy: "percentage",
    author_email: "fixture-08a6ef6987@example.org",
    annotations: { "workers/triggered_by": "deployment" },
    versions: [{ version_id: VERSION_ID, percentage: 100 }],
    created_on: "2026-08-27T20:00:00.000Z",
    ...overrides,
  };
}

describe("public Worker activation evidence", () => {
  it("projects one exact 100-percent Wrangler deployment", () => {
    expect(projectWranglerDeploymentStatus(status())).toEqual({
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      createdOn: "2026-08-27T20:00:00.000Z",
    });
    const evidence = planPublicWorkerActivationEvidence({
      lease: lease(),
      candidate: candidate(),
      deploymentStatus: status(),
    });
    expect(evidence).toEqual({
      action: "activate",
      buildBatchId: BUILD_BATCH_ID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
    });
    expect(projectPublicDeploymentCloudflareEvidence(
      evidence,
      BUILD_BATCH_ID,
    )).toEqual(evidence);
  });

  it("projects one exact 100-percent API deployment only in API mode", () => {
    const apiStatus = status({ source: "api" });
    expect(projectApiDeploymentStatus(apiStatus)).toEqual({
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      createdOn: "2026-08-27T20:00:00.000Z",
    });
    expect(planPublicWorkerActivationEvidence({
      lease: lease(),
      candidate: candidate(),
      deploymentStatus: apiStatus,
      deploymentSource: "api",
    })).toEqual({
      action: "activate",
      buildBatchId: BUILD_BATCH_ID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
    });
    expect(planPublicWorkerActivationEvidence({
      lease: lease(),
      candidate: candidate(),
      deploymentStatus: apiStatus,
    })).toEqual({ action: "reconcile" });
    expect(planPublicWorkerActivationEvidence({
      lease: lease(),
      candidate: candidate(),
      deploymentStatus: status(),
      deploymentSource: "api",
    })).toEqual({ action: "reconcile" });
  });

  it.each([
    ["another version", status({
      versions: [{
        version_id: "33333333-3333-4333-8333-333333333333",
        percentage: 100,
      }],
    })],
    ["a gradual deployment", status({
      versions: [
        { version_id: VERSION_ID, percentage: 50 },
        {
          version_id: "33333333-3333-4333-8333-333333333333",
          percentage: 50,
        },
      ],
    })],
    ["an unknown trigger", status({
      annotations: { "workers/triggered_by": "rollback" },
    })],
    ["malformed JSON data", { active: VERSION_ID }],
  ])("keeps %s reconciling", (_label, deploymentStatus) => {
    expect(planPublicWorkerActivationEvidence({
      lease: lease(),
      candidate: candidate(),
      deploymentStatus,
    })).toEqual({ action: "reconcile" });
  });

  it("rejects a candidate that does not match the lease", () => {
    expect(() => planPublicWorkerActivationEvidence({
      lease: lease(),
      candidate: candidate({ commitSha: "f".repeat(40) }),
      deploymentStatus: status(),
    })).toThrow(/does not match/i);
  });

});
