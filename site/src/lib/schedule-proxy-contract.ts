// Browser-facing request and response contract for the schedule proxy.
// The server owns TVSS credentials and returns only display-safe ScheduleDay
// data. This pure module maps its wire statuses to ScheduleFetchStatus; callers
// own fetches, caching, retries and DOM updates.

import type { ScheduleDay } from "./schedule-now-next.ts";
import type { ScheduleFetchStatus } from "./schedule-availability.ts";
import { isBroadcastDate } from "./broadcast-date.ts";

/** The wire contract adds bad-request (HTTP 400) and not-configured (HTTP 503)
 * for invalid requests or incomplete upstream configuration. Both map to a
 * non-retryable client state. */
export type ScheduleProxyStatus =
  | "ok"
  | "not-configured"
  | "bad-request"
  | "forbidden"
  | "rateLimited"
  | "timeout"
  | "error";

// Every wire status, for validating an untrusted response envelope at runtime.
// The parsed body is untyped JSON, so a status outside this set (a proxy bug, a
// truncated body, a stray gateway page) is caught rather than trusted.
const PROXY_STATUSES: ReadonlySet<string> = new Set<ScheduleProxyStatus>([
  "ok",
  "not-configured",
  "bad-request",
  "forbidden",
  "rateLimited",
  "timeout",
  "error",
]);

/**
 * The proxy response envelope, mirroring functions/lib/pbs/schedule-proxy.js: a
 * status, the display-safe day on success (null otherwise), and when the proxy
 * fetched it. `day` is a ScheduleDay only when `status` is `ok`.
 */
export interface ScheduleProxyResponse {
  readonly status: ScheduleProxyStatus;
  readonly day: ScheduleDay | null;
  readonly fetchedAt: string;
}

/**
 * The parameters the front may scope a schedule request to. Both are optional:
 * the proxy defaults the callsign to the station and the date to today in the
 * station's zone when they are absent.
 */
export interface ScheduleProxyQuery {
  readonly callsign?: string;
  readonly date?: string;
}

/**
 * Build the query string for a schedule proxy request, e.g.
 * "?callsign=wnjt&date=20260710". A parameter that is absent or empty is
 * omitted, because the proxy treats a missing or empty callsign or date the same
 * way: it resolves each with `value || default`, so an empty value falls back to
 * the station callsign or today in the station's zone rather than reaching the
 * proxy's 400 path. Omitting an empty value therefore matches the proxy's own
 * contract and keeps a request from a cleared form field to the default day. The
 * result is "" when neither is given. Values are URL-encoded. Beyond the
 * empty-is-default rule the proxy validates callsign and date and answers a
 * malformed one with 400, so this does not re-check them: the server is the
 * single validation authority, and duplicating its rules here would let the two
 * sides drift.
 */
export function buildScheduleProxyQuery(query: ScheduleProxyQuery = {}): string {
  const params = new URLSearchParams();
  if (query.callsign) {
    params.set("callsign", query.callsign);
  }
  if (query.date) {
    params.set("date", query.date);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

/**
 * The client-facing outcome of one proxy fetch: a ScheduleFetchStatus the
 * degradation policy understands, and the day when it is live.
 */
export interface MappedScheduleFetch {
  readonly status: ScheduleFetchStatus;
  readonly day: ScheduleDay | null;
}

// A structural check that an untrusted value matches the ScheduleDay shape the
// client renders: the fields deriveNowNext and the grid read. The server already
// filters every served day through toDisplaySafeDay, so this does not distrust
// our own proxy; it guards against a tampered, truncated, or gateway-rewritten
// body that still says `ok` but carries no usable day (for example
// { "status": "ok", "day": {} }, which would throw in deriveNowNext when it maps
// over a missing entries array). Timestamps are not parsed here because
// deriveNowNext already drops entries whose start or end will not parse.
//
// A single malformed entry rejects the whole day, unlike deriveNowNext, which
// skips a bad entry and renders the rest. The two layers have different jobs:
// this is a trust gate on an untrusted body (a malformed entry from a server
// that runs toDisplaySafeDay signals a tampered or truncated payload, so the
// day is distrusted wholesale), while deriveNowNext is rendering leniency on a
// day that already passed this gate.
function isScheduleEntry(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.startsAt === "string" &&
    entry.startsAt !== "" &&
    typeof entry.endsAt === "string" &&
    entry.endsAt !== "" &&
    typeof entry.title === "string" &&
    entry.title !== ""
  );
}

function isScheduleDay(value: unknown): value is ScheduleDay {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const day = value as Record<string, unknown>;
  // Strict about the shape, not merely about presence. This gate exists for a
  // body that did not come from our proxy, and a dashless "20260710" is both the
  // most likely wrong value (it is what TVSS itself uses) and one that renders as
  // "Date unavailable" without throwing. A non-empty-string check accepts it.
  if (!isBroadcastDate(day.date)) {
    return false;
  }
  if (typeof day.callsign !== "string" || day.callsign === "") {
    return false;
  }
  if (!Array.isArray(day.entries)) {
    return false;
  }
  return day.entries.every(isScheduleEntry);
}

/**
 * Translate a proxy response into the client's ScheduleFetchStatus vocabulary,
 * so schedule-availability.ts decides the render and the retry from one source.
 * The mapping is total and never throws: an envelope that is not a known shape
 * degrades to `error`, the policy's retryable generic-failure case, rather than
 * crashing the strip on a proxy bug or a truncated body.
 *
 * `not-configured` collapses onto `forbidden`. Both mean the proxy structurally
 * cannot serve listings and retrying will not change that: a 403 is lapsed
 * access, `not-configured` is missing upstream configuration. Both take the
 * non-retryable fallback path, and the client needs no separate case because the
 * visitor behavior is identical: show the last-known-good day or the honest
 * unavailable state, and do not auto-retry.
 * `bad-request` takes the same non-retryable path: repeating a malformed query
 * cannot fix it. A thrown secret read is instead `error`, which remains retryable.
 *
 * An `ok` status is live only when its `day` is a valid ScheduleDay. A
 * well-formed `ok` always carries one, because the server filters every served
 * day through toDisplaySafeDay. An `ok` that arrives with a missing or malformed
 * day is a broken success the renderer cannot use, so it degrades to `error`
 * (retryable) rather than reaching the strip as bogus live data. A mapped `ok`
 * therefore always carries a usable day.
 */
export function mapScheduleProxyResponse(
  response: ScheduleProxyResponse,
): MappedScheduleFetch {
  if (
    response === null ||
    typeof response !== "object" ||
    !PROXY_STATUSES.has(response.status)
  ) {
    return { status: "error", day: null };
  }

  switch (response.status) {
    case "ok":
      return isScheduleDay(response.day)
        ? { status: "ok", day: response.day }
        : { status: "error", day: null };
    case "not-configured":
    case "bad-request":
    case "forbidden":
      return { status: "forbidden", day: null };
    case "rateLimited":
      return { status: "rateLimited", day: null };
    case "timeout":
      return { status: "timeout", day: null };
    case "error":
      return { status: "error", day: null };
    default: {
      // Exhaustiveness: response.status narrows to `never` here because every
      // ScheduleProxyStatus is handled above, so adding a status without a case
      // makes this assignment a compile error instead of a silent miss. The
      // runtime guard above means this branch never executes.
      const unreachable: never = response.status;
      return { status: unreachable, day: null };
    }
  }
}
