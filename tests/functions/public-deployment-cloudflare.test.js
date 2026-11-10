import { describe, expect, it } from "vitest";
import evidence from "../../functions/lib/public-deployment-cloudflare.js";

const {
  PublicDeploymentCloudflareEvidenceError,
  planPublicDeploymentCloudflareEvidence,
  projectCloudflareActiveDeploymentObservation,
  projectCloudflareBuildObservation,
  projectCloudflareVersionBuildObservation,
} = evidence;

const CANDIDATE_BUILD_UUID = "11111111-1111-4111-8111-111111111111";
const PREDECESSOR_BUILD_UUID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const PREDECESSOR_DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const CANDIDATE_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const PREDECESSOR_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const LEASE_TOKEN = "77777777-7777-4777-8777-777777777777";
const EXTERNAL_SCRIPT_ID = "dd7160bb9cef458093557736f4b9e75b";
const CANDIDATE_COMMIT_SHA = "c".repeat(40);
const PREDECESSOR_COMMIT_SHA = "b".repeat(40);
const CREATED_ON = "2026-08-14T18:00:00.000Z";

function timestamp(millis = Date.parse(CREATED_ON)) {
  return { toMillis: () => millis };
}

function lease(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: CANDIDATE_BUILD_UUID,
    generation: 8,
    commitSha: CANDIDATE_COMMIT_SHA,
    leaseToken: LEASE_TOKEN,
    leaseAcquiredAt: timestamp(),
    predecessorGeneration: 7,
    predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    predecessorCommitSha: PREDECESSOR_COMMIT_SHA,
    ...overrides,
  };
}

function buildResult(overrides = {}) {
  return {
    build_uuid: CANDIDATE_BUILD_UUID,
    created_on: CREATED_ON,
    status: "stopped",
    build_outcome: "success",
    stopped_on: "2026-08-14T18:05:00.000Z",
    build_trigger_metadata: {
      branch: "production",
      commit_hash: CANDIDATE_COMMIT_SHA,
    },
    trigger: {
      external_script_id: EXTERNAL_SCRIPT_ID,
    },
    ...overrides,
  };
}

function buildResponse(overrides = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: buildResult(overrides),
  };
}

function deployment(overrides = {}) {
  return {
    id: CANDIDATE_DEPLOYMENT_ID,
    created_on: CREATED_ON,
    strategy: "percentage",
    versions: [
      {
        percentage: 100,
        version_id: CANDIDATE_VERSION_ID,
      },
    ],
    ...overrides,
  };
}

function deploymentsResponse(overrides = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      deployments: [deployment(overrides)],
    },
  };
}

function emptyDeploymentsResponse() {
  return {
    success: true,
    errors: [],
    messages: [],
    result: { deployments: [] },
  };
}

function buildsByVersionResponse(
  versionId = CANDIDATE_VERSION_ID,
  result = buildResult(),
  overrides = {},
) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      builds: {
        [versionId]: result,
        ...overrides,
      },
    },
  };
}

function predecessorDeploymentResponse() {
  return deploymentsResponse({
    id: PREDECESSOR_DEPLOYMENT_ID,
    versions: [
      {
        percentage: 100,
        version_id: PREDECESSOR_VERSION_ID,
      },
    ],
  });
}

function predecessorVersionResponse(overrides = {}) {
  return buildsByVersionResponse(
    PREDECESSOR_VERSION_ID,
    buildResult({
      build_uuid: PREDECESSOR_BUILD_UUID,
      build_trigger_metadata: {
        branch: "production",
        commit_hash: PREDECESSOR_COMMIT_SHA,
      },
      ...overrides,
    }),
  );
}

function plan(overrides = {}) {
  return planPublicDeploymentCloudflareEvidence({
    lease: lease(),
    expectedBranch: "production",
    expectedExternalScriptId: EXTERNAL_SCRIPT_ID,
    buildResponse: buildResponse(),
    deploymentsResponse: deploymentsResponse(),
    buildsByVersionResponse: buildsByVersionResponse(),
    ...overrides,
  });
}

describe("Cloudflare deployment evidence projections", () => {
  it("projects only the known build identity and state fields", () => {
    expect(
      projectCloudflareBuildObservation(
        buildResponse({
          future_build_field: "ignored",
          build_trigger_metadata: {
            branch: "production",
            commit_hash: CANDIDATE_COMMIT_SHA,
            future_metadata_field: "ignored",
          },
          trigger: {
            external_script_id: EXTERNAL_SCRIPT_ID,
            future_trigger_field: "ignored",
          },
        }),
      ),
    ).toEqual({
      buildUuid: CANDIDATE_BUILD_UUID,
      commitSha: CANDIDATE_COMMIT_SHA,
      branch: "production",
      externalScriptId: EXTERNAL_SCRIPT_ID,
      status: "stopped",
      outcome: "success",
      createdOn: CREATED_ON,
      stoppedOn: "2026-08-14T18:05:00.000Z",
    });
  });

  it("projects only one exact active version at 100 percent", () => {
    expect(
      projectCloudflareActiveDeploymentObservation(
        deploymentsResponse({ future_deployment_field: "ignored" }),
      ),
    ).toEqual({
      deploymentId: CANDIDATE_DEPLOYMENT_ID,
      versionId: CANDIDATE_VERSION_ID,
      percentage: 100,
      createdOn: CREATED_ON,
    });
  });

  it("projects the build keyed by the requested version id", () => {
    expect(
      projectCloudflareVersionBuildObservation(
        buildsByVersionResponse(),
        CANDIDATE_VERSION_ID,
      ),
    ).toEqual(projectCloudflareBuildObservation(buildResponse()));
  });

  it.each([
    buildResponse({ build_uuid: "not-a-uuid" }),
    buildResponse({ created_on: "not-a-date" }),
    buildResponse({ created_on: "2026-08-14" }),
    buildResponse({ created_on: "2026-02-31T18:00:00Z" }),
    buildResponse({ created_on: "2025-02-29T18:00:00-05:00" }),
    buildResponse({ stopped_on: "2026-08-14T18:05:00" }),
    buildResponse({ status: "future-status" }),
    buildResponse({ build_outcome: "future-outcome" }),
    buildResponse({
      build_trigger_metadata: {
        branch: "production",
        commit_hash: "not-a-commit",
      },
    }),
    { success: false, result: null },
  ])("rejects malformed build evidence", (response) => {
    expect(() => projectCloudflareBuildObservation(response)).toThrow(
      PublicDeploymentCloudflareEvidenceError,
    );
  });

  it.each([
    deploymentsResponse({ versions: [] }),
    deploymentsResponse({
      versions: [
        { percentage: 50, version_id: CANDIDATE_VERSION_ID },
        { percentage: 50, version_id: PREDECESSOR_VERSION_ID },
      ],
    }),
    deploymentsResponse({
      versions: [{ percentage: 99.9, version_id: CANDIDATE_VERSION_ID }],
    }),
    deploymentsResponse({ created_on: "not-a-date" }),
    deploymentsResponse({ created_on: "2026-04-31T18:00:00Z" }),
    deploymentsResponse({ id: "not-a-uuid" }),
  ])("rejects ambiguous or malformed active deployment evidence", (response) => {
    expect(() =>
      projectCloudflareActiveDeploymentObservation(response),
    ).toThrow(PublicDeploymentCloudflareEvidenceError);
  });

  it("rejects absent, extra, and conflicting version mappings", () => {
    expect(() =>
      projectCloudflareVersionBuildObservation(
        buildsByVersionResponse(PREDECESSOR_VERSION_ID),
        CANDIDATE_VERSION_ID,
      ),
    ).toThrow(PublicDeploymentCloudflareEvidenceError);
    expect(() =>
      projectCloudflareVersionBuildObservation(
        buildsByVersionResponse(CANDIDATE_VERSION_ID, buildResult(), {
          [PREDECESSOR_VERSION_ID]: buildResult({
            build_uuid: PREDECESSOR_BUILD_UUID,
          }),
        }),
        CANDIDATE_VERSION_ID,
      ),
    ).toThrow(PublicDeploymentCloudflareEvidenceError);
  });
});

describe("Cloudflare public deployment evidence plan", () => {
  it("activates only when the active version maps exactly to the leased candidate", () => {
    expect(plan()).toEqual({
      action: "activate",
      buildBatchId: CANDIDATE_BUILD_UUID,
      deploymentId: CANDIDATE_DEPLOYMENT_ID,
      versionId: CANDIDATE_VERSION_ID,
      commitSha: CANDIDATE_COMMIT_SHA,
    });
  });

  it.each([
    undefined,
    null,
    { success: true, result: {} },
    buildResponse({ status: "queued", build_outcome: undefined }),
    buildResponse({ status: "running", build_outcome: undefined }),
  ])("lets exact active evidence win over a missing or stale build status", (response) => {
    expect(plan({ buildResponse: response })).toEqual({
      action: "activate",
      buildBatchId: CANDIDATE_BUILD_UUID,
      deploymentId: CANDIDATE_DEPLOYMENT_ID,
      versionId: CANDIDATE_VERSION_ID,
      commitSha: CANDIDATE_COMMIT_SHA,
    });
  });

  it.each([
    ["fail", "terminal-failure"],
    ["cancelled", "terminal-failure"],
    ["terminated", "terminal-failure"],
    ["skipped", "reconcile"],
    ["success", "reconcile"],
  ])("plans %s against the exact active predecessor as %s", (outcome, action) => {
    const response = buildResponse({ build_outcome: outcome });
    const expected =
      action === "terminal-failure"
        ? {
            action,
            buildBatchId: CANDIDATE_BUILD_UUID,
            outcome,
          }
        : { action };

    expect(
      plan({
        buildResponse: response,
        deploymentsResponse: predecessorDeploymentResponse(),
        buildsByVersionResponse: predecessorVersionResponse(),
      }),
    ).toEqual(expected);
  });

  it("keeps an active predecessor reconciling while the candidate is not stopped", () => {
    expect(
      plan({
        buildResponse: buildResponse({
          status: "running",
          build_outcome: undefined,
          stopped_on: undefined,
        }),
        deploymentsResponse: predecessorDeploymentResponse(),
        buildsByVersionResponse: predecessorVersionResponse(),
      }),
    ).toEqual({ action: "reconcile" });
  });

  it("keeps terminal candidate evidence reconciling when a leased predecessor is absent", () => {
    expect(
      plan({
        buildResponse: buildResponse({ build_outcome: "fail" }),
        deploymentsResponse: emptyDeploymentsResponse(),
        buildsByVersionResponse: undefined,
      }),
    ).toEqual({ action: "reconcile" });
  });

  it.each(["fail", "cancelled", "terminated"])(
    "settles first-deployment outcome %s when the active list is empty",
    (outcome) => {
      expect(
        plan({
          lease: lease({
            generation: 1,
            predecessorGeneration: 0,
            predecessorDeploymentId: null,
            predecessorCommitSha: null,
          }),
          buildResponse: buildResponse({ build_outcome: outcome }),
          deploymentsResponse: emptyDeploymentsResponse(),
          buildsByVersionResponse: undefined,
        }),
      ).toEqual({
        action: "terminal-failure",
        buildBatchId: CANDIDATE_BUILD_UUID,
        outcome,
      });
    },
  );

  it.each([
    ["build UUID", { build_uuid: PREDECESSOR_BUILD_UUID }],
    [
      "commit SHA",
      {
        build_trigger_metadata: {
          branch: "production",
          commit_hash: PREDECESSOR_COMMIT_SHA,
        },
      },
    ],
    [
      "branch",
      {
        build_trigger_metadata: {
          branch: "main",
          commit_hash: CANDIDATE_COMMIT_SHA,
        },
      },
    ],
    [
      "Worker tag",
      { trigger: { external_script_id: "another-worker-tag" } },
    ],
  ])("reconciles an active mapping with a mismatched %s", (_label, mismatch) => {
    expect(
      plan({
        buildsByVersionResponse: buildsByVersionResponse(
          CANDIDATE_VERSION_ID,
          buildResult(mismatch),
        ),
      }),
    ).toEqual({ action: "reconcile" });
  });

  it.each([
    deploymentsResponse({ versions: [] }),
    deploymentsResponse({
      versions: [
        { percentage: 50, version_id: CANDIDATE_VERSION_ID },
        { percentage: 50, version_id: PREDECESSOR_VERSION_ID },
      ],
    }),
    deploymentsResponse({
      versions: [{ percentage: 99.9, version_id: CANDIDATE_VERSION_ID }],
    }),
  ])("reconciles an ambiguous active deployment", (response) => {
    expect(plan({ deploymentsResponse: response })).toEqual({
      action: "reconcile",
    });
  });

  it.each([
    undefined,
    null,
    { success: false, result: null },
    buildsByVersionResponse(PREDECESSOR_VERSION_ID),
    buildsByVersionResponse(CANDIDATE_VERSION_ID, buildResult(), {
      [PREDECESSOR_VERSION_ID]: buildResult({
        build_uuid: PREDECESSOR_BUILD_UUID,
      }),
    }),
  ])("reconciles an absent or conflicting version mapping", (response) => {
    expect(plan({ buildsByVersionResponse: response })).toEqual({
      action: "reconcile",
    });
  });

  it.each([
    ["invalid candidate UUID", { lease: lease({ buildBatchId: "bad" }) }],
    [
      "invalid candidate commit",
      { lease: lease({ commitSha: PREDECESSOR_COMMIT_SHA }) },
    ],
    ["invalid deployment date", { deploymentsResponse: deploymentsResponse({ created_on: "bad" }) }],
    [
      "unknown mapped status",
      {
        buildsByVersionResponse: buildsByVersionResponse(
          CANDIDATE_VERSION_ID,
          buildResult({ status: "future-status" }),
        ),
      },
    ],
    ["Cloudflare API error", { deploymentsResponse: { success: false, result: null } }],
    [
      "a malformed lease timestamp",
      {
        lease: lease({
          leaseAcquiredAt: {
            toMillis: () => {
              throw new Error("malformed timestamp");
            },
          },
        }),
      },
    ],
  ])("reconciles %s", (_label, overrides) => {
    expect(plan(overrides)).toEqual({ action: "reconcile" });
  });

  it("does not release the fence for terminal candidate evidence against an unverified predecessor", () => {
    expect(
      plan({
        buildResponse: buildResponse({ build_outcome: "fail" }),
        deploymentsResponse: predecessorDeploymentResponse(),
        buildsByVersionResponse: predecessorVersionResponse({
          build_trigger_metadata: {
            branch: "production",
            commit_hash: "a".repeat(40),
          },
        }),
      }),
    ).toEqual({ action: "reconcile" });
  });
});
