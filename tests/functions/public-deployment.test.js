import { describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import deployment from "../../functions/lib/public-deployment.js";

const admin = adminPkg;
const {
  PublicDeploymentFenceError,
  PublicDeploymentStateError,
  assertMediaLifecycleDeploymentFence,
  assertPublicDeploymentCancelledBatch,
  assertPublicDeploymentLeaseBatch,
  assertPublicDeploymentPointer,
  assertPublicDeploymentReservedBatch,
  initialPublicDeploymentPointer,
  planPublicDeploymentLeaseAcquisition,
  projectPublicBuildSupersession,
  projectPublicBuildReservation,
  projectPublicBuildReadiness,
  projectPublicDeploymentLease,
} = deployment;

const timestamp = admin.firestore.Timestamp.fromDate(
  new Date("2026-08-14T15:00:00.000Z"),
);

function ready(overrides = {}) {
  return {
    schemaVersion: 1,
    mediaLifecycleReady: true,
    state: "idle",
    activeGeneration: 7,
    activeDeploymentId: "deployment-7",
    activeCommitSha: "b".repeat(40),
    lastReservedGeneration: 7,
    newestEligibleGeneration: 7,
    newestEligibleBuildBatchId: "build-seven",
    ...overrides,
  };
}

function readyBatch(overrides = {}) {
  return {
    schemaVersion: 1,
    buildBatchId: "build-eight",
    generation: 8,
    status: "ready",
    commitSha: "c".repeat(40),
    reservedAgainstGeneration: 7,
    reservedAgainstDeploymentId: "deployment-7",
    reservedAgainstCommitSha: "b".repeat(40),
    cutoffAt: timestamp,
    reservedAt: timestamp,
    readyAt: timestamp,
    ...overrides,
  };
}

function deployingPointer(overrides = {}) {
  return ready({
    state: "deploying",
    lastReservedGeneration: 8,
    newestEligibleGeneration: 8,
    newestEligibleBuildBatchId: "build-eight",
    leaseToken: "11111111-1111-4111-8111-111111111111",
    leaseAcquiredAt: timestamp,
    candidateGeneration: 8,
    candidateBuildBatchId: "build-eight",
    candidateCommitSha: "c".repeat(40),
    predecessorGeneration: 7,
    predecessorDeploymentId: "deployment-7",
    predecessorCommitSha: "b".repeat(40),
    ...overrides,
  });
}

function deployingBatch(overrides = {}) {
  return readyBatch({
    status: "deploying",
    leaseToken: "11111111-1111-4111-8111-111111111111",
    leaseAcquiredAt: timestamp,
    predecessorGeneration: 7,
    predecessorDeploymentId: "deployment-7",
    predecessorCommitSha: "b".repeat(40),
    ...overrides,
  });
}

function reconcilingPointer(overrides = {}) {
  return deployingPointer({
    state: "reconciling",
    reconcilingAt: timestamp,
    cloudflareEvidenceDigest: "d".repeat(64),
    ...overrides,
  });
}

function reconcilingBatch(overrides = {}) {
  return deployingBatch({
    status: "reconciling",
    reconcilingAt: timestamp,
    cloudflareEvidenceDigest: "d".repeat(64),
    ...overrides,
  });
}

describe("public deployment fence", () => {
  it("returns the active deployment receipt only for a ready idle coordinator", () => {
    expect(assertMediaLifecycleDeploymentFence(ready())).toEqual({
      generation: 7,
      deploymentId: "deployment-7",
      commitSha: "b".repeat(40),
    });
  });

  it.each([
    null,
    {},
    ready({ schemaVersion: 2 }),
    ready({ mediaLifecycleReady: false }),
    ready({ state: "reconciling" }),
    ready({ activeGeneration: 0 }),
    ready({ activeGeneration: 1.5 }),
    ready({ activeDeploymentId: "deployment 7" }),
    ready({ activeDeploymentId: "d".repeat(129) }),
    ready({ activeCommitSha: "b".repeat(39) }),
    ready({ activeCommitSha: "b".repeat(41) }),
    ready({ activeCommitSha: "B".repeat(40) }),
    ready({ lastReservedGeneration: 6 }),
    ready({ newestEligibleGeneration: 6 }),
    ready({
      lastReservedGeneration: 8,
      newestEligibleGeneration: 8,
      newestEligibleBuildBatchId: "build-eight",
    }),
    ready({ lastReservedGeneration: 8 }),
    ready({ newestEligibleBuildBatchId: null }),
    ready({ leaseToken: "stale-lease" }),
  ])("fails closed for an invalid coordinator receipt", (value) => {
    expect(() => assertMediaLifecycleDeploymentFence(value)).toThrow(
      PublicDeploymentFenceError,
    );
  });
});

describe("public deployment data contract", () => {
  it("accepts only a typed cancelled reservation tombstone", () => {
    const cancellationReceipt = {
      schemaVersion: 1,
      reason: "source_superseded_before_candidate",
      queueId: "Apex0903Cutover00001",
      buildBatchId: "cms-Apex0903Cutover00001",
      generation: 37,
      queueCommitSha: "e".repeat(40),
      operatorCommitSha: "f".repeat(40),
      serializerId: "node-compute-primary",
      claimTokenDigest: "1".repeat(64),
      cutoffAt: timestamp,
      cancelledAt: timestamp,
    };
    const cancelled = {
      schemaVersion: 1,
      buildBatchId: cancellationReceipt.buildBatchId,
      generation: cancellationReceipt.generation,
      status: "cancelled",
      commitSha: cancellationReceipt.queueCommitSha,
      reservedAgainstGeneration: 7,
      reservedAgainstDeploymentId: "deployment-7",
      reservedAgainstCommitSha: "b".repeat(40),
      cutoffAt: timestamp,
      reservedAt: timestamp,
      cancelledReason: cancellationReceipt.reason,
      cancelledAt: timestamp,
      cancellationReceipt,
    };

    expect(assertPublicDeploymentCancelledBatch(
      cancelled,
      cancellationReceipt.buildBatchId,
    )).toEqual(cancelled);
    expect(() => assertPublicDeploymentCancelledBatch({
      ...cancelled,
      cancellationReceipt: {
        ...cancellationReceipt,
        serializerId: "x".repeat(65),
      },
    })).toThrow(PublicDeploymentStateError);
    expect(() => assertPublicDeploymentCancelledBatch({
      ...cancelled,
      cancellationReceipt: {
        ...cancellationReceipt,
        queueId: "short",
      },
    })).toThrow(PublicDeploymentStateError);
  });

  it("accepts a typed cancellation receipt bound to artifact inclusion", () => {
    const cancellationReceipt = {
      schemaVersion: 2,
      reason: "source_superseded_before_candidate",
      queueId: "Apex0903Cutover00001",
      buildBatchId: "cms-Apex0903Cutover00001",
      generation: 37,
      queueCommitSha: "e".repeat(40),
      operatorCommitSha: "f".repeat(40),
      serializerId: "node-compute-primary",
      claimTokenDigest: "1".repeat(64),
      cutoffAt: timestamp,
      artifactReceiptDigest: "2".repeat(64),
      artifactInclusionRecordedAt: timestamp,
      cancelledAt: timestamp,
    };
    const cancelled = {
      schemaVersion: 1,
      buildBatchId: cancellationReceipt.buildBatchId,
      generation: cancellationReceipt.generation,
      status: "cancelled",
      commitSha: cancellationReceipt.queueCommitSha,
      reservedAgainstGeneration: 7,
      reservedAgainstDeploymentId: "deployment-7",
      reservedAgainstCommitSha: "b".repeat(40),
      cutoffAt: timestamp,
      reservedAt: timestamp,
      cancelledReason: cancellationReceipt.reason,
      cancelledAt: timestamp,
      cancellationReceipt,
    };

    expect(assertPublicDeploymentCancelledBatch(
      cancelled,
      cancellationReceipt.buildBatchId,
    )).toEqual(cancelled);
    expect(() => assertPublicDeploymentCancelledBatch({
      ...cancelled,
      cancellationReceipt: {
        ...cancellationReceipt,
        artifactInclusionRecordedAt: null,
      },
    })).toThrow(PublicDeploymentStateError);
  });

  it("initializes with no active artifact and keeps media lifecycle disabled", () => {
    expect(initialPublicDeploymentPointer()).toEqual({
      schemaVersion: 1,
      mediaLifecycleReady: false,
      state: "idle",
      activeGeneration: 0,
      activeDeploymentId: null,
      activeCommitSha: null,
      lastReservedGeneration: 0,
      newestEligibleGeneration: 0,
      newestEligibleBuildBatchId: null,
    });
    expect(
      assertPublicDeploymentPointer(initialPublicDeploymentPointer()),
    ).toEqual(initialPublicDeploymentPointer());
  });

  it.each([
    ready({ schemaVersion: 2 }),
    ready({ lastReservedGeneration: 6 }),
    ready({ lastReservedGeneration: 7.5 }),
    ready({ activeDeploymentId: null }),
    ready({ activeCommitSha: "B".repeat(40) }),
    ready({
      activeGeneration: 0,
      activeDeploymentId: null,
      activeCommitSha: null,
      newestEligibleGeneration: 0,
      newestEligibleBuildBatchId: null,
    }),
    ready({
      state: "reconciling",
      leaseToken: "lease-8",
      candidateGeneration: 8,
      candidateBuildId: "build-8",
      candidateCommitSha: "c".repeat(40),
    }),
  ])("rejects a malformed or regressed pointer", (value) => {
    expect(() => assertPublicDeploymentPointer(value)).toThrow(
      PublicDeploymentStateError,
    );
  });

  it("rejects unimplemented non-idle pointer states and future fields", () => {
    expect(() =>
      assertPublicDeploymentPointer(
        ready({
          mediaLifecycleReady: false,
          state: "reconciling",
          lastReservedGeneration: 8,
          leaseToken: "lease-8",
          leaseAcquiredAt: "not-a-timestamp",
          candidateGeneration: 8,
          candidateBuildId: "build-8",
          candidateCommitSha: "c".repeat(40),
        }),
      ),
    ).toThrow(PublicDeploymentStateError);
    expect(() =>
      assertPublicDeploymentPointer(
        ready({ mediaLifecycleReady: false, futureLeaseField: "value" }),
      ),
    ).toThrow(PublicDeploymentStateError);
  });

  it("accepts an exact deploying pointer while the lifecycle fence stays closed", () => {
    expect(assertPublicDeploymentPointer(deployingPointer())).toEqual(
      deployingPointer(),
    );
    expect(() =>
      assertMediaLifecycleDeploymentFence(deployingPointer()),
    ).toThrow(PublicDeploymentFenceError);
  });

  it("accepts an exact reconciling pointer while the lifecycle fence stays closed", () => {
    expect(assertPublicDeploymentPointer(reconcilingPointer())).toEqual(
      reconcilingPointer(),
    );
    expect(() =>
      assertMediaLifecycleDeploymentFence(reconcilingPointer()),
    ).toThrow(PublicDeploymentFenceError);
  });

  it("accepts a newer eligible high-water mark without replacing the active lease", () => {
    const pointer = deployingPointer({
      lastReservedGeneration: 9,
      newestEligibleGeneration: 9,
      newestEligibleBuildBatchId: "build-nine",
    });

    expect(assertPublicDeploymentPointer(pointer)).toEqual(pointer);
    expect(() => assertMediaLifecycleDeploymentFence(pointer)).toThrow(
      PublicDeploymentFenceError,
    );
  });

  it.each([
    deployingPointer({ candidateGeneration: 7 }),
    deployingPointer({ candidateBuildBatchId: "another-build" }),
    deployingPointer({ predecessorGeneration: 6 }),
    deployingPointer({ predecessorDeploymentId: "another-deployment" }),
    deployingPointer({ leaseAcquiredAt: "not-a-timestamp" }),
    deployingPointer({ leaseExpiresAt: timestamp }),
  ])("rejects a malformed or extended deploying pointer", (value) => {
    expect(() => assertPublicDeploymentPointer(value)).toThrow(
      PublicDeploymentStateError,
    );
  });

  it("projects only the immutable reservation receipt", () => {
    const batch = {
      schemaVersion: 1,
      buildBatchId: "build-8",
      generation: 8,
      status: "deploying",
      leaseToken: "unvalidated-mutable-state",
      commitSha: "c".repeat(40),
      reservedAgainstGeneration: 7,
      reservedAgainstDeploymentId: "deployment-7",
      reservedAgainstCommitSha: "b".repeat(40),
      cutoffAt: timestamp,
      reservedAt: timestamp,
    };
    expect(projectPublicBuildReservation(batch, "build-8")).toEqual({
      schemaVersion: 1,
      buildBatchId: "build-8",
      generation: 8,
      commitSha: "c".repeat(40),
      reservedAgainstGeneration: 7,
      reservedAgainstDeploymentId: "deployment-7",
      reservedAgainstCommitSha: "b".repeat(40),
      cutoffAt: timestamp,
      reservedAt: timestamp,
    });
    expect(() =>
      projectPublicBuildReservation(
        { ...batch, buildBatchId: "another-build" },
        "build-8",
      ),
    ).toThrow(PublicDeploymentStateError);
    expect(() =>
      projectPublicBuildReservation(
        { ...batch, reservedAgainstGeneration: 9 },
        "build-8",
      ),
    ).toThrow(PublicDeploymentStateError);
  });

  it("validates an exact reserved batch before readiness", () => {
    const reserved = {
      ...readyBatch(),
      status: "reserved",
    };
    delete reserved.readyAt;

    expect(assertPublicDeploymentReservedBatch(reserved, "build-eight"))
      .toEqual(reserved);
    expect(() =>
      assertPublicDeploymentReservedBatch(
        { ...reserved, futureField: true },
        "build-eight",
      ),
    ).toThrow(PublicDeploymentStateError);
    expect(() =>
      assertPublicDeploymentReservedBatch(readyBatch(), "build-eight"),
    ).toThrow(PublicDeploymentStateError);
  });

  it("projects one immutable readiness receipt after status progression", () => {
    expect(projectPublicBuildReadiness(readyBatch(), "build-eight")).toEqual({
      schemaVersion: 1,
      buildBatchId: "build-eight",
      generation: 8,
      commitSha: "c".repeat(40),
      readyAt: timestamp,
    });
    expect(projectPublicBuildReadiness(deployingBatch(), "build-eight"))
      .toEqual({
        schemaVersion: 1,
        buildBatchId: "build-eight",
        generation: 8,
        commitSha: "c".repeat(40),
        readyAt: timestamp,
      });
  });
});

describe("public deployment lease contract", () => {
  it.each([
    readyBatch(),
    deployingBatch(),
    reconcilingBatch(),
    readyBatch({
      status: "superseded",
      supersededReason: "newer_eligible_generation",
      supersededAt: timestamp,
      supersededByGeneration: 9,
      supersededByBuildBatchId: "build-nine",
    }),
  ])("accepts the exact %s batch state", (batch) => {
    expect(
      assertPublicDeploymentLeaseBatch(batch, batch.buildBatchId),
    ).toEqual(batch);
  });

  it.each([
    readyBatch({ status: "reserved" }),
    readyBatch({ readyAt: "not-a-timestamp" }),
    readyBatch({
      readyAt: admin.firestore.Timestamp.fromDate(
        new Date("2020-01-01T00:00:00.000Z"),
      ),
    }),
    readyBatch({ futureField: true }),
    deployingBatch({ leaseToken: "bad token" }),
    deployingBatch({ predecessorGeneration: 8 }),
    readyBatch({
      status: "superseded",
      supersededReason: "timeout",
      supersededAt: timestamp,
      supersededByGeneration: 9,
      supersededByBuildBatchId: "build-nine",
    }),
  ])("rejects an ineligible or malformed lease batch", (batch) => {
    expect(() =>
      assertPublicDeploymentLeaseBatch(batch, batch.buildBatchId),
    ).toThrow(PublicDeploymentStateError);
  });

  it("plans acquire, retry, supersede, and busy without a Firestore dependency", () => {
    expect(
      planPublicDeploymentLeaseAcquisition(
        ready({
          lastReservedGeneration: 8,
          newestEligibleGeneration: 8,
          newestEligibleBuildBatchId: "build-eight",
        }),
        readyBatch(),
      ),
    ).toEqual({ action: "acquire" });
    expect(
      planPublicDeploymentLeaseAcquisition(
        deployingPointer(),
        deployingBatch(),
      ),
    ).toEqual({ action: "retry" });
    expect(
      planPublicDeploymentLeaseAcquisition(
        reconcilingPointer(),
        reconcilingBatch(),
      ),
    ).toEqual({ action: "retry" });
    expect(
      planPublicDeploymentLeaseAcquisition(
        ready({
          lastReservedGeneration: 9,
          newestEligibleGeneration: 9,
          newestEligibleBuildBatchId: "build-nine",
        }),
        readyBatch(),
      ),
    ).toEqual({
      action: "supersede",
      supersededByGeneration: 9,
      supersededByBuildBatchId: "build-nine",
    });
    expect(
      planPublicDeploymentLeaseAcquisition(
        deployingPointer({
          lastReservedGeneration: 9,
          newestEligibleGeneration: 9,
          newestEligibleBuildBatchId: "build-nine",
        }),
        readyBatch({
          buildBatchId: "build-nine",
          generation: 9,
          commitSha: "d".repeat(40),
        }),
      ),
    ).toEqual({ action: "busy" });
  });

  it("refuses a ready batch that the readiness boundary did not register", () => {
    expect(() =>
      planPublicDeploymentLeaseAcquisition(
        ready({ lastReservedGeneration: 8 }),
        readyBatch(),
      ),
    ).toThrow("eligible generation is invalid");
  });

  it("refuses to supersede a ready batch still claimed by the active lease", () => {
    const pointer = deployingPointer({
      lastReservedGeneration: 9,
      newestEligibleGeneration: 9,
      newestEligibleBuildBatchId: "build-nine",
    });

    expect(() =>
      planPublicDeploymentLeaseAcquisition(pointer, readyBatch()),
    ).toThrow("lease receipt is invalid");
  });

  it("refuses a superseded batch still claimed by the active lease", () => {
    const pointer = deployingPointer({
      lastReservedGeneration: 9,
      newestEligibleGeneration: 9,
      newestEligibleBuildBatchId: "build-nine",
    });
    const superseded = readyBatch({
      status: "superseded",
      supersededReason: "newer_eligible_generation",
      supersededAt: timestamp,
      supersededByGeneration: 9,
      supersededByBuildBatchId: "build-nine",
    });

    expect(() =>
      planPublicDeploymentLeaseAcquisition(pointer, superseded),
    ).toThrow("lease receipt is invalid");
  });

  it("refuses to reacquire the already active generation", () => {
    expect(() =>
      planPublicDeploymentLeaseAcquisition(
        ready(),
        readyBatch({
          buildBatchId: "build-seven",
          generation: 7,
          reservedAgainstGeneration: 6,
          reservedAgainstDeploymentId: "deployment-6",
          reservedAgainstCommitSha: "a".repeat(40),
        }),
      ),
    ).toThrow("eligible generation is invalid");
  });

  it("projects only immutable lease and supersession receipts", () => {
    expect(projectPublicDeploymentLease(deployingBatch(), "build-eight"))
      .toEqual({
        schemaVersion: 1,
        buildBatchId: "build-eight",
        generation: 8,
        commitSha: "c".repeat(40),
        leaseToken: "11111111-1111-4111-8111-111111111111",
        leaseAcquiredAt: timestamp,
        predecessorGeneration: 7,
        predecessorDeploymentId: "deployment-7",
        predecessorCommitSha: "b".repeat(40),
      });
    expect(
      projectPublicBuildSupersession(
        readyBatch({
          status: "superseded",
          supersededReason: "newer_eligible_generation",
          supersededAt: timestamp,
          supersededByGeneration: 9,
          supersededByBuildBatchId: "build-nine",
        }),
        "build-eight",
      ),
    ).toEqual({
      schemaVersion: 1,
      buildBatchId: "build-eight",
      generation: 8,
      commitSha: "c".repeat(40),
      supersededReason: "newer_eligible_generation",
      supersededAt: timestamp,
      supersededByGeneration: 9,
      supersededByBuildBatchId: "build-nine",
    });
  });

  it("rejects a supersession receipt if the eligible high-water mark regressed", () => {
    expect(() =>
      planPublicDeploymentLeaseAcquisition(
        ready({
          lastReservedGeneration: 9,
          newestEligibleGeneration: 8,
          newestEligibleBuildBatchId: "build-eight",
        }),
        readyBatch({
          status: "superseded",
          supersededReason: "newer_eligible_generation",
          supersededAt: timestamp,
          supersededByGeneration: 9,
          supersededByBuildBatchId: "build-nine",
        }),
      ),
    ).toThrow("generation counter regressed");
  });
});
