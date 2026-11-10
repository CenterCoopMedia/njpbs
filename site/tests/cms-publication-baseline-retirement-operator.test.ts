// @vitest-environment node

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import {
  assertApexDoesNotServeCandidate,
  assertNoApexCustomDomain,
  assertNoApexWildcardRoute,
  parseRetirementArguments,
  runCmsPublicationBaselineRetirement,
  runCmsPublicationBaselineRetirementCommand,
} from "../scripts/retire-cms-publication-baseline";
import {
  canonicalPublicationReceipt,
} from "../src/lib/public-publication-receipt";

const QUEUE_ID = "Apex0902Cutover00003";
const BUILD_BATCH_ID = `cms-${QUEUE_ID}`;
const GENERATION = 33;
const OPERATOR_COMMIT_SHA = "b".repeat(40);
const COMMIT_SHA = "f".repeat(40);
const DEPLOYMENT_ID = "8a30d4d0-3119-44ba-8239-5c60d053384f";
const VERSION_ID = "a3ccb239-88e5-43aa-8643-01c6616704a1";
const WORKER_TAG = "d".repeat(32);
const WORKER_TOKEN = "w".repeat(40);
const ROUTE_TOKEN = "r".repeat(40);
const CLAIM_TOKEN = "33333333-3333-4333-8333-333333333333";
const SERIALIZER_ID = "node-compute-primary";
const ARTIFACT_DIGEST = "c".repeat(64);
const ARTIFACT_RECEIPT_DIGEST = "d".repeat(64);
const MEDIA_MANIFEST_DIGEST = "1".repeat(64);
const CANDIDATE_PUBLICATION_BYTES = `${JSON.stringify(
  canonicalPublicationReceipt({
    schemaVersion: 1,
    digestAlgorithm: "sha256",
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: COMMIT_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    artifactReceiptDigest: ARTIFACT_RECEIPT_DIGEST,
    mediaManifestDigest: MEDIA_MANIFEST_DIGEST,
  }),
  null,
  2,
)}\n`;

interface TestCloudflareRequest {
  url: string;
  method: "GET" | "POST";
  token: string;
  body?: unknown;
}

interface TestSettlementInput {
  firestore: Firestore;
  lease: unknown;
  evidence: unknown;
}

function intent() {
  return {
    operatorCommitSha: OPERATOR_COMMIT_SHA,
    queueId: QUEUE_ID,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: COMMIT_SHA,
    deploymentId: DEPLOYMENT_ID,
    versionId: VERSION_ID,
    serializerId: SERIALIZER_ID,
  };
}

function lease() {
  return {
    schemaVersion: 1 as const,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: COMMIT_SHA,
    leaseToken: "22222222-2222-4222-8222-222222222222",
    leaseAcquiredAt: { toMillis: () => 1 },
    predecessorGeneration: 11,
    predecessorDeploymentId: "11111111-1111-4111-8111-111111111111",
    predecessorCommitSha: "a".repeat(40),
  };
}

function candidate() {
  return {
    schemaVersion: 1 as const,
    buildBatchId: BUILD_BATCH_ID,
    generation: GENERATION,
    commitSha: COMMIT_SHA,
    workerName: "njpbs-production",
    workerVersionId: VERSION_ID,
    workerVersionTag: `cms-g${GENERATION}-${ARTIFACT_DIGEST.slice(0, 16)}`,
    versionCreatedOn: "2026-09-02T23:31:30.000Z",
    artifactDigest: ARTIFACT_DIGEST,
    artifactReceiptDigest: ARTIFACT_RECEIPT_DIGEST,
    publicationReceiptDigest: createHash("sha256")
      .update(CANDIDATE_PUBLICATION_BYTES)
      .digest("hex"),
    mediaManifestDigest: MEDIA_MANIFEST_DIGEST,
    artifactFileCount: 2,
    artifactBytes: 1_000,
    wranglerVersion: "4.123.0",
    recordedAt: { toMillis: () => 2 },
  };
}

function state(
  phase: "reconciling" | "deployed" = "reconciling",
  retired = false,
) {
  return {
    phase,
    lease: lease(),
    candidate: candidate(),
    queue: {
      queue: { status: retired ? "cancelled" as const : "publishing" as const },
      receipt: retired ? { queueId: QUEUE_ID } : null,
    },
  };
}

function workersResponse() {
  return {
    success: true,
    result: [{ id: "njpbs-production", tag: WORKER_TAG }],
  };
}

function triggerResponse() {
  return {
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
}

function routeResponse(patterns = [
  "https://njpbs.org/contact",
  "https://njpbs.org/contact/*",
]) {
  return {
    success: true,
    result: patterns.map((pattern) => ({ pattern })),
  };
}

function customDomainResponse(hostnames = [
  "contact.njpbs.org",
  "preview.njpbs.org",
]) {
  return {
    success: true,
    result: hostnames.map((hostname) => ({ hostname })),
    result_info: {
      count: hostnames.length,
      page: 1,
      total_count: hostnames.length,
    },
  };
}

function deploymentsResponse(versionId = VERSION_ID) {
  return {
    success: true,
    result: {
      deployments: [{
        id: DEPLOYMENT_ID,
        source: "api",
        strategy: "percentage",
        annotations: { "workers/triggered_by": "deployment" },
        versions: [{ version_id: versionId, percentage: 100 }],
        created_on: "2026-09-02T23:32:00.000Z",
      }],
    },
  };
}

function publicationBytes(overrides = {}) {
  const receipt = canonicalPublicationReceipt({
    schemaVersion: 1,
    digestAlgorithm: "sha256",
    buildBatchId: "older-baseline",
    generation: 32,
    commitSha: "a".repeat(40),
    artifactDigest: "2".repeat(64),
    artifactReceiptDigest: "3".repeat(64),
    mediaManifestDigest: "4".repeat(64),
    ...overrides,
  });
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

function candidatePublicationBytes() {
  return CANDIDATE_PUBLICATION_BYTES;
}

function journal(job = true) {
  let retained = job ? {
    queueId: QUEUE_ID,
    buildBatchId: BUILD_BATCH_ID,
    commitSha: COMMIT_SHA,
    claimToken: CLAIM_TOKEN,
    createdAt: "2026-09-02T23:28:59.000Z",
  } : null;
  return {
    journalPath: "/var/lib/njpbs-cms-publisher/claim-journal.json",
    read: vi.fn(async () => retained),
    reserve: vi.fn(),
    clear: vi.fn(async () => {
      const idempotent = retained === null;
      retained = null;
      return { idempotent };
    }),
  };
}

function requestJsonFixture(options: {
  wildcardObservation?: number;
  customDomainObservation?: number;
  changedDeploymentObservation?: number;
} = {}) {
  const calls: TestCloudflareRequest[] = [];
  let observation = 0;
  const requestJson = vi.fn(async (
    request: TestCloudflareRequest,
  ): Promise<unknown> => {
    calls.push(request);
    expect(request.method).toBe("GET");
    if (String(request.url).endsWith("/workers/scripts")) {
      observation += 1;
      return workersResponse();
    }
    if (String(request.url).endsWith("/triggers")) return triggerResponse();
    if (String(request.url).endsWith("/workers/domains")) {
      expect(request.token).toBe(WORKER_TOKEN);
      return customDomainResponse(
        observation === options.customDomainObservation
          ? ["njpbs.org"]
          : undefined,
      );
    }
    if (String(request.url).endsWith("/workers/routes")) {
      expect(request.token).toBe(ROUTE_TOKEN);
      return routeResponse(
        observation === options.wildcardObservation
          ? ["https://njpbs.org/*"]
          : undefined,
      );
    }
    if (String(request.url).endsWith("/deployments")) {
      return deploymentsResponse(
        observation === options.changedDeploymentObservation
          ? "44444444-4444-4444-8444-444444444444"
          : VERSION_ID,
      );
    }
    throw new Error("unexpected Cloudflare request");
  });
  return { calls, requestJson };
}

function fixture(options: {
  requestJson?: ReturnType<typeof requestJsonFixture>["requestJson"];
  requestApex?: (url: string) => Promise<{
    body: string;
    publicationOrigin: string | null;
  }>;
} = {}) {
  const readState = vi.fn()
    .mockResolvedValueOnce(state("reconciling"))
    .mockResolvedValueOnce(state("deployed"))
    .mockResolvedValueOnce(state("deployed", true));
  const settleOutcome = vi.fn(async (_input: TestSettlementInput) => ({
    outcome: "deployed" as const,
    idempotent: false,
    receipt: {
      buildBatchId: BUILD_BATCH_ID,
      generation: GENERATION,
      commitSha: COMMIT_SHA,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
    },
  }));
  const retireQueue = vi.fn(async (_input: unknown) => ({
    outcome: "cancelled" as const,
    idempotent: false,
    receipt: {
      queueId: QUEUE_ID,
      buildBatchId: BUILD_BATCH_ID,
      generation: GENERATION,
      commitSha: COMMIT_SHA,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
    },
  }));
  return {
    readState,
    settleOutcome,
    retireQueue,
    requestJson: options.requestJson ?? requestJsonFixture().requestJson,
    requestApex: options.requestApex ?? vi.fn(async (_url: string) => ({
      body: publicationBytes(),
      publicationOrigin: null,
    })),
  };
}

describe("CMS publication baseline retirement provider gate", () => {
  it("accepts Contact-only routes and rejects a full apex wildcard", () => {
    expect(() => assertNoApexWildcardRoute(routeResponse())).not.toThrow();
    for (const pattern of [
      "https://njpbs.org/*",
      "njpbs.org/*",
      "https://*njpbs.org/*",
    ]) {
      expect(() => assertNoApexWildcardRoute(routeResponse([pattern])))
        .toThrow(/apex Worker route/i);
    }
  });

  it("requires a complete custom-domain list without the apex", () => {
    expect(() => assertNoApexCustomDomain(customDomainResponse())).not.toThrow();
    expect(() => assertNoApexCustomDomain(
      customDomainResponse(["njpbs.org"]),
    )).toThrow(/custom domain/i);
    expect(() => assertNoApexCustomDomain({
      ...customDomainResponse(),
      result_info: {
        ...customDomainResponse().result_info,
        total_count: 3,
      },
    })).toThrow(/incomplete/i);
  });

  it("requires a valid different canonical apex receipt", () => {
    expect(() => assertApexDoesNotServeCandidate({
      body: publicationBytes(),
      publicationOrigin: null,
    }, candidate())).not.toThrow();
    expect(() => assertApexDoesNotServeCandidate({
      body: "{}",
      publicationOrigin: null,
    }, candidate())).toThrow(/response is invalid/i);
    expect(() => assertApexDoesNotServeCandidate({
      body: candidatePublicationBytes(),
      publicationOrigin: null,
    }, candidate())).toThrow(/already public/i);
    expect(() => assertApexDoesNotServeCandidate({
      body: publicationBytes(),
      publicationOrigin: "njpbs-production",
    }, candidate())).toThrow(/already public/i);
  });

  it("uses only GET observations, then settles, cancels, and clears", async () => {
    const events: string[] = [];
    const provider = requestJsonFixture();
    const test = fixture({ requestJson: provider.requestJson });
    test.settleOutcome.mockImplementation(async () => {
      events.push("settle");
      return {
        outcome: "deployed",
        idempotent: false,
        receipt: {
          buildBatchId: BUILD_BATCH_ID,
          generation: GENERATION,
          commitSha: COMMIT_SHA,
          deploymentId: DEPLOYMENT_ID,
          versionId: VERSION_ID,
        },
      };
    });
    test.retireQueue.mockImplementation(async () => {
      events.push("retire");
      return {
        outcome: "cancelled",
        idempotent: false,
        receipt: {
          queueId: QUEUE_ID,
          buildBatchId: BUILD_BATCH_ID,
          generation: GENERATION,
          commitSha: COMMIT_SHA,
          deploymentId: DEPLOYMENT_ID,
          versionId: VERSION_ID,
        },
      };
    });
    const tokenJournal = journal();
    tokenJournal.clear.mockImplementation(async () => {
      events.push("clear");
      return { idempotent: false };
    });
    tokenJournal.read
      .mockResolvedValueOnce({
        queueId: QUEUE_ID,
        buildBatchId: BUILD_BATCH_ID,
        commitSha: COMMIT_SHA,
        claimToken: CLAIM_TOKEN,
        createdAt: "2026-09-02T23:28:59.000Z",
      })
      .mockResolvedValueOnce(null);

    const result = await runCmsPublicationBaselineRetirement({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      workerApiToken: WORKER_TOKEN,
      routeApiToken: ROUTE_TOKEN,
      dependencies: test,
    });

    expect(result).toMatchObject({
      outcome: "retired",
      idempotent: false,
      queueId: QUEUE_ID,
      generation: GENERATION,
    });
    expect(provider.requestJson).toHaveBeenCalledTimes(15);
    expect(provider.calls.every((request) => request.method === "GET"))
      .toBe(true);
    expect(test.requestApex).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["settle", "retire", "clear"]);
    expect(tokenJournal.clear).toHaveBeenCalledWith({
      queueId: QUEUE_ID,
      claimToken: CLAIM_TOKEN,
    });
  });

  it("leaves the queue and journal intact if the route changes after settlement", async () => {
    const provider = requestJsonFixture({ wildcardObservation: 3 });
    const test = fixture({ requestJson: provider.requestJson });
    const tokenJournal = journal();

    await expect(runCmsPublicationBaselineRetirement({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      workerApiToken: WORKER_TOKEN,
      routeApiToken: ROUTE_TOKEN,
      dependencies: test,
    })).rejects.toThrow(/apex Worker route/i);

    expect(test.settleOutcome).toHaveBeenCalledOnce();
    expect(test.retireQueue).not.toHaveBeenCalled();
    expect(tokenJournal.clear).not.toHaveBeenCalled();
  });

  it("leaves the queue and journal intact if an apex custom domain appears after settlement", async () => {
    const provider = requestJsonFixture({ customDomainObservation: 3 });
    const test = fixture({ requestJson: provider.requestJson });
    const tokenJournal = journal();

    await expect(runCmsPublicationBaselineRetirement({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      workerApiToken: WORKER_TOKEN,
      routeApiToken: ROUTE_TOKEN,
      dependencies: test,
    })).rejects.toThrow(/custom domain/i);

    expect(test.settleOutcome).toHaveBeenCalledOnce();
    expect(test.retireQueue).not.toHaveBeenCalled();
    expect(tokenJournal.clear).not.toHaveBeenCalled();
  });

  it("leaves the queue and journal intact if the active deployment changes after settlement", async () => {
    const provider = requestJsonFixture({ changedDeploymentObservation: 3 });
    const test = fixture({ requestJson: provider.requestJson });
    const tokenJournal = journal();

    await expect(runCmsPublicationBaselineRetirement({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      workerApiToken: WORKER_TOKEN,
      routeApiToken: ROUTE_TOKEN,
      dependencies: test,
    })).rejects.toThrow(/retirement target/i);

    expect(test.settleOutcome).toHaveBeenCalledOnce();
    expect(test.retireQueue).not.toHaveBeenCalled();
    expect(tokenJournal.clear).not.toHaveBeenCalled();
  });

  it("recovers a deployed batch whose empty queue and journal remain", async () => {
    const test = fixture();
    test.readState.mockReset()
      .mockResolvedValueOnce(state("deployed"))
      .mockResolvedValueOnce(state("deployed"))
      .mockResolvedValueOnce(state("deployed", true));
    test.settleOutcome.mockResolvedValue({
      outcome: "deployed",
      idempotent: true,
      receipt: {
        buildBatchId: BUILD_BATCH_ID,
        generation: GENERATION,
        commitSha: COMMIT_SHA,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
      },
    });
    const tokenJournal = journal();

    const result = await runCmsPublicationBaselineRetirement({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      workerApiToken: WORKER_TOKEN,
      routeApiToken: ROUTE_TOKEN,
      dependencies: test,
    });

    expect(result).toMatchObject({
      outcome: "retired",
      idempotent: false,
      queueIdempotent: false,
    });
    expect(test.settleOutcome).toHaveBeenCalledOnce();
    expect(test.settleOutcome.mock.calls[0][0].lease).toMatchObject({
      buildBatchId: BUILD_BATCH_ID,
      generation: GENERATION,
      commitSha: COMMIT_SHA,
      leaseToken: lease().leaseToken,
    });
    expect(test.retireQueue).toHaveBeenCalledOnce();
    expect(tokenJournal.clear).toHaveBeenCalledOnce();
  });

  it("does not settle when the apex response is not canonical", async () => {
    const test = fixture({
      requestApex: vi.fn(async () => ({
        body: "{}",
        publicationOrigin: null,
      })),
    });
    const tokenJournal = journal();

    await expect(runCmsPublicationBaselineRetirement({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      workerApiToken: WORKER_TOKEN,
      routeApiToken: ROUTE_TOKEN,
      dependencies: test,
    })).rejects.toThrow(/response is invalid/i);
    expect(test.settleOutcome).not.toHaveBeenCalled();
    expect(test.retireQueue).not.toHaveBeenCalled();
    expect(tokenJournal.clear).not.toHaveBeenCalled();
  });

  it("keeps a fully retired retry idempotent without provider access", async () => {
    const test = fixture();
    test.readState.mockReset()
      .mockResolvedValue(state("deployed", true));
    test.retireQueue.mockResolvedValue({
      outcome: "cancelled",
      idempotent: true,
      receipt: {
        queueId: QUEUE_ID,
        buildBatchId: BUILD_BATCH_ID,
        generation: GENERATION,
        commitSha: COMMIT_SHA,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
      },
    });

    const result = await runCmsPublicationBaselineRetirement({
      firestore: {} as Firestore,
      journal: journal(false),
      intent: intent(),
      workerApiToken: WORKER_TOKEN,
      routeApiToken: ROUTE_TOKEN,
      dependencies: test,
    });

    expect(result.idempotent).toBe(true);
    expect(test.requestJson).not.toHaveBeenCalled();
    expect(test.requestApex).not.toHaveBeenCalled();
    expect(test.settleOutcome).not.toHaveBeenCalled();
    expect(test.retireQueue).toHaveBeenCalledOnce();
  });

  it("clears the retained journal on a retry after queue retirement", async () => {
    const test = fixture();
    test.readState.mockReset()
      .mockResolvedValue(state("deployed", true));
    test.retireQueue.mockResolvedValue({
      outcome: "cancelled",
      idempotent: true,
      receipt: {
        queueId: QUEUE_ID,
        buildBatchId: BUILD_BATCH_ID,
        generation: GENERATION,
        commitSha: COMMIT_SHA,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
      },
    });
    const tokenJournal = journal();

    const result = await runCmsPublicationBaselineRetirement({
      firestore: {} as Firestore,
      journal: tokenJournal,
      intent: intent(),
      workerApiToken: WORKER_TOKEN,
      routeApiToken: ROUTE_TOKEN,
      dependencies: test,
    });

    expect(result).toMatchObject({
      idempotent: false,
      queueIdempotent: true,
      journalIdempotent: false,
    });
    expect(test.requestJson).not.toHaveBeenCalled();
    expect(test.settleOutcome).not.toHaveBeenCalled();
    expect(tokenJournal.clear).toHaveBeenCalledWith({
      queueId: QUEUE_ID,
      claimToken: CLAIM_TOKEN,
    });
  });
});

describe("CMS publication baseline retirement command", () => {
  it("parses the operator source separately from the retired target", () => {
    expect(parseRetirementArguments([
      "--apply",
      OPERATOR_COMMIT_SHA,
      QUEUE_ID,
      String(GENERATION),
      COMMIT_SHA,
      DEPLOYMENT_ID,
      VERSION_ID,
      SERIALIZER_ID,
    ])).toEqual(intent());
  });

  it("refuses emulator routing before lock, credential, or provider access", async () => {
    const dependencies = {
      assertLock: vi.fn(),
      readCredential: vi.fn(),
      requestJson: vi.fn(),
    };

    await expect(runCmsPublicationBaselineRetirementCommand([], dependencies, {
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    })).rejects.toThrow(/emulator route is not allowed/i);
    expect(dependencies.assertLock).not.toHaveBeenCalled();
    expect(dependencies.readCredential).not.toHaveBeenCalled();
    expect(dependencies.requestJson).not.toHaveBeenCalled();
  });

  it("keeps both Cloudflare credentials on separate descriptors behind the lock", () => {
    const wrapper = readFileSync(
      new URL(
        "../../scripts/retire-cms-publication-baseline.sh",
        import.meta.url,
      ),
      "utf8",
    );
    expect(wrapper).toContain("set -euo pipefail");
    expect(wrapper).toContain("umask 077");
    expect(wrapper).toContain("/usr/bin/flock --exclusive --nonblock 5");
    expect(wrapper).toContain(
      'exec 3<"$CREDENTIALS_DIRECTORY/cloudflare-api-token"',
    );
    expect(wrapper).toContain(
      'exec 4<"$CREDENTIALS_DIRECTORY/firebase-service-account"',
    );
    expect(wrapper).toContain(
      'exec 6<"$CREDENTIALS_DIRECTORY/cloudflare-route-read-token"',
    );
    expect(wrapper.indexOf("/usr/bin/flock")).toBeLessThan(
      wrapper.indexOf("exec 3<"),
    );
    expect(wrapper).not.toMatch(/exec .*CLOUDFLARE_API_TOKEN/);
  });


});
