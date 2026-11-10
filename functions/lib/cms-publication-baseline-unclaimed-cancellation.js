"use strict";

// Guarded cancellation for a baseline queue that never reached serializer
// claim. The host token journal is verified and cleared by the operator.

const {
  BASELINE_ACTOR,
  projectExactQueue,
} = require("./cms-publication-baseline");
const { timestampParts } = require("./cms-publish-artifact");
const {
  assertPublicDeploymentPointer,
  isCommitSha,
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

const CANCELLATION_SCHEMA_VERSION = 1;
const CANCELLATION_REASON = "source_superseded_before_serializer_claim";
const CANCELLATION_ERROR =
  "Unclaimed publication baseline cancelled after its source was superseded.";
const CANCELLATION_ACTION = "cms-publication-baseline.cancel-unclaimed";
const CANCELLATION_SOURCE =
  "cms-publication-baseline-unclaimed-cancellation";
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TOKEN_DIGEST = /^[a-f0-9]{64}$/;
const PENDING_QUEUE_FIELDS = new Set([
  "status",
  "transport",
  "triggeredBy",
  "triggeredByEmail",
  "triggeredAt",
  "completedAt",
  "error",
  "changes",
  "commitSha",
]);
const CANCELLED_QUEUE_FIELDS = new Set([
  ...PENDING_QUEUE_FIELDS,
  "unclaimedBaselineCancellationReceipt",
]);
const CANCELLATION_RECEIPT_FIELDS = new Set([
  "schemaVersion",
  "reason",
  "queueId",
  "buildBatchId",
  "queueCommitSha",
  "operatorCommitSha",
  "serializerId",
  "claimTokenDigest",
  "cancelledAt",
]);

class CmsPublicationBaselineUnclaimedCancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsPublicationBaselineUnclaimedCancellationError";
  }
}

function cancellationError(message) {
  throw new CmsPublicationBaselineUnclaimedCancellationError(message);
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

function assertInput(expected) {
  if (
    !plainObject(expected) ||
    !QUEUE_ID.test(expected.queueId ?? "") ||
    expected.buildBatchId !== `cms-${expected.queueId}` ||
    !isCommitSha(expected.queueCommitSha) ||
    !isCommitSha(expected.operatorCommitSha) ||
    expected.queueCommitSha === expected.operatorCommitSha ||
    !SERIALIZER_ID.test(expected.serializerId ?? "") ||
    (expected.claimTokenDigest !== null &&
      !TOKEN_DIGEST.test(expected.claimTokenDigest ?? ""))
  ) {
    cancellationError(
      "The unclaimed CMS publication baseline cancellation input is invalid",
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
      "Firestore is required for unclaimed baseline cancellation",
    );
  }
}

function projectReceipt(value, expected) {
  if (
    !hasExactFields(value, CANCELLATION_RECEIPT_FIELDS) ||
    value.schemaVersion !== CANCELLATION_SCHEMA_VERSION ||
    value.reason !== CANCELLATION_REASON ||
    value.queueId !== expected.queueId ||
    value.buildBatchId !== expected.buildBatchId ||
    value.queueCommitSha !== expected.queueCommitSha ||
    value.operatorCommitSha !== expected.operatorCommitSha ||
    value.serializerId !== expected.serializerId ||
    !TOKEN_DIGEST.test(value.claimTokenDigest ?? "") ||
    (expected.claimTokenDigest !== null &&
      value.claimTokenDigest !== expected.claimTokenDigest) ||
    timestampParts(value.cancelledAt) === null
  ) {
    cancellationError(
      "The unclaimed CMS publication baseline cancellation receipt conflicts",
    );
  }
  return Object.freeze({ ...value });
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
  if (queue.status === "cancelled") {
    if (!hasExactQueueFields(queue, CANCELLED_QUEUE_FIELDS)) {
      cancellationError(
        "The cancelled CMS publication baseline has conflicting evidence",
      );
    }
    const receipt = projectReceipt(
      queue.unclaimedBaselineCancellationReceipt,
      expected,
    );
    if (
      queue.error !== CANCELLATION_ERROR ||
      !sameTimestamp(queue.completedAt, receipt.cancelledAt)
    ) {
      cancellationError(
        "The unclaimed CMS publication baseline cancellation receipt conflicts",
      );
    }
    return Object.freeze({ queue, receipt });
  }
  if (
    queue.status !== "pending" ||
    !hasExactQueueFields(queue, PENDING_QUEUE_FIELDS) ||
    queue.completedAt !== null ||
    queue.error !== null
  ) {
    cancellationError(
      "The CMS publication baseline is not pending before serializer claim",
    );
  }
  return Object.freeze({ queue, receipt: null });
}

function assertFirstMutationState({
  expected,
  pointerSnapshot,
  batchSnapshot,
  candidateSnapshot,
  manifestSnapshot,
  manifestChunksSnapshot,
  verificationSnapshot,
}) {
  if (expected.claimTokenDigest === null) {
    cancellationError(
      "The unclaimed publishing baseline has no retained journal token",
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
    pointer.newestEligibleBuildBatchId === expected.buildBatchId
  ) {
    cancellationError(
      "The public deployment coordinator is not idle with media publishing disabled",
    );
  }
  if (
    batchSnapshot.exists ||
    candidateSnapshot.exists ||
    manifestSnapshot.exists ||
    !manifestChunksSnapshot.empty ||
    verificationSnapshot.exists
  ) {
    cancellationError(
      "The CMS publication baseline already has build or deployment evidence",
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

async function cancelUnclaimedCmsPublicationBaseline({
  firestore,
  expected: expectedValue,
  serverTimestamp,
}) {
  assertFirestore(firestore);
  if (typeof serverTimestamp !== "function") {
    cancellationError(
      "A Firestore server timestamp is required for unclaimed baseline cancellation",
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
    const projectedQueue = projectQueue(queueSnapshot, expected);
    if (projectedQueue.receipt) {
      return Object.freeze({
        outcome: "cancelled",
        idempotent: true,
        receipt: projectedQueue.receipt,
      });
    }
    assertFirstMutationState({
      expected,
      pointerSnapshot,
      batchSnapshot,
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
      queueCommitSha: expected.queueCommitSha,
      operatorCommitSha: expected.operatorCommitSha,
      serializerId: expected.serializerId,
      claimTokenDigest: expected.claimTokenDigest,
      cancelledAt: timestamp,
    };
    transaction.update(queueRef, {
      status: "cancelled",
      completedAt: timestamp,
      error: CANCELLATION_ERROR,
      unclaimedBaselineCancellationReceipt: receipt,
    });
    transaction.create(
      firestore.collection("admin_logs").doc(),
      auditEntry({
        expected,
        before: {
          status: projectedQueue.queue.status,
          queueCommitSha: expected.queueCommitSha,
        },
        after: {
          status: "cancelled",
          reason: CANCELLATION_REASON,
          operatorCommitSha: expected.operatorCommitSha,
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
  CmsPublicationBaselineUnclaimedCancellationError,
  cancelUnclaimedCmsPublicationBaseline,
};
