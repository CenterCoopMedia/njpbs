"use strict";

// SDK names and codes are untrusted too. Keep only known diagnostic categories;
// messages, stacks and other provider fields can contain request content.
const ERROR_TYPES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "AggregateError", "FirebaseError", "PublicDeploymentFenceError",
]);
const ERROR_CODES = new Set([
  "cancelled", "unknown", "invalid-argument", "deadline-exceeded", "not-found",
  "already-exists", "permission-denied", "resource-exhausted", "failed-precondition",
  "aborted", "out-of-range", "unimplemented", "internal", "unavailable", "data-loss",
  "unauthenticated", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND",
]);

// These local refusal messages contain no request or provider data. Match the
// complete text so an unexpected failed-precondition cannot expose its details.
const UNAVAILABLE_MESSAGES = new Set([
  "The CMS publication runtime control is invalid",
  "Cloud publication requires its runtime control",
  "Cloud publication is paused or owned by another release",
  "The CMS publication runtime control snapshot is invalid",
  "Firestore is required for CMS publication runtime control",
  "A Firestore transaction is required for CMS publication runtime control",
  "CMS publication is paused for a serializer handoff",
  "Another CMS publication serializer owns this runtime",
  "The active Post renderer changed. Try this removal again shortly.",
  "Media lifecycle changes are temporarily unavailable.",
  "Media admission reconciliation exceeds 5,000 active records",
  "Media admission count needs reconciliation",
  "The media store credentials are not configured.",
  "The media store is not configured.",
]);

function curatedLifecycleFailureMessage(error, status) {
  return status === 503 && UNAVAILABLE_MESSAGES.has(error?.message) ? error.message : null;
}

function lifecycleErrorDiagnostic(error) {
  return {
    errorType: ERROR_TYPES.has(error?.name) ? error.name : "unknown",
    errorCode: ERROR_CODES.has(error?.code) ||
      (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16)
      ? error.code : null,
  };
}

module.exports = { curatedLifecycleFailureMessage, lifecycleErrorDiagnostic };
