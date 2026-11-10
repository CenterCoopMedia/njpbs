"use strict";

const SLOW_RETRY_MS = 10 * 60_000;
const FAILURE_CLASSES = ["timeout", "storage_readback", "lease_lost", "context_changed", "validation"];
const TRANSIENT_STORAGE_CODES = new Set([4, 8, 10, 13, 14, 408, 429, 500, 502, 503, 504,
  "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"]);
const families = {
  post: { field: "transport", owner: "post-no-build-v1", error: "Public Post confirmation is unavailable" },
  page: { field: "transport", owner: "page-no-build-v1", error: "Public Page confirmation is unavailable" },
  home: { field: "owner", owner: "page-no-build-v1", error: "Public Home refresh confirmation is unavailable" },
  postProof: { error: "Public Post check is unavailable" },
  background: { error: "background_generation_failed" },
};

// Each original queue/child owns its counters and claim. This policy only
// decides its next attempt; source, runtime and public proof stay with its owner.
function publicationAttempt(row, family, now) {
  const contract = families[family];
  if (!["pending", "failed"].includes(row?.status) ||
      contract.field && row[contract.field] !== contract.owner) return null;
  if (family === "background" && slowBackgroundRetryDue(row, now)) return "claim";
  const pristine = family === "home" && row.status === "pending" && row.attempts === undefined &&
    row.nextAttemptAt === undefined && row.claim == null;
  const attempts = pristine ? 0 : row.attempts, due = pristine ? 0 : row.nextAttemptAt;
  if (!Number.isFinite(due) || due > now) return null;
  if (family !== "background" && (!Number.isSafeInteger(attempts) || attempts < 0 ||
      family !== "postProof" && row.claim != null && (typeof row.claim !== "string" || !row.claim))) return null;
  if (attempts >= 4) return family === "background" ||
    attempts === 4 && (family === "postProof" ? row.status === "pending" : row.claim) ? "exhaust" : null;
  return "claim";
}

function publicationClaim(row, claim, now, leaseMs = 60_000) {
  return { claim, attempts: (row.attempts ?? 0) + 1, nextAttemptAt: now + leaseMs };
}

function publicationFailure(row, family, now) {
  const exhausted = row.attempts >= 4;
  return { status: exhausted || ["background", "postProof"].includes(family) ? "failed" : "pending", claim: null,
    nextAttemptAt: exhausted ? null : now + 60_000 * 2 ** (row.attempts - 1), error: families[family].error };
}

function publicationRetry(row, family) {
  const contract = families[family];
  return row?.[contract.field] === contract.owner && row.status === "failed" && row.claim == null;
}

function backgroundFailure(error, signal, stage) {
  if (signal?.aborted || error?.name === "TimeoutError" || error?.code === "ETIMEDOUT") {
    return { failureClass: "timeout", retryable: true };
  }
  if (stage === "storage") return { failureClass: "storage_readback", retryable: TRANSIENT_STORAGE_CODES.has(error?.code) };
  return { failureClass: "validation", retryable: false };
}

function slowBackgroundRetryDue(task, time) {
  return task?.status === "failed" && Number.isSafeInteger(task.attempts) && task.attempts >= 4 &&
    task.nextAttemptAt === null && task.lastAttempt?.retryable === true &&
    ["timeout", "storage_readback", "lease_lost"].includes(task.lastAttempt.failureClass) &&
    Number.isFinite(task.slowRetryAt) && task.slowRetryAt <= time;
}

function expiredBackgroundClaim(task, time) {
  return ["pending", "failed"].includes(task?.status) && typeof task.claim === "string" &&
    Number.isFinite(task.nextAttemptAt) && task.nextAttemptAt <= time;
}

module.exports = { publicationAttempt, publicationClaim, publicationFailure, publicationRetry,
  SLOW_RETRY_MS, FAILURE_CLASSES, backgroundFailure, slowBackgroundRetryDue, expiredBackgroundClaim };
