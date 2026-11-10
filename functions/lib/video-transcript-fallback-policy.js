"use strict";

const PAID_FALLBACK_POLICY = "local-elevenlabs-amazon-v1";
const REQUESTER_DAILY_AUDIO_SECONDS = 3600;

// A failed request is not necessarily an unsubmitted request. Only these
// terminal receipts establish a safe boundary for another paid provider.
function paidFallbackDecision(job) {
  if (!job || job.provider !== "elevenlabs") return "reconcile";
  if (job.active === true) return "wait";
  if (job.active !== false) return "reconcile";
  if (job.phase === "ready") return "ready";
  if (job.phase !== "failed") return "reconcile";
  // The current adapter classifies every non-success HTTP response as uncertain.
  // This receipt is usable only if a future adapter proves a rejection explicitly.
  if (job.errorCode === "elevenlabs_request_rejected") return "amazon";
  if (!job.submissionIntentAt && job.budgetReservation?.state === "released" &&
      job.errorCode === "byok_preparation_failed") return "amazon";
  // Admission failures can mean revoked access or stopped billing. Sending
  // the same media to another provider would bypass those controls.
  return "reconcile";
}

module.exports = { PAID_FALLBACK_POLICY, REQUESTER_DAILY_AUDIO_SECONDS, paidFallbackDecision };
