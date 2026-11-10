"use strict";

import { it as test } from "vitest";
import assert from "node:assert/strict";
import policy from "../../functions/lib/video-transcript-fallback-policy.js";
const { paidFallbackDecision } = policy;
const terminal = (fields) => ({ provider: "elevenlabs", active: false, ...fields });

test("a live paid request cannot start a second provider", () => {
  for (const phase of ["pending", "running", "ready", "failed"]) {
    assert.equal(paidFallbackDecision({ provider: "elevenlabs", active: true, phase }), "wait");
  }
});

test("successful paid work is reused", () => {
  assert.equal(paidFallbackDecision(terminal({ phase: "ready" })), "ready");
});

test("unknown acceptance and authorization failures require reconciliation", () => {
  for (const errorCode of ["elevenlabs_submission_uncertain", "byok_admission_invalid", "unknown_error"]) {
    for (const phase of ["failed", "needs_reconciliation"]) {
      assert.equal(paidFallbackDecision(terminal({ phase, errorCode })), "reconcile");
    }
  }
  assert.equal(paidFallbackDecision(null), "reconcile");
  assert.equal(paidFallbackDecision({ provider: "elevenlabs", phase: "ready" }), "reconcile");
  assert.equal(paidFallbackDecision({ provider: "local", phase: "failed" }), "reconcile");
});

test("a definitive provider rejection can reach the final fallback", () => {
  assert.equal(paidFallbackDecision(terminal({ phase: "failed", errorCode: "elevenlabs_request_rejected",
    submissionIntentAt: "2026-09-22T19:00:00Z" })), "amazon");
});

test("preparation failure needs both no submission intent and released reservation", () => {
  const failed = terminal({ phase: "failed", errorCode: "byok_preparation_failed", budgetReservation: { state: "released" } });
  assert.equal(paidFallbackDecision(failed), "amazon");
  assert.equal(paidFallbackDecision({ ...failed, submissionIntentAt: "2026-09-22T19:00:00Z" }), "reconcile");
  for (const state of ["reserved", "consumed", undefined]) {
    assert.equal(paidFallbackDecision({ ...failed, budgetReservation: { state } }), "reconcile");
  }
});
