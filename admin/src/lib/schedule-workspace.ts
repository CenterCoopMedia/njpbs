import type { BroadcastAiring, BroadcastScheduleSource } from "../data/broadcast-schedule";

export type ScheduleStatusFilter = "all" | "premieres" | "preempted" | "pending";
export interface ScheduleFilters {
  query?: string;
  station?: string;
  program?: string;
  status?: ScheduleStatusFilter;
}
export interface EpisodeAiringGroup {
  detailsStatus: BroadcastAiring["detailsStatus"];
  episode: string;
  premiere: boolean;
  program: string;
  slots: Array<Pick<BroadcastAiring, "station" | "status" | "time">>;
  title: string;
}

export function parseScheduleStatus(value: string | null): ScheduleStatusFilter {
  return value === "premieres" || value === "preempted" || value === "pending" ? value : "all";
}

export function todayInTimeZone(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function scheduleCoverageState(source: BroadcastScheduleSource, today: string) {
  if (today < source.coverageStart) return "upcoming";
  if (today > source.coverageEnd) return "expired";
  return "covered";
}

/** Sort source clock labels without manufacturing dates, durations, or on-air status. */
export function broadcastTimeMinutes(value: string): number {
  const normalized = value.toLowerCase().replace(/[.\s]/g, "");
  if (normalized === "noon") return 12 * 60;
  if (normalized === "midnight") return 0;
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(normalized);
  if (!match) return Number.POSITIVE_INFINITY;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return Number.POSITIVE_INFINITY;
  return (hour % 12) * 60 + minute + (match[3] === "pm" ? 720 : 0);
}

export function filterBroadcastAirings(
  airings: readonly BroadcastAiring[],
  { query = "", station = "", program = "", status = "all" }: ScheduleFilters,
): BroadcastAiring[] {
  const terms = query.trim().toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
  return airings.filter((airing) => {
    if (station && airing.station !== station) return false;
    if (program && airing.program !== program) return false;
    if (status === "premieres" && !airing.premiere) return false;
    if (status === "preempted" && airing.status !== "preempted") return false;
    if (status === "pending" && airing.detailsStatus !== "pending") return false;
    const searchable = [airing.program, airing.title, airing.episode, airing.station]
      .join(" ").toLocaleLowerCase("en-US");
    return terms.every((term) => searchable.includes(term));
  });
}

/** Call with one day's airings. Source records are never changed or dropped. */
export function groupEpisodeAirings(airings: readonly BroadcastAiring[]): EpisodeAiringGroup[] {
  const groups = new Map<string, EpisodeAiringGroup>();
  const ordered = [...airings].sort((a, b) => {
    const aTime = broadcastTimeMinutes(a.time);
    const bTime = broadcastTimeMinutes(b.time);
    return (aTime === bTime ? 0 : aTime < bTime ? -1 : 1)
      || a.station.localeCompare(b.station);
  });
  for (const airing of ordered) {
    const key = JSON.stringify([airing.program, airing.episode, airing.title]);
    const existing = groups.get(key);
    if (existing) {
      existing.slots.push({ station: airing.station, status: airing.status, time: airing.time });
      existing.premiere ||= airing.premiere;
      if (airing.detailsStatus === "pending") existing.detailsStatus = "pending";
    } else {
      groups.set(key, {
        detailsStatus: airing.detailsStatus,
        episode: airing.episode,
        premiere: airing.premiere,
        program: airing.program,
        slots: [{ station: airing.station, status: airing.status, time: airing.time }],
        title: airing.title,
      });
    }
  }
  return Array.from(groups.values());
}
