// Pure degradation policy for the TVSS-backed now/next strip.
// Given the last proxy result, an explicit time and any last-known-good display
// data, choose live, cached or unavailable copy and whether to retry. This differs
// from the gc.js widget policy, which observes an opaque embed through DOM
// signals. Callers own the proxy fetch, cache and rendering.

/**
 * Proxy fetch outcomes that the display policy can act on independently.
 * Forbidden access is not retried; timeouts and rate limits may recover.
 */
export type ScheduleFetchStatus =
  | "ok" // fresh listings returned
  | "timeout" // upstream did not answer in time, or the network is down
  | "forbidden" // 403: access has lapsed, or the key lacks this resource
  | "rateLimited" // 429: over the rate limit, retry later
  | "error"; // any other upstream failure (4xx or 5xx)

/** Last-known-good data plus when we fetched it, for the cached fallback. */
export interface CachedPayload<T> {
  readonly data: T;
  /** When the cached data was fetched, as ISO 8601 with an offset. */
  readonly fetchedAt: string;
}

/** Inputs the availability decision is made from. */
export interface ScheduleAvailabilityInputs<T> {
  readonly status: ScheduleFetchStatus;
  /** The freshly fetched payload. Present when {@link status} is `ok`. */
  readonly fresh: T | null;
  /** Last-known-good payload from a prior successful fetch, or null if none. */
  readonly cache: CachedPayload<T> | null;
  /** The instant the decision is made at, used to judge cache staleness. */
  readonly now: Date;
  /**
   * How old cached data may be before it is flagged stale. A display heuristic
   * for whether to warn the visitor the listings may be out of date, not a hard
   * cache lifetime. Defaults to {@link SCHEDULE_STALE_AFTER_MS}.
   */
  readonly staleAfterMs?: number;
}

/** What the strip renders, as a closed set so no caller can invent a fourth. */
export type ScheduleRender<T> =
  /** A successful fetch: show live listings. */
  | { readonly mode: "live"; readonly data: T }
  /**
   * The fetch failed but we hold last-known-good data: show it, honestly framed
   * and marked with when it was loaded and whether it is now stale.
   */
  | {
      readonly mode: "cached";
      readonly data: T;
      readonly fetchedAt: string;
      readonly stale: boolean;
      readonly notice: string;
    }
  /** The fetch failed and there is nothing cached: show an honest empty state. */
  | { readonly mode: "unavailable"; readonly notice: string };

export interface ScheduleAvailabilityResult<T> {
  readonly render: ScheduleRender<T>;
  /**
   * Whether the caller should schedule an automatic retry of the proxy. False on
   * a genuine successful fetch (nothing to retry) and on a 403 (lapsed access
   * will not self-heal, so retrying only hammers a forbidden endpoint). True for
   * a timeout, a rate limit, or a generic error, which are transient, and also
   * for a broken success (an `ok` status that arrived with no payload): that is a
   * transient failure the proxy mislabeled as `ok`, so the strip should recover
   * on its own rather than sit on the fallback until a page reload.
   */
  readonly retryable: boolean;
}

/** Default staleness threshold: six hours. See {@link ScheduleAvailabilityInputs.staleAfterMs}. */
export const SCHEDULE_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Shown with cached listings after a failed fetch. Names the situation honestly
 * (the live source is down, this is the last set we loaded) so the strip is not
 * silently serving old data as if it were current. The caller pairs it with the
 * `fetchedAt` time and the `stale` flag from the result.
 */
export const SCHEDULE_CACHED_NOTICE =
  "Live listings are temporarily unavailable, so this shows the schedule we last loaded.";

/**
 * Shown when the fetch failed and nothing is cached. Carries a real next step
 * (the livestream, the full schedule) rather than a dead end, matching the honest
 * fallback the schedule widget and the player already offer.
 */
export const SCHEDULE_UNAVAILABLE_NOTICE =
  "Live TV listings are temporarily unavailable. Watch the NJ PBS livestream or open the full schedule.";

/** A failed fetch that is worth retrying automatically. A 403 is not: lapsed
 *  access will not come back on its own, so retrying a forbidden endpoint is
 *  wasted load. A successful fetch has nothing to retry. */
function isRetryable(status: ScheduleFetchStatus): boolean {
  return status === "timeout" || status === "rateLimited" || status === "error";
}

/**
 * Resolve what the now/next strip should render, and whether to retry, from the
 * last fetch outcome and any last-known-good cache.
 *
 * The order is fixed and total: a successful fetch with fresh data is live; any
 * failure (or an `ok` status that arrived without data, which is treated as a
 * failure rather than trusted) falls back to cached data when we hold it, and to
 * the honest unavailable state when we do not. The function never throws and
 * never mutates its inputs, so a caller can re-run it on every fetch result and
 * get a stable, render-ready answer.
 */
export function resolveScheduleAvailability<T>(
  inputs: ScheduleAvailabilityInputs<T>,
): ScheduleAvailabilityResult<T> {
  const { status, fresh, cache, now } = inputs;
  const staleAfterMs = inputs.staleAfterMs ?? SCHEDULE_STALE_AFTER_MS;

  // A successful fetch that actually carried data is the only live path. An `ok`
  // with no payload is a broken success; fall through to the cache rather than
  // render an empty "live" strip.
  if (status === "ok" && fresh !== null) {
    return { render: { mode: "live", data: fresh }, retryable: false };
  }

  // A broken success (`ok` with no payload) is a transient failure the proxy
  // mislabeled, so it is retryable even though `ok` itself is not. Without this
  // the strip would drop to the fallback and never try again without a reload.
  // Reaching here with `ok` means the live branch above already fell through, so
  // this is precisely the empty-payload case.
  const brokenSuccess = status === "ok";
  const retryable = brokenSuccess || isRetryable(status);

  if (cache !== null) {
    const ageMs = now.getTime() - Date.parse(cache.fetchedAt);
    // A cache we cannot date (unparseable timestamp) is treated as stale so the
    // visitor is warned rather than reassured by a missing signal.
    const stale = Number.isNaN(ageMs) ? true : ageMs > staleAfterMs;
    return {
      render: {
        mode: "cached",
        data: cache.data,
        fetchedAt: cache.fetchedAt,
        stale,
        notice: SCHEDULE_CACHED_NOTICE,
      },
      retryable,
    };
  }

  return {
    render: { mode: "unavailable", notice: SCHEDULE_UNAVAILABLE_NOTICE },
    retryable,
  };
}
