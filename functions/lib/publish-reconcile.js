"use strict";

const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { settleBuildQueueInTransaction } = require("./publish-build-state");
const { platformLimit } = require("./release-wait");
const { readSerializerPublicationControlInTransaction } = require("./serializer-publication-control");

const QUEUE_COLLECTION = "cmsPublishQueue";
const NON_TERMINAL_STATUSES = ["reserved", "pending", "publishing"];
// Every other transport names its own durable recovery owner, which alone
// settles its rows. Older rows have no transport.
const LEGACY_TRANSPORTS = new Set([undefined, null, "github", "serializer"]);
// A batch in one of these states is being activated or reconciled.
const OWNED_BATCH_STATUSES = new Set(["ready", "deploying", "reconciling"]);
const RECONCILE_PAGE_SIZE = 100;
// Writeback and dev publication recognize rows settled with this error.
const STALE_PUBLISH_ERROR =
  "Publish marked failed during reconciliation because no terminal workflow status was recorded within 24 hours.";

function timestampToMillis(value) {
  let milliseconds = null;
  if (value && typeof value.toMillis === "function") {
    milliseconds = value.toMillis();
  } else if (value instanceof Date) {
    milliseconds = value.getTime();
  }
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

// The Cloud Functions platform ends every request and schedule run by this
// limit, so an older row has no live request that can still dispatch it.
const requestLimitMillis = () => platformLimit("cloudFunctionsHttpSeconds") * 1_000;

function isLegacyRow(queue, cutoff) {
  const triggeredAt = timestampToMillis(queue?.triggeredAt);
  return LEGACY_TRANSPORTS.has(queue?.transport) &&
    NON_TERMINAL_STATUSES.includes(queue.status) &&
    triggeredAt !== null && triggeredAt <= cutoff;
}

// GitHub dispatch exists only for development (cms-publish-dispatch.js). Its
// workflow run owns a dispatched row and writes the terminal status.
const ownedByDevelopmentRun = (queue) => queue.transport === "github" &&
  process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development";

// A pending serializer row is durable before any journal, batch or candidate,
// and a paused serializer can still claim it. Only the recorded end of the
// serializer, or of legacy publication, shows that nothing will.
async function serializerCanClaim({ firestore, transaction, queue }) {
  if (queue.transport !== "serializer" || queue.status !== "pending") return false;
  const root = await transaction.get(firestore.doc("system/publicDeployment"));
  if (root.data()?.schemaVersion === 2) return false;
  return (await readSerializerPublicationControlInTransaction({ firestore, transaction })).enabled;
}

/** Whether the exact records of this row still name an owner: a serializer
 * journal job, an uploaded candidate, or a batch that is being activated. */
async function hasPublicationOwner({ firestore, transaction, queueId }) {
  const batchRef = firestore.doc(`system/publicDeployment/buildBatches/cms-${queueId}`);
  const [batch, candidate, pointer] = await transaction.getAll(batchRef,
    batchRef.collection("candidates").doc("worker"), firestore.doc("system/publicDeployment"));
  const job = await transaction.get(firestore.collection("cmsPublicationSerializerJournals")
    .where("job.queueId", "==", queueId).limit(1));
  const status = batch.data()?.status;
  return !job.empty || OWNED_BATCH_STATUSES.has(status) || status === "reserved" && candidate.exists ||
    pointer.data()?.candidateBuildBatchId === `cms-${queueId}`;
}

/** Fail the legacy queue rows that no owner can still settle, and release the
 * content markers that point at them in the same transaction. */
async function reconcileStalePublishRows({ firestore, now = () => Date.now() }) {
  // Lifecycle enqueue passes its ISO clock through the publish readiness gate.
  const time = now();
  const cutoff = (typeof time === "string" ? Date.parse(time) : time) - requestLimitMillis();
  const query = firestore
    .collection(QUEUE_COLLECTION)
    .where("status", "in", NON_TERMINAL_STATUSES)
    .where("triggeredAt", "<=", Timestamp.fromMillis(cutoff))
    .orderBy("triggeredAt", "desc")
    .limit(RECONCILE_PAGE_SIZE);

  let reconciledCount = 0;
  let after;
  while (true) {
    const candidates = await (after ? query.startAfter(after) : query).get();
    for (const candidate of candidates.docs) {
      // A transport not-in query would omit legacy jobs with no transport.
      // Page past protected owners so they cannot hide later orphans.
      if (!isLegacyRow(candidate.data(), cutoff) || ownedByDevelopmentRun(candidate.data())) continue;
      const result = await firestore.runTransaction(async (transaction) => {
        const queue = (await transaction.get(candidate.ref)).data();
        if (!isLegacyRow(queue, cutoff) || ownedByDevelopmentRun(queue) ||
            await serializerCanClaim({ firestore, transaction, queue }) ||
            await hasPublicationOwner({ firestore, transaction, queueId: candidate.id })) return false;
        return settleBuildQueueInTransaction(firestore, transaction, {
          queueId: candidate.id,
          status: "failed",
          queueUpdate: {
            status: "failed",
            completedAt: FieldValue.serverTimestamp(),
            error: STALE_PUBLISH_ERROR,
          },
          retireReservedBatch: true,
        });
      });
      if (result) reconciledCount += 1;
    }
    if (candidates.size < RECONCILE_PAGE_SIZE) break;
    after = candidates.docs.at(-1);
  }

  return reconciledCount;
}

module.exports = {
  NON_TERMINAL_STATUSES,
  QUEUE_COLLECTION,
  STALE_PUBLISH_ERROR,
  reconcileStalePublishRows,
  timestampToMillis,
};
