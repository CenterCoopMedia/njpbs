"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const { assertSerializerPublicationEnabledInTransaction } = require("./serializer-publication-control");
const { isDeepStrictEqual } = require("node:util");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./audit");
const { addressedPublishChanges, markBuildEnqueuedInTransaction } = require("./publish-build-state");
const {
  assertCmsPublicationAdmission,
  readCmsPublicationRuntimeControlInTransaction,
} = require("./cms-publication-runtime-control");

const { routePurgeConfig, prepareRoutePurgeInTransaction, attemptPostRoutePurge } = require("./post-route-purge");

const QUEUE_COLLECTION = "cmsPublishQueue";
const SERIALIZER_TRANSPORT = "serializer";

async function enqueueSerializerBuild({
  firestore,
  actor,
  changes,
  source,
  queueId = null,
  queueReserved = false,
  commitSha = null,
  adminLogEntryFn = adminLogEntry,
  markBuildEnqueuedInTransactionFn = markBuildEnqueuedInTransaction,
  requireExactPendingChanges = false,
  assertInTransactionFn = null,
  routePurge = {},
}) {
  if (commitSha !== null && !/^[a-f0-9]{40}$/.test(commitSha)) {
    throw new Error(
      "enqueueSerializerBuild commitSha must be a full commit SHA",
    );
  }
  if (
    assertInTransactionFn != null &&
    typeof assertInTransactionFn !== "function"
  ) {
    throw new Error(
      "enqueueSerializerBuild assertInTransactionFn must be a function",
    );
  }
  const queueRef = queueId
    ? firestore.collection(QUEUE_COLLECTION).doc(queueId)
    : firestore.collection(QUEUE_COLLECTION).doc();
  const auditRef = firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc();
  const queue = {
    status: "pending",
    transport: SERIALIZER_TRANSPORT,
    triggeredBy: actor.uid,
    triggeredByEmail: actor.email ?? null,
    triggeredAt: FieldValue.serverTimestamp(),
    completedAt: null,
    error: null,
    changes: Array.isArray(changes) ? changes : [],
    ...(commitSha === null ? {} : { commitSha }),
  };
  const audit = adminLogEntryFn({
    actorUid: actor.uid,
    actorEmail: actor.email ?? null,
    action: "cms.publish",
    target: queueRef.id,
    after: {
      status: "pending",
      transport: SERIALIZER_TRANSPORT,
      changesCount: queue.changes.length,
      ...(commitSha === null ? {} : { commitSha }),
    },
    source,
  });

  const purgeConfig = routePurge.config ?? routePurgeConfig();
  const idempotent = await firestore.runTransaction(async (transaction) => {
    await require("./public-release-legacy-queue-admission").assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
    const runtimeControl =
      await readCmsPublicationRuntimeControlInTransaction({
        firestore,
        transaction,
      });
    if (queueReserved) {
      const snapshot = await transaction.get(queueRef);
      if (!snapshot.exists) {
        throw new Error(`Reserved publish queue ${queueRef.id} was not found`);
      }
      const existing = snapshot.data();
      const exactIdentity =
        existing?.transport === queue.transport &&
        existing?.triggeredBy === queue.triggeredBy &&
        existing?.triggeredByEmail === queue.triggeredByEmail &&
        existing?.commitSha === queue.commitSha &&
        isDeepStrictEqual(existing?.changes, queue.changes);
      if (!exactIdentity) {
        throw new Error(`Reserved publish queue ${queueRef.id} conflicts`);
      }
      if (existing.status !== "reserved") return true;
    }
    // Runtime-pin pauses let an exact prior reservation drain. The separate
    // initial-install fence above closes only after its transaction proves
    // there is no reserved/pending/publishing queue.
    if (!queueReserved) {
      await assertSerializerPublicationEnabledInTransaction({ firestore, transaction });
      assertCmsPublicationAdmission(runtimeControl);
    }
    // Callers such as a media-on source baseline recheck predicates here so a
    // later staff publish cannot land between reservation and promotion.
    const writeAdmission = assertInTransactionFn ? await assertInTransactionFn({
        firestore,
        transaction,
        queueRef,
        queue,
      }) : null;
    const purgeState = await prepareRoutePurgeInTransaction({ firestore, transaction,
      changes: addressedPublishChanges(queue.changes), config: purgeConfig, now: (routePurge.now ?? Date.now)() });
    if (purgeState !== undefined) queue.routePurge = purgeState;
    const marked = await markBuildEnqueuedInTransactionFn(firestore, transaction, {
      queueId: queueRef.id,
      changes: queue.changes,
    });
    const contentCount = addressedPublishChanges(queue.changes)
      .filter((change) => change.collection !== "cmsSettings").length;
    if (requireExactPendingChanges && marked !== contentCount) {
      const error = new Error("The requested publication is no longer pending.");
      error.status = 409;
      throw error;
    }
    // An admission receipt can join the existing queue transaction after all
    // reads, without introducing a second queue owner or a post-commit gap.
    if (typeof writeAdmission === "function") writeAdmission();
    if (queueReserved) transaction.update(queueRef, queue);
    else transaction.create(queueRef, queue);
    transaction.create(auditRef, audit);
    return false;
  });

  // Remote invalidation runs only after the queue/snapshot commit. Its failure
  // remains on routePurge and cannot change publication or build status.
  await attemptPostRoutePurge({ firestore, queueId: queueRef.id, config: purgeConfig, ...routePurge });
  return {
    success: true,
    queueId: queueRef.id,
    dispatched: false,
    status: "pending",
    transport: SERIALIZER_TRANSPORT,
    idempotent,
    message: "Publish queued.",
  };
}

module.exports = { enqueueSerializerBuild };
