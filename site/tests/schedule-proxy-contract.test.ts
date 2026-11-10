import { describe, expect, it } from "vitest";
import {
  buildScheduleProxyQuery,
  mapScheduleProxyResponse,
  type ScheduleProxyResponse,
} from "../src/lib/schedule-proxy-contract";
import {
  resolveScheduleAvailability,
  SCHEDULE_UNAVAILABLE_NOTICE,
  type CachedPayload,
} from "../src/lib/schedule-availability";
import type { ScheduleDay } from "../src/lib/schedule-now-next";

// The gap this covers: the static front reaches the schedule proxy over a
// documented interface (#185 acceptance criterion 1). schedule-proxy-contract.ts
// is that interface on the client side. It defines the request query and the
// response envelope, and translates the proxy's six-value wire status onto the
// five-value ScheduleFetchStatus the degradation policy acts on. These prove the
// translation is total and, fed through the real policy, yields the right render
// and retry, with no network and no DOM. The load-bearing case is the current
// reality: the proxy reports `not-configured` until its key lands, and the strip
// must show the honest fallback without hammering an unconfigured endpoint.

const DAY: ScheduleDay = {
  date: "2026-07-10",
  callsign: "wnjt",
  entries: [
    {
      startsAt: "2026-07-10T20:00:00-04:00",
      endsAt: "2026-07-10T21:00:00-04:00",
      title: "Nature",
    },
  ],
};

function proxyResponse(
  overrides: Partial<ScheduleProxyResponse>,
): ScheduleProxyResponse {
  return {
    status: "ok",
    day: null,
    fetchedAt: "2026-07-10T20:05:00-04:00",
    ...overrides,
  };
}

describe("buildScheduleProxyQuery", () => {
  it("returns an empty string when neither parameter is given", () => {
    expect(buildScheduleProxyQuery()).toBe("");
    expect(buildScheduleProxyQuery({})).toBe("");
  });

  it("includes only the parameters that are present, so the proxy defaults the rest", () => {
    expect(buildScheduleProxyQuery({ callsign: "wnjt" })).toBe("?callsign=wnjt");
    expect(buildScheduleProxyQuery({ date: "20260710" })).toBe("?date=20260710");
    expect(buildScheduleProxyQuery({ callsign: "wnjt", date: "20260710" })).toBe(
      "?callsign=wnjt&date=20260710",
    );
  });

  it("url-encodes parameter values", () => {
    expect(buildScheduleProxyQuery({ callsign: "a b" })).toBe("?callsign=a+b");
  });

  it("omits an explicitly empty value, matching how the proxy defaults an empty callsign or date", () => {
    // The proxy resolves callsign and date with `value || default`, so an empty
    // string falls back to the default rather than erroring. Omitting it here
    // produces the same default fetch instead of sending `?callsign=`.
    expect(buildScheduleProxyQuery({ callsign: "", date: "" })).toBe("");
    expect(buildScheduleProxyQuery({ callsign: "", date: "20260710" })).toBe(
      "?date=20260710",
    );
  });
});

describe("mapScheduleProxyResponse", () => {
  it("maps a successful response to ok and carries the day", () => {
    const mapped = mapScheduleProxyResponse(
      proxyResponse({ status: "ok", day: DAY }),
    );
    expect(mapped).toEqual({ status: "ok", day: DAY });
  });

  it("degrades an ok status with no day to error rather than promoting a broken success to live", () => {
    const mapped = mapScheduleProxyResponse(
      proxyResponse({ status: "ok", day: null }),
    );
    expect(mapped).toEqual({ status: "error", day: null });
  });

  it("degrades an ok status with a malformed day (missing entries) to error, not live data", () => {
    const malformed = {
      status: "ok",
      day: { date: "2026-07-10", callsign: "wnjt" },
      fetchedAt: "2026-07-10T20:05:00-04:00",
    };
    expect(
      mapScheduleProxyResponse(malformed as unknown as ScheduleProxyResponse),
    ).toEqual({ status: "error", day: null });
  });

  it("degrades an ok status whose day carries a malformed entry to error", () => {
    const malformed = {
      status: "ok",
      day: {
        date: "2026-07-10",
        callsign: "wnjt",
        entries: [{ startsAt: "2026-07-10T20:00:00-04:00", title: "Nature" }],
      },
      fetchedAt: "2026-07-10T20:05:00-04:00",
    };
    expect(
      mapScheduleProxyResponse(malformed as unknown as ScheduleProxyResponse),
    ).toEqual({ status: "error", day: null });
  });

  it("degrades an ok status whose day carries TVSS's dashless date to error", () => {
    // #753. This gate guards a body that did not come from our proxy, and a
    // dashless date is the wrong value most likely to arrive, because it is the
    // format TVSS itself uses and the one the proxy is called with. It used to
    // pass, because the check only asked for a non-empty string. The renderer
    // then reads it as `new Date("20260710T12:00:00Z")`, an Invalid Date, and
    // draws "Date unavailable" over a generic 24-hour grid without throwing.
    const dashless = {
      status: "ok",
      day: { ...DAY, date: "20260710" },
      fetchedAt: "2026-07-10T20:05:00-04:00",
    };
    expect(
      mapScheduleProxyResponse(dashless as unknown as ScheduleProxyResponse),
    ).toEqual({ status: "error", day: null });
  });

  it("degrades an ok status whose day names a date that never happened", () => {
    // Shape alone is not enough: Date.UTC rolls Sep 31 into Oct 1 instead of
    // rejecting it, so a day that parses is not necessarily a day that exists.
    for (const date of ["2026-09-31", "2026-02-29", "2026-13-01"]) {
      const impossible = {
        status: "ok",
        day: { ...DAY, date },
        fetchedAt: "2026-07-10T20:05:00-04:00",
      };
      expect(
        mapScheduleProxyResponse(impossible as unknown as ScheduleProxyResponse),
      ).toEqual({ status: "error", day: null });
    }
  });

  it("still accepts a real ISO day, including a genuine leap day", () => {
    // The guard has to reject the bad shapes without costing a good one, or the
    // strip goes dark on a working proxy every fourth February.
    for (const date of ["2026-07-10", "2028-02-29", "2026-01-01"]) {
      const mapped = mapScheduleProxyResponse(
        proxyResponse({ status: "ok", day: { ...DAY, date } }),
      );
      expect(mapped.status).toBe("ok");
      expect(mapped.day?.date).toBe(date);
    }
  });

  it("collapses not-configured onto forbidden so retrying does not hammer an unconfigured proxy", () => {
    const mapped = mapScheduleProxyResponse(
      proxyResponse({ status: "not-configured" }),
    );
    expect(mapped).toEqual({ status: "forbidden", day: null });
  });

  it("maps the remaining statuses onto their client equivalents", () => {
    expect(
      mapScheduleProxyResponse(proxyResponse({ status: "forbidden" })).status,
    ).toBe("forbidden");
    expect(
      mapScheduleProxyResponse(proxyResponse({ status: "rateLimited" })).status,
    ).toBe("rateLimited");
    expect(
      mapScheduleProxyResponse(proxyResponse({ status: "timeout" })).status,
    ).toBe("timeout");
    expect(
      mapScheduleProxyResponse(proxyResponse({ status: "error" })).status,
    ).toBe("error");
  });

  it("degrades an unknown or malformed envelope to error rather than throwing", () => {
    const unknownStatus = { status: "teapot", day: null, fetchedAt: "" };
    expect(
      mapScheduleProxyResponse(unknownStatus as unknown as ScheduleProxyResponse),
    ).toEqual({ status: "error", day: null });
    expect(
      mapScheduleProxyResponse(null as unknown as ScheduleProxyResponse),
    ).toEqual({ status: "error", day: null });
    expect(
      mapScheduleProxyResponse(
        "not an object" as unknown as ScheduleProxyResponse,
      ),
    ).toEqual({ status: "error", day: null });
  });
});

describe("proxy contract feeding the degradation policy", () => {
  const now = new Date("2026-07-10T20:06:00-04:00");

  it.each([
    ["bad-request", false],
    ["error", true],
  ] as const)("gives %s the correct retry policy", (status, retryable) => {
    const mapped = mapScheduleProxyResponse(proxyResponse({ status }));
    const result = resolveScheduleAvailability({
      status: mapped.status,
      fresh: mapped.day,
      cache: null,
      now,
    });
    expect(result.render.mode).toBe("unavailable");
    expect(result.retryable).toBe(retryable);
  });

  it("renders a not-configured proxy as the honest unavailable state and does not retry", () => {
    const mapped = mapScheduleProxyResponse(
      proxyResponse({ status: "not-configured" }),
    );
    const result = resolveScheduleAvailability({
      status: mapped.status,
      fresh: mapped.day,
      cache: null,
      now,
    });
    expect(result.render).toEqual({
      mode: "unavailable",
      notice: SCHEDULE_UNAVAILABLE_NOTICE,
    });
    expect(result.retryable).toBe(false);
  });

  it("serves last-known-good listings when not-configured but a cache exists, still without retrying", () => {
    const cache: CachedPayload<ScheduleDay> = {
      data: DAY,
      fetchedAt: "2026-07-10T20:00:00-04:00",
    };
    const mapped = mapScheduleProxyResponse(
      proxyResponse({ status: "not-configured" }),
    );
    const result = resolveScheduleAvailability({
      status: mapped.status,
      fresh: mapped.day,
      cache,
      now,
    });
    expect(result.render.mode).toBe("cached");
    expect(result.retryable).toBe(false);
  });

  it("renders a live day on a successful fetch", () => {
    const mapped = mapScheduleProxyResponse(
      proxyResponse({ status: "ok", day: DAY }),
    );
    const result = resolveScheduleAvailability({
      status: mapped.status,
      fresh: mapped.day,
      cache: null,
      now,
    });
    expect(result.render).toEqual({ mode: "live", data: DAY });
    expect(result.retryable).toBe(false);
  });

  it("retries a transient timeout, falling back to cache in the meantime", () => {
    const cache: CachedPayload<ScheduleDay> = {
      data: DAY,
      fetchedAt: "2026-07-10T20:00:00-04:00",
    };
    const mapped = mapScheduleProxyResponse(
      proxyResponse({ status: "timeout" }),
    );
    const result = resolveScheduleAvailability({
      status: mapped.status,
      fresh: mapped.day,
      cache,
      now,
    });
    expect(result.render.mode).toBe("cached");
    expect(result.retryable).toBe(true);
  });

  it("falls back and retries a broken success (ok with no day) rather than sitting on the fallback", () => {
    const cache: CachedPayload<ScheduleDay> = {
      data: DAY,
      fetchedAt: "2026-07-10T20:00:00-04:00",
    };
    const mapped = mapScheduleProxyResponse(
      proxyResponse({ status: "ok", day: null }),
    );
    const result = resolveScheduleAvailability({
      status: mapped.status,
      fresh: mapped.day,
      cache,
      now,
    });
    expect(result.render.mode).toBe("cached");
    expect(result.retryable).toBe(true);
  });

  it("renders the honest unavailable state for a malformed ok, never crashing on the bad day", () => {
    // The finding's exact case: a body that still says ok but carries an
    // unusable day. It must degrade to the fallback, not reach the renderer.
    const malformed = {
      status: "ok",
      day: { date: "2026-07-10", callsign: "wnjt" },
      fetchedAt: "2026-07-10T20:05:00-04:00",
    };
    const mapped = mapScheduleProxyResponse(
      malformed as unknown as ScheduleProxyResponse,
    );
    const result = resolveScheduleAvailability({
      status: mapped.status,
      fresh: mapped.day,
      cache: null,
      now,
    });
    expect(result.render).toEqual({
      mode: "unavailable",
      notice: SCHEDULE_UNAVAILABLE_NOTICE,
    });
    expect(result.retryable).toBe(true);
  });
});
