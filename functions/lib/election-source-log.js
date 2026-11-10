"use strict";
const CODES = new Set(["aborted", "already-exists", "cancelled", "deadline-exceeded", "failed-precondition", "internal",
  "invalid-argument", "not-found", "out-of-range", "permission-denied", "resource-exhausted", "unauthenticated", "unavailable", "unimplemented", "unknown"]);
/** Log only fixed error categories, never provider errors, messages or headers. */
function logUnexpected(error, stage) {
  const code = Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16 ? error.code
    : CODES.has(error?.code) ? error.code : "unknown";
  const type = ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "FirebaseError"].includes(error?.name)
    ? error.name : "Error";
  console.error("Election source operation failed", { stage, code, type });
}
module.exports = { logUnexpected };
