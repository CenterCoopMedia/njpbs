"use strict";

const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { settleBuildQueue } = require("./publish-build-state");

const QUEUE_COLLECTION = "cmsPublishQueue";
const NON_TERMINAL_STATUSES = ["reserved", "pending", "publishing"];
// Home uses the Page transport; settings use the aggregate-context transport.
// Their durable recovery owners alone settle these operations.
const DURABLE_NO_BUILD_TRANSPORTS = new Set([
  "post-no-build-v1", "page-no-build-v1", "public-context-no-build-v1",
]);
const STALE_PUBLISH_AFTER_MS = 24 * 60 * 60 * 1000;
const RECONCILE_PAGE_SIZE = 100;
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

async function reconcileStalePublishRows({
  firestore,
  now = () => Date.now(),
  staleAfterMs = STALE_PUBLISH_AFTER_MS,
}) {
  // Lifecycle enqueue passes its ISO clock through the publish readiness gate.
  const time = now();
  const cutoff = (typeof time === "string" ? Date.parse(time) : time) - staleAfterMs;
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
      // Page past protected owners so they cannot hide later stale jobs.
      if (DURABLE_NO_BUILD_TRANSPORTS.has(candidate.data().transport)) continue;
      const triggeredAt = timestampToMillis(candidate.data().triggeredAt);
      if (triggeredAt === null || triggeredAt > cutoff) continue;
      const reconciled = await settleBuildQueue(firestore, {
        queueId: candidate.id,
        status: "failed",
        queueUpdate: {
          status: "failed",
          completedAt: FieldValue.serverTimestamp(),
          error: STALE_PUBLISH_ERROR,
        },
        acceptQueue: (data) => {
          const triggeredAt = timestampToMillis(data.triggeredAt);
          return (
            !DURABLE_NO_BUILD_TRANSPORTS.has(data.transport) &&
            NON_TERMINAL_STATUSES.includes(data.status) &&
            triggeredAt !== null &&
            triggeredAt <= cutoff
          );
        },
      });
      if (reconciled) reconciledCount += 1;
    }
    if (candidates.size < RECONCILE_PAGE_SIZE) break;
    after = candidates.docs.at(-1);
  }

  return reconciledCount;
}

module.exports = {
  NON_TERMINAL_STATUSES,
  QUEUE_COLLECTION,
  STALE_PUBLISH_AFTER_MS,
  STALE_PUBLISH_ERROR,
  reconcileStalePublishRows,
  timestampToMillis,
};
