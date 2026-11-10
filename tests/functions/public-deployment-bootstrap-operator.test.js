import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import operatorModule from "../../scripts/bootstrap-public-deployment.cjs";

const ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WORKER_NAME = "njpbs-production";
const WORKER_TAG = "d".repeat(32);
const BUILD_UUID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const COMMIT_SHA = "a".repeat(40);
const TOKEN = "t".repeat(40);
const {
  PublicDeploymentBootstrapOperatorError,
  parseApplyArguments,
  parseCloudflareToken,
  parseFirebaseServiceAccount,
  projectOperatorReceipt,
  runPublicDeploymentBootstrapOperator,
} = operatorModule;

function workersResponse(overrides = {}) {
  return {
    success: true,
    result: [
      { id: WORKER_NAME, tag: WORKER_TAG },
      { id: "another-worker", tag: "1".repeat(32) },
    ],
    ...overrides,
  };
}

function deployment({
  deploymentId = DEPLOYMENT_ID,
  versionId = VERSION_ID,
} = {}) {
  return {
    id: deploymentId,
    source: "wrangler",
    strategy: "percentage",
    created_on: "2026-08-27T17:56:07.218Z",
    annotations: { "workers/triggered_by": "deployment" },
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

function deploymentsResponse(options = {}) {
  return {
    success: true,
    result: { deployments: [deployment(options)] },
  };
}

function buildResult({
  buildUuid = BUILD_UUID,
  commitSha = COMMIT_SHA,
  externalScriptId = WORKER_TAG,
} = {}) {
  return {
    build_uuid: buildUuid,
    created_on: "2026-08-27T17:54:04.891Z",
    status: "stopped",
    build_outcome: "success",
    stopped_on: "2026-08-27T17:56:11.043Z",
    build_trigger_metadata: {
      branch: "production",
      commit_hash: commitSha,
    },
    trigger: { external_script_id: externalScriptId },
  };
}

function buildsByVersionResponse(
  versionId = VERSION_ID,
  options = {},
) {
  return {
    success: true,
    result: { builds: { [versionId]: buildResult(options) } },
  };
}

function requestQueue(responses) {
  const requestJson = vi.fn();
  for (const response of responses) {
    requestJson.mockResolvedValueOnce(response);
  }
  return requestJson;
}

function persistedReceipt(evidence, overrides = {}) {
  return {
    ...evidence,
    generation: 10,
    bootstrappedAt: { toMillis: () => Date.parse("2026-08-27T18:00:00.000Z") },
    ...overrides,
  };
}

describe("public deployment bootstrap operator input", () => {
  it("requires one explicit apply flag and full production commit", () => {
    expect(parseApplyArguments(["--apply", COMMIT_SHA])).toEqual({
      expectedCommitSha: COMMIT_SHA,
    });
    for (const value of [
      [],
      [COMMIT_SHA],
      ["--apply"],
      ["--apply", "short"],
      ["--apply", COMMIT_SHA, "extra"],
    ]) {
      expect(() => parseApplyArguments(value)).toThrow(
        PublicDeploymentBootstrapOperatorError,
      );
    }
  });

  it("reads only a bounded token first line", () => {
    expect(parseCloudflareToken(`${TOKEN}\nname: ignored metadata\n`)).toBe(
      TOKEN,
    );
    for (const value of ["", "short", `${"x".repeat(40)} bad`, "x".repeat(81)]) {
      expect(() => parseCloudflareToken(value)).toThrow(
        PublicDeploymentBootstrapOperatorError,
      );
    }
  });

  it("accepts only the NJ PBS Firebase project", () => {
    const account = {
      type: "service_account",
      project_id: "njpbs-site",
      client_email: "publisher@njpbs-site.iam.gserviceaccount.com",
      private_key: "test-key",
    };
    expect(parseFirebaseServiceAccount(JSON.stringify(account))).toEqual(
      account,
    );
    expect(() =>
      parseFirebaseServiceAccount(
        JSON.stringify({ ...account, project_id: "another-project" }),
      ),
    ).toThrow(PublicDeploymentBootstrapOperatorError);
    expect(() => parseFirebaseServiceAccount("not-json")).toThrow(
      PublicDeploymentBootstrapOperatorError,
    );
  });
});

describe("runPublicDeploymentBootstrapOperator", () => {
  it("settles one exact receipt and verifies Cloudflare again", async () => {
    const requestJson = requestQueue([
      workersResponse(),
      deploymentsResponse(),
      buildsByVersionResponse(),
      deploymentsResponse(),
      buildsByVersionResponse(),
    ]);
    const bootstrapFn = vi.fn(async ({ evidence }) => ({
      idempotent: false,
      receipt: persistedReceipt(evidence),
    }));

    const result = await runPublicDeploymentBootstrapOperator({
      firestore: { projectId: "demo" },
      cloudflareApiToken: TOKEN,
      expectedCommitSha: COMMIT_SHA,
      requestJson,
      bootstrapFn,
    });

    expect(result.idempotent).toBe(false);
    expect(result.receipt).toMatchObject({
      generation: 10,
      cloudflareBuildUuid: BUILD_UUID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
    });
    expect(bootstrapFn).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledTimes(5);
    expect(requestJson.mock.calls.map(([url]) => url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/builds/builds?version_ids=${VERSION_ID}`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments`,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/builds/builds?version_ids=${VERSION_ID}`,
    ]);
    for (const [url, token] of requestJson.mock.calls) {
      expect(url).not.toContain(TOKEN);
      expect(token).toBe(TOKEN);
    }
  });

  it("refuses an unexpected production commit before the Firestore write", async () => {
    const requestJson = requestQueue([
      workersResponse(),
      deploymentsResponse(),
      buildsByVersionResponse(),
    ]);
    const bootstrapFn = vi.fn();

    await expect(
      runPublicDeploymentBootstrapOperator({
        firestore: {},
        cloudflareApiToken: TOKEN,
        expectedCommitSha: "b".repeat(40),
        requestJson,
        bootstrapFn,
      }),
    ).rejects.toThrow("does not match the expected production commit");
    expect(bootstrapFn).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(3);
  });

  it("reports reconciliation when Cloudflare changes after the write", async () => {
    const nextVersionId = "44444444-4444-4444-8444-444444444444";
    const requestJson = requestQueue([
      workersResponse(),
      deploymentsResponse(),
      buildsByVersionResponse(),
      deploymentsResponse({
        deploymentId: "55555555-5555-4555-8555-555555555555",
        versionId: nextVersionId,
      }),
      buildsByVersionResponse(nextVersionId, {
        buildUuid: "66666666-6666-4666-8666-666666666666",
        commitSha: "c".repeat(40),
      }),
    ]);
    const bootstrapFn = vi.fn(async ({ evidence }) => ({
      idempotent: false,
      receipt: persistedReceipt(evidence),
    }));

    await expect(
      runPublicDeploymentBootstrapOperator({
        firestore: {},
        cloudflareApiToken: TOKEN,
        expectedCommitSha: COMMIT_SHA,
        requestJson,
        bootstrapFn,
      }),
    ).rejects.toThrow("changed during bootstrap; reconciliation is required");
    expect(bootstrapFn).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledTimes(5);
  });

  it("reports reconciliation when the post-write provider read fails", async () => {
    const requestJson = requestQueue([
      workersResponse(),
      deploymentsResponse(),
      buildsByVersionResponse(),
    ]);
    requestJson.mockRejectedValueOnce(new Error("provider unavailable"));
    const bootstrapFn = vi.fn(async ({ evidence }) => ({
      idempotent: false,
      receipt: persistedReceipt(evidence),
    }));

    await expect(
      runPublicDeploymentBootstrapOperator({
        firestore: {},
        cloudflareApiToken: TOKEN,
        expectedCommitSha: COMMIT_SHA,
        requestJson,
        bootstrapFn,
      }),
    ).rejects.toThrow("reconciliation is required");
    expect(bootstrapFn).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledTimes(4);
  });

  it("rejects a missing or duplicate named Worker", async () => {
    for (const result of [
      [],
      [
        { id: WORKER_NAME, tag: WORKER_TAG },
        { id: WORKER_NAME, tag: WORKER_TAG },
      ],
    ]) {
      const requestJson = requestQueue([workersResponse({ result })]);
      await expect(
        runPublicDeploymentBootstrapOperator({
          firestore: {},
          cloudflareApiToken: TOKEN,
          expectedCommitSha: COMMIT_SHA,
          requestJson,
          bootstrapFn: vi.fn(),
        }),
      ).rejects.toThrow("Worker identity is invalid");
    }
  });
});

describe("public deployment bootstrap operator output", () => {
  it("projects no credential material", () => {
    const receipt = persistedReceipt({
      schemaVersion: 1,
      workerName: WORKER_NAME,
      buildBatchId: `bootstrap:${BUILD_UUID}`,
      cloudflareBuildUuid: BUILD_UUID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
      branch: "production",
      externalScriptId: WORKER_TAG,
      buildCreatedOn: "2026-08-27T17:54:04.891Z",
      buildStoppedOn: "2026-08-27T17:56:11.043Z",
      deploymentCreatedOn: "2026-08-27T17:56:07.218Z",
      evidenceDigest: "d".repeat(64),
    });

    expect(projectOperatorReceipt({ idempotent: false, receipt })).toEqual({
      idempotent: false,
      generation: 10,
      workerName: WORKER_NAME,
      buildBatchId: `bootstrap:${BUILD_UUID}`,
      cloudflareBuildUuid: BUILD_UUID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
      evidenceDigest: "d".repeat(64),
      bootstrappedAt: "2026-08-27T18:00:00.000Z",
    });
  });

  it("keeps credentials out of environment variables and logs", () => {
    const source = readFileSync(
      new URL("../../scripts/bootstrap-public-deployment.cjs", import.meta.url),
      "utf8",
    );
    const environmentReads = [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(match => match[1]);
    expect(environmentReads.sort()).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_PUBLIC_WORKER_TAG"]);
    const withoutSettings = source.replace(/process\.env\.(?:CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_PUBLIC_WORKER_TAG)\b/g, "");
    expect(withoutSettings).not.toMatch(/process\s*(?:\.\s*env|\[\s*["']env["']\s*\])/);
    expect(source).not.toContain("console.log(cloudflareApiToken");
    expect(source).not.toContain("console.log(serviceAccount");
    expect(source).toContain("readFileSync(3");
    expect(source).toContain("readFileSync(4");
  });
});
