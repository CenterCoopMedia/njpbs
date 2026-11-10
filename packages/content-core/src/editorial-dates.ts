// The four dates a story carries, and which one each surface is allowed to show.
//
// Issue #1041. Before this module a post had exactly one date field, `date`, which
// an editor had to fill in to save a draft. Whatever day they happened to start
// writing therefore became the date the public page, the listing sort, and the
// structured data all reported as the day the story published. A draft written on
// Monday and published on Friday said Monday. A draft saved, sat on for a month,
// and then published said the wrong month. That is the bug: a draft-creation
// timestamp was presenting as a publication time.
//
// Four distinct facts are separated here, each with one writer:
//
// - `firstPublishedAt` — the trusted server time at which publication first
//   completed. Minted by the server at that moment and never again: a republish, a
//   revision, an unpublish-and-republish, and a restore all leave it alone. A
//   scheduled publish stamps the instant the scheduler actually published, not the
//   `publishAt` the editor asked for, because a run that lands four minutes late
//   published four minutes late.
// - `date` — the editorial display date, a calendar day in station time. It is
//   derived from `firstPublishedAt` unless an authorized editor deliberately
//   backdates it (a story that ran in print last week, a piece moved over from the
//   old site). `editorialDateSource` records which of those two it is, so nothing
//   downstream has to guess.
// - `meaningfulUpdatedAt` — when the story was substantively updated. Set only by an
//   explicit decision at save or publish time. Fixing a typo, re-saving to change a
//   tag, or any other ordinary save does not touch it, which is the whole reason it
//   is a separate field from `updatedAt`.
// - `showUpdatedDate` — whether the public page shows that update time at all. A
//   newsroom decision, not a consequence of having updated something.
//
// Everything here is pure: no clock is read, no record is written. Callers pass the
// instant they already minted from trusted server time and apply the returned
// fields. That is what makes the time-zone and daylight-saving behaviour testable
// against fixed instants rather than against whatever day the test happens to run.
//
// Cloud Functions cannot import TypeScript from their deploy bundle, so
// functions/lib/editorial-dates.js mirrors this contract in CommonJS and a parity
// test holds the two together.

import { parsePublishInstant } from "./publish-instant.ts";
import {
  STATION_TIME_ZONE,
  instantToStationLocal,
  stationLocalToInstant,
} from "./station-time.ts";

/**
 * Where a record's editorial display date came from. Stored, not inferred at read
 * time, because the three cases are indistinguishable from the data alone once a
 * derived date has been written down.
 *
 * - `firstPublish` — derived from `firstPublishedAt`. The default for anything
 *   created under this contract.
 * - `backdated` — deliberately set by an editor holding `content.publish`.
 * - `legacy` — the record predates this contract. Its `date` is whatever the old
 *   single-field editor stored, and it is authoritative because nothing better
 *   exists. See {@link applyFirstPublish} for why a legacy record never gets a
 *   `firstPublishedAt` minted after the fact.
 */
export type EditorialDateSource = "firstPublish" | "backdated" | "legacy";

export const EDITORIAL_DATE_SOURCES: readonly EditorialDateSource[] = Object.freeze([
  "firstPublish",
  "backdated",
  "legacy",
]);

/**
 * The date fields this contract owns. Declared as a standalone interface rather
 * than inline on `PostRecord` so the server mirror, the published snapshot, and any
 * later record type that grows a publication date all describe the same shape.
 *
 * Every field is optional: a draft that has never published holds none of them.
 */
export interface EditorialDateFields {
  /**
   * The editorial display date as a `YYYY-MM-DD` calendar day in station time.
   * Blank or absent on a draft that has not published and has not been backdated.
   */
  date?: string;
  /** Which rule produced `date`. Server-managed; never an editor field. */
  editorialDateSource?: EditorialDateSource;
  /** Trusted server instant at which publication first completed. Immutable. */
  firstPublishedAt?: string;
  /** uid of whoever completed that first publication. */
  firstPublishedBy?: string;
  /** Trusted server instant of the last update an editor called meaningful. */
  meaningfulUpdatedAt?: string;
  /** uid of whoever recorded that update. */
  meaningfulUpdatedBy?: string;
  /** Whether the public page shows the update time. Off unless turned on. */
  showUpdatedDate?: boolean;
  /**
   * The one-shot request an editor submits with a save to record a meaningful
   * update. The server consumes it — stamping `meaningfulUpdatedAt` — and stores it
   * back as false, so the next ordinary save cannot silently re-stamp.
   */
  recordMeaningfulUpdate?: boolean;
}

/** What a read-side resolver needs. Deliberately looser than `PostRecord`. */
export type EditorialDateRecord = EditorialDateFields & {
  published?: { publishedAt?: unknown } | unknown;
  publiclyVisible?: boolean;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` string that names a day the calendar actually has. */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The calendar day a stored instant falls on in station time, or null if the value
 * is not an instant the publish gate can read.
 *
 * The zone matters and is the reason this is not `instant.slice(0, 10)`. A story
 * published at 11:30 p.m. on Aug. 13 in New Jersey is stored as `2026-08-14T03:30Z`.
 * Slicing the UTC string dates it Aug. 14 — a day the newsroom never published on,
 * and a day that reads as tomorrow to every reader in the state.
 */
export function stationCalendarDay(
  value: unknown,
  timeZone: string = STATION_TIME_ZONE,
): string | null {
  const local = instantToStationLocal(value, timeZone);
  return local === "" ? null : local.slice(0, 10);
}

/** Whether a record has ever been public, by either marker the CMS writes. */
function hasBeenPublic(record: EditorialDateRecord | null | undefined): boolean {
  if (!record) return false;
  if (record.publiclyVisible === true) return true;
  const published = (record as { published?: unknown }).published;
  return typeof published === "object" && published !== null;
}

/**
 * Which rule owns this record's display date, for a record that may predate the
 * contract. A stored source wins. Otherwise a record that already carries a `date`
 * is legacy — that value came from the old single-field editor and is the only
 * editorial date anyone has for it — and a record with no date at all is a new one
 * whose date will be derived at first publish.
 */
export function resolveEditorialDateSource(
  record: EditorialDateRecord | null | undefined,
): EditorialDateSource {
  const stored = record?.editorialDateSource;
  if (
    typeof stored === "string" &&
    (EDITORIAL_DATE_SOURCES as readonly string[]).includes(stored)
  ) {
    return stored as EditorialDateSource;
  }
  return nonEmptyString(record?.date) ? "legacy" : "firstPublish";
}

/**
 * The calendar day the public page, listings, structured data, and sorting all show
 * as this story's date, or null when it has none yet.
 *
 * A record whose date is derived reads it back out of `firstPublishedAt` rather than
 * trusting the stored copy, so a stale or hand-edited `date` cannot outvote the
 * publication receipt. A backdated or legacy record reads the stored day, which is
 * the point of those states.
 *
 * Null is a real answer, not a failure: an unpublished draft has no publication
 * date, and the fix for that is to publish it, not to show the day someone started
 * typing.
 */
export function resolveDisplayDate(
  record: EditorialDateRecord | null | undefined,
  timeZone: string = STATION_TIME_ZONE,
): string | null {
  if (!record) return null;
  const source = resolveEditorialDateSource(record);
  if (source === "firstPublish") {
    return stationCalendarDay(record.firstPublishedAt, timeZone);
  }
  const stored = nonEmptyString(record.date);
  if (stored && isCalendarDay(stored)) return stored;
  return stationCalendarDay(record.firstPublishedAt, timeZone);
}

/**
 * The instant of midnight, station time, on a calendar day, or null for a day the
 * calendar does not have. Used when a story has no first-publish instant on its
 * display day.
 */
export function stationDayStartInstant(
  day: string,
  timeZone: string = STATION_TIME_ZONE,
): number | null {
  if (!isCalendarDay(day)) return null;
  const midnight = stationLocalToInstant(`${day}T00:00`, timeZone);
  return midnight === null ? null : parsePublishInstant(midnight);
}

/** What a public renderer needs to decide whether to print "Updated ...". */
export interface UpdateDisplay {
  /** True only when the newsroom turned the control on and a real update exists. */
  show: boolean;
  /** The stored instant, for a `<time datetime>` attribute and structured data. */
  at: string | null;
  /** The station-time calendar day of that instant. */
  date: string | null;
}

/**
 * Whether and what the public page shows for the update time.
 *
 * Two conditions, both required. The newsroom has to have turned `showUpdatedDate`
 * on, and there has to be a meaningful update to show. Having updated a story is
 * not on its own a decision to say so on the page, and turning the control on
 * before any meaningful update has happened must not print the save time instead.
 *
 * An update dated on or before the display date is not shown either. It is not
 * wrong, but "Published Aug. 13 · Updated Aug. 13" tells a reader nothing and
 * "Updated Aug. 12" on a story dated Aug. 13 reads as an error. Both happen
 * naturally: a story fixed substantively before it went live, and a backdated piece.
 */
export function resolveUpdateDisplay(
  record: EditorialDateRecord | null | undefined,
  timeZone: string = STATION_TIME_ZONE,
): UpdateDisplay {
  const at = record?.meaningfulUpdatedAt;
  const date = stationCalendarDay(at, timeZone);
  if (!date || typeof at !== "string") return { show: false, at: null, date: null };
  const displayDate = resolveDisplayDate(record, timeZone);
  const show = record?.showUpdatedDate === true && (!displayDate || date > displayDate);
  return { show, at, date };
}

/**
 * The instant a listing sorts this story by, or null when it has no date at all.
 *
 * Sorting follows the date the page displays, so a reader never sees a list whose
 * order contradicts the dates printed in it. A derived date sorts by the exact
 * publication instant, which keeps two stories published the same morning in the
 * order they actually went live. A backdated or legacy story uses its first-publish
 * instant when it falls on the display day in station time. Otherwise, it sorts
 * by station midnight of its display day.
 */
export function editorialSortInstant(
  record: EditorialDateRecord | null | undefined,
  timeZone: string = STATION_TIME_ZONE,
): number | null {
  if (!record) return null;
  const firstPublishedAt = typeof record.firstPublishedAt === "string" ? record.firstPublishedAt : "";
  if (resolveEditorialDateSource(record) === "firstPublish") {
    return parsePublishInstant(firstPublishedAt);
  }
  const day = resolveDisplayDate(record, timeZone);
  if (day !== null && stationCalendarDay(firstPublishedAt, timeZone) === day) {
    return parsePublishInstant(firstPublishedAt);
  }
  return day === null ? null : stationDayStartInstant(day, timeZone);
}

/**
 * The fields to write when a publication completes. Returns only what changes, so a
 * caller merges it over the composed document.
 *
 * Called on every publish, not only the first, and does nothing on the later ones:
 * a first-publish time that a republish could move is not a first-publish time.
 *
 * The legacy case is decided here rather than left to each caller. A record that was
 * already public before this contract existed has no `firstPublishedAt` and no way
 * to recover one — its `published.publishedAt` is the most recent publish, not the
 * first, and writing that down would state a specific falsehood with a server
 * timestamp's authority. So it is never minted for such a record. The record is
 * marked `legacy` instead, which pins its display date to the `date` the old editor
 * stored and keeps every reader-facing surface showing exactly what it showed
 * yesterday.
 */
export function applyFirstPublish(
  record: EditorialDateRecord | null | undefined,
  options: { at: string; by: string; timeZone?: string },
): Partial<EditorialDateFields> {
  const timeZone = options.timeZone ?? STATION_TIME_ZONE;
  const source = resolveEditorialDateSource(record);

  if (parsePublishInstant(String(record?.firstPublishedAt ?? "")) !== null) {
    return {};
  }
  if (hasBeenPublic(record)) {
    return source === "legacy" ? {} : { editorialDateSource: source };
  }
  if (parsePublishInstant(options.at) === null) {
    throw new Error("First publish requires an absolute UTC instant");
  }
  if (nonEmptyString(options.by) === null) {
    throw new Error("First publish requires an actor");
  }

  const stamped: Partial<EditorialDateFields> = {
    firstPublishedAt: options.at,
    firstPublishedBy: options.by,
    editorialDateSource: source,
  };
  if (source === "firstPublish") {
    const day = stationCalendarDay(options.at, timeZone);
    if (day) stamped.date = day;
  }
  return stamped;
}

/**
 * The fields to write for the meaningful-update decision on one save.
 *
 * `recordMeaningfulUpdate` always comes back false. It is a request an editor makes
 * once, not a setting: leaving it on would turn every later typo fix into a
 * republished "Updated today", which is the exact behaviour this contract exists to
 * prevent.
 */
export function applyMeaningfulUpdate(options: {
  requested: unknown;
  at: string;
  by: string;
}): Partial<EditorialDateFields> {
  if (options.requested !== true) return { recordMeaningfulUpdate: false };
  if (parsePublishInstant(options.at) === null) {
    throw new Error("A meaningful update requires an absolute UTC instant");
  }
  if (nonEmptyString(options.by) === null) {
    throw new Error("A meaningful update requires an actor");
  }
  return {
    meaningfulUpdatedAt: options.at,
    meaningfulUpdatedBy: options.by,
    recordMeaningfulUpdate: false,
  };
}

/** The outcome of reading a submitted editorial date against what is stored. */
export interface EditorialDateWrite {
  /**
   * True when the submission moves the editorial date away from, or back to, the
   * publication receipt.
   */
  backdates: boolean;
  /**
   * True when that move changes a date readers can already see, which is the case
   * the save boundary refuses without `content.publish`.
   *
   * A date typed on a draft nobody has ever seen is not gated here. It is a
   * proposal, and it reaches readers only through a publish, which is itself a
   * publish-capability decision. Gating it twice would stop a contributor from
   * drafting a piece with the day it ran in print already filled in, while adding
   * nothing: the record cannot go public without an editor.
   */
  requiresPublishAuthority: boolean;
  /** Fields to merge into the composed document. Empty when nothing changes. */
  fields: Partial<EditorialDateFields>;
  /** A refusal message when the submitted value is not a real calendar day. */
  error: string | null;
}

/**
 * Read a submitted editorial date against the stored record and say what it means.
 *
 * The three outcomes:
 *
 * - The field was not submitted, or matches the date the record already displays:
 *   nothing changes and nothing needs authorizing. This is the ordinary save, and it
 *   is why re-saving a published post does not trip the capability check.
 * - A different day was submitted: a deliberate backdate. `date` is stored verbatim
 *   and the source becomes `backdated`, so no later publish overwrites it.
 * - The field was submitted blank on a record that was backdated or legacy: the
 *   editor is handing the date back to the publication receipt. That is equally a
 *   publish-level decision — it moves the date a reader sees — so it is gated the
 *   same way.
 *
 * A blank submission on a record whose date is already derived is not a change; a
 * draft that has never published is expected to sit there with an empty field.
 */
export function resolveEditorialDateWrite(
  stored: EditorialDateRecord | null | undefined,
  submitted: unknown,
  timeZone: string = STATION_TIME_ZONE,
): EditorialDateWrite {
  const unchanged: EditorialDateWrite = {
    backdates: false,
    requiresPublishAuthority: false,
    fields: {},
    error: null,
  };
  const refuse = (error: string): EditorialDateWrite => ({ ...unchanged, error });
  if (submitted === undefined) return unchanged;
  if (submitted !== null && typeof submitted !== "string") {
    return refuse("date must be a string");
  }

  const value = nonEmptyString(submitted);
  const source = resolveEditorialDateSource(stored);
  const current = resolveDisplayDate(stored, timeZone);
  // A date readers can already see. Only moving one of those needs publish
  // authority; a draft's date is a proposal until somebody publishes it.
  const isPublic = hasBeenPublic(stored);

  if (value === null) {
    if (source === "firstPublish") return unchanged;
    const derived = stationCalendarDay(stored?.firstPublishedAt, timeZone);
    // Handing the date back to the publication receipt requires there to be one. A
    // post that was already public before this contract existed has no
    // `firstPublishedAt` and never gets one minted (see `applyFirstPublish`), so
    // accepting the clear would blank the only date it has, leave `resolveDisplayDate`
    // null, and make the next publish fail its own snapshot gate for want of a date.
    // The stored day is kept instead; an editor who wants a different one types it.
    if (derived === null && isPublic) {
      return refuse("date cannot be cleared on a post with no recorded first-publish time");
    }
    return {
      backdates: true,
      requiresPublishAuthority: isPublic,
      fields: { date: derived ?? "", editorialDateSource: "firstPublish" },
      error: null,
    };
  }
  if (!isCalendarDay(value)) return refuse("date must be a valid date");
  if (value === current) {
    // Same day, but a legacy record has to be labelled the first time it is saved
    // under this contract or it would keep re-deriving its source on every read.
    return source === "legacy" && stored?.editorialDateSource === undefined
      ? { ...unchanged, fields: { editorialDateSource: "legacy" } }
      : unchanged;
  }
  return {
    backdates: true,
    requiresPublishAuthority: isPublic,
    fields: { date: value, editorialDateSource: "backdated" },
    error: null,
  };
}
