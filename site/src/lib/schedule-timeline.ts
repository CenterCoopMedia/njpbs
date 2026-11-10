import type { ScheduleListing } from "./schedule-feed.ts";
import { SCHEDULE_TIME_ZONE } from "./schedule-view.ts";

const MINUTE_MS = 60_000;

export const PRIMETIME_START_MINUTE = 20 * 60;
export const PRIMETIME_END_MINUTE = 23 * 60;

export interface ScheduleTimelineRow {
  readonly listing: ScheduleListing;
  readonly startMinute: number;
  readonly durationMinutes: number;
}

export interface ScheduleRowHeightOptions {
  readonly startMinute: number;
  readonly durationMinutes: number;
  readonly nextStartMinute: number | null;
  readonly pixelsPerMinute: number;
  readonly minHeightPx: number;
}

export interface ScheduleHourMark {
  readonly hour: number;
  readonly minute: number;
  readonly label: string;
}

const timePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const dateLabelFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
});

export function easternStartMinute(timestamp: string): number {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return Number.NaN;

  const parts = zonedParts(instant.getTime());
  const dayStart = zonedLocalHourInstant(
    `${parts.year}-${parts.month}-${parts.day}`,
    0,
  );
  return Number.isFinite(dayStart)
    ? (instant.getTime() - dayStart) / MINUTE_MS
    : Number.NaN;
}

export function scheduleDurationMinutes(
  startsAt: string,
  endsAt: string,
): number {
  return (Date.parse(endsAt) - Date.parse(startsAt)) / MINUTE_MS;
}

export function formatScheduleTime(timestamp: string): string {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return "Time unavailable";
  return normalizeDayPeriod(timePartsFormatter.format(instant));
}

export function formatScheduleRange(
  listing: Pick<ScheduleListing, "startsAt" | "endsAt">,
): string {
  const start = formatScheduleTime(listing.startsAt);
  const end = formatScheduleTime(listing.endsAt);
  const startPeriod = dayPeriod(start);
  const endPeriod = dayPeriod(end);
  const conciseStart = startPeriod === endPeriod
    ? start.replace(/\s(?:a\.m\.|p\.m\.)$/, "")
    : start;
  return `${conciseStart}–${end} ET`;
}

export function formatScheduleDateLabel(value: string | Date): string {
  const instant = typeof value === "string"
    ? new Date(`${value}T12:00:00Z`)
    : value;
  if (Number.isNaN(instant.getTime())) return "Date unavailable";
  return dateLabelFormatter.format(instant);
}

export function buildScheduleHourMarks(date: string): readonly ScheduleHourMark[] {
  const dayStart = zonedLocalHourInstant(date, 0);
  const dayLength = scheduleDayLengthMinutes(date);
  if (!Number.isFinite(dayStart) || !Number.isFinite(dayLength)) {
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      minute: hour * 60,
      label: formatWallHour(hour),
    }));
  }

  return Array.from({ length: Math.ceil(dayLength / 60) }, (_, index) => {
    const minute = index * 60;
    const instant = dayStart + minute * MINUTE_MS;
    const parts = zonedParts(instant);
    return {
      hour: Number(parts.hour),
      minute,
      label: formatScheduleTime(new Date(instant).toISOString()),
    };
  });
}

export function scheduleDayLengthMinutes(date: string): number {
  const dayStart = zonedLocalHourInstant(date, 0);
  const nextDayStart = zonedLocalHourInstant(nextDateKey(date), 0);
  return Number.isFinite(dayStart) && Number.isFinite(nextDayStart)
    ? (nextDayStart - dayStart) / MINUTE_MS
    : Number.NaN;
}

export function scheduleTimelineDurationMinutes(date: string): number {
  return scheduleDayLengthMinutes(date);
}

export function scheduleLocalHourMinute(date: string, hour: number): number {
  const dayStart = zonedLocalHourInstant(date, 0);
  const instant = zonedLocalHourInstant(date, hour);
  return Number.isFinite(dayStart) && Number.isFinite(instant)
    ? (instant - dayStart) / MINUTE_MS
    : Number.NaN;
}

export function scheduleRowHeightPx(
  options: ScheduleRowHeightOptions,
): number {
  const proportionalHeight =
    options.durationMinutes * options.pixelsPerMinute - 2;
  const preferredHeight = Math.max(options.minHeightPx, proportionalHeight);
  if (
    options.nextStartMinute === null ||
    !Number.isFinite(options.nextStartMinute) ||
    options.nextStartMinute <= options.startMinute
  ) {
    return preferredHeight;
  }

  const availableHeight =
    (options.nextStartMinute - options.startMinute) * options.pixelsPerMinute -
    2;
  return Math.max(0, Math.min(preferredHeight, availableHeight));
}

export function buildScheduleRows(
  listings: readonly ScheduleListing[],
): readonly ScheduleTimelineRow[] {
  return listings.flatMap((listing) => {
    const startMinute = easternStartMinute(listing.startsAt);
    const durationMinutes = scheduleDurationMinutes(
      listing.startsAt,
      listing.endsAt,
    );
    if (
      !Number.isFinite(startMinute) ||
      !Number.isFinite(durationMinutes) ||
      durationMinutes <= 0
    ) {
      return [];
    }
    return [{ listing, startMinute, durationMinutes }];
  });
}

function normalizeDayPeriod(value: string): string {
  return value.replace(/\sAM$/, " a.m.").replace(/\sPM$/, " p.m.");
}

function dayPeriod(value: string): string | null {
  return value.match(/(?:a\.m\.|p\.m\.)$/)?.[0] ?? null;
}

function zonedLocalHourInstant(date: string, hour: number): number {
  const parts = dateParts(date);
  if (!parts) return Number.NaN;

  const { year, month, day } = parts;
  const localAsUtc = Date.UTC(year, month - 1, day, hour);
  const expected = `${date}T${pad(hour)}:00:00`;
  const offsets = new Set(
    [-12, 0, 12].map((offsetHour) =>
      timeZoneOffsetMinutes(localAsUtc + offsetHour * 60 * MINUTE_MS),
    ),
  );

  const instants = Array.from(offsets)
    .map((offsetMinutes) => localAsUtc - offsetMinutes * MINUTE_MS)
    .filter((instant) => zonedDateTimeKey(instant) === expected)
    .sort((a, b) => a - b);

  return instants[0] ?? Number.NaN;
}

function nextDateKey(date: string): string {
  const parts = dateParts(date);
  if (!parts) return "";
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

function dateParts(
  date: string,
): { readonly year: number; readonly month: number; readonly day: number } | null {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function timeZoneOffsetMinutes(instant: number): number {
  const parts = zonedParts(instant);
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((representedAsUtc - instant) / MINUTE_MS);
}

function zonedDateTimeKey(instant: number): string {
  const parts = zonedParts(instant);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function zonedParts(instant: number): Record<string, string> {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date(instant))
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
}

function formatWallHour(hour: number): string {
  const displayHour = hour % 12 || 12;
  return `${displayHour}:00 ${hour < 12 ? "a.m." : "p.m."}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
