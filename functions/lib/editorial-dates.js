"use strict";

// Server mirror of packages/content-core/src/editorial-dates.ts (issue #1041).
//
// Firebase deploys functions/ on its own, so the TypeScript contract cannot be
// imported here at runtime. This is the CommonJS copy every Cloud Function calls,
// and tests/preflight/editorial-dates-parity.test.js holds the two together by
// running the same table of cases through both.
//
// Read the TypeScript module for why the four dates are separate. The short
// version, because it is the reason this file exists at all: `date` used to be a
// required field an editor filled in to save a draft, so the day someone started
// writing became the day the post claimed to have published. `firstPublishedAt` is
// now minted here, from trusted server time, at the moment publication completes,
// and only ever once.
//
// The zone arithmetic mirrors packages/content-core/src/station-time.ts. It is kept
// small on purpose: this file needs the calendar day of an instant in station time
// and the instant of station midnight on a day, and nothing else.

const { parsePublishInstant } = require("./publish-instant");

const STATION_TIME_ZONE = "America/New_York";

const EDITORIAL_DATE_SOURCES = Object.freeze([
  "firstPublish",
  "backdated",
  "legacy",
]);

/** Server-owned date fields a client may never write directly. */
const SERVER_MANAGED_EDITORIAL_DATE_FIELDS = Object.freeze([
  "editorialDateSource",
  "firstPublishedAt",
  "firstPublishedBy",
  "meaningfulUpdatedAt",
  "meaningfulUpdatedBy",
]);

/** Date fields an editor submits with a save. */
const EDITOR_EDITORIAL_DATE_FIELDS = Object.freeze([
  "date",
  "recordMeaningfulUpdate",
  "showUpdatedDate",
]);

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isCalendarDay(value) {
  if (typeof value !== "string" || !CALENDAR_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function zonedParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function offsetMinutes(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asIfUtc - instant) / 60_000);
}

/**
 * The calendar day a stored instant falls on in station time, or null when the
 * value is not an instant the publish gate can read. Never `slice(0, 10)`: a story
 * published at 11:30 p.m. in New Jersey is stored on the following UTC day.
 */
function stationCalendarDay(value, timeZone = STATION_TIME_ZONE) {
  if (typeof value !== "string") return null;
  const instant = parsePublishInstant(value);
  if (instant === null) return null;
  const parts = zonedParts(instant, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The instant of midnight, station time, on a calendar day. Used when a story has
 * no first-publish instant on its display day.
 * Returns null for a day the calendar does not have.
 */
function stationDayStartInstant(day, timeZone = STATION_TIME_ZONE) {
  if (!isCalendarDay(day)) return null;
  const asIfUtc = Date.parse(`${day}T00:00:00.000Z`);
  // Sample either side of the day so a transition resolves to the earlier reading,
  // matching stationLocalToInstant.
  const candidates = [-24, 0, 24]
    .map((hours) => offsetMinutes(asIfUtc + hours * 3_600_000, timeZone))
    .map((offset) => asIfUtc - offset * 60_000)
    .filter((instant) => stationCalendarDay(new Date(instant).toISOString(), timeZone) === day)
    .sort((a, b) => a - b);
  if (candidates.length > 0) return candidates[0];
  const before = offsetMinutes(asIfUtc - 24 * 3_600_000, timeZone);
  return asIfUtc - before * 60_000;
}

function hasBeenPublic(record) {
  if (!record) return false;
  if (record.publiclyVisible === true) return true;
  return typeof record.published === "object" && record.published !== null;
}

function resolveEditorialDateSource(record) {
  const stored = record?.editorialDateSource;
  if (typeof stored === "string" && EDITORIAL_DATE_SOURCES.includes(stored)) {
    return stored;
  }
  return nonEmptyString(record?.date) ? "legacy" : "firstPublish";
}

function resolveDisplayDate(record, timeZone = STATION_TIME_ZONE) {
  if (!record) return null;
  if (resolveEditorialDateSource(record) === "firstPublish") {
    return stationCalendarDay(record.firstPublishedAt, timeZone);
  }
  const stored = nonEmptyString(record.date);
  if (stored && isCalendarDay(stored)) return stored;
  return stationCalendarDay(record.firstPublishedAt, timeZone);
}

function resolveUpdateDisplay(record, timeZone = STATION_TIME_ZONE) {
  const at = record?.meaningfulUpdatedAt;
  const date = stationCalendarDay(at, timeZone);
  if (!date || typeof at !== "string") return { show: false, at: null, date: null };
  const displayDate = resolveDisplayDate(record, timeZone);
  const show = record?.showUpdatedDate === true && (!displayDate || date > displayDate);
  return { show, at, date };
}

/**
 * Sort by the display day. Backdated and legacy stories use their first-publish
 * instant when it falls on that station day; otherwise, use station midnight.
 */
function editorialSortInstant(record, timeZone = STATION_TIME_ZONE) {
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
 * The fields to write when publication completes. Empty on every publish after the
 * first, and empty for a record that was already public before this contract
 * existed: its real first-publish time is not recoverable, and writing down the
 * most recent publish instead would state a specific falsehood with a server
 * timestamp's authority.
 */
function applyFirstPublish(record, options) {
  const timeZone = options?.timeZone ?? STATION_TIME_ZONE;
  const source = resolveEditorialDateSource(record);
  if (parsePublishInstant(String(record?.firstPublishedAt ?? "")) !== null) return {};
  if (hasBeenPublic(record)) {
    return source === "legacy" ? {} : { editorialDateSource: source };
  }
  if (parsePublishInstant(options?.at) === null) {
    throw new Error("First publish requires an absolute UTC instant");
  }
  if (nonEmptyString(options?.by) === null) {
    throw new Error("First publish requires an actor");
  }
  const stamped = {
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
 * The fields to write for the meaningful-update decision on one save. The request
 * flag always comes back false: leaving it on would turn the next typo fix into a
 * fresh "Updated today", which is the behaviour this contract exists to prevent.
 */
function applyMeaningfulUpdate(options) {
  if (options?.requested !== true) return { recordMeaningfulUpdate: false };
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

/**
 * Read a submitted editorial date against the stored record. `backdates` says the
 * editorial date moves; `requiresPublishAuthority` says that move changes a date
 * readers can already see, which is what the save boundary gates on
 * `content.publish`. A date typed on a draft nobody has seen is a proposal, and it
 * reaches readers only through a publish, which is gated on its own.
 */
function resolveEditorialDateWrite(stored, submitted, timeZone = STATION_TIME_ZONE) {
  const unchanged = {
    backdates: false,
    requiresPublishAuthority: false,
    fields: {},
    error: null,
  };
  const refuse = (error) => ({ ...unchanged, error });
  if (submitted === undefined) return unchanged;
  if (submitted !== null && typeof submitted !== "string") {
    return refuse("date must be a string");
  }

  const value = nonEmptyString(submitted);
  const source = resolveEditorialDateSource(stored);
  const current = resolveDisplayDate(stored, timeZone);
  const isPublic = hasBeenPublic(stored);

  if (value === null) {
    if (source === "firstPublish") return unchanged;
    const derived = stationCalendarDay(stored?.firstPublishedAt, timeZone);
    // A public record with no recoverable first-publish time keeps its stored date:
    // clearing it would leave the post with no display date at all, and no later
    // publish mints one for a record that was already public.
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

module.exports = {
  EDITORIAL_DATE_SOURCES,
  EDITOR_EDITORIAL_DATE_FIELDS,
  SERVER_MANAGED_EDITORIAL_DATE_FIELDS,
  STATION_TIME_ZONE,
  applyFirstPublish,
  applyMeaningfulUpdate,
  editorialSortInstant,
  isCalendarDay,
  resolveDisplayDate,
  resolveEditorialDateSource,
  resolveEditorialDateWrite,
  resolveUpdateDisplay,
  stationCalendarDay,
  stationDayStartInstant,
};
