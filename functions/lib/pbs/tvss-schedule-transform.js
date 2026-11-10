"use strict";

// Candidate display-safe WNJT mapping for the TVSS proxy. This is the server-side
// subset of site/src/lib/schedule-feed.ts, pinned to the public JAWS
// providers-feed fixture. It must be reconciled against a sanitized response
// from the exact authenticated endpoint before schedule.js wires it.

const TVSS_TIME_ZONE = "America/New_York";
const TVSS_WNJT_FEED_CID = "4211290e-ce30-49e5-9be1-2c412c5b3278";
const TVSS_WNJT_FEED_SHORT_NAME = "WNJTDT";

const CONTAMINATED_ON_STORY_CID = "86e58e7f-f313-42cd-a105-274eb900b8df";
const CONTAMINATED_ON_STORY_PROGRAM_EXTERNAL_ID = "SH014081970000";
const CONTAMINATED_ON_STORY_EPISODE_TITLE =
  "Gun and Powder'' at Paper Mill Playhouse, Architect Edward T. Bowser, Jr. &";

function transformTvssScheduleDay(payload, { callsign, date }) {
  if (typeof callsign !== "string" || callsign.toLowerCase() !== "wnjt") {
    throw new Error("The staged TVSS transform only supports the WNJT callsign.");
  }
  const broadcastDate = compactBroadcastDate(date);
  const root = asRecord(payload, "TVSS payload");
  const broadcast = asArray(root.headends, "TVSS headends")
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
    feeds.find(({ short_name: shortName }) =>
      shortName === TVSS_WNJT_FEED_SHORT_NAME
    );
  if (!feed) {
    throw new Error("Broadcast headend has no WNJTDT feed.");
  }

  const listings = asArray(feed.listings, "WNJTDT listings").map((value) =>
    asRecord(value, "TVSS listing"),
  );
  if (listings.length === 0) {
    throw new Error("TVSS broadcast day has no listings.");
  }

  const entries = [];
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const listing of listings) {
    const entry = mapListing(listing, broadcastDate, previousEnd);
    entries.push(entry);
    previousEnd = Date.parse(entry.endsAt);
  }

  return {
    date: broadcastDate,
    callsign: requiredString(callsign, "callsign").toLowerCase(),
    entries,
  };
}

function mapListing(listing, broadcastDate, earliestInstant) {
  const startTime = requiredString(listing.start_time, "listing start_time");
  if (!/^(?:[01]\d|2[0-3])[0-5]\d$/.test(startTime)) {
    throw new Error(`TVSS listing has an invalid start_time: ${startTime}`);
  }

  const candidates = zonedLocalInstants(
    broadcastDate,
    startTime,
    TVSS_TIME_ZONE,
  );
  if (candidates.length === 0) {
    throw new Error(
      `TVSS listing start ${broadcastDate} ${startTime} does not exist in ${TVSS_TIME_ZONE}.`,
    );
  }
  const startInstant = candidates.find(
    (candidate) => candidate >= earliestInstant,
  );
  if (startInstant === undefined) {
    throw new Error(
      `TVSS listing start ${broadcastDate} ${startTime} overlaps or precedes the prior listing.`,
    );
  }

  const endInstant = startInstant + parseTvssDuration(listing.duration) * 60_000;
  const sourceEpisodeTitle = optionalString(listing.episode_title);
  const contaminatedEpisodeTitle =
    listing.cid === CONTAMINATED_ON_STORY_CID &&
    listing.program_external_id === CONTAMINATED_ON_STORY_PROGRAM_EXTERNAL_ID &&
    sourceEpisodeTitle === CONTAMINATED_ON_STORY_EPISODE_TITLE;
  const episodeTitle = contaminatedEpisodeTitle
    ? undefined
    : sourceEpisodeTitle;

  return {
    startsAt: formatZonedIso(startInstant, TVSS_TIME_ZONE),
    endsAt: formatZonedIso(endInstant, TVSS_TIME_ZONE),
    title: requiredString(listing.title, "listing title"),
    ...(episodeTitle ? { episodeTitle } : {}),
  };
}

function compactBroadcastDate(value) {
  const match = typeof value === "string"
    ? value.match(/^(\d{4})(\d{2})(\d{2})$/)
    : null;
  if (!match) {
    throw new Error("TVSS date must use YYYYMMDD.");
  }
  const [, year, month, day] = match;
  const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    candidate.getUTCFullYear() !== Number(year) ||
    candidate.getUTCMonth() + 1 !== Number(month) ||
    candidate.getUTCDate() !== Number(day)
  ) {
    throw new Error(`TVSS date is not a real calendar day: ${value}`);
  }
  return `${year}-${month}-${day}`;
}

// TVSS encodes durations as HHMM-like integers: 100 means one hour.
function parseTvssDuration(value) {
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

function zonedLocalInstants(date, time, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2));
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set(
    [-12, 0, 12].map((hours) =>
      timeZoneOffsetMinutes(localAsUtc + hours * 3_600_000, timeZone),
    ),
  );
  const expected = `${date}T${time.slice(0, 2)}:${time.slice(2)}:00`;
  return Array.from(offsets)
    .map((offsetMinutes) => localAsUtc - offsetMinutes * 60_000)
    .filter((instant) => formatZonedIso(instant, timeZone).slice(0, 19) === expected)
    .filter((instant, index, values) => values.indexOf(instant) === index)
    .sort((a, b) => a - b);
}

function formatZonedIso(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  const offsetMinutes = timeZoneOffsetMinutes(instant, timeZone);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

function timeZoneOffsetMinutes(instant, timeZone) {
  const parts = zonedParts(instant, timeZone);
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((representedAsUtc - instant) / 60_000);
}

function zonedParts(instant, timeZone) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(new Date(instant))
    .reduce((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});

  const { year, month, day, hour, minute, second } = values;
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error(`Could not format a date in ${timeZone}.`);
  }
  return { year, month, day, hour, minute, second };
}

function asRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value;
}

function asArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing.`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  TVSS_TIME_ZONE,
  TVSS_WNJT_FEED_CID,
  TVSS_WNJT_FEED_SHORT_NAME,
  transformTvssScheduleDay,
};
