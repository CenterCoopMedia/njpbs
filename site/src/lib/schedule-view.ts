import { TVSS_TIME_ZONE, TVSS_WNJT_FEED_CID, type BakedScheduleData, type ScheduleFeedDay, type ScheduleListing } from "./schedule-feed.ts";
import { scheduleDateKey } from "../../../packages/content-core/src/schedule-clock.ts";
export {
  scheduleDateKey,
  resolveScheduleClock,
  getScheduleClockState,
  SCHEDULE_TIME_ZONE,
  type ScheduleClockState,
} from "../../../packages/content-core/src/schedule-clock.ts";

export function unavailableScheduleData(now = new Date()): BakedScheduleData {
  const date = scheduleDateKey(now);
  const day = { date, callsign: "wnjt", timeZone: TVSS_TIME_ZONE, feedCid: TVSS_WNJT_FEED_CID, entries: [] };
  return { source: "pbs-tvss", generatedAt: now.toISOString(), timeZone: TVSS_TIME_ZONE,
    request: { station: "WNJT", dates: [date] },
    days: { broadcast: [{ ...day, kind: "broadcast" }], kids: [{ ...day, kind: "kids" }] } };
}

export type ScheduleDayState =
  | {
      readonly kind: "empty";
      readonly entries: readonly ScheduleListing[];
      readonly kids: readonly ScheduleListing[];
      readonly kidsKind: "empty";
    }
  | {
      readonly kind: "ready";
      readonly entries: readonly ScheduleListing[];
      readonly kids: readonly ScheduleListing[];
      readonly kidsKind: "empty" | "ready";
    };

export function filterKidsListings(
  entries: readonly ScheduleListing[],
): readonly ScheduleListing[] {
  return entries.filter((entry) => entry.isKids === true);
}

export function getScheduleDayState(day: ScheduleFeedDay): ScheduleDayState {
  const kids = filterKidsListings(day.entries);

  if (day.entries.length === 0) {
    return {
      kind: "empty",
      entries: day.entries,
      kids,
      kidsKind: "empty",
    };
  }

  return {
    kind: "ready",
    entries: day.entries,
    kids,
    kidsKind: kids.length === 0 ? "empty" : "ready",
  };
}

export function resolveInitialScheduleDay(
  days: readonly ScheduleFeedDay[],
  at: Date,
): ScheduleFeedDay | null {
  const fallback = days[0];
  if (!fallback) return null;

  const date = scheduleDateKey(at);
  const current = days.find((day) => day.date === date);
  if (current) return current;

  return {
    ...fallback,
    date,
    entries: [],
  };
}
