import { describe, expect, it } from "vitest";
import {
  resolveScheduleAvailability,
  SCHEDULE_CACHED_NOTICE,
  SCHEDULE_STALE_AFTER_MS,
  SCHEDULE_UNAVAILABLE_NOTICE,
  type CachedPayload,
} from "../src/lib/schedule-availability";

// The gap this covers: the /live now-next strip is backed by our own proxy fetch
// of TVSS (schedule-now-next.ts), so unlike the gc.js widget it sees a real fetch
// status. resolveScheduleAvailability is the policy that turns a failed fetch into
// last-known-good listings or an honest empty state, and decides whether retrying
// is worthwhile: a 403 (lapsed access) must not be retried, a timeout or 429
// should be. This proves the PBS-timeout / 403 / 429 handling #189 asks for on
// this surface, with no network and no DOM.

// A stand-in payload: the policy is generic and never inspects the data.
interface Listings {
  readonly label: string;
}
const FRESH: Listings = { label: "fresh" };
const CACHED: Listings = { label: "cached" };

const NOW = new Date("2026-07-08T12:00:00-04:00");
function cacheAgedMs(ms: number): CachedPayload<Listings> {
  return { data: CACHED, fetchedAt: new Date(NOW.getTime() - ms).toISOString() };
}

describe("resolveScheduleAvailability — successful fetch", () => {
  it("renders live listings and asks for no retry", () => {
    const result = resolveScheduleAvailability({
      status: "ok",
      fresh: FRESH,
      cache: cacheAgedMs(1000),
      now: NOW,
    });
    expect(result).toEqual({ render: { mode: "live", data: FRESH }, retryable: false });
  });

  it("treats an ok status with no payload as a broken success: falls back and stays retryable", () => {
    // A mislabeled empty success must not strand the strip on the fallback until
    // a reload, so unlike a real success it is retryable.
    const withCache = resolveScheduleAvailability({
      status: "ok",
      fresh: null,
      cache: cacheAgedMs(1000),
      now: NOW,
    });
    expect(withCache.render.mode).toBe("cached");
    expect(withCache.retryable).toBe(true);

    const noCache = resolveScheduleAvailability({
      status: "ok",
      fresh: null,
      cache: null,
      now: NOW,
    });
    expect(noCache.render.mode).toBe("unavailable");
    expect(noCache.retryable).toBe(true);
  });
});

describe("resolveScheduleAvailability — last-known-good on failure", () => {
  it("serves recent cached listings, marked not stale, with the honest notice", () => {
    const result = resolveScheduleAvailability({
      status: "timeout",
      fresh: null,
      cache: cacheAgedMs(60_000),
      now: NOW,
    });
    expect(result).toEqual({
      render: {
        mode: "cached",
        data: CACHED,
        fetchedAt: cacheAgedMs(60_000).fetchedAt,
        stale: false,
        notice: SCHEDULE_CACHED_NOTICE,
      },
      retryable: true,
    });
  });

  it("flags cached listings older than the threshold as stale", () => {
    const result = resolveScheduleAvailability({
      status: "error",
      fresh: null,
      cache: cacheAgedMs(SCHEDULE_STALE_AFTER_MS + 1),
      now: NOW,
    });
    expect(result.render).toMatchObject({ mode: "cached", stale: true });
  });

  it("treats the staleness threshold as inclusive (exactly old is not stale)", () => {
    const staleAfterMs = 10_000;
    const atThreshold = resolveScheduleAvailability({
      status: "timeout",
      fresh: null,
      cache: cacheAgedMs(staleAfterMs),
      now: NOW,
      staleAfterMs,
    });
    expect(atThreshold.render).toMatchObject({ mode: "cached", stale: false });

    const pastThreshold = resolveScheduleAvailability({
      status: "timeout",
      fresh: null,
      cache: cacheAgedMs(staleAfterMs + 1),
      now: NOW,
      staleAfterMs,
    });
    expect(pastThreshold.render).toMatchObject({ mode: "cached", stale: true });
  });

  it("treats a cache with an unparseable timestamp as stale", () => {
    const result = resolveScheduleAvailability({
      status: "timeout",
      fresh: null,
      cache: { data: CACHED, fetchedAt: "not-a-date" },
      now: NOW,
    });
    expect(result.render).toMatchObject({ mode: "cached", stale: true });
  });
});

describe("resolveScheduleAvailability — honest empty state with no cache", () => {
  it("shows the unavailable notice with a real next step", () => {
    const result = resolveScheduleAvailability({
      status: "timeout",
      fresh: null,
      cache: null,
      now: NOW,
    });
    expect(result.render).toEqual({
      mode: "unavailable",
      notice: SCHEDULE_UNAVAILABLE_NOTICE,
    });
  });
});

describe("resolveScheduleAvailability — retry policy", () => {
  it("does not retry a 403, whether or not a cache is present", () => {
    expect(
      resolveScheduleAvailability({ status: "forbidden", fresh: null, cache: cacheAgedMs(1000), now: NOW }).retryable,
    ).toBe(false);
    expect(
      resolveScheduleAvailability({ status: "forbidden", fresh: null, cache: null, now: NOW }).retryable,
    ).toBe(false);
  });

  it("retries transient failures (timeout, 429, generic error)", () => {
    for (const status of ["timeout", "rateLimited", "error"] as const) {
      expect(
        resolveScheduleAvailability({ status, fresh: null, cache: null, now: NOW }).retryable,
      ).toBe(true);
    }
  });
});

describe("resolveScheduleAvailability — purity", () => {
  it("does not mutate the inputs or the cache object", () => {
    const cache = cacheAgedMs(1000);
    const inputs = { status: "forbidden" as const, fresh: null, cache, now: NOW };
    const frozenCache = Object.freeze({ ...cache });
    resolveScheduleAvailability(inputs);
    expect(cache).toEqual(frozenCache);
    expect(inputs.status).toBe("forbidden");
  });

  it("always resolves to exactly one of the three render modes", () => {
    const statuses = ["ok", "timeout", "forbidden", "rateLimited", "error"] as const;
    for (const status of statuses) {
      for (const cache of [cacheAgedMs(1000), null]) {
        const { render } = resolveScheduleAvailability({
          status,
          fresh: status === "ok" ? FRESH : null,
          cache,
          now: NOW,
        });
        expect(["live", "cached", "unavailable"]).toContain(render.mode);
      }
    }
  });
});
