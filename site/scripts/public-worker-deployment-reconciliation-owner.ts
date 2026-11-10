// Event-driven owner for ambiguous public Worker deployment state. It listens
// to one coordination document, makes no idle poll, and runs one reconciliation
// at a time. Credentials are supplied only after the deployment-path gate and
// exact-source checks pass.

import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import {
  reconcilePublicWorkerDeployment,
} from "./reconcile-public-worker-deployment";

const requireModule = createRequire(import.meta.url);
const { ownsPublication, publicationRuntime } = requireModule("../../functions/lib/publication-runtime-owner.js");
const deploymentModule = requireModule(
  "../../functions/lib/public-deployment.js",
) as {
  assertPublicDeploymentPointer(value: unknown): PublicDeploymentPointer;
};
const coordinatorModule = requireModule(
  "../../functions/lib/public-deployment-coordinator.js",
) as {
  publicDeploymentRef(firestore: Firestore): PublicDeploymentDocumentReference;
};
const { assertPublicDeploymentPointer } = deploymentModule;
const { publicDeploymentRef } = coordinatorModule;

const CLOUDFLARE_TOKEN = /^[A-Za-z0-9_-]{20,80}$/;

export const PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS = Object.freeze([
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

interface PublicDeploymentPointer {
  runtime?: { owner: "node-compute" | "cloudflare"; release: string };
  state: "idle" | "deploying" | "reconciling";
  candidateBuildBatchId?: string;
  candidateGeneration?: number;
  candidateCommitSha?: string;
  leaseToken?: string;
}

interface PublicDeploymentSnapshot {
  exists: boolean;
  data(): unknown;
}

interface PublicDeploymentDocumentReference {
  onSnapshot(
    next: (snapshot: PublicDeploymentSnapshot) => void,
    error: (error: unknown) => void,
  ): () => void;
}

type ReconciliationResult =
  | { outcome: "idle"; idempotent: true }
  | {
      // The owner rejects "failed"; only the restore operator reports it.
      outcome: "deployed" | "reconciling" | "failed";
      idempotent: boolean;
      receipt?: Record<string, unknown>;
      [field: string]: unknown;
    };

interface ReconciliationOwnerDependencies {
  reconcile(input: {
    firestore: Firestore;
    cloudflareApiToken: string;
    runtime?: { owner: "node-compute" | "cloudflare"; release: string };
  }): Promise<ReconciliationResult>;
  scheduleRetry(callback: () => void, delayMs: number): unknown;
  cancelRetry(handle: unknown): void;
}

export interface PublicDeploymentReconciliationOwner {
  closed: Promise<{ reason: "stopped" }>;
  checkpoint(): number;
  stop(): void;
  waitForIdleAfter(checkpoint: number): Promise<void>;
}

export class PublicDeploymentReconciliationOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicDeploymentReconciliationOwnerError";
  }
}

export class PublicDeploymentReconciliationOwnerStoppedError
  extends PublicDeploymentReconciliationOwnerError {
  constructor(message: string) {
    super(message);
    this.name = "PublicDeploymentReconciliationOwnerStoppedError";
  }
}

function ownerError(message: string): never {
  throw new PublicDeploymentReconciliationOwnerError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function assertReconciliationResult(
  value: unknown,
): asserts value is ReconciliationResult {
  if (
    !plainObject(value) ||
    typeof value.idempotent !== "boolean" ||
    !["idle", "deployed", "reconciling"].includes(String(value.outcome)) ||
    (value.outcome === "idle" && value.idempotent !== true)
  ) {
    ownerError("The public deployment reconciliation result is invalid");
  }
}

function activeLeaseKey(pointer: PublicDeploymentPointer): string | null {
  if (pointer.state === "idle") return null;
  return JSON.stringify([
    pointer.candidateBuildBatchId,
    pointer.candidateGeneration,
    pointer.candidateCommitSha,
    pointer.leaseToken,
  ]);
}

const defaultDependencies: ReconciliationOwnerDependencies = {
  reconcile: reconcilePublicWorkerDeployment,
  scheduleRetry: (callback, delayMs) => setTimeout(callback, delayMs),
  cancelRetry: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function resolveDependencies(
  overrides: Partial<ReconciliationOwnerDependencies> | undefined,
): ReconciliationOwnerDependencies {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    ownerError("The public deployment reconciliation owner dependencies are invalid");
  }
  return dependencies;
}

export function startPublicWorkerDeploymentReconciliationOwner({
  firestore,
  cloudflareApiToken,
  runtime,
  dependencies: dependencyOverrides,
}: {
  firestore: Firestore;
  cloudflareApiToken: string;
  runtime?: { owner: "node-compute" | "cloudflare"; release: string };
  dependencies?: Partial<ReconciliationOwnerDependencies>;
}): PublicDeploymentReconciliationOwner {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function" ||
    !CLOUDFLARE_TOKEN.test(cloudflareApiToken ?? "")
  ) {
    ownerError("The public deployment reconciliation owner input is invalid");
  }
  if (runtime) publicationRuntime(runtime);
  const dependencies = resolveDependencies(dependencyOverrides);

  let detach: (() => void) | null = null;
  let retryHandle: unknown = null;
  let retryIndex = 0;
  let activeKey: string | null = null;
  let runRequested = false;
  let working = false;
  let closing = false;
  let closeError: Error | null = null;
  let closedSettled = false;
  let snapshotVersion = 0;
  let idleVersion = 0;
  const idleWaiters = new Set<{
    checkpoint: number;
    resolve(): void;
    reject(error: Error): void;
  }>();
  let resolveClosed: (value: { reason: "stopped" }) => void;
  let rejectClosed: (error: Error) => void;
  const closed = new Promise<{ reason: "stopped" }>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  const cancelScheduledRetry = () => {
    if (retryHandle === null) return;
    const handle = retryHandle;
    retryHandle = null;
    dependencies.cancelRetry(handle);
  };

  const settleClosed = () => {
    if (closedSettled || working || !closing) return;
    closedSettled = true;
    if (closeError) rejectClosed(closeError);
    else resolveClosed({ reason: "stopped" });
  };

  const rejectIdleWaiters = (error: Error) => {
    for (const waiter of idleWaiters) waiter.reject(error);
    idleWaiters.clear();
  };

  const resolveIdleWaiters = () => {
    for (const waiter of idleWaiters) {
      if (idleVersion <= waiter.checkpoint) continue;
      idleWaiters.delete(waiter);
      waiter.resolve();
    }
  };

  const close = (error: Error | null = null) => {
    if (closing) {
      if (error && !closeError) closeError = error;
      return;
    }
    closing = true;
    closeError = error;
    runRequested = false;
    cancelScheduledRetry();
    rejectIdleWaiters(
      error ?? new PublicDeploymentReconciliationOwnerStoppedError(
        "The public deployment reconciliation owner stopped before deployment became idle",
      ),
    );
    detach?.();
    settleClosed();
  };

  const requestRun = () => {
    if (closing || activeKey === null) return;
    runRequested = true;
    void drain();
  };

  const scheduleNextRetry = (leaseKey: string) => {
    cancelScheduledRetry();
    const delayIndex = Math.min(
      retryIndex,
      PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS.length - 1,
    );
    const delayMs = PUBLIC_DEPLOYMENT_RECONCILIATION_RETRY_DELAYS_MS[delayIndex];
    retryIndex += 1;
    let handle: unknown;
    handle = dependencies.scheduleRetry(() => {
      if (retryHandle !== handle) return;
      retryHandle = null;
      if (!closing && activeKey === leaseKey) requestRun();
    }, delayMs);
    if (handle === null || handle === undefined) {
      ownerError("The public deployment retry timer is invalid");
    }
    retryHandle = handle;
  };

  async function drain(): Promise<void> {
    if (working || closing || !runRequested || activeKey === null) return;
    runRequested = false;
    working = true;
    const leaseKey = activeKey;
    try {
      const result = await dependencies.reconcile({
        firestore,
        cloudflareApiToken,
        ...(runtime ? { runtime } : {}),
      });
      assertReconciliationResult(result);
      if (
        !closing &&
        activeKey === leaseKey &&
        result.outcome === "reconciling"
      ) {
        scheduleNextRetry(leaseKey);
      }
    } catch (error) {
      close(asError(error, "Public deployment reconciliation failed"));
    } finally {
      working = false;
      if (closing) settleClosed();
      else if (runRequested) void drain();
    }
  }

  const receive = (snapshot: PublicDeploymentSnapshot) => {
    if (closing) return;
    try {
      if (
        !snapshot ||
        snapshot.exists !== true ||
        typeof snapshot.data !== "function"
      ) {
        ownerError("The public deployment coordinator is missing");
      }
      const pointer = assertPublicDeploymentPointer(snapshot.data());
      if (snapshotVersion === Number.MAX_SAFE_INTEGER) {
        ownerError("The public deployment observation checkpoint is exhausted");
      }
      snapshotVersion += 1;
      const nextKey = activeLeaseKey(pointer);
      if (nextKey === null) {
        idleVersion = snapshotVersion;
        resolveIdleWaiters();
        activeKey = null;
        retryIndex = 0;
        runRequested = false;
        cancelScheduledRetry();
        return;
      }
      const owned = runtime ? ownsPublication(pointer, runtime) : pointer.runtime === undefined;
      if (!owned) {
        activeKey = null;
        runRequested = false;
        cancelScheduledRetry();
        return;
      }
      if (nextKey === activeKey) return;
      activeKey = nextKey;
      retryIndex = 0;
      cancelScheduledRetry();
      requestRun();
    } catch (error) {
      close(asError(error, "The public deployment listener snapshot is invalid"));
    }
  };

  const fail = (error: unknown) => {
    close(asError(error, "The public deployment listener failed"));
  };

  try {
    const possibleDetach: unknown = publicDeploymentRef(firestore)
      .onSnapshot(receive, fail);
    if (typeof possibleDetach !== "function") {
      close(new Error(
        "The public deployment listener did not return a detach function",
      ));
    } else {
      const verifiedDetach = possibleDetach as () => void;
      detach = verifiedDetach;
      if (closing) verifiedDetach();
    }
  } catch (error) {
    close(asError(error, "The public deployment listener could not start"));
  }

  const waitForIdleAfter = (checkpoint: number): Promise<void> => {
    if (
      !Number.isSafeInteger(checkpoint) ||
      checkpoint < 0 ||
      checkpoint > snapshotVersion
    ) {
      return Promise.reject(new PublicDeploymentReconciliationOwnerError(
        "The public deployment observation checkpoint is invalid",
      ));
    }
    if (closing) {
      return Promise.reject(
        closeError ?? new PublicDeploymentReconciliationOwnerStoppedError(
          "The public deployment reconciliation owner stopped before deployment became idle",
        ),
      );
    }
    if (idleVersion > checkpoint) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      idleWaiters.add({ checkpoint, resolve, reject });
    });
  };

  return {
    closed,
    checkpoint: () => snapshotVersion,
    stop: () => close(),
    waitForIdleAfter,
  };
}
