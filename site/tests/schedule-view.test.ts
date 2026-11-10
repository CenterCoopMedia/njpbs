// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as scheduleView from "../src/lib/schedule-view.ts";
import {
  SCHEDULE_TIME_ZONE,
  filterKidsListings,
  getScheduleClockState,
  getScheduleDayState,
  resolveScheduleClock,
  scheduleDateKey,
} from "../src/lib/schedule-view.ts";
import type {
  ScheduleFeedDay,
  ScheduleListing,
} from "../src/lib/schedule-feed.ts";

function listing(
  title: string,
  startsAt: string,
  endsAt: string,
  options: Partial<Pick<ScheduleListing, "kids" | "isKids">> = {},
): ScheduleListing {
  return {
    title,
    startsAt,
    endsAt,
    seasonNumber: null,
    episodeNumber: null,
    nolaRoot: null,
    programId: null,
    programExternalId: null,
    cid: null,
    isKids: false,
    feedKind: "broadcast",
    ...options,
  };
}

function day(
  date: string,
  entries: readonly ScheduleListing[],
): ScheduleFeedDay {
  return {
    date,
    callsign: "wnjt",
    kind: "broadcast",
    feedCid: "test-feed",
    timeZone: "America/New_York",
    entries,
  };
}

function initialScheduleDay(
  days: readonly ScheduleFeedDay[],
  at: Date,
): ScheduleFeedDay | null {
  const resolveInitialScheduleDay = (
    scheduleView as typeof scheduleView & {
      resolveInitialScheduleDay?: (
        days: readonly ScheduleFeedDay[],
        at: Date,
      ) => ScheduleFeedDay | null;
    }
  ).resolveInitialScheduleDay;
  expect(resolveInitialScheduleDay).toBeTypeOf("function");
  return resolveInitialScheduleDay?.(days, at) ?? null;
}

const news = listing(
  "News",
  "2026-07-10T19:00:00-04:00",
  "2026-07-10T20:00:00-04:00",
);
const nature = listing(
  "Nature",
  "2026-07-10T20:00:00-04:00",
  "2026-07-10T20:30:00-04:00",
);
const nova = listing(
  "Nova",
  "2026-07-10T20:30:00-04:00",
  "2026-07-10T21:00:00-04:00",
);
const frontline = listing(
  "Frontline",
  "2026-07-10T21:30:00-04:00",
  "2026-07-10T22:00:00-04:00",
);
const broadcastDay = day("2026-07-10", [news, nature, nova, frontline]);

describe("scheduleDateKey", () => {
  it("uses the Eastern calendar date when UTC has crossed midnight", () => {
    expect(SCHEDULE_TIME_ZONE).toBe("America/New_York");
    expect(scheduleDateKey(new Date("2026-07-11T03:30:00Z"))).toBe(
      "2026-07-10",
    );
  });
});

describe("resolveScheduleClock", () => {
  it("returns a new date for a valid mock-time override", () => {
    const realNow = new Date("2026-07-10T12:00:00-04:00");
    const resolved = resolveScheduleClock(
      realNow,
      "2026-07-10T20:15:00-04:00",
    );

    expect(resolved.toISOString()).toBe("2026-07-11T00:15:00.000Z");
    expect(resolved).not.toBe(realNow);
  });

  it("falls back to a clone of the real clock for an invalid override", () => {
    const realNow = new Date("2026-07-10T12:00:00-04:00");
    const resolved = resolveScheduleClock(realNow, "not-a-time");

    expect(resolved.getTime()).toBe(realNow.getTime());
    expect(resolved).not.toBe(realNow);
  });

  it("rejects a timestamp without a time zone", () => {
    const realNow = new Date("2026-07-10T12:00:00-04:00");
    const resolved = resolveScheduleClock(realNow, "2026-07-10T20:15:00");

    expect(resolved.getTime()).toBe(realNow.getTime());
    expect(resolved).not.toBe(realNow);
  });

  it("rejects a date without a time", () => {
    const realNow = new Date("2026-07-10T12:00:00-04:00");
    const resolved = resolveScheduleClock(realNow, "2026-07-10");

    expect(resolved.getTime()).toBe(realNow.getTime());
    expect(resolved).not.toBe(realNow);
  });

  it("rejects a non-ISO value accepted by the permissive date parser", () => {
    const realNow = new Date("2026-07-10T12:00:00-04:00");
    const resolved = resolveScheduleClock(
      realNow,
      "July 10, 2026 20:15:00 GMT-0400",
    );

    expect(resolved.getTime()).toBe(realNow.getTime());
    expect(resolved).not.toBe(realNow);
  });
});

describe("filterKidsListings", () => {
  it("uses only the settled isKids classification", () => {
    const underFlagged = listing(
      "Weather Hunters",
      "2026-07-10T08:00:00-04:00",
      "2026-07-10T08:30:00-04:00",
      { kids: false, isKids: true },
    );
    const rawFalsePositive = listing(
      "Not a kids show",
      "2026-07-10T08:30:00-04:00",
      "2026-07-10T09:00:00-04:00",
      { kids: true, isKids: false },
    );

    expect(filterKidsListings([underFlagged, rawFalsePositive])).toEqual([
      underFlagged,
    ]);
  });
});

describe("getScheduleDayState", () => {
  it("marks an empty broadcast day and its kids subset empty", () => {
    expect(getScheduleDayState(day("2026-07-11", []))).toEqual({
      kind: "empty",
      entries: [],
      kids: [],
      kidsKind: "empty",
    });
  });

  it("keeps a ready broadcast day when it has no kids rows", () => {
    const entries = [news, nature];

    expect(getScheduleDayState(day("2026-07-10", entries))).toEqual({
      kind: "ready",
      entries,
      kids: [],
      kidsKind: "empty",
    });
  });

  it("marks the kids subset ready when settled kids rows exist", () => {
    const kidsEntry = listing(
      "Weather Hunters",
      "2026-07-10T08:00:00-04:00",
      "2026-07-10T08:30:00-04:00",
      { kids: false, isKids: true },
    );

    expect(getScheduleDayState(day("2026-07-10", [news, kidsEntry]))).toEqual({
      kind: "ready",
      entries: [news, kidsEntry],
      kids: [kidsEntry],
      kidsKind: "ready",
    });
  });
});

describe("resolveInitialScheduleDay", () => {
  it("selects the current Eastern day when it is baked", () => {
    expect(
      initialScheduleDay(
        [broadcastDay],
        new Date("2026-07-11T00:15:00Z"),
      ),
    ).toBe(broadcastDay);
  });

  it("returns an empty current-day shape when the baked window is expired", () => {
    const expiredDay = day("2026-07-01", [news]);

    expect(
      initialScheduleDay(
        [expiredDay],
        new Date("2026-07-10T12:00:00-04:00"),
      ),
    ).toEqual({
      ...expiredDay,
      date: "2026-07-10",
      entries: [],
    });
  });

  it("returns null when no schedule days are baked", () => {
    expect(initialScheduleDay([], new Date("2026-07-10T12:00:00-04:00"))).toBeNull();
  });
});

describe("getScheduleClockState", () => {
  it("selects the Eastern day and reports mid-program timing", () => {
    const state = getScheduleClockState(
      [broadcastDay],
      new Date("2026-07-11T00:15:00Z"),
    );

    expect(state).toEqual({
      date: "2026-07-10",
      onNow: nature,
      upNext: nova,
      elapsedMinutes: 15,
      remainingMinutes: 15,
      progressPercent: 50,
    });
  });

  it("assigns an exact start to the incoming program", () => {
    const state = getScheduleClockState(
      [broadcastDay],
      new Date("2026-07-10T20:00:00-04:00"),
    );

    expect(state).toMatchObject({
      onNow: nature,
      upNext: nova,
      elapsedMinutes: 0,
      remainingMinutes: 30,
      progressPercent: 0,
    });
  });

  it("hands an exact end to the next contiguous program", () => {
    const state = getScheduleClockState(
      [broadcastDay],
      new Date("2026-07-10T20:30:00-04:00"),
    );

    expect(state).toMatchObject({
      onNow: nova,
      upNext: frontline,
      elapsedMinutes: 0,
      remainingMinutes: 30,
      progressPercent: 0,
    });
  });

  it("reports the next program and zero timing values during a gap", () => {
    const state = getScheduleClockState(
      [broadcastDay],
      new Date("2026-07-10T21:15:00-04:00"),
    );

    expect(state).toEqual({
      date: "2026-07-10",
      onNow: null,
      upNext: frontline,
      elapsedMinutes: 0,
      remainingMinutes: 0,
      progressPercent: 0,
    });
  });

  it("reports no programs and zero timing values at the final exact end", () => {
    const state = getScheduleClockState(
      [broadcastDay],
      new Date("2026-07-10T22:00:00-04:00"),
    );

    expect(state).toEqual({
      date: "2026-07-10",
      onNow: null,
      upNext: null,
      elapsedMinutes: 0,
      remainingMinutes: 0,
      progressPercent: 0,
    });
  });

  it("returns null when the Eastern date is outside the baked days", () => {
    expect(
      getScheduleClockState(
        [broadcastDay],
        new Date("2026-07-11T04:00:00Z"),
      ),
    ).toBeNull();
  });
});
