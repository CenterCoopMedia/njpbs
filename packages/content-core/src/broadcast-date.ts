// The one definition of a broadcast day's date, for everything in site/src/lib
// that reads one (#753).
//
// A schedule day carries its date as ISO YYYY-MM-DD, and both places that render
// a day parse it as `new Date(`${value}T12:00:00Z`)` — schedule-timeline.ts and
// NativeSchedule.astro. Any other shape is an Invalid Date there, which renders
// as "Date unavailable" over a generic 24-hour grid without throwing or logging.
// A validator that only checks "non-empty string" therefore passes the exact
// value that breaks the render, which is how #753 happened: the static feed
// validated properly and the proxy contract did not, because each had written
// its own check.
//
// TVSS's own dashless YYYYMMDD is the shape that actually shows up, since that is
// what the proxy is called with, so it is the case worth being strict about.

const BROADCAST_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True when `value` is an ISO YYYY-MM-DD naming a day that exists.
 *
 * The calendar round-trip is the part worth keeping: `Date.UTC(2026, 8, 31)`
 * silently rolls Sep 31 into Oct 1 rather than throwing, so a shape check alone
 * accepts days that never happened. Comparing the constructed date's fields back
 * against the parsed input is what rejects those.
 */
export function isBroadcastDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(BROADCAST_DATE_PATTERN);
  if (!match) return false;
  const [, year, month, day] = match;
  const asDate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  return (
    asDate.getUTCFullYear() === Number(year) &&
    asDate.getUTCMonth() + 1 === Number(month) &&
    asDate.getUTCDate() === Number(day)
  );
}

/**
 * Throwing form, for the build-time paths that would rather fail loudly than
 * emit a day nobody can render. The predicate is the primitive; this exists so a
 * caller that cannot usefully continue does not have to write the throw itself.
 */
export function assertBroadcastDate(value: string): void {
  if (!isBroadcastDate(value)) {
    throw new Error(`Invalid broadcast date: ${value}`);
  }
}
