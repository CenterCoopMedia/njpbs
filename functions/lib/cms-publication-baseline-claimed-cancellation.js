"use strict";

// Guarded cancellation for an empty baseline that the serializer claimed but
// could not advance to a Worker candidate. The host token journal is verified
// and cleared by the operator after this transaction terminalizes both durable
// records.

const {
  BASELINE_ACTOR,
  projectExactQueue,
} = require("./cms-publication-baseline");
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
const { projectClaim } = require("./cms-publication-serializer");
const {
  projectInclusionReceipt,
} = require("./cms-public-deployment-writeback");

const CANCELLATION_SCHEMA_VERSION = 2;
const CANCELLATION_REASON = PUBLIC_BUILD_CANCELLED_REASON;
const CANCELLATION_ERROR =
  "Claimed publication baseline cancelled before a public candidate was created.";
const CANCELLATION_ACTION = "cms-publication-baseline.cancel-claimed";
const CANCELLATION_SOURCE =
  "cms-publication-baseline-claimed-cancellation";
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ARTIFACT_BUILD_FIELDS = new Set([
  "buildBatchId",
  "generation",
  "commitSha",
  "cutoffAt",
]);
const PUBLISHING_QUEUE_FIELDS = new Set([
  "status",
  "transport",
  "triggeredBy",
  "triggeredByEmail",
  "triggeredAt",
  "completedAt",
  "error",
  "changes",
  "commitSha",
  "serializerClaim",
  "artifactBuild",
]);
const CANCELLED_QUEUE_FIELDS = new Set([
  ...PUBLISHING_QUEUE_FIELDS,
  "claimedBaselineCancellationReceipt",
]);
const INCLUDED_PUBLISHING_QUEUE_FIELDS = new Set([
  ...PUBLISHING_QUEUE_FIELDS,
  "artifactInclusion",
]);
const INCLUDED_CANCELLED_QUEUE_FIELDS = new Set([
  ...CANCELLED_QUEUE_FIELDS,
  "artifactInclusion",
]);
const LEGACY_CANCELLATION_RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "reason",
  "queueId",
  "buildBatchId",
  "generation",
  "queueCommitSha",
  "operatorCommitSha",
  "serializerId",
  "claimTokenDigest",
  "cutoffAt",
  "cancelledAt",
]);
const CANCELLATION_RECEIPT_FIELDS = new Set([
  ...LEGACY_CANCELLATION_RECEIPT_FIELDS,
  "artifactReceiptDigest",
  "artifactInclusionRecordedAt",
]);

class CmsPublicationBaselineClaimedCancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsPublicationBaselineClaimedCancellationError";
  }
}

function cancellationError(message) {
  throw new CmsPublicationBaselineClaimedCancellationError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, fields) {
  return plainObject(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field));
}

function sameTimestamp(left, right) {
  const leftParts = timestampParts(left);
  const rightParts = timestampParts(right);
  return Boolean(
    leftParts &&
      rightParts &&
      leftParts.seconds === rightParts.seconds &&
      leftParts.nanoseconds === rightParts.nanoseconds,
  );
}

function timestampAtOrBefore(left, right) {
  const leftParts = timestampParts(left);
  const rightParts = timestampParts(right);
  return Boolean(
    leftParts &&
      rightParts &&
      (leftParts.seconds < rightParts.seconds ||
        (leftParts.seconds === rightParts.seconds &&
          leftParts.nanoseconds <= rightParts.nanoseconds)),
  );
}

function assertInput(expected) {
  if (
    !plainObject(expected) ||
    !QUEUE_ID.test(expected.queueId ?? "") ||
    expected.buildBatchId !== `cms-${expected.queueId}` ||
    !Number.isSafeInteger(expected.generation) ||
    expected.generation < 1 ||
    !isCommitSha(expected.queueCommitSha) ||
    !isCommitSha(expected.operatorCommitSha) ||
    expected.queueCommitSha === expected.operatorCommitSha ||
    !SERIALIZER_ID.test(expected.serializerId ?? "") ||
    (expected.claimTokenDigest !== null &&
      !DIGEST.test(expected.claimTokenDigest ?? ""))
  ) {
    cancellationError(
      "The claimed CMS publication baseline cancellation input is invalid",
    );
  }
  return Object.freeze({ ...expected });
}

function assertFirestore(firestore) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function"
  ) {
    cancellationError(
      "Firestore is required for claimed baseline cancellation",
    );
  }
}

function projectArtifactBuild(value, expected) {
  if (
    !hasExactFields(value, ARTIFACT_BUILD_FIELDS) ||
    value.buildBatchId !== expected.buildBatchId ||
    value.generation !== expected.generation ||
    value.commitSha !== expected.queueCommitSha ||
    timestampMillis(value.cutoffAt) === null
  ) {
    cancellationError(
      "The claimed CMS publication baseline artifact build is invalid",
    );
  }
  return Object.freeze({ ...value });
}

function projectReceipt(value, expected) {
  const fields = value?.schemaVersion === 1
    ? LEGACY_CANCELLATION_RECEIPT_FIELDS
    : CANCELLATION_RECEIPT_FIELDS;
  const inclusionBindingValid = value?.schemaVersion === 1 ||
    ((value?.artifactReceiptDigest === null &&
      value?.artifactInclusionRecordedAt === null) ||
      (DIGEST.test(value?.artifactReceiptDigest ?? "") &&
        timestampMillis(value?.artifactInclusionRecordedAt) !== null &&
        timestampAtOrBefore(
          value?.cutoffAt,
          value?.artifactInclusionRecordedAt,
        ) &&
        timestampAtOrBefore(
          value?.artifactInclusionRecordedAt,
          value?.cancelledAt,
        )));
  if (
    ![1, CANCELLATION_SCHEMA_VERSION].includes(value?.schemaVersion) ||
    !hasExactFields(value, fields) ||
    value.reason !== CANCELLATION_REASON ||
    value.queueId !== expected.queueId ||
    value.buildBatchId !== expected.buildBatchId ||
    value.generation !== expected.generation ||
    value.queueCommitSha !== expected.queueCommitSha ||
    value.operatorCommitSha !== expected.operatorCommitSha ||
    value.serializerId !== expected.serializerId ||
    !DIGEST.test(value.claimTokenDigest ?? "") ||
    (expected.claimTokenDigest !== null &&
      value.claimTokenDigest !== expected.claimTokenDigest) ||
    timestampMillis(value.cutoffAt) === null ||
    timestampMillis(value.cancelledAt) === null ||
    !inclusionBindingValid
  ) {
    cancellationError(
      "The claimed CMS publication baseline cancellation receipt conflicts",
    );
  }
  return Object.freeze({ ...value });
}

function projectArtifactInclusion(value, expected, build) {
  let inclusion;
  try {
    inclusion = projectInclusionReceipt(value);
  } catch {
    cancellationError(
      "The claimed CMS publication baseline artifact inclusion is invalid",
    );
  }
  if (
    inclusion.buildBatchId !== expected.buildBatchId ||
    inclusion.generation !== expected.generation ||
    inclusion.commitSha !== expected.queueCommitSha ||
    !sameTimestamp(inclusion.cutoffAt, build.cutoffAt) ||
    !timestampAtOrBefore(inclusion.cutoffAt, inclusion.recordedAt)
  ) {
    cancellationError(
      "The claimed CMS publication baseline artifact inclusion conflicts",
    );
  }
  return Object.freeze({ ...inclusion });
}

function receiptMatchesInclusion(receipt, inclusion) {
  if (receipt.schemaVersion === 1) return inclusion === null;
  if (inclusion === null) {
    return receipt.artifactReceiptDigest === null &&
      receipt.artifactInclusionRecordedAt === null;
  }
  return receipt.artifactReceiptDigest === inclusion.artifactReceiptDigest &&
    sameTimestamp(
      receipt.artifactInclusionRecordedAt,
      inclusion.recordedAt,
    );
}

function sameReceiptInclusionBinding(left, right) {
  if (
    left.schemaVersion !== right.schemaVersion ||
    left.artifactReceiptDigest !== right.artifactReceiptDigest
  ) {
    return false;
  }
  if (
    left.artifactInclusionRecordedAt == null ||
    right.artifactInclusionRecordedAt == null
  ) {
    return left.artifactInclusionRecordedAt ===
      right.artifactInclusionRecordedAt;
  }
  return sameTimestamp(
    left.artifactInclusionRecordedAt,
    right.artifactInclusionRecordedAt,
  );
}

function hasExactQueueFields(queue, fields) {
  return hasExactFields(queue, new Set([...fields,
    ...(queue.noBuildStaticReturn === undefined ? [] : ["noBuildStaticReturn"])]));
}

function projectQueue(snapshot, expected) {
  let queue;
  try {
    queue = projectExactQueue(snapshot, {
      queueId: expected.queueId,
      commitSha: expected.queueCommitSha,
    });
  } catch {
    cancellationError("The CMS publication baseline queue is invalid");
  }
  if (!queue) {
    cancellationError("The CMS publication baseline queue is missing");
  }
  const hasInclusion = Object.hasOwn(queue, "artifactInclusion");
  const expectedFields = queue.status === "cancelled"
    ? hasInclusion
      ? INCLUDED_CANCELLED_QUEUE_FIELDS
      : CANCELLED_QUEUE_FIELDS
    : hasInclusion
      ? INCLUDED_PUBLISHING_QUEUE_FIELDS
      : PUBLISHING_QUEUE_FIELDS;
  if (!hasExactQueueFields(queue, expectedFields)) {
    cancellationError(
      "The claimed CMS publication baseline has conflicting evidence",
    );
  }

  let claim;
  try {
    claim = projectClaim(queue.serializerClaim);
  } catch {
    cancellationError("The CMS publication baseline claim is invalid");
  }
  const build = projectArtifactBuild(queue.artifactBuild, expected);
  const inclusion = hasInclusion
    ? projectArtifactInclusion(queue.artifactInclusion, expected, build)
    : null;
  if (
    claim.serializerId !== expected.serializerId ||
    claim.buildBatchId !== expected.buildBatchId ||
    claim.commitSha !== expected.queueCommitSha ||
    (expected.claimTokenDigest !== null &&
      claim.tokenDigest !== expected.claimTokenDigest)
  ) {
    cancellationError("The CMS publication baseline claim conflicts");
  }

  if (queue.status === "publishing") {
    if (
      queue.completedAt !== null ||
      queue.error !== null
    ) {
      cancellationError(
        "The CMS publication baseline is not a claimed pre-candidate build",
      );
    }
    return Object.freeze({ queue, claim, build, inclusion, receipt: null });
  }
  if (queue.status !== "cancelled") {
    cancellationError(
      "The CMS publication baseline is not a claimed pre-candidate build",
    );
  }
  const receipt = projectReceipt(
    queue.claimedBaselineCancellationReceipt,
    expected,
  );
  if (
    queue.error !== CANCELLATION_ERROR ||
    claim.tokenDigest !== receipt.claimTokenDigest ||
    !sameTimestamp(queue.completedAt, receipt.cancelledAt) ||
    !sameTimestamp(build.cutoffAt, receipt.cutoffAt) ||
    !receiptMatchesInclusion(receipt, inclusion) ||
    (inclusion &&
      !timestampAtOrBefore(inclusion.recordedAt, receipt.cancelledAt))
  ) {
    cancellationError(
      "The claimed CMS publication baseline cancellation receipt conflicts",
    );
  }
  return Object.freeze({ queue, claim, build, inclusion, receipt });
}

function projectBatch(snapshot, expected, queueState) {
  if (!snapshot.exists) {
    cancellationError("The CMS publication baseline build batch is missing");
  }
  let batch;
  try {
    batch = queueState.receipt
      ? assertPublicDeploymentCancelledBatch(
          snapshot.data(),
          expected.buildBatchId,
        )
      : assertPublicDeploymentReservedBatch(
          snapshot.data(),
          expected.buildBatchId,
        );
  } catch {
    cancellationError("The CMS publication baseline build batch is invalid");
  }
  const batchReceipt = queueState.receipt
    ? projectReceipt(batch.cancellationReceipt, expected)
    : null;
  if (
    batch.generation !== expected.generation ||
    batch.commitSha !== expected.queueCommitSha ||
    !sameTimestamp(batch.cutoffAt, queueState.build.cutoffAt) ||
    (queueState.inclusion &&
      !timestampAtOrBefore(batch.reservedAt, queueState.inclusion.recordedAt)) ||
    (!queueState.receipt &&
      (!timestampAtOrBefore(queueState.queue.triggeredAt, queueState.claim.claimedAt) ||
        !timestampAtOrBefore(queueState.claim.claimedAt, batch.cutoffAt) ||
        !timestampAtOrBefore(batch.cutoffAt, batch.reservedAt))) ||
    (queueState.receipt &&
      (!sameTimestamp(batch.cancelledAt, queueState.receipt.cancelledAt) ||
        !sameTimestamp(batch.cutoffAt, queueState.receipt.cutoffAt) ||
        batchReceipt.claimTokenDigest !== queueState.receipt.claimTokenDigest ||
        !sameReceiptInclusionBinding(batchReceipt, queueState.receipt)))
  ) {
    cancellationError("The CMS publication baseline build batch conflicts");
  }
  return batch;
}

function assertFirstMutationState({
  expected,
  pointerSnapshot,
  candidateSnapshot,
  manifestSnapshot,
  manifestChunksSnapshot,
  verificationSnapshot,
}) {
  if (expected.claimTokenDigest === null) {
    cancellationError(
      "The claimed publication baseline has no retained journal token",
    );
  }
  if (!pointerSnapshot.exists) {
    cancellationError("The public deployment coordinator is missing");
  }
  let pointer;
  try {
    pointer = assertPublicDeploymentPointer(pointerSnapshot.data());
  } catch {
    cancellationError("The public deployment coordinator is invalid");
  }
  if (
    pointer.state !== "idle" ||
    pointer.mediaLifecycleReady !== false ||
    pointer.activeGeneration === expected.generation ||
    pointer.newestEligibleGeneration === expected.generation ||
    pointer.newestEligibleBuildBatchId === expected.buildBatchId ||
    pointer.lastReservedGeneration < expected.generation
  ) {
    cancellationError(
      "The public deployment coordinator is not safe for baseline cancellation",
    );
  }
  if (
    candidateSnapshot.exists ||
    manifestSnapshot.exists ||
    !manifestChunksSnapshot.empty ||
    verificationSnapshot.exists
  ) {
    cancellationError(
      "The CMS publication baseline already has candidate or deployment evidence",
    );
  }
  return pointer;
}

function auditEntry({ expected, before, after, timestamp }) {
  return {
    actorUid: BASELINE_ACTOR.uid,
    actorEmail: BASELINE_ACTOR.email,
    action: CANCELLATION_ACTION,
    target: `cmsPublishQueue/${expected.queueId}`,
    before,
    after,
    source: CANCELLATION_SOURCE,
    timestamp,
    at: new Date().toISOString(),
  };
}

async function cancelClaimedCmsPublicationBaseline({
  firestore,
  expected: expectedValue,
  serverTimestamp,
}) {
  assertFirestore(firestore);
  if (typeof serverTimestamp !== "function") {
    cancellationError(
      "A Firestore server timestamp is required for claimed baseline cancellation",
    );
  }
  const expected = assertInput(expectedValue);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, expected.buildBatchId);
  const candidateRef = publicWorkerCandidateRef(
    firestore,
    expected.buildBatchId,
  );
  const manifestRef = publicMediaManifestRef(
    firestore,
    expected.buildBatchId,
  );
  const verificationRef = publicMediaManifestVerificationRef(
    firestore,
    expected.buildBatchId,
  );
  const manifestChunksQuery = manifestRef.collection("chunks").limit(1);
  const queueRef = firestore.collection("cmsPublishQueue").doc(expected.queueId);

  return firestore.runTransaction(async (transaction) => {
    const [
      pointerSnapshot,
      batchSnapshot,
      candidateSnapshot,
      manifestSnapshot,
      verificationSnapshot,
      queueSnapshot,
    ] = await transaction.getAll(
      pointerRef,
      batchRef,
      candidateRef,
      manifestRef,
      verificationRef,
      queueRef,
    );
    const manifestChunksSnapshot = await transaction.get(manifestChunksQuery);
    const queueState = projectQueue(queueSnapshot, expected);
    const batch = projectBatch(batchSnapshot, expected, queueState);
    if (queueState.receipt) {
      return Object.freeze({
        outcome: "cancelled",
        idempotent: true,
        receipt: queueState.receipt,
      });
    }
    assertFirstMutationState({
      expected,
      pointerSnapshot,
      candidateSnapshot,
      manifestSnapshot,
      manifestChunksSnapshot,
      verificationSnapshot,
    });

    const timestamp = serverTimestamp();
    const receipt = {
      schemaVersion: CANCELLATION_SCHEMA_VERSION,
      reason: CANCELLATION_REASON,
      queueId: expected.queueId,
      buildBatchId: expected.buildBatchId,
      generation: expected.generation,
      queueCommitSha: expected.queueCommitSha,
      operatorCommitSha: expected.operatorCommitSha,
      serializerId: expected.serializerId,
      claimTokenDigest: expected.claimTokenDigest,
      cutoffAt: queueState.build.cutoffAt,
      artifactReceiptDigest:
        queueState.inclusion?.artifactReceiptDigest ?? null,
      artifactInclusionRecordedAt:
        queueState.inclusion?.recordedAt ?? null,
      cancelledAt: timestamp,
    };
    transaction.update(queueRef, {
      status: "cancelled",
      completedAt: timestamp,
      error: CANCELLATION_ERROR,
      claimedBaselineCancellationReceipt: receipt,
    });
    transaction.update(batchRef, {
      status: "cancelled",
      cancelledReason: CANCELLATION_REASON,
      cancelledAt: timestamp,
      cancellationReceipt: receipt,
    });
    transaction.create(
      firestore.collection("admin_logs").doc(),
      auditEntry({
        expected,
        before: {
          queueStatus: queueState.queue.status,
          batchStatus: batch.status,
          generation: expected.generation,
          queueCommitSha: expected.queueCommitSha,
          artifactInclusionPresent: queueState.inclusion !== null,
        },
        after: {
          queueStatus: "cancelled",
          batchStatus: "cancelled",
          reason: CANCELLATION_REASON,
          operatorCommitSha: expected.operatorCommitSha,
          artifactInclusionPresent: queueState.inclusion !== null,
        },
        timestamp,
      }),
    );
    return Object.freeze({
      outcome: "cancelled",
      idempotent: false,
      receipt,
    });
  });
}

module.exports = {
  CANCELLATION_ACTION,
  CANCELLATION_ERROR,
  CANCELLATION_REASON,
  CmsPublicationBaselineClaimedCancellationError,
  cancelClaimedCmsPublicationBaseline,
};
