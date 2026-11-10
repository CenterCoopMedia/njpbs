import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PublicWorkerActivationOperatorError,
  assertProductionFirestoreRouting,
  assertProductionWorkerSubdomainDisabled,
  assertProviderDeploymentPathsSerialized,
  assertUploadOnlyProductionTrigger,
  projectActivationOperatorResult,
  parseApplyArguments,
  requestPublicPublicationReceipt,
  runPublicWorkerActivationOperator,
} from "../../site/scripts/activate-public-worker-candidate";

const ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKER_NAME = "njpbs-production";
const WORKER_TAG = "d".repeat(32);
const TRIGGER_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const PREDECESSOR_DEPLOYMENT_ID =
  "44444444-4444-4444-8444-444444444444";
const COMMIT_SHA = "a".repeat(40);
const TOKEN = "t".repeat(40);
const timestamp = {
  toMillis: () => Date.parse("2026-08-27T20:00:00.000Z"),
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
const prepared = {
  ...publication,
  publicationReceiptDigest: createHash("sha256")
    .update(publicationBytes)
    .digest("hex"),
  artifactFileCount: 100,
  artifactBytes: 1_000_000,
};

function workersResponse() {
  return {
    success: true,
    result: [
      { id: WORKER_NAME, tag: WORKER_TAG },
      { id: "another-worker", tag: "e".repeat(32) },
    ],
  };
}

function triggersResponse(overrides = {}) {
  return {
    success: true,
    result: [{
      trigger_uuid: TRIGGER_ID,
      external_script_id: WORKER_TAG,
      trigger_name: "Deploy default branch",
      deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc",
      root_directory: "/",
      branch_includes: ["production"],
      branch_excludes: [],
      ...overrides,
    }],
  };
}

function deploymentStatus({
  deploymentId = DEPLOYMENT_ID,
  versionId = VERSION_ID,
} = {}) {
  return {
    id: deploymentId,
    source: "api",
    strategy: "percentage",
    annotations: { "workers/triggered_by": "deployment" },
    versions: [{ version_id: versionId, percentage: 100 }],
    created_on: "2026-08-27T20:01:00.000Z",
  };
}

function deploymentsResponse(options = {}) {
  return {
    success: true,
    result: { deployments: [deploymentStatus(options)] },
  };
}

function disabledSubdomainResponse(overrides = {}) {
  return {
    success: true,
    result: {
      enabled: false,
      previews_enabled: false,
      ...overrides,
    },
  };
}

function lease() {
  return {
    schemaVersion: 1,
    buildBatchId: prepared.buildBatchId,
    generation: prepared.generation,
    commitSha: prepared.commitSha,
    leaseToken: "lease-one",
    leaseAcquiredAt: timestamp,
    predecessorGeneration: 9,
    predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    predecessorCommitSha: "f".repeat(40),
  };
}

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: prepared.buildBatchId,
    generation: prepared.generation,
    commitSha: prepared.commitSha,
    workerName: WORKER_NAME,
    workerVersionId: VERSION_ID,
    workerVersionTag: `cms-g10-${prepared.artifactDigest.slice(0, 16)}`,
    versionCreatedOn: "2026-08-27T20:00:00.000Z",
    artifactDigest: prepared.artifactDigest,
    artifactReceiptDigest: prepared.artifactReceiptDigest,
    publicationReceiptDigest: prepared.publicationReceiptDigest,
    mediaManifestDigest: prepared.mediaManifestDigest,
    artifactFileCount: prepared.artifactFileCount,
    artifactBytes: prepared.artifactBytes,
    wranglerVersion: "4.123.0",
    recordedAt: timestamp,
    ...overrides,
  };
}

function acquired(overrides = {}) {
  return {
    outcome: "acquired" as const,
    idempotent: false,
    lease: lease(),
    candidate: candidate(),
    ...overrides,
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

function successfulSettlement(evidence: { action: string }) {
  return {
    outcome: evidence.action === "activate" ? "deployed" : "reconciling",
    idempotent: false,
    receipt: {
      buildBatchId: prepared.buildBatchId,
      generation: prepared.generation,
      commitSha: prepared.commitSha,
      ...(evidence.action === "activate"
        ? { deploymentId: DEPLOYMENT_ID, versionId: VERSION_ID }
        : { leaseToken: "lease-one" }),
    },
  };
}

function operator(overrides: Record<string, unknown> = {}) {
  const requestJson = requestQueue([
    workersResponse(),
    triggersResponse(),
    triggersResponse(),
    disabledSubdomainResponse(),
    { success: true, result: deploymentStatus() },
    deploymentsResponse(),
    triggersResponse(),
  ]);
  const acquireLeaseFn = vi.fn(async () => acquired());
  const settleOutcomeFn = vi.fn(async ({ evidence }) =>
    successfulSettlement(evidence));
  const requestPublication = vi.fn(async () => publicationBytes);
  const input = {
    firestore: {},
    cloudflareApiToken: TOKEN,
    preparedArtifact: prepared,
    requestJson,
    requestPublication,
    acquireLeaseFn,
    settleOutcomeFn,
    ...overrides,
  };
  return {
    input,
    requestJson: input.requestJson as typeof requestJson,
    requestPublication: input.requestPublication as typeof requestPublication,
    acquireLeaseFn: input.acquireLeaseFn as typeof acquireLeaseFn,
    settleOutcomeFn: input.settleOutcomeFn as typeof settleOutcomeFn,
  };
}

describe("upload-only production trigger gate", () => {
  it("accepts only the pinned upload-only production trigger", () => {
    expect(assertUploadOnlyProductionTrigger(triggersResponse(), WORKER_TAG))
      .toBe(TRIGGER_ID);

    for (const response of [
      triggersResponse({ deploy_command: "npx wrangler versions upload" }),
      triggersResponse({ deploy_command: "npx wrangler deploy" }),
      triggersResponse({ branch_includes: ["main"] }),
      triggersResponse({ branch_excludes: ["production"] }),
      triggersResponse({ external_script_id: "f".repeat(32) }),
      { success: true, result: [] },
      {
        success: true,
        result: [triggersResponse().result[0], triggersResponse().result[0]],
      },
    ]) {
      expect(() => assertUploadOnlyProductionTrigger(response, WORKER_TAG))
        .toThrow(PublicWorkerActivationOperatorError);
    }
  });

  it("accepts only a disabled production Worker subdomain", () => {
    expect(() => assertProductionWorkerSubdomainDisabled(
      disabledSubdomainResponse(),
    )).not.toThrow();

    for (const response of [
      disabledSubdomainResponse({ enabled: true }),
      disabledSubdomainResponse({ previews_enabled: true }),
      { success: false, result: { enabled: false, previews_enabled: false } },
    ]) {
      expect(() => assertProductionWorkerSubdomainDisabled(response))
        .toThrow(PublicWorkerActivationOperatorError);
    }
  });
});

describe("public Worker activation operator", () => {
  it("requests the exact public receipt with GET", async () => {
    const fetchMock = vi.fn(async () => new Response(publicationBytes, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-njpbs-publication-origin": "njpbs-production",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(requestPublicPublicationReceipt(
        "https://njpbs.org/_publication.json?candidate=build-one",
      )).resolves.toBe(publicationBytes);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "https://njpbs.org/_publication.json?candidate=build-one",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
        },
      }),
    );
  });

  it("refuses a receipt that does not prove the production Worker origin", async () => {
    for (const origin of [null, "github-pages", "NJPBS-production"]) {
      const headers: Record<string, string> = {
        "content-type": "application/json; charset=utf-8",
      };
      if (origin !== null) headers["x-njpbs-publication-origin"] = origin;
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(publicationBytes, { headers })
      ));

      await expect(requestPublicPublicationReceipt(
        "https://njpbs.org/_publication.json?candidate=build-one",
      )).rejects.toThrow(/receipt response is invalid/i);
      vi.unstubAllGlobals();
    }
  });

  it("activates one exact new lease and verifies its public receipt", async () => {
    const fixture = operator();
    const result = await runPublicWorkerActivationOperator(fixture.input);

    expect(result.outcome).toBe("deployed");
    expect(fixture.acquireLeaseFn).toHaveBeenCalledWith({
      firestore: {},
      buildBatchId: prepared.buildBatchId,
      commitSha: prepared.commitSha,
    });
    expect(fixture.requestJson).toHaveBeenCalledTimes(7);
    expect(fixture.requestJson.mock.calls.map(([request]) => request.url))
      .toEqual([
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/builds/workers/${WORKER_TAG}/triggers`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/builds/workers/${WORKER_TAG}/triggers`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/subdomain`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments`,
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/builds/workers/${WORKER_TAG}/triggers`,
      ]);
    expect(fixture.requestJson.mock.calls[3][0]).toMatchObject({
      method: "POST",
      token: TOKEN,
      body: { enabled: false, previews_enabled: false },
    });
    const deploymentRequest = fixture.requestJson.mock.calls[4][0];
    expect(deploymentRequest).toMatchObject({
      method: "POST",
      token: TOKEN,
      body: {
        strategy: "percentage",
        versions: [{ version_id: VERSION_ID, percentage: 100 }],
      },
    });
    for (const [{ url, token }] of fixture.requestJson.mock.calls) {
      expect(url).not.toContain(TOKEN);
      expect(token).toBe(TOKEN);
    }
    expect(fixture.requestPublication).toHaveBeenCalledWith(
      `https://njpbs.org/_publication.json?candidate=${prepared.buildBatchId}&version=${VERSION_ID}`,
    );
    expect(fixture.settleOutcomeFn).toHaveBeenCalledTimes(1);
    expect(fixture.settleOutcomeFn.mock.calls[0][0].evidence).toEqual({
      action: "activate",
      buildBatchId: prepared.buildBatchId,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
    });
  });

  it("refuses the current auto-deploy trigger before it acquires a lease", async () => {
    const fixture = operator({
      requestJson: requestQueue([
        workersResponse(),
        triggersResponse({ deploy_command: "npx wrangler deploy" }),
      ]),
    });

    await expect(runPublicWorkerActivationOperator(fixture.input))
      .rejects.toThrow(/upload-only/i);
    expect(fixture.acquireLeaseFn).not.toHaveBeenCalled();
    expect(fixture.settleOutcomeFn).not.toHaveBeenCalled();
  });

  it.each(["busy", "superseded"])(
    "returns %s without changing Cloudflare traffic",
    async (outcome) => {
      const fixture = operator({
        requestJson: requestQueue([workersResponse(), triggersResponse()]),
        acquireLeaseFn: vi.fn(async () => ({ outcome, idempotent: false })),
      });

      expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
        .toBe(outcome);
      expect(fixture.requestJson).toHaveBeenCalledTimes(2);
      expect(fixture.requestPublication).not.toHaveBeenCalled();
      expect(fixture.settleOutcomeFn).not.toHaveBeenCalled();
    },
  );

  it("fences under the lease when the provider trigger changes before deploy", async () => {
    const fixture = operator({
      requestJson: requestQueue([
        workersResponse(),
        triggersResponse(),
        triggersResponse({ deploy_command: "npx wrangler deploy" }),
      ]),
    });

    expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
      .toBe("reconciling");
    expect(fixture.requestJson.mock.calls.some(
      ([request]) => request.method === "POST",
    )).toBe(false);
    expect(fixture.requestPublication).not.toHaveBeenCalled();
    expect(fixture.settleOutcomeFn.mock.calls[0][0].evidence).toEqual({
      action: "reconcile",
    });
  });

  it("observes an exact retry without creating another deployment", async () => {
    const fixture = operator({
      requestJson: requestQueue([
        workersResponse(),
        triggersResponse(),
        deploymentsResponse(),
        triggersResponse(),
      ]),
      acquireLeaseFn: vi.fn(async () => acquired({ idempotent: true })),
    });

    expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
      .toBe("deployed");
    expect(fixture.requestJson).toHaveBeenCalledTimes(4);
    expect(fixture.requestJson.mock.calls.some(
      ([request]) => request.method === "POST",
    )).toBe(false);
  });

  it("fences a retry whose candidate is not authoritatively active", async () => {
    const fixture = operator({
      requestJson: requestQueue([
        workersResponse(),
        triggersResponse(),
        deploymentsResponse({
          deploymentId: PREDECESSOR_DEPLOYMENT_ID,
          versionId: "55555555-5555-4555-8555-555555555555",
        }),
      ]),
      acquireLeaseFn: vi.fn(async () => acquired({ idempotent: true })),
    });

    expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
      .toBe("reconciling");
    expect(fixture.requestJson.mock.calls.some(
      ([request]) => request.method === "POST",
    )).toBe(false);
    expect(fixture.requestPublication).not.toHaveBeenCalled();
    expect(fixture.settleOutcomeFn.mock.calls[0][0].evidence).toEqual({
      action: "reconcile",
    });
  });

  it("trusts exact active evidence after an ambiguous POST response", async () => {
    const fixture = operator({
      requestJson: requestQueue([
        workersResponse(),
        triggersResponse(),
        triggersResponse(),
        disabledSubdomainResponse(),
        new Error("connection reset"),
        deploymentsResponse(),
        triggersResponse(),
      ]),
    });

    expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
      .toBe("deployed");
    expect(fixture.settleOutcomeFn.mock.calls[0][0].evidence.action)
      .toBe("activate");
  });

  it("fences an exact version when the public receipt does not match", async () => {
    const fixture = operator({
      requestPublication: vi.fn(async () => `${publicationBytes}changed`),
    });

    expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
      .toBe("reconciling");
    expect(fixture.settleOutcomeFn.mock.calls[0][0].evidence).toEqual({
      action: "reconcile",
    });
  });

  it("fences when the production trigger changes before settlement", async () => {
    const fixture = operator({
      requestJson: requestQueue([
        workersResponse(),
        triggersResponse(),
        triggersResponse(),
        disabledSubdomainResponse(),
        { success: true, result: deploymentStatus() },
        deploymentsResponse(),
        triggersResponse({ deploy_command: "npx wrangler deploy" }),
      ]),
    });

    expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
      .toBe("reconciling");
    expect(fixture.settleOutcomeFn.mock.calls[0][0].evidence).toEqual({
      action: "reconcile",
    });
  });

  it("fences before traffic when the stored candidate differs from the artifact", async () => {
    const fixture = operator({
      acquireLeaseFn: vi.fn(async () => acquired({
        candidate: candidate({ artifactDigest: "f".repeat(64) }),
      })),
      requestJson: requestQueue([workersResponse(), triggersResponse()]),
    });

    expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
      .toBe("reconciling");
    expect(fixture.requestJson).toHaveBeenCalledTimes(2);
    expect(fixture.requestPublication).not.toHaveBeenCalled();
    expect(fixture.settleOutcomeFn.mock.calls[0][0].evidence).toEqual({
      action: "reconcile",
    });
  });

  it("attempts a reconciliation fence when active settlement fails", async () => {
    const fixture = operator();
    fixture.settleOutcomeFn
      .mockRejectedValueOnce(new Error("ambiguous Firestore response"))
      .mockResolvedValueOnce(successfulSettlement({ action: "reconcile" }));

    expect((await runPublicWorkerActivationOperator(fixture.input)).outcome)
      .toBe("reconciling");
    expect(fixture.settleOutcomeFn).toHaveBeenCalledTimes(2);
    expect(fixture.settleOutcomeFn.mock.calls[1][0].evidence).toEqual({
      action: "reconcile",
    });
  });
});

describe("activation operator output and credential boundary", () => {
  it("opens the production command after every provider path is serialized", () => {
    expect(() => assertProviderDeploymentPathsSerialized())
      .not.toThrow();
  });

  it("refuses Firestore emulator routing at the production command boundary", () => {
    expect(() => assertProductionFirestoreRouting({
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
    })).toThrow(/emulator route is not allowed/i);
    expect(() => assertProductionFirestoreRouting({
      FIRESTORE_EMULATOR_HOST: "",
    })).toThrow(/emulator route is not allowed/i);
    expect(() => assertProductionFirestoreRouting({})).not.toThrow();
  });

  it("projects only bounded public receipt fields", () => {
    expect(projectActivationOperatorResult({
      outcome: "deployed",
      idempotent: false,
      receipt: {
        buildBatchId: prepared.buildBatchId,
        generation: prepared.generation,
        commitSha: prepared.commitSha,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
        secret: TOKEN,
      },
    })).toEqual({
      outcome: "deployed",
      idempotent: false,
      buildBatchId: prepared.buildBatchId,
      generation: prepared.generation,
      commitSha: prepared.commitSha,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
    });
  });
  it("bounds explicit predecessor restore and preserves the ordinary apply command", () => {
    expect(parseApplyArguments(["--apply", "/tmp/prepared-worker.json"])).toEqual({ preparedArtifactPath: "/tmp/prepared-worker.json" });
    expect(parseApplyArguments(["--restore-predecessor", "cms-current", "cms-previous"]))
      .toEqual({ buildBatchId: "cms-current", predecessorBuildBatchId: "cms-previous" });
    for (const args of [["--restore-predecessor", "cms-current"], ["--restore-predecessor", "../escape", "cms-previous"],
      ["--restore-predecessor", "__reserved__", "cms-previous"], ["--restore-predecessor", "cms-current", "cms-previous", "extra"],
      ["--apply", "relative.json"], ["--apply", "/tmp/prepared.json", "extra"]]) {
      expect(() => parseApplyArguments(args)).toThrow(PublicWorkerActivationOperatorError);
    }
    expect(() => projectActivationOperatorResult({ outcome: "failed", idempotent: true,
      receipt: { restoredPredecessor: { secret: TOKEN } } })).toThrow();
  });

  it("keeps credentials out of argv, environment variables, and logs", () => {
    const source = readFileSync(
      new URL(
        "../../site/scripts/activate-public-worker-candidate.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("assertProductionFirestoreRouting(process.env)");
    expect(source.indexOf("assertProductionFirestoreRouting(process.env)"))
      .toBeLessThan(source.indexOf('readFileSync(3, "utf8")'));
    expect(source.indexOf("assertProviderDeploymentPathsSerialized()"))
      .toBeLessThan(source.indexOf('readFileSync(3, "utf8")'));
    expect(source).not.toContain("process.env.CLOUDFLARE");
    expect(source).not.toContain("process.env.GOOGLE");
    expect(source).not.toContain("console.log(cloudflareApiToken");
    expect(source).not.toContain("console.log(serviceAccount");
    expect(source).toContain("readFileSync(3");
    expect(source).toContain("readFileSync(4");
  });
});
