"use strict";

const { processingChanges } = require("./video-processing-status");
const { FieldValue } = require("firebase-admin/firestore");
const { SourceMediaValidationError } = require("./source-media-contract");
const LOCAL_OUTSTANDING_LIMIT = 500;
const queueRef = (firestore) => firestore.collection("mediaSourceTranscriptLimits").doc("local-outstanding");

async function readLocalQueue(tx, firestore) {
  const queue = (await tx.get(queueRef(firestore))).data();
  if (queue?.initialized === true) {
    if (!Array.isArray(queue.activeIds) || queue.activeIds.some(id => typeof id !== "string")) {
      throw new SourceMediaValidationError("The local transcript queue needs an administrator's check", 503);
    }
    return queue.activeIds;
  }
  // One bounded bootstrap for pre-existing local jobs. The queue record joins
  // the read set, so admission and terminal array transforms cannot lose slots.
  const jobs = firestore.collection("mediaSourceTranscriptJobs");
  const [local, oldAmazon] = await Promise.all([
    tx.get(jobs.where("active", "==", true).where("provider", "==", "local").limit(LOCAL_OUTSTANDING_LIMIT)),
    // The previous default-request admission allowed at most 20 outstanding
    // jobs, including local jobs already routed to Amazon during rollout.
    tx.get(jobs.where("active", "==", true).where("provider", "==", "amazon-transcribe").limit(20)),
  ]);
  return [...new Set([...local.docs.map(doc => doc.id),
    ...oldAmazon.docs.filter(doc => doc.data().fallbackAt || doc.data().localQueueSlot).map(doc => doc.id)])];
}
function reserveLocalQueue(tx, firestore, activeIds, id) {
  if (activeIds.length >= LOCAL_OUTSTANDING_LIMIT) {
    throw new SourceMediaValidationError("The station has 500 queued or running local transcripts. Wait for a transcript to finish, then try again", 429);
  }
  tx.set(queueRef(firestore), { initialized: true, activeIds: [...activeIds, id] });
}
function releaseLocalQueue(tx, firestore, job) {
  if (job?.localQueueSlot || job?.provider === "local" || job?.fallbackAt) {
    tx.set(queueRef(firestore), { activeIds: FieldValue.arrayRemove(job.id) }, { merge: true });
  }
}
async function requeueLocalFallback(tx, firestore, ref, job, now) {
  if ((!job.localQueueSlot && !job.fallbackAt) || job.startIntentAt) return false;
  const activeIds = await readLocalQueue(tx, firestore);
  if (!activeIds.includes(job.id)) {
    if (activeIds.length >= LOCAL_OUTSTANDING_LIMIT) return false;
    reserveLocalQueue(tx, firestore, activeIds, job.id);
  }
  tx.update(ref, processingChanges(job, { provider: "local", phase: "pending", active: true,
    localQueueSlot: true, processingStage: "queued", paidFallbackState: null, fallbackTranscriptId: null,
    // A failed local attempt goes behind fresh work. Keep the original request
    // time for staff status; createdAt orders the next queued attempt.
    ...(job.startedAt ? { requestedAt: job.requestedAt ?? job.createdAt, createdAt: new Date(now).toISOString() } : {}),
    localLeaseToken: null, localLeaseUntil: 0, localStage: null, localProcessedSeconds: null,
    leaseOwner: null, leaseUntil: 0, errorCode: null, fallbackReason: null }, now));
  return true;
}
module.exports = { LOCAL_OUTSTANDING_LIMIT, readLocalQueue, reserveLocalQueue, releaseLocalQueue, requeueLocalFallback };
