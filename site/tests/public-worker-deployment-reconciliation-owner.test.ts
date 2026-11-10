// @vitest-environment node

import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import {
  PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS,
  PublicDeploymentReconciliationOwnerStoppedError,
  startPublicWorkerDeploymentReconciliationOwner,
} from "../scripts/public-worker-deployment-reconciliation-owner";

const TOKEN = "t".repeat(40);
const COMMIT_SHA = "a".repeat(40);
const timestamp = {
  toMillis: () => Date.parse("2026-08-28T20:00:00.000Z"),
};

function idlePointer() {
  return {
    schemaVersion: 1,
    mediaLifecycleReady: false,
    state: "idle",
    activeGeneration: 0,
    activeDeploymentId: null,
    activeCommitSha: null,
    lastReservedGeneration: 0,
    newestEligibleGeneration: 0,
    newestEligibleBuildBatchId: null,
  };
}

function activePointer(
  buildBatchId = "build-one",
  generation = 1,
  state: "deploying" | "reconciling" = "deploying",
) {
  const pointer = {
    schemaVersion: 1,
    mediaLifecycleReady: false,
    state,
    activeGeneration: 0,
    activeDeploymentId: null,
    activeCommitSha: null,
    lastReservedGeneration: generation,
    newestEligibleGeneration: generation,
    newestEligibleBuildBatchId: buildBatchId,
    leaseToken: `lease-${generation}`,
    leaseAcquiredAt: timestamp,
    candidateGeneration: generation,
    candidateBuildBatchId: buildBatchId,
    candidateCommitSha: COMMIT_SHA,
    predecessorGeneration: 0,
    predecessorDeploymentId: null,
    predecessorCommitSha: null,
  };
  return state === "reconciling"
    ? {
        ...pointer,
        reconcilingAt: timestamp,
        cloudflareEvidenceDigest: "b".repeat(64),
      }
    : pointer;
}

function listenerHarness() {
  let next: ((snapshot: unknown) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const onSnapshot = vi.fn((
    nextHandler: (snapshot: unknown) => void,
    errorHandler: (error: unknown) => void,
  ) => {
    next = nextHandler;
    fail = errorHandler;
    return unsubscribe;
  });
  const doc = vi.fn(() => ({ onSnapshot }));
  const collection = vi.fn(() => ({ doc }));
  return {
    firestore: {
      collection,
      runTransaction: vi.fn(),
    } as unknown as Firestore,
    emit(value: unknown) {
      next?.({ exists: true, data: () => value });
    },
    emitMissing() {
      next?.({ exists: false, data: () => undefined });
    },
    fail(error: unknown) {
      fail?.(error);
    },
    collection,
    doc,
    onSnapshot,
    unsubscribe,
  };
}

interface ScheduledRetry {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

type ReconcileFunction = NonNullable<NonNullable<
  Parameters<typeof startPublicWorkerDeploymentReconciliationOwner>[0][
    "dependencies"
  ]
>["reconcile"]>;
type ReconciliationResult = Awaited<ReturnType<ReconcileFunction>>;
type Reconcile = ReturnType<typeof vi.fn<ReconcileFunction>>;

function timerHarness() {
  const scheduled: ScheduledRetry[] = [];
  const scheduleRetry = vi.fn((callback: () => void, delayMs: number) => {
    const retry = { callback, delayMs, cancelled: false };
    scheduled.push(retry);
    return retry;
  });
  const cancelRetry = vi.fn((retry: ScheduledRetry) => {
    retry.cancelled = true;
  });
  return { scheduled, scheduleRetry, cancelRetry };
}

function startFixture({
  reconcile = vi.fn<ReconcileFunction>(
    async () => ({
      outcome: "reconciling",
      idempotent: true,
    }),
  ),
}: { reconcile?: Reconcile } = {}) {
  const listener = listenerHarness();
  const timers = timerHarness();
  const owner = startPublicWorkerDeploymentReconciliationOwner({
    firestore: listener.firestore,
    cloudflareApiToken: TOKEN,
    dependencies: {
      reconcile,
      scheduleRetry: timers.scheduleRetry,
      cancelRetry: timers.cancelRetry,
    },
  });
  return { listener, timers, reconcile, owner };
}

describe("public Worker deployment reconciliation owner", () => {
  it("advances its checkpoint and resolves an older wait on idle", async () => {
    const fixture = startFixture();
    expect(fixture.owner.checkpoint()).toBe(0);
    const idle = fixture.owner.waitForIdleAfter(0);

    fixture.listener.emit(idlePointer());

    await expect(idle).resolves.toBeUndefined();
    expect(fixture.owner.checkpoint()).toBe(1);
    fixture.owner.stop();
    await fixture.owner.closed;
  });

  it("waits for an idle observation newer than the supplied checkpoint", async () => {
    const fixture = startFixture();
    fixture.listener.emit(idlePointer());
    const checkpoint = fixture.owner.checkpoint();
    let settled = false;
    const idle = fixture.owner.waitForIdleAfter(checkpoint).then(() => {
      settled = true;
    });

    fixture.listener.emit(activePointer());
    await Promise.resolve();
    expect(settled).toBe(false);
    fixture.listener.emit(idlePointer());

    await expect(idle).resolves.toBeUndefined();
    fixture.owner.stop();
    await fixture.owner.closed;
  });

  it.each([-1, 0.5, Number.NaN, 1])(
    "rejects invalid or future checkpoint %s",
    async (checkpoint) => {
      const fixture = startFixture();

      await expect(fixture.owner.waitForIdleAfter(checkpoint))
        .rejects.toThrow(/checkpoint is invalid/i);
      fixture.owner.stop();
      await fixture.owner.closed;
    },
  );

  it("rejects an idle waiter when the owner stops", async () => {
    const fixture = startFixture();
    const idleError = fixture.owner.waitForIdleAfter(0).catch(
      (error: unknown) => error,
    );

    fixture.owner.stop();

    const error = await idleError;
    expect(error).toBeInstanceOf(PublicDeploymentReconciliationOwnerStoppedError);
    expect(error).toHaveProperty(
      "message",
      expect.stringMatching(/stopped before deployment became idle/i),
    );
    await fixture.owner.closed;
  });

  it("rejects an idle waiter with the listener failure", async () => {
    const fixture = startFixture();
    const idle = fixture.owner.waitForIdleAfter(0);

    fixture.listener.fail(new Error("listen failed"));

    await expect(idle).rejects.toThrow(/listen failed/i);
    await expect(fixture.owner.closed).rejects.toThrow(/listen failed/i);
  });

  it("uses one document listener and makes no provider call while idle", async () => {
    const fixture = startFixture();

    expect(fixture.listener.collection).toHaveBeenCalledWith("system");
    expect(fixture.listener.doc).toHaveBeenCalledWith("publicDeployment");
    expect(fixture.listener.onSnapshot).toHaveBeenCalledTimes(1);
    fixture.listener.emit(idlePointer());
    await Promise.resolve();

    expect(fixture.reconcile).not.toHaveBeenCalled();
    expect(fixture.timers.scheduleRetry).not.toHaveBeenCalled();
    fixture.owner.stop();
    await expect(fixture.owner.closed).resolves.toEqual({ reason: "stopped" });
  });

  it("reconciles immediately, deduplicates snapshots, and uses the bounded retry ladder", async () => {
    const fixture = startFixture();
    fixture.listener.emit(activePointer());

    await vi.waitFor(() => expect(fixture.reconcile).toHaveBeenCalledTimes(1));
    expect(fixture.reconcile).toHaveBeenCalledWith({
      firestore: fixture.listener.firestore,
      cloudflareApiToken: TOKEN,
    });
    await vi.waitFor(() => expect(fixture.timers.scheduled).toHaveLength(1));
    fixture.listener.emit(activePointer("build-one", 1, "reconciling"));
    await Promise.resolve();
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);

    for (
      let index = 0;
      index < PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS.length;
      index += 1
    ) {
      const retry = fixture.timers.scheduled[index];
      expect(retry.delayMs).toBe(
        PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS[index],
      );
      retry.callback();
      await vi.waitFor(() => {
        expect(fixture.reconcile).toHaveBeenCalledTimes(index + 2);
        expect(fixture.timers.scheduled).toHaveLength(index + 2);
      });
    }
    expect(PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      15_000,
      25_000,
      60_000,
      120_000,
      300_000,
    ]);
    expect(
      PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS
        .slice(0, 6)
        .reduce((total, delay) => total + delay, 0),
    ).toBe(55_000);
    expect(fixture.timers.scheduled.at(-1)?.delayMs).toBe(300_000);

    fixture.owner.stop();
    await fixture.owner.closed;
  });

  it("runs only one reconciliation and queues a new lease behind it", async () => {
    let releaseFirst: ((value: ReconciliationResult) => void) | undefined;
    const reconcile = vi.fn<ReconcileFunction>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = resolve;
      }))
      .mockResolvedValueOnce({ outcome: "deployed", idempotent: false });
    const fixture = startFixture({ reconcile });

    fixture.listener.emit(activePointer());
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    fixture.listener.emit(activePointer());
    fixture.listener.emit(activePointer("build-two", 2));
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);

    releaseFirst?.({ outcome: "idle", idempotent: true });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    expect(fixture.timers.scheduleRetry).not.toHaveBeenCalled();

    fixture.owner.stop();
    await fixture.owner.closed;
  });

  it("resets a partly used retry ladder for a new exact lease", async () => {
    const fixture = startFixture();
    fixture.listener.emit(activePointer());
    await vi.waitFor(() => expect(fixture.timers.scheduled).toHaveLength(1));
    fixture.timers.scheduled[0].callback();
    await vi.waitFor(() => expect(fixture.timers.scheduled).toHaveLength(2));
    expect(fixture.timers.scheduled[1].delayMs).toBe(2_000);

    fixture.listener.emit(activePointer("build-two", 2));
    await vi.waitFor(() => expect(fixture.reconcile).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(fixture.timers.scheduled).toHaveLength(3));
    expect(fixture.timers.scheduled[1].cancelled).toBe(true);
    expect(fixture.timers.scheduled[2].delayMs).toBe(1_000);

    fixture.owner.stop();
    await fixture.owner.closed;
  });

  it("cancels a pending retry when the coordinator becomes idle", async () => {
    const fixture = startFixture();
    fixture.listener.emit(activePointer());
    await vi.waitFor(() => expect(fixture.timers.scheduled).toHaveLength(1));
    const retry = fixture.timers.scheduled[0];

    fixture.listener.emit(idlePointer());
    expect(fixture.timers.cancelRetry).toHaveBeenCalledWith(retry);
    retry.callback();
    await Promise.resolve();
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);

    fixture.owner.stop();
    await fixture.owner.closed;
  });

  it("does not schedule another check after a verified deployment", async () => {
    const reconcile = vi.fn<ReconcileFunction>(async () => ({
      outcome: "deployed",
      idempotent: false,
    }));
    const fixture = startFixture({ reconcile });

    fixture.listener.emit(activePointer());
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(fixture.timers.scheduleRetry).not.toHaveBeenCalled();

    fixture.owner.stop();
    await fixture.owner.closed;
  });

  it("stops and rejects when the Firestore listener fails", async () => {
    const fixture = startFixture();
    fixture.listener.fail(new Error("listen failed"));

    await expect(fixture.owner.closed).rejects.toThrow(/listen failed/);
    expect(fixture.listener.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.timers.scheduleRetry).not.toHaveBeenCalled();
  });

  it("fails closed when the listener does not return a detach function", async () => {
    const firestore = {
      collection: vi.fn(() => ({
        doc: vi.fn(() => ({ onSnapshot: vi.fn(() => null) })),
      })),
      runTransaction: vi.fn(),
    } as unknown as Firestore;
    const owner = startPublicWorkerDeploymentReconciliationOwner({
      firestore,
      cloudflareApiToken: TOKEN,
    });

    await expect(owner.closed).rejects.toThrow(/detach function/i);
  });

  it("stops and rejects when reconciliation fails", async () => {
    const fixture = startFixture({
      reconcile: vi.fn(async () => {
        throw new Error("Firestore settlement failed");
      }),
    });
    fixture.listener.emit(activePointer());

    await expect(fixture.owner.closed).rejects.toThrow(/settlement failed/);
    expect(fixture.listener.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an invalid reconciliation result", async () => {
    const fixture = startFixture({
      reconcile: vi.fn<ReconcileFunction>(async () => ({
        outcome: "idle",
        idempotent: false,
      } as unknown as ReconciliationResult)),
    });
    fixture.listener.emit(activePointer());

    await expect(fixture.owner.closed).rejects.toThrow(/result is invalid/i);
    expect(fixture.listener.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("waits for an active reconciliation during clean shutdown", async () => {
    let release: ((value: ReconciliationResult) => void) | undefined;
    const fixture = startFixture({
      reconcile: vi.fn<ReconcileFunction>(
        () => new Promise((resolve) => {
          release = resolve;
        }),
      ),
    });
    fixture.listener.emit(activePointer());
    await vi.waitFor(() => expect(fixture.reconcile).toHaveBeenCalledTimes(1));
    let closed = false;
    void fixture.owner.closed.then(() => {
      closed = true;
    });

    fixture.owner.stop();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(fixture.listener.unsubscribe).toHaveBeenCalledTimes(1);
    release?.({ outcome: "idle", idempotent: true });
    await expect(fixture.owner.closed).resolves.toEqual({ reason: "stopped" });
  });

  it("reports an active reconciliation failure after clean shutdown starts", async () => {
    let failReconciliation: ((error: Error) => void) | undefined;
    const fixture = startFixture({
      reconcile: vi.fn<ReconcileFunction>(
        () => new Promise((_resolve, reject) => {
          failReconciliation = reject;
        }),
      ),
    });
    fixture.listener.emit(activePointer());
    await vi.waitFor(() => expect(fixture.reconcile).toHaveBeenCalledTimes(1));

    fixture.owner.stop();
    failReconciliation?.(new Error("active reconciliation failed"));

    await expect(fixture.owner.closed).rejects.toThrow(
      /active reconciliation failed/i,
    );
    expect(fixture.listener.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a missing coordinator document", async () => {
    const fixture = startFixture();
    fixture.listener.emitMissing();

    await expect(fixture.owner.closed).rejects.toThrow(/coordinator.*missing/i);
    expect(fixture.listener.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });
});
