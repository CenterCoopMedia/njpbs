"use strict";

const { createHash } = require("node:crypto");
const { REQUESTER_DAILY_AUDIO_SECONDS } = require("./video-transcript-fallback-policy");
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const LIMITS = {
  requester: { submissions: 5, audioSeconds: REQUESTER_DAILY_AUDIO_SECONDS, outstanding: 1 },
  global: { submissions: 20, audioSeconds: 14400 },
};

function budgetRefs(firestore, uid, day) {
  const collection = firestore.collection("mediaTranscriptionBudgets");
  return {
    requester: collection.doc(`user-${hash(uid)}-${day}`),
    global: collection.doc(`global-${day}`),
    slot: collection.doc(`slot-${hash(uid)}`),
  };
}
function counters(record = {}) {
  const result = {};
  for (const field of [
    "reservedSubmissions",
    "reservedAudioSeconds",
    "consumedSubmissions",
    "consumedAudioSeconds",
  ]) {
    result[field] = record[field] ?? 0;
    if (!Number.isSafeInteger(result[field]) || result[field] < 0)
      throw fail(503, "Transcript budget is unavailable");
  }
  return result;
}
function budgetView(record, limits) {
  const value = counters(record);
  return {
    ...value,
    remainingSubmissions: Math.max(
      0,
      limits.submissions -
        value.reservedSubmissions -
        value.consumedSubmissions,
    ),
    remainingAudioSeconds: Math.max(
      0,
      limits.audioSeconds -
        value.reservedAudioSeconds -
        value.consumedAudioSeconds,
    ),
  };
}

// Amazon reserves conservatively as consumed before any external work. An
// uncertain start cannot release money for another provider or another job.
async function admitAmazon({ tx, firestore, job, now }) {
  if (job.amazonBudgetReservation) return job.amazonBudgetReservation;
  // Pre-existing start intents can only poll or reconcile. Do not strand an
  // already submitted job when today's allowance is used or the day changes.
  if (job.startIntentAt && ["starting", "running"].includes(job.phase)) return { legacy: true };
  const day = new Date(now).toISOString().slice(0, 10);
  const refs = budgetRefs(firestore, job.requestedBy, day);
  const [billing, personal, global, slot] = await Promise.all([
    tx.get(firestore.doc("system/billing")), tx.get(refs.requester), tx.get(refs.global), tx.get(refs.slot),
  ]);
  if (billing.data()?.disabled === true) return { blocked: "billing_unavailable" };
  const heldId = slot.data()?.jobId;
  const held = heldId ? await tx.get(firestore.collection("mediaSourceTranscriptJobs").doc(heldId)) : null;
  if (heldId && (!held.exists || held.data().active === true)) return null;
  const seconds = Math.ceil(job.durationSeconds);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const records = [[refs.requester, personal.data(), LIMITS.requester], [refs.global, global.data(), LIMITS.global]];
  for (const [, record, limits] of records) {
    const view = budgetView(record, limits);
    if (view.remainingSubmissions < 1 || view.remainingAudioSeconds < seconds) return null;
  }
  for (const [ref, record] of records) {
    const value = counters(record);
    tx.set(ref, { ...value, consumedSubmissions: value.consumedSubmissions + 1,
      consumedAudioSeconds: value.consumedAudioSeconds + seconds });
  }
  tx.set(refs.slot, { jobId: job.id });
  return { day, audioSeconds: seconds };
}
module.exports = { LIMITS, budgetRefs, counters, budgetView, admitAmazon };
