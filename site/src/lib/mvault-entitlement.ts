// Pure Passport entitlement policy over a freshly fetched MVault record.
// PMSSO authenticates the viewer; MVault authorizes the benefit. The decision
// uses status, offer, expiry, grace and timing fields at an explicit time. It
// performs no I/O and persists no membership state. Callers map raw API fields
// into this shape and supply the live record rather than a stored session copy.

/** MVault's own window verdict, when the API returns one. Authoritative. */
export type MVaultTiming =
  | "before_start"
  | "within_start_expire_dates"
  | "within_grace_period"
  | "expired";

/**
 * A member's live MVault `membership_info`, mapped to the site's camelCase shape.
 * MVault's own fields are snake_case: `expire_date` -> `expireDate`, `start_date`
 * -> `startDate`, and the grace-window end derived from `grace_period` ->
 * `graceThrough`. This mirrors `MembershipInfo` in pmsso-login.ts, which is
 * likewise the mapped view, not the raw MVault JSON. The snake_case -> camelCase
 * mapping is done at the credentialed fetch boundary, so this pure core stays in the site's own vocabulary. Only the
 * entitlement-bearing fields are modeled; extra MVault fields are ignored, so a
 * future addition cannot change the decision by default.
 */
export interface MVaultMembership {
  /** MVault On/Off. Compared case-insensitively; only "on" can entitle. */
  status: string;
  /** COVE benefit-window key. Absent/empty on a non-activated record. */
  offer?: string | null;
  /**
   * Active-window start, ISO calendar date (YYYY-MM-DD, from `start_date`). A
   * membership before its start date is not yet active even though it is inside
   * its expire window (MVault's `before_start`). Optional: many `membership_info`
   * reads omit it, and an absent start means no lower bound to enforce.
   */
  startDate?: string;
  /** Active-window end, ISO calendar date (YYYY-MM-DD, from `expire_date`). */
  expireDate?: string;
  /**
   * End of the grace window, ISO calendar date (YYYY-MM-DD; ~3 months past
   * `expireDate` in the spec's example, derived from `grace_period`). An in-grace
   * member still streams. Absent when the record carries no grace window.
   */
  graceThrough?: string;
  /** MVault's own window verdict; authoritative over the date math when present. */
  timing?: MVaultTiming;
  /** MVault provisional flag: a not-yet-activated placeholder membership. */
  provisional?: boolean;
}

/**
 * The two streaming states. Only these may carry `entitled: true`.
 */
export type EntitledState =
  | "active" // within the paid window
  | "grace"; // past expiry but within the grace window — still streams

/**
 * Every denying state. Only these may carry `entitled: false`.
 */
export type DeniedState =
  | "expired" // past the grace window
  | "inactive" // status Off, no offer, provisional, or before the start date — a non-member
  | "malformed"; // unreadable record or clock — fail closed

/**
 * The entitlement state, narrower than a bare boolean so a caller can tell an
 * in-grace member from an expired one and log the reason.
 */
export type EntitlementState = EntitledState | DeniedState;

/**
 * A decided entitlement. The boolean and the state are one fact, not two, so this
 * is a discriminated union rather than a record of independent fields: `entitled:
 * true` admits only a streaming state, and `entitled: false` admits only a denying
 * one. `{ entitled: true, state: "expired" }` does not type-check.
 *
 * The union is the primary defense, not the only one. This value crosses a
 * credentialed fetch boundary at runtime — the caller maps a JSON
 * record into this shape — and a type cannot police a value that enters the process
 * as JSON, so a mapper bug or an unchecked cast can still construct an inconsistent
 * pair. The playback gate therefore re-checks the state rather than trusting the
 * boolean, and fails closed on a disagreement (see `resolveGatedPlayback`).
 */
export type Entitlement =
  | { readonly entitled: true; readonly state: EntitledState }
  | { readonly entitled: false; readonly state: DeniedState };

/** MVault answers On/Off; only a case-insensitive "on" can entitle. */
function isOn(status: string): boolean {
  return typeof status === "string" && status.trim().toLowerCase() === "on";
}

/** A real benefit window. A non-activated record carries no offer. */
function hasOffer(offer: string | null | undefined): boolean {
  return typeof offer === "string" && offer.trim().length > 0;
}

/**
 * Validate a strict ISO calendar date (YYYY-MM-DD) and return it in canonical
 * form (trimmed), or null when it is absent, not date-only, or not a real
 * calendar date. Null is the fail-closed signal: the caller denies rather than
 * guessing at a window. Returning the string (not an instant) keeps the window
 * checks in the calendar-date domain, so they compare lexically against the
 * member's Eastern date with no instant/timezone ambiguity.
 *
 * The regex alone is too lenient for a security gate — it accepts "2026-02-31"
 * and "2026-02-29" in a non-leap year — so the digits are round-tripped through a
 * UTC Date and any rolled-over date is rejected. Date-only is required (MVault's
 * dates are date-only); a datetime with a zone offset fails the regex.
 */
function validDate(s: string | undefined): string | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

/**
 * The Eastern (America/New_York) calendar date of an epoch-ms instant, as a
 * YYYY-MM-DD string. MVault's dates are New Jersey calendar dates, and the repo's
 * other date-only windows compare Eastern dates (see `easternDateString` in
 * media-manager-gating.ts) so a UTC host does not flip a boundary at 8pm ET. This
 * gate does the same: a member whose window ends "2026-07-09" keeps access
 * through the whole New Jersey day, not until UTC midnight. Kept local so the
 * entitlement core stays dependency-free.
 */
function easternDate(now: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Decide Passport entitlement from a live MVault record at time `now` (epoch ms).
 *
 * Fail-closed throughout: a broken clock, a status that is not On, a missing
 * offer, a provisional record, or an unreadable date all deny. Entitlement
 * requires MVault to say On AND a benefit offer AND the current time to fall in
 * the active window or the grace window — never merely that a `membership_info`
 * block exists. MVault's own `timing` verdict wins when present; the
 * `expireDate`/`graceThrough` dates are the fallback when it is not.
 */
export function evaluateEntitlement(
  m: MVaultMembership,
  now: number,
): Entitlement {
  // A broken clock cannot decide a time window: deny.
  if (!Number.isFinite(now)) return { entitled: false, state: "malformed" };

  // Non-member gates. A provisional (not-yet-activated) record, a status that is
  // not On, or a record with no benefit offer is not a member — regardless of
  // any dates on the record.
  if (m.provisional === true) return { entitled: false, state: "inactive" };
  if (!isOn(m.status) || !hasOffer(m.offer)) {
    return { entitled: false, state: "inactive" };
  }

  // Window. MVault's own verdict is authoritative when it returns one; an
  // unrecognized timing string falls through to the date math below.
  switch (m.timing) {
    case "within_start_expire_dates":
      return { entitled: true, state: "active" };
    case "within_grace_period":
      return { entitled: true, state: "grace" };
    case "expired":
      return { entitled: false, state: "expired" };
    case "before_start":
      return { entitled: false, state: "inactive" };
  }

  // No usable timing verdict: derive the window from the record's dates, compared
  // as New Jersey calendar days (see easternDate). Date-only YYYY-MM-DD strings
  // sort lexically, so a string compare is an inclusive whole-day check with no
  // instant/timezone ambiguity.
  const expire = validDate(m.expireDate);
  // On + offer but no readable expiry is an unreadable record: fail closed.
  if (expire === null) return { entitled: false, state: "malformed" };
  const todayET = easternDate(now);

  // A membership before its start date is not yet active, even inside its expire
  // window — MVault's before_start state, which the date fallback must enforce
  // too. The start day is inclusive, so deny only when today is before it. An
  // absent start imposes no lower bound; a present-but-unreadable start is an
  // unreadable record, so it fails closed.
  if (m.startDate !== undefined) {
    const start = validDate(m.startDate);
    if (start === null) return { entitled: false, state: "malformed" };
    if (todayET < start) return { entitled: false, state: "inactive" };
  }

  // The window ends are inclusive of their named day: a member whose expireDate is
  // today still streams, and grace runs through the end of the graceThrough day.
  if (todayET <= expire) return { entitled: true, state: "active" };
  const grace = validDate(m.graceThrough);
  if (grace !== null && todayET <= grace) {
    return { entitled: true, state: "grace" };
  }
  return { entitled: false, state: "expired" };
}

/** Trim/lowercase an email for comparison, or null when it is absent/blank. */
function normEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const t = email.trim().toLowerCase();
  return t === "" ? null : t;
}

/**
 * Whether the signed-in identity's email differs from the contact email on the
 * MVault membership. This is the common support-ticket failure: a member signs
 * in with a PBS Account whose email is not the one on their donation record, so
 * the live lookup finds no entitlement for the identity in use. Returns false
 * when either email is missing — a mismatch cannot be asserted without both.
 */
export function identityMismatch(
  signInEmail: string | null | undefined,
  membershipContactEmail: string | null | undefined,
): boolean {
  const a = normEmail(signInEmail);
  const b = normEmail(membershipContactEmail);
  if (a === null || b === null) return false;
  return a !== b;
}

/**
 * Whether to offer the PBS "Passport Reset" path instead of a bare denial. Only
 * when the member is not entitled AND the sign-in vs contact emails differ: a
 * mismatch is the likely cause of the miss, so the site surfaces the signed-in
 * identity and the reset path (re-link the membership to the account in use)
 * rather than silently denying. The reset URL is runtime config, not hard-coded
 * here. An entitled member is never offered a reset.
 *
 * This reads the boolean without re-checking the state, unlike the playback gate.
 * The reset path is offered only from the `notEntitled` island,
 * and `resolveGatedPlayback` routes a record whose halves disagree to the unavailable
 * island before reaching it, so no inconsistent record gets this far. The direction
 * is also the safe one — a stray `entitled: true` withholds a reset offer rather than
 * granting anything.
 */
export function passportResetOffered(
  entitlement: Entitlement,
  signInEmail: string | null | undefined,
  membershipContactEmail: string | null | undefined,
): boolean {
  return (
    !entitlement.entitled &&
    identityMismatch(signInEmail, membershipContactEmail)
  );
}
