"use strict";

const { platformLimit } = require("./release-wait");

const FAILURE_CLASSES = ["timeout", "storage_readback", "lease_lost", "context_changed", "validation"];
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

/** What a refused public answer said about its own origin. */
function publicAnswerOrigin({ status, headers }) {
  return { rendererSha: headers.get("x-njpbs-renderer-sha"), contextDigest: headers.get("x-njpbs-context-sha256"),
    unmarkedGone: status === 410 && !headers.has("x-njpbs-withdrawal-revision") };
}

/** A wrong receipt is final only from the current renderer and context. An
 * answer from another renderer or context, or a 410 without the durable
 * withdrawal marker, means the current answer has not arrived. */
function publicAnswerRefused(error, current = undefined) {
  if (!REFUSED.includes(error?.code)) return false;
  const { rendererSha = null, contextDigest = null, unmarkedGone = false } = error.origin ?? {};
  if (rendererSha === null && contextDigest === null) return !unmarkedGone;
  return current !== undefined && rendererSha === current.rendererSha && contextDigest === current.contextDigest;
}

function publicationFailure(row, family, now, error = undefined, current = undefined) {
  if (family === "background") {
    // The same invalid input fails again, so its failure is final and the last
    // good output stays. A moved context is superseded: the next pass makes a
    // task for the current one. Any other failure never runs out of attempts;
    // its pause doubles from one minute and stays at 30 minutes.
    if (error?.retryable === false) return { status: error.failureClass === "context_changed" ? "superseded" : "failed",
      claim: null, nextAttemptAt: null, error: families[family].error };
    const pause = Math.min(60_000 * 2 ** Math.max(0, row.attempts - 1), 30 * 60_000);
    return { status: "failed", claim: null, nextAttemptAt: now + pause, error: families[family].error };
  }
  const refused = publicAnswerRefused(error, current);
  return { status: refused || family === "postProof" ? "failed" : "pending", claim: null,
    ...(refused ? { attempts: TERMINAL } : {}),
    // The next minute wake reads again. This write must not wake itself.
    nextAttemptAt: refused ? null : now + 60_000, error: families[family].error };
}

function publicationRetry(row, family) {
  const contract = families[family];
  return row?.[contract.field] === contract.owner && row.status === "failed" && row.claim == null;
}

// Only a contract refusal of the frozen input is certain to repeat. A transport
// fault, a permission an operator can restore and an unknown error can clear.
function backgroundFailure(error, signal, stage) {
  if (signal?.aborted || error?.name === "TimeoutError" || error?.code === "ETIMEDOUT") {
    return { failureClass: "timeout", retryable: true };
  }
  const failureClass = stage === "storage" ? "storage_readback" : "validation";
  return { failureClass, retryable: error?.code !== "background_contract_refused" };
}

// A failed, unclaimed background row is due at its next attempt, whatever its
// attempt count. A row the removed four-attempt cap stopped has no next
// attempt; it resumes at its slowRetryAt when it has one.
function slowBackgroundRetryDue(task, time) {
  if (task?.status !== "failed" || task.claim != null) return false;
  const due = task.nextAttemptAt ?? task.slowRetryAt;
  return Number.isFinite(due) && due <= time;
}

function expiredBackgroundClaim(task, time) {
  return ["pending", "failed"].includes(task?.status) && typeof task.claim === "string" &&
    Number.isFinite(task.nextAttemptAt) && task.nextAttemptAt <= time;
}

module.exports = { publicAnswerOrigin, publicAnswerRefused, publicationAttempt, publicationClaim, publicationFailure, publicationRetry,
  FAILURE_CLASSES, backgroundFailure, slowBackgroundRetryDue, expiredBackgroundClaim };
