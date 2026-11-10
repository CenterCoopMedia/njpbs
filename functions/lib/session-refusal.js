"use strict";

const refusedRequests = new WeakMap();
const forwardedFrom = new WeakMap();
const SESSION_EXPIRED_CODE = "session_expired";

// Firebase refresh tokens have no end date. Measured from auth_time, so a token refresh does not
// extend a session. firestore.rules and cms-api/src/firebase-auth.ts hold the same limit.
const MAX_SESSION_AGE_SECONDS = 60 * 24 * 60 * 60;

function sessionOutlivedMaximum(authTime, nowMs = Date.now()) {
  return Number.isFinite(authTime) && nowMs / 1000 - authTime >= MAX_SESSION_AGE_SECONDS;
}

// A request copy handed to an inner handler. Its refusal also marks the request that the outer
// edge wrapper holds.
function linkForwardedRequest(forwarded, original) {
  forwardedFrom.set(forwarded, original);
}

function markSessionRefused(req, reason) {
  const value = reason === "token_expired" ? reason : undefined;
  for (let target = req; target; target = forwardedFrom.get(target)) refusedRequests.set(target, value);
}

function sessionWasRefused(req) {
  return refusedRequests.has(req);
}

function sessionRefusalReason(req) {
  return refusedRequests.get(req);
}

// For a handler that serializes a verifier error itself. Only the typed refusal's reason leaves.
function sessionRefusalFields(error) {
  return error?.status === 401 && error.code === SESSION_EXPIRED_CODE && error.reason === "token_expired"
    ? { reason: error.reason } : {};
}

module.exports = {
  MAX_SESSION_AGE_SECONDS,
  SESSION_EXPIRED_CODE,
  linkForwardedRequest,
  markSessionRefused,
  sessionOutlivedMaximum,
  sessionWasRefused,
  sessionRefusalFields,
  sessionRefusalReason,
};
