import { assertBroadcastDate } from "./broadcast-date";
import type { ScheduleDay, ScheduleEntry } from "./schedule-now-next";
import { resolveScheduleClock, SCHEDULE_TIME_ZONE } from "./schedule-clock";

export type ScheduleSource = "pbs-tvss" | "pbs-tvss-with-njpbs-corrections";

export interface ScheduleSourceSnapshot {
  schemaVersion: 1;
  publication: { buildBatchId: string; generation: number; commitSha: string } | null;
  source: ScheduleSource;
  checkedAt: string;
  timeZone: typeof SCHEDULE_TIME_ZONE;
  days: ScheduleDay[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Schedule source data is invalid.");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000) throw new Error("Schedule source text is invalid.");
  return value;
}

function instant(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(resolveScheduleClock(new Date(Number.NaN), result).getTime())) {
    throw new Error("Schedule source time is invalid.");
  }
  return result;
}

function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Schedule source list is invalid.");
  return value;
}

function entry(value: unknown): ScheduleEntry {
  const item = object(value);
  const startsAt = instant(item.startsAt);
  const endsAt = instant(item.endsAt);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("Schedule source interval is invalid.");
  return { title: text(item.title), startsAt, endsAt,
    ...(item.episodeTitle === undefined ? {} : { episodeTitle: text(item.episodeTitle) }) };
}

function sourceData(value: unknown): Omit<ScheduleSourceSnapshot, "schemaVersion" | "publication"> {
  const source = object(value);
  if ((source.source !== "pbs-tvss" && source.source !== "pbs-tvss-with-njpbs-corrections") ||
      source.timeZone !== SCHEDULE_TIME_ZONE) throw new Error("Schedule source is invalid.");
  const dates = new Set<string>();
  // The October correction and a rolling 14-day window can contain 44 dates.
  const days = list(source.days, 45).map(value => {
    const day = object(value);
    const date = text(day.date);
    assertBroadcastDate(date);
    if (dates.has(date) || day.callsign !== "wnjt") throw new Error("Schedule source day is invalid.");
    dates.add(date);
    return { date, callsign: "wnjt", entries: list(day.entries, 1_000).map(entry) };
  });
  return { source: source.source, timeZone: SCHEDULE_TIME_ZONE, checkedAt: instant(source.checkedAt), days };
}

// Publish only fields used by the strip, never upstream requests or credentials.
export function createScheduleSourceSnapshot(
  data: {
    source: ScheduleSource; generatedAt: string; timeZone: string;
    days: { broadcast: readonly ScheduleDay[] };
  },
  publication: ScheduleSourceSnapshot["publication"],
): ScheduleSourceSnapshot {
  return { schemaVersion: 1, publication: publication ? {
    buildBatchId: publication.buildBatchId, generation: publication.generation, commitSha: publication.commitSha,
  } : null, ...sourceData({ ...data, checkedAt: data.generatedAt, days: data.days.broadcast }) };
}

export function readScheduleSourceSnapshot(value: unknown, publication: unknown): ScheduleSourceSnapshot {
  const source = object(value);
  const expected = object(publication);
  const receipt = object(source.publication);
  if (source.schemaVersion !== 1 || expected.schemaVersion !== 1 ||
      typeof receipt.buildBatchId !== "string" || !receipt.buildBatchId ||
      !Number.isSafeInteger(receipt.generation) || Number(receipt.generation) < 1 ||
      typeof receipt.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(receipt.commitSha) ||
      !["buildBatchId", "generation", "commitSha"].every(key => receipt[key] === expected[key])) {
    throw new Error("The schedule and publication receipts do not match. Reload the schedule.");
  }
  return { schemaVersion: 1, publication: {
    buildBatchId: receipt.buildBatchId, generation: Number(receipt.generation), commitSha: receipt.commitSha,
  }, ...sourceData(source) };
}
