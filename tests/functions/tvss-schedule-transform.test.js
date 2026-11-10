import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import scheduleWiring from "../../functions/schedule.js";
import tvssTransform from "../../functions/lib/pbs/tvss-schedule-transform.js";
import {
  shapeTvssScheduleDay,
  unwrapTvssJsonp,
} from "../../site/src/lib/schedule-feed.ts";

const { resolveTransform } = scheduleWiring;
const { transformTvssScheduleDay } = tvssTransform;

const fixtureText = readFileSync(
  new URL("../../site/tests/fixtures/tvss-wnjt-20260710.jsonp", import.meta.url),
  "utf8",
);

function displayFields(day) {
  return {
    date: day.date,
    callsign: day.callsign,
    entries: day.entries.map((entry) => ({
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      title: entry.title,
      ...(entry.episodeTitle ? { episodeTitle: entry.episodeTitle } : {}),
    })),
  };
}

function payloadWithListings(listings) {
  return {
    headends: [
      {
        name: "Broadcast",
        feeds: [
          {
            cid: "4211290e-ce30-49e5-9be1-2c412c5b3278",
            short_name: "WNJTDT",
            listings,
          },
        ],
      },
    ],
  };
}

describe("TVSS schedule transform", () => {
  it("matches the site mapper for the display-safe WNJT fixture fields", () => {
    const payload = unwrapTvssJsonp(fixtureText);
    const siteDay = shapeTvssScheduleDay(payload, {
      date: "2026-07-10",
      kind: "broadcast",
    });

    expect(
      transformTvssScheduleDay(payload, {
        callsign: "WNJT",
        date: "20260710",
      }),
    ).toEqual(displayFields(siteDay));
  });

  it("uses the New York winter offset independently of the host time zone", () => {
    const day = transformTvssScheduleDay(
      payloadWithListings([
        {
          start_time: "2000",
          duration: 100,
          title: "Nature",
          episode_title: "Winter wildlife",
        },
      ]),
      { callsign: "WNJT", date: "20260110" },
    );

    expect(day).toEqual({
      date: "2026-01-10",
      callsign: "wnjt",
      entries: [
        {
          startsAt: "2026-01-10T20:00:00-05:00",
          endsAt: "2026-01-10T21:00:00-05:00",
          title: "Nature",
          episodeTitle: "Winter wildlife",
        },
      ],
    });
  });

  it("rejects a nonexistent spring-forward local start", () => {
    expect(() =>
      transformTvssScheduleDay(
        payloadWithListings([
          { start_time: "0200", duration: 30, title: "Missing hour" },
        ]),
        { callsign: "wnjt", date: "20260308" },
      ),
    ).toThrow(/does not exist/i);
  });

  it("uses both fall-back offsets for repeated local starts in feed order", () => {
    const day = transformTvssScheduleDay(
      payloadWithListings([
        { start_time: "0130", duration: 100, title: "First 1:30" },
        { start_time: "0130", duration: 100, title: "Second 1:30" },
      ]),
      { callsign: "wnjt", date: "20261101" },
    );

    expect(day.entries).toEqual([
      {
        startsAt: "2026-11-01T01:30:00-04:00",
        endsAt: "2026-11-01T01:30:00-05:00",
        title: "First 1:30",
      },
      {
        startsAt: "2026-11-01T01:30:00-05:00",
        endsAt: "2026-11-01T02:30:00-05:00",
        title: "Second 1:30",
      },
    ]);
  });

  it("keeps the proxy unwired while exposing a tested candidate mapper", () => {
    expect(resolveTransform()).toBeUndefined();
    const payload = unwrapTvssJsonp(fixtureText);
    expect(
      transformTvssScheduleDay(payload, {
        callsign: "WNJT",
        date: "20260710",
      }),
    ).toEqual(displayFields(shapeTvssScheduleDay(payload, {
      date: "2026-07-10",
      kind: "broadcast",
    })));

    expect(() =>
      transformTvssScheduleDay(payload, {
        callsign: "wxyz",
        date: "20260710",
      }),
    ).toThrow(/only supports.*WNJT/i);

    const indexSource = readFileSync(
      new URL("../../functions/index.js", import.meta.url),
      "utf8",
    );
    expect(indexSource).not.toMatch(/^\s*exports\.scheduleProxy\s*=/m);
    expect(indexSource).toMatch(/^\/\/\s+exports\.scheduleProxy\s*=/m);
  });
});
