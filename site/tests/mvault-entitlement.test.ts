import { describe, it, expect } from "vitest";
import {
  evaluateEntitlement,
  identityMismatch,
  passportResetOffered,
  type MVaultMembership,
} from "../src/lib/mvault-entitlement";

// These prove the credential-free entitlement policy for live MVault Passport
// checks (#208): entitled only when MVault says On with a benefit offer inside
// the active or grace window, fail-closed on everything else, MVault's own
// `timing` verdict authoritative when present, and the email-mismatch signal
// that offers the Passport Reset path. Design:
// docs/research/mvault-entitlement-core.md.

const NOW = Date.parse("2026-07-09T18:00:00Z");

const member = (over: Partial<MVaultMembership> = {}): MVaultMembership => ({
  status: "on",
  offer: "sustainer",
  expireDate: "2027-01-01",
  ...over,
});

describe("evaluateEntitlement — the acceptance criteria", () => {
  it("grants an active member (On, offer, within the window)", () => {
    expect(evaluateEntitlement(member(), NOW)).toEqual({
      entitled: true,
      state: "active",
    });
  });

  it("denies an expired-past-grace member even though the block is present", () => {
    const m = member({ expireDate: "2026-01-01", graceThrough: "2026-04-01" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "expired",
    });
  });

  it("keeps an in-grace member streaming (past expiry, before grace end)", () => {
    const m = member({ expireDate: "2026-06-01", graceThrough: "2026-09-01" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: true,
      state: "grace",
    });
  });

  it("treats a non-activated visitor (status Off, offer null) as a non-member", () => {
    const m = member({ status: "off", offer: null });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "inactive",
    });
  });
});

describe("evaluateEntitlement — status and offer gates", () => {
  it("requires On, not merely a present block (On with no offer is inactive)", () => {
    expect(evaluateEntitlement(member({ offer: undefined }), NOW)).toEqual({
      entitled: false,
      state: "inactive",
    });
    expect(evaluateEntitlement(member({ offer: "  " }), NOW)).toEqual({
      entitled: false,
      state: "inactive",
    });
  });

  it("denies a provisional (not-yet-activated) record regardless of dates", () => {
    const m = member({ provisional: true });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "inactive",
    });
  });

  it("normalizes status case and whitespace", () => {
    expect(evaluateEntitlement(member({ status: "On" }), NOW).entitled).toBe(true);
    expect(evaluateEntitlement(member({ status: " on " }), NOW).entitled).toBe(true);
    expect(evaluateEntitlement(member({ status: "OFF" }), NOW).state).toBe(
      "inactive",
    );
  });
});

describe("evaluateEntitlement — MVault timing is authoritative when present", () => {
  it("streams on within_start_expire_dates even with no dates", () => {
    const m: MVaultMembership = {
      status: "on",
      offer: "sustainer",
      timing: "within_start_expire_dates",
    };
    expect(evaluateEntitlement(m, NOW)).toEqual({ entitled: true, state: "active" });
  });

  it("streams on within_grace_period even with no dates", () => {
    const m: MVaultMembership = {
      status: "on",
      offer: "sustainer",
      timing: "within_grace_period",
    };
    expect(evaluateEntitlement(m, NOW)).toEqual({ entitled: true, state: "grace" });
  });

  it("denies on timing=expired even if a stale future expireDate is present", () => {
    const m = member({ timing: "expired", expireDate: "2999-01-01" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "expired",
    });
  });

  it("denies on timing=before_start as a not-yet-active non-member", () => {
    const m = member({ timing: "before_start" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "inactive",
    });
  });

  it("falls back to date math on an unrecognized timing string", () => {
    // A future MVault timing value must not be trusted as a grant; the dates decide.
    const m = { ...member(), timing: "surprise" as unknown as undefined };
    expect(evaluateEntitlement(m, NOW)).toEqual({ entitled: true, state: "active" });
  });
});

describe("evaluateEntitlement — start-date gate (date fallback)", () => {
  it("denies a not-yet-active membership even inside its expire window", () => {
    // start tomorrow, expire next year, no timing: must not grant early.
    const m = member({ startDate: "2026-07-10", expireDate: "2027-07-10" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "inactive",
    });
  });

  it("grants once the start date has passed and the window is open", () => {
    const m = member({ startDate: "2026-01-01", expireDate: "2027-01-01" });
    expect(evaluateEntitlement(m, NOW)).toEqual({ entitled: true, state: "active" });
  });

  it("fails closed on a present-but-unreadable start date", () => {
    const m = member({ startDate: "not-a-date" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "malformed",
    });
  });
});

describe("evaluateEntitlement — date-only windows are inclusive days", () => {
  // MVault's date fields name whole days, not instants. A member must keep
  // streaming through the end of their expiry (and grace) day, not be cut off at
  // that day's first instant. NOW is 2026-07-09T18:00Z — mid-day on the boundary.
  it("keeps a member whose expiry is today active through the whole day", () => {
    const m = member({ expireDate: "2026-07-09" });
    expect(evaluateEntitlement(m, NOW)).toEqual({ entitled: true, state: "active" });
  });

  it("keeps a member in grace through the end of the graceThrough day", () => {
    const m = member({ expireDate: "2026-07-08", graceThrough: "2026-07-09" });
    expect(evaluateEntitlement(m, NOW)).toEqual({ entitled: true, state: "grace" });
  });

  it("activates a membership on its start day from that day's start", () => {
    const m = member({ startDate: "2026-07-09", expireDate: "2027-01-01" });
    expect(evaluateEntitlement(m, NOW)).toEqual({ entitled: true, state: "active" });
  });

  it("expires the day after the grace day ends", () => {
    // grace through 2026-07-08: by mid-day 2026-07-09 the whole grace day is past.
    const m = member({ expireDate: "2026-06-01", graceThrough: "2026-07-08" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "expired",
    });
  });
});

describe("evaluateEntitlement — boundaries are New Jersey calendar days", () => {
  // MVault dates are NJ calendar dates. The window must turn over at Eastern
  // midnight, not UTC midnight, or an NJ member loses ~4-5 hours on their boundary
  // day. These times straddle the ET/UTC day boundary to prove it.
  it("keeps a member active late on their Eastern expiry day (03:00Z next day is still 11pm ET)", () => {
    // 2026-07-10T03:00Z is 2026-07-09 23:00 in NJ — still the expiry day.
    const at = Date.parse("2026-07-10T03:00:00Z");
    const m = member({ expireDate: "2026-07-09" });
    expect(evaluateEntitlement(m, at)).toEqual({ entitled: true, state: "active" });
  });

  it("expires once the Eastern day rolls over (05:00Z next day is 1am ET)", () => {
    // 2026-07-10T05:00Z is 2026-07-10 01:00 in NJ — past the expiry day.
    const at = Date.parse("2026-07-10T05:00:00Z");
    const m = member({ expireDate: "2026-07-09" });
    expect(evaluateEntitlement(m, at)).toEqual({
      entitled: false,
      state: "expired",
    });
  });

  it("does not grant a future start early on Eastern time (still the prior NJ day)", () => {
    // 2026-07-10T03:00Z is 2026-07-09 23:00 in NJ — before the start day.
    const at = Date.parse("2026-07-10T03:00:00Z");
    const m = member({ startDate: "2026-07-10", expireDate: "2027-07-10" });
    expect(evaluateEntitlement(m, at)).toEqual({
      entitled: false,
      state: "inactive",
    });
  });
});

describe("evaluateEntitlement — fail closed", () => {
  it("denies on a non-finite clock", () => {
    expect(evaluateEntitlement(member(), Infinity)).toEqual({
      entitled: false,
      state: "malformed",
    });
    expect(evaluateEntitlement(member(), NaN)).toEqual({
      entitled: false,
      state: "malformed",
    });
  });

  it("denies On+offer with an unreadable expiry and no timing", () => {
    const m = member({ expireDate: "not-a-date" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "malformed",
    });
  });

  it("denies On+offer with no expiry, no grace, no timing", () => {
    const m = member({ expireDate: undefined });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "malformed",
    });
  });

  it("rejects an out-of-range calendar expiry (Feb 31 rolls over)", () => {
    expect(evaluateEntitlement(member({ expireDate: "2026-02-31" }), NOW)).toEqual({
      entitled: false,
      state: "malformed",
    });
  });

  it("rejects Feb 29 in a non-leap year", () => {
    expect(evaluateEntitlement(member({ expireDate: "2026-02-29" }), NOW)).toEqual({
      entitled: false,
      state: "malformed",
    });
  });

  it("accepts a real leap day (Feb 29 in a leap year)", () => {
    // 2028 is a leap year; a valid future expiry still grants.
    expect(evaluateEntitlement(member({ expireDate: "2028-02-29" }), NOW).entitled).toBe(
      true,
    );
  });

  it("rejects a datetime string — the date fields are date-only", () => {
    const m = member({ expireDate: "2027-01-01T00:00:00Z" });
    expect(evaluateEntitlement(m, NOW)).toEqual({
      entitled: false,
      state: "malformed",
    });
  });
});

describe("identityMismatch", () => {
  it("flags a real sign-in vs contact email mismatch", () => {
    expect(identityMismatch("user-b8bcff3d2d@example.org", "donor@work.org")).toBe(true);
  });

  it("ignores case and whitespace when the emails match", () => {
    expect(identityMismatch(" User-b8bcff3d2d@example.org ", "user-b8bcff3d2d@example.org")).toBe(false);
  });

  it("cannot assert a mismatch when either email is missing", () => {
    expect(identityMismatch(undefined, "donor@work.org")).toBe(false);
    expect(identityMismatch("user-b8bcff3d2d@example.org", "")).toBe(false);
    expect(identityMismatch(null, null)).toBe(false);
  });
});

describe("passportResetOffered", () => {
  const denied = { entitled: false, state: "inactive" } as const;
  const granted = { entitled: true, state: "active" } as const;

  it("offers the reset when a denied member's emails differ", () => {
    expect(passportResetOffered(denied, "user-b8bcff3d2d@example.org", "donor@work.org")).toBe(
      true,
    );
  });

  it("never offers a reset to an entitled member", () => {
    expect(passportResetOffered(granted, "user-b8bcff3d2d@example.org", "donor@work.org")).toBe(
      false,
    );
  });

  it("does not offer a reset when the denial is not an email mismatch", () => {
    expect(passportResetOffered(denied, "user-b8bcff3d2d@example.org", "user-b8bcff3d2d@example.org")).toBe(
      false,
    );
  });
});
