import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRequire } from "node:module";
import adminPkg from "../helpers/firebase-admin.js";
import coordinatorModule from "../../functions/lib/public-deployment-coordinator.js";
import candidateStoreModule from "../../functions/lib/public-worker-candidate-store.js";
import candidateModule from "../../functions/lib/public-worker-candidate.js";
import pagesArtifactModule from "../../functions/lib/pages-public-artifact.js";

const admin = adminPkg;
const require = createRequire(import.meta.url);
const PROJECT = "demo-njpbs";
const { acquirePublicDeploymentLease, reservePublicBuildBatch } = coordinatorModule;
const { recordPublicWorkerCandidate } = candidateStoreModule;
const { publicWorkerCandidateTag } = candidateModule;
const { selectActivePublicBuildBatch } = pagesArtifactModule;
const {
  PublicDeploymentStateError,
} = require("../../functions/lib/public-deployment.js");
let db;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function storedPointer() {
  return (await db.collection("system").doc("publicDeployment").get()).data();
}

async function storedBatch(buildBatchId) {
  return (
    await db
      .collection("system")
      .doc("publicDeployment")
      .collection("buildBatches")
      .doc(buildBatchId)
      .get()
  ).data();
}

function reserve(buildBatchId, commitSha) {
  return reservePublicBuildBatch({
    firestore: db,
    buildBatchId,
    commitSha,
  });
}

function acquire(buildBatchId, commitSha) {
  return acquirePublicDeploymentLease({
    firestore: db,
    buildBatchId,
    commitSha,
  });
}

async function markReady(buildBatchId) {
  const pointerRef = db.collection("system").doc("publicDeployment");
  const batchRef = pointerRef.collection("buildBatches").doc(buildBatchId);
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
  const artifactDigest = batch.generation.toString(16).padStart(64, "0");
  return recordPublicWorkerCandidate({
    firestore: db,
    candidate: {
      schemaVersion: 1,
      buildBatchId,
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
    },
  });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("public-deployment-coordinator.test.js");
});

beforeEach(clearFirestore);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("reservePublicBuildBatch", () => {
  it("initializes one fail-closed generation", async () => {
    const result = await reserve(
      "11111111-1111-4111-8111-111111111111",
      "a".repeat(40),
    );

    expect(result.idempotent).toBe(false);
    expect(result).not.toHaveProperty("coordinator");
    const pointer = await storedPointer();
    expect(pointer).toMatchObject({
      schemaVersion: 1,
      state: "idle",
      mediaLifecycleReady: false,
      activeGeneration: 0,
      lastReservedGeneration: 1,
      newestEligibleGeneration: 0,
      newestEligibleBuildBatchId: null,
    });
    expect(result.batch).toMatchObject({
      buildBatchId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      reservedAgainstGeneration: 0,
      reservedAgainstDeploymentId: null,
      reservedAgainstCommitSha: null,
    });
    expect(result.batch.cutoffAt.toMillis()).toBeGreaterThan(0);
    expect(result.batch.reservedAt.toMillis()).toBe(
      result.batch.cutoffAt.toMillis(),
    );
    expect(pointer.updatedAt.toMillis()).toBe(
      result.batch.reservedAt.toMillis(),
    );
    expect(await storedBatch(result.batch.buildBatchId)).toEqual({
      ...result.batch,
      status: "reserved",
    });
  });

  it("cannot replace the authoritative Firestore server timestamp", async () => {
    const injectedTimestamp = vi.fn(() => ({}));
    const result = await reservePublicBuildBatch({
      firestore: db,
      buildBatchId: "build-one",
      commitSha: "a".repeat(40),
      serverTimestamp: injectedTimestamp,
    });

    expect(injectedTimestamp).not.toHaveBeenCalled();
    expect(result.batch.cutoffAt.toMillis()).toBeGreaterThan(0);
    expect(result.batch.reservedAt.toMillis()).toBe(
      result.batch.cutoffAt.toMillis(),
    );
  });

  it("reserves distinct generations in order", async () => {
    const first = await reserve("build-one", "a".repeat(40));
    const second = await reserve("build-two", "b".repeat(40));

    expect(first.batch.generation).toBe(1);
    expect(second.batch.generation).toBe(2);
    expect((await storedPointer()).lastReservedGeneration).toBe(2);
  });

  it("serializes concurrent reservations without reusing a generation", async () => {
    const results = await Promise.all([
      reserve("build-one", "a".repeat(40)),
      reserve("build-two", "b".repeat(40)),
    ]);

    expect(results.map((result) => result.batch.generation).sort()).toEqual([
      1, 2,
    ]);
    expect((await storedPointer()).lastReservedGeneration).toBe(2);
  });

  it("returns the exact reservation for an idempotent retry", async () => {
    const first = await reserve("build-one", "a".repeat(40));
    const retry = await reserve("build-one", "a".repeat(40));

    expect(retry.idempotent).toBe(true);
    expect(retry.batch).toEqual(first.batch);
    expect(retry).not.toHaveProperty("coordinator");
    expect((await storedPointer()).lastReservedGeneration).toBe(1);
  });

  it("returns the progressed batch for an exact retry", async () => {
    const first = await reserve("build-one", "a".repeat(40));
    await db
      .collection("system")
      .doc("publicDeployment")
      .collection("buildBatches")
      .doc("build-one")
      .update({ status: "deploying", leaseToken: "lease-one" });

    const retry = await reserve("build-one", "a".repeat(40));

    expect(retry.idempotent).toBe(true);
    expect(retry.batch).toEqual(first.batch);
    expect(retry.batch).not.toHaveProperty("status");
    expect(retry.batch).not.toHaveProperty("leaseToken");
    expect(retry).not.toHaveProperty("coordinator");
    expect((await storedPointer()).lastReservedGeneration).toBe(1);
  });

  it("captures the active receipt that generation eight reserved against", async () => {
    await db
      .collection("system")
      .doc("publicDeployment")
      .set({
        schemaVersion: 1,
        mediaLifecycleReady: true,
        state: "idle",
        activeGeneration: 7,
        activeDeploymentId: "deployment-7",
        activeCommitSha: "a".repeat(40),
        lastReservedGeneration: 7,
        newestEligibleGeneration: 7,
        newestEligibleBuildBatchId: "build-seven",
      });

    const result = await reserve("build-eight", "b".repeat(40));

    expect(result.batch).toMatchObject({
      generation: 8,
      reservedAgainstGeneration: 7,
      reservedAgainstDeploymentId: "deployment-7",
      reservedAgainstCommitSha: "a".repeat(40),
    });
    expect(await storedBatch("build-eight")).toEqual({
      ...result.batch,
      status: "reserved",
    });
    expect(await storedPointer()).toMatchObject({
      mediaLifecycleReady: true,
      activeGeneration: 7,
      activeDeploymentId: "deployment-7",
      activeCommitSha: "a".repeat(40),
      lastReservedGeneration: 8,
      newestEligibleGeneration: 7,
      newestEligibleBuildBatchId: "build-seven",
    });
  });

  it("rejects reuse of a build id for another commit", async () => {
    await reserve("build-one", "a".repeat(40));

    await expect(reserve("build-one", "b".repeat(40))).rejects.toThrow(
      "belongs to a different commit",
    );
    expect((await storedPointer()).lastReservedGeneration).toBe(1);
  });

  it("refuses to reserve against an unimplemented non-idle pointer", async () => {
    await db
      .collection("system")
      .doc("publicDeployment")
      .set({
        schemaVersion: 1,
        mediaLifecycleReady: false,
        state: "reconciling",
        activeGeneration: 7,
        activeDeploymentId: "deployment-7",
        activeCommitSha: "a".repeat(40),
        lastReservedGeneration: 8,
        newestEligibleGeneration: 8,
        newestEligibleBuildBatchId: "build-eight",
        leaseToken: "lease-8",
        candidateGeneration: 8,
        candidateBuildBatchId: "build-eight",
        candidateCommitSha: "b".repeat(40),
        leaseAcquiredAt: admin.firestore.Timestamp.fromDate(
          new Date("2026-08-14T12:00:00.000Z"),
        ),
        predecessorGeneration: 7,
        predecessorDeploymentId: "deployment-7",
        predecessorCommitSha: "a".repeat(40),
      });

    await expect(reserve("build-nine", "c".repeat(40))).rejects.toThrow(
      "coordinator is invalid",
    );
    expect(await storedPointer()).toMatchObject({
      state: "reconciling",
      leaseToken: "lease-8",
      candidateGeneration: 8,
      lastReservedGeneration: 8,
    });
    expect(await storedBatch("build-nine")).toBeUndefined();
  });

  it.each(["bad/id", ".", "..", "__reserved__"])(
    "rejects reserved or invalid Firestore build id %s without a write",
    async (buildBatchId) => {
      await expect(
        reserve(buildBatchId, "a".repeat(40)),
      ).rejects.toBeInstanceOf(PublicDeploymentStateError);
      expect((await db.collection("system").get()).empty).toBe(true);
    },
  );

  it.each(["a".repeat(39), "A".repeat(40)])(
    "rejects invalid commit identity %s",
    async (commitSha) => {
      await expect(reserve("build-one", commitSha)).rejects.toBeInstanceOf(
        PublicDeploymentStateError,
      );
      expect((await db.collection("system").get()).empty).toBe(true);
    },
  );

  it("rejects a malformed or regressed pointer without a write", async () => {
    await db
      .collection("system")
      .doc("publicDeployment")
      .set({
        schemaVersion: 1,
        mediaLifecycleReady: false,
        state: "idle",
        activeGeneration: 7,
        activeDeploymentId: "deployment-7",
        activeCommitSha: "a".repeat(40),
        lastReservedGeneration: 6,
        newestEligibleGeneration: 7,
        newestEligibleBuildBatchId: "build-seven",
      });

    await expect(reserve("build-eight", "b".repeat(40))).rejects.toThrow(
      "coordinator is invalid",
    );
    expect(await storedBatch("build-eight")).toBeUndefined();
  });
});

describe("selectActivePublicBuildBatch", () => {
  const buildBatchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const deploymentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const versionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const predecessorDeploymentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const leaseToken = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const commitSha = "a".repeat(40);
  const predecessorCommitSha = "b".repeat(40);
  const cutoffAt = admin.firestore.Timestamp.fromDate(
    new Date("2026-09-15T20:00:00.000Z"),
  );
  const reservedAt = admin.firestore.Timestamp.fromDate(
    new Date("2026-09-15T20:00:01.000Z"),
  );
  const readyAt = admin.firestore.Timestamp.fromDate(
    new Date("2026-09-15T20:00:02.000Z"),
  );
  const leaseAcquiredAt = admin.firestore.Timestamp.fromDate(
    new Date("2026-09-15T20:00:03.000Z"),
  );
  const deployedAt = admin.firestore.Timestamp.fromDate(
    new Date("2026-09-15T20:00:04.000Z"),
  );

  async function seedActiveDeployment(pointerOverrides = {}) {
    const pointerRef = db.collection("system").doc("publicDeployment");
    const batchRef = pointerRef.collection("buildBatches").doc(buildBatchId);
    const pointer = {
      schemaVersion: 1,
      mediaLifecycleReady: true,
      state: "idle",
      activeGeneration: 7,
      activeDeploymentId: deploymentId,
      activeCommitSha: commitSha,
      lastReservedGeneration: 7,
      newestEligibleGeneration: 7,
      newestEligibleBuildBatchId: buildBatchId,
      updatedAt: deployedAt,
      ...pointerOverrides,
    };
    const batch = {
      schemaVersion: 1,
      buildBatchId,
      generation: 7,
      status: "deployed",
      commitSha,
      reservedAgainstGeneration: 6,
      reservedAgainstDeploymentId: predecessorDeploymentId,
      reservedAgainstCommitSha: predecessorCommitSha,
      cutoffAt,
      reservedAt,
      readyAt,
      leaseToken,
      leaseAcquiredAt,
      predecessorGeneration: 6,
      predecessorDeploymentId,
      predecessorCommitSha,
      mediaManifestDigest: "c".repeat(64),
      cloudflareEvidenceDigest: "d".repeat(64),
      deployedAt,
      deploymentId,
      deploymentVersionId: versionId,
    };
    const write = db.batch();
    write.set(pointerRef, pointer);
    write.set(batchRef, batch);
    await write.commit();
    return { pointerRef, batchRef, pointer, batch };
  }

  it("returns the aligned active batch without changing coordinator state", async () => {
    const seeded = await seedActiveDeployment();

    await expect(
      selectActivePublicBuildBatch({ firestore: db, commitSha }),
    ).resolves.toEqual({ buildBatchId, generation: 7, commitSha });
    expect((await seeded.pointerRef.get()).data()).toEqual(seeded.pointer);
    expect((await seeded.batchRef.get()).data()).toEqual(seeded.batch);
  });

  it("rejects a Pages source that differs from the active Worker", async () => {
    await seedActiveDeployment();

    await expect(
      selectActivePublicBuildBatch({
        firestore: db,
        commitSha: "f".repeat(40),
      }),
    ).rejects.toThrow(
      "The Pages source does not match one aligned active public deployment",
    );
  });

  it("rejects an unsettled generation before it reads an artifact", async () => {
    await seedActiveDeployment({ lastReservedGeneration: 8 });

    await expect(
      selectActivePublicBuildBatch({ firestore: db, commitSha }),
    ).rejects.toThrow(
      "The Pages source does not match one aligned active public deployment",
    );
  });
});

describe("acquirePublicDeploymentLease", () => {
  it("acquires one server-owned lease and captures the current active predecessor", async () => {
    await db.collection("system").doc("publicDeployment").set({
      schemaVersion: 1,
      mediaLifecycleReady: true,
      state: "idle",
      activeGeneration: 5,
      activeDeploymentId: "deployment-5",
      activeCommitSha: "a".repeat(40),
      lastReservedGeneration: 5,
      newestEligibleGeneration: 5,
      newestEligibleBuildBatchId: "build-five",
    });
    const reservation = await reserve("build-six", "b".repeat(40));
    await db.collection("system").doc("publicDeployment").update({
      activeGeneration: 4,
      activeDeploymentId: "deployment-4",
      activeCommitSha: "d".repeat(40),
    });
    await markReady("build-six");
    const injectedTimestamp = vi.fn(() => ({}));

    const result = await acquirePublicDeploymentLease({
      firestore: db,
      buildBatchId: "build-six",
      commitSha: "b".repeat(40),
      leaseToken: "caller-owned-token",
      serverTimestamp: injectedTimestamp,
    });

    expect(result.outcome).toBe("acquired");
    expect(result.idempotent).toBe(false);
    expect(result.lease.leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.lease.leaseToken).not.toBe("caller-owned-token");
    expect(injectedTimestamp).not.toHaveBeenCalled();
    expect(result.lease).toMatchObject({
      buildBatchId: "build-six",
      generation: 6,
      predecessorGeneration: 4,
      predecessorDeploymentId: "deployment-4",
      predecessorCommitSha: "d".repeat(40),
    });
    expect(reservation.batch.reservedAgainstGeneration).toBe(5);
    expect(result.lease.leaseAcquiredAt.toMillis()).toBeGreaterThanOrEqual(
      (await storedBatch("build-six")).readyAt.toMillis(),
    );
    expect(result.lease).not.toHaveProperty("leaseExpiresAt");
    expect(await storedPointer()).toMatchObject({
      state: "deploying",
      mediaLifecycleReady: true,
      activeGeneration: 4,
      activeDeploymentId: "deployment-4",
      activeCommitSha: "d".repeat(40),
      lastReservedGeneration: 6,
      newestEligibleGeneration: 6,
      newestEligibleBuildBatchId: "build-six",
      candidateGeneration: 6,
      candidateBuildBatchId: "build-six",
      candidateCommitSha: "b".repeat(40),
      predecessorGeneration: 4,
    });
  });

  it("returns the exact persisted lease on an exact retry", async () => {
    await reserve("build-one", "a".repeat(40));
    await markReady("build-one");
    const first = await acquire("build-one", "a".repeat(40));

    const retry = await acquire("build-one", "a".repeat(40));

    expect(retry).toEqual({
      outcome: "acquired",
      idempotent: true,
      lease: first.lease,
      candidate: first.candidate,
    });
  });

  it("refuses a reserved batch because only ready is eligible", async () => {
    await reserve("build-one", "a".repeat(40));

    await expect(acquire("build-one", "a".repeat(40))).rejects.toThrow(
      "build batch is invalid",
    );
    expect(await storedPointer()).toMatchObject({
      state: "idle",
      newestEligibleGeneration: 0,
    });
    expect(await storedBatch("build-one")).toMatchObject({ status: "reserved" });
  });

  it("preserves an active lease while a later build reserves a generation", async () => {
    await reserve("build-one", "a".repeat(40));
    await markReady("build-one");
    const acquired = await acquire("build-one", "a".repeat(40));

    const later = await reserve("build-two", "b".repeat(40));
    const retry = await acquire("build-one", "a".repeat(40));

    expect(later.batch.generation).toBe(2);
    expect(await storedPointer()).toMatchObject({
      state: "deploying",
      lastReservedGeneration: 2,
      newestEligibleGeneration: 1,
      candidateBuildBatchId: "build-one",
      leaseToken: acquired.lease.leaseToken,
    });
    expect(retry).toEqual({
      outcome: "acquired",
      idempotent: true,
      lease: acquired.lease,
      candidate: acquired.candidate,
    });
  });

  it("supersedes an older ready generation after the newer generation acquires", async () => {
    await reserve("build-one", "a".repeat(40));
    await reserve("build-two", "b".repeat(40));
    await Promise.all([markReady("build-one"), markReady("build-two")]);
    await acquire("build-two", "b".repeat(40));

    const result = await acquire("build-one", "a".repeat(40));
    const retry = await acquire("build-one", "a".repeat(40));

    expect(result).toMatchObject({
      outcome: "superseded",
      idempotent: false,
      supersession: {
        buildBatchId: "build-one",
        generation: 1,
        supersededReason: "newer_eligible_generation",
        supersededByGeneration: 2,
        supersededByBuildBatchId: "build-two",
      },
    });
    expect(retry).toEqual({ ...result, idempotent: true });
    expect(await storedBatch("build-one")).toMatchObject({
      status: "superseded",
      supersededByGeneration: 2,
      supersededByBuildBatchId: "build-two",
    });
  });

  it("supersedes an older caller before the newest ready generation acquires", async () => {
    await reserve("build-one", "a".repeat(40));
    await reserve("build-two", "b".repeat(40));
    await Promise.all([markReady("build-one"), markReady("build-two")]);

    const older = await acquire("build-one", "a".repeat(40));
    const newer = await acquire("build-two", "b".repeat(40));

    expect(older).toMatchObject({
      outcome: "superseded",
      supersession: {
        generation: 1,
        supersededByGeneration: 2,
        supersededByBuildBatchId: "build-two",
      },
    });
    expect(newer).toMatchObject({
      outcome: "acquired",
      lease: { generation: 2, buildBatchId: "build-two" },
    });
    expect(await storedPointer()).toMatchObject({
      state: "deploying",
      newestEligibleGeneration: 2,
      newestEligibleBuildBatchId: "build-two",
      candidateGeneration: 2,
      candidateBuildBatchId: "build-two",
    });
  }, 10_000);

  it("leaves a newer ready generation busy while another lease is active", async () => {
    await reserve("build-one", "a".repeat(40));
    await markReady("build-one");
    const first = await acquire("build-one", "a".repeat(40));
    await reserve("build-two", "b".repeat(40));
    await markReady("build-two");

    const result = await acquire("build-two", "b".repeat(40));
    const firstRetry = await acquire("build-one", "a".repeat(40));

    expect(result).toEqual({ outcome: "busy", idempotent: false });
    expect(firstRetry).toEqual({
      outcome: "acquired",
      idempotent: true,
      lease: first.lease,
      candidate: first.candidate,
    });
    expect(await storedBatch("build-two")).toMatchObject({ status: "ready" });
    expect(await storedPointer()).toMatchObject({
      state: "deploying",
      candidateBuildBatchId: "build-one",
      leaseToken: first.lease.leaseToken,
      newestEligibleGeneration: 2,
      newestEligibleBuildBatchId: "build-two",
      lastReservedGeneration: 2,
    });
  });

  it("does not supersede a ready batch still claimed by the active lease", async () => {
    await reserve("build-one", "a".repeat(40));
    await markReady("build-one");
    await acquire("build-one", "a".repeat(40));
    await reserve("build-two", "b".repeat(40));
    await markReady("build-two");
    const batchRef = db
      .collection("system")
      .doc("publicDeployment")
      .collection("buildBatches")
      .doc("build-one");
    await batchRef.update({
      status: "ready",
      leaseToken: admin.firestore.FieldValue.delete(),
      leaseAcquiredAt: admin.firestore.FieldValue.delete(),
      predecessorGeneration: admin.firestore.FieldValue.delete(),
      predecessorDeploymentId: admin.firestore.FieldValue.delete(),
      predecessorCommitSha: admin.firestore.FieldValue.delete(),
    });

    const pointerBefore = await storedPointer();
    const batchBefore = await storedBatch("build-one");
    await expect(acquire("build-one", "a".repeat(40))).rejects.toThrow(
      "lease receipt is invalid",
    );

    expect(await storedPointer()).toEqual(pointerBefore);
    expect(await storedBatch("build-one")).toEqual(batchBefore);
    expect(await acquire("build-two", "b".repeat(40))).toEqual({
      outcome: "busy",
      idempotent: false,
    });
  });

  it("does not replace a lease because its timestamp is old", async () => {
    await reserve("build-one", "a".repeat(40));
    await markReady("build-one");
    const first = await acquire("build-one", "a".repeat(40));
    const old = admin.firestore.Timestamp.fromDate(
      new Date("2020-01-01T00:00:00.000Z"),
    );
    await Promise.all([
      db.collection("system").doc("publicDeployment").update({
        leaseAcquiredAt: old,
      }),
      db
        .collection("system")
        .doc("publicDeployment")
        .collection("buildBatches")
        .doc("build-one")
        .update({ leaseAcquiredAt: old }),
    ]);
    await reserve("build-two", "b".repeat(40));
    await markReady("build-two");

    expect(await acquire("build-two", "b".repeat(40))).toEqual({
      outcome: "busy",
      idempotent: false,
    });
    expect(await storedPointer()).toMatchObject({
      state: "deploying",
      candidateBuildBatchId: "build-one",
      leaseToken: first.lease.leaseToken,
      leaseAcquiredAt: old,
    });
  });

  it("serializes concurrent acquisitions to one lease", async () => {
    await reserve("build-one", "a".repeat(40));
    await reserve("build-two", "b".repeat(40));
    await Promise.all([markReady("build-one"), markReady("build-two")]);

    const results = await Promise.all([
      acquire("build-one", "a".repeat(40)),
      acquire("build-two", "b".repeat(40)),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ outcome: "superseded" }),
      expect.objectContaining({ outcome: "acquired" }),
    ]);
    expect((await storedPointer()).candidateBuildBatchId).toBe("build-two");
    expect((await storedPointer()).state).toBe("deploying");
  });
});
