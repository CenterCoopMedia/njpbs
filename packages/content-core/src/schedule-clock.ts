import { deriveNowNext, type ScheduleDay, type ScheduleEntry } from "./schedule-now-next.ts";
import { STATION_TIME_ZONE } from "./station-time";

export const SCHEDULE_TIME_ZONE = STATION_TIME_ZONE;

const ABSOLUTE_ISO_TIMESTAMP =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export interface ScheduleClockState {
  readonly date: string;
  readonly onNow: ScheduleEntry | null;
  readonly upNext: ScheduleEntry | null;
  readonly elapsedMinutes: number;
  readonly remainingMinutes: number;
  readonly progressPercent: number;
}

export function scheduleDateKey(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(at)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function resolveScheduleClock(
  realNow: Date,
  mockTime?: string | null,
): Date {
  if (mockTime) {
    const match = mockTime.match(ABSOLUTE_ISO_TIMESTAMP);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const calendarDate = new Date(0);
      calendarDate.setUTCHours(0, 0, 0, 0);
      calendarDate.setUTCFullYear(year, month - 1, day);
      const parsed = Date.parse(mockTime);
      if (
        calendarDate.getUTCFullYear() === year &&
        calendarDate.getUTCMonth() === month - 1 &&
        calendarDate.getUTCDate() === day &&
        !Number.isNaN(parsed)
      ) {
        return new Date(parsed);
      }
    }
  }

  return new Date(realNow.getTime());
}

export function getScheduleClockState(
  days: readonly ScheduleDay[],
  at: Date,
): ScheduleClockState | null {
  const date = scheduleDateKey(at);
  const day = days.find((candidate) => candidate.date === date);
  if (!day) return null;

  const nowNext = deriveNowNext(day, at);
  const onNow =
    day.entries.find((entry) => entry === nowNext.onNow) ?? null;
  const upNext =
    day.entries.find((entry) => entry === nowNext.upNext) ?? null;

  if (!onNow) {
    return {
      date,
      onNow: null,
      upNext,
      elapsedMinutes: 0,
      remainingMinutes: 0,
      progressPercent: 0,
    };
  }

  const now = at.getTime();
  const start = Date.parse(onNow.startsAt);
  const end = Date.parse(onNow.endsAt);
  const duration = end - start;

  return {
    date,
    onNow,
    upNext,
    elapsedMinutes: (now - start) / 60_000,
    remainingMinutes: (end - now) / 60_000,
    progressPercent: ((now - start) / duration) * 100,
  };
}
