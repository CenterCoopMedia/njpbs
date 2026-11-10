import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import bootstrapModule from "../../functions/lib/public-deployment-bootstrap.js";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const WORKER_NAME = "njpbs-production";
const BUILD_UUID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const EXTERNAL_SCRIPT_ID = "d".repeat(32);
const COMMIT_SHA = "a".repeat(40);
const BUILD_CREATED_ON = "2026-08-27T17:54:04.891Z";
const DEPLOYMENT_CREATED_ON = "2026-08-27T17:56:07.218Z";
const BUILD_STOPPED_ON = "2026-08-27T17:56:11.043Z";
const BOOTSTRAP_BUILD_BATCH_ID = `bootstrap:${BUILD_UUID}`;
const {
  PublicDeploymentBootstrapEvidenceError,
  bootstrapPublicDeployment,
  projectPublicDeploymentBootstrapEvidence,
} = bootstrapModule;
let db;

function buildResult(overrides = {}) {
  return {
    build_uuid: BUILD_UUID,
    created_on: BUILD_CREATED_ON,
    status: "stopped",
    build_outcome: "success",
    stopped_on: BUILD_STOPPED_ON,
    build_trigger_metadata: {
      branch: "production",
      commit_hash: COMMIT_SHA,
    },
    trigger: {
      external_script_id: EXTERNAL_SCRIPT_ID,
    },
    ...overrides,
  };
}

function deployment(overrides = {}) {
  return {
    id: DEPLOYMENT_ID,
    source: "wrangler",
    strategy: "percentage",
    created_on: DEPLOYMENT_CREATED_ON,
    annotations: {
      "workers/triggered_by": "deployment",
    },
    versions: [{ version_id: VERSION_ID, percentage: 100 }],
    ...overrides,
  };
}

function deploymentsResponse(overrides = {}) {
  return {
    success: true,
    result: { deployments: [deployment(overrides)] },
  };
}

function buildsByVersionResponse(result = buildResult(), overrides = {}) {
  return {
    success: true,
    result: {
      builds: {
        [VERSION_ID]: result,
        ...overrides,
      },
    },
  };
}

function evidence(overrides = {}) {
  return projectPublicDeploymentBootstrapEvidence({
    workerName: WORKER_NAME,
    expectedExternalScriptId: EXTERNAL_SCRIPT_ID,
    deploymentsResponse: deploymentsResponse(),
    buildsByVersionResponse: buildsByVersionResponse(),
    ...overrides,
  });
}

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function seedUnbootstrappedPointer(overrides = {}) {
  await db.collection("system").doc("publicDeployment").set({
    schemaVersion: 1,
    mediaLifecycleReady: false,
    state: "idle",
    activeGeneration: 0,
    activeDeploymentId: null,
    activeCommitSha: null,
    lastReservedGeneration: 9,
    newestEligibleGeneration: 0,
    newestEligibleBuildBatchId: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...overrides,
  });
}

async function storedPointer() {
  return (await db.collection("system").doc("publicDeployment").get()).data();
}

async function storedReceipt() {
  return (
    await db
      .collection("system")
      .doc("publicDeployment")
      .collection("bootstrapReceipts")
      .doc("initial")
      .get()
  ).data();
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("public-deployment-bootstrap.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("public deployment bootstrap evidence", () => {
  it("projects one successful Wrangler deployment and its exact build", () => {
    expect(
      evidence({
        deploymentsResponse: deploymentsResponse({ future_field: "ignored" }),
        buildsByVersionResponse: buildsByVersionResponse(
          buildResult({ future_field: "ignored" }),
        ),
      }),
    ).toEqual({
      schemaVersion: 1,
      workerName: WORKER_NAME,
      buildBatchId: BOOTSTRAP_BUILD_BATCH_ID,
      cloudflareBuildUuid: BUILD_UUID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
      branch: "production",
      externalScriptId: EXTERNAL_SCRIPT_ID,
      buildCreatedOn: BUILD_CREATED_ON,
      buildStoppedOn: BUILD_STOPPED_ON,
      deploymentCreatedOn: DEPLOYMENT_CREATED_ON,
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("accepts Cloudflare's deployment timestamp before its stopped timestamp", () => {
    expect(Date.parse(DEPLOYMENT_CREATED_ON)).toBeLessThan(
      Date.parse(BUILD_STOPPED_ON),
    );
    expect(evidence().deploymentId).toBe(DEPLOYMENT_ID);
  });

  it.each([
    ["another Worker", { workerName: "another-worker" }],
    [
      "another Worker tag",
      { expectedExternalScriptId: "another-worker-tag" },
    ],
    ["an API deployment", { deploymentsResponse: deploymentsResponse({ source: "api" }) }],
    [
      "an unknown trigger",
      {
        deploymentsResponse: deploymentsResponse({
          annotations: { "workers/triggered_by": "future-trigger" },
        }),
      },
    ],
    [
      "a non-production branch",
      {
        buildsByVersionResponse: buildsByVersionResponse(
          buildResult({
            build_trigger_metadata: {
              branch: "main",
              commit_hash: COMMIT_SHA,
            },
          }),
        ),
      },
    ],
    [
      "a running build",
      {
        buildsByVersionResponse: buildsByVersionResponse(
          buildResult({
            status: "running",
            build_outcome: undefined,
            stopped_on: undefined,
          }),
        ),
      },
    ],
    [
      "a failed build",
      {
        buildsByVersionResponse: buildsByVersionResponse(
          buildResult({ build_outcome: "fail" }),
        ),
      },
    ],
    [
      "a split deployment",
      {
        deploymentsResponse: deploymentsResponse({
          versions: [
            { version_id: VERSION_ID, percentage: 50 },
            {
              version_id: "44444444-4444-4444-8444-444444444444",
              percentage: 50,
            },
          ],
        }),
      },
    ],
  ])("rejects %s", (_label, overrides) => {
    expect(() => evidence(overrides)).toThrow(
      PublicDeploymentBootstrapEvidenceError,
    );
  });
});

describe("bootstrapPublicDeployment", () => {
  it("allocates the next generation and keeps media lifecycle changes blocked", async () => {
    await seedUnbootstrappedPointer();

    const result = await bootstrapPublicDeployment({
      firestore: db,
      evidence: evidence(),
    });

    expect(result.idempotent).toBe(false);
    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      generation: 10,
      buildBatchId: BOOTSTRAP_BUILD_BATCH_ID,
      deploymentId: DEPLOYMENT_ID,
      versionId: VERSION_ID,
      commitSha: COMMIT_SHA,
      workerName: WORKER_NAME,
    });
    expect(result.receipt.bootstrappedAt.toMillis()).toBeGreaterThan(0);
    expect(await storedReceipt()).toEqual(result.receipt);
    const pointer = await storedPointer();
    expect(pointer).toMatchObject({
      schemaVersion: 1,
      mediaLifecycleReady: false,
      state: "idle",
      activeGeneration: 10,
      activeDeploymentId: DEPLOYMENT_ID,
      activeCommitSha: COMMIT_SHA,
      lastReservedGeneration: 10,
      newestEligibleGeneration: 10,
      newestEligibleBuildBatchId: BOOTSTRAP_BUILD_BATCH_ID,
    });
    expect(pointer.updatedAt.toMillis()).toBe(
      result.receipt.bootstrappedAt.toMillis(),
    );
  });

  it("returns the immutable receipt after later reservations advance", async () => {
    await seedUnbootstrappedPointer();
    const first = await bootstrapPublicDeployment({
      firestore: db,
      evidence: evidence(),
    });
    await db.collection("system").doc("publicDeployment").update({
      lastReservedGeneration: 11,
    });

    const retry = await bootstrapPublicDeployment({
      firestore: db,
      evidence: evidence(),
    });

    expect(retry).toEqual({ idempotent: true, receipt: first.receipt });
    expect((await storedPointer()).lastReservedGeneration).toBe(11);
    expect((await storedReceipt()).bootstrappedAt.toMillis()).toBe(
      first.receipt.bootstrappedAt.toMillis(),
    );
  });

  it("serializes concurrent exact attempts to one generation", async () => {
    await seedUnbootstrappedPointer();

    const results = await Promise.all([
      bootstrapPublicDeployment({ firestore: db, evidence: evidence() }),
      bootstrapPublicDeployment({ firestore: db, evidence: evidence() }),
    ]);

    expect(results.map((result) => result.idempotent).sort()).toEqual([
      false,
      true,
    ]);
    expect(results[0].receipt).toEqual(results[1].receipt);
    expect((await storedPointer()).activeGeneration).toBe(10);
  });

  it("rejects a conflicting retry without changing the receipt", async () => {
    await seedUnbootstrappedPointer();
    const first = await bootstrapPublicDeployment({
      firestore: db,
      evidence: evidence(),
    });
    const conflicting = evidence({
      buildsByVersionResponse: buildsByVersionResponse(
        buildResult({
          build_trigger_metadata: {
            branch: "production",
            commit_hash: "b".repeat(40),
          },
        }),
      ),
    });

    await expect(
      bootstrapPublicDeployment({ firestore: db, evidence: conflicting }),
    ).rejects.toThrow("belongs to different Cloudflare evidence");
    expect(await storedReceipt()).toEqual(first.receipt);
  });

  it("rejects a retry after another deployment becomes active", async () => {
    await seedUnbootstrappedPointer();
    await bootstrapPublicDeployment({ firestore: db, evidence: evidence() });
    await db.collection("system").doc("publicDeployment").update({
      activeGeneration: 11,
      activeDeploymentId: "55555555-5555-4555-8555-555555555555",
      activeCommitSha: "c".repeat(40),
      lastReservedGeneration: 11,
      newestEligibleGeneration: 11,
      newestEligibleBuildBatchId: "later-build",
    });

    await expect(
      bootstrapPublicDeployment({ firestore: db, evidence: evidence() }),
    ).rejects.toThrow("no longer matches the active deployment");
  });

  it("rejects a missing or non-pristine pointer without a write", async () => {
    await expect(
      bootstrapPublicDeployment({ firestore: db, evidence: evidence() }),
    ).rejects.toThrow("coordinator does not exist");
    expect(await storedReceipt()).toBeUndefined();

    await seedUnbootstrappedPointer({
      activeGeneration: 7,
      activeDeploymentId: "66666666-6666-4666-8666-666666666666",
      activeCommitSha: "d".repeat(40),
      lastReservedGeneration: 9,
      newestEligibleGeneration: 7,
      newestEligibleBuildBatchId: "earlier-build",
    });
    await expect(
      bootstrapPublicDeployment({ firestore: db, evidence: evidence() }),
    ).rejects.toThrow("already has an active receipt");
    expect(await storedReceipt()).toBeUndefined();
  });

  it("rejects tampered projected evidence before reading Firestore", async () => {
    const tampered = { ...evidence(), commitSha: "e".repeat(40) };

    await expect(
      bootstrapPublicDeployment({ firestore: db, evidence: tampered }),
    ).rejects.toThrow(PublicDeploymentBootstrapEvidenceError);
    expect((await db.collection("system").get()).empty).toBe(true);
  });
});
