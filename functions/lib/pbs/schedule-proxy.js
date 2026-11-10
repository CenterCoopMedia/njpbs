"use strict";

// The TVSS schedule proxy core (#185, #188): everything the schedule endpoint
// does except the Firebase wiring and the secret read, kept free of firebase
// imports so it is unit-tested with an injected fetch and no emulator.
//
// TVSS is PBS's read-only TV Schedules Service. It answers over HTTPS with a
// secret in the X-PBSAUTH header, and every URL requires a trailing slash.
// The browser never calls it directly; this proxy holds the key and returns
// only the display-safe ScheduleDay contract (schedule-day.js).
//
// What is built here: the request URL, the timeout, the header, and the mapping
// from TVSS's HTTP reality onto the ScheduleFetchStatus vocabulary the client
// degradation policy (site/src/lib/schedule-availability.ts) already acts on.
//
// The staged WNJT raw-body transform lives in tvss-schedule-transform.js and
// stays an injected dependency here so the fetch core can be tested without
// coupling to one station feed. The function remains unexported until the key
// lands and the authenticated endpoint's exact response shape is reconciled.

const { toDisplaySafeDay } = require("./schedule-day");

// The only place the PBS host is named. Keeping it here is the point of the thin
// interface: swapping or mocking the upstream touches one module.
const TVSS_BASE_URL = "https://tvss.services.pbs.org/tvss/";

// How long to wait on TVSS before giving up and degrading. The client policy
// treats a timeout as retryable, so a slow upstream never hangs the strip.
const DEFAULT_TIMEOUT_MS = 8000;

const CALLSIGN_PATTERN = /^[a-z0-9]{2,12}$/;
// YYYYMMDD, split into year, month, and day so the value can be checked against a
// real calendar rather than just an eight-digit shape. The round-trip in
// buildScheduleUrl rejects an impossible date (month 13, day 45, Sep 31, a
// non-leap Feb 29) before any network call, so no TVSS quota is spent on a day
// that cannot occur. Same technique as the site-side assertBroadcastDate
// (site/src/lib/broadcast-date.ts), adapted to the dashless TVSS date format.
const DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})$/;

/**
 * Build the TVSS day-listings URL for a callsign and YYYYMMDD date. The
 * live-verified dated path is `<callsign>/day/<date>/` (#777). Lowercases the
 * callsign (TVSS lowercases it anyway) and keeps the mandatory trailing slash.
 * Throws on a malformed callsign, a wrong-shape date, or a shape-valid date that
 * is not a real calendar day (Sep 31, a non-leap Feb 29), so a bad request never
 * reaches the network as an invalid URL.
 */
function buildScheduleUrl({ callsign, date }) {
  const normalizedCallsign =
    typeof callsign === "string" ? callsign.toLowerCase() : "";
  if (!CALLSIGN_PATTERN.test(normalizedCallsign)) {
    throw new Error("invalid callsign: expected 2-12 letters or digits");
  }
  const dateMatch = typeof date === "string" ? date.match(DATE_PATTERN) : null;
  if (!dateMatch) {
    throw new Error("invalid date: expected YYYYMMDD");
  }
  const [, year, month, day] = dateMatch;
  // JS normalizes an out-of-range month or day (Sep 31 rolls into Oct 1) instead
  // of throwing, so a value that does not round-trip through a UTC construction
  // is not a real calendar day.
  const asDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    asDate.getUTCFullYear() !== Number(year) ||
    asDate.getUTCMonth() + 1 !== Number(month) ||
    asDate.getUTCDate() !== Number(day)
  ) {
    throw new Error("invalid date: not a real calendar day");
  }
  return `${TVSS_BASE_URL}${normalizedCallsign}/day/${date}/`;
}

/**
 * Convert a TVSS request date (YYYYMMDD) into the format a served ScheduleDay
 * carries (YYYY-MM-DD). Two formats, one direction, and they are not
 * interchangeable: the dashless form is the TVSS URL path segment, while
 * `day.date` is ISO because the client parses it as `${date}T12:00:00Z`
 * (site/src/lib/schedule-timeline.ts) and the static feed validates it with
 * assertBroadcastDate (site/src/lib/schedule-feed.ts). toDisplaySafeDay enforces
 * the same ISO shape and real-calendar-day rule, so a dashless `day.date` is
 * rejected before it can become an Invalid Date in the browser.
 *
 * Shape-only, because buildScheduleUrl has already rejected an impossible
 * calendar day before the fetch. Throws rather than best-effort, so a bad date
 * degrades the fetch to `error` instead of serving a day the panel cannot read.
 */
function toBroadcastDate(compactDate) {
  const match =
    typeof compactDate === "string" ? compactDate.match(DATE_PATTERN) : null;
  if (!match) {
    // Named, and echoing the value, so a log can tell this guard from the
    // identically-shaped one in buildScheduleUrl.
    throw new Error(
      `toBroadcastDate: expected YYYYMMDD, got ${JSON.stringify(compactDate)}`,
    );
  }
  const [, year, month, day] = match;
  return `${year}-${month}-${day}`;
}

/**
 * Collapse a TVSS HTTP status onto the ScheduleFetchStatus vocabulary. 200 is
 * `ok`; 401/403 are `forbidden` (a missing or lapsed key, which does not
 * self-heal); 429 is `rateLimited`; every other non-2xx is `error`. The client
 * degradation policy keys its retry decision off exactly these cases.
 */
function classifyHttpStatus(httpStatus) {
  if (httpStatus >= 200 && httpStatus < 300) {
    return "ok";
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return "forbidden";
  }
  if (httpStatus === 429) {
    return "rateLimited";
  }
  return "error";
}

/**
 * Classify a failure thrown while fetching or reading the TVSS response. An
 * aborted request is our own timeout firing (whether it aborts the headers or a
 * stalled body stream), and a bare network failure means the upstream did not
 * answer, so both map to `timeout` (which the client treats as retryable). A
 * body that will not parse or transform throws something else and is an
 * unexpected `error`.
 */
function classifyFetchError(err) {
  if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return "timeout";
  }
  if (err instanceof TypeError) {
    // fetch rejects with a TypeError when the network request itself fails.
    return "timeout";
  }
  return "error";
}

function emptyResult(status, fetchedAt) {
  return { status, day: null, fetchedAt };
}

/**
 * Fetch one channel-day from TVSS and return a result the endpoint can serialize
 * directly: a ScheduleFetchStatus, the display-safe ScheduleDay on success, and
 * the fetch time.
 *
 * The fetch core is `not-configured` until it receives both an auth key and its
 * injected transform. Production wiring supplies the WNJT transform; the key
 * comes from Secret Manager (#187) and is blocked on the external PBS-credentials
 * issues. This still checks both dependencies so a partial or test harness never
 * calls TVSS with missing configuration.
 *
 * On a live call it sends X-PBSAUTH, applies a timeout, classifies the HTTP
 * outcome, and on success runs the injected transform and filters its result
 * through toDisplaySafeDay so no upstream-only field can reach the client. The
 * timeout stays live through the body read, so a response that returns headers
 * and then stalls mid-stream degrades to `timeout` instead of hanging until the
 * function deadline. A transform that throws, or a success body that does not
 * shape into a valid ScheduleDay, degrades to `error` rather than serving a
 * malformed day.
 *
 * A 2xx with no body (a 204, or a blank body on any success status) is an empty
 * day: served as `ok` with `entries: []`, without running the transform. The
 * empty-body comments below point back here rather than restating this.
 *
 * `ok` is right because a station with nothing scheduled has answered correctly.
 * Reporting `error` would fail twice over: the client treats `error` as a
 * retryable generic failure and caches it `no-store`, so the front would render a
 * failure state for a healthy upstream and keep re-polling a day that will stay
 * empty. Served as `ok` it lands where it should, which is worth tracing once
 * because two nearby cases read alike: resolveScheduleAvailability takes the
 * `mode: "live"` branch on `status === "ok" && fresh !== null`, and an empty day
 * object is non-null, so getScheduleDayState renders its `kind: "empty"` state.
 * The neighboring retryable "broken success" branch is for an `ok` whose day is
 * absent (`fresh === null`), not for a day with zero entries.
 *
 * Like every fetch path this sits behind the `not-configured` gate above, so it
 * goes live with the key rather than before it. The empty-day shape is settled
 * and tested independently of the transform.
 */
async function fetchSchedule({
  callsign,
  date,
  authKey,
  transform,
  fetchImpl = fetch,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const fetchedAt = now().toISOString();

  if (!authKey || typeof transform !== "function") {
    return emptyResult("not-configured", fetchedAt);
  }

  const url = buildScheduleUrl({ callsign, date });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Fetching the headers and reading the body are both network work under the
    // abort timer: our own timeout abort and bare network failures (including a
    // response that returns headers under the deadline and then stalls mid-body)
    // degrade to `timeout`, which the client treats as retryable. Parsing happens
    // after this block, so a body that will not parse degrades to `error`.
    let rawBody;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { "X-PBSAUTH": authKey, Accept: "application/json" },
        signal: controller.signal,
      });

      const status = classifyHttpStatus(response.status);
      if (status !== "ok") {
        // A non-2xx status is decided from the headers alone; the body is left
        // unread so a hostile or huge error page never streams through the proxy.
        return emptyResult(status, fetchedAt);
      }

      // Text, then parsed below, so an empty body stays distinguishable from a
      // broken one: response.json() throws a SyntaxError on a 204 or any blank
      // 2xx, collapsing the empty day into `error` (see the empty-day paragraph
      // in this function's docstring for why that is the wrong answer).
      rawBody = await response.text();
    } catch (err) {
      return emptyResult(classifyFetchError(err), fetchedAt);
    }

    // The shaping runs on an already-read body, so it is not network work: any
    // failure here means the payload did not shape into a valid ScheduleDay.
    // Classify it as `error`, never `timeout`, whether the mismatch surfaces as a
    // TypeError (reading a field off a missing object), a SyntaxError (a 2xx body
    // that is not JSON), or a rejection from toDisplaySafeDay.
    try {
      // No body means no payload to map, so the empty day is built here from the
      // callsign and date already in hand rather than routed through the
      // transform. Its date is converted, never echoed: see toBroadcastDate.
      const hasBody = rawBody.trim() !== "";
      const day = hasBody
        ? transform(JSON.parse(rawBody), { callsign, date })
        : { date: toBroadcastDate(date), callsign, entries: [] };
      return { status: "ok", day: toDisplaySafeDay(day), fetchedAt };
    } catch {
      return emptyResult("error", fetchedAt);
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  TVSS_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  buildScheduleUrl,
  toBroadcastDate,
  classifyHttpStatus,
  classifyFetchError,
  fetchSchedule,
};
