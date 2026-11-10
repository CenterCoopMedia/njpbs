"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const {
  enqueueSerializerBuild,
} = require("./cms-publish-serializer-queue");
const { assertPublishedMediaSafe } = require("./published-media-safety");
const {
  assertCmsPublicationAdmission,
  readCmsPublicationRuntimeControlInTransaction,
} = require("./cms-publication-runtime-control");
const { assertSerializerPublicationEnabledInTransaction } = require("./serializer-publication-control");
const {
  PublicDeploymentStateError,
  assertPublicDeploymentPointer,
  isCommitSha,
  timestampMillis,
} = require("./public-deployment");
const { publicDeploymentRef } = require("./public-deployment-coordinator");

const BASELINE_ACTOR = Object.freeze({
  uid: "system:publication-baseline",
  email: null,
});
const BASELINE_SOURCE = "publication-baseline";
const QUEUE_COLLECTION = "cmsPublishQueue";
const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const QUEUE_STATUSES = new Set([
  "reserved",
  "pending",
  "publishing",
  "success",
  "failed",
  "cancelled",
]);

class CmsPublicationBaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsPublicationBaselineError";
  }
}

function baselineError(message) {
  throw new CmsPublicationBaselineError(message);
}

function assertInput({ firestore, queueId, commitSha, returnPostId }) {
  if (
    !firestore ||
    typeof firestore.collection !== "function" ||
    typeof firestore.runTransaction !== "function" ||
    !QUEUE_ID.test(queueId ?? "") ||
    !isCommitSha(commitSha) ||
    (returnPostId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(returnPostId))
  ) {
    baselineError("The CMS publication baseline input is invalid");
  }
}

function projectExactQueue(snapshot, identity) {
  const { queueId, commitSha, returnPostId } = identity;
  if (!snapshot?.exists) return null;
  const queue = snapshot.data();
  if (
    !queue ||
    queue.transport !== "serializer" ||
    queue.triggeredBy !== BASELINE_ACTOR.uid ||
    queue.triggeredByEmail !== null ||
    queue.commitSha !== commitSha ||
    (Object.hasOwn(identity, "returnPostId") && (queue.noBuildStaticReturn?.postId ?? undefined) !== returnPostId) ||
    !Array.isArray(queue.changes) ||
    queue.changes.length !== 0 ||
    !QUEUE_STATUSES.has(queue.status) ||
    timestampMillis(queue.triggeredAt) === null
  ) {
    baselineError(`Publish queue ${queueId} belongs to another request`);
  }
  if (queue.noBuildStaticReturn) require("./no-build-post-static-return").projectStaticInput(queue.noBuildStaticReturn);
  return queue;
}

function exactResult(queueId, queue, idempotent) {
  return Object.freeze({
    success: true,
    queueId,
    dispatched: false,
    status: queue.status,
    transport: "serializer",
    idempotent,
    message: "Publication baseline queue confirmed.",
  });
}

function assertCoordinatorAvailable(snapshot) {
  if (!snapshot.exists) {
    baselineError("The public deployment coordinator is missing");
  }
  let pointer;
  try {
    pointer = assertPublicDeploymentPointer(snapshot.data());
  } catch (error) {
    if (error instanceof PublicDeploymentStateError) {
      baselineError(error.message);
    }
    throw error;
  }
  if (pointer.state !== "idle") {
    baselineError(
      "The public deployment coordinator is not idle with media publishing disabled",
    );
  }
  if (pointer.mediaLifecycleReady === false) {
    return pointer;
  }
  if (
    pointer.mediaLifecycleReady === true &&
    pointer.activeGeneration > 0 &&
    pointer.lastReservedGeneration === pointer.activeGeneration &&
    pointer.newestEligibleGeneration === pointer.activeGeneration
  ) {
    return pointer;
  }
  if (
    pointer.mediaLifecycleReady === true &&
    pointer.lastReservedGeneration > pointer.activeGeneration &&
    pointer.newestEligibleGeneration === pointer.activeGeneration
  ) {
    baselineError(
      "Use --apply-recovery; last reserved generation is ahead of active",
    );
  }
  if (
    pointer.mediaLifecycleReady === true &&
    pointer.newestEligibleGeneration > pointer.activeGeneration
  ) {
    baselineError(
      "Newest eligible generation is ahead of active; finish that candidate before a source baseline",
    );
  }
  baselineError(
    "The public deployment coordinator is not idle with media publishing disabled",
  );
}

async function assertNoPendingSourceBaselineWork({
  firestore,
  transaction,
  queueId,
  pointer,
  returnPostId,
}) {
  // A compatible code release can repair an owned detail route before its
  // confirmation succeeds. Keep that operation pending; activation still proves
  // every owned route, and only its confirmation owner can settle the content.
  const retained = (await retainedNoBuildWork({ firestore, transaction, pointer })).filter(state => state.postId !== returnPostId);
  const retainedQueues = new Set(retained.map(state => state.operationId));
  const retainedPosts = new Set(retained.map(state => state.postId));
  const contextQueues = await require("./public-context-publication")
    .retainedPublicContextQueueIdsInTransaction({ firestore, transaction });
  const activeQueues = await transaction.get(
    firestore
      .collection(QUEUE_COLLECTION)
      .where("status", "in", ["reserved", "pending", "publishing"])
      .limit(retained.length + contextQueues.size + 2),
  );
  if (activeQueues.docs.some((doc) => doc.id !== queueId && !retainedQueues.has(doc.id) && !contextQueues.has(doc.id))) {
    baselineError("Finish existing publication queues before a source baseline");
  }
  const pendingContent = await Promise.all(
    ["cmsPages", "cmsPosts"].map((collection) =>
      transaction.get(
        firestore
          .collection(collection)
          .where("publishBuildPending", "==", true)
          .limit(retained.length + 1),
      ),
    ),
  );
  if (!pendingContent[0].empty || pendingContent[1].docs.some(doc => !retainedPosts.has(doc.id))) {
    baselineError("Resolve pending content publication before a source baseline");
  }
}

async function retainedNoBuildWork({ firestore, transaction, pointer }) {
  const { TRANSPORT } = require("./no-build-post-publication");
  const { listNoBuildPostOwners, readNoBuildPostCapability, effectiveNoBuildPostState } = require("./no-build-post-ownership");
  const owners = await listNoBuildPostOwners({ firestore, transaction });
  const capability = await readNoBuildPostCapability({ firestore, transaction });
  const retained = [];
  for (const owner of owners) {
    const state = effectiveNoBuildPostState(owner.state, capability);
    if (!state?.operationId || state.mode === "static" || !state.servingEnabled ||
        state.rendererSha !== pointer.activeCommitSha) continue;
    const queue = (await transaction.get(firestore.doc(`${QUEUE_COLLECTION}/${state.operationId}`))).data();
    const document = (await transaction.get(firestore.doc(`cmsPosts/${state.postId}`))).data();
    const change = queue?.changes?.[0];
    if (queue?.transport !== TRANSPORT || !["pending", "failed"].includes(queue.status) ||
        queue.changes?.length !== 1 || change.collection !== "cmsPosts" || change.id !== state.postId ||
        change.sourceVersion !== state.sourceVersion || (change.operation === "withdraw") === state.visible ||
        queue.noBuildPost?.operationId !== state.operationId || queue.noBuildPost.postId !== state.postId ||
        queue.noBuildPost.sourceVersion !== state.sourceVersion ||
        document?.publishBuildPending !== true || document.publishBuildQueueId !== state.operationId ||
        document.published?.sourceVersion !== state.sourceVersion || document.published?.metadata?.slug !== state.slug ||
        require("./public-video-references").publiclyVisible(document) !== state.visible) continue;
    retained.push(state);
  }
  return retained;
}

async function assertSourceBaselineAdmission({
  firestore,
  transaction,
  queueId,
  pointerSnapshot,
  returnPostId,
}) {
  const pointer = assertCoordinatorAvailable(
    pointerSnapshot ?? (await transaction.get(publicDeploymentRef(firestore))),
  );
  await assertNoPendingSourceBaselineWork({ firestore, transaction, queueId, pointer, returnPostId });
  return pointer;
}

async function reserveBaselineQueue({ firestore, queueId, commitSha, returnPostId }) {
  const queueRef = firestore.collection(QUEUE_COLLECTION).doc(queueId);
  const pointerRef = publicDeploymentRef(firestore);
  return firestore.runTransaction(async (transaction) => {
    const [queueSnapshot, pointerSnapshot, runtimeControl] = await Promise.all([
      transaction.get(queueRef),
      transaction.get(pointerRef),
      readCmsPublicationRuntimeControlInTransaction({ firestore, transaction }),
    ]);
    const existing = projectExactQueue(queueSnapshot, { queueId, commitSha, returnPostId });
    if (existing && existing.status !== "reserved") {
      return { existing };
    }
    if (!existing) await require("./public-release-legacy-queue-admission")
      .assertLegacyPublicQueueAdmissionInTransaction({ firestore, transaction });
    assertCmsPublicationAdmission(runtimeControl);
    // A retained reservation was accepted before the cutoff and can finish.
    if (!existing) await assertSerializerPublicationEnabledInTransaction({ firestore, transaction });
    await assertSourceBaselineAdmission({
      firestore,
      transaction,
      queueId,
      pointerSnapshot,
      returnPostId,
    });
    const intent = returnPostId === undefined ? null : await require("./no-build-post-static-return").staticReturnIntentInTransaction({
      firestore, transaction, postId: returnPostId,
    });
    if (existing?.noBuildStaticReturn) await require("./no-build-post-static-return").assertStaticReturnIntentInTransaction({
      firestore, transaction, intent: existing.noBuildStaticReturn,
    });
    if (!existing) {
      transaction.create(queueRef, {
        status: "reserved",
        transport: "serializer",
        triggeredBy: BASELINE_ACTOR.uid,
        triggeredByEmail: null,
        triggeredAt: FieldValue.serverTimestamp(),
        completedAt: null,
        error: null,
        changes: [],
        commitSha,
        ...(intent ? { noBuildStaticReturn: intent } : {}),
      });
    }
    return { existing: null };
  });
}

async function enqueueCmsPublicationBaseline(
  { firestore, queueId, commitSha, returnPostId },
  {
    assertPublishedMediaSafeFn = assertPublishedMediaSafe,
    enqueueSerializerBuildFn = enqueueSerializerBuild,
  } = {},
) {
  assertInput({ firestore, queueId, commitSha, returnPostId });
  if (
    typeof assertPublishedMediaSafeFn !== "function" ||
    typeof enqueueSerializerBuildFn !== "function"
  ) {
    baselineError("The CMS publication baseline dependencies are invalid");
  }
  const queueRef = firestore.collection(QUEUE_COLLECTION).doc(queueId);
  const before = projectExactQueue(await queueRef.get(), { queueId, commitSha, returnPostId });
  if (before && before.status !== "reserved") {
    return exactResult(queueId, before, true);
  }

  await assertPublishedMediaSafeFn({ firestore });
  const reservation = await reserveBaselineQueue({
    firestore,
    queueId,
    commitSha,
    returnPostId,
  });
  if (reservation.existing) {
    return exactResult(queueId, reservation.existing, true);
  }

  const queued = await enqueueSerializerBuildFn({
    firestore,
    actor: BASELINE_ACTOR,
    changes: [],
    source: BASELINE_SOURCE,
    queueId,
    queueReserved: true,
    commitSha,
    assertInTransactionFn: async ({ firestore: enqueueFirestore, transaction }) => {
      await assertSourceBaselineAdmission({ firestore: enqueueFirestore, transaction, queueId, returnPostId });
      if (returnPostId !== undefined) {
        const reserved = (await transaction.get(queueRef)).data();
        await require("./no-build-post-static-return").assertStaticReturnIntentInTransaction({
          firestore: enqueueFirestore, transaction, intent: reserved?.noBuildStaticReturn,
        });
      }
    },
  });
  const persisted = projectExactQueue(await queueRef.get(), { queueId, commitSha, returnPostId });
  if (!persisted || persisted.status === "reserved") {
    baselineError("The CMS publication baseline queue was not persisted");
  }
  return exactResult(queueId, persisted, queued.idempotent === true);
}

module.exports = {
  BASELINE_ACTOR,
  BASELINE_SOURCE,
  CmsPublicationBaselineError,
  enqueueCmsPublicationBaseline,
  projectExactQueue,
  assertNoPendingSourceBaselineWork,
  reserveBaselineQueue,
};
