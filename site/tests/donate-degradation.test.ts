// Pins the donate handoff's degradation policy (#189): the CTA routes to the PBS
// form only when it is reachable, every outage degrades to an honest unavailable
// state that never re-links the failing host, and a 403 lapse is never retried. No
// network, no DOM, no clock.

import { describe, it, expect } from "vitest";

import {
  resolveDonateCta,
  DONATE_UNAVAILABLE_NOTICE,
  DONATE_LAPSED_NOTICE,
  type DonatePortalSignal,
  type DonatePortalFailure,
} from "../src/lib/donate-degradation";

const FAILURES: DonatePortalFailure[] = [
  "timeout",
  "forbidden",
  "rateLimited",
  "error",
];
const TRANSIENT: DonatePortalFailure[] = ["timeout", "rateLimited", "error"];

// The phrase a notice uses only when it is honest to invite a retry. The 403 lapse
// notice must never carry it, since a forbidden does not self-heal.
const RETRY_TAIL = "try again shortly";

// Every signal the policy accepts, enumerated once so the exhaustive invariants
// below cannot silently miss a branch.
const ALL_SIGNALS: DonatePortalSignal[] = [
  { kind: "reachable" },
  ...FAILURES.map((status): DonatePortalSignal => ({ kind: "outage", status })),
];

describe("donate handoff degradation policy (issue #189)", () => {
  it("a reachable donation form routes the CTA to PBS, with nothing to retry", () => {
    const result = resolveDonateCta({ kind: "reachable" });
    expect(result.render).toEqual({ mode: "donate" });
    expect(result.retryable).toBe(false);
  });

  it("every outage degrades to the unavailable state and never re-links the failing host", () => {
    for (const status of FAILURES) {
      const { render } = resolveDonateCta({ kind: "outage", status });
      // The whole point of the fallback: an outage must not render the `donate`
      // mode, which is the mode the caller wires to the unreachable donateUrl.
      expect(render.mode).toBe("unavailable");
    }
  });

  it("a transient outage is retryable and its notice invites a retry", () => {
    for (const status of TRANSIENT) {
      const result = resolveDonateCta({ kind: "outage", status });
      expect(result.retryable).toBe(true);
      expect(result.render).toEqual({
        mode: "unavailable",
        notice: DONATE_UNAVAILABLE_NOTICE,
      });
      expect(DONATE_UNAVAILABLE_NOTICE).toContain(RETRY_TAIL);
    }
  });

  it("a 403 lapse is not retryable and its notice does not invite a futile retry", () => {
    const result = resolveDonateCta({ kind: "outage", status: "forbidden" });
    expect(result.retryable).toBe(false);
    expect(result.render).toEqual({
      mode: "unavailable",
      notice: DONATE_LAPSED_NOTICE,
    });
    // The bug this guards against: a notice that promises a retry while retryable is
    // false. The lapse copy must not carry the transient tail.
    expect(DONATE_LAPSED_NOTICE).not.toContain(RETRY_TAIL);
  });

  it("a notice invites a retry if and only if the result is retryable", () => {
    // The gate policy's marquee invariant, mirrored here: pin the iff across every
    // signal so the copy can never promise a retry the policy refuses, nor withhold
    // one it allows. The two tests above check each half; this ties them as one.
    for (const signal of ALL_SIGNALS) {
      const { render, retryable } = resolveDonateCta(signal);
      if (render.mode === "donate") {
        expect(retryable).toBe(false); // routing to the form has no notice, nothing to retry
        continue;
      }
      expect(render.notice.includes(RETRY_TAIL)).toBe(retryable);
    }
  });

  it("every unavailable notice keeps a CCM-controlled way to reach the station in front of the donor", () => {
    for (const status of FAILURES) {
      const { render } = resolveDonateCta({ kind: "outage", status });
      if (render.mode !== "unavailable")
        throw new Error("expected unavailable");
      // Honest, never a dead end: the copy points at contacting NJ PBS, the PBS-free
      // reach path, not back at the failing PBS form.
      expect(render.notice).toContain("Contact NJ PBS");
    }
  });

  it("is total and pure over every signal: a render for each, and the input is untouched", () => {
    for (const signal of ALL_SIGNALS) {
      const snapshot = JSON.stringify(signal);
      const result = resolveDonateCta(signal);
      expect(
        result.render.mode === "donate" || result.render.mode === "unavailable",
      ).toBe(true);
      // retryable is true only for a transient outage.
      const expectRetry =
        signal.kind === "outage" && signal.status !== "forbidden";
      expect(result.retryable).toBe(expectRetry);
      expect(JSON.stringify(signal)).toBe(snapshot);
    }
  });
});
