// What a stored `publishAt` string means, and where it becomes a number.
//
// `EditorialBase.publishAt` is an ISO-8601 string; the editorial workflow core
// (#202) speaks epoch-ms numbers and refuses date strings on purpose. Every read
// boundary that carries a record toward the core therefore has to parse, and each
// one that grew its own parser would be free to disagree about which strings are
// real instants. This module is the single definition for the site's TypeScript
// read boundaries, so the build-time publish gate (#465) and the workflow
// projection (#519) can never drift on the question.
//
// Cloud Functions cannot import this TypeScript module from their deploy bundle,
// so functions/lib/publish-instant.js is the CommonJS mirror used by every
// Functions caller. Keep both contracts and their tests aligned when the accepted
// shape changes.
//
// The strictness is the point. A plain `Date.parse` accepts an impossible calendar
// date and rolls it forward (Feb 30 becomes Mar 2) and reads a zone-less value in
// whatever timezone the machine happens to be in, so the same record would cross
// its publish time at different wall-clock moments across build environments. Both
// callers gate visibility, so both fail closed on anything they cannot read exactly.

/**
 * An absolute UTC ISO-8601 instant: a full date-time ending in `Z`, with the
 * milliseconds optional. The `Z` is required deliberately, since a zone-less value
 * carries no instant at all until someone picks a zone for it. `Date#toISOString`
 * emits this form (always with three-digit milliseconds), and that is what the
 * write boundary stores.
 */
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Parse a stored `publishAt` to epoch milliseconds, or null if it is not a real
 * absolute instant. The value is matched against the strict UTC shape and rebuilt
 * with `Date.UTC`; every calendar field must survive the round trip, which is what
 * rejects an impossible date rather than silently moving it.
 *
 * Returns null rather than throwing: both callers are scanning stored rows, where
 * one bad value should exclude that row, not abort the batch.
 */
export function parsePublishInstant(value: string): number | null {
  // A stored row is untrusted at runtime whatever the type says; a non-string would
  // throw off .match() and take out the whole scan.
  if (typeof value !== "string") return null;
  const match = value.match(UTC_INSTANT);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millis] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  const ms = millis ? Number(millis.padEnd(3, "0")) : 0;
  const instant = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const roundTrip = new Date(instant);
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== mo - 1 ||
    roundTrip.getUTCDate() !== d ||
    roundTrip.getUTCHours() !== h ||
    roundTrip.getUTCMinutes() !== mi ||
    roundTrip.getUTCSeconds() !== s
  ) {
    return null;
  }
  return instant;
}
