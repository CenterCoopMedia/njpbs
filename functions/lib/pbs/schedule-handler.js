"use strict";

// The schedule endpoint request handler (#185, #188), free of firebase imports
// so the method guard, CORS, header baseline, input validation, and status
// mapping are unit-tested with a fake req/res and no emulator. functions/
// schedule.js is the thin wiring that reads the secret and wraps this in
// onRequest.

const {
  hardeningHeaders,
  corsHeaders,
  DEFAULT_ALLOWED_ORIGINS,
} = require("../http-headers");
const { buildScheduleUrl, fetchSchedule } = require("./schedule-proxy");

// ScheduleFetchStatus plus the proxy-only configuration/input states to HTTP. The
// body always carries the status too, so a client reads the same signal whether
// it keys off the code or the JSON.
const STATUS_TO_HTTP = Object.freeze({
  ok: 200,
  "not-configured": 503,
  "bad-request": 400,
  forbidden: 403,
  rateLimited: 429,
  timeout: 504,
  error: 502,
});

function readHeader(req, name) {
  if (typeof req.get === "function") {
    return req.get(name) || "";
  }
  if (!req.headers) {
    return "";
  }
  const lower = name.toLowerCase();
  return req.headers[lower] || req.headers[name] || "";
}

function readOrigin(req) {
  return readHeader(req, "origin");
}

function readQueryValue(req, key) {
  const value = req.query ? req.query[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

function applyHeaders(res, headers) {
  for (const [name, value] of Object.entries(headers)) {
    res.set(name, value);
  }
}

// NJ PBS broadcasts on Eastern time, so the default "today" is the station-local
// day, not the UTC day. Formatting in UTC would ask TVSS for tomorrow's listings
// during a normal Eastern prime-time window (any time at or after 00:00Z, e.g.
// 8 p.m. EDT), showing viewers the wrong day.
const STATION_TIME_ZONE = "America/New_York";

/**
 * Format a Date as YYYYMMDD in the station's timezone, TVSS's date-path format.
 * en-CA renders an ISO-style YYYY-MM-DD, so stripping the dashes gives the
 * date TVSS expects.
 */
function formatDate(date, timeZone = STATION_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  return parts.replace(/-/g, "");
}

/**
 * Build the schedule request handler. Dependencies are injected so the wiring
 * supplies the live secret read, the station callsign, the origin allowlist, and
 * (once it exists) the raw-to-model transform, while a test supplies fakes.
 */
function createScheduleHandler(deps = {}) {
  const {
    fetchScheduleFn = fetchSchedule,
    getAuthKey = () => null,
    getTransform = () => undefined,
    getDefaultCallsign = () => "wnjt",
    getAllowlist = () => DEFAULT_ALLOWED_ORIGINS,
    stationTimeZone = STATION_TIME_ZONE,
    now = () => new Date(),
  } = deps;

  return async (req, res) => {
    // The header baseline and CORS decision apply to every response, including
    // errors and the preflight, so a failure is as locked down as a success. The
    // allowlist and callsign default are read per request so firebase deploy
    // params resolve at runtime.
    const requestOrigin = readOrigin(req);
    const { headers: cors, allowed: originAllowed } = corsHeaders({
      requestOrigin,
      allowlist: getAllowlist(),
    });
    applyHeaders(res, { ...hardeningHeaders(), ...cors });

    if (req.method === "OPTIONS") {
      // A disallowed origin still gets a 204, just without the allow-origin
      // header, which is how the browser learns the real request is not allowed.
      res.status(204).end();
      return;
    }

    if (req.method !== "GET") {
      res.status(405).json({ status: "error", error: "method not allowed" });
      return;
    }

    // Enforce the allowlist as the boundary, not just a browser read-block, so a
    // foreign page cannot spend a PBS TVSS call. Two signals, because neither is
    // complete on its own:
    //   1. Fetch Metadata: browsers set Sec-Fetch-Site even on no-cors
    //      subresource loads (`<img>`, `<script>`) that omit Origin, so it
    //      catches the cross-site quota-drain the Origin check alone misses.
    //   2. Origin allowlist: a CORS request carries an Origin; if it is present
    //      but not allowed, reject it too (older browsers may omit Sec-Fetch-Site).
    // A request with neither signal (same-origin, server-to-server, monitoring,
    // an old browser) cannot be judged here and passes through; the per-IP rate
    // limit for those callers is #254.
    if (readHeader(req, "sec-fetch-site") === "cross-site") {
      res.status(403).json({ status: "error", error: "cross-site request" });
      return;
    }
    if (requestOrigin && !originAllowed) {
      res.status(403).json({ status: "error", error: "origin not allowed" });
      return;
    }

    const callsign = readQueryValue(req, "callsign") || getDefaultCallsign();
    const date = readQueryValue(req, "date") || formatDate(now(), stationTimeZone);

    try {
      // Validate the request shape up front so a bad callsign or date is a clear
      // 400 rather than a confusing upstream failure, even before the proxy is
      // configured.
      buildScheduleUrl({ callsign, date });
    } catch {
      res.set("Cache-Control", "no-store");
      res.status(400).json({
        status: "bad-request",
        day: null,
        fetchedAt: now().toISOString(),
      });
      return;
    }

    let result;
    try {
      result = await fetchScheduleFn({
        callsign,
        date,
        authKey: getAuthKey(),
        transform: getTransform(),
        now,
      });
    } catch {
      // Secret reads and request setup can fail temporarily. Keep the failure
      // retryable without sending exception details or credentials to clients.
      result = { status: "error", day: null, fetchedAt: now().toISOString() };
    }

    const httpStatus = STATUS_TO_HTTP[result.status] ?? 502;
    // Successful listings may be briefly cached at the edge; anything else must
    // not be, so a transient failure is never held as if it were an answer.
    res.set(
      "Cache-Control",
      result.status === "ok" ? "public, max-age=60" : "no-store",
    );
    res.status(httpStatus).json(result);
  };
}

module.exports = {
  STATUS_TO_HTTP,
  STATION_TIME_ZONE,
  formatDate,
  createScheduleHandler,
};
