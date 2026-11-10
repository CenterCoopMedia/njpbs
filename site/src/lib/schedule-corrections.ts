import october from "../data/schedule-corrections-2026-10.json";
import november from "../data/schedule-corrections-2026-11.json";
import {
  TVSS_TIME_ZONE,
  TVSS_WNJT_FEED_CID,
  type BakedScheduleData,
  type ScheduleFeedDay,
  type ScheduleListing,
} from "./schedule-feed.ts";

interface WorkbookEntry {
  cells: string;
  title: string;
  episodeCode: string | null;
  episodeTitle?: string;
  isKids: boolean;
  startTime: string | null;
  endTime: string | null;
}

const correctionDates = new Set(october.days.map((day) => day.date));

/** Filter dates supplied by the loaded correction source. */
export function uncorrectedScheduleDates(dates: readonly string[]): string[] {
  return dates.filter((date) => !correctionDates.has(date));
}

function instant(date: string, time: string): string {
  if (time === "24:00") {
    const tomorrow = new Date(`${date}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return `${tomorrow.toISOString().slice(0, 10)}T00:00:00-04:00`;
  }
  // This correction is limited to October 2026, before the DST transition.
  if (!/^2026-10-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("The October schedule correction has an invalid time.");
  }
  return `${date}T${time}:00-04:00`;
}

function identity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function consistentSeriesDescriptions(
  days: readonly ScheduleFeedDay[],
): ReadonlyMap<string, string> {
  const descriptions = new Map<string, string | null>();
  for (const entry of days.flatMap((day) => day.entries)) {
    if (!entry.description) continue;
    const key = identity(entry.title);
    if (!descriptions.has(key)) {
      descriptions.set(key, entry.description);
    } else if (descriptions.get(key) !== entry.description) {
      descriptions.set(key, null);
    }
  }
  return new Map(
    [...descriptions].filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

function listing(
  date: string,
  entry: WorkbookEntry,
  metadata: readonly ScheduleListing[],
  seriesDescriptions: ReadonlyMap<string, string>,
  description?: string,
): ScheduleListing {
  if (!entry.startTime || !entry.endTime) throw new Error("The correction has an unresolved interval.");
  // A program at the same clock time can be a different show or episode. Keep
  // upstream metadata only when both explicit identities agree.
  const matching = !description && entry.episodeTitle
    ? metadata.find((candidate) => candidate.episodeTitle &&
      identity(candidate.title) === identity(entry.title) &&
      identity(candidate.episodeTitle) === identity(entry.episodeTitle!))
    : undefined;
  const resolvedDescription = description ??
    matching?.description ??
    seriesDescriptions.get(identity(entry.title));
  return {
    ...(matching ?? {
      seasonNumber: null, episodeNumber: null, nolaRoot: null,
      programId: null, programExternalId: null, cid: null,
    }),
    title: entry.title,
    ...(entry.episodeTitle ? { episodeTitle: matching?.episodeTitle ?? entry.episodeTitle } : {}),
    ...(resolvedDescription ? { description: resolvedDescription } : {}),
    startsAt: instant(date, entry.startTime),
    endsAt: instant(date, entry.endTime),
    isKids: entry.isKids,
    kids: entry.isKids,
    feedKind: "broadcast",
  };
}

function correctedDay(
  day: { date: string; entries: readonly WorkbookEntry[] },
  metadata: readonly ScheduleListing[],
  seriesDescriptions: ReadonlyMap<string, string>,
): ScheduleFeedDay {
  const entries: ScheduleListing[] = [];
  for (let index = 0; index < day.entries.length; index += 1) {
    const entry = day.entries[index];
    if (entry.endTime !== null) {
      entries.push(listing(day.date, entry, metadata, seriesDescriptions));
      continue;
    }
    const next = day.entries[index + 1];
    const documented = october.unresolved.some((item) => item.date === day.date &&
      item.cells[0] === entry.cells && item.cells[1] === next?.cells);
    if (!documented || !entry.startTime || next?.startTime !== null || !next.endTime) {
      throw new Error("The October schedule has an undocumented unresolved boundary.");
    }
    entries.push(listing(day.date, {
      ...entry, title: `${entry.title} / ${next.title}: Timing to be confirmed`,
      episodeTitle: undefined, episodeCode: null, isKids: false, endTime: next.endTime,
    }, [], seriesDescriptions, `${entry.title} is followed by ${next.title}. The program order is confirmed; the exact changeover time is awaiting confirmation.`));
    index += 1;
  }
  return {
    date: day.date, callsign: "wnjt", kind: "broadcast", feedCid: TVSS_WNJT_FEED_CID,
    timeZone: TVSS_TIME_ZONE, sourceRevision: october.source.revision, entries,
  };
}

function applyOctoberScheduleCorrections(data: BakedScheduleData): BakedScheduleData {
  if (!data.request.dates.some((date) => correctionDates.has(date))) return data;
  const broadcast = new Map(data.days.broadcast.map((day) => [day.date, day]));
  const kids = new Map(data.days.kids.map((day) => [day.date, day]));
  const seriesDescriptions = consistentSeriesDescriptions(data.days.broadcast);
  for (const day of october.days) {
    const corrected = correctedDay(
      day,
      broadcast.get(day.date)?.entries ?? [],
      seriesDescriptions,
    );
    broadcast.set(day.date, corrected);
    kids.set(day.date, {
      ...corrected, kind: "kids",
      entries: corrected.entries.map((entry) => ({ ...entry, feedKind: "kids" })),
    });
  }
  const dates = [...new Set([...data.request.dates, ...correctionDates])].sort();
  if (dates.length > 45) throw new Error("The corrected schedule exceeds the 45-day source limit.");
  return {
    ...data, source: "pbs-tvss-with-njpbs-corrections",
    request: { ...data.request, dates },
    days: {
      broadcast: [...broadcast.values()].sort((a, b) => a.date.localeCompare(b.date)),
      kids: [...kids.values()].sort((a, b) => a.date.localeCompare(b.date)),
    },
  };
}

const novemberEpisodes = new Map(november.dates.map((episode) => [episode.date, episode]));

/** November supplies episode details, not a replacement channel timeline. */
function applyNovemberEpisodeCorrections(data: BakedScheduleData): BakedScheduleData {
  let changed = false;
  function correctDay(day: ScheduleFeedDay): ScheduleFeedDay {
    const episode = novemberEpisodes.get(day.date);
    if (!episode) return day;
    let dayChanged = false;
    const entries = day.entries.map((entry) => {
      if (identity(entry.title) !== "oneononewithsteveadubato") return entry;
      dayChanged = true;
      return {
        ...entry,
        episodeNumber: Number(episode.episode_code),
        episodeTitle: episode.guest_or_title,
        episodeDescription: episode.description,
      };
    });
    if (!dayChanged) return day;
    changed = true;
    return { ...day, entries };
  }
  const broadcast = data.days.broadcast.map(correctDay);
  const kids = data.days.kids.map(correctDay);
  return changed
    ? { ...data, source: "pbs-tvss-with-njpbs-corrections", days: { broadcast, kids } }
    : data;
}

/** Apply the same dated sources to baked pages, publisher input and refresh checks. */
export function applyScheduleCorrections(data: BakedScheduleData): BakedScheduleData {
  return applyNovemberEpisodeCorrections(applyOctoberScheduleCorrections(data));
}
