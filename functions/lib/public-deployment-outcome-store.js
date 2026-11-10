"use strict";

const { preparePublicReleaseProducerInTransaction, publicReleaseProducerOperation } = require("./public-release-producer");

const { assertNoBuildPageCandidateInTransaction, writeNoBuildPageCandidateActivation } = require("./no-build-page-candidate");

const { assertNoBuildCandidateInTransaction, writeNoBuildCandidateActivation } = require("./no-build-post-publication");
const { bumpPublicContextRevision } = require("./public-context-revision");
const { candidateNoBuildContract } = require("./no-build-post-publication");
const { readNoBuildPostOwner, readNoBuildPostCapability, effectiveNoBuildPostState, candidateSupportsPost } = require("./no-build-post-ownership");
const { currentStaticInput, projectStaticProof, staticProofInput } = require("./no-build-post-static-return");

// Inert Firestore settlement for already-collected Cloudflare evidence. This
// module has no transport, handler, environment, workflow, or function-manifest
// export. It only commits a decisive or reconciling result after it revalidates
// the exact lease, candidate, reservation, and public-media readiness receipts.

const { runtimeFields, assertPublicationOwner, assertRuntimeSource } = require("./publication-runtime-owner");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const {
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
  PublicDeploymentStateError,
  assertPublicDeploymentLeaseBatch,
  assertPublicDeploymentLeaseReceipt,
  assertPublicDeploymentPointer,
  assertPublicDeploymentTerminalBatchStructure,
  projectPublicBuildReservation,
  projectPublicDeploymentLease,
  timestampMillis,
  isPublicDeploymentIdentifier,
} = require("./public-deployment");
const {
  projectPublicDeploymentCloudflareEvidence,
  publicDeploymentCloudflareEvidenceDigest,
} = require("./public-deployment-cloudflare");
const {
  publicBuildBatchRef,
  publicDeploymentRef,
  publicWorkerCandidateRef,
} = require("./public-deployment-coordinator");
const {
  assertPublicWorkerCandidateMatchesBatch,
  assertPublicWorkerCandidateDatabase,
} = require("./public-worker-candidate");
const {
  publicMediaManifestRef,
  publicMediaManifestVerificationRef,
} = require("./public-media-manifest-store");
const {
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS,
  MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNERS,
  MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK,
  MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES,
  PUBLIC_MEDIA_MANIFEST_COLLECTIONS,
  PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM,
  PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION,
  timestampParts,
} = require("./public-media-manifest");

const DIGEST = /^[a-f0-9]{64}$/;
const ADMIN_LOGS_COLLECTION = "admin_logs";
const HEADER_FIELDS = new Set([
  "schemaVersion",
  "digestAlgorithm",
  "buildBatchId",
  "generation",
  "commitSha",
  "cutoffAt",
  "coverage",
  "ownerCount",
  "maxOwnerWritesPerChunk",
  "maxChunkBytes",
  "maxVerificationBytes",
  "chunkCount",
  "mediaManifestDigest",
]);
const COVERAGE_FIELDS = new Set([
  "collection",
  "complete",
  "ownerCount",
  "ownerIdsDigest",
]);
const VERIFICATION_FIELDS = new Set([
  "schemaVersion",
  "buildBatchId",
  "generation",
  "mediaManifestDigest",
  "ownerCount",
  "chunkCount",
  "verifiedAt",
]);
const LEASE_BATCH_FIELDS = [
  "schemaVersion",
  "buildBatchId",
  "generation",
  "commitSha",
  "reservedAgainstGeneration",
  "reservedAgainstDeploymentId",
  "reservedAgainstCommitSha",
  "cutoffAt",
  "reservedAt",
  "readyAt",
  "leaseToken",
  "leaseAcquiredAt",
  "predecessorGeneration",
  "predecessorDeploymentId",
  "predecessorCommitSha",
];

function stateError(message) {
  throw new PublicDeploymentStateError(message);
}

// Preserve the existing public error identity, but let callers distinguish a
// verified terminal conflict from an ambiguous transport/commit failure.
class PublicDeploymentTerminalEvidenceError extends PublicDeploymentStateError {}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, fields) {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function sameTimestamp(left, right) {
  const leftMillis = timestampMillis(left);
  return leftMillis !== null && leftMillis === timestampMillis(right);
}

function publicDeploymentAdminLogEntry({
  actorUid,
  action,
  target,
  before,
  after,
  source,
}) {
  return {
    actorUid,
    actorEmail: null,
    action,
    target,
    before,
    after,
    source,
    timestamp: FieldValue.serverTimestamp(),
    at: new Date().toISOString(),
  };
}

function assertFirestore(firestore) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    stateError("firestore is required");
  }
}

function assertManifestCompletion({ batch, header, verification }) {
  const reservation = projectPublicBuildReservation(
    batch,
    batch.buildBatchId,
  );
  if (
    !hasExactFields(header, HEADER_FIELDS) ||
    header.schemaVersion !== PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION ||
    header.digestAlgorithm !== PUBLIC_MEDIA_MANIFEST_DIGEST_ALGORITHM ||
    header.buildBatchId !== reservation.buildBatchId ||
    header.generation !== reservation.generation ||
    header.commitSha !== reservation.commitSha ||
    !isDeepStrictEqual(
      timestampParts(header.cutoffAt),
      timestampParts(reservation.cutoffAt),
    ) ||
    !DIGEST.test(header.mediaManifestDigest) ||
    !Number.isSafeInteger(header.ownerCount) ||
    header.ownerCount < 0 ||
    header.ownerCount > MAX_PUBLIC_MEDIA_MANIFEST_OWNERS ||
    header.maxOwnerWritesPerChunk !==
      MAX_PUBLIC_MEDIA_MANIFEST_OWNER_WRITES_PER_CHUNK ||
    header.maxChunkBytes !== MAX_PUBLIC_MEDIA_MANIFEST_CHUNK_BYTES ||
    header.maxVerificationBytes !==
      MAX_PUBLIC_MEDIA_MANIFEST_VERIFICATION_BYTES ||
    !Number.isSafeInteger(header.chunkCount) ||
    header.chunkCount < 0 ||
    header.chunkCount > MAX_PUBLIC_MEDIA_MANIFEST_CHUNKS ||
    (header.ownerCount === 0 && header.chunkCount !== 0) ||
    (header.ownerCount > 0 && header.chunkCount === 0) ||
    !Array.isArray(header.coverage) ||
    header.coverage.length !== PUBLIC_MEDIA_MANIFEST_COLLECTIONS.length
  ) {
    stateError("The public media manifest completion receipt is invalid");
  }
  let coverageOwnerCount = 0;
  for (const [index, entry] of header.coverage.entries()) {
    if (
      !hasExactFields(entry, COVERAGE_FIELDS) ||
      entry.collection !== PUBLIC_MEDIA_MANIFEST_COLLECTIONS[index] ||
      entry.complete !== true ||
      !Number.isSafeInteger(entry.ownerCount) ||
      entry.ownerCount < 0 ||
      !DIGEST.test(entry.ownerIdsDigest)
    ) {
      stateError("The public media manifest completion receipt is invalid");
    }
    coverageOwnerCount += entry.ownerCount;
  }
  if (
    coverageOwnerCount !== header.ownerCount ||
    !hasExactFields(verification, VERIFICATION_FIELDS) ||
    verification.schemaVersion !== PUBLIC_MEDIA_MANIFEST_SCHEMA_VERSION ||
    verification.buildBatchId !== header.buildBatchId ||
    verification.generation !== header.generation ||
    verification.mediaManifestDigest !== header.mediaManifestDigest ||
    verification.ownerCount !== header.ownerCount ||
    verification.chunkCount !== header.chunkCount ||
    timestampMillis(verification.verifiedAt) === null ||
    timestampMillis(verification.verifiedAt) > timestampMillis(batch.readyAt)
  ) {
    stateError("The public media manifest completion receipt is invalid");
  }
  return Object.freeze({
    buildBatchId: header.buildBatchId,
    generation: header.generation,
    commitSha: header.commitSha,
    mediaManifestDigest: header.mediaManifestDigest,
  });
}

function assertLeaseAlignment({ pointer, batch, lease }) {
  const projectedLease = assertPublicDeploymentLeaseReceipt(lease);
  const storedLease = projectPublicDeploymentLease(
    batch,
    projectedLease.buildBatchId,
  );
  const pointerHasLease =
    pointer.state === "deploying" || pointer.state === "reconciling";
  const matchingReconciliation =
    batch.status !== "reconciling" ||
    (sameTimestamp(pointer.reconcilingAt, batch.reconcilingAt) &&
      pointer.cloudflareEvidenceDigest === batch.cloudflareEvidenceDigest);
  if (
    !pointerHasLease ||
    pointer.state !== batch.status ||
    !matchingReconciliation ||
    pointer.candidateBuildBatchId !== projectedLease.buildBatchId ||
    pointer.candidateGeneration !== projectedLease.generation ||
    pointer.candidateCommitSha !== projectedLease.commitSha ||
    !isDeepStrictEqual(pointer.runtime, projectedLease.runtime) ||
    pointer.leaseToken !== projectedLease.leaseToken ||
    !sameTimestamp(pointer.leaseAcquiredAt, projectedLease.leaseAcquiredAt) ||
    pointer.predecessorGeneration !== projectedLease.predecessorGeneration ||
    pointer.predecessorDeploymentId !==
      projectedLease.predecessorDeploymentId ||
    pointer.predecessorCommitSha !== projectedLease.predecessorCommitSha ||
    !isDeepStrictEqual(
      { ...storedLease, leaseAcquiredAt: null },
      { ...projectedLease, leaseAcquiredAt: null },
    ) ||
    !sameTimestamp(storedLease.leaseAcquiredAt, projectedLease.leaseAcquiredAt)
  ) {
    stateError("The public deployment lease receipt is invalid");
  }
  return projectedLease;
}

function assertStoredLeaseMatches(batch, lease) {
  const storedLease = assertPublicDeploymentLeaseReceipt({
    ...runtimeFields(batch.runtime),
    schemaVersion: batch.schemaVersion,
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    leaseToken: batch.leaseToken,
    leaseAcquiredAt: batch.leaseAcquiredAt,
    predecessorGeneration: batch.predecessorGeneration,
    predecessorDeploymentId: batch.predecessorDeploymentId,
    predecessorCommitSha: batch.predecessorCommitSha,
  });
  if (
    !isDeepStrictEqual(
      { ...storedLease, leaseAcquiredAt: null },
      { ...lease, leaseAcquiredAt: null },
    ) ||
    !sameTimestamp(storedLease.leaseAcquiredAt, lease.leaseAcquiredAt)
  ) {
    stateError("The public deployment lease receipt is invalid");
  }
  return storedLease;
}

function pointerAuditReceipt(pointer, extra = {}) {
  return {
    state: pointer.state,
    activeGeneration: pointer.activeGeneration,
    activeDeploymentId: pointer.activeDeploymentId,
    candidateGeneration: pointer.candidateGeneration ?? null,
    candidateBuildBatchId: pointer.candidateBuildBatchId ?? null,
    ...extra,
  };
}

function idlePointer(
  pointer,
  active,
  timestamp,
  mediaLifecycleReady,
) {
  return {
    schemaVersion: PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
    mediaLifecycleReady,
    state: "idle",
    activeGeneration: active.generation,
    activeDeploymentId: active.deploymentId,
    activeCommitSha: active.commitSha,
    lastReservedGeneration: pointer.lastReservedGeneration,
    newestEligibleGeneration: pointer.newestEligibleGeneration,
    newestEligibleBuildBatchId: pointer.newestEligibleBuildBatchId,
    updatedAt: timestamp,
  };
}

function leaseBatchProjection(batch) {
  return { ...runtimeFields(batch.runtime), ...Object.fromEntries(LEASE_BATCH_FIELDS.map((field) => [field, batch[field]])),
    ...(batch.noBuildStaticInput === undefined ? {} : { noBuildStaticInput: batch.noBuildStaticInput }),
  };
}

function terminalReceipt(batch) {
  const shared = {
    ...runtimeFields(batch.runtime),
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    mediaManifestDigest: batch.mediaManifestDigest,
    cloudflareEvidenceDigest: batch.cloudflareEvidenceDigest,
  };
  if (batch.status === "deployed") {
    return {
      ...shared,
      deploymentId: batch.deploymentId,
      versionId: batch.deploymentVersionId,
    };
  }
  return {
    ...shared,
    terminalOutcome: batch.terminalOutcome,
    predecessorGeneration: batch.predecessorGeneration,
    predecessorDeploymentId: batch.predecessorDeploymentId,
    predecessorCommitSha: batch.predecessorCommitSha,
    ...(batch.restoredPredecessor ? { restoredPredecessor: batch.restoredPredecessor } : {}),
  };
}

function assertTerminalBatch({
  batch,
  lease,
  evidence,
  evidenceDigest,
  manifest,
}) {
  assertPublicDeploymentTerminalBatchStructure(batch, batch?.buildBatchId);
  assertStoredLeaseMatches(batch, lease);
  if (
    batch.mediaManifestDigest !== manifest.mediaManifestDigest ||
    batch.cloudflareEvidenceDigest !== evidenceDigest
  ) {
    throw new PublicDeploymentTerminalEvidenceError("The public deployment terminal receipt is invalid");
  }

  if (batch.status === "deployed") {
    if (
      evidence.action !== "activate" ||
      batch.deploymentId !== evidence.deploymentId ||
      batch.deploymentVersionId !== evidence.versionId ||
      batch.commitSha !== evidence.commitSha
    ) {
      throw new PublicDeploymentTerminalEvidenceError("The public deployment terminal receipt is invalid");
    }
  } else if (batch.restoredPredecessor) {
    if (evidence.action !== "restore-predecessor" || !isDeepStrictEqual(batch.restoredPredecessor, evidence.predecessor)) {
    throw new PublicDeploymentTerminalEvidenceError("The restored predecessor terminal receipt is invalid");
    }
  } else if (
    evidence.action !== "terminal-failure" ||
    batch.terminalOutcome !== evidence.outcome
  ) {
    throw new PublicDeploymentTerminalEvidenceError("The public deployment terminal receipt is invalid");
  }
  return terminalReceipt(batch);
}

async function assertPredecessorRestoreInTransaction({ firestore, transaction, pointer, batch, candidate, lease,
  predecessorBuildBatchId, target }) {
  assertLeaseAlignment({ pointer, batch, lease });
  if (pointer.state !== "reconciling" || batch.status !== "reconciling" || !candidate.noBuildStatic ||
      !isPublicDeploymentIdentifier(predecessorBuildBatchId)) stateError("Only a stale static candidate can restore its predecessor");
  const proofInput = staticProofInput(projectStaticProof(candidate.noBuildStatic));
  const { state: retainedState } = await readNoBuildPostOwner({ firestore, transaction, postId: proofInput.postId });
  const state = effectiveNoBuildPostState(retainedState, await readNoBuildPostCapability({ firestore, transaction }));
  if (!state?.operationId || state.postId !== proofInput.postId || state.rendererSha !== lease.predecessorCommitSha ||
      isDeepStrictEqual(await currentStaticInput({ firestore, transaction, state }), proofInput)) {
    stateError("The static candidate is not eligible for predecessor restore");
  }
  const [previousBatchRow, previousCandidateRow, manifestRow, verificationRow] = await transaction.getAll(
    publicBuildBatchRef(firestore, predecessorBuildBatchId), publicWorkerCandidateRef(firestore, predecessorBuildBatchId),
    publicMediaManifestRef(firestore, predecessorBuildBatchId), publicMediaManifestVerificationRef(firestore, predecessorBuildBatchId));
  if (![previousBatchRow, previousCandidateRow, manifestRow, verificationRow].every(row => row.exists)) {
    stateError("The retained predecessor artifact is incomplete");
  }
  const previousBatch = previousBatchRow.data();
  assertPublicDeploymentTerminalBatchStructure(previousBatch, predecessorBuildBatchId);
  const previousCandidate = assertPublicWorkerCandidateMatchesBatch(previousCandidateRow.data(), previousBatch, { target });
  const manifest = assertManifestCompletion({ batch: previousBatch, header: manifestRow.data(), verification: verificationRow.data() });
  const contract = candidateNoBuildContract(previousCandidate.noBuildPost);
  if (previousBatch.status !== "deployed" || previousBatch.generation !== lease.predecessorGeneration ||
      previousBatch.commitSha !== lease.predecessorCommitSha || previousBatch.deploymentVersionId !== previousCandidate.workerVersionId ||
      previousBatch.mediaManifestDigest !== previousCandidate.mediaManifestDigest || manifest.mediaManifestDigest !== previousCandidate.mediaManifestDigest ||
      !candidateSupportsPost(contract, state.postId) || contract.rendererSha !== state.rendererSha ||
      (state.mode === "static" && !previousCandidate.noBuildStatic)) {
    stateError("The retained predecessor does not preserve the current route owner");
  }
  await assertNoBuildCandidateInTransaction({ firestore, transaction, candidate: previousCandidate });
  await assertNoBuildPageCandidateInTransaction({ firestore, transaction, candidate: previousCandidate });
  return previousCandidate;
}

async function readPublicDeploymentPredecessorRestore({ firestore, buildBatchId, predecessorBuildBatchId, runtime, target }) {
  assertFirestore(firestore);
  assertPublicWorkerCandidateDatabase(firestore, target);
  if (!isPublicDeploymentIdentifier(buildBatchId) || !isPublicDeploymentIdentifier(predecessorBuildBatchId)) {
    stateError("The predecessor restore identity is invalid");
  }
  return firestore.runTransaction(async transaction => {
    const [pointerRow, batchRow, candidateRow] = await transaction.getAll(publicDeploymentRef(firestore),
      publicBuildBatchRef(firestore, buildBatchId), publicWorkerCandidateRef(firestore, buildBatchId));
    if (![pointerRow, batchRow, candidateRow].every(row => row.exists)) stateError("The restore lease is missing");
    const pointer = assertPublicDeploymentPointer(pointerRow.data());
    const batch = batchRow.data();
    assertPublicationOwner(batch, runtime ?? { owner: "node-compute", release: batch.commitSha });
    if (batch.status === "failed" && batch.restoredPredecessor?.buildBatchId === predecessorBuildBatchId) {
      assertPublicDeploymentTerminalBatchStructure(batch, buildBatchId);
      const lease = assertPublicDeploymentLeaseReceipt({ ...runtimeFields(batch.runtime), ...Object.fromEntries([
        "schemaVersion", "buildBatchId", "generation", "commitSha", "leaseToken", "leaseAcquiredAt",
        "predecessorGeneration", "predecessorDeploymentId", "predecessorCommitSha",
      ].map(field => [field, batch[field]])) });
      return { completed: { lease, evidence: { action: "restore-predecessor", buildBatchId,
        predecessor: batch.restoredPredecessor } } };
    }
    assertPublicDeploymentLeaseBatch(batch, buildBatchId);
    const lease = projectPublicDeploymentLease(batch, buildBatchId);
    const candidate = assertPublicWorkerCandidateMatchesBatch(candidateRow.data(), batch, { target });
    const predecessor = await assertPredecessorRestoreInTransaction({ firestore, transaction, pointer, batch, candidate, lease,
      predecessorBuildBatchId, target });
    return { lease, candidate, predecessor };
  }, { readOnly: true });
}

function reconcilingReceipt(batch) {
  return {
    buildBatchId: batch.buildBatchId,
    generation: batch.generation,
    commitSha: batch.commitSha,
    leaseToken: batch.leaseToken,
    predecessorGeneration: batch.predecessorGeneration,
    predecessorDeploymentId: batch.predecessorDeploymentId,
    predecessorCommitSha: batch.predecessorCommitSha,
    mediaManifestDigest: batch.mediaManifestDigest,
    cloudflareEvidenceDigest: batch.cloudflareEvidenceDigest,
  };
}

async function settlePublicDeploymentOutcome({
  firestore,
  lease,
  evidence,
  runtime,
  target,
  adminLogEntryFn = publicDeploymentAdminLogEntry,
} = {}) {
  assertFirestore(firestore);
  assertPublicWorkerCandidateDatabase(firestore, target);
  const projectedLease = assertPublicDeploymentLeaseReceipt(lease);
  const executor = runtime ?? { owner: "node-compute", release: projectedLease.commitSha };
  if (projectedLease.runtime !== undefined) assertRuntimeSource(executor, projectedLease.commitSha);
  assertPublicationOwner(projectedLease, executor);
  const requestedEvidence = projectPublicDeploymentCloudflareEvidence(
    evidence,
    projectedLease.buildBatchId,
  );
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(
    firestore,
    projectedLease.buildBatchId,
  );
  const manifestRef = publicMediaManifestRef(
    firestore,
    projectedLease.buildBatchId,
  );
  const verificationRef = publicMediaManifestVerificationRef(
    firestore,
    projectedLease.buildBatchId,
  );
  const candidateRef = publicWorkerCandidateRef(
    firestore,
    projectedLease.buildBatchId,
  );

  return firestore.runTransaction(async (transaction) => {
    const snapshots = await transaction.getAll(
      pointerRef,
      batchRef,
      manifestRef,
      verificationRef,
      candidateRef,
    );
    const [
      pointerSnapshot,
      batchSnapshot,
      manifestSnapshot,
      verificationSnapshot,
      candidateSnapshot,
    ] = snapshots;
    if (
      !pointerSnapshot.exists ||
      !batchSnapshot.exists ||
      !manifestSnapshot.exists ||
      !verificationSnapshot.exists ||
      !candidateSnapshot.exists
    ) {
      stateError("The public media manifest completion receipt is missing");
    }

    await require("./public-release-writer-fence").assertNoReleaseWriterInTransaction({ firestore, transaction });
    const pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
    const storedBatch = batchSnapshot.data();
    const manifest = assertManifestCompletion({
      batch: storedBatch,
      header: manifestSnapshot.data(),
      verification: verificationSnapshot.data(),
    });
    const candidate = assertPublicWorkerCandidateMatchesBatch(
      candidateSnapshot.data(),
      storedBatch,
      { target },
    );
    if (candidate.mediaManifestDigest !== manifest.mediaManifestDigest) {
      stateError("The prepared public Worker candidate is invalid");
    }
    const projectedEvidence =
      requestedEvidence.action === "activate" &&
      (requestedEvidence.commitSha !== projectedLease.commitSha ||
        requestedEvidence.versionId !== candidate.workerVersionId)
        ? Object.freeze({ action: "reconcile" })
        : requestedEvidence;
    const evidenceDigest = publicDeploymentCloudflareEvidenceDigest(
      projectedEvidence,
      projectedLease.buildBatchId,
    );

    if (storedBatch.status === "deployed" || storedBatch.status === "failed") {
      // A reconciler can finish its inconclusive probe after the activation
      // owner commits. Read the same lease's verified receipt; never replace
      // it with stale reconciliation evidence or write to a newer pointer.
      const terminalEvidence = storedBatch.status === "deployed" && requestedEvidence.action === "reconcile"
        ? { action: "activate", buildBatchId: storedBatch.buildBatchId,
          deploymentId: storedBatch.deploymentId, versionId: storedBatch.deploymentVersionId,
          commitSha: storedBatch.commitSha }
        : projectedEvidence;
      const receipt = assertTerminalBatch({
        batch: storedBatch,
        lease: projectedLease,
        evidence: terminalEvidence,
        evidenceDigest: publicDeploymentCloudflareEvidenceDigest(terminalEvidence, projectedLease.buildBatchId),
        manifest,
      });
      return { outcome: storedBatch.status, idempotent: true, receipt };
    }

    const batch = assertPublicDeploymentLeaseBatch(
      storedBatch,
      projectedLease.buildBatchId,
    );
    assertLeaseAlignment({ pointer, batch, lease: projectedLease });
    if (
      batch.status === "reconciling" &&
      projectedEvidence.action === "reconcile"
    ) {
      if (
        pointer.state !== "reconciling" ||
        pointer.cloudflareEvidenceDigest !== evidenceDigest ||
        batch.cloudflareEvidenceDigest !== evidenceDigest ||
        !sameTimestamp(pointer.reconcilingAt, batch.reconcilingAt)
      ) {
        stateError("The public deployment reconciliation receipt is invalid");
      }
      return {
        outcome: "reconciling",
        idempotent: true,
        receipt: reconcilingReceipt({
          ...batch,
          mediaManifestDigest: manifest.mediaManifestDigest,
        }),
      };
    }

    const noBuildPage = projectedEvidence.action === "activate"
      ? await assertNoBuildPageCandidateInTransaction({ firestore, transaction, candidate }) : null;
    const noBuild = projectedEvidence.action === "activate"
      ? await assertNoBuildCandidateInTransaction({ firestore, transaction, candidate }) : null;
    if (projectedEvidence.action === "restore-predecessor") {
      const previous = await assertPredecessorRestoreInTransaction({ firestore, transaction, pointer, batch, candidate,
        lease: projectedLease, predecessorBuildBatchId: projectedEvidence.predecessor.buildBatchId, target });
      const receipt = projectedEvidence.predecessor;
      if (receipt.generation !== previous.generation || receipt.commitSha !== previous.commitSha ||
          receipt.versionId !== previous.workerVersionId || receipt.artifactDigest !== previous.artifactDigest ||
          receipt.artifactReceiptDigest !== previous.artifactReceiptDigest ||
          receipt.publicationReceiptDigest !== previous.publicationReceiptDigest || receipt.mediaManifestDigest !== previous.mediaManifestDigest) {
        stateError("The restored predecessor evidence changed");
      }
      const queueId = /^cms-([A-Za-z0-9]{20})$/.exec(batch.buildBatchId)?.[1];
      if (queueId) {
        // Use the existing settlement rules so failed content keeps its retry
        // marker and the serializer can clear its retained token journal.
        const { settleBuildQueueInTransaction } = require("./publish-build-state");
        const settled = await settleBuildQueueInTransaction(firestore, transaction, { queueId, status: "failed",
          acceptQueue: queue => ["pending", "publishing", "failed", "cancelled"].includes(queue.status) && queue.transport === "serializer" &&
            queue.artifactBuild?.buildBatchId === batch.buildBatchId && queue.artifactBuild?.generation === batch.generation &&
            queue.artifactBuild?.commitSha === batch.commitSha && sameTimestamp(queue.artifactBuild?.cutoffAt, batch.cutoffAt) &&
            queue.artifactInclusion?.artifactReceiptDigest === candidate.artifactReceiptDigest,
          queueUpdate: { status: "failed", completedAt: FieldValue.serverTimestamp(),
            error: "The static candidate was cancelled after a verified predecessor restore." } });
        if (!settled) stateError("The restored candidate queue is not the retained serializer operation");
      }
    }
    const timestamp = FieldValue.serverTimestamp();
    let nextPointer;
    let nextBatch;
    let outcome;
    let action;
    if (projectedEvidence.action === "activate") {
      nextPointer = idlePointer(pointer, {
        generation: batch.generation,
        deploymentId: projectedEvidence.deploymentId,
        commitSha: batch.commitSha,
      }, timestamp, pointer.mediaLifecycleReady);
      nextBatch = {
        ...leaseBatchProjection(batch),
        status: "deployed",
        mediaManifestDigest: manifest.mediaManifestDigest,
        cloudflareEvidenceDigest: evidenceDigest,
        deployedAt: timestamp,
        deploymentId: projectedEvidence.deploymentId,
        deploymentVersionId: projectedEvidence.versionId,
      };
      outcome = "deployed";
      action = "public-deployment.activate";
    } else if (projectedEvidence.action === "terminal-failure" || projectedEvidence.action === "restore-predecessor") {
      const restored = projectedEvidence.action === "restore-predecessor" ? projectedEvidence.predecessor : null;
      nextPointer = idlePointer(pointer, {
        generation: batch.predecessorGeneration,
        deploymentId: restored?.deploymentId ?? batch.predecessorDeploymentId,
        commitSha: batch.predecessorCommitSha,
      }, timestamp, pointer.mediaLifecycleReady);
      if (restored && pointer.newestEligibleGeneration === batch.generation && pointer.newestEligibleBuildBatchId === batch.buildBatchId) {
        // Retire only this failed eligibility. Keep the monotonic reservation
        // counter and any separately prepared newer candidate.
        nextPointer.newestEligibleGeneration = restored.generation;
        nextPointer.newestEligibleBuildBatchId = restored.buildBatchId;
      }
      nextBatch = {
        ...leaseBatchProjection(batch),
        status: "failed",
        mediaManifestDigest: manifest.mediaManifestDigest,
        cloudflareEvidenceDigest: evidenceDigest,
        failedAt: timestamp,
        terminalOutcome: restored ? "cancelled" : projectedEvidence.outcome,
        ...(restored ? { restoredPredecessor: restored } : {}),
      };
      outcome = "failed";
      action = restored ? "public-deployment.restore-predecessor" : "public-deployment.fail";
    } else {
      nextPointer = {
        ...pointer,
        state: "reconciling",
        reconcilingAt: timestamp,
        cloudflareEvidenceDigest: evidenceDigest,
        updatedAt: timestamp,
      };
      nextBatch = {
        ...leaseBatchProjection(batch),
        status: "reconciling",
        reconcilingAt: timestamp,
        cloudflareEvidenceDigest: evidenceDigest,
      };
      outcome = "reconciling";
      action = "public-deployment.reconcile";
    }

    const receipt = outcome === "reconciling"
      ? reconcilingReceipt({
          ...nextBatch,
          mediaManifestDigest: manifest.mediaManifestDigest,
        })
      : terminalReceipt(nextBatch);
    const releaseSourceDocuments = [{ path: pointerRef.path, data: nextPointer }];
    // Capture the existing activation writers' exact public authority values;
    // this recorder never writes and never retains operational timestamps.
    const sourceRecorder = { set(ref, data) { releaseSourceDocuments.push({ path: ref.path, data }); }, update() {} };
    if (outcome === "deployed") {
      if (noBuildPage) writeNoBuildPageCandidateActivation(sourceRecorder, firestore, noBuildPage, candidate);
      if (noBuild) writeNoBuildCandidateActivation(sourceRecorder, firestore, noBuild, candidate);
    }
    const writeReleaseChange = outcome === "deployed" ? await preparePublicReleaseProducerInTransaction({ firestore, transaction,
      operationId: publicReleaseProducerOperation("provider", batch.buildBatchId, nextPointer.activeGeneration, nextPointer.activeCommitSha),
      activation: { buildBatchId: batch.buildBatchId, commitSha: nextPointer.activeCommitSha },
      revisionDelta: noBuild ? 1 : 0, changes: [{ kind: "provider", id: "public-code", action: "dependency",
        sourceVersion: nextPointer.activeGeneration, sourceDocuments: releaseSourceDocuments, snapshot: { commitSha: nextPointer.activeCommitSha,
          generation: nextPointer.activeGeneration, deploymentId: nextPointer.activeDeploymentId } }] }) : () => {};
    writeReleaseChange();
    if (noBuildPage) writeNoBuildPageCandidateActivation(transaction, firestore, noBuildPage, candidate);
    if (noBuild) {
      writeNoBuildCandidateActivation(transaction, firestore, noBuild, candidate);
      bumpPublicContextRevision(transaction, firestore);
    }
    transaction.set(pointerRef, nextPointer);
    transaction.set(batchRef, nextBatch);
    transaction.set(
      firestore.collection(ADMIN_LOGS_COLLECTION).doc(),
      adminLogEntryFn({
        actorUid: "system:public-deployment",
        action,
        target: `system/publicDeployment/buildBatches/${batch.buildBatchId}`,
        before: pointerAuditReceipt(pointer),
        after: pointerAuditReceipt(nextPointer, {
          state: outcome,
          terminalOutcome: nextBatch.terminalOutcome ?? null,
          cloudflareEvidenceDigest: evidenceDigest,
        }),
        source: "public-deployment-outcome-store",
      }),
    );
    return { outcome, idempotent: false, receipt };
  });
}

module.exports = {
  PublicDeploymentTerminalEvidenceError,
  assertManifestCompletion,
  assertPublicDeploymentTerminalBatch: assertTerminalBatch,
  assertPublicDeploymentTerminalBatchStructure,
  settlePublicDeploymentOutcome,
  readPublicDeploymentPredecessorRestore,
};
