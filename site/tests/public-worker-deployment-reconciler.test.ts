// @vitest-environment node

import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import {
  reconcilePublicWorkerDeployment,
} from "../scripts/reconcile-public-worker-deployment";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const WORKER_NAME = "njpbs-production";
const WORKER_TAG = "d".repeat(32);
const TRIGGER_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const PREDECESSOR_DEPLOYMENT_ID =
  "44444444-4444-4444-8444-444444444444";
const PREDECESSOR_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const TOKEN = "t".repeat(40);
const COMMIT_SHA = "a".repeat(40);
const timestamp = {
  toMillis: () => Date.parse("2026-08-28T20:00:00.000Z"),
};

const publication = {
  schemaVersion: 1 as const,
  digestAlgorithm: "sha256" as const,
  buildBatchId: "build-one",
  generation: 10,
  commitSha: COMMIT_SHA,
  artifactDigest: "b".repeat(64),
  artifactReceiptDigest: "c".repeat(64),
  mediaManifestDigest: "d".repeat(64),
};
const publicationBytes = `${JSON.stringify(publication, null, 2)}\n`;
const publicationReceiptDigest = createHash("sha256")
  .update(publicationBytes)
  .digest("hex");

function state() {
  return {
    lease: {
      schemaVersion: 1 as const,
      buildBatchId: publication.buildBatchId,
      generation: publication.generation,
      commitSha: publication.commitSha,
      leaseToken: "lease-one",
      leaseAcquiredAt: timestamp,
      predecessorGeneration: 9,
      predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
      predecessorCommitSha: "f".repeat(40),
    },
    candidate: {
      schemaVersion: 1 as const,
      buildBatchId: publication.buildBatchId,
      generation: publication.generation,
      commitSha: publication.commitSha,
      workerName: WORKER_NAME,
      workerVersionId: VERSION_ID,
      workerVersionTag: `cms-g10-${publication.artifactDigest.slice(0, 16)}`,
      versionCreatedOn: "2026-08-28T20:00:00.000Z",
      artifactDigest: publication.artifactDigest,
      artifactReceiptDigest: publication.artifactReceiptDigest,
      publicationReceiptDigest,
      mediaManifestDigest: publication.mediaManifestDigest,
      artifactFileCount: 100,
      artifactBytes: 1_000_000,
      wranglerVersion: "4.123.0",
      recordedAt: timestamp,
    },
  };
}

function workersResponse() {
  return {
    success: true,
    result: [{ id: WORKER_NAME, tag: WORKER_TAG }],
  };
}

function triggersResponse(overrides = {}) {
  return {
    success: true,
    result: [{
      trigger_uuid: TRIGGER_ID,
      external_script_id: WORKER_TAG,
      deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
      root_directory: "/",
      branch_includes: ["production"],
      branch_excludes: [],
      ...overrides,
    }],
  };
}

function deploymentsResponse(
  versionId = VERSION_ID,
  deploymentId = DEPLOYMENT_ID,
) {
  return {
    success: true,
    result: {
      deployments: [{
        id: deploymentId,
        source: "api",
        strategy: "percentage",
        annotations: { "workers/triggered_by": "deployment" },
        versions: [{ version_id: versionId, percentage: 100 }],
        created_on: "2026-08-28T20:01:00.000Z",
      }],
    },
  };
}

function requestQueue(responses: unknown[]) {
  const requestJson = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) requestJson.mockRejectedValueOnce(response);
    else requestJson.mockResolvedValueOnce(response);
  }
  return requestJson;
}

// Database boundary for a production-target candidate with no admitted Post
// owners. These reads never contact Firestore or supply a publication decision.
const firestore = {
  projectId: "njpbs-site",
  doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
  collection: () => ({ get: async () => ({ docs: [], empty: true, size: 0 }) }),
} as unknown as Firestore;

function fixture(overrides: Record<string, unknown> = {}) {
  const requestJson = requestQueue([
    workersResponse(),
    triggersResponse(),
    deploymentsResponse(),
    triggersResponse(),
  ]);
  const requestPublication = vi.fn(async () => publicationBytes);
  const settleOutcome = vi.fn(async ({ evidence }) => {
    const outcome: "deployed" | "reconciling" =
      evidence.action === "activate" ? "deployed" : "reconciling";
    return {
      outcome,
      idempotent: false,
      receipt: { buildBatchId: publication.buildBatchId },
    };
  });
  const input = {
    firestore,
    cloudflareApiToken: TOKEN,
    readState: vi.fn(async () => state()),
    requestJson,
    requestPublication,
    settleOutcome,
    ...overrides,
  };
  return {
    input,
    requestJson: input.requestJson as typeof requestJson,
    requestPublication: input.requestPublication as typeof requestPublication,
    settleOutcome: input.settleOutcome as typeof settleOutcome,
  };
}

describe("public Worker deployment reconciler", () => {
  it("does no provider work while the coordinator is idle", async () => {
    const caseFixture = fixture({ readState: vi.fn(async () => null) });

    await expect(reconcilePublicWorkerDeployment(caseFixture.input))
      .resolves.toEqual({ outcome: "idle", idempotent: true });
    expect(caseFixture.requestJson).not.toHaveBeenCalled();
    expect(caseFixture.requestPublication).not.toHaveBeenCalled();
    expect(caseFixture.settleOutcome).not.toHaveBeenCalled();
  });

  it("settles only the exact active candidate with its public receipt", async () => {
    const caseFixture = fixture();

    await expect(reconcilePublicWorkerDeployment(caseFixture.input))
      .resolves.toMatchObject({ outcome: "deployed" });
    expect(caseFixture.requestJson.mock.calls.map(([request]) => request.url))
      .toEqual([
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/builds/workers/${WORKER_TAG}/triggers`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/builds/workers/${WORKER_TAG}/triggers`,
      ]);
    expect(caseFixture.requestJson.mock.calls.every(
      ([request]) => request.method === "GET" && request.token === TOKEN,
    )).toBe(true);
    expect(caseFixture.requestPublication).toHaveBeenCalledWith(
      `https://njpbs.org/_publication.json?candidate=${publication.buildBatchId}&version=${VERSION_ID}`,
    );
    expect(caseFixture.settleOutcome.mock.calls[0][0].evidence).toEqual({
      action: "activate",
      buildBatchId: publication.buildBatchId,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
    });
  });

  it("keeps an exact predecessor active result fenced", async () => {
    const caseFixture = fixture({
      requestJson: requestQueue([
        workersResponse(),
        triggersResponse(),
        deploymentsResponse(
          PREDECESSOR_VERSION_ID,
          PREDECESSOR_DEPLOYMENT_ID,
        ),
      ]),
    });

    await expect(reconcilePublicWorkerDeployment(caseFixture.input))
      .resolves.toMatchObject({ outcome: "reconciling" });
    expect(caseFixture.requestPublication).not.toHaveBeenCalled();
    expect(caseFixture.settleOutcome.mock.calls[0][0].evidence).toEqual({
      action: "reconcile",
    });
  });

  it("keeps a candidate with a mismatched public receipt fenced", async () => {
    const caseFixture = fixture({
      requestPublication: vi.fn(async () => `${publicationBytes}changed`),
    });

    await expect(reconcilePublicWorkerDeployment(caseFixture.input))
      .resolves.toMatchObject({ outcome: "reconciling" });
    expect(caseFixture.settleOutcome.mock.calls[0][0].evidence).toEqual({
      action: "reconcile",
    });
  });

  it("keeps provider errors fenced", async () => {
    const caseFixture = fixture({
      requestJson: requestQueue([new Error("connection reset")]),
    });

    await expect(reconcilePublicWorkerDeployment(caseFixture.input))
      .resolves.toMatchObject({ outcome: "reconciling" });
    expect(caseFixture.requestPublication).not.toHaveBeenCalled();
    expect(caseFixture.settleOutcome.mock.calls[0][0].evidence).toEqual({
      action: "reconcile",
    });
  });

  it("reapplies the fence when decisive settlement has an ambiguous response", async () => {
    const caseFixture = fixture();
    caseFixture.settleOutcome
      .mockRejectedValueOnce(new Error("ambiguous Firestore response"))
      .mockResolvedValueOnce({
        outcome: "reconciling",
        idempotent: false,
        receipt: { buildBatchId: publication.buildBatchId },
      });

    await expect(reconcilePublicWorkerDeployment(caseFixture.input))
      .resolves.toMatchObject({ outcome: "reconciling" });
    expect(caseFixture.settleOutcome).toHaveBeenCalledTimes(2);
    expect(caseFixture.settleOutcome.mock.calls[1][0].evidence).toEqual({
      action: "reconcile",
    });
  });
});
