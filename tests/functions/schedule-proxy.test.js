import { describe, expect, it, vi } from "vitest";

import httpHeaders from "../../functions/lib/http-headers.js";
import scheduleDay from "../../functions/lib/pbs/schedule-day.js";
import scheduleProxy from "../../functions/lib/pbs/schedule-proxy.js";
import scheduleHandler from "../../functions/lib/pbs/schedule-handler.js";
import scheduleWiring from "../../functions/schedule.js";

const { hardeningHeaders, resolveAllowedOrigin, corsHeaders } = httpHeaders;
const { toDisplaySafeEntry, toDisplaySafeDay } = scheduleDay;
const {
  buildScheduleUrl,
  toBroadcastDate,
  classifyHttpStatus,
  classifyFetchError,
  fetchSchedule,
} = scheduleProxy;
const { createScheduleHandler, STATUS_TO_HTTP, formatDate } = scheduleHandler;

const NOW = () => new Date("2026-07-10T15:00:00Z");

function makeRes() {
  const res = {
    headers: {},
    statusCode: undefined,
    body: undefined,
    ended: false,
    set(name, value) {
      res.headers[name] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(obj) {
      res.body = obj;
      res.ended = true;
      return res;
    },
    end() {
      res.ended = true;
      return res;
    },
  };
  return res;
}

function makeReq({ method = "GET", origin, secFetchSite, query = {}, headers = {} } = {}) {
  const merged = { ...headers };
  if (origin) merged.origin = origin;
  if (secFetchSite) merged["sec-fetch-site"] = secFetchSite;
  return { method, query, headers: merged };
}

// The proxy reads a success body with response.text() and parses it itself, so it
// can tell an empty body (an empty day) from a broken one. These fakes expose
// only text() for that reason: a production path that reached for json() would
// fail loudly here rather than pass against a fixture the real Response-reading
// code no longer uses.
function jsonResponse(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

function textResponse(status, rawBody) {
  return { status, text: async () => rawBody };
}

describe("http-headers hardening baseline", () => {
  it("sets nosniff, deny-frame, HSTS, no-referrer, and a locked permissions policy", () => {
    const headers = hardeningHeaders();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Permissions-Policy"]).toContain("geolocation=()");
  });

  it("returns a fresh copy each call so a caller cannot mutate the baseline", () => {
    const first = hardeningHeaders();
    first["X-Frame-Options"] = "SAMEORIGIN";
    expect(hardeningHeaders()["X-Frame-Options"]).toBe("DENY");
  });
});

describe("CORS origin allowlist", () => {
  it("echoes an allowlisted origin and rejects everything else", () => {
    expect(resolveAllowedOrigin("https://njpbs.org")).toBe("https://njpbs.org");
    expect(resolveAllowedOrigin("https://evil.example")).toBeNull();
    expect(resolveAllowedOrigin("")).toBeNull();
    expect(resolveAllowedOrigin(undefined)).toBeNull();
  });

  it("allows a caller-supplied allowlist to widen the set", () => {
    const allowlist = ["https://preview.njpbs.workers.dev"];
    expect(resolveAllowedOrigin("https://preview.njpbs.workers.dev", allowlist)).toBe(
      "https://preview.njpbs.workers.dev",
    );
    expect(resolveAllowedOrigin("https://njpbs.org", allowlist)).toBeNull();
  });

  it("sets Vary: Origin on every response and allow-origin only when allowed", () => {
    const allowed = corsHeaders({ requestOrigin: "https://njpbs.org" });
    expect(allowed.allowed).toBe(true);
    expect(allowed.headers["Access-Control-Allow-Origin"]).toBe("https://njpbs.org");
    expect(allowed.headers["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
    expect(allowed.headers.Vary).toBe("Origin");

    const denied = corsHeaders({ requestOrigin: "https://evil.example" });
    expect(denied.allowed).toBe(false);
    expect(denied.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(denied.headers.Vary).toBe("Origin");
  });
});

describe("display-safe schedule projection", () => {
  it("keeps only the four display fields and drops upstream-only metadata", () => {
    const safe = toDisplaySafeEntry({
      startsAt: "2026-07-10T20:00:00-04:00",
      endsAt: "2026-07-10T21:00:00-04:00",
      title: "Nature",
      episodeTitle: "Silent Roar",
      // Upstream-only fields that must never reach the client.
      providerId: "gracenote:123",
      headend: "WNJT-DT",
      xPbsauth: "leaked-key",
    });
    expect(safe).toEqual({
      startsAt: "2026-07-10T20:00:00-04:00",
      endsAt: "2026-07-10T21:00:00-04:00",
      title: "Nature",
      episodeTitle: "Silent Roar",
    });
  });

  it("omits episodeTitle when it is absent or empty rather than serializing null", () => {
    const safe = toDisplaySafeEntry({
      startsAt: "2026-07-10T20:00:00-04:00",
      endsAt: "2026-07-10T21:00:00-04:00",
      title: "Nature",
      episodeTitle: "",
    });
    expect("episodeTitle" in safe).toBe(false);
  });

  it("rejects an entry missing a required field", () => {
    expect(() =>
      toDisplaySafeEntry({ startsAt: "x", endsAt: "y" }),
    ).toThrow(/title/);
  });

  it("lowercases the callsign and projects every entry", () => {
    const day = toDisplaySafeDay({
      date: "2026-07-10",
      callsign: "WNJT",
      entries: [
        {
          startsAt: "2026-07-10T20:00:00-04:00",
          endsAt: "2026-07-10T21:00:00-04:00",
          title: "Nature",
          providerId: "drop-me",
        },
      ],
    });
    expect(day.callsign).toBe("wnjt");
    expect(day.entries[0]).not.toHaveProperty("providerId");
  });

  it("rejects a day whose entries are not an array", () => {
    expect(() =>
      toDisplaySafeDay({ date: "2026-07-10", callsign: "wnjt", entries: null }),
    ).toThrow(/entries/);
  });

  // The client parses day.date as `${date}T12:00:00Z`, so a shape it cannot read
  // is an Invalid Date: "Date unavailable" and a generic hour grid, with nothing
  // thrown and nothing logged. A non-empty-string check passes all of these, so
  // the contract has to be the thing that catches them (#751).
  it("rejects TVSS's dashless date, the shape a transform is handed", () => {
    // ctx.date arrives as 20260710. Passing it through is the likely mistake, so
    // this is the case that matters most.
    expect(() =>
      toDisplaySafeDay({ date: "20260710", callsign: "wnjt", entries: [] }),
    ).toThrow(/ISO date/);
  });

  it.each(["2026-7-10", "07-10-2026", "2026/07/10", "2026-07-10T00:00:00Z", "today"])(
    "rejects the unparseable day date %s",
    (date) => {
      expect(() => toDisplaySafeDay({ date, callsign: "wnjt", entries: [] })).toThrow(
        /ISO date/,
      );
    },
  );

  it.each(["2026-13-01", "2026-00-10", "2026-09-31", "2026-02-29", "2026-04-31"])(
    "rejects the impossible day date %s",
    (date) => {
      expect(() => toDisplaySafeDay({ date, callsign: "wnjt", entries: [] })).toThrow(
        /not a real calendar day/,
      );
    },
  );

  it("accepts real ISO days, including a leap-year Feb 29", () => {
    for (const date of ["2026-01-01", "2026-12-31", "2028-02-29"]) {
      expect(toDisplaySafeDay({ date, callsign: "wnjt", entries: [] }).date).toBe(date);
    }
  });

  it("still reports a missing date as missing, not as a format problem", () => {
    // The message a caller sees should name the actual fault, so an absent field
    // does not read as a malformed one.
    expect(() =>
      toDisplaySafeDay({ callsign: "wnjt", entries: [] }),
    ).toThrow(/date must be a non-empty string/);
  });
});

describe("TVSS URL building", () => {
  it("builds the live-verified <callsign>/day/<date>/ URL with a lowercased callsign", () => {
    expect(buildScheduleUrl({ callsign: "WNJT", date: "20260710" })).toBe(
      "https://tvss.services.pbs.org/tvss/wnjt/day/20260710/",
    );
  });

  it("rejects a malformed callsign or date before any network call", () => {
    expect(() => buildScheduleUrl({ callsign: "w/../etc", date: "20260710" })).toThrow(
      /callsign/,
    );
    expect(() => buildScheduleUrl({ callsign: "wnjt", date: "2026-07-10" })).toThrow(
      /date/,
    );
  });

  // Eight digits but not a real day: out-of-range month or day (month 13, day 00,
  // day 45), and impossible-but-in-range days a range check alone would miss (Sep
  // 31, and Feb 29 in the non-leap year 2026). Each must 400 up front rather than
  // spend a TVSS call on a day that cannot exist. Named per case so a regression
  // reports the exact date that stopped being rejected.
  it.each([
    "20261345", "20260010", "20260732", "20260700", "20261232",
    "20260931", "20260229", "20260431",
  ])("rejects the impossible date %s before any network call", (date) => {
    expect(() => buildScheduleUrl({ callsign: "wnjt", date })).toThrow(
      /not a real calendar day/,
    );
  });

  it("accepts real calendar days, including a leap-year Feb 29", () => {
    expect(buildScheduleUrl({ callsign: "wnjt", date: "20260101" })).toBe(
      "https://tvss.services.pbs.org/tvss/wnjt/day/20260101/",
    );
    expect(buildScheduleUrl({ callsign: "wnjt", date: "20261231" })).toBe(
      "https://tvss.services.pbs.org/tvss/wnjt/day/20261231/",
    );
    expect(buildScheduleUrl({ callsign: "wnjt", date: "20280229" })).toBe(
      "https://tvss.services.pbs.org/tvss/wnjt/day/20280229/",
    );
  });
});

describe("HTTP and fetch-error classification", () => {
  it("maps TVSS HTTP statuses onto the fetch-status vocabulary", () => {
    expect(classifyHttpStatus(200)).toBe("ok");
    expect(classifyHttpStatus(204)).toBe("ok");
    expect(classifyHttpStatus(401)).toBe("forbidden");
    expect(classifyHttpStatus(403)).toBe("forbidden");
    expect(classifyHttpStatus(429)).toBe("rateLimited");
    expect(classifyHttpStatus(500)).toBe("error");
    expect(classifyHttpStatus(404)).toBe("error");
  });

  it("treats an abort or a network failure as a timeout", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyFetchError(abort)).toBe("timeout");
    expect(classifyFetchError(new TypeError("fetch failed"))).toBe("timeout");
    expect(classifyFetchError(new Error("weird"))).toBe("error");
  });
});

describe("fetchSchedule orchestration", () => {
  // Stands in for the production transform, so it has to model the
  // contract a real one must meet: ctx.date arrives as TVSS's YYYYMMDD and a
  // served day carries ISO, so it converts rather than echoing. A fixture that
  // passed ctx.date straight through would still satisfy toDisplaySafeDay and
  // would quietly teach the next reader the wrong shape.
  const validTransform = (body, ctx) => ({
    date: toBroadcastDate(ctx.date),
    callsign: ctx.callsign,
    entries: body.listings.map((l) => ({
      startsAt: l.start,
      endsAt: l.end,
      title: l.title,
      providerId: l.providerId,
    })),
  });

  it("reports not-configured when the auth key is missing", async () => {
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: null,
      transform: validTransform,
      fetchImpl: vi.fn(),
      now: NOW,
    });
    expect(result.status).toBe("not-configured");
    expect(result.day).toBeNull();
  });

  it("reports not-configured when the transform is not wired", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: undefined,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("not-configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends X-PBSAUTH to the right URL and returns a display-safe day on success", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        listings: [
          {
            start: "2026-07-10T20:00:00-04:00",
            end: "2026-07-10T21:00:00-04:00",
            title: "Nature",
            providerId: "drop-me",
          },
        ],
      }),
    );
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: validTransform,
      fetchImpl,
      now: NOW,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://tvss.services.pbs.org/tvss/wnjt/day/20260710/");
    expect(opts.headers["X-PBSAUTH"]).toBe("placeholder-key");
    expect(result.status).toBe("ok");
    expect(result.day.callsign).toBe("wnjt");
    // The served date is the ISO form, not the YYYYMMDD the proxy was called
    // with. Untested until #751, which is how the fixture came to model the wrong
    // shape for whoever writes the real transform.
    expect(result.day.date).toBe("2026-07-10");
    expect(result.day.entries[0]).not.toHaveProperty("providerId");
  });

  it("degrades a transform that echoes the request date to error, not a bad day", async () => {
    // The realistic transform bug: `date: ctx.date` looks right and produces a day
    // the browser silently mis-renders. The contract turns that into a refusal to
    // serve, which the client's degradation policy already handles.
    const echoingTransform = (body, ctx) => ({
      date: ctx.date,
      callsign: ctx.callsign,
      entries: [],
    });
    const fetchImpl = vi.fn(async () => jsonResponse(200, { listings: [] }));
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: echoingTransform,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("error");
    expect(result.day).toBeNull();
  });

  it("maps a forbidden response without reading the body", async () => {
    const text = vi.fn(async () => {
      throw new Error("body must not be read on a non-ok response");
    });
    const fetchImpl = vi.fn(async () => ({ status: 403, text }));
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: validTransform,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("forbidden");
    expect(result.day).toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  it("maps a rate-limited response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, {}));
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: validTransform,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("rateLimited");
  });

  it("maps an aborted fetch to a timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: validTransform,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("timeout");
  });

  it("maps a 200 whose body stalls and aborts mid-stream to a timeout", async () => {
    // Headers arrive under the deadline, but the body read is aborted by the
    // still-armed timeout. This must degrade to timeout, not hang or error.
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      text: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    }));
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: validTransform,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("timeout");
    expect(result.day).toBeNull();
  });

  it("degrades a 200 whose body will not transform to an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { unexpected: true }));
    const throwingTransform = () => {
      throw new Error("cannot map this shape");
    };
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: throwingTransform,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("error");
    expect(result.day).toBeNull();
  });

  it("degrades a transform TypeError to error, not a retryable timeout", async () => {
    // The realistic broken-payload case: a 200 body missing the field the
    // transform reads throws a TypeError. It must stay `error`, since a
    // `timeout` would tell the client to keep retrying a payload that will
    // never map.
    const fetchImpl = vi.fn(async () => jsonResponse(200, { notListings: [] }));
    const shapeReadingTransform = (body, ctx) => ({
      date: ctx.date,
      callsign: ctx.callsign,
      entries: body.listings.map((l) => ({ startsAt: l.start })),
    });
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: shapeReadingTransform,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("error");
    expect(result.day).toBeNull();
  });

  it("serves a 204 as an ok empty day, not an error", async () => {
    // Why `ok` rather than `error` is documented on fetchSchedule. The transform
    // throws here so the fixture enforces the other half of the contract: with no
    // body to map, nothing may reach it.
    const transform = vi.fn(() => {
      throw new Error("transform must not run when there is no body to map");
    });
    const fetchImpl = vi.fn(async () => textResponse(204, ""));
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform,
      fetchImpl,
      now: NOW,
    });

    expect(result.status).toBe("ok");
    expect(result.day.entries).toEqual([]);
    expect(result.day.callsign).toBe("wnjt");
    expect(transform).not.toHaveBeenCalled();
  });

  it("dates an empty day the way the client parses it, not the way TVSS asks for it", async () => {
    // `date` arrives as 20260710 and must be served as 2026-07-10. Echoing it
    // satisfies toDisplaySafeDay and still breaks the panel, so the assertion
    // below is on the served format rather than on the field being present.
    const fetchImpl = vi.fn(async () => textResponse(204, ""));
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: validTransform,
      fetchImpl,
      now: NOW,
    });

    expect(result.day.date).toBe("2026-07-10");
    expect(Number.isNaN(new Date(`${result.day.date}T12:00:00Z`).getTime())).toBe(
      false,
    );
  });

  it("treats a blank 200 body as an empty day too, not only a 204", async () => {
    // The empty-day case is decided by the body, not the status code, so an
    // upstream that answers 200 with nothing (or only whitespace) lands in the
    // same place instead of depending on TVSS's choice of success code.
    for (const rawBody of ["", "   ", "\n"]) {
      const result = await fetchSchedule({
        callsign: "wnjt",
        date: "20260710",
        authKey: "placeholder-key",
        transform: validTransform,
        fetchImpl: vi.fn(async () => textResponse(200, rawBody)),
        now: NOW,
      });
      expect(result.status).toBe("ok");
      expect(result.day.entries).toEqual([]);
    }
  });

  it("still degrades a 200 body that is not JSON to an error", async () => {
    // Reading the body as text rather than json() is what makes an empty body
    // serviceable; it must not also let a non-empty garbage body through. An
    // HTML error page served with a 200 is the realistic case.
    const fetchImpl = vi.fn(async () =>
      textResponse(200, "<html>upstream error</html>"),
    );
    const result = await fetchSchedule({
      callsign: "wnjt",
      date: "20260710",
      authKey: "placeholder-key",
      transform: validTransform,
      fetchImpl,
      now: NOW,
    });
    expect(result.status).toBe("error");
    expect(result.day).toBeNull();
  });
});

describe("toBroadcastDate", () => {
  it("converts a TVSS path date to the ISO date a served day carries", () => {
    expect(toBroadcastDate("20260710")).toBe("2026-07-10");
    expect(toBroadcastDate("20260101")).toBe("2026-01-01");
  });

  it("round-trips with formatDate, the producer of the request date", () => {
    // formatDate builds the YYYYMMDD the proxy is called with; this is the other
    // half of that pair, so the two must agree on the same day.
    expect(toBroadcastDate(formatDate(new Date("2026-07-11T02:00:00Z")))).toBe(
      "2026-07-10",
    );
  });

  it("throws rather than returning a date the client cannot parse", () => {
    for (const bad of ["2026-07-10", "202607", "", "notadate", undefined, null]) {
      expect(() => toBroadcastDate(bad)).toThrow(/expected YYYYMMDD/);
    }
  });
});

describe("default-date formatting", () => {
  it("formats the station-local day, not the UTC day, late in the evening", () => {
    // 02:00Z on the 11th is still 22:00 on the 10th in Eastern time, so the
    // default listings day must be the 10th, the schedule viewers are watching.
    const lateEvening = new Date("2026-07-11T02:00:00Z");
    expect(formatDate(lateEvening)).toBe("20260710");
    expect(formatDate(lateEvening, "UTC")).toBe("20260711");
  });
});

describe("schedule request handler", () => {
  const okDay = {
    date: "2026-07-10",
    callsign: "wnjt",
    entries: [],
  };

  function handlerWith(overrides = {}) {
    return createScheduleHandler({
      fetchScheduleFn: vi.fn(async () => ({
        status: "not-configured",
        day: null,
        fetchedAt: NOW().toISOString(),
      })),
      getAuthKey: () => null,
      getTransform: () => undefined,
      getDefaultCallsign: () => "wnjt",
      now: NOW,
      ...overrides,
    });
  }

  it("answers a preflight with 204 and the header baseline", async () => {
    const handler = handlerWith();
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS", origin: "https://njpbs.org" }), res);
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://njpbs.org");
  });

  it("rejects a non-GET method", async () => {
    const handler = handlerWith();
    const res = makeRes();
    await handler(makeReq({ method: "POST" }), res);
    expect(res.statusCode).toBe(405);
    expect(res.body.status).toBe("error");
  });

  it.each([{ date: "2026-07-10" }, { callsign: "w/../etc" }])(
    "rejects malformed input %j without a retryable status or upstream call",
    async (query) => {
      const fetchScheduleFn = vi.fn();
      const handler = handlerWith({ fetchScheduleFn });
      const res = makeRes();
      await handler(makeReq({ query }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        status: "bad-request",
        day: null,
        fetchedAt: NOW().toISOString(),
      });
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(fetchScheduleFn).not.toHaveBeenCalled();
    },
  );

  it("keeps a real secret read failure retryable and private", async () => {
    const secretRead = vi.spyOn(scheduleWiring.PBS_TVSS_AUTH, "value")
      .mockImplementation(() => {
        throw new Error("secret-read-detail");
      });
    const fetchScheduleFn = vi.fn();
    try {
      const handler = handlerWith({
        getAuthKey: scheduleWiring.resolveAuthKey,
        fetchScheduleFn,
      });
      const res = makeRes();
      await handler(makeReq({ origin: "https://njpbs.org" }), res);
      expect(res.statusCode).toBe(502);
      expect(res.body).toEqual({
        status: "error",
        day: null,
        fetchedAt: NOW().toISOString(),
      });
      expect(res.headers["Cache-Control"]).toBe("no-store");
      expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://njpbs.org");
      expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(fetchScheduleFn).not.toHaveBeenCalled();
    } finally {
      secretRead.mockRestore();
    }
  });

  it("keeps an unset real secret on the permanent not-configured path", async () => {
    const secretRead = vi.spyOn(scheduleWiring.PBS_TVSS_AUTH, "value").mockReturnValue("");
    try {
      const handler = handlerWith({
        getAuthKey: scheduleWiring.resolveAuthKey,
        fetchScheduleFn: fetchSchedule,
      });
      const res = makeRes();
      await handler(makeReq(), res);
      expect(res.statusCode).toBe(503);
      expect(res.body.status).toBe("not-configured");
    } finally {
      secretRead.mockRestore();
    }
  });

  it("returns 503 and no-store when the proxy is not configured", async () => {
    const handler = handlerWith();
    const res = makeRes();
    await handler(makeReq({ origin: "https://njpbs.org" }), res);
    expect(res.statusCode).toBe(STATUS_TO_HTTP["not-configured"]);
    expect(res.body.status).toBe("not-configured");
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("returns 200 and a short cache on a successful day", async () => {
    const handler = handlerWith({
      fetchScheduleFn: vi.fn(async () => ({
        status: "ok",
        day: okDay,
        fetchedAt: NOW().toISOString(),
      })),
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.day).toEqual(okDay);
    expect(res.headers["Cache-Control"]).toBe("public, max-age=60");
  });

  it("does not set allow-origin for an origin off the allowlist", async () => {
    const handler = handlerWith();
    const res = makeRes();
    await handler(makeReq({ origin: "https://evil.example" }), res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(res.headers.Vary).toBe("Origin");
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("rejects a request from an off-allowlist origin before it can spend a TVSS call", async () => {
    const fetchScheduleFn = vi.fn(async () => ({
      status: "ok",
      day: okDay,
      fetchedAt: NOW().toISOString(),
    }));
    const handler = handlerWith({ fetchScheduleFn });
    const res = makeRes();
    await handler(makeReq({ origin: "https://evil.example" }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.status).toBe("error");
    expect(fetchScheduleFn).not.toHaveBeenCalled();
  });

  it("lets a request with no Origin header through to the proxy", async () => {
    // Same-origin, server-to-server, and monitoring callers send no Origin and
    // cannot be judged by the allowlist, so they must not be rejected here; their
    // abuse boundary is the per-IP rate limit in #254.
    const fetchScheduleFn = vi.fn(async () => ({
      status: "ok",
      day: okDay,
      fetchedAt: NOW().toISOString(),
    }));
    const handler = handlerWith({ fetchScheduleFn });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(fetchScheduleFn).toHaveBeenCalledOnce();
  });

  it("rejects a Sec-Fetch-Site: cross-site request that carries no Origin", async () => {
    // A cross-site no-cors subresource load (an `<img>` or `<script>` pointed at
    // the proxy) omits Origin but still sets Sec-Fetch-Site, so this closes the
    // quota-drain the Origin check alone misses.
    const fetchScheduleFn = vi.fn(async () => ({
      status: "ok",
      day: okDay,
      fetchedAt: NOW().toISOString(),
    }));
    const handler = handlerWith({ fetchScheduleFn });
    const res = makeRes();
    await handler(makeReq({ secFetchSite: "cross-site" }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.status).toBe("error");
    expect(fetchScheduleFn).not.toHaveBeenCalled();
  });

  it("lets a Sec-Fetch-Site: same-origin request through to the proxy", async () => {
    const fetchScheduleFn = vi.fn(async () => ({
      status: "ok",
      day: okDay,
      fetchedAt: NOW().toISOString(),
    }));
    const handler = handlerWith({ fetchScheduleFn });
    const res = makeRes();
    await handler(makeReq({ secFetchSite: "same-origin" }), res);
    expect(res.statusCode).toBe(200);
    expect(fetchScheduleFn).toHaveBeenCalledOnce();
  });

  it("passes the injected key, transform, and callsign default to the proxy", async () => {
    const fetchScheduleFn = vi.fn(async () => ({
      status: "not-configured",
      day: null,
      fetchedAt: NOW().toISOString(),
    }));
    const transform = () => ({});
    const handler = handlerWith({
      fetchScheduleFn,
      getAuthKey: () => "placeholder-key",
      getTransform: () => transform,
      getDefaultCallsign: () => "njtv",
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(fetchScheduleFn).toHaveBeenCalledOnce();
    const arg = fetchScheduleFn.mock.calls[0][0];
    expect(arg.authKey).toBe("placeholder-key");
    expect(arg.transform).toBe(transform);
    expect(arg.callsign).toBe("njtv");
    expect(arg.date).toBe("20260710");
  });
});
