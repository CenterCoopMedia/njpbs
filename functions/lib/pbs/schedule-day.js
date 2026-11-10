"use strict";

// The display-safe schedule contract, server side (#188).
//
// This mirrors the browser-facing model in site/src/lib/schedule-now-next.ts:
// ScheduleEntry / ScheduleDay are the only fields the browser is allowed to see.
// The proxy passes every day it is about to return through toDisplaySafeDay, so
// the TVSS X-PBSAUTH key, provider ids, headend detail, and any other
// upstream-only metadata are dropped by construction rather than by a reviewer
// remembering to strip them (acceptance criterion 2 of #185, made executable).
//
// The projector operates on the already-normalized ScheduleDay shape, not on a
// raw TVSS payload. tvss-schedule-transform.js owns the WNJT mapping; this module
// guarantees that its result is filtered before it reaches the browser.

function fail(message) {
  return new Error(`invalid schedule day: ${message}`);
}

function requireString(value, field) {
  if (typeof value !== "string" || value === "") {
    throw fail(`${field} must be a non-empty string`);
  }
  return value;
}

// ISO YYYY-MM-DD, captured so the value can be checked against a real calendar
// rather than only a shape.
const BROADCAST_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Require a served day's date to be the ISO YYYY-MM-DD the client can parse.
 *
 * A non-empty string is not enough here, which is why this exists rather than
 * another requireString call. The client reads `day.date` as
 * `new Date(`${value}T12:00:00Z`)` (site/src/lib/schedule-timeline.ts), so any
 * other shape is an Invalid Date: the panel renders "Date unavailable" and the
 * hour grid falls back to a generic 24 hours. Nothing throws and nothing logs.
 *
 * The shape that actually shows up is TVSS's own dashless YYYYMMDD, because that
 * is the format the proxy is called with and the transform receives in
 * `ctx.date`. Passing it straight through is the obvious implementation and the
 * wrong one, so the contract rejects it here instead of trusting every future
 * transform to remember. This is the server-side twin of the static feed's
 * assertBroadcastDate (site/src/lib/broadcast-date.ts), same calendar round-trip.
 *
 * Throwing degrades the whole day to `error` in fetchSchedule instead of serving
 * it, which is worth doing even though the client treats `error` as retryable.
 * Only two things reach this: the injected transform's output, and the synthetic
 * empty day, which is ISO by construction (toBroadcastDate). So a bad shape here
 * is a deploy bug, not a runtime condition TVSS can trigger. Retrying a deploy
 * bug spends quota without fixing it, and serving the day hides it behind a panel
 * that looks populated and carries no date. An `error` is at least visible.
 */
function requireBroadcastDate(value, field) {
  const match = requireString(value, field).match(BROADCAST_DATE_PATTERN);
  if (!match) {
    throw fail(`${field} must be an ISO date (YYYY-MM-DD), got ${value}`);
  }
  const [, year, month, day] = match;
  // JS normalizes an out-of-range month or day (Sep 31 rolls into Oct 1) instead
  // of throwing, so a value that does not round-trip is not a real calendar day.
  const asDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    asDate.getUTCFullYear() !== Number(year) ||
    asDate.getUTCMonth() + 1 !== Number(month) ||
    asDate.getUTCDate() !== Number(day)
  ) {
    throw fail(`${field} is not a real calendar day: ${value}`);
  }
  return value;
}

/**
 * Project one listing down to the four display fields. Unknown fields are
 * dropped: only startsAt, endsAt, title, and (when present and non-empty)
 * episodeTitle survive, so nothing the upstream feed carries can leak through a
 * spread. episodeTitle is optional and is omitted entirely when absent or empty
 * rather than serialized as null, matching the optional field in the model.
 */
function toDisplaySafeEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw fail("entry must be an object");
  }

  const safe = {
    startsAt: requireString(entry.startsAt, "startsAt"),
    endsAt: requireString(entry.endsAt, "endsAt"),
    title: requireString(entry.title, "title"),
  };

  if (typeof entry.episodeTitle === "string" && entry.episodeTitle !== "") {
    safe.episodeTitle = entry.episodeTitle;
  }

  return safe;
}

/**
 * Project one channel-day down to the display-safe contract. Validates the day
 * envelope, requires an ISO date the client can parse (requireBroadcastDate),
 * lowercases the callsign to match the model's convention, and maps every entry
 * through toDisplaySafeEntry. Throws if entries is not an array or any entry is
 * malformed, so a caller can treat a thrown error as "do not serve this day"
 * rather than shipping a half-valid payload.
 */
function toDisplaySafeDay(day) {
  if (day === null || typeof day !== "object" || Array.isArray(day)) {
    throw fail("day must be an object");
  }
  if (!Array.isArray(day.entries)) {
    throw fail("entries must be an array");
  }

  return {
    date: requireBroadcastDate(day.date, "date"),
    callsign: requireString(day.callsign, "callsign").toLowerCase(),
    entries: day.entries.map(toDisplaySafeEntry),
  };
}

module.exports = {
  toDisplaySafeEntry,
  toDisplaySafeDay,
  requireBroadcastDate,
};
