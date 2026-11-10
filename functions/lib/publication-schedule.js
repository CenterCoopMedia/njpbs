// Mirror of packages/content-core/src/publication-schedule.ts; parity is tested.
// Scheduling uses New York calendar months, not a fixed 30-day duration.
const PUBLICATION_TIME_ZONE = "America/New_York";

const stationClock = new Intl.DateTimeFormat("en-US", {
  timeZone: PUBLICATION_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function localTimestamp(instant) {
  const parts = stationClock.formatToParts(instant);
  const read = (type) => Number(parts.find(part => part.type === type)?.value);
  return Date.UTC(read("year"), read("month") - 1, read("day"),
    read("hour"), read("minute"), read("second"), new Date(instant).getUTCMilliseconds());
}

/** Same New York clock time next month, clamped to that month's last day.
 * At a skipped clock time the ceiling moves forward by the gap; at a repeated
 * time it includes both occurrences. The editor must still choose an actual
 * instant explicitly; this disambiguation only defines the upper boundary.
 */
function publicationScheduleDeadline(now) {
  const local = new Date(localTimestamp(now));
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const target = Date.UTC(year, month, Math.min(local.getUTCDate(), lastDay),
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds());
  const day = 86_400_000;
  const offsets = [...new Set([-day, 0, day].map(delta =>
    localTimestamp(target + delta) - (target + delta)))];
  const candidates = offsets.map(offset => target - offset)
    .filter(instant => localTimestamp(instant) === target);
  return candidates.length ? Math.max(...candidates)
    : target - (localTimestamp(target - day) - (target - day));
}

function publicationScheduleError(instant, now) {
  if (!Number.isFinite(instant) || !Number.isFinite(now)) return "Choose a valid publication time.";
  if (instant <= now) return "Scheduled publication must be in the future.";
  if (instant > publicationScheduleDeadline(now)) {
    return "Schedule publication no more than one calendar month ahead in New York time.";
  }
  return null;
}

module.exports = { PUBLICATION_TIME_ZONE, publicationScheduleDeadline, publicationScheduleError };
