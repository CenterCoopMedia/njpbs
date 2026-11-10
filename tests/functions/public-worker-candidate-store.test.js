import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import coordinatorModule from "../../functions/lib/public-deployment-coordinator.js";
import candidateStoreModule from "../../functions/lib/public-worker-candidate-store.js";
import candidateModule from "../../functions/lib/public-worker-candidate.js";

const admin = adminPkg;
const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const {
  acquirePublicDeploymentLease,
  publicWorkerCandidateRef,
  reservePublicBuildBatch,
} = coordinatorModule;
const { recordPublicWorkerCandidate } = candidateStoreModule;
const { publicWorkerCandidateTag } = candidateModule;
let db;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function readyBatch(
  buildBatchId = "build-one",
  commitSha = "a".repeat(40),
  runtime,
) {
  await reservePublicBuildBatch({
    firestore: db,
    buildBatchId,
    commitSha,
    runtime,
  });
  const batchRef = db
    .collection("system/publicDeployment/buildBatches")
    .doc(buildBatchId);
  await batchRef.update({
    status: "ready",
    readyAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  const batch = (await batchRef.get()).data();
  const manifestRef = batchRef.collection("manifests").doc("publicMedia");
  await Promise.all([
    manifestRef.set({
      buildBatchId,
      generation: batch.generation,
      commitSha: batch.commitSha,
      mediaManifestDigest: "c".repeat(64),
      ownerCount: 0,
      chunkCount: 0,
    }),
    manifestRef.collection("verifications").doc("complete").set({
      buildBatchId,
      generation: batch.generation,
      mediaManifestDigest: "c".repeat(64),
      ownerCount: 0,
      chunkCount: 0,
      verifiedAt: batch.readyAt,
    }),
  ]);
  return batch;
}

function candidate(batch, overrides = {}) {
  const artifactDigest = batch.generation.toString(16).padStart(64, "0");
  return {
    schemaVersion: 1,
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    workerName: "njpbs-production",
    workerVersionId: "11111111-1111-4111-8111-111111111111",
    workerVersionTag: publicWorkerCandidateTag({
      generation: batch.generation,
      artifactDigest,
    }),
    versionCreatedOn: "2026-08-27T20:00:00.000Z",
    artifactDigest,
    artifactReceiptDigest: "e".repeat(64),
    publicationReceiptDigest: "f".repeat(64),
    mediaManifestDigest: "c".repeat(64),
    artifactFileCount: 100,
    artifactBytes: 1_000_000,
    wranglerVersion: "4.123.0",
    ...overrides,
  };
}

async function pointer() {
  return (await db.collection("system").doc("publicDeployment").get()).data();
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("public-worker-candidate-store.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("public Worker candidate store", () => {
  it("records one exact candidate and advances eligibility atomically", async () => {
    const batch = await readyBatch();

    const result = await recordPublicWorkerCandidate({
      firestore: db,
      candidate: candidate(batch),
    });

    expect(result.idempotent).toBe(false);
    expect(result.candidate).toMatchObject(candidate(batch));
    expect(result.candidate.recordedAt.toMillis()).toBeGreaterThan(0);
    expect(await pointer()).toMatchObject({
      state: "idle",
      lastReservedGeneration: 1,
      newestEligibleGeneration: 1,
      newestEligibleBuildBatchId: "build-one",
    });
    expect((await publicWorkerCandidateRef(db, "build-one").get()).data())
      .toEqual(result.candidate);
  });

  it("accepts an exact retry without replacing recordedAt", async () => {
    const batch = await readyBatch();
    const first = await recordPublicWorkerCandidate({
      firestore: db,
      candidate: candidate(batch),
    });

    const retry = await recordPublicWorkerCandidate({
      firestore: db,
      candidate: candidate(batch),
    });

    expect(retry).toEqual({ idempotent: true, candidate: first.candidate });
  });

  it("rejects a conflicting retry without changing the stored candidate", async () => {
    const batch = await readyBatch();
    const first = await recordPublicWorkerCandidate({
      firestore: db,
      candidate: candidate(batch),
    });

    await expect(recordPublicWorkerCandidate({
      firestore: db,
      candidate: candidate(batch, {
        workerVersionId: "22222222-2222-4222-8222-222222222222",
      }),
    })).rejects.toThrow("conflicts with its build batch");

    expect((await publicWorkerCandidateRef(db, "build-one").get()).data())
      .toEqual(first.candidate);
  });

  it("keeps a reserved batch and missing manifest completion ineligible", async () => {
    const { batch } = await reservePublicBuildBatch({
      firestore: db,
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
    });

    await expect(recordPublicWorkerCandidate({
      firestore: db,
      candidate: candidate(batch),
    })).rejects.toThrow("media manifest is not ready");

    expect((await publicWorkerCandidateRef(db, "build-one").get()).exists)
      .toBe(false);
    expect(await pointer()).toMatchObject({ newestEligibleGeneration: 0 });
  });

  it("rejects a candidate that does not bind the ready media manifest", async () => {
    const batch = await readyBatch();

    await expect(recordPublicWorkerCandidate({
      firestore: db,
      candidate: candidate(batch, { mediaManifestDigest: "d".repeat(64) }),
    })).rejects.toThrow("media manifest completion receipt is invalid");

    expect((await publicWorkerCandidateRef(db, "build-one").get()).exists)
      .toBe(false);
    expect(await pointer()).toMatchObject({ newestEligibleGeneration: 0 });
  });

  it("requires a candidate before it grants a deployment lease", async () => {
    const batch = await readyBatch();

    await expect(acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: batch.buildBatchId,
      commitSha: batch.commitSha,
    })).rejects.toThrow("prepared public Worker candidate does not exist");

    expect(await pointer()).toMatchObject({
      state: "idle",
      newestEligibleGeneration: 0,
    });
  });

  it("keeps the highest prepared generation during concurrent recording", async () => {
    const first = await readyBatch("build-one", "a".repeat(40));
    const second = await readyBatch("build-two", "b".repeat(40));

    await Promise.all([
      recordPublicWorkerCandidate({ firestore: db, candidate: candidate(first) }),
      recordPublicWorkerCandidate({ firestore: db, candidate: candidate(second) }),
    ]);

    expect(await pointer()).toMatchObject({
      lastReservedGeneration: 2,
      newestEligibleGeneration: 2,
      newestEligibleBuildBatchId: "build-two",
    });
    expect((await publicWorkerCandidateRef(db, "build-one").get()).exists)
      .toBe(true);
    expect((await publicWorkerCandidateRef(db, "build-two").get()).exists)
      .toBe(true);
  });

  it("returns the exact immutable candidate with an acquired lease", async () => {
    const batch = await readyBatch();
    const prepared = await recordPublicWorkerCandidate({
      firestore: db,
      candidate: candidate(batch),
    });

    const acquired = await acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: batch.buildBatchId,
      commitSha: batch.commitSha,
    });

    expect(acquired).toMatchObject({
      outcome: "acquired",
      idempotent: false,
      candidate: prepared.candidate,
    });
  });
});


describe("publication runtime owner and release", () => {
  const commitSha = "a".repeat(40);
  const cloud = { owner: "cloudflare", release: commitSha };
  const office = { owner: "node-compute", release: commitSha };
  it("keeps legacy reservations with OFJ and refuses cloud or another source", async () => {
    const batch = await readyBatch("legacy");
    await recordPublicWorkerCandidate({ firestore: db, candidate: candidate(batch) });
    await expect(acquirePublicDeploymentLease({ firestore: db, buildBatchId: "legacy", commitSha, runtime: cloud }))
      .rejects.toThrow("Another publication runtime");
    await expect(reservePublicBuildBatch({ firestore: db, buildBatchId: "legacy", commitSha,
      runtime: { ...office, release: "b".repeat(40) } })).rejects.toThrow("source conflicts");
    expect((await acquirePublicDeploymentLease({ firestore: db, buildBatchId: "legacy", commitSha })).outcome).toBe("acquired");
  });
  it("records an immutable cloud candidate and serializes both lanes through the same lease", async () => {
    const first = await readyBatch("office", commitSha, office);
    await recordPublicWorkerCandidate({ firestore: db, candidate: candidate(first, { runtime: office }), runtime: office });
    const officeLease = await acquirePublicDeploymentLease({ firestore: db, buildBatchId: "office", commitSha, runtime: office });
    expect(officeLease.outcome).toBe("acquired");
    const next = await readyBatch("cloud", commitSha, cloud);
    const cloudCandidate = candidate(next, { runtime: cloud });
    await expect(recordPublicWorkerCandidate({ firestore: db, candidate: cloudCandidate }))
      .rejects.toThrow("Another publication runtime");
    const results = await Promise.all([1, 2].map(() => recordPublicWorkerCandidate({ firestore: db, candidate: cloudCandidate, runtime: cloud })));
    expect(results.map(result => result.idempotent).sort()).toEqual([false, true]);
    await expect(acquirePublicDeploymentLease({ firestore: db, buildBatchId: "cloud", commitSha, runtime: office }))
      .rejects.toThrow("Another publication runtime");
    expect(await acquirePublicDeploymentLease({ firestore: db, buildBatchId: "cloud", commitSha, runtime: cloud }))
      .toEqual({ outcome: "busy", idempotent: false });
    expect(await pointer()).toMatchObject({ candidateBuildBatchId: "office", runtime: office, leaseToken: officeLease.lease.leaseToken });
    const { readPublicDeploymentReconciliationState } = await import("../../site/scripts/reconcile-public-worker-deployment.ts");
    expect(await readPublicDeploymentReconciliationState(db, cloud)).toBeNull();
    expect(await readPublicDeploymentReconciliationState(db, office)).toMatchObject({ lease: { runtime: office } });
  });
  it("rejects OFJ reconciliation of cloud leases and mismatched candidate ownership", async () => {
    const batch = await readyBatch("cloud", commitSha, cloud);
    await expect(recordPublicWorkerCandidate({ firestore: db, candidate: candidate(batch, { runtime: office }), runtime: cloud }))
      .rejects.toThrow("does not match");
    await recordPublicWorkerCandidate({ firestore: db, candidate: candidate(batch, { runtime: cloud }), runtime: cloud });
    const results = await Promise.all([1, 2].map(() => acquirePublicDeploymentLease({ firestore: db, buildBatchId: "cloud", commitSha, runtime: cloud })));
    expect(results[0].lease).toEqual(results[1].lease);
    const { readPublicDeploymentReconciliationState } = await import("../../site/scripts/reconcile-public-worker-deployment.ts");
    expect(await readPublicDeploymentReconciliationState(db)).toBeNull();
    expect(await readPublicDeploymentReconciliationState(db, { ...cloud, release: "b".repeat(40) })).toBeNull();
    expect(await readPublicDeploymentReconciliationState(db, cloud)).toMatchObject({ lease: { runtime: cloud } });
  });
});
