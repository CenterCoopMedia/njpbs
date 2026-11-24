"use strict";

const { platformLimit } = require("./release-wait");

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
  if (family === "background" && attempts >= 4) return "exhaust";
  return "claim";
}

// Readers of these rows know attempts 0 to 4, and 4 as the end. A row that is
// still waiting stays below 4; the run journal holds the real read counts.
const TERMINAL = 4;

// Only a killed process leaves a claim behind, and it cannot outlive the
// platform limit. The claim ID, not this time, fences every later write.
function publicationClaim(row, claim, now, takeoverMs = undefined) {
  if (takeoverMs !== undefined) return { claim, attempts: (row.attempts ?? 0) + 1, nextAttemptAt: now + takeoverMs };
  return { claim, attempts: Math.min((row.attempts ?? 0) + 1, TERMINAL - 1),
    nextAttemptAt: now + platformLimit("cloudFunctionsScheduleSeconds") * 1_000 };
}

// The public route, or the purge it needs, answered and refused. Any other
// error is a state that has not arrived yet, so the publication keeps waiting.
const REFUSED = ["public_receipt_refused", "public_bytes_refused", "public_purge_refused"];
const publicAnswerRefused = error => REFUSED.includes(error?.code);

function publicationFailure(row, family, now, error = undefined) {
  if (family === "background") {
    const exhausted = row.attempts >= 4;
    return { status: "failed", claim: null, nextAttemptAt: exhausted ? null : now + 60_000 * 2 ** (row.attempts - 1),
      error: families[family].error };
  }
  const refused = publicAnswerRefused(error);
  return { status: refused || family === "postProof" ? "failed" : "pending", claim: null,
    ...(refused ? { attempts: TERMINAL } : {}),
    // The next minute wake reads again. This write must not wake itself.
    nextAttemptAt: refused ? null : now + 60_000, error: families[family].error };
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

module.exports = { publicAnswerRefused, publicationAttempt, publicationClaim, publicationFailure, publicationRetry,
  SLOW_RETRY_MS, FAILURE_CLASSES, backgroundFailure, slowBackgroundRetryDue, expiredBackgroundClaim };
