"use strict";

const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./audit");
const {
  BASELINE_ACTOR,
  CmsPublicationBaselineError,
  projectExactQueue,
  assertNoPendingSourceBaselineWork,
} = require("./cms-publication-baseline");
const {
  assertPublicDeploymentPointer,
  isCommitSha,
  isPublicDeploymentIdentifier,
  timestampMillis,
} = require("./public-deployment");
const {
  publicBuildBatchRef,
  publicDeploymentRef,
} = require("./public-deployment-coordinator");
const {
  assertPublishedAssetProjection,
  readPublishedMediaAssets,
} = require("./published-media-safety");
const {
  assertCmsPublicationAdmission,
  readCmsPublicationRuntimeControlInTransaction,
} = require("./cms-publication-runtime-control");
const { assertSerializerPublicationEnabledInTransaction } = require("./serializer-publication-control");

function refuse(message) {
  throw new CmsPublicationBaselineError(message);
}

function assertRecoveryInput({ queueId, commitSha, expected }) {
  if (
    !/^[A-Za-z0-9]{20}$/.test(queueId ?? "") ||
    !isCommitSha(commitSha) ||
    !expected ||
    Object.keys(expected).length !== 4 ||
    !Number.isSafeInteger(expected.activeGeneration) ||
    expected.activeGeneration < 1 ||
    !Number.isSafeInteger(expected.lastReservedGeneration) ||
    expected.lastReservedGeneration <= expected.activeGeneration ||
    !Number.isSafeInteger(expected.lastReservedGeneration + 1) ||
    !isPublicDeploymentIdentifier(expected.activeDeploymentId) ||
    !isCommitSha(expected.activeCommitSha)
  ) {
    refuse("The baseline recovery identity is invalid");
  }
}

function assertRecoveryPointer(snapshot, expected) {
  if (!snapshot.exists) refuse("The public deployment coordinator is missing");
  const pointer = assertPublicDeploymentPointer(snapshot.data());
  if (
    pointer.state !== "idle" ||
    pointer.mediaLifecycleReady !== true ||
    pointer.newestEligibleGeneration !== pointer.activeGeneration ||
    Object.entries(expected).some(([key, value]) => pointer[key] !== value)
  ) {
    refuse("The baseline recovery predecessor or generation fence changed");
  }
  return pointer;
}

function recoveryRetry({
  queueSnapshot,
  receiptSnapshot,
  batchSnapshot,
  identity,
}) {
  if (!queueSnapshot.exists && !receiptSnapshot.exists && !batchSnapshot.exists)
    return null;
  const queue = projectExactQueue(queueSnapshot, identity);
  const receipt = receiptSnapshot.data();
  if (
    !queue ||
    queue.status === "reserved" ||
    !receipt ||
    timestampMillis(receipt.createdAt) === null ||
    !isDeepStrictEqual(
      Object.fromEntries(
        Object.entries(receipt).filter(([key]) => key !== "createdAt"),
      ),
      identity,
    )
  ) {
    refuse("The baseline recovery receipt conflicts");
  }
  return queue.status;
}

// This operator-only transaction replaces neither the active receipt nor the
// ordinary media admission fence. It closes media mutation before a new build,
// while locking the exact content and asset projections that make that safe.
async function recoverCmsPublicationBaseline({
  firestore,
  queueId,
  commitSha,
  expected,
}) {
  assertRecoveryInput({ queueId, commitSha, expected });
  const identity = {
    queueId,
    commitSha,
    expected,
    buildBatchId: `cms-${queueId}`,
  };
  const pointerRef = publicDeploymentRef(firestore);
  const queueRef = firestore.collection("cmsPublishQueue").doc(queueId);
  const receiptRef = queueRef.collection("recovery").doc("baseline");
  const batchRef = publicBuildBatchRef(firestore, identity.buildBatchId);
  const result = await firestore.runTransaction(async (transaction) => {
    const [snapshots, runtimeControl] = await Promise.all([
      transaction.getAll(pointerRef, queueRef, receiptRef, batchRef),
      readCmsPublicationRuntimeControlInTransaction({ firestore, transaction }),
    ]);
    const [pointerSnapshot, queueSnapshot, receiptSnapshot, batchSnapshot] =
      snapshots;
    const retryStatus = recoveryRetry({
      queueSnapshot,
      receiptSnapshot,
      batchSnapshot,
      identity,
    });
    if (retryStatus) return { status: retryStatus, idempotent: true };
    assertCmsPublicationAdmission(runtimeControl);
    await assertSerializerPublicationEnabledInTransaction({ firestore, transaction });
    const pointer = assertRecoveryPointer(pointerSnapshot, expected);
    await assertNoPendingSourceBaselineWork({ firestore, transaction, queueId, pointer });

    const { assetIds, assetOwners, assetSnapshots } =
      await readPublishedMediaAssets({ firestore, transaction });
    for (const [index, assetId] of assetIds.entries()) {
      assertPublishedAssetProjection({
        assetId,
        owner: assetOwners.get(assetId),
        privateSnapshot: assetSnapshots[index * 2],
        publicSnapshot: assetSnapshots[index * 2 + 1],
        uploadedMediaReady: true,
      });
    }
    const timestamp = FieldValue.serverTimestamp();
    transaction.set(pointerRef, {
      ...pointer,
      mediaLifecycleReady: false,
      updatedAt: timestamp,
    });
    transaction.create(queueRef, {
      status: "pending",
      transport: "serializer",
      triggeredBy: BASELINE_ACTOR.uid,
      triggeredByEmail: null,
      triggeredAt: timestamp,
      completedAt: null,
      error: null,
      changes: [],
      commitSha,
    });
    transaction.create(receiptRef, { ...identity, createdAt: timestamp });
    transaction.create(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      adminLogEntry({
        actorUid: BASELINE_ACTOR.uid,
        action: "cms-publication-baseline.recover",
        target: queueId,
        before: { ...expected, mediaLifecycleReady: true },
        after: {
          ...identity,
          mediaLifecycleReady: false,
          assetCount: assetIds.length,
        },
        source: "publication-baseline-recovery",
      }),
    );
    return { status: "pending", idempotent: false };
  });
  return { success: true, queueId, transport: "serializer", ...result };
}

module.exports = { assertRecoveryInput, recoverCmsPublicationBaseline };
