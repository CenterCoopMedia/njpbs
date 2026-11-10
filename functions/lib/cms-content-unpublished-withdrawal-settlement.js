"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { BASELINE_ACTOR } = require("./cms-publication-baseline");
const { CANCELLATION_ERROR } = require("./cms-publication-content-claimed-cancellation");
const { timestampParts } = require("./cms-publish-artifact");
const {
  assertPublicDeploymentCancelledBatch,
  assertPublicDeploymentPointer,
  isCommitSha,
  isPublicDeploymentIdentifier,
  timestampMillis,
} = require("./public-deployment");
const { publicBuildBatchRef, publicDeploymentRef } = require("./public-deployment-coordinator");
const { addressedPublishChanges } = require("./publish-build-state");

const SETTLEMENT_ACTION = "cms-content.settle-unpublished-withdrawal";
const RECEIPT_FIELD = "unpublishedWithdrawalSettlementReceipt";

class CmsContentUnpublishedWithdrawalSettlementError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsContentUnpublishedWithdrawalSettlementError";
  }
}

function refuse(message) {
  throw new CmsContentUnpublishedWithdrawalSettlementError(message);
}

function assertSettlementInput(expected) {
  if (
    !["cmsPages", "cmsPosts"].includes(expected?.collection) ||
    !isPublicDeploymentIdentifier(expected?.recordId) ||
    !Number.isSafeInteger(expected?.sourceVersion) || expected.sourceVersion < 1 ||
    !/^[A-Za-z0-9]{20}$/.test(expected?.queueId ?? "") ||
    !Number.isSafeInteger(expected?.activeGeneration) || expected.activeGeneration < 1 ||
    !isPublicDeploymentIdentifier(expected?.activeBuildBatchId) ||
    !isCommitSha(expected?.operatorCommitSha)
  ) {
    refuse("The unpublished withdrawal settlement input is invalid");
  }
}

function assertCancelledQueue(queueSnapshot, batchSnapshot, expected) {
  if (!queueSnapshot.exists || queueSnapshot.data().status !== "cancelled") {
    refuse("The named publication queue is missing or not cancelled");
  }
  const queue = queueSnapshot.data();
  let batch;
  try {
    batch = assertPublicDeploymentCancelledBatch(batchSnapshot.data(), `cms-${expected.queueId}`);
  } catch {
    refuse("The claimed content cancellation receipt or batch is invalid");
  }
  const receipt = queue.claimedContentCancellationReceipt;
  if (
    ![1, 2].includes(receipt?.schemaVersion) || receipt.queueId !== expected.queueId ||
    !isDeepStrictEqual(receipt, batch.cancellationReceipt) ||
    queue.error !== CANCELLATION_ERROR ||
    !isDeepStrictEqual(timestampParts(queue.completedAt), timestampParts(receipt.cancelledAt))
  ) {
    refuse("The claimed content cancellation receipt is missing or conflicts");
  }
  // This is the cancelled original publication, before staff withdrew the record.
  // A cancelled withdrawal or an unrelated queue cannot prove that publication failed.
  const publication = addressedPublishChanges(queue.changes).find((change) =>
    change.collection === expected.collection && change.id === expected.recordId);
  if (publication?.sourceVersion !== expected.sourceVersion || publication.operation !== undefined) {
    refuse("The cancelled queue's original content publication guard refused");
  }
  return receipt;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function settlementIdentity(expected, cancellation) {
  // Use an explicit field order and timestamp parts to bind the durable evidence.
  const cancellationReceiptDigest = digest({
    schemaVersion: cancellation.schemaVersion, reason: cancellation.reason,
    queueId: cancellation.queueId, buildBatchId: cancellation.buildBatchId,
    generation: cancellation.generation, queueCommitSha: cancellation.queueCommitSha,
    operatorCommitSha: cancellation.operatorCommitSha, serializerId: cancellation.serializerId,
    claimTokenDigest: cancellation.claimTokenDigest,
    cutoffAt: timestampParts(cancellation.cutoffAt),
    ...(cancellation.schemaVersion === 2 ? {
      artifactReceiptDigest: cancellation.artifactReceiptDigest,
      artifactInclusionRecordedAt: timestampParts(cancellation.artifactInclusionRecordedAt),
    } : {}),
    cancelledAt: timestampParts(cancellation.cancelledAt),
  });
  return {
    schemaVersion: 1,
    collection: expected.collection, recordId: expected.recordId,
    sourceVersion: expected.sourceVersion, queueId: expected.queueId,
    activeGeneration: expected.activeGeneration,
    activeBuildBatchId: expected.activeBuildBatchId,
    operatorCommitSha: expected.operatorCommitSha,
    cancellationReceiptDigest,
  };
}

function assertUnconfirmedRecord(record, expected) {
  if (!record) refuse("The content record is missing");
  if (record.publiclyVisible !== false) refuse("The content visibility guard refused");
  if (record.published?.sourceVersion !== expected.sourceVersion) {
    refuse("The published source version guard refused");
  }
  // With explicit invisibility and a pending build, save.js's legacy fallback
  // cannot confirm published.sourceVersion. Require an absent or null marker too.
  if (record.publicSourceVersion != null) refuse("The confirmed public version guard refused");
}

function assertSettlementReceipt(record, identity) {
  const receipt = record[RECEIPT_FIELD];
  const { settledAt, ...storedIdentity } = receipt ?? {};
  if (
    !isDeepStrictEqual(storedIdentity, { ...identity, receiptDigest: digest(identity) }) ||
    timestampMillis(settledAt) === null ||
    record.publishBuildPending !== false || record.publishBuildQueueId !== null ||
    record.publicSourceVersion !== null
  ) {
    refuse("The unpublished withdrawal settlement receipt or end state conflicts");
  }
  return receipt;
}

function assertIdlePredecessor(snapshot, expected, cancelledBatch) {
  let pointer;
  try {
    pointer = assertPublicDeploymentPointer(snapshot.data());
  } catch {
    refuse("The public deployment coordinator is missing or invalid");
  }
  if (
    pointer.state !== "idle" || pointer.activeGeneration !== expected.activeGeneration ||
    pointer.newestEligibleGeneration !== expected.activeGeneration ||
    pointer.newestEligibleBuildBatchId !== expected.activeBuildBatchId
  ) {
    refuse("The idle coordinator generation or active batch guard refused");
  }
  if (
    pointer.activeGeneration !== cancelledBatch.reservedAgainstGeneration ||
    pointer.activeDeploymentId !== cancelledBatch.reservedAgainstDeploymentId ||
    pointer.activeCommitSha !== cancelledBatch.reservedAgainstCommitSha ||
    pointer.lastReservedGeneration !== cancelledBatch.generation
  ) {
    refuse("The cancelled publication predecessor or last reservation guard refused");
  }
}

async function settleUnpublishedCmsContentWithdrawal({ firestore, expected, serverTimestamp }) {
  assertSettlementInput(expected);
  const recordRef = firestore.collection(expected.collection).doc(expected.recordId);
  const queueRef = firestore.collection("cmsPublishQueue").doc(expected.queueId);
  const pointerRef = publicDeploymentRef(firestore);
  const batchRef = publicBuildBatchRef(firestore, `cms-${expected.queueId}`);
  const idempotent = await firestore.runTransaction(async (transaction) => {
    const [recordSnapshot, queueSnapshot, pointerSnapshot, batchSnapshot] =
      await transaction.getAll(recordRef, queueRef, pointerRef, batchRef);
    if (!recordSnapshot.exists) refuse("The content record is missing");
    const record = recordSnapshot.data();
    assertUnconfirmedRecord(record, expected);
    const cancellation = assertCancelledQueue(queueSnapshot, batchSnapshot, expected);
    const identity = settlementIdentity(expected, cancellation);
    if (record[RECEIPT_FIELD] !== undefined) {
      assertSettlementReceipt(record, identity);
      return true;
    }
    assertIdlePredecessor(pointerSnapshot, expected, batchSnapshot.data());
    if (record.publishBuildPending !== true) refuse("The pending withdrawal guard refused");
    if (record.publishBuildQueueId !== null && record.publishBuildQueueId !== expected.queueId) {
      refuse("The content build queue ownership guard refused");
    }
    const contextQueues = await require("./public-context-publication")
      .retainedPublicContextQueueIdsInTransaction({ firestore, transaction });
    const activeQueues = await transaction.get(firestore.collection("cmsPublishQueue")
      .where("status", "in", ["reserved", "pending", "publishing"]).limit(contextQueues.size + 1));
    if (activeQueues.docs.some(row => !contextQueues.has(row.id))) refuse("The live publication queue guard refused");
    const publicAttempts = await transaction.get(firestore.collection("cmsPublishQueue")
      .where("status", "in", ["success", "public_unconfirmed"]));
    if (publicAttempts.docs.some((snapshot) => addressedPublishChanges(snapshot.data().changes)
      .some((change) => change.collection === expected.collection &&
        change.id === expected.recordId && change.sourceVersion === expected.sourceVersion &&
        change.operation === undefined))) {
      refuse("The prior public publication attempt guard refused");
    }

    const timestamp = serverTimestamp();
    const receipt = { ...identity, receiptDigest: digest(identity), settledAt: timestamp };
    transaction.update(recordRef, {
      publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: null,
      [RECEIPT_FIELD]: receipt,
    });
    transaction.create(firestore.collection("admin_logs").doc(), {
      actorUid: BASELINE_ACTOR.uid, actorEmail: BASELINE_ACTOR.email,
      action: SETTLEMENT_ACTION, target: `${expected.collection}/${expected.recordId}`,
      before: {
        publishBuildPending: true, publishBuildQueueId: record.publishBuildQueueId,
        publicSourceVersion: record.publicSourceVersion ?? null,
      },
      after: { publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: null, receipt },
      source: "cms-content-unpublished-withdrawal-settlement",
      timestamp, at: new Date().toISOString(),
    });
    return false;
  });
  // Read back resolved server timestamps before reporting success.
  const [recordSnapshot, queueSnapshot, batchSnapshot] = await firestore.getAll(recordRef, queueRef, batchRef);
  const record = recordSnapshot.data();
  assertUnconfirmedRecord(record, expected);
  const cancellation = assertCancelledQueue(queueSnapshot, batchSnapshot, expected);
  return {
    outcome: "settled", idempotent,
    receipt: assertSettlementReceipt(record, settlementIdentity(expected, cancellation)),
  };
}

module.exports = {
  CmsContentUnpublishedWithdrawalSettlementError,
  settleUnpublishedCmsContentWithdrawal,
};
