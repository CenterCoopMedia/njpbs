import { describe, expect, it, vi } from "vitest";
import scheduleEndpoint from "../../functions/broadcast-schedule.js";
import * as scheduleData from "../../functions/lib/broadcast-schedule-data.mjs";

const { createCmsGetBroadcastScheduleHandler } = scheduleEndpoint;

function makeReq({ method = "POST", body = {} } = {}) {
  return {
    method,
    body,
    headers: { "content-type": "application/json" },
    rawBody: Buffer.from(JSON.stringify(body)),
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headersSent: false,
    headers: new Map(),
  };
  res.set = (name, value) => {
    res.headers.set(name.toLowerCase(), value);
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.headersSent = true;
    return res;
  };
  return res;
}

function actor(grants) {
  return {
    uid: "staff-1",
    email: "staff@example.org",
    principal: { id: "staff-1", grants },
  };
}

describe("private broadcast schedule data", () => {
  it("keeps the verified source entries and cross-month limits", () => {
    expect(() => scheduleData.validateBroadcastSchedule()).not.toThrow();
    expect(scheduleData.BROADCAST_AIRINGS).toHaveLength(236);
    expect(scheduleData.BROADCAST_AIRINGS[0]?.date).toBe("2026-10-01");
    expect(scheduleData.BROADCAST_AIRINGS.at(-1)?.date).toBe("2026-11-05");
    expect(
      scheduleData.BROADCAST_AIRINGS.find(
        (airing) =>
          airing.date === "2026-10-01" &&
          airing.program === "State of Affairs" &&
          airing.episode === "1017",
      ),
    ).toMatchObject({
      station: "NJ PBS",
      time: "6 a.m.",
      premiere: false,
    });
    expect(
      scheduleData.BROADCAST_AIRINGS.some(
        (airing) =>
          airing.date === "2026-11-01" &&
          airing.episode === "2959" &&
          airing.station === "NJ PBS" &&
          airing.time === "11 a.m.",
      ),
    ).toBe(true);

    const media105Dates = new Set(
      scheduleData.BROADCAST_AIRINGS
        .filter((airing) =>
          airing.program === "Media Matters" &&
          airing.episode === "105"
        )
        .map((airing) => airing.date),
    );
    expect([...media105Dates]).toEqual(["2026-10-30"]);

    const rememberEpisodes = scheduleData.BROADCAST_AIRINGS
      .filter((airing) =>
        airing.program === "Remember Them" &&
        airing.station === "NJ PBS" &&
        airing.time === "4 p.m." &&
        new Date(`${airing.date}T12:00:00Z`).getUTCDay() === 6
      )
      .map(({ date, episode, title }) => ({ date, episode, title }));
    expect(rememberEpisodes).toEqual([
      { date: "2026-10-03", episode: "314", title: "Remembering George Washington" },
      { date: "2026-10-10", episode: "307", title: "Remembering Tony Bennett" },
      { date: "2026-10-17", episode: "403", title: "Remembering Olympia Dukakis and Bob McGrath" },
      { date: "2026-10-24", episode: "401", title: "Remembering Luther Vandross" },
      { date: "2026-10-31", episode: "303", title: "Remembering Toni Morrison" },
    ]);
  });
});

describe("cmsGetBroadcastSchedule", () => {
  it("refuses an authenticated account without an admitted CMS role", async () => {
    const loadScheduleFn = vi.fn();
    const handler = createCmsGetBroadcastScheduleHandler({
      requirePrincipalFn: vi.fn(async () => actor([])),
      loadScheduleFn,
      log: { error: vi.fn() },
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/CMS access required/i);
    expect(loadScheduleFn).not.toHaveBeenCalled();
  });

  it("returns the packet only after admitted bearer authentication", async () => {
    const handler = createCmsGetBroadcastScheduleHandler({
      requirePrincipalFn: vi.fn(async () => actor([{ role: "staff" }])),
      loadScheduleFn: async () => ({
        source: scheduleData.BROADCAST_SCHEDULE_SOURCE,
        airings: scheduleData.BROADCAST_AIRINGS,
      }),
      log: { error: vi.fn() },
    });
    const res = makeRes();

    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      source: scheduleData.BROADCAST_SCHEDULE_SOURCE,
    });
    expect(res.body.airings).toHaveLength(236);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Authorization");
  });
});
