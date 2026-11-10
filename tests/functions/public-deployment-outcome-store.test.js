import { releasePair, pairReference } from "../helpers/public-release-pair.js";
import pairWork from "../../functions/lib/public-release-pair-work.js";
import settingsPublication from "../../functions/lib/settings-publication.js";
import contextRevision from "../../functions/lib/public-context-revision.js";
import { enrollPublicReleaseLog, publicReleaseEntries } from "../helpers/public-release-producer.js";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import adminPkg from "../helpers/firebase-admin.js";
import { electionBlock, electionRace } from "../fixtures/election-results.ts";
import pageOwnership from "../../functions/lib/no-build-page-ownership.js";
import outcomeStore from "../../functions/lib/public-deployment-outcome-store.js";
import { reconcilePublicWorkerDeployment } from "../../site/scripts/reconcile-public-worker-deployment.ts";
import { runPublicWorkerActivationOperator } from "../../site/scripts/activate-public-worker-candidate.ts";

const admin = adminPkg;
const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const {
  assertPublicDeploymentTerminalBatchStructure,
  settlePublicDeploymentOutcome,
} = outcomeStore;

const BUILD_BATCH_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PREDECESSOR_DEPLOYMENT_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_TOKEN = "55555555-5555-4555-8555-555555555555";
const LATER_BUILD_BATCH_ID = "77777777-7777-4777-8777-777777777777";
const LATER_DEPLOYMENT_ID = "88888888-8888-4888-8888-888888888888";
const LATER_LEASE_TOKEN = "99999999-9999-4999-8999-999999999999";
const COMMIT_SHA = "c".repeat(40);
const PREDECESSOR_COMMIT_SHA = "b".repeat(40);
const LATER_COMMIT_SHA = "e".repeat(40);
const MANIFEST_DIGEST = "d".repeat(64);
const ARTIFACT_DIGEST = "a".repeat(64);

const cutoffAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-08-14T12:00:00.000Z"),
);
const reservedAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-08-14T12:01:00.000Z"),
);
const verifiedAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-08-14T12:02:00.000Z"),
);
const readyAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-08-14T12:03:00.000Z"),
);
const leaseAcquiredAt = admin.firestore.Timestamp.fromDate(
  new Date("2026-08-14T12:04:00.000Z"),
);

let db;

function pointer(overrides = {}) {
  return {
    schemaVersion: 1,
    mediaLifecycleReady: true,
    state: "deploying",
    activeGeneration: 7,
    activeDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    activeCommitSha: PREDECESSOR_COMMIT_SHA,
    lastReservedGeneration: 9,
    newestEligibleGeneration: 9,
    newestEligibleBuildBatchId: "99999999-9999-4999-8999-999999999999",
    leaseToken: LEASE_TOKEN,
    leaseAcquiredAt,
    candidateGeneration: 8,
    candidateBuildBatchId: BUILD_BATCH_ID,
    candidateCommitSha: COMMIT_SHA,
    predecessorGeneration: 7,
    predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    predecessorCommitSha: PREDECESSOR_COMMIT_SHA,
    ...overrides,
  };
}

function laterDeployingPointer(active) {
  return pointer({
    activeGeneration: active.generation,
    activeDeploymentId: active.deploymentId,
    activeCommitSha: active.commitSha,
    lastReservedGeneration: 9,
    newestEligibleGeneration: 9,
    newestEligibleBuildBatchId: LATER_BUILD_BATCH_ID,
    leaseToken: LATER_LEASE_TOKEN,
    candidateGeneration: 9,
    candidateBuildBatchId: LATER_BUILD_BATCH_ID,
    candidateCommitSha: LATER_COMMIT_SHA,
    predecessorGeneration: active.generation,
    predecessorDeploymentId: active.deploymentId,
    predecessorCommitSha: active.commitSha,
  });
}

function laterIdlePointer() {
  return {
    schemaVersion: 1,
    mediaLifecycleReady: true,
    state: "idle",
    activeGeneration: 9,
    activeDeploymentId: LATER_DEPLOYMENT_ID,
    activeCommitSha: LATER_COMMIT_SHA,
    lastReservedGeneration: 9,
    newestEligibleGeneration: 9,
    newestEligibleBuildBatchId: LATER_BUILD_BATCH_ID,
  };
}

function batch(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: 8,
    status: "deploying",
    commitSha: COMMIT_SHA,
    reservedAgainstGeneration: 6,
    reservedAgainstDeploymentId: "66666666-6666-4666-8666-666666666666",
    reservedAgainstCommitSha: "a".repeat(40),
    cutoffAt,
    reservedAt,
    readyAt,
    leaseToken: LEASE_TOKEN,
    leaseAcquiredAt,
    predecessorGeneration: 7,
    predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    predecessorCommitSha: PREDECESSOR_COMMIT_SHA,
    ...overrides,
  };
}

function lease(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: 8,
    commitSha: COMMIT_SHA,
    leaseToken: LEASE_TOKEN,
    leaseAcquiredAt,
    predecessorGeneration: 7,
    predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
    predecessorCommitSha: PREDECESSOR_COMMIT_SHA,
    ...overrides,
  };
}

function coverage() {
  return [
    ["cmsPages", "1"],
    ["cmsPosts", "2"],
    ["cmsSettings", "3"],
    ["cmsAuthorProfilesPublic", "4"],
  ].map(([collection, digestStart]) => ({
    collection,
    complete: true,
    ownerCount: 0,
    ownerIdsDigest: digestStart.repeat(64),
  }));
}

function header(overrides = {}) {
  return {
    schemaVersion: 1,
    digestAlgorithm: "sha256",
    buildBatchId: BUILD_BATCH_ID,
    generation: 8,
    commitSha: COMMIT_SHA,
    cutoffAt,
    coverage: coverage(),
    ownerCount: 0,
    maxOwnerWritesPerChunk: 200,
    maxChunkBytes: 2 * 1024 * 1024,
    maxVerificationBytes: 2 * 1024 * 1024,
    chunkCount: 0,
    mediaManifestDigest: MANIFEST_DIGEST,
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: BUILD_BATCH_ID,
    generation: 8,
    mediaManifestDigest: MANIFEST_DIGEST,
    ownerCount: 0,
    chunkCount: 0,
    verifiedAt,
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
    workerVersionTag: `cms-g8-${ARTIFACT_DIGEST.slice(0, 16)}`,
    versionCreatedOn: "2026-08-14T12:03:30.000Z",
    artifactDigest: ARTIFACT_DIGEST,
    artifactReceiptDigest: "e".repeat(64),
    publicationReceiptDigest: "f".repeat(64),
    mediaManifestDigest: MANIFEST_DIGEST,
    artifactFileCount: 100,
    artifactBytes: 1_000_000,
    wranglerVersion: "4.123.0",
    recordedAt: readyAt,
    ...overrides,
  };
}

function activateEvidence(overrides = {}) {
  return {
    action: "activate",
    buildBatchId: BUILD_BATCH_ID,
    deploymentId: DEPLOYMENT_ID,
    versionId: VERSION_ID,
    commitSha: COMMIT_SHA,
    ...overrides,
  };
}

function failureEvidence(outcome = "fail", overrides = {}) {
  return {
    action: "terminal-failure",
    buildBatchId: BUILD_BATCH_ID,
    outcome,
    ...overrides,
  };
}

function refs() {
  const pointerRef = db.collection("system").doc("publicDeployment");
  const batchRef = pointerRef.collection("buildBatches").doc(BUILD_BATCH_ID);
  const manifestRef = batchRef.collection("manifests").doc("publicMedia");
  const verificationRef = manifestRef.collection("verifications").doc("complete");
  const candidateRef = batchRef.collection("candidates").doc("worker");
  return { pointerRef, batchRef, manifestRef, verificationRef, candidateRef };
}

async function seed(overrides = {}) {
  const state = refs();
  await Promise.all([
    state.pointerRef.set(overrides.pointer ?? pointer()),
    state.batchRef.set(overrides.batch ?? batch()),
    state.manifestRef.set(overrides.header ?? header()),
    state.verificationRef.set(overrides.verification ?? verification()),
    state.candidateRef.set(overrides.candidate ?? candidate()),
  ]);
}

async function stored() {
  const state = refs();
  const [pointerSnapshot, batchSnapshot, logs] = await Promise.all([
    state.pointerRef.get(),
    state.batchRef.get(),
    db.collection("admin_logs").get(),
  ]);
  return {
    pointer: pointerSnapshot.data(),
    batch: batchSnapshot.data(),
    logs: logs.docs.map((document) => document.data()),
  };
}

async function settle(evidence) {
  return settlePublicDeploymentOutcome({
    firestore: db,
    lease: lease(),
    evidence,
  });
}

async function activationOperatorInput() {
  const publication = {
    schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: BUILD_BATCH_ID,
    generation: 8, commitSha: COMMIT_SHA, artifactDigest: ARTIFACT_DIGEST,
    artifactReceiptDigest: "e".repeat(64), mediaManifestDigest: MANIFEST_DIGEST,
  };
  const body = JSON.stringify(publication);
  const publicationReceiptDigest = createHash("sha256").update(body).digest("hex");
  await seed({ candidate: candidate({ publicationReceiptDigest }) });
  const tag = "d".repeat(32);
  const input = {
    firestore: db, cloudflareApiToken: "t".repeat(40),
    preparedArtifact: { ...publication, publicationReceiptDigest,
      artifactFileCount: 100, artifactBytes: 1_000_000 },
    requestJson: async ({ url, method }) => {
      expect(method).toBe("GET");
      if (url.endsWith("/workers/scripts")) return {
        success: true, result: [{ id: "njpbs-production", tag }],
      };
      if (url.endsWith("/triggers")) return { success: true, result: [{
        trigger_uuid: "11111111-1111-4111-8111-111111111111", external_script_id: tag,
        deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc", root_directory: "/",
        branch_includes: ["production"], branch_excludes: [],
      }] };
      expect(url.endsWith("/deployments")).toBe(true);
      return { success: true, result: { deployments: [{
        id: LATER_DEPLOYMENT_ID, source: "api", strategy: "percentage",
        annotations: { "workers/triggered_by": "deployment" },
        versions: [{ version_id: VERSION_ID, percentage: 100 }],
        created_on: "2026-08-14T12:05:00.000Z",
      }] } };
    },
    requestPublication: async () => body,
  };
  return { input, body };
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("public-deployment-outcome-store.test.js");
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

describe("public deployment outcome store", () => {
  it("activates only the exact candidate and preserves both high-water counters", async () => {
    await seed();

    const result = await settle(activateEvidence());
    const state = await stored();

    expect(result).toMatchObject({
      outcome: "deployed",
      idempotent: false,
      receipt: {
        buildBatchId: BUILD_BATCH_ID,
        generation: 8,
        deploymentId: DEPLOYMENT_ID,
        versionId: VERSION_ID,
        commitSha: COMMIT_SHA,
        mediaManifestDigest: MANIFEST_DIGEST,
      },
    });
    expect(result.receipt.cloudflareEvidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(state.pointer).toMatchObject({
      schemaVersion: 1,
      mediaLifecycleReady: true,
      state: "idle",
      activeGeneration: 8,
      activeDeploymentId: DEPLOYMENT_ID,
      activeCommitSha: COMMIT_SHA,
      lastReservedGeneration: 9,
      newestEligibleGeneration: 9,
      newestEligibleBuildBatchId: "99999999-9999-4999-8999-999999999999",
    });
    for (const field of [
      "leaseToken",
      "candidateGeneration",
      "candidateBuildBatchId",
      "predecessorGeneration",
    ]) {
      expect(state.pointer).not.toHaveProperty(field);
    }
    expect(state.batch).toMatchObject({
      status: "deployed",
      deploymentId: DEPLOYMENT_ID,
      deploymentVersionId: VERSION_ID,
      mediaManifestDigest: MANIFEST_DIGEST,
      cloudflareEvidenceDigest: result.receipt.cloudflareEvidenceDigest,
    });
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({
      actorUid: "system:public-deployment",
      action: "public-deployment.activate",
      target: `system/publicDeployment/buildBatches/${BUILD_BATCH_ID}`,
      before: { state: "deploying", activeGeneration: 7 },
      after: {
        state: "deployed",
        activeGeneration: 8,
        cloudflareEvidenceDigest: result.receipt.cloudflareEvidenceDigest,
      },
    });
  });

  it("does not enable a disabled media lifecycle fence on activation", async () => {
    await seed({
      pointer: pointer({
        mediaLifecycleReady: false,
        lastReservedGeneration: 8,
        newestEligibleGeneration: 8,
        newestEligibleBuildBatchId: BUILD_BATCH_ID,
      }),
    });

    await settle(activateEvidence());

    expect((await stored()).pointer).toMatchObject({
      state: "idle",
      activeGeneration: 8,
      mediaLifecycleReady: false,
      lastReservedGeneration: 8,
      newestEligibleGeneration: 8,
    });
  });

  it("returns the exact deployed receipt on an exact retry with zero new writes", async () => {
    await seed();
    const first = await settle(activateEvidence());
    const retry = await settle(activateEvidence());
    const state = await stored();

    expect(retry).toEqual({ ...first, idempotent: true });
    expect(state.logs).toHaveLength(1);
  });

  it.each([
    ["deployed", activateEvidence(), (batch) => ({
      ...batch,
      deploymentId: "not-a-cloudflare-uuid",
    })],
    ["failed", failureEvidence(), (batch) => ({
      ...batch,
      failedAt: readyAt,
    })],
  ])(
    "validates the exact %s terminal shape and rejects malformed evidence",
    async (_status, evidence, malformed) => {
      await seed();
      await settle(evidence);
      const batch = (await stored()).batch;

      expect(() => assertPublicDeploymentTerminalBatchStructure(
        batch,
        BUILD_BATCH_ID,
      )).not.toThrow();
      expect(() => assertPublicDeploymentTerminalBatchStructure(
        malformed(batch),
        BUILD_BATCH_ID,
      )).toThrow(/terminal receipt/i);
    },
  );

  it.each([
    ["deployed", activateEvidence(), {
      generation: 8,
      deploymentId: DEPLOYMENT_ID,
      commitSha: COMMIT_SHA,
    }],
    ["failed", failureEvidence(), {
      generation: 7,
      deploymentId: PREDECESSOR_DEPLOYMENT_ID,
      commitSha: PREDECESSOR_COMMIT_SHA,
    }],
  ])(
    "returns the exact %s receipt after later coordinator work changes the pointer",
    async (_outcome, evidence, active) => {
      await seed();
      const first = await settle(evidence);

      await refs().pointerRef.set(laterDeployingPointer(active));
      const deployingRetry = await settle(evidence);
      await refs().pointerRef.set(laterIdlePointer());
      const settledRetry = await settle(evidence);

      expect(deployingRetry).toEqual({ ...first, idempotent: true });
      expect(settledRetry).toEqual({ ...first, idempotent: true });
      expect((await stored()).logs).toHaveLength(1);
    },
  );

  it.each([
    ["deployed", activateEvidence()],
    ["failed", failureEvidence()],
  ])("rejects a mismatched caller lease on an exact %s retry", async (_outcome, evidence) => {
    await seed();
    await settle(evidence);

    await expect(settlePublicDeploymentOutcome({
      firestore: db,
      lease: lease({ leaseToken: "different-token" }),
      evidence,
    })).rejects.toThrow(/lease receipt/i);

    expect((await stored()).logs).toHaveLength(1);
  });

  it("reads the completed lease when stale reconciliation follows activation", async () => {
    await seed();
    await settle({ action: "reconcile" });
    const activated = await settle(activateEvidence());
    const before = await stored();

    expect(await settle({ action: "reconcile" }))
      .toEqual({ ...activated, idempotent: true });
    expect(await stored()).toEqual(before);

    await refs().pointerRef.set(laterDeployingPointer({
      generation: 8, deploymentId: DEPLOYMENT_ID, commitSha: COMMIT_SHA,
    }));
    const later = await stored();
    expect(await settle({ action: "reconcile" }))
      .toEqual({ ...activated, idempotent: true });
    expect(await stored()).toEqual(later);

    await expect(settlePublicDeploymentOutcome({
      firestore: db, lease: lease({ leaseToken: "different-token" }),
      evidence: { action: "reconcile" },
    })).rejects.toThrow(/lease receipt/i);
  });

  it("rejects stale reconciliation against a corrupt terminal receipt", async () => {
    await seed();
    await settle(activateEvidence());
    await refs().batchRef.update({ cloudflareEvidenceDigest: "0".repeat(64) });
    const before = await stored();
    await expect(settle({ action: "reconcile" })).rejects.toThrow(/terminal receipt/i);
    expect(await stored()).toEqual(before);
  });

  it.each([
    { versionId: "99999999-9999-4999-8999-999999999999" },
    { commitSha: "f".repeat(40) },
    { deploymentId: "99999999-9999-4999-8999-999999999999" },
  ])("does not treat conflicting activation evidence as a stale probe", async mismatch => {
    await seed();
    await settle(activateEvidence());
    const before = await stored();
    await expect(settle({ ...activateEvidence(), ...mismatch })).rejects.toThrow(/terminal receipt/i);
    expect(await stored()).toEqual(before);
  });

  it("completes reconciliation when activation settles during its provider probe", async () => {
    await seed();
    let enteredProbe;
    const probing = new Promise(resolve => { enteredProbe = resolve; });
    let finishProbe;
    const probe = new Promise(resolve => { finishProbe = resolve; });
    const reconciliation = reconcilePublicWorkerDeployment({
      firestore: db, cloudflareApiToken: "t".repeat(40),
      requestJson: async () => {
        enteredProbe();
        await probe;
        throw new Error("Provider evidence is not yet decisive");
      },
    });
    await probing;
    const activation = await settle(activateEvidence());
    const before = await stored();
    finishProbe();
    expect(await reconciliation).toEqual({ ...activation, idempotent: true });
    expect(await stored()).toEqual(before);
  });

  it.each(["reconciler", "activation operator"])(
    "rejects conflicting terminal evidence through the %s fallback",
    async operator => {
      const { input, body } = await activationOperatorInput();
      input.requestPublication = async () => {
        // The other owner commits a different deployment while this probe
        // is in flight. The operator must not turn that conflict into success.
        await settle(activateEvidence());
        return body;
      };
      const run = operator === "reconciler" ? reconcilePublicWorkerDeployment : runPublicWorkerActivationOperator;
      await expect(run(input)).rejects.toThrow(/terminal receipt/i);
      expect((await stored()).batch.deploymentId).toBe(DEPLOYMENT_ID);
      expect((await stored()).logs).toHaveLength(1);
    },
  );

  it.each(["reconciler", "activation operator"].flatMap(operator =>
    ["conflicting", "matching", "uncommitted"].map(receipt => ({ operator, receipt })),
  ))("checks $receipt evidence after a transient $operator settlement failure", async ({ operator, receipt }) => {
    const { input, body } = await activationOperatorInput();
    let failNextTransaction = false;
    let concurrentResult;
    let afterConcurrentCommit;
    // Inject a lost database request before commit. All successful transactions,
    // including the competing owner and retry, use the real Firestore emulator.
    input.firestore = {
      projectId: db.projectId,
      doc: db.doc.bind(db),
      getAll: db.getAll.bind(db),
      collection: db.collection.bind(db),
      runTransaction: async (...args) => {
        if (failNextTransaction) {
          failNextTransaction = false;
          if (receipt !== "uncommitted") {
            concurrentResult = await settle(activateEvidence({
              deploymentId: receipt === "matching" ? LATER_DEPLOYMENT_ID : DEPLOYMENT_ID,
            }));
          }
          afterConcurrentCommit = await stored();
          throw Object.assign(new Error("Firestore unavailable before commit"), { code: 14 });
        }
        return db.runTransaction(...args);
      },
    };
    input.requestPublication = async () => {
      failNextTransaction = true;
      return body;
    };
    const run = operator === "reconciler" ? reconcilePublicWorkerDeployment : runPublicWorkerActivationOperator;
    if (receipt === "conflicting") {
      await expect(run(input)).rejects.toThrow(/ambiguous|terminal receipt/i);
      expect(await stored()).toEqual(afterConcurrentCommit);
    } else if (receipt === "matching") {
      expect(await run(input)).toEqual({ ...concurrentResult, idempotent: true });
      expect(await stored()).toEqual(afterConcurrentCommit);
    } else {
      expect(await run(input)).toMatchObject({ outcome: "reconciling", idempotent: false });
      expect((await stored()).batch.status).toBe("reconciling");
      expect((await stored()).logs).toHaveLength(1);
    }
  });

  it.each(["fail", "cancelled", "terminated"])(
    "records exact terminal %s evidence while retaining the predecessor",
    async (outcome) => {
      await seed();

      const result = await settle(failureEvidence(outcome));
      const state = await stored();

      expect(result).toMatchObject({
        outcome: "failed",
        idempotent: false,
        receipt: {
          buildBatchId: BUILD_BATCH_ID,
          generation: 8,
          terminalOutcome: outcome,
          predecessorGeneration: 7,
          predecessorDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
          predecessorCommitSha: PREDECESSOR_COMMIT_SHA,
          mediaManifestDigest: MANIFEST_DIGEST,
        },
      });
      expect(state.pointer).toMatchObject({
        state: "idle",
        activeGeneration: 7,
        activeDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
        activeCommitSha: PREDECESSOR_COMMIT_SHA,
        lastReservedGeneration: 9,
        newestEligibleGeneration: 9,
      });
      expect(state.batch).toMatchObject({
        status: "failed",
        terminalOutcome: outcome,
        cloudflareEvidenceDigest: result.receipt.cloudflareEvidenceDigest,
      });
      expect(state.logs).toHaveLength(1);
      expect(state.logs[0]).toMatchObject({
        action: "public-deployment.fail",
        after: { state: "failed", terminalOutcome: outcome },
      });
    },
  );

  it("preserves a disabled predecessor lifecycle flag on terminal failure", async () => {
    await seed({ pointer: pointer({ mediaLifecycleReady: false }) });

    await settle(failureEvidence());

    expect((await stored()).pointer).toMatchObject({
      state: "idle",
      activeGeneration: 7,
      mediaLifecycleReady: false,
    });
  });

  it("keeps a canonical activation plan that contradicts the lease reconciling", async () => {
    await seed();

    const result = await settle(activateEvidence({
      commitSha: "f".repeat(40),
    }));
    const state = await stored();

    expect(result).toMatchObject({ outcome: "reconciling", idempotent: false });
    expect(state.pointer).toMatchObject({
      state: "reconciling",
      activeGeneration: 7,
      leaseToken: LEASE_TOKEN,
    });
    expect(state.batch).toMatchObject({
      status: "reconciling",
      leaseToken: LEASE_TOKEN,
    });
    expect(state.batch).not.toHaveProperty("terminalOutcome");
    expect(state.logs).toHaveLength(1);
  });

  it("keeps an activation for another Worker version reconciling", async () => {
    await seed();

    const result = await settle(activateEvidence({
      versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }));
    const state = await stored();

    expect(result).toMatchObject({ outcome: "reconciling", idempotent: false });
    expect(state.pointer).toMatchObject({
      state: "reconciling",
      activeGeneration: 7,
      leaseToken: LEASE_TOKEN,
    });
    expect(state.batch).toMatchObject({ status: "reconciling" });
  });

  it("keeps ambiguous evidence reconciling without changing the active receipt", async () => {
    await seed();

    const first = await settle({ action: "reconcile" });
    const retry = await settle({ action: "reconcile" });
    const state = await stored();

    expect(first).toMatchObject({ outcome: "reconciling", idempotent: false });
    expect(retry).toEqual({ ...first, idempotent: true });
    expect(state.pointer).toMatchObject({
      state: "reconciling",
      activeGeneration: 7,
      activeDeploymentId: PREDECESSOR_DEPLOYMENT_ID,
      activeCommitSha: PREDECESSOR_COMMIT_SHA,
      leaseToken: LEASE_TOKEN,
      candidateGeneration: 8,
      lastReservedGeneration: 9,
      newestEligibleGeneration: 9,
      cloudflareEvidenceDigest: first.receipt.cloudflareEvidenceDigest,
    });
    expect(state.batch).toMatchObject({
      status: "reconciling",
      leaseToken: LEASE_TOKEN,
      predecessorGeneration: 7,
      cloudflareEvidenceDigest: first.receipt.cloudflareEvidenceDigest,
    });
    expect(state.pointer.activeGeneration).not.toBe(8);
    expect(state.batch).not.toHaveProperty("terminalOutcome");
    expect(state.logs).toHaveLength(1);
  });

  it("settles a reconciling lease when later evidence becomes decisive", async () => {
    await seed();
    await settle({ action: "reconcile" });

    const result = await settle(activateEvidence());
    const state = await stored();

    expect(result).toMatchObject({ outcome: "deployed", idempotent: false });
    expect(state.pointer).toMatchObject({ state: "idle", activeGeneration: 8 });
    expect(state.batch).toMatchObject({ status: "deployed" });
    expect(state.logs).toHaveLength(2);
  });

  it.each([
    ["a deploying batch beside a reconciling pointer", async () => {
      await refs().batchRef.update({
        status: "deploying",
        reconcilingAt: admin.firestore.FieldValue.delete(),
        cloudflareEvidenceDigest: admin.firestore.FieldValue.delete(),
      });
    }],
    ["a reconciling batch beside a deploying pointer", async () => {
      await refs().pointerRef.update({
        state: "deploying",
        reconcilingAt: admin.firestore.FieldValue.delete(),
        cloudflareEvidenceDigest: admin.firestore.FieldValue.delete(),
      });
    }],
    ["different reconciliation timestamps", async () => {
      await refs().batchRef.update({
        reconcilingAt: admin.firestore.Timestamp.fromDate(
          new Date("2026-08-14T12:06:00.000Z"),
        ),
      });
    }],
    ["different reconciliation evidence digests", async () => {
      await refs().batchRef.update({
        cloudflareEvidenceDigest: "f".repeat(64),
      });
    }],
  ])(
    "rejects decisive evidence with %s",
    async (_label, mutateReceipt) => {
      await seed();
      await settle({ action: "reconcile" });
      await mutateReceipt();

      await expect(settle(activateEvidence())).rejects.toThrow(
        /lease receipt/i,
      );
      expect((await stored()).logs).toHaveLength(1);
    },
  );

  it.each([
    ["lease token", { lease: lease({ leaseToken: "different-token" }) }],
    ["candidate pointer", {
      pointer: pointer({ candidateCommitSha: "f".repeat(40) }),
    }],
    ["batch generation", { batch: batch({ generation: 6 }) }],
    ["batch cutoff", {
      header: header({
        cutoffAt: admin.firestore.Timestamp.fromDate(
          new Date("2026-08-14T11:00:00.000Z"),
        ),
      }),
    }],
    ["manifest digest", {
      verification: verification({ mediaManifestDigest: "e".repeat(64) }),
    }],
    ["prepared candidate manifest digest", {
      candidate: candidate({ mediaManifestDigest: "e".repeat(64) }),
    }],
  ])("rejects a conflicting %s without a settlement write", async (_label, overrides) => {
    await seed(overrides);
    const suppliedLease = overrides.lease ?? lease();

    await expect(settlePublicDeploymentOutcome({
      firestore: db,
      lease: suppliedLease,
      evidence: activateEvidence(),
    })).rejects.toThrow();

    const state = await stored();
    expect(state.pointer.state).toBe("deploying");
    expect(state.batch.status).toBe("deploying");
    expect(state.logs).toHaveLength(0);
  });

  it("rejects missing readiness receipts and noncanonical evidence", async () => {
    await seed();
    await refs().verificationRef.delete();

    await expect(settle(activateEvidence())).rejects.toThrow(/manifest/i);
    await expect(settle(activateEvidence({ futureField: true })))
      .rejects.toThrow(/Cloudflare evidence/i);

    const state = await stored();
    expect(state.pointer.state).toBe("deploying");
    expect(state.logs).toHaveLength(0);
  });

  it("stays absent from every deployment manifest and network boundary", () => {
    const manifest = readFileSync(
      new URL("../../functions/index.js", import.meta.url),
      "utf8",
    );
    const source = readFileSync(
      new URL(
        "../../functions/lib/public-deployment-outcome-store.js",
        import.meta.url,
      ),
      "utf8",
    );

    expect(manifest).not.toContain("public-deployment-outcome-store");
    expect(source).not.toMatch(
      /fetch\s*\(|process\.env|defineSecret|onRequest|require\("\.\/(?:audit|firebase)"\)/,
    );
  });
});


it("retains the exact cloud owner through reconciliation and terminal retries", async () => {
  const runtime = { owner: "cloudflare", release: COMMIT_SHA };
  await seed({ pointer: pointer({ runtime }), batch: batch({ runtime }), candidate: candidate({ runtime }) });
  const input = { firestore: db, lease: { ...lease(), runtime }, evidence: { action: "reconcile" }, runtime };
  await expect(settlePublicDeploymentOutcome({ ...input, runtime: undefined })).rejects.toThrow("Another publication runtime");
  expect(await settlePublicDeploymentOutcome(input)).toMatchObject({ outcome: "reconciling" });
  expect((await stored()).batch.runtime).toEqual(runtime);
  const terminal = { ...input, evidence: activateEvidence() };
  expect(await settlePublicDeploymentOutcome(terminal)).toMatchObject({ outcome: "deployed", receipt: { runtime } });
  expect(await settlePublicDeploymentOutcome(terminal)).toMatchObject({ outcome: "deployed", idempotent: true, receipt: { runtime } });
  expect((await stored()).batch.runtime).toEqual(runtime);
});


async function seedOwnedPage({ visible = true, noBuildPage = true } = {}) {
  await seed({ candidate: candidate(noBuildPage ? { noBuildPage: {
    schemaVersion: 1, rendererSha: COMMIT_SHA, enabled: true, authoritative: true,
  } } : {}) });
  const published = { sourceVersion: 2, metadata: { title: "Contact", slug: "contact", previousSlugs: ["former"] }, blocks: [] };
  const owner = { schemaVersion: 1, pageId: "contact", rendererSha: PREDECESSOR_COMMIT_SHA,
    servingEnabled: true, generation: 7, operationId: "A".repeat(20), sourceVersion: 2,
    path: "/contact/", ownedPaths: ["/contact/", "/former/"], visible,
    snapshotDigest: pageOwnership.digest(published), runtime: { owner: "cloudflare", release: PREDECESSOR_COMMIT_SHA } };
  await db.doc(`${pageOwnership.PAGE_OWNER_COLLECTION}/contact`).set(owner);
  await db.doc("cmsPages/contact").set({ publiclyVisible: visible, published });
  await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).set({ schemaVersion: 1,
    rendererSha: PREDECESSOR_COMMIT_SHA, servingEnabled: true, generation: 7 });
  for (const path of owner.ownedPaths) await pageOwnership.pageRouteRef(db, path).set({ schemaVersion: 1, pageId: "contact", path });
  return owner;
}

it.each([true, false])("settles a compatible Page candidate preserving visible=%s and aliases", async visible => {
  const retained = await seedOwnedPage({ visible });
  const terminalOwnerPresent = existsSync(new URL("../../functions/lib/no-build-page-serving.js", import.meta.url)) &&
    existsSync(new URL("../../functions/lib/no-build-page-recovery.js", import.meta.url));
  expect(await settle(activateEvidence())).toMatchObject({ outcome: "deployed" });
  expect((await db.doc(`${pageOwnership.PAGE_OWNER_COLLECTION}/contact`).get()).data()).toEqual(retained);
  expect((await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).get()).data())
    .toEqual({ schemaVersion: 1, rendererSha: COMMIT_SHA, servingEnabled: true, generation: 8,
      ...(terminalOwnerPresent ? { terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: COMMIT_SHA } } : {}) });
  expect(await settle(activateEvidence())).toMatchObject({ outcome: "deployed", idempotent: true });
});

it("the existing publisher settlement installs election capability 2 and terminal replay preserves it", async () => {
  const owner = await seedOwnedPage();
  const published = (await db.doc("cmsPages/contact").get()).data().published;
  published.blocks = [electionBlock(electionRace({ expectedVoteShare: 0.85, reportingShare: null }))];
  await db.doc("cmsPages/contact").update({ published });
  await db.doc(`${pageOwnership.PAGE_OWNER_COLLECTION}/contact`).update({ snapshotDigest: pageOwnership.digest(published) });
  await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).update({ electionResultsVersion: 1 });
  await refs().candidateRef.update({ "noBuildPage.electionResultsVersion": 2 });
  expect(await settle(activateEvidence())).toMatchObject({ outcome: "deployed" });
  const capability = (await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).get()).data();
  expect(capability).toMatchObject({ rendererSha: COMMIT_SHA, electionResultsVersion: 2, generation: 8 });
  expect((await db.doc(`${pageOwnership.PAGE_OWNER_COLLECTION}/${owner.pageId}`).get()).data().visible).toBe(true);
  // Terminal CMS writeback calls this same existing settlement module. It must
  // return before running activation writers again or demoting the new marker.
  expect(await settle(activateEvidence())).toMatchObject({ outcome: "deployed", idempotent: true });
  expect((await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).get()).data()).toEqual(capability);
});

it.each(["missing capability", "snapshot changed", "alias claim missing"])("refuses activation when Page %s", async defect => {
  await seedOwnedPage({ noBuildPage: defect !== "missing capability" });
  if (defect === "snapshot changed") await db.doc("cmsPages/contact").update({ "published.metadata.title": "Unsealed revision" });
  if (defect === "alias claim missing") await pageOwnership.pageRouteRef(db, "/former/").delete();
  await expect(settle(activateEvidence())).rejects.toThrow();
  expect((await stored()).pointer.state).toBe("deploying");
  expect((await db.doc(pageOwnership.PAGE_CAPABILITY_PATH).get()).data().rendererSha).toBe(PREDECESSOR_COMMIT_SHA);
});

it("change-log: activation settles its exact busy lease with one atomic provider append", async () => {
  await seed();
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 4 });
  await enrollPublicReleaseLog(db, PREDECESSOR_COMMIT_SHA);
  await db.doc(`cmsPreviewPublicContexts/${BUILD_BATCH_ID}`).set({ schemaVersion: 1, buildBatchId: BUILD_BATCH_ID,
    artifactReceiptDigest: candidate().artifactReceiptDigest, sha256: "a".repeat(64), byteLength: 128,
    key: `public-context/${BUILD_BATCH_ID}/${"a".repeat(64)}.json` });
  const nextPair = releasePair("b", COMMIT_SHA);
  await db.doc(pairWork.publicReleasePairPath(nextPair.pairId)).set(nextPair);
  await db.doc("system/publicReleaseChangeLog").update({ activation: { buildBatchId: BUILD_BATCH_ID, pair: pairReference(nextPair) } });
  const result = await settle(activateEvidence());
  expect(result).toMatchObject({ outcome: "deployed", idempotent: false });
  const [entry] = await publicReleaseEntries(db);
  expect(entry.changes).toMatchObject([{ kind: "provider", id: "public-code", action: "dependency", sourceVersion: 8 }]);
  expect((await stored()).pointer).toMatchObject({ state: "idle", activeCommitSha: COMMIT_SHA });
  expect((await settle(activateEvidence())).idempotent).toBe(true);
  expect(await publicReleaseEntries(db)).toHaveLength(1);
  const control = (await db.doc("system/publicReleaseChangeLog").get()).data();
  expect(control.pair).toEqual(pairReference(nextPair));
  expect(control).not.toHaveProperty("activation");
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: COMMIT_SHA, serializerId: "cloudflare-publisher" });
  await db.runTransaction(async transaction => {
    const published = { sourceVersion: 1, values: { newsletterText: "Current code" } };
    const prepared = await settingsPublication.prepareSettingsPublication({ firestore: db, transaction,
      id: "public-site-chrome", published, actor: { uid: "editor" } });
    prepared.write();
    contextRevision.bumpPublicContextRevision(transaction, db);
    transaction.set(db.doc("cmsSettings/public-site-chrome"), { published });
  });
  const after = await publicReleaseEntries(db);
  expect(after).toHaveLength(2);
  expect(after[1].pair).toEqual(pairReference(nextPair));
});

it.each(["missing", "wrong-build"])("change-log: activation %s refuses before any settlement or append", async mode => {
  await seed();
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 4 });
  await enrollPublicReleaseLog(db, PREDECESSOR_COMMIT_SHA);
  if (mode === "wrong-build") {
    const nextPair = releasePair("b", COMMIT_SHA);
    await db.doc(pairWork.publicReleasePairPath(nextPair.pairId)).set(nextPair);
    await db.doc("system/publicReleaseChangeLog").update({ activation: { buildBatchId: "different-build", pair: pairReference(nextPair) } });
  }
  const before = await stored();
  await expect(settle(activateEvidence())).rejects.toThrow();
  expect(await stored()).toEqual(before);
  expect(await publicReleaseEntries(db)).toEqual([]);
});
