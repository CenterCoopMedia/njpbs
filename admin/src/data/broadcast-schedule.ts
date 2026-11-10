export type AiringStatus = "scheduled" | "preempted";
export type EpisodeDetailsStatus = "provided" | "pending";

export interface BroadcastAiring {
  date: string;
  detailsStatus: EpisodeDetailsStatus;
  episode: string;
  premiere: boolean;
  program: string;
  station: string;
  status: AiringStatus;
  time: string;
  title: string;
}

export interface BroadcastScheduleSource {
  coverageEnd: string;
  coverageStart: string;
  label: string;
  received: string;
  timezone: string;
}

export interface BroadcastSchedule {
  airings: readonly BroadcastAiring[];
  source: BroadcastScheduleSource;
}

export interface BroadcastDay {
  airings: BroadcastAiring[];
  date: string;
  withinCoverage: boolean;
}

function dateAtNoon(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = dateAtNoon(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addScheduleDays(value: string, days: number): string {
  const next = dateAtNoon(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export function scheduleWeekStart(value: string): string {
  const current = dateAtNoon(value);
  const day = current.getUTCDay();
  current.setUTCDate(current.getUTCDate() - (day === 0 ? 6 : day - 1));
  return current.toISOString().slice(0, 10);
}

export function scheduleWeekStarts(source: BroadcastScheduleSource): string[] {
  const first = scheduleWeekStart(source.coverageStart);
  const last = scheduleWeekStart(source.coverageEnd);
  const weeks: string[] = [];
  for (let week = first; week <= last; week = addScheduleDays(week, 7)) {
    weeks.push(week);
  }
  return weeks;
}

export function scheduleWeekForDate(
  source: BroadcastScheduleSource,
  today: string,
  requested?: string | null,
): string {
  const weeks = scheduleWeekStarts(source);
  if (requested && isDateKey(requested)) {
    const requestedWeek = scheduleWeekStart(requested);
    return weeks.find((week) => week >= requestedWeek) ?? weeks.at(-1) ?? requestedWeek;
  }
  const current = scheduleWeekStart(today);
  if (weeks.includes(current)) return current;
  return weeks.find((week) => week > current) ?? weeks.at(-1) ?? current;
}

export function scheduleDaysForWeek(
  schedule: BroadcastSchedule,
  weekStart: string,
): BroadcastDay[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addScheduleDays(weekStart, index);
    return {
      date,
      airings: schedule.airings.filter((airing) => airing.date === date),
      withinCoverage:
        date >= schedule.source.coverageStart && date <= schedule.source.coverageEnd,
    };
  });
}

export function adjacentScheduleWeek(
  source: BroadcastScheduleSource,
  weekStart: string,
  direction: -1 | 1,
): string | null {
  const weeks = scheduleWeekStarts(source);
  const index = weeks.indexOf(weekStart);
  if (index === -1) return null;
  return weeks[index + direction] ?? null;
}

export function validateBroadcastSchedule(schedule: BroadcastSchedule): void {
  const { airings, source } = schedule;
  if (
    !isDateKey(source.coverageStart) ||
    !isDateKey(source.coverageEnd) ||
    source.coverageStart > source.coverageEnd ||
    !isDateKey(source.received) ||
    !source.label ||
    !source.timezone
  ) {
    throw new Error("Broadcast schedule source is invalid");
  }

  const seen = new Set<string>();
  for (const airing of airings) {
    if (airing.date < source.coverageStart || airing.date > source.coverageEnd) {
      throw new Error(`Broadcast date is outside the source coverage: ${airing.date}`);
    }
    if (!airing.program || !airing.episode || !airing.station || !airing.time || !airing.title) {
      throw new Error(`Broadcast entry is incomplete: ${airing.date}`);
    }
    const key = [
      airing.date,
      airing.time,
      airing.station,
      airing.program,
      airing.episode,
    ].join("|");
    if (seen.has(key)) throw new Error(`Duplicate broadcast entry: ${key}`);
    seen.add(key);
  }
}
