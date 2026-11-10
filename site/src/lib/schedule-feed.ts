import type {
  ScheduleDay,
  ScheduleEntry,
} from "./schedule-now-next.ts";
import { assertBroadcastDate } from "./broadcast-date.ts";
import type { ScheduleSource } from "../../../packages/content-core/src/schedule-source-snapshot";
import {
  STATION_TIME_ZONE,
  offsetMinutes as timeZoneOffsetMinutes,
  zonedLocalInstants,
  zonedParts,
} from "../../../packages/content-core/src/station-time";

export const TVSS_TIME_ZONE = STATION_TIME_ZONE;

/**
 * Select the WNJT HD feed by its configured identity.
 * Keep the short-name fallback because PBS may replace a station feed record.
 */
export const TVSS_WNJT_FEED_CID = "4211290e-ce30-49e5-9be1-2c412c5b3278";
export const TVSS_WNJT_FEED_SHORT_NAME = "WNJTDT";

const CONTAMINATED_ON_STORY_CID = "86e58e7f-f313-42cd-a105-274eb900b8df";
const CONTAMINATED_ON_STORY_PROGRAM_EXTERNAL_ID = "SH014081970000";
const CONTAMINATED_ON_STORY_EPISODE_TITLE =
  "Gun and Powder'' at Paper Mill Playhouse, Architect Edward T. Bowser, Jr. &";

/**
 * Explicit known kids series supplement the upstream kids flag.
 */
export const PBS_KIDS_NOLA_ROOTS: ReadonlySet<string> = new Set([
  "WILK",
  "RORU",
  "EWHY",
  "SWYC",
  "DKYH",
  "DTIG",
  "WBAT",
  "SESA",
  "AWAY",
  "ARUR",
  "ATHA",
  "XRID",
  "MDEN",
  "CARL",
  "ODDS",
  "LYLO",
  "PBAJ",
  "WEHU",
  "TDYB",
  "BGSS",
  "CANI",
]);

export type ScheduleFeedKind = "broadcast" | "kids";

/** A TVSS airing with the metadata the native schedule grid will need. */
export interface ScheduleListing extends ScheduleEntry {
  /** The series blurb, the same text on every airing of the show. */
  readonly description?: string;
  /**
   * What this particular airing is about, when TVSS carries something the series
   * blurb does not already say. Absent when the two match: Gracenote fills the
   * episode field with the series text for a daily interview or news program, and
   * repeating it under the series line tells a viewer nothing.
   */
  readonly episodeDescription?: string;
  readonly hd?: boolean;
  readonly closedCaptions?: boolean;
  readonly seasonNumber: number | null;
  readonly episodeNumber: number | null;
  readonly airingType?: string;
  readonly nolaRoot: string | null;
  readonly programId: number | null;
  readonly programExternalId: string | null;
  readonly cid: string | null;
  /** PBS's kidsflag response marks each airing, including non-kids programs. */
  readonly kids?: boolean;
  /** Settled kids classification for render code. */
  readonly isKids: boolean;
  readonly feedKind: ScheduleFeedKind;
}

/** One normalized WNJT broadcast day from the TVSS station feed. */
export interface ScheduleFeedDay extends Omit<ScheduleDay, "entries"> {
  readonly kind: ScheduleFeedKind;
  readonly feedCid: string;
  readonly timeZone: typeof TVSS_TIME_ZONE;
  /** Start of the successful PBS retrieval run for this exact day. */
  readonly sourceCheckedAt?: string;
  /** Date on an approved replacement lineup; it is not a PBS check. */
  readonly sourceRevision?: string;
  readonly entries: readonly ScheduleListing[];
}

/** The committed schedule dataset consumed by later native schedule work. */
export interface BakedScheduleData {
  readonly source: ScheduleSource;
  readonly generatedAt: string;
  readonly timeZone: typeof TVSS_TIME_ZONE;
  readonly request: {
    readonly station: "WNJT";
    readonly dates: readonly string[];
  };
  readonly days: {
    readonly broadcast: readonly ScheduleFeedDay[];
    readonly kids: readonly ScheduleFeedDay[];
  };
}

export interface ShapeTvssScheduleDayOptions {
  /** Broadcast date as YYYY-MM-DD in America/New_York. */
  readonly date: string;
  readonly kind: ScheduleFeedKind;
}

/** Parse the fixed `cb({...})` envelope without evaluating JavaScript. */
export function unwrapTvssJsonp(text: string): unknown {
  const match = text.match(/^\s*cb\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (!match) {
    throw new Error('TVSS response did not use the expected "cb" callback.');
  }

  try {
    return JSON.parse(match[1]);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`TVSS callback did not contain valid JSON: ${message}`);
  }
}

/** Select and normalize one WNJT day from an unwrapped TVSS payload. */
export function shapeTvssScheduleDay(
  payload: unknown,
  options: ShapeTvssScheduleDayOptions,
): ScheduleFeedDay {
  assertBroadcastDate(options.date);
  const root = asRecord(payload, "TVSS payload");
  const headends = asArray(root.headends, "TVSS headends");
  const broadcast = headends
    .map((value) => asRecord(value, "TVSS headend"))
    .find(({ name }) => name === "Broadcast");
  if (!broadcast) {
    throw new Error('TVSS payload has no "Broadcast" headend.');
  }

  const feeds = asArray(broadcast.feeds, "Broadcast feeds").map((value) =>
    asRecord(value, "TVSS feed"),
  );
  const feed =
    feeds.find(({ cid }) => cid === TVSS_WNJT_FEED_CID) ??
    feeds.find(({ short_name }) => short_name === TVSS_WNJT_FEED_SHORT_NAME);
  if (!feed) {
    throw new Error("Broadcast headend has no WNJTDT feed.");
  }

  const sourceListings = asArray(feed.listings, "WNJTDT listings").map(
    (value) => asRecord(value, "TVSS listing"),
  );
  if (sourceListings.length === 0) {
    throw new Error(`TVSS ${options.kind} day has no listings.`);
  }

  const entries: ScheduleListing[] = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const listing of sourceListings) {
    const entry = mapListing(listing, options, previousEnd);
    entries.push(entry);
    previousEnd = Date.parse(entry.endsAt);
  }

  return {
    date: options.date,
    callsign: "wnjt",
    kind: options.kind,
    feedCid: readRequiredString(feed.cid, "TVSS feed cid"),
    timeZone: TVSS_TIME_ZONE,
    entries,
  };
}

/**
 * The airing-specific synopsis, or undefined when there is nothing extra to say.
 *
 * TVSS carries `episode_description` on most listings, and for an episodic show it
 * is the line a viewer actually wants: "Aviva, Martin, and Chris learn about
 * agriculture in the animal world from Leafcutter ants in the Amazon rainforest."
 * rather than the series blurb that runs under every Wild Kratts. For a daily
 * interview or news program Gracenote fills the same field with the series text,
 * so a naive read would print the same sentence twice under the same program.
 * Comparing them here keeps the decision out of every render surface.
 *
 * The comparison collapses whitespace and case to tolerate formatting variation.
 */
function readEpisodeDescription(
  listing: Record<string, unknown>,
  description: string | undefined,
): string | undefined {
  const episodeDescription = readOptionalString(listing.episode_description);
  if (!episodeDescription) return undefined;
  const normalize = (value: string) =>
    value.replace(/\s+/g, " ").trim().toLowerCase();
  return normalize(episodeDescription) === normalize(description ?? "")
    ? undefined
    : episodeDescription;
}

/** Match one TVSS title copied from the following State of the Arts listing. */
function isContaminatedOnStoryEpisodeTitle(
  listing: Record<string, unknown>,
  episodeTitle: string | undefined,
): boolean {
  return (
    listing.cid === CONTAMINATED_ON_STORY_CID &&
    listing.program_external_id === CONTAMINATED_ON_STORY_PROGRAM_EXTERNAL_ID &&
    episodeTitle === CONTAMINATED_ON_STORY_EPISODE_TITLE
  );
}

function mapListing(
  listing: Record<string, unknown>,
  options: ShapeTvssScheduleDayOptions,
  earliestInstant: number,
): ScheduleListing {
  const startTime = readRequiredString(listing.start_time, "listing start_time");
  if (!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(startTime)) {
    throw new Error(`TVSS listing has an invalid start_time: ${startTime}`);
  }
  const durationMinutes = parseTvssDuration(listing.duration);
  const candidates = zonedLocalInstants(
    options.date,
    startTime,
    TVSS_TIME_ZONE,
  );
  if (candidates.length === 0) {
    throw new Error(
      `TVSS listing start ${options.date} ${startTime} does not exist in ${TVSS_TIME_ZONE}.`,
    );
  }
  const startInstant = candidates.find(
    (candidate) => candidate >= earliestInstant,
  );
  if (startInstant === undefined) {
    throw new Error(
      `TVSS listing start ${options.date} ${startTime} overlaps or precedes the prior listing.`,
    );
  }
  const endInstant = startInstant + durationMinutes * 60_000;
  const sourceEpisodeTitle = readOptionalString(listing.episode_title);
  const episodeTitle = isContaminatedOnStoryEpisodeTitle(
    listing,
    sourceEpisodeTitle,
  )
    ? undefined
    : sourceEpisodeTitle;
  const description = readOptionalString(listing.description);
  const episodeDescription = readEpisodeDescription(listing, description);
  const airingType = readOptionalString(listing.airing_type);
  const nolaRoot = readOptionalString(listing.nola_root) ?? null;
  const programId = readNullableNumber(listing.program_id, "program_id");
  const programExternalId = readNullableString(
    listing.program_external_id,
    "program_external_id",
  );
  const cid = readNullableString(listing.cid, "cid");
  const hd = readOptionalBoolean(listing.hd, "listing hd");
  const closedCaptions = readOptionalBoolean(
    listing.closed_captions,
    "listing closed_captions",
  );
  const kids =
    options.kind === "kids"
      ? readRequiredBoolean(listing.kids, "listing kids")
      : readOptionalBoolean(listing.kids, "listing kids");
  const isKids =
    kids === true ||
    (nolaRoot !== null && PBS_KIDS_NOLA_ROOTS.has(nolaRoot));

  return {
    startsAt: formatZonedIso(startInstant, TVSS_TIME_ZONE),
    endsAt: formatZonedIso(endInstant, TVSS_TIME_ZONE),
    title: readRequiredString(listing.title, "listing title"),
    ...(episodeTitle ? { episodeTitle } : {}),
    ...(description ? { description } : {}),
    ...(episodeDescription ? { episodeDescription } : {}),
    ...(hd === undefined ? {} : { hd }),
    ...(closedCaptions === undefined ? {} : { closedCaptions }),
    seasonNumber: readNullableNumber(listing.season_number, "season_number"),
    episodeNumber: readNullableNumber(listing.episode_number, "episode_number"),
    ...(airingType ? { airingType } : {}),
    nolaRoot,
    programId,
    programExternalId,
    cid,
    ...(kids === undefined ? {} : { kids }),
    isKids,
    feedKind: options.kind,
  };
}

/** TVSS encodes durations as HHMM-like integers: 100 means one hour. */
function parseTvssDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`TVSS listing has an invalid duration: ${String(value)}`);
  }
  const hours = Math.floor(value / 100);
  const minutes = value % 100;
  if (minutes >= 60) {
    throw new Error(`TVSS listing has an invalid duration: ${value}`);
  }
  return hours * 60 + minutes;
}

function formatZonedIso(instant: number, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  const offsetMinutes = timeZoneOffsetMinutes(instant, timeZone);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array.`);
  return value;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing.`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`listing ${label} is not a nonblank string.`);
  }
  return value.trim();
}

function readOptionalBoolean(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} is not a boolean.`);
  return value;
}

function readRequiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is not a boolean.`);
  return value;
}

function readNullableNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`listing ${label} is not an integer.`);
  }
  return value;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
