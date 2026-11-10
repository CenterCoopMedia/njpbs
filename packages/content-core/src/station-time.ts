// Moving an editorial instant between how it is stored and how a person edits it.
//
// The two ends are already decided, in code, and this module only connects them.
// Storage is an absolute UTC instant: `parsePublishInstant` requires the trailing
// `Z` and the build-time publish gate (#465) drops any record it cannot read
// exactly, so a value that is not a real UTC instant fails closed and the record
// never ships. Display is station time: `America/New_York` is what the schedule
// feed, entitlement windows, and the Media Manager gate all use when they turn
// an instant into something a person reads.
//
// Without this pair the editor cannot honour both. `<input type="datetime-local">`
// speaks a bare wall-clock string with no zone, and the browser's own
// interpretation of one is the machine's local zone, which is right only for an
// editor sitting in New Jersey. An editor travelling, or a contractor in another
// state, would set an event to 8 PM and store 8 PM in their zone.
//
// TVSS and editorial controls share the zone arithmetic here. Each caller keeps
// its own transition policy: editors move a skipped time forward, while TVSS
// rejects it and uses listing order to select a repeated time.

import { parsePublishInstant } from "./publish-instant.ts";

/**
 * The zone an NJ PBS editor works in. Every surface that renders an instant for a
 * person already uses this zone, so an editor reads the same wall-clock time in
 * the CMS that a visitor reads on the site.
 */
export const STATION_TIME_ZONE = "America/New_York";

/** The shape `<input type="datetime-local">` reads and writes: no zone, no seconds. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** The calendar and clock fields of an instant as they read in `timeZone`. */
export function zonedParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const fields = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
  if (Object.values(fields).some((value) => !value)) {
    throw new Error(`Could not format a date in ${timeZone}.`);
  }
  return fields;
}

/**
 * How far `timeZone` is from UTC at `instant`, in minutes. Derived by asking the
 * zone what wall-clock time the instant reads as and measuring the gap, so it
 * follows daylight saving without a table of transition dates.
 */
export function offsetMinutes(instant: number, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asIfUtc - instant) / 60_000);
}

/**
 * Instants for a validated YYYY-MM-DD date and HHMM time in a named zone.
 * Return unique candidates in time order: one normally, two in a repeated hour,
 * and none in a skipped hour. The caller decides how to handle those cases.
 */
export function zonedLocalInstants(
  date: string,
  time: string,
  timeZone: string,
): number[] {
  const [year, month, day] = date.split("-").map(Number);
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2));
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // A day either side samples both offsets around a station-time transition.
  const offsets = new Set(
    [-24, 0, 24].map((hours) =>
      offsetMinutes(localAsUtc + hours * 3_600_000, timeZone),
    ),
  );
  const expected = `${date}T${time.slice(0, 2)}:${time.slice(2)}:00`;
  return Array.from(offsets)
    .map((offset) => localAsUtc - offset * 60_000)
    .filter((instant) => {
      const parts = zonedParts(instant, timeZone);
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` === expected;
    })
    .sort((a, b) => a - b);
}

/**
 * Render a stored instant as the local date and time a `datetime-local` control
 * reads, in station time. Returns "" for anything the publish gate cannot read,
 * so a blank scheduling field and an unreadable one look the same in the editor
 * as they do to the gate.
 *
 * Readable is decided by `parsePublishInstant`, not by `new Date`, and which
 * records that matters for depends on the field.
 *
 * `publishAt` never reaches storage as a bare day: `normalizePublishAt` in
 * `functions/lib/content-metadata.js` turns the old date control's `"2026-07-24"`
 * into `"2026-07-24T00:00:00.000Z"` before it is written. So a legacy article
 * holds a real instant, the gate has always accepted it, and it renders here as
 * 8 PM on the 23rd in station time. That is the truth about what was stored, and
 * it is the harm the old control did: it moved the record to the evening before.
 *
 * An event's `startsAt` and `endsAt` have no such server normalizer, so a legacy
 * one really can hold `"2026-08-01"`. `new Date` would read that as UTC midnight
 * and show an editor 8 PM on July 31st, a wrong day stated confidently enough to
 * be corrected into a real schedule. Showing nothing says the true thing instead:
 * this field holds no instant and has to be set again.
 */
export function instantToStationLocal(
  value: unknown,
  timeZone: string = STATION_TIME_ZONE,
): string {
  if (typeof value !== "string") return "";
  const instant = parsePublishInstant(value);
  if (instant === null) return "";
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * Turn the local date and time an editor picked into the stored UTC instant.
 *
 * Returns null for a string that is not a well-formed local date-time or that
 * names a day the calendar does not have, so a caller can leave the stored value
 * alone rather than overwrite a good instant with a broken one.
 *
 * Seconds land on zero, because the control has no seconds to offer. An imported
 * instant of 20:00:30 that an editor then edits comes back 20:00:00. Nothing
 * editorial schedules to the second, and the alternative is carrying a hidden
 * remainder an editor cannot see or change.
 *
 * Daylight saving makes two wall-clock times special, and both are resolved here
 * rather than left to the caller:
 *
 * - The hour that repeats each autumn names two instants. The earlier one wins,
 *   which is the reading a person means by "1:30 that morning".
 * - The hour that is skipped each spring names none. Rather than refuse a time an
 *   editor can reach with two clicks, the clock is carried forward by the length
 *   of the gap, so 2:30 becomes 3:30 and re-renders that way in the control.
 */
export function stationLocalToInstant(
  local: string,
  timeZone: string = STATION_TIME_ZONE,
): string | null {
  const match = typeof local === "string" ? local.match(LOCAL_DATE_TIME) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);

  // A year still being typed is not a year. The control fills the segment a digit
  // at a time, so 2026 arrives as 0002, then 0020, then 0202, and the third of
  // those is a date the round-trip check below would happily accept and store as
  // the year 202. Nothing editorial is scheduled before the first millennium.
  if (year < 1000) return null;

  // Reject a date the calendar does not have before doing any zone work. Date.UTC
  // rolls February 30th forward to March 2nd without complaint, and a silently
  // moved date is worse than a refused one.
  const check = new Date(asIfUtc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    return null;
  }

  const candidates = zonedLocalInstants(
    `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    `${pad(hour)}${pad(minute)}`,
    timeZone,
  );

  if (candidates.length > 0) {
    return new Date(candidates[0]).toISOString();
  }

  // The skipped hour. Reading the offset from before the transition puts the clock
  // past the gap by exactly its length.
  const before = offsetMinutes(asIfUtc - 24 * 3_600_000, timeZone);
  return new Date(asIfUtc - before * 60_000).toISOString();
}
