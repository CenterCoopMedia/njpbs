// Display-safe schedule types and now/next derivation for the TVSS-backed
// schedule island and the /live now-next strip (#188).
//
// The types here are the shape the browser is allowed to see. The server-side
// proxy (a Firebase Cloud Function that holds the TVSS X-PBSAUTH key) reads the
// upstream TVSS listings and returns only these fields, so the key and any upstream-only
// metadata never reach the client. Both the interactive island and the
// build-time static grid render from this same model and call the same
// derivation, so the "on now" highlight and the /live strip cannot disagree
// about where the boundary between two programs falls.
//
// deriveNowNext is pure and holds no live-key or runtime dependency, so it is
// buildable and testable in this static repo today; the TVSS-to-model transform
// and the caching proxy that produce a ScheduleDay are the separate proxy-runtime
// slice of #188 (blocked on the proxy and Secret Manager issues, and on the
// blocked:external PBS-credentials issue for the key itself).

/** One broadcast on one channel: only the fields the schedule UI displays. */
export interface ScheduleEntry {
  /** Program start as ISO 8601 with an offset, e.g. 2026-07-06T20:00:00-04:00. */
  readonly startsAt: string;
  /**
   * Program end as ISO 8601 with an offset. Always present: the proxy fills it
   * from the following listing's start (or the listing's own length) so the
   * client never has to infer where a program ends.
   */
  readonly endsAt: string;
  /** Series title, e.g. "Nature". */
  readonly title: string;
  /** Episode title when the listing carries one, e.g. "Silent Roar". */
  readonly episodeTitle?: string;
}

/** One channel-day of listings, ascending by startsAt and non-overlapping. */
export interface ScheduleDay {
  /** Broadcast day as YYYY-MM-DD in the station's local zone. */
  readonly date: string;
  /** Station callsign the listings are for, lowercased, e.g. "njtv". */
  readonly callsign: string;
  /** The day's listings, ascending by startsAt, non-overlapping. */
  readonly entries: readonly ScheduleEntry[];
}

/** What the /live now-next strip shows: the program on air and the one after. */
export interface NowNext {
  /**
   * The entry whose half-open interval [startsAt, endsAt) contains the query
   * instant, or null in a gap between listings, before the first, or after the
   * last.
   */
  readonly onNow: ScheduleEntry | null;
  /**
   * The program that follows onNow (or the next one due when nothing is on
   * air), or null when the day has no later listing.
   */
  readonly upNext: ScheduleEntry | null;
}

/**
 * Resolve the on-air and up-next programs for `at` within one day's listings.
 *
 * `onNow` is the entry whose half-open interval [startsAt, endsAt) contains
 * `at`. Half-open on purpose: a program that ends exactly at `at` has already
 * handed the air off to the next one, so the boundary instant belongs to the
 * incoming program, not the outgoing one.
 *
 * `upNext` is the earliest entry that starts at or after the current
 * program's end. When nothing is on air (an empty day, a gap between listings,
 * or an instant before the first or after the last), it is instead the earliest
 * entry that starts at or after `at`. Anchoring to the current program's end
 * rather than to `at` keeps the on-air program itself from being reported as
 * its own "up next" when `at` lands exactly on its start.
 *
 * Both fields are null when the day supplies no matching entry.
 *
 * ScheduleDay documents its entries as sorted and non-overlapping, but this
 * scans linearly and takes the earliest qualifying start rather than trusting
 * the order: a day is short, and a mis-sorted upstream payload should degrade to
 * a correct-but-linear answer instead of a wrong one. Listings whose timestamps
 * do not parse, or whose end is not after their start, are skipped so a bad
 * record cannot match as on-air or mis-order up-next.
 */
export function deriveNowNext(day: ScheduleDay, at: Date): NowNext {
  const t = at.getTime();

  // Parse once, and drop any listing without a valid, positive-length interval.
  const timed = day.entries
    .map((entry) => ({
      entry,
      start: Date.parse(entry.startsAt),
      end: Date.parse(entry.endsAt),
    }))
    .filter(
      ({ start, end }) =>
        !Number.isNaN(start) && !Number.isNaN(end) && end > start,
    );

  const current = timed.find(({ start, end }) => t >= start && t < end) ?? null;

  // up-next begins at or after the current program's end, or after `at` when
  // nothing is on air.
  const threshold = current ? current.end : t;
  let next: (typeof timed)[number] | null = null;
  for (const item of timed) {
    if (item.start >= threshold && (next === null || item.start < next.start)) {
      next = item;
    }
  }

  return {
    onNow: current?.entry ?? null,
    upNext: next?.entry ?? null,
  };
}
