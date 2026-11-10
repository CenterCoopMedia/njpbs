import { cloudflarePublicWorkerTag } from "./cloudflare-account.mjs";
// Reconciliation retains ambiguous leases. Only the explicit predecessor
// restore entry below can move traffic, with the same retained lease and owner.

import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type {
  DocumentReference,
  Firestore,
} from "firebase-admin/firestore";
import {
  assertPreparedPublicWorkerArtifact,
  publicPublicationReceiptMatchesPreparedArtifact,
  type PreparedPublicWorkerArtifact,
} from "../src/lib/public-worker-artifact";
import {
  activeDeployment,
  assertPublicWorkerIdentity,
  assertUploadOnlyProductionTrigger,
  PUBLICATION_PROBE_ORIGIN,
  PUBLICATION_PROBE_PATH,
  PUBLIC_WORKER_NAME,
  requestCloudflareJson,
  requestPublicPublicationReceipt,
  workerApiPath,
} from "./activate-public-worker-candidate";

const requireModule = createRequire(import.meta.url);
const { ownsPublication, assertPublicationOwner, assertRuntimeSource } = requireModule("../../functions/lib/publication-runtime-owner.js");
type PublicationRuntime = { owner: "node-compute" | "cloudflare"; release: string };
const { verifyNoBuildPostPublicRoute } = requireModule("../../functions/lib/no-build-post-recovery.js") as {
  verifyNoBuildPostPublicRoute(input: { firestore: Firestore; candidate: PublicWorkerCandidate }): Promise<void> };
const deploymentModule = requireModule(
  "../../functions/lib/public-deployment.js",
) as {
  assertPublicDeploymentPointer(value: unknown): PublicDeploymentPointer;
  projectPublicDeploymentLease(
    value: unknown,
    expectedBuildBatchId: string,
  ): PublicDeploymentLease;
  timestampMillis(value: unknown): number | null;
  isPublicDeploymentIdentifier(value: unknown): boolean;
};
const coordinatorModule = requireModule(
  "../../functions/lib/public-deployment-coordinator.js",
) as {
  publicBuildBatchRef(
    firestore: Firestore,
    buildBatchId: string,
  ): DocumentReference;
  publicDeploymentRef(firestore: Firestore): DocumentReference;
  publicWorkerCandidateRef(
    firestore: Firestore,
    buildBatchId: string,
  ): DocumentReference;
};
const candidateModule = requireModule(
  "../../functions/lib/public-worker-candidate.js",
) as {
  assertPublicWorkerCandidateMatchesBatch(
    candidate: unknown,
    batch: unknown,
  ): PublicWorkerCandidate;
};
const activationEvidenceModule = requireModule(
  "../../functions/lib/public-worker-activation.js",
) as {
  planPublicWorkerActivationEvidence(input: {
    lease: PublicDeploymentLease;
    candidate: PublicWorkerCandidate;
    deploymentStatus: unknown;
    deploymentSource: "api";
  }): ActivationEvidence;
  projectApiDeploymentStatus(value: unknown): { deploymentId: string; versionId: string };
};
const { publicDeploymentCloudflareEvidenceDigest } = requireModule(
  "../../functions/lib/public-deployment-cloudflare.js",
) as {
  publicDeploymentCloudflareEvidenceDigest(evidence: ActivationEvidence, buildBatchId: string): string;
};
const outcomeStoreModule = requireModule(
  "../../functions/lib/public-deployment-outcome-store.js",
) as {
  PublicDeploymentTerminalEvidenceError: new (message: string) => Error;
  settlePublicDeploymentOutcome(input: {
    firestore: Firestore;
    lease: PublicDeploymentLease;
    evidence: ActivationEvidence;
    runtime?: PublicationRuntime;
  }): Promise<ReconciliationResult>;
  readPublicDeploymentPredecessorRestore(input: { firestore: Firestore; buildBatchId: string; predecessorBuildBatchId: string; runtime?: PublicationRuntime }):
    Promise<{ lease: PublicDeploymentLease; candidate: PublicWorkerCandidate; predecessor: PublicWorkerCandidate } |
      { completed: { lease: PublicDeploymentLease; evidence: ActivationEvidence } }>;
};

const {
  assertPublicDeploymentPointer,
  projectPublicDeploymentLease,
  timestampMillis,
  isPublicDeploymentIdentifier,
} = deploymentModule;
const {
  publicBuildBatchRef,
  publicDeploymentRef,
  publicWorkerCandidateRef,
} = coordinatorModule;
const { assertPublicWorkerCandidateMatchesBatch } = candidateModule;
const { planPublicWorkerActivationEvidence } = activationEvidenceModule;
const { projectApiDeploymentStatus } = activationEvidenceModule;
const { settlePublicDeploymentOutcome, PublicDeploymentTerminalEvidenceError } = outcomeStoreModule;
const { readPublicDeploymentPredecessorRestore } = outcomeStoreModule;

const CLOUDFLARE_TOKEN = /^[A-Za-z0-9_-]{20,80}$/;

interface PublicDeploymentPointer {
  runtime?: PublicationRuntime;
  state: "idle" | "deploying" | "reconciling";
  candidateBuildBatchId?: string;
  candidateGeneration?: number;
  candidateCommitSha?: string;
  leaseToken?: string;
  leaseAcquiredAt?: unknown;
  predecessorGeneration?: number;
  predecessorDeploymentId?: string | null;
  predecessorCommitSha?: string | null;
  reconcilingAt?: unknown;
  cloudflareEvidenceDigest?: string;
}

interface PublicDeploymentLease {
  runtime?: PublicationRuntime;
  schemaVersion: 1;
  buildBatchId: string;
  generation: number;
  commitSha: string;
  leaseToken: string;
  leaseAcquiredAt: unknown;
  predecessorGeneration: number;
  predecessorDeploymentId: string | null;
  predecessorCommitSha: string | null;
}

interface PublicWorkerCandidate {
  schemaVersion: 1;
  buildBatchId: string;
  generation: number;
  commitSha: string;
  workerVersionId: string;
  artifactDigest: string;
  artifactReceiptDigest: string;
  publicationReceiptDigest: string;
  mediaManifestDigest: string;
  artifactFileCount: number;
  artifactBytes: number;
  [field: string]: unknown;
}

type ActivationEvidence =
  | { action: "reconcile" }
  | { action: "restore-predecessor"; buildBatchId: string; predecessor: Record<string, unknown> }
  | {
      action: "activate";
      buildBatchId: string;
      deploymentId: string;
      versionId: string;
      commitSha: string;
    };

type ReconciliationResult =
  | { outcome: "idle"; idempotent: true }
  | {
      outcome: "deployed" | "reconciling" | "failed";
      idempotent: boolean;
      receipt?: Record<string, unknown>;
      [field: string]: unknown;
    };

interface ReconciliationState {
  lease: PublicDeploymentLease;
  candidate: PublicWorkerCandidate;
}

interface CloudflareRequest {
  url: string;
  method: "GET" | "POST";
  token: string;
  body?: unknown;
}

type RequestJson = (request: CloudflareRequest) => Promise<unknown>;
type RequestPublication = (url: string) => Promise<string>;
type ReadState = (firestore: Firestore, runtime?: PublicationRuntime) => Promise<ReconciliationState | null>;
type SettleOutcome = (input: {
  runtime?: PublicationRuntime;
  firestore: Firestore;
  lease: PublicDeploymentLease;
  evidence: ActivationEvidence;
}) => Promise<ReconciliationResult>;

export class PublicWorkerReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicWorkerReconciliationError";
  }
}

function reconciliationError(message: string): never {
  throw new PublicWorkerReconciliationError(message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function snapshotExists(value: unknown): value is {
  exists: true;
  data(): unknown;
} {
  return plainObject(value) && value.exists === true &&
    typeof value.data === "function";
}

function sameTimestamp(left: unknown, right: unknown): boolean {
  const leftMillis = timestampMillis(left);
  return leftMillis !== null && leftMillis === timestampMillis(right);
}

function assertPointerLeaseAlignment(
  pointer: PublicDeploymentPointer,
  batch: Record<string, unknown>,
  lease: PublicDeploymentLease,
): void {
  const matchingReconciliation = pointer.state !== "reconciling" ||
    (sameTimestamp(pointer.reconcilingAt, batch.reconcilingAt) &&
      pointer.cloudflareEvidenceDigest === batch.cloudflareEvidenceDigest);
  if (
    !isDeepStrictEqual(pointer.runtime, batch.runtime) ||
    pointer.state !== batch.status ||
    !matchingReconciliation ||
    pointer.candidateBuildBatchId !== lease.buildBatchId ||
    pointer.candidateGeneration !== lease.generation ||
    pointer.candidateCommitSha !== lease.commitSha ||
    pointer.leaseToken !== lease.leaseToken ||
    !sameTimestamp(pointer.leaseAcquiredAt, lease.leaseAcquiredAt) ||
    pointer.predecessorGeneration !== lease.predecessorGeneration ||
    pointer.predecessorDeploymentId !== lease.predecessorDeploymentId ||
    pointer.predecessorCommitSha !== lease.predecessorCommitSha
  ) {
    reconciliationError(
      "The public deployment reconciliation lease is invalid",
    );
  }
}

export async function readPublicDeploymentReconciliationState(
  firestore: Firestore,
  runtime?: PublicationRuntime,
): Promise<ReconciliationState | null> {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    reconciliationError(
      "Firestore is required for public deployment reconciliation",
    );
  }
  return firestore.runTransaction(async (transaction) => {
    const pointerSnapshot = await transaction.get(publicDeploymentRef(firestore));
    if (!snapshotExists(pointerSnapshot)) {
      reconciliationError("The public deployment coordinator does not exist");
    }
    const pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
    if (pointer.state === "idle") return null;
    const executor = runtime ?? { owner: "node-compute", release: pointer.candidateCommitSha };
    if (!ownsPublication(pointer, executor)) return null;
    if (pointer.runtime !== undefined) assertRuntimeSource(executor, pointer.candidateCommitSha);
    const buildBatchId = pointer.candidateBuildBatchId;
    if (typeof buildBatchId !== "string") {
      reconciliationError(
        "The public deployment reconciliation lease is invalid",
      );
    }
    const [batchSnapshot, candidateSnapshot] = await transaction.getAll(
      publicBuildBatchRef(firestore, buildBatchId),
      publicWorkerCandidateRef(firestore, buildBatchId),
    );
    if (!snapshotExists(batchSnapshot) || !snapshotExists(candidateSnapshot)) {
      reconciliationError(
        "The public deployment reconciliation state is incomplete",
      );
    }
    const batchValue = batchSnapshot.data();
    if (!plainObject(batchValue)) {
      reconciliationError(
        "The public deployment reconciliation batch is invalid",
      );
    }
    assertPublicationOwner(batchValue, executor);
    const lease = projectPublicDeploymentLease(batchValue, buildBatchId);
    assertPointerLeaseAlignment(pointer, batchValue, lease);
    const candidate = assertPublicWorkerCandidateMatchesBatch(
      candidateSnapshot.data(),
      batchValue,
    );
    return Object.freeze({ lease, candidate });
  });
}

function preparedFromCandidate(
  candidate: PublicWorkerCandidate,
): PreparedPublicWorkerArtifact {
  return assertPreparedPublicWorkerArtifact({
    schemaVersion: candidate.schemaVersion,
    digestAlgorithm: "sha256",
    buildBatchId: candidate.buildBatchId,
    generation: candidate.generation,
    commitSha: candidate.commitSha,
    artifactDigest: candidate.artifactDigest,
    artifactReceiptDigest: candidate.artifactReceiptDigest,
    publicationReceiptDigest: candidate.publicationReceiptDigest,
    mediaManifestDigest: candidate.mediaManifestDigest,
    artifactFileCount: candidate.artifactFileCount,
    artifactBytes: candidate.artifactBytes,
  });
}

async function collectActivationEvidence({
  firestore,
  state,
  cloudflareApiToken,
  requestJson,
  requestPublication,
}: {
  state: ReconciliationState;
  firestore: Firestore;
  cloudflareApiToken: string;
  requestJson: RequestJson;
  requestPublication: RequestPublication;
}): Promise<ActivationEvidence> {
  cloudflarePublicWorkerTag();
  try {
    const workerResponse = await requestJson({
      url: workerApiPath("/workers/scripts"),
      method: "GET",
      token: cloudflareApiToken,
    });
    const workerTag = assertPublicWorkerIdentity(workerResponse);
    const triggerResponse = await requestJson({
      url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
      method: "GET",
      token: cloudflareApiToken,
    });
    assertUploadOnlyProductionTrigger(triggerResponse, workerTag);
    const deploymentsResponse = await requestJson({
      url: workerApiPath(`/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`),
      method: "GET",
      token: cloudflareApiToken,
    });
    let evidence = planPublicWorkerActivationEvidence({
      lease: state.lease,
      candidate: state.candidate,
      deploymentStatus: activeDeployment(deploymentsResponse),
      deploymentSource: "api",
    });
    if (evidence.action !== "activate") return evidence;

    const prepared = preparedFromCandidate(state.candidate);
    const probe = new URL(PUBLICATION_PROBE_PATH, PUBLICATION_PROBE_ORIGIN);
    probe.searchParams.set("candidate", prepared.buildBatchId);
    probe.searchParams.set("version", state.candidate.workerVersionId);
    const body = await requestPublication(probe.toString());
    if (!publicPublicationReceiptMatchesPreparedArtifact(body, prepared)) {
      return { action: "reconcile" };
    }
    await verifyNoBuildPostPublicRoute({ firestore, candidate: state.candidate });
    const finalTriggerResponse = await requestJson({
      url: workerApiPath(`/builds/workers/${workerTag}/triggers`),
      method: "GET",
      token: cloudflareApiToken,
    });
    assertUploadOnlyProductionTrigger(finalTriggerResponse, workerTag);
    return evidence;
  } catch {
    return { action: "reconcile" };
  }
}

async function settleWithFallback({
  firestore,
  lease,
  evidence,
  settleOutcome,
}: {
  firestore: Firestore;
  lease: PublicDeploymentLease;
  evidence: ActivationEvidence;
  settleOutcome: SettleOutcome;
}): Promise<ReconciliationResult> {
  try {
    return await settleOutcome({ firestore, lease, evidence });
  } catch (error) {
    if (error instanceof PublicDeploymentTerminalEvidenceError) throw error;
    if (evidence.action === "reconcile") {
      reconciliationError(
        "The public deployment reconciliation was not persisted",
      );
    }
    try {
      const fallback = await settleOutcome({
        firestore,
        lease,
        evidence: { action: "reconcile" },
      });
      // A competing owner may have settled while the first request failed.
      // A terminal success must still match the caller's original evidence.
      if (fallback.outcome === "deployed" &&
        fallback.receipt?.cloudflareEvidenceDigest !== publicDeploymentCloudflareEvidenceDigest(evidence, lease.buildBatchId)) {
        throw new PublicDeploymentTerminalEvidenceError("The public deployment terminal receipt is invalid");
      }
      return fallback;
    } catch {
      reconciliationError(
        "The public deployment outcome is ambiguous; reconciliation remains required",
      );
    }
  }
}

export async function reconcilePublicWorkerDeployment({
  firestore,
  cloudflareApiToken,
  runtime,
  readState = readPublicDeploymentReconciliationState,
  requestJson = requestCloudflareJson,
  requestPublication = requestPublicPublicationReceipt,
  settleOutcome = settlePublicDeploymentOutcome,
}: {
  firestore: Firestore;
  cloudflareApiToken: string;
  runtime?: PublicationRuntime;
  readState?: ReadState;
  requestJson?: RequestJson;
  requestPublication?: RequestPublication;
  settleOutcome?: SettleOutcome;
}): Promise<ReconciliationResult> {
  if (
    !firestore ||
    !CLOUDFLARE_TOKEN.test(cloudflareApiToken ?? "") ||
    typeof readState !== "function" ||
    typeof requestJson !== "function" ||
    typeof requestPublication !== "function" ||
    typeof settleOutcome !== "function"
  ) {
    reconciliationError("The public deployment reconciler input is invalid");
  }
  const state = await readState(firestore, runtime);
  if (state === null) return { outcome: "idle", idempotent: true };
  assertPublicationOwner(state.lease, runtime ?? { owner: "node-compute", release: state.lease.commitSha });
  const settleOwned: SettleOutcome = input => settleOutcome({ ...input, ...(runtime ? { runtime } : {}) });
  const evidence = await collectActivationEvidence({
    firestore,
    state,
    cloudflareApiToken,
    requestJson,
    requestPublication,
  });
  return settleWithFallback({
    firestore,
    lease: state.lease,
    evidence,
    settleOutcome: settleOwned,
  });
}

/** Operator-only escape from a stale static candidate. The normal listener
 * never calls this entry and cannot infer restore intent from a paused flag. */
export async function restorePublicWorkerPredecessor({ firestore, cloudflareApiToken, buildBatchId, predecessorBuildBatchId, runtime,
  requestJson = requestCloudflareJson, requestPublication = requestPublicPublicationReceipt }: {
  firestore: Firestore; cloudflareApiToken: string; buildBatchId: string; predecessorBuildBatchId: string;
  runtime?: PublicationRuntime; requestJson?: RequestJson; requestPublication?: RequestPublication;
}): Promise<ReconciliationResult> {
  if (!firestore || !CLOUDFLARE_TOKEN.test(cloudflareApiToken ?? "") || !isPublicDeploymentIdentifier(buildBatchId) ||
      !isPublicDeploymentIdentifier(predecessorBuildBatchId) || typeof requestJson !== "function" || typeof requestPublication !== "function") {
    reconciliationError("The predecessor restore input is invalid");
  }
  cloudflarePublicWorkerTag();
  const state = await readPublicDeploymentPredecessorRestore({ firestore, buildBatchId, predecessorBuildBatchId, runtime });
  const settleOwned: SettleOutcome = input => settlePublicDeploymentOutcome({ ...input, ...(runtime ? { runtime } : {}) });
  if ("completed" in state) return settleOwned({ firestore, ...state.completed });
  let evidence: ActivationEvidence = { action: "reconcile" };
  try {
    const workerTag = assertPublicWorkerIdentity(await requestJson({ url: workerApiPath("/workers/scripts"), method: "GET", token: cloudflareApiToken }));
    const triggerUrl = workerApiPath(`/builds/workers/${workerTag}/triggers`);
    assertUploadOnlyProductionTrigger(await requestJson({ url: triggerUrl, method: "GET", token: cloudflareApiToken }), workerTag);
    const deploymentsUrl = workerApiPath(`/workers/scripts/${PUBLIC_WORKER_NAME}/deployments`);
    let active = projectApiDeploymentStatus(activeDeployment(await requestJson({ url: deploymentsUrl, method: "GET", token: cloudflareApiToken })));
    if (active.versionId !== state.candidate.workerVersionId && active.versionId !== state.predecessor.workerVersionId) {
      throw new Error("The active Worker is outside this retained restore lease");
    }
    const current = await readPublicDeploymentPredecessorRestore({ firestore, buildBatchId, predecessorBuildBatchId, runtime });
    if ("completed" in current || !isDeepStrictEqual(current, state)) throw new Error("The restore lease changed");
    if (active.versionId !== state.predecessor.workerVersionId) {
      // A dropped POST response is resolved by the authoritative read below.
      try {
        await requestJson({ url: deploymentsUrl, method: "POST", token: cloudflareApiToken,
          body: { strategy: "percentage", versions: [{ version_id: state.predecessor.workerVersionId, percentage: 100 }] } });
      } catch { /* The exact active-version receipt decides the outcome. */ }
    }
    active = projectApiDeploymentStatus(activeDeployment(await requestJson({ url: deploymentsUrl, method: "GET", token: cloudflareApiToken })));
    if (active.versionId !== state.predecessor.workerVersionId) throw new Error("The predecessor version was not restored");
    const probe = new URL(PUBLICATION_PROBE_PATH, PUBLICATION_PROBE_ORIGIN);
    probe.searchParams.set("cms-context", "code");
    if (!publicPublicationReceiptMatchesPreparedArtifact(await requestPublication(probe.toString()), preparedFromCandidate(state.predecessor))) {
      throw new Error("The restored predecessor artifact receipt changed");
    }
    assertUploadOnlyProductionTrigger(await requestJson({ url: triggerUrl, method: "GET", token: cloudflareApiToken }), workerTag);
    const finalActive = projectApiDeploymentStatus(activeDeployment(await requestJson({ url: deploymentsUrl, method: "GET", token: cloudflareApiToken })));
    if (!isDeepStrictEqual(finalActive, active)) throw new Error("The restored deployment changed during verification");
    const previous = state.predecessor;
    evidence = { action: "restore-predecessor", buildBatchId, predecessor: { buildBatchId: previous.buildBatchId,
      generation: previous.generation, commitSha: previous.commitSha, deploymentId: active.deploymentId, versionId: active.versionId,
      artifactDigest: previous.artifactDigest, artifactReceiptDigest: previous.artifactReceiptDigest,
      publicationReceiptDigest: previous.publicationReceiptDigest, mediaManifestDigest: previous.mediaManifestDigest } };
  } catch { /* Ambiguity retains the same reconciliation lease. */ }
  return settleWithFallback({ firestore, lease: state.lease, evidence, settleOutcome: settleOwned });
}
