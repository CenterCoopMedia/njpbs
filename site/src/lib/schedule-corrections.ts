import october from "../data/schedule-corrections-2026-10.json";
import november from "../data/schedule-corrections-2026-11.json";
import december from "../data/schedule-corrections-2026-12.json";
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

interface WorkbookSource {
  source: { revision: string };
  unresolved: { date: string; cells: string[] }[];
  days: { date: string; entries: WorkbookEntry[] }[];
}

const workbooks: readonly WorkbookSource[] = [october, november.workbook, december];
const workbookOnlyDates = new Set(october.days.map((day) => day.date));

/** Filter loaded workbook dates; October replaces feed entries while later months retain matching PBS details. */
export function uncorrectedScheduleDates(dates: readonly string[]): string[] {
  return dates.filter((date) => !workbookOnlyDates.has(date));
}

function instant(date: string, time: string): string {
  if (time === "24:00") {
    const tomorrow = new Date(`${date}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return instant(tomorrow.toISOString().slice(0, 10), "00:00");
  }
  if (!/^202[67]-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error("The schedule correction has an invalid time.");
  }
  // These approved sources span the November 1, 2026 fall-back transition.
  const daylight = date < "2026-11-01" || (date === "2026-11-01" && time < "02:00");
  return `${date}T${time}:00${daylight ? "-04:00" : "-05:00"}`;
}

function identity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function programWords(value: string): string {
  return value.toLowerCase().replace(/^the\s+/, "").replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ").trim()
    .replace(/^dw (?=focus on europe$)/, "")
    .replace(/\bchitmacha\b/, "chitimacha");
}

function truncatedProgramTitle(feedTitle: string, workbookTitle: string): boolean {
  const feed = programWords(feedTitle);
  const workbook = programWords(workbookTitle);
  return feed.length >= 30 && workbook.startsWith(feed) &&
    /^[a-z]/.test(workbook.slice(feed.length, feed.length + 1));
}

/** Titles can omit an article, name a special after a colon, or be cut short by PBS. */
export function sameScheduleProgram(feedTitle: string, workbookTitle: string): boolean {
  return programWords(feedTitle) === programWords(workbookTitle) ||
    programWords(feedTitle.split(":")[0]) === programWords(workbookTitle) ||
    truncatedProgramTitle(feedTitle, workbookTitle);
}

function episodeIdentity(value: string): string {
  const parts: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", i: "1", ii: "2", iii: "3", iv: "4" };
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/^the\s+/, "").replace(/&/g, "and").replace(/\+/g, "plus").replace(/=/g, "equals")
    .replace(/\b(?:part|pt\.?)\s*(one|two|three|four|i{1,3}|iv|[1-9]\d*)\b/g,
      (_match, part: string) => `part${parts[part] ?? part}`)
    .replace(/[^a-z0-9]/g, "");
}

/** House/catalog numbers do not establish episode identity; explicit titles do. */
export function scheduleEpisodeDiffers(
  feed: Pick<ScheduleListing, "episodeTitle">,
  title?: string,
): boolean {
  return Boolean(title && episodeIdentity(title) !== episodeIdentity(feed.episodeTitle ?? ""));
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
  // Match the new lineups by program and clock time. October's episode-specific
  // correction retains its stricter explicit episode match.
  const matching = description ? undefined : metadata.find((candidate) => {
    if (!date.startsWith("2026-10")) {
      const start = Date.parse(instant(date, entry.startTime!));
      return sameScheduleProgram(candidate.title, entry.title) &&
        Date.parse(candidate.startsAt) <= start && Date.parse(candidate.endsAt) > start;
    }
    return identity(candidate.title) === identity(entry.title) &&
      entry.episodeTitle && candidate.episodeTitle &&
      identity(candidate.episodeTitle) === identity(entry.episodeTitle);
  });
  const resolvedDescription = description ??
    matching?.description ??
    seriesDescriptions.get(identity(entry.title));
  const episodeDiffers = !date.startsWith("2026-10") && matching && scheduleEpisodeDiffers(matching, entry.episodeTitle);
  const retained = matching ? { ...matching } : undefined;
  if (retained && episodeDiffers) {
    delete retained.episodeTitle;
    delete retained.episodeDescription;
    delete retained.airingType;
    delete retained.hd;
    delete retained.closedCaptions;
    retained.seasonNumber = null;
    retained.episodeNumber = null;
    retained.cid = null;
  }
  return {
    ...(retained ?? {
      seasonNumber: null, episodeNumber: null, nolaRoot: null,
      programId: null, programExternalId: null, cid: null,
    }),
    title: matching && !date.startsWith("2026-10") && !truncatedProgramTitle(matching.title, entry.title)
      ? matching.title : entry.title,
    ...((!matching || episodeDiffers) && entry.episodeTitle ? { episodeTitle: entry.episodeTitle } : {}),
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
  source: WorkbookSource,
): ScheduleFeedDay {
  const entries: ScheduleListing[] = [];
  for (let index = 0; index < day.entries.length; index += 1) {
    const entry = day.entries[index];
    if (entry.endTime !== null) {
      entries.push(listing(day.date, entry, metadata, seriesDescriptions));
      continue;
    }
    const group = [entry];
    while (group.at(-1)!.endTime === null) {
      const previous = group.at(-1)!;
      const next = day.entries[++index];
      const documented = source.unresolved.some((item) => item.date === day.date &&
        item.cells[0] === previous.cells && item.cells[1] === next?.cells);
      if (!documented || !entry.startTime || next?.startTime !== null) {
        throw new Error("The schedule has an undocumented unresolved boundary.");
      }
      group.push(next);
    }
    const programs = group.filter((item) => item.title !== "Fill");
    if (programs.length === 1 && programs.length < group.length) {
      const airing = listing(day.date, { ...programs[0], endTime: group.at(-1)!.endTime }, metadata, seriesDescriptions);
      entries.push({ ...airing, title: `${airing.title.replace(/: Timing to be confirmed$/, "")}: Timing to be confirmed` });
      continue;
    }
    const titles = programs.map((item) => item.title);
    entries.push(listing(day.date, {
      ...entry, title: `${titles.join(" / ")}: Timing to be confirmed`,
      episodeTitle: undefined, episodeCode: null, isKids: false, endTime: group.at(-1)!.endTime,
    }, [], seriesDescriptions, `${titles.join(" is followed by ")}. The program order is confirmed; the exact changeover time is awaiting confirmation.`));
  }
  return {
    date: day.date, callsign: "wnjt", kind: "broadcast", feedCid: TVSS_WNJT_FEED_CID,
    timeZone: TVSS_TIME_ZONE, sourceRevision: source.source.revision, entries,
  };
}

function applyWorkbookScheduleCorrections(data: BakedScheduleData): BakedScheduleData {
  const active = workbooks.find((source) => source.days.some((day) => data.request.dates.includes(day.date)));
  if (!active) return data;
  // Expand the first covered month only. Adjacent months use the rolling window,
  // which keeps the existing 45-day source bound at month boundaries.
  const dates = [...new Set([...data.request.dates, ...active.days.map((day) => day.date)])].sort();
  if (dates.length > 45) throw new Error("The corrected schedule exceeds the 45-day source limit.");
  const includedDates = new Set(dates);
  const broadcast = new Map(data.days.broadcast.map((day) => [day.date, day]));
  const kids = new Map(data.days.kids.map((day) => [day.date, day]));
  const seriesDescriptions = consistentSeriesDescriptions(data.days.broadcast);
  for (const source of workbooks) {
    for (const day of source.days) {
      if (!includedDates.has(day.date)) continue;
      const corrected = correctedDay(
        day,
        broadcast.get(day.date)?.entries ?? [],
        seriesDescriptions,
        source,
      );
      broadcast.set(day.date, corrected);
      kids.set(day.date, {
        ...corrected, kind: "kids",
        entries: corrected.entries.map((entry) => ({ ...entry, feedKind: "kids" })),
      });
    }
  }
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

/** Apply the separately approved November episode details after the lineup. */
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
  return applyNovemberEpisodeCorrections(applyWorkbookScheduleCorrections(data));
}
