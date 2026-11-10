// Pure degradation policy for member-gated Passport playback.
// PMSSO identifies the viewer and MVault supplies a live entitlement verdict.
// Only a resolved, entitled member receives access. Signed-out, denied and outage
// states keep the surrounding editorial page usable and deny the gated stream.
// Unlike display-only schedule data, entitlement is never served from a cache.
// Callers own authentication, credentialed fetches, clocks and rendering.

import { passportResetOffered } from "./mvault-entitlement";
import type { Entitlement, DeniedState } from "./mvault-entitlement";

/**
 * How a live PBS call behind the gate failed, as the proxy collapses it — the same
 * non-ok cases as the schedule surfaces' {@link import("./schedule-availability").ScheduleFetchStatus}.
 * The `forbidden` case is not retryable: a lapsed
 * key does not self-heal, so it is never retried; the rest are transient.
 */
export type GatedFetchFailure =
  | "timeout" // upstream did not answer in time, or the network is down
  | "forbidden" // 403: the proxy key has lapsed or lacks this resource
  | "rateLimited" // 429: over the rate limit, retry later
  | "error"; // any other upstream failure (4xx or 5xx)

/** Which live call behind the gate hit an outage: identity (PMSSO) or entitlement (MVault). */
export type GatedOutageLayer = "auth" | "entitlement";

/**
 * The outcome of the gate's live auth + entitlement attempt, as a closed set so a
 * caller cannot invent a fifth. Exactly one is fed to {@link resolveGatedPlayback}:
 *
 *   - `resolved`: both calls answered; `entitlement` is the live MVault verdict
 *     from evaluateEntitlement. This is the only signal that can grant access.
 *     `signInEmail` and `membershipContactEmail` are the identities the
 *     credentialed slice resolved (the PIDS sign-in email and the email on the
 *     MVault record). `passportResetEligible` is the separate proof from that
 *     slice that this inactive verdict is a genuine identity miss, rather than a
 *     provisional or not-yet-started membership. They drive only the Passport
 *     Reset offer and never the entitlement decision itself. All are optional
 *     because absent identity proof must never offer a reset.
 *   - `signedOut`: PMSSO answered but there is no active session — the person is
 *     simply not signed in. Not an outage: the island invites sign-in.
 *   - `outage`: a call at `layer` failed with `status`. Access is denied and the
 *     island shows an honest temporarily-unavailable state; there is no cached
 *     entitlement to serve (see the module note).
 */
export type GatedPlaybackSignal =
  | {
      readonly kind: "resolved";
      readonly entitlement: Entitlement;
      readonly signInEmail?: string | null;
      readonly membershipContactEmail?: string | null;
      readonly passportResetEligible?: boolean;
    }
  | { readonly kind: "signedOut" }
  | {
      readonly kind: "outage";
      readonly layer: GatedOutageLayer;
      readonly status: GatedFetchFailure;
    };

/**
 * What the gated island renders, as a closed set. None of these is a broken state:
 * `play` serves the benefit, and the other three are honest, accessible fallbacks
 * the caller renders in place of the video without taking the surrounding page.
 */
export type GatedPlaybackRender =
  /** Entitled: serve the Passport stream. */
  | { readonly mode: "play" }
  /**
   * Signed in but genuinely not entitled — an expired or inactive membership.
   * Carries the entitlement `state` so the caller can tailor the prompt; the base
   * notice is honest and never a dead end.
   *
   * The `state` is narrowed to the two real lapses. An unreadable (`malformed`)
   * record is NOT this case — the member may be active and cannot fix a backend data
   * problem by renewing — and neither is a record whose two halves disagree.
   * Both route to the `unavailable` state below, so the caller never has to write
   * copy for a state it cannot receive.
   *
   * `reset` accompanies only the `inactive` state after the credentialed slice
   * verifies that the denial is a genuine identity miss, the two emails differ,
   * and a Passport Reset URL is configured.
   * The caller surfaces `reset.signInEmail` (which account was checked) and links to
   * `reset.resetUrl` so a recoverable miss is a path forward, not a wall. It is never
   * attached to an `expired` state: a located, lapsed membership needs renewal, not a
   * relink that cannot restore an expired benefit. Absent, too, for a genuine
   * non-member (matching emails) or when no reset URL is set, and never for an
   * unreadable record — that routes to `unavailable` above and never reaches here.
   */
  | {
      readonly mode: "notEntitled";
      readonly state: Exclude<DeniedState, "malformed">;
      readonly notice: string;
      readonly reset?: {
        readonly signInEmail: string;
        readonly resetUrl: string;
      };
    }
  /** Not signed in: invite sign-in rather than deny silently. */
  | { readonly mode: "signIn"; readonly notice: string }
  /**
   * A live call behind the gate is failing, or the entitlement record came back
   * unreadable — either malformed, or with its two halves disagreeing. Honest
   * temporarily-unavailable state; the visitor is treated as unauthenticated (access
   * denied), and the rest of the page stays usable.
   */
  | {
      readonly mode: "unavailable";
      readonly layer: GatedOutageLayer;
      readonly notice: string;
    };

export interface GatedPlaybackResult {
  readonly render: GatedPlaybackRender;
  /**
   * Whether the gated stream may be served now. Fail-closed: true only for a live,
   * resolved member whose record says entitled AND carries a streaming state, both
   * halves agreeing. Every outage denies — there is no cached entitlement
   * to serve, so an unreachable MVault or PMSSO is treated as unauthenticated
   * rather than granted from stale state.
   */
  readonly grantAccess: boolean;
  /**
   * Whether the caller should retry the failed live call. Only an outage is ever
   * retryable, and a `forbidden` (403 lapse) is not — it will not self-heal, so
   * retrying only hammers a forbidden endpoint. A resolved verdict and a signed-out
   * visitor are settled answers with nothing to retry.
   */
  readonly retryable: boolean;
}

/**
 * Runtime configuration for the gate's rendering. The Passport Reset URL is app
 * config (the PBS reset path), never hard-coded in this policy, so the reset
 * offer is made only when it is supplied. Optional and defaulted, so a caller that
 * passes no options gets the same not-entitled notice as before.
 */
export interface GatedPlaybackOptions {
  /** The PBS Passport Reset path a denied, mismatched member is sent to. */
  readonly passportResetUrl?: string | null;
}

/**
 * Shown when a signed-in visitor is genuinely not entitled — an expired or inactive
 * membership. Names the situation honestly and points at the real next step (renew,
 * or sign in with the account on the membership) rather than a bare "access denied".
 * Not used for an unreadable record: renewing cannot fix a data problem, so that
 * routes to {@link GATED_ENTITLEMENT_UNREADABLE_NOTICE}.
 */
export const GATED_NOT_ENTITLED_NOTICE =
  "This program is a Passport member benefit. Renew or sign in with the account on your membership to watch.";

/**
 * Shown in place of {@link GATED_NOT_ENTITLED_NOTICE} when a denied member's sign-in
 * email differs from the contact email on their membership — the common support case
 * where the lookup missed because the two accounts are not linked. The base copy names
 * the situation without hard-coding either the email or the link: the caller renders
 * the signed-in email from the render's `reset.signInEmail` and points the reset action
 * at `reset.resetUrl`, so the visitor sees which account was checked and a real way to
 * fix it.
 */
export const GATED_PASSPORT_RESET_NOTICE =
  "We couldn't find an active Passport membership for the email you signed in with. If your membership is under a different email, reset your Passport to link it to the account you're using now.";

/** Shown when no one is signed in: invite sign-in instead of denying silently. */
export const GATED_SIGN_IN_NOTICE =
  "Sign in with your PBS Account to watch Passport member programs.";

/**
 * Shown when the sign-in call is down with a transient failure (the `auth` outage
 * layer, timeout/429/error): the visitor cannot be identified, so sign-in is the
 * thing to retry. Honest that only the membership check is down — not the whole
 * site — and offers the free livestream so the island is never a dead end. It ends
 * by inviting a retry, which is honest only for a transient failure; a 403 lapse
 * uses {@link GATED_AUTH_LAPSED_NOTICE} instead.
 */
export const GATED_AUTH_UNAVAILABLE_NOTICE =
  "Member sign-in is temporarily unavailable, so this program can't be verified right now. Watch the free NJ PBS livestream, or try again shortly.";

/**
 * Shown when sign-in succeeded but the entitlement lookup is down with a transient
 * failure (the `entitlement` outage layer). It does not tell an already-signed-in
 * visitor to sign in again, which would send them down the wrong recovery path; it
 * names the membership check as the thing that is down and offers the free
 * livestream. Invites a retry — honest only for a transient failure.
 */
export const GATED_ENTITLEMENT_UNAVAILABLE_NOTICE =
  "We can't confirm your membership right now, so this program can't be unlocked. Watch the free NJ PBS livestream, or try again shortly.";

/**
 * Shown for a 403 at the `auth` layer. A forbidden is a service-side credential
 * lapse, not a slow network, so it does not self-heal and `retryable` is false. The
 * copy must not promise "try again shortly" the way the transient notice does — that
 * would tell the visitor to retry something that will not clear. It offers the free
 * livestream and says access is being restored, staying honest without inviting a
 * futile retry.
 */
export const GATED_AUTH_LAPSED_NOTICE =
  "Member sign-in is temporarily unavailable, so this program can't be verified right now. Watch the free NJ PBS livestream while we restore access.";

/**
 * Shown for a 403 at the `entitlement` layer — the same lapse case as
 * {@link GATED_AUTH_LAPSED_NOTICE}, phrased for the membership check. No retry
 * promise, since a 403 does not self-heal.
 */
export const GATED_ENTITLEMENT_LAPSED_NOTICE =
  "We can't confirm your membership right now, so this program can't be unlocked. Watch the free NJ PBS livestream while we restore access.";

/**
 * Shown when MVault answered but the entitlement record is unreadable (state
 * `malformed`: a bad response, a missing expiry, a bad clock, or a mapper bug). The
 * member may be perfectly active, so the not-entitled "renew" copy would be
 * misleading — they cannot fix a backend data problem by renewing or reauthenticating.
 * Name it as a membership-check problem on our side and point at support if it
 * persists. No retry promise: a re-fetch returns the same broken record.
 */
export const GATED_ENTITLEMENT_UNREADABLE_NOTICE =
  "We found your membership but can't confirm it right now, so this program can't be unlocked. Watch the free NJ PBS livestream, or contact NJ PBS support if this keeps happening.";

/**
 * The honest unavailable notice for an outage, chosen by which live call failed and
 * whether it was a transient blip or a 403 lapse. A 403 does not self-heal
 * (`retryable` is false), so it gets a notice that does not invite a retry; and the
 * layer split keeps a signed-in visitor from ever being wrongly told sign-in is down.
 */
function unavailableNotice(
  layer: GatedOutageLayer,
  status: GatedFetchFailure,
): string {
  const lapsed = status === "forbidden";
  if (layer === "auth") {
    return lapsed ? GATED_AUTH_LAPSED_NOTICE : GATED_AUTH_UNAVAILABLE_NOTICE;
  }
  return lapsed
    ? GATED_ENTITLEMENT_LAPSED_NOTICE
    : GATED_ENTITLEMENT_UNAVAILABLE_NOTICE;
}

/** A failed live call worth retrying: any transport failure except a 403 lapse,
 *  which does not self-heal. Mirrors schedule-availability's retry rule. */
function isRetryableFailure(status: GatedFetchFailure): boolean {
  return status !== "forbidden";
}

/**
 * Whether a state is one of the two that stream. Takes a bare `string` rather than
 * `EntitlementState` because this value reaches the module from live MVault JSON: at
 * runtime it can be a string the union does not list. A narrower parameter would also
 * let a caller's narrowing make the comparison look redundant and invite its removal,
 * and the runtime check is the whole point here.
 */
function isStreamingState(state: string): boolean {
  return state === "active" || state === "grace";
}

/**
 * Whether an entitlement's two halves agree — the boolean says stream and the state
 * is a streaming one, or neither. The union in mvault-entitlement.ts makes a
 * disagreement unrepresentable in TypeScript, so within this codebase this is always
 * true; it is checked anyway because the value is mapped from a live MVault JSON
 * record at a credentialed boundary the type system does not reach.
 */
function isConsistent(entitlement: Entitlement): boolean {
  return entitlement.entitled === isStreamingState(entitlement.state);
}

/**
 * The island for a record the gate could not read: malformed, or with its two halves
 * disagreeing. A data problem on our side rather than a statement about the
 * membership, so the visitor is not told to renew — they may be perfectly active, and
 * renewing cannot fix a backend defect. Never retryable: a re-fetch returns the same
 * broken record, so it needs a backend or support fix, not a loop.
 */
function unreadableRecord(): GatedPlaybackResult {
  return {
    render: {
      mode: "unavailable",
      layer: "entitlement",
      notice: GATED_ENTITLEMENT_UNREADABLE_NOTICE,
    },
    grantAccess: false,
    retryable: false,
  };
}

/**
 * The Passport Reset affordance for a denied member, or null when it must not be
 * offered. The credentialed slice must first verify that the inactive verdict is a
 * genuine identity miss; this prevents provisional and before-start records from
 * inheriting reset copy just because they collapse to `inactive`. The sign-in
 * and contact emails must also differ (`passportResetOffered`, the single source of
 * truth for the mismatch rule), a sign-in email must be known, and a reset URL must
 * be configured. Any missing proof falls back to the bare denial rather than a
 * half-built, dead, or misleading reset path.
 *
 * The display `signInEmail` is the trimmed original, not the lowercased comparison
 * form, so the visitor sees the address as they typed it. Only called from the
 * `inactive` case, never for `expired` (a located, lapsed membership renews, it
 * does not relink) nor for a malformed or inconsistent record (routed to
 * `unreadableRecord` first), so a data problem or genuine lapse is never dressed
 * up as a fixable mismatch.
 */
function passportResetOffer(
  entitlement: Entitlement,
  signInEmail: string | null | undefined,
  membershipContactEmail: string | null | undefined,
  resetEligible: boolean | undefined,
  resetUrl: string | null | undefined,
): { readonly signInEmail: string; readonly resetUrl: string } | null {
  const email = typeof signInEmail === "string" ? signInEmail.trim() : "";
  const url = typeof resetUrl === "string" ? resetUrl.trim() : "";
  if (resetEligible !== true || email === "" || url === "") return null;
  if (!passportResetOffered(entitlement, signInEmail, membershipContactEmail)) {
    return null;
  }
  return { signInEmail: email, resetUrl: url };
}

/**
 * Decide the outcome for a signal that resolved to an entitlement record.
 *
 * Its own function, not an inline branch: nested inside the caller's
 * `switch (signal.kind)`, a state the switch missed would fall through into the next
 * signal case. Here it cannot — the `default` makes a state added to
 * `EntitlementState` later a compile error rather than a silent slide into the
 * "renew your membership" copy, which prevents an incorrect renewal prompt.
 *
 * The consistency gate runs first, so past it the state alone decides and the
 * boolean is not consulted again.
 *
 * The identity and reset args drive only the Passport Reset offer on a genuine
 * not-entitled verdict; every other outcome ignores them, so the entitlement
 * decision never depends on them.
 */
function playbackForEntitlement(
  entitlement: Entitlement,
  signInEmail: string | null | undefined,
  membershipContactEmail: string | null | undefined,
  resetEligible: boolean | undefined,
  resetUrl: string | null | undefined,
): GatedPlaybackResult {
  if (!isConsistent(entitlement)) return unreadableRecord();

  switch (entitlement.state) {
    case "active":
    case "grace":
      return { render: { mode: "play" }, grantAccess: true, retryable: false };
    case "malformed":
      return unreadableRecord();
    case "expired":
      // A located, lapsed membership: MVault found this identity's record and its
      // benefit window is over. Reset relinks accounts; it cannot restore an expired
      // benefit, so an email mismatch does not change the honest next step — renew. The
      // base notice already adds "or sign in with the account on your membership", which
      // covers the member whose still-active membership is under a different email
      // without a misleading "reset your Passport" prompt. So expired never offers reset.
      return {
        render: {
          mode: "notEntitled",
          state: entitlement.state,
          notice: GATED_NOT_ENTITLED_NOTICE,
        },
        grantAccess: false,
        retryable: false,
      };
    case "inactive": {
      // `inactive` also includes provisional and not-yet-started memberships, so
      // this policy cannot infer reset eligibility from the collapsed state alone.
      // Require the credentialed slice that reads the source record to verify a
      // genuine identity miss. The email comparison and configured URL remain
      // independent fail-closed checks.
      const reset = passportResetOffer(
        entitlement,
        signInEmail,
        membershipContactEmail,
        resetEligible,
        resetUrl,
      );
      return {
        render: reset
          ? {
              mode: "notEntitled",
              state: entitlement.state,
              notice: GATED_PASSPORT_RESET_NOTICE,
              reset,
            }
          : {
              mode: "notEntitled",
              state: entitlement.state,
              notice: GATED_NOT_ENTITLED_NOTICE,
            },
        grantAccess: false,
        retryable: false,
      };
    }
    default: {
      // Exhaustiveness: entitlement narrows to `never` here because every
      // EntitlementState is handled above, so adding a state without a case makes
      // this assignment a compile error instead of a silent miss.
      //
      // Unlike the other uses of this idiom in the codebase, this branch IS
      // reachable at runtime. The record is mapped from live MVault JSON at a
      // credentialed boundary, so a state string outside the union — a value a newer
      // MVault starts returning — can arrive whatever the type says. Falling out of
      // the switch would return undefined and crash the island; denying with the
      // unreadable notice is the fail-closed answer.
      const unreachable: never = entitlement;
      void unreachable;
      return unreadableRecord();
    }
  }
}

/**
 * Resolve what the gated island renders, whether to grant access, and whether to
 * retry, from the outcome of the live auth + entitlement attempt.
 *
 * Total and pure: it returns a render for every signal, never throws, and never
 * mutates its input. Fail-closed — only a `resolved` signal whose entitlement is
 * both entitled and in a streaming state grants access; a not-entitled
 * verdict, a signed-out visitor, and every outage all deny and show an honest island
 * state. An outage serves no cached entitlement,
 * so an unreachable upstream reads as unauthenticated rather than as access.
 *
 * `options.passportResetUrl` enables the Passport Reset offer on a denied mismatch.
 * With no options the not-entitled render is the bare renew notice, unchanged.
 */
export function resolveGatedPlayback(
  signal: GatedPlaybackSignal,
  options: GatedPlaybackOptions = {},
): GatedPlaybackResult {
  switch (signal.kind) {
    case "resolved":
      return playbackForEntitlement(
        signal.entitlement,
        signal.signInEmail,
        signal.membershipContactEmail,
        signal.passportResetEligible,
        options.passportResetUrl,
      );
    case "signedOut":
      return {
        render: { mode: "signIn", notice: GATED_SIGN_IN_NOTICE },
        grantAccess: false,
        retryable: false,
      };
    case "outage":
      return {
        render: {
          mode: "unavailable",
          layer: signal.layer,
          notice: unavailableNotice(signal.layer, signal.status),
        },
        grantAccess: false,
        retryable: isRetryableFailure(signal.status),
      };
  }
}
