// Pins the gate's degradation policy (#189): fail-closed on every outage, honest
// island states, and a 403 lapse that is never retried. No network, no DOM, no
// clock. One case composes the real entitlement core to prove the two cores fit.

import { describe, it, expect } from "vitest";

import {
  resolveGatedPlayback,
  GATED_NOT_ENTITLED_NOTICE,
  GATED_PASSPORT_RESET_NOTICE,
  GATED_SIGN_IN_NOTICE,
  GATED_AUTH_UNAVAILABLE_NOTICE,
  GATED_ENTITLEMENT_UNAVAILABLE_NOTICE,
  GATED_AUTH_LAPSED_NOTICE,
  GATED_ENTITLEMENT_LAPSED_NOTICE,
  GATED_ENTITLEMENT_UNREADABLE_NOTICE,
  type GatedPlaybackSignal,
  type GatedFetchFailure,
  type GatedOutageLayer,
} from "../src/lib/member-gated-playback";
import {
  evaluateEntitlement,
  type Entitlement,
  type EntitlementState,
  type EntitledState,
  type DeniedState,
} from "../src/lib/mvault-entitlement";

const FAILURES: GatedFetchFailure[] = [
  "timeout",
  "forbidden",
  "rateLimited",
  "error",
];
const TRANSIENT: GatedFetchFailure[] = ["timeout", "rateLimited", "error"];
const LAYERS: GatedOutageLayer[] = ["auth", "entitlement"];

// The phrase a notice uses only when it is honest to invite a retry. The whole
// bug this guards against was a notice that promised this while retryable was false.
const RETRY_TAIL = "try again shortly";

// The boolean and the state are one fact (#431), so this builds an entitlement
// from the state alone and derives the boolean. There is no way to hand it a
// disagreeing pair; the deliberately-inconsistent ones are built by `resolvedWith`
// in the #431 block below, which has to cast past the type system to do it.
const ent = (state: EntitlementState): Entitlement =>
  state === "active" || state === "grace"
    ? { entitled: true, state }
    : { entitled: false, state };

// Every signal the policy accepts, enumerated once so the exhaustive invariants
// below cannot silently miss a branch.
const ALL_SIGNALS: GatedPlaybackSignal[] = [
  { kind: "resolved", entitlement: ent("active") },
  { kind: "resolved", entitlement: ent("grace") },
  { kind: "resolved", entitlement: ent("expired") },
  { kind: "resolved", entitlement: ent("inactive") },
  { kind: "resolved", entitlement: ent("malformed") },
  { kind: "signedOut" },
  ...LAYERS.flatMap((layer) =>
    FAILURES.map((status): GatedPlaybackSignal => ({ kind: "outage", layer, status })),
  ),
];

describe("member-gated playback degradation policy (issue #189)", () => {
  it("an entitled member plays, with nothing to retry", () => {
    for (const state of ["active", "grace"] as EntitledState[]) {
      const r = resolveGatedPlayback({ kind: "resolved", entitlement: ent(state) });
      expect(r.render).toEqual({ mode: "play" });
      expect(r.grantAccess).toBe(true);
      expect(r.retryable).toBe(false);
    }
  });

  it("composes the real entitlement core: an active MVault record plays", () => {
    // Prove the gate sits downstream of evaluateEntitlement, not a hand-built stub.
    const entitlement = evaluateEntitlement(
      { status: "On", offer: "passport", timing: "within_start_expire_dates" },
      Date.parse("2026-07-09T12:00:00-04:00"),
    );
    expect(entitlement.entitled).toBe(true);
    const r = resolveGatedPlayback({ kind: "resolved", entitlement });
    expect(r.render).toEqual({ mode: "play" });
    expect(r.grantAccess).toBe(true);
  });

  it("a signed-in but genuinely-lapsed member is denied with an honest prompt that carries the state", () => {
    // Expired and inactive are real membership lapses: the honest next step is
    // renew or sign in with the account on the membership. (Malformed is handled
    // separately below — it is a data problem, not a lapse.)
    for (const state of ["expired", "inactive"] as DeniedState[]) {
      const r = resolveGatedPlayback({ kind: "resolved", entitlement: ent(state) });
      expect(r.render).toEqual({
        mode: "notEntitled",
        state,
        notice: GATED_NOT_ENTITLED_NOTICE,
      });
      expect(r.grantAccess).toBe(false);
      expect(r.retryable).toBe(false);
    }
  });

  it("an unreadable (malformed) record is an unavailable data problem, not a lapsed membership", () => {
    // The member may be perfectly active; the record just could not be read. Telling
    // them to renew would be misleading, so this routes to the honest unavailable
    // island (entitlement layer) with a support-oriented notice, not the renew copy.
    const r = resolveGatedPlayback({ kind: "resolved", entitlement: ent("malformed") });
    expect(r.render).toEqual({
      mode: "unavailable",
      layer: "entitlement",
      notice: GATED_ENTITLEMENT_UNREADABLE_NOTICE,
    });
    expect(r.grantAccess).toBe(false);
    expect(r.retryable).toBe(false);
    // It must not send an active member down the renew/reauthenticate path.
    expect(GATED_ENTITLEMENT_UNREADABLE_NOTICE.toLowerCase()).not.toContain("renew");
  });

  it("a signed-out visitor is invited to sign in, not denied silently", () => {
    const r = resolveGatedPlayback({ kind: "signedOut" });
    expect(r.render).toEqual({ mode: "signIn", notice: GATED_SIGN_IN_NOTICE });
    expect(r.grantAccess).toBe(false);
    expect(r.retryable).toBe(false);
  });

  it("any outage denies access and shows an honest unavailable island for the failing layer", () => {
    for (const layer of LAYERS) {
      for (const status of FAILURES) {
        const r = resolveGatedPlayback({ kind: "outage", layer, status });
        expect(r.render.mode).toBe("unavailable");
        expect(r.render.mode === "unavailable" && r.render.layer).toBe(layer);
        expect(r.grantAccess).toBe(false);
      }
    }
  });

  it("the outage notice is specific to both the failing layer and the cause", () => {
    // Four distinct honest messages: transient vs 403 lapse, for each layer. The 403
    // notices must not reuse the transient copy — that is the retry-promise bug.
    const cases: [GatedOutageLayer, GatedFetchFailure, string][] = [
      ["auth", "timeout", GATED_AUTH_UNAVAILABLE_NOTICE],
      ["auth", "forbidden", GATED_AUTH_LAPSED_NOTICE],
      ["entitlement", "timeout", GATED_ENTITLEMENT_UNAVAILABLE_NOTICE],
      ["entitlement", "forbidden", GATED_ENTITLEMENT_LAPSED_NOTICE],
    ];
    for (const [layer, status, expected] of cases) {
      const { render } = resolveGatedPlayback({ kind: "outage", layer, status });
      expect(render.mode === "unavailable" && render.notice).toBe(expected);
    }
  });

  it("an entitlement outage never tells an already-signed-in visitor that sign-in is down", () => {
    // auth succeeded, only the entitlement lookup failed, so the recovery path must
    // not be "sign in again". The two layers carry distinct notices, transient and
    // lapsed alike.
    for (const status of ["timeout", "forbidden"] as GatedFetchFailure[]) {
      const auth = resolveGatedPlayback({ kind: "outage", layer: "auth", status }).render;
      const entitlement = resolveGatedPlayback({ kind: "outage", layer: "entitlement", status }).render;
      expect(auth.mode === "unavailable" && auth.notice).not.toBe(
        entitlement.mode === "unavailable" && entitlement.notice,
      );
      expect(entitlement.mode === "unavailable" && entitlement.notice.toLowerCase()).not.toContain(
        "sign in",
      );
    }
  });

  it("a 403 lapse is never retried; every other transport failure is", () => {
    // The membership-lapse boundary #189 exists for: a forbidden does not self-heal,
    // so retrying only hammers a forbidden endpoint. timeout/429/error are transient.
    for (const layer of LAYERS) {
      expect(resolveGatedPlayback({ kind: "outage", layer, status: "forbidden" }).retryable).toBe(false);
      for (const status of TRANSIENT) {
        expect(resolveGatedPlayback({ kind: "outage", layer, status }).retryable).toBe(true);
      }
    }
  });

  it("a notice invites a retry if and only if the result is retryable", () => {
    // The exact contradiction the review caught: a 403 outage set retryable:false but
    // still showed the transient "try again shortly" copy. Pin the invariant across
    // every signal so the notice can never again promise a retry the policy refuses.
    for (const signal of ALL_SIGNALS) {
      const { render, retryable } = resolveGatedPlayback(signal);
      if (render.mode === "play") {
        expect(retryable).toBe(false); // play has no notice and nothing to retry
        continue;
      }
      expect(render.notice.includes(RETRY_TAIL)).toBe(retryable);
    }
  });

  it("fail-closed: only a resolved, entitled member is ever granted access", () => {
    // Exhaustive over every non-(resolved+entitled) signal — no outage, no
    // signed-out visitor, and no denying verdict may grant access. This is the
    // whole point of the surface: an unreachable or unreadable MVault must read as
    // unauthenticated, never as access served from stale state (#208 persists none).
    for (const signal of ALL_SIGNALS) {
      const entitled =
        signal.kind === "resolved" && signal.entitlement.entitled;
      expect(resolveGatedPlayback(signal).grantAccess).toBe(entitled);
    }
  });

  it("no signal ever produces a broken or empty island: the render is always one of the four honest modes", () => {
    const modes = new Set(["play", "notEntitled", "signIn", "unavailable"]);
    for (const signal of ALL_SIGNALS) {
      const { render } = resolveGatedPlayback(signal);
      expect(modes.has(render.mode)).toBe(true);
      // Every fallback carries a real next step, never a bare or empty notice.
      if (render.mode !== "play") {
        expect(render.notice.length).toBeGreaterThan(0);
      }
      // Every outage-family island keeps the free-livestream escape hatch, so an
      // unavailable state is never a dead end for a visitor who just wants to watch.
      if (render.mode === "unavailable") {
        expect(render.notice.toLowerCase()).toContain("livestream");
      }
    }
  });
});

// #431. The boolean and the state are one fact. The Entitlement union makes a
// disagreement unrepresentable in TypeScript, so these inputs have to be cast in to
// exist at all — which is the point: they model what a mapper bug or an unchecked
// cast can still hand the gate at the credentialed MVault boundary, where the type
// system does not reach. Granting on the boolean alone would stream Passport content
// to a lapsed member.
describe("resolveGatedPlayback: inconsistent entitlement records fail closed (#431)", () => {
  /** Build a resolved signal from a pair the Entitlement union forbids. */
  const resolvedWith = (entitled: boolean, state: string): GatedPlaybackSignal =>
    ({ kind: "resolved", entitlement: { entitled, state } } as unknown as GatedPlaybackSignal);

  it("rejects the bad pair at compile time", () => {
    // The primary defense. If this ever stops erroring, the union has been loosened
    // back to two independent fields and the runtime checks below are all that is
    // left. @ts-expect-error fails the typecheck when the error disappears.
    // @ts-expect-error entitled: true admits only "active" or "grace"
    const bad: Entitlement = { entitled: true, state: "expired" };
    expect(bad.state).toBe("expired");
  });

  for (const state of ["expired", "inactive", "malformed"] as DeniedState[]) {
    it(`denies { entitled: true, state: "${state}" } and shows the unreadable island`, () => {
      const result = resolveGatedPlayback(resolvedWith(true, state));
      expect(result.grantAccess).toBe(false);
      expect(result.render.mode).toBe("unavailable");
      // Not the not-entitled "renew" copy: an inconsistent record is a defect on our
      // side, and the member may be perfectly active, so blaming them would be both
      // wrong and unfixable by them.
      if (result.render.mode === "unavailable") {
        expect(result.render.notice).toBe(GATED_ENTITLEMENT_UNREADABLE_NOTICE);
        expect(result.render.layer).toBe("entitlement");
      }
      // A re-fetch returns the same broken record, so a retry loop is pointless.
      expect(result.retryable).toBe(false);
    });
  }

  for (const state of ["active", "grace"] as EntitledState[]) {
    it(`treats { entitled: false, state: "${state}" } as a defect, not a lapsed membership`, () => {
      // The inverse disagreement. This one already denied before the change; the bug
      // is that the visitor was told to renew a membership the record says is active,
      // sending them down a recovery path that cannot work. So the assertion that
      // matters is the copy, not the denial.
      const result = resolveGatedPlayback(resolvedWith(false, state));
      expect(result.grantAccess).toBe(false);
      expect(result.render.mode).toBe("unavailable");
      if (result.render.mode === "unavailable") {
        expect(result.render.notice).toBe(GATED_ENTITLEMENT_UNREADABLE_NOTICE);
        expect(result.render.layer).toBe("entitlement");
      }
    });
  }

  for (const entitled of [true, false]) {
    it(`denies an unknown state (entitled: ${entitled}) instead of crashing`, () => {
      // A newer MVault returning a state this build has never heard of. It gets past
      // the type system the same way the pairs above do, and the exhaustive switch has
      // no case for it, so the `default` is what stands between an unknown string and
      // a gate that returns undefined and takes the island down with it.
      const result = resolveGatedPlayback(resolvedWith(entitled, "suspended"));
      expect(result.grantAccess).toBe(false);
      expect(result.render.mode).toBe("unavailable");
      if (result.render.mode === "unavailable") {
        expect(result.render.notice).toBe(GATED_ENTITLEMENT_UNREADABLE_NOTICE);
      }
    });
  }

  for (const state of ["active", "grace"] as EntitledState[]) {
    it(`still plays for a consistent { entitled: true, state: "${state}" }`, () => {
      // Built by the honest constructor, not cast in: the fail-closed checks above
      // must not have cost a real member their stream.
      const result = resolveGatedPlayback({ kind: "resolved", entitlement: ent(state) });
      expect(result.grantAccess).toBe(true);
      expect(result.render.mode).toBe("play");
    });
  }
});

// #448. The common support case: a member signs in with a PBS Account whose email is
// not the one on their donation record, so the live MVault lookup misses and they hit
// a "not entitled" wall for a membership they actually have. When the site knows both
// emails and a reset URL is configured, the denial becomes a recoverable path — the
// signed-in identity plus the Passport Reset link — instead of a dead end. The offer
// is never made for a data problem (malformed/inconsistent), for a genuine non-member
// (matching emails), for an entitled member, or when the URL is missing.
describe("Passport Reset surface on a denied email mismatch (#448)", () => {
  const RESET_URL = "https://help.pbs.org/passport/reset";
  const SIGN_IN = "member@example.com";
  const CONTACT = "donor@example.org";

  it("offers the reset path for an inactive, mismatched member, carrying the signed-in identity and configured URL", () => {
    // The credentialed boundary has verified this inactive result is an identity
    // miss, rather than another inactive lifecycle state.
    const result = resolveGatedPlayback(
      {
        kind: "resolved",
        entitlement: ent("inactive"),
        signInEmail: SIGN_IN,
        membershipContactEmail: CONTACT,
        passportResetEligible: true,
      },
      { passportResetUrl: RESET_URL },
    );
    expect(result.render).toEqual({
      mode: "notEntitled",
      state: "inactive",
      notice: GATED_PASSPORT_RESET_NOTICE,
      reset: { signInEmail: SIGN_IN, resetUrl: RESET_URL },
    });
    // A reset offer is still a denial: it never grants access or invites a blind retry.
    expect(result.grantAccess).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it("requires credentialed proof so provisional and before-start memberships never inherit reset copy", () => {
    const provisional = evaluateEntitlement(
      {
        status: "On",
        offer: "passport",
        provisional: true,
        expireDate: "2026-12-31",
      },
      Date.parse("2026-07-09T12:00:00-04:00"),
    );
    const beforeStart = evaluateEntitlement(
      {
        status: "On",
        offer: "passport",
        timing: "before_start",
        expireDate: "2026-12-31",
      },
      Date.parse("2026-07-09T12:00:00-04:00"),
    );
    expect(provisional).toEqual({ entitled: false, state: "inactive" });
    expect(beforeStart).toEqual({ entitled: false, state: "inactive" });

    const signals: GatedPlaybackSignal[] = [
      {
        kind: "resolved",
        entitlement: ent("inactive"),
        signInEmail: SIGN_IN,
        membershipContactEmail: CONTACT,
      },
      {
        kind: "resolved",
        entitlement: provisional,
        signInEmail: SIGN_IN,
        membershipContactEmail: CONTACT,
        passportResetEligible: false,
      },
      {
        kind: "resolved",
        entitlement: beforeStart,
        signInEmail: SIGN_IN,
        membershipContactEmail: CONTACT,
        passportResetEligible: false,
      },
    ];

    for (const signal of signals) {
      const result = resolveGatedPlayback(signal, {
        passportResetUrl: RESET_URL,
      });
      expect(result.render).toEqual({
        mode: "notEntitled",
        state: "inactive",
        notice: GATED_NOT_ENTITLED_NOTICE,
      });
      expect(
        result.render.mode === "notEntitled" && "reset" in result.render,
      ).toBe(false);
    }
  });

  it("keeps an expired membership on the renewal path even with an email mismatch and a URL", () => {
    // A located, lapsed membership: MVault found the record and its window is over.
    // Reset relinks accounts and cannot restore an expired benefit, so the honest step
    // is renew — the base notice already adds "or sign in with the account on your
    // membership" for the member whose active membership is under a different email.
    const result = resolveGatedPlayback(
      {
        kind: "resolved",
        entitlement: ent("expired"),
        signInEmail: SIGN_IN,
        membershipContactEmail: CONTACT,
        passportResetEligible: true,
      },
      { passportResetUrl: RESET_URL },
    );
    expect(result.render).toEqual({
      mode: "notEntitled",
      state: "expired",
      notice: GATED_NOT_ENTITLED_NOTICE,
    });
    expect(result.render.mode === "notEntitled" && "reset" in result.render).toBe(false);
  });

  it("does not offer a reset when the two emails match — a genuine non-member sees the bare notice", () => {
    const result = resolveGatedPlayback(
      {
        kind: "resolved",
        entitlement: ent("inactive"),
        signInEmail: SIGN_IN,
        membershipContactEmail: SIGN_IN,
        passportResetEligible: true,
      },
      { passportResetUrl: RESET_URL },
    );
    expect(result.render).toEqual({
      mode: "notEntitled",
      state: "inactive",
      notice: GATED_NOT_ENTITLED_NOTICE,
    });
    expect(result.render.mode === "notEntitled" && "reset" in result.render).toBe(false);
  });

  it("compares the emails case- and whitespace-insensitively, but surfaces the address as the member typed it", () => {
    // The mismatch check is normalized (trim + lowercase), so casing alone is not a
    // mismatch; but the displayed identity keeps the member's own casing so it reads
    // as the address they signed in with.
    const matchesButMessy = resolveGatedPlayback(
      {
        kind: "resolved",
        entitlement: ent("inactive"),
        signInEmail: "  Member@Example.com ",
        membershipContactEmail: "member@example.com",
        passportResetEligible: true,
      },
      { passportResetUrl: RESET_URL },
    );
    // Same address, different casing/spacing — not a mismatch, so no reset offer.
    expect(matchesButMessy.render).toEqual({
      mode: "notEntitled",
      state: "inactive",
      notice: GATED_NOT_ENTITLED_NOTICE,
    });

    const realMismatch = resolveGatedPlayback(
      {
        kind: "resolved",
        entitlement: ent("inactive"),
        signInEmail: "  Alex@Example.com ",
        membershipContactEmail: "donor@example.org",
        passportResetEligible: true,
      },
      { passportResetUrl: RESET_URL },
    );
    expect(realMismatch.render.mode === "notEntitled" && realMismatch.render.reset).toEqual({
      signInEmail: "Alex@Example.com",
      resetUrl: RESET_URL,
    });
  });

  it("falls back to the bare notice rather than render a dead link when no reset URL is configured", () => {
    // The mismatch is real, but with no URL (options omitted, or a blank/whitespace
    // value) an offer would be a link to nowhere. An honest renew notice beats that.
    for (const options of [undefined, {}, { passportResetUrl: "" }, { passportResetUrl: "   " }]) {
      const result = resolveGatedPlayback(
        {
          kind: "resolved",
          entitlement: ent("inactive"),
          signInEmail: SIGN_IN,
          membershipContactEmail: CONTACT,
          passportResetEligible: true,
        },
        options,
      );
      expect(result.render).toEqual({
        mode: "notEntitled",
        state: "inactive",
        notice: GATED_NOT_ENTITLED_NOTICE,
      });
    }
  });

  it("does not offer a reset when a sign-in email is not known", () => {
    // Without an identity to surface, "reset the account you signed in with" has no
    // account to name, so the offer would be incomplete. Missing on either side of the
    // pair means no assertable mismatch anyway.
    for (const signInEmail of [undefined, null, "   "]) {
      const result = resolveGatedPlayback(
        {
          kind: "resolved",
          entitlement: ent("inactive"),
          signInEmail,
          membershipContactEmail: CONTACT,
          passportResetEligible: true,
        },
        { passportResetUrl: RESET_URL },
      );
      expect(result.render).toEqual({
        mode: "notEntitled",
        state: "inactive",
        notice: GATED_NOT_ENTITLED_NOTICE,
      });
    }
  });

  it("does not offer a reset to a genuine non-member with no membership on file", () => {
    // The most common inactive path: someone signs in and MVault has no record for
    // them, so there is no contact email to compare. A mismatch cannot be asserted
    // without both sides, so the offer stays silent — never tell an actual non-member
    // to "reset your Passport". This is the false positive the whole gating prevents.
    for (const membershipContactEmail of [undefined, null, "   "]) {
      const result = resolveGatedPlayback(
        {
          kind: "resolved",
          entitlement: ent("inactive"),
          signInEmail: SIGN_IN,
          membershipContactEmail,
          passportResetEligible: true,
        },
        { passportResetUrl: RESET_URL },
      );
      expect(result.render).toEqual({
        mode: "notEntitled",
        state: "inactive",
        notice: GATED_NOT_ENTITLED_NOTICE,
      });
    }
  });

  it("never offers a reset for an unreadable record, even with a mismatch and a URL", () => {
    // The critical invariant: a malformed or inconsistent record is a data problem the
    // member cannot fix by relinking accounts. It routes to the unavailable island
    // before the reset case is ever considered, so a mismatch must not turn a backend
    // defect into a misleading "reset your Passport" prompt.
    const malformed = resolveGatedPlayback(
      {
        kind: "resolved",
        entitlement: ent("malformed"),
        signInEmail: SIGN_IN,
        membershipContactEmail: CONTACT,
        passportResetEligible: true,
      },
      { passportResetUrl: RESET_URL },
    );
    expect(malformed.render.mode).toBe("unavailable");
    expect(malformed.render.mode === "unavailable" && malformed.render.notice).toBe(
      GATED_ENTITLEMENT_UNREADABLE_NOTICE,
    );

    // An inconsistent pair (cast past the union, as #431 models the mapper bug) with a
    // mismatch and a URL must also stay unavailable, not become a reset offer.
    const inconsistent = resolveGatedPlayback({
      kind: "resolved",
      entitlement: { entitled: false, state: "grace" },
      signInEmail: SIGN_IN,
      membershipContactEmail: CONTACT,
      passportResetEligible: true,
    } as unknown as GatedPlaybackSignal, { passportResetUrl: RESET_URL });
    expect(inconsistent.render.mode).toBe("unavailable");
  });

  it("never offers a reset to an entitled member, even on an email mismatch", () => {
    // An entitled member streams; the mismatch is immaterial to them, and a reset
    // prompt would be nonsense. passportResetOffered guards on !entitled, so play wins.
    for (const state of ["active", "grace"] as EntitledState[]) {
      const result = resolveGatedPlayback(
        {
          kind: "resolved",
          entitlement: ent(state),
          signInEmail: SIGN_IN,
          membershipContactEmail: CONTACT,
          passportResetEligible: true,
        },
        { passportResetUrl: RESET_URL },
      );
      expect(result.render).toEqual({ mode: "play" });
      expect(result.grantAccess).toBe(true);
    }
  });

  it("composes the real entitlement core: an inactive MVault record with a mismatch offers the reset", () => {
    // Prove the surface sits downstream of evaluateEntitlement, not a hand-built stub:
    // a real inactive record (status Off — no active membership for this identity), a
    // real mismatch, and a configured URL produce the offer.
    const entitlement = evaluateEntitlement(
      { status: "Off", offer: null },
      Date.parse("2026-07-09T12:00:00-04:00"),
    );
    expect(entitlement).toEqual({ entitled: false, state: "inactive" });
    const result = resolveGatedPlayback(
      {
        kind: "resolved",
        entitlement,
        signInEmail: SIGN_IN,
        membershipContactEmail: CONTACT,
        passportResetEligible: true,
      },
      { passportResetUrl: RESET_URL },
    );
    expect(result.render.mode === "notEntitled" && result.render.reset).toEqual({
      signInEmail: SIGN_IN,
      resetUrl: RESET_URL,
    });
    expect(result.render.mode === "notEntitled" && result.render.notice).toBe(
      GATED_PASSPORT_RESET_NOTICE,
    );
  });
});
