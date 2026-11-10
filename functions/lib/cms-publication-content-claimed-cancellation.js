"use strict";

const { isDeepStrictEqual } = require("node:util");
const { BASELINE_ACTOR } = require("./cms-publication-baseline");
const { projectClaim } = require("./cms-publication-serializer");
const { projectInclusionReceipt } = require("./cms-public-deployment-writeback");
const { timestampParts } = require("./cms-publish-artifact");
const {
  PUBLIC_BUILD_CANCELLED_REASON,
  assertPublicDeploymentCancelledBatch,
  assertPublicDeploymentPointer,
  assertPublicDeploymentReservedBatch,
  isCommitSha,
  timestampMillis,
} = require("./public-deployment");
const {
  publicBuildBatchRef,
  publicDeploymentRef,
  publicWorkerCandidateRef,
} = require("./public-deployment-coordinator");
const {
  publicMediaManifestRef,
  publicMediaManifestVerificationRef,
} = require("./public-media-manifest-store");
const { settleBuildQueueInTransaction } = require("./publish-build-state");

const CANCELLATION_ERROR =
  "Claimed publication content cancelled before activation.";
const CANCELLATION_ACTION = "cms-publication-content.cancel-claimed";
const DIGEST = /^[a-f0-9]{64}$/;

class CmsPublicationContentClaimedCancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsPublicationContentClaimedCancellationError";
  }
}

function refuse(message) {
  throw new CmsPublicationContentClaimedCancellationError(message);
}

function sameTimestamp(left, right) {
  const parts = timestampParts(left);
  return Boolean(parts && isDeepStrictEqual(parts, timestampParts(right)));
}

function assertInput(expected) {
  if (
    !/^[A-Za-z0-9]{20}$/.test(expected?.queueId ?? "") ||
    expected.buildBatchId !== `cms-${expected.queueId}` ||
    !isCommitSha(expected.queueCommitSha) ||
    !isCommitSha(expected.operatorCommitSha) ||
    expected.queueCommitSha === expected.operatorCommitSha ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(expected.serializerId ?? "") ||
    typeof expected.journalPath !== "string" ||
    !expected.journalPath.startsWith("/") ||
    (expected.claimTokenDigest !== null &&
      !DIGEST.test(expected.claimTokenDigest ?? ""))
  ) {
    refuse("The claimed content cancellation input is invalid");
  }
}

function assertClaimedQueue(queue, expected, batch) {
  let claim;
  try {
    claim = projectClaim(queue?.serializerClaim);
  } catch {
    refuse("The claimed content serializer claim is invalid");
  }
  const build = queue?.artifactBuild;
  if (
    queue.transport !== "serializer" ||
    !Array.isArray(queue.changes) || queue.changes.length === 0 ||
    (queue.commitSha !== undefined && queue.commitSha !== expected.queueCommitSha) ||
    claim.serializerId !== expected.serializerId ||
    claim.buildBatchId !== expected.buildBatchId ||
    claim.commitSha !== expected.queueCommitSha ||
    (expected.claimTokenDigest !== null &&
      claim.tokenDigest !== expected.claimTokenDigest) ||
    batch.commitSha !== expected.queueCommitSha ||
    build?.buildBatchId !== expected.buildBatchId ||
    build.generation !== batch.generation ||
    build.commitSha !== expected.queueCommitSha ||
    !sameTimestamp(build.cutoffAt, batch.cutoffAt) ||
    Object.keys(build).length !== 4 ||
    timestampMillis(queue.triggeredAt) === null ||
    timestampMillis(claim.claimedAt) < timestampMillis(queue.triggeredAt) ||
    timestampMillis(batch.cutoffAt) < timestampMillis(claim.claimedAt) ||
    queue.deploymentClaim !== undefined ||
    queue.deploymentReceipt !== undefined ||
    queue.artifactBuildRollback !== undefined
  ) {
    refuse("The claimed content queue, source, or serializer conflicts");
  }
  if (queue.artifactInclusion !== undefined) {
    let inclusion;
    try {
      inclusion = projectInclusionReceipt(queue.artifactInclusion);
    } catch {
      refuse("The claimed content artifact inclusion is invalid");
    }
    if (
      inclusion.buildBatchId !== expected.buildBatchId ||
      inclusion.generation !== batch.generation ||
      inclusion.commitSha !== expected.queueCommitSha ||
      !sameTimestamp(inclusion.cutoffAt, batch.cutoffAt) ||
      timestampMillis(inclusion.recordedAt) < timestampMillis(batch.reservedAt)
    ) {
      refuse("The claimed content artifact inclusion conflicts");
    }
  }
  return claim;
}

function receiptMatchesInclusion(receipt, inclusion) {
  if (receipt.schemaVersion === 1) return inclusion === undefined;
  if (inclusion === undefined) {
    return receipt.artifactReceiptDigest === null &&
      receipt.artifactInclusionRecordedAt === null;
  }
  return receipt.artifactReceiptDigest === inclusion.artifactReceiptDigest &&
    sameTimestamp(receipt.artifactInclusionRecordedAt, inclusion.recordedAt);
}

function assertReceipt(queue, batch, expected, claim) {
  const receipt = batch.cancellationReceipt;
  if (
    queue.error !== CANCELLATION_ERROR ||
    !isDeepStrictEqual(queue.claimedContentCancellationReceipt, receipt) ||
    queue.claimedContentCancellationJournalPath !== expected.journalPath ||
    ![1, 2].includes(receipt.schemaVersion) ||
    receipt.queueId !== expected.queueId ||
    receipt.operatorCommitSha !== expected.operatorCommitSha ||
    receipt.serializerId !== expected.serializerId ||
    receipt.claimTokenDigest !== claim.tokenDigest ||
    !receiptMatchesInclusion(receipt, queue.artifactInclusion) ||
    !sameTimestamp(queue.completedAt, receipt.cancelledAt)
  ) {
    refuse("The claimed content cancellation receipt conflicts");
  }
  return receipt;
}

function projectBatch(value, buildBatchId, cancelled) {
  try {
    return cancelled
      ? assertPublicDeploymentCancelledBatch(value, buildBatchId)
      : assertPublicDeploymentReservedBatch(value, buildBatchId);
  } catch {
    refuse("The claimed content build batch is invalid");
  }
}

function assertBeforeActivation(pointer, batch, candidateSnapshot, expected) {
  // A strict reserved batch has no lease, activation, or deployment record.
  // Checking its predecessor proves this batch did not change public generation.
  if (
    expected.claimTokenDigest === null ||
    pointer.state !== "idle" ||
    pointer.activeGeneration !== batch.reservedAgainstGeneration ||
    pointer.activeDeploymentId !== batch.reservedAgainstDeploymentId ||
    pointer.activeCommitSha !== batch.reservedAgainstCommitSha ||
    pointer.lastReservedGeneration < batch.generation ||
    pointer.newestEligibleGeneration >= batch.generation ||
    pointer.newestEligibleBuildBatchId === expected.buildBatchId ||
    candidateSnapshot.exists
  ) {
    refuse("The claimed content batch is not safe to cancel before activation");
  }
}

async function cancelClaimedCmsPublicationContent({
  firestore, expected, serverTimestamp,
}) {
  assertInput(expected);
  const queueRef = firestore.collection("cmsPublishQueue").doc(expected.queueId);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, expected.buildBatchId);
  const candidateRef = publicWorkerCandidateRef(firestore, expected.buildBatchId);
  const manifestRef = publicMediaManifestRef(firestore, expected.buildBatchId);
  const verificationRef = publicMediaManifestVerificationRef(firestore, expected.buildBatchId);
  const manifestChunksQuery = manifestRef.collection("chunks").limit(1);
  const idempotent = await firestore.runTransaction(async (transaction) => {
    const [queueSnapshot, batchSnapshot, pointerSnapshot, candidateSnapshot,
      manifestSnapshot, verificationSnapshot] = await transaction.getAll(
      queueRef, batchRef, pointerRef, candidateRef, manifestRef, verificationRef,
    );
    const manifestChunksSnapshot = await transaction.get(manifestChunksQuery);
    if (!queueSnapshot.exists || !batchSnapshot.exists) {
      refuse("The claimed content queue or reserved batch is missing");
    }
    const queue = queueSnapshot.data();
    const batch = projectBatch(
      batchSnapshot.data(), expected.buildBatchId, queue.status === "cancelled",
    );
    const claim = assertClaimedQueue(queue, expected, batch);
    if (queue.status === "cancelled") {
      assertReceipt(queue, batch, expected, claim);
      return true;
    }
    if (
      queue.status !== "publishing" ||
      queue.completedAt != null || queue.error != null ||
      queue.claimedContentCancellationReceipt !== undefined
    ) {
      refuse("The content queue is not a claimed build");
    }
    if (!pointerSnapshot.exists) refuse("The public deployment coordinator is missing");
    let pointer;
    try {
      pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
    } catch {
      refuse("The public deployment coordinator is invalid");
    }
    assertBeforeActivation(pointer, batch, candidateSnapshot, expected);
    if (manifestSnapshot.exists || !manifestChunksSnapshot.empty || verificationSnapshot.exists) {
      refuse("The claimed content batch already has public media evidence");
    }

    const timestamp = serverTimestamp();
    // Bind inclusion evidence with the baseline v2 contract. Keep legacy retries.
    const receipt = {
      schemaVersion: 2,
      reason: PUBLIC_BUILD_CANCELLED_REASON,
      queueId: expected.queueId,
      buildBatchId: expected.buildBatchId,
      generation: batch.generation,
      queueCommitSha: expected.queueCommitSha,
      operatorCommitSha: expected.operatorCommitSha,
      serializerId: expected.serializerId,
      claimTokenDigest: claim.tokenDigest,
      cutoffAt: batch.cutoffAt,
      artifactReceiptDigest: queue.artifactInclusion?.artifactReceiptDigest ?? null,
      artifactInclusionRecordedAt: queue.artifactInclusion?.recordedAt ?? null,
      cancelledAt: timestamp,
    };
    // This reads and settles the same revisions as update-publish-status.cjs.
    // All guard reads happen before settlement writes in this transaction.
    await settleBuildQueueInTransaction(firestore, transaction, {
      queueId: expected.queueId,
      status: "cancelled",
      queueUpdate: {
        status: "cancelled",
        completedAt: timestamp,
        error: CANCELLATION_ERROR,
        claimedContentCancellationReceipt: receipt,
        claimedContentCancellationJournalPath: expected.journalPath,
      },
    });
    transaction.update(batchRef, {
      status: "cancelled",
      cancelledReason: PUBLIC_BUILD_CANCELLED_REASON,
      cancelledAt: timestamp,
      cancellationReceipt: receipt,
    });
    transaction.create(firestore.collection("admin_logs").doc(), {
      actorUid: BASELINE_ACTOR.uid,
      actorEmail: BASELINE_ACTOR.email,
      action: CANCELLATION_ACTION,
      target: `cmsPublishQueue/${expected.queueId}`,
      before: { queueStatus: queue.status, batchStatus: batch.status },
      after: { queueStatus: "cancelled", batchStatus: "cancelled", receipt },
      source: "cms-publication-content-claimed-cancellation",
      timestamp,
      at: new Date().toISOString(),
    });
    return false;
  });
  // Return resolved server timestamps, including on a crash-recovery retry.
  const [queueSnapshot, batchSnapshot] = await firestore.getAll(queueRef, batchRef);
  const batch = projectBatch(batchSnapshot.data(), expected.buildBatchId, true);
  const queue = queueSnapshot.data();
  const claim = assertClaimedQueue(queue, expected, batch);
  return {
    outcome: "cancelled", idempotent,
    receipt: assertReceipt(queue, batch, expected, claim),
  };
}

module.exports = {
  CANCELLATION_ERROR,
  CmsPublicationContentClaimedCancellationError,
  cancelClaimedCmsPublicationContent,
};
