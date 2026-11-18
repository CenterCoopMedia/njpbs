import { parsePublishInstant } from "../../packages/content-core/src/publish-instant.ts";
import { isBroadcastDate } from "../src/lib/broadcast-date";
import { TVSS_TIME_ZONE, TVSS_WNJT_FEED_CID, type BakedScheduleData, type ScheduleFeedDay, type ScheduleListing } from "../src/lib/schedule-feed";

export const SCHEDULE_CORRECTIONS_PATH = "system/publicDeployment/scheduleCorrections/current";
const easternDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TVSS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
});

function invalid(): never {
  throw new Error("Published schedule corrections are invalid");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) invalid();
  return value;
}

export function readScheduleCorrections(value: unknown): Map<string, ScheduleFeedDay> {
  const corrections = new Map<string, ScheduleFeedDay>();
  if (value === undefined) return corrections;
  const { days } = object(value);
  if (!Array.isArray(days) || days.length > 45) invalid();
  for (const rawDay of days) {
    const { date, sourceRevision, entries } = object(rawDay);
    if (!isBroadcastDate(date) || !isBroadcastDate(sourceRevision) || corrections.has(date) ||
        !Array.isArray(entries) || !entries.length || entries.length > 200) invalid();
    const day = easternDate.format(new Date(`${date}T12:00:00Z`));
    let previousEnd = -Infinity;
    const listings = entries.map((rawEntry: unknown): ScheduleListing => {
      const { title, startsAt, endsAt, isKids, episodeTitle, description, episodeDescription } = object(rawEntry);
      const start = parsePublishInstant(text(startsAt, 24));
      const end = parsePublishInstant(text(endsAt, 24));
      if (start === null || end === null || start >= end || start < previousEnd || typeof isKids !== "boolean" ||
          easternDate.format(start) !== day || easternDate.format(end - 1) !== day) invalid();
      previousEnd = end;
      return {
        title: text(title, 512), startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(),
        ...(episodeTitle === undefined ? {} : { episodeTitle: text(episodeTitle, 1024) }),
        ...(description === undefined ? {} : { description: text(description, 4000) }),
        ...(episodeDescription === undefined ? {} : { episodeDescription: text(episodeDescription, 4000) }),
        isKids, kids: isKids, feedKind: "broadcast", seasonNumber: null, episodeNumber: null,
        programId: null, programExternalId: null, nolaRoot: null, cid: null,
      };
    });
    corrections.set(date, { date, sourceRevision, publishedCorrection: true, entries: listings, callsign: "wnjt",
      timeZone: TVSS_TIME_ZONE, feedCid: TVSS_WNJT_FEED_CID, kind: "broadcast" });
  }
  return corrections;
}

export function applyPublishedScheduleCorrections(data: BakedScheduleData, corrections: ReadonlyMap<string, ScheduleFeedDay>): BakedScheduleData {
  if (!data.request.dates.some(date => corrections.has(date))) return data;
  return {
    ...data, source: "pbs-tvss-with-njpbs-corrections",
    days: {
      broadcast: data.days.broadcast.map(day => corrections.get(day.date) ?? day),
      kids: data.days.kids.map(day => {
        const replacement = corrections.get(day.date);
        return replacement ? { ...replacement, kind: "kids", entries: replacement.entries.map(entry => ({ ...entry, feedKind: "kids" })) } : day;
      }),
    },
  };
}
