import { describe, expect, it } from "vitest";

import functionsEntitlement from "../../functions/lib/pbs/mvault-entitlement.js";
import { evaluateEntitlement as evaluateSiteEntitlement, identityMismatch as siteIdentityMismatch, passportResetOffered as sitePassportResetOffered, type Entitlement, type MVaultMembership } from "../../site/src/lib/mvault-entitlement";

const {
  evaluateEntitlement: evaluateFunctionsEntitlement,
  identityMismatch: functionsIdentityMismatch,
  passportResetOffered: functionsPassportResetOffered,
} = functionsEntitlement;

const NOW = Date.parse("2026-07-09T18:00:00Z");
const LATE_ON_EXPIRY_DAY_ET = Date.parse("2026-07-10T03:00:00Z");
const AFTER_EXPIRY_DAY_ET = Date.parse("2026-07-10T05:00:00Z");

function member(overrides: Partial<MVaultMembership> = {}): MVaultMembership {
  return {
    status: "on",
    offer: "sustainer",
    expireDate: "2027-01-01",
    ...overrides,
  };
}

const evaluationFixtures: Array<{
  name: string;
  membership: MVaultMembership;
  now: number;
  expected: Entitlement;
}> = [
  {
    name: "active timing wins over an expired date",
    membership: member({
      timing: "within_start_expire_dates",
      expireDate: "2020-01-01",
    }),
    now: NOW,
    expected: { entitled: true, state: "active" },
  },
  {
    name: "grace timing grants without fallback dates",
    membership: member({
      timing: "within_grace_period",
      expireDate: undefined,
    }),
    now: NOW,
    expected: { entitled: true, state: "grace" },
  },
  {
    name: "expired timing wins over a future date",
    membership: member({ timing: "expired", expireDate: "2999-01-01" }),
    now: NOW,
    expected: { entitled: false, state: "expired" },
  },
  {
    name: "before-start timing wins over an open date window",
    membership: member({
      timing: "before_start",
      startDate: "2020-01-01",
      expireDate: "2999-01-01",
    }),
    now: NOW,
    expected: { entitled: false, state: "inactive" },
  },
  {
    name: "inactive status wins over active timing",
    membership: member({ status: "off", timing: "within_start_expire_dates" }),
    now: NOW,
    expected: { entitled: false, state: "inactive" },
  },
  {
    name: "a provisional record cannot grant",
    membership: member({ provisional: true, timing: "within_start_expire_dates" }),
    now: NOW,
    expected: { entitled: false, state: "inactive" },
  },
  {
    name: "a record without an offer cannot grant",
    membership: member({ offer: null, timing: "within_start_expire_dates" }),
    now: NOW,
    expected: { entitled: false, state: "inactive" },
  },
  {
    name: "a future start date denies before the window",
    membership: member({ startDate: "2026-07-10" }),
    now: NOW,
    expected: { entitled: false, state: "inactive" },
  },
  {
    name: "fallback dates grant inside the grace window",
    membership: member({
      expireDate: "2026-06-01",
      graceThrough: "2026-09-01",
    }),
    now: NOW,
    expected: { entitled: true, state: "grace" },
  },
  {
    name: "the Eastern expiry day stays active after UTC midnight",
    membership: member({ expireDate: "2026-07-09" }),
    now: LATE_ON_EXPIRY_DAY_ET,
    expected: { entitled: true, state: "active" },
  },
  {
    name: "the window expires after the Eastern day changes",
    membership: member({ expireDate: "2026-07-09" }),
    now: AFTER_EXPIRY_DAY_ET,
    expected: { entitled: false, state: "expired" },
  },
  {
    name: "an invalid expiry fails closed",
    membership: member({ expireDate: "2026-02-31" }),
    now: NOW,
    expected: { entitled: false, state: "malformed" },
  },
  {
    name: "an invalid start date fails closed",
    membership: member({ startDate: "not-a-date" }),
    now: NOW,
    expected: { entitled: false, state: "malformed" },
  },
  {
    name: "a non-finite clock fails closed",
    membership: member(),
    now: Number.NaN,
    expected: { entitled: false, state: "malformed" },
  },
];

const identityFixtures: Array<{
  name: string;
  signInEmail: string | null | undefined;
  contactEmail: string | null | undefined;
  expected: boolean;
}> = [
  {
    name: "different emails are a mismatch",
    signInEmail: "fixture-b8bcff3d2d@example.org",
    contactEmail: "fixture-5eaf082c19@example.org",
    expected: true,
  },
  {
    name: "case and whitespace normalize",
    signInEmail: " fixture-b8bcff3d2d@example.org ",
    contactEmail: "fixture-b8bcff3d2d@example.org",
    expected: false,
  },
  {
    name: "a missing identity cannot assert a mismatch",
    signInEmail: undefined,
    contactEmail: "fixture-5eaf082c19@example.org",
    expected: false,
  },
];

const resetFixtures: Array<{
  name: string;
  entitlement: Entitlement;
  signInEmail: string;
  contactEmail: string;
  expected: boolean;
}> = [
  {
    name: "a denied member with different emails gets reset",
    entitlement: { entitled: false, state: "inactive" },
    signInEmail: "fixture-b8bcff3d2d@example.org",
    contactEmail: "fixture-5eaf082c19@example.org",
    expected: true,
  },
  {
    name: "an entitled member never gets reset",
    entitlement: { entitled: true, state: "active" },
    signInEmail: "fixture-b8bcff3d2d@example.org",
    contactEmail: "fixture-5eaf082c19@example.org",
    expected: false,
  },
  {
    name: "matching emails do not offer reset",
    entitlement: { entitled: false, state: "inactive" },
    signInEmail: "fixture-b8bcff3d2d@example.org",
    contactEmail: "fixture-b8bcff3d2d@example.org",
    expected: false,
  },
];

describe("MVault entitlement Functions parity (#1261)", () => {
  it.each(evaluationFixtures)("matches evaluation: $name", (fixture) => {
    const site = evaluateSiteEntitlement(fixture.membership, fixture.now);
    const functions = evaluateFunctionsEntitlement(
      fixture.membership,
      fixture.now,
    );

    expect(site).toEqual(fixture.expected);
    expect(functions).toEqual(fixture.expected);
    expect(functions).toEqual(site);
  });

  it.each(identityFixtures)("matches identity: $name", (fixture) => {
    const site = siteIdentityMismatch(
      fixture.signInEmail,
      fixture.contactEmail,
    );
    const functions = functionsIdentityMismatch(
      fixture.signInEmail,
      fixture.contactEmail,
    );

    expect(site).toBe(fixture.expected);
    expect(functions).toBe(fixture.expected);
    expect(functions).toBe(site);
  });

  it.each(resetFixtures)("matches reset: $name", (fixture) => {
    const site = sitePassportResetOffered(
      fixture.entitlement,
      fixture.signInEmail,
      fixture.contactEmail,
    );
    const functions = functionsPassportResetOffered(
      fixture.entitlement,
      fixture.signInEmail,
      fixture.contactEmail,
    );

    expect(site).toBe(fixture.expected);
    expect(functions).toBe(fixture.expected);
    expect(functions).toBe(site);
  });
});
