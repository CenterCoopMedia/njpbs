// @vitest-environment node
// Boundary tests for deriveNowNext (#188). The now/next boundary is the one
// piece of the schedule feature that is easy to get subtly wrong: an off-by-one
// at a program handoff shows the wrong show as "on now". It is pinned here
// before the proxy that feeds it exists.
import { describe, it, expect } from "vitest";
import {
  deriveNowNext,
  type ScheduleDay,
} from "../src/lib/schedule-now-next.ts";

// A representative evening on one channel: four contiguous programs, then a
// 30-minute gap, then a late program. Times carry the -04:00 ET offset so the
// test does not depend on the machine's local zone.
const day: ScheduleDay = {
  date: "2026-07-06",
  callsign: "njtv",
  entries: [
    { startsAt: "2026-07-06T19:00:00-04:00", endsAt: "2026-07-06T20:00:00-04:00", title: "News" },
    {
      startsAt: "2026-07-06T20:00:00-04:00",
      endsAt: "2026-07-06T20:30:00-04:00",
      title: "Nature",
      episodeTitle: "Silent Roar",
    },
    { startsAt: "2026-07-06T20:30:00-04:00", endsAt: "2026-07-06T21:00:00-04:00", title: "Nova" },
    // gap 21:00 - 21:30
    { startsAt: "2026-07-06T21:30:00-04:00", endsAt: "2026-07-06T22:00:00-04:00", title: "Frontline" },
  ],
};
const [news, nature, nova, frontline] = day.entries;

const at = (iso: string) => new Date(iso);

describe("deriveNowNext", () => {
  it("mid-program reports that program on now and the next one up", () => {
    const { onNow, upNext } = deriveNowNext(day, at("2026-07-06T19:30:00-04:00"));
    expect(onNow).toBe(news);
    expect(upNext).toBe(nature);
  });

  it("carries the episode title through on the on-air entry", () => {
    const { onNow } = deriveNowNext(day, at("2026-07-06T20:15:00-04:00"));
    expect(onNow).toBe(nature);
    expect(onNow?.episodeTitle).toBe("Silent Roar");
  });

  it("treats a program boundary as belonging to the incoming program", () => {
    // Exactly 20:00: News has ended, Nature is on. Half-open [start, end) means
    // the boundary instant is Nature's, not News's.
    const { onNow, upNext } = deriveNowNext(day, at("2026-07-06T20:00:00-04:00"));
    expect(onNow).toBe(nature);
    // ...and up-next is Nova, not Nature itself, even though Nature starts at t.
    expect(upNext).toBe(nova);
  });

  it("in a gap reports nothing on now and the next program up", () => {
    const { onNow, upNext } = deriveNowNext(day, at("2026-07-06T21:15:00-04:00"));
    expect(onNow).toBeNull();
    expect(upNext).toBe(frontline);
  });

  it("before the first listing reports the first as up next", () => {
    const { onNow, upNext } = deriveNowNext(day, at("2026-07-06T18:00:00-04:00"));
    expect(onNow).toBeNull();
    expect(upNext).toBe(news);
  });

  it("during the last listing reports it on now with nothing up next", () => {
    const { onNow, upNext } = deriveNowNext(day, at("2026-07-06T21:45:00-04:00"));
    expect(onNow).toBe(frontline);
    expect(upNext).toBeNull();
  });

  it("after the last listing reports nothing on now and nothing up next", () => {
    const { onNow, upNext } = deriveNowNext(day, at("2026-07-06T22:30:00-04:00"));
    expect(onNow).toBeNull();
    expect(upNext).toBeNull();
  });

  it("at the exact end of the last listing reports nothing on now or up next", () => {
    // 22:00 is Frontline's endsAt. Half-open [start, end) means the day's final
    // instant belongs to no program, and there is no later listing to be next,
    // so both are null. This is the one boundary with no incoming program to
    // absorb the instant.
    const { onNow, upNext } = deriveNowNext(day, at("2026-07-06T22:00:00-04:00"));
    expect(onNow).toBeNull();
    expect(upNext).toBeNull();
  });

  it("an empty day reports nothing on now and nothing up next", () => {
    const empty: ScheduleDay = { date: "2026-07-06", callsign: "njtv", entries: [] };
    const { onNow, upNext } = deriveNowNext(empty, at("2026-07-06T20:00:00-04:00"));
    expect(onNow).toBeNull();
    expect(upNext).toBeNull();
  });

  it("skips listings with unparseable or non-positive-length intervals", () => {
    const messy: ScheduleDay = {
      date: "2026-07-06",
      callsign: "njtv",
      entries: [
        { startsAt: "not-a-date", endsAt: "2026-07-06T20:00:00-04:00", title: "Broken start" },
        { startsAt: "2026-07-06T20:00:00-04:00", endsAt: "2026-07-06T20:00:00-04:00", title: "Zero length" },
        { startsAt: "2026-07-06T21:00:00-04:00", endsAt: "2026-07-06T20:00:00-04:00", title: "End before start" },
        { startsAt: "2026-07-06T20:00:00-04:00", endsAt: "2026-07-06T21:00:00-04:00", title: "Good" },
      ],
    };
    const { onNow, upNext } = deriveNowNext(messy, at("2026-07-06T20:30:00-04:00"));
    expect(onNow?.title).toBe("Good");
    expect(upNext).toBeNull();
  });

  it("takes the earliest qualifying start even when entries are out of order", () => {
    const unsorted: ScheduleDay = {
      date: "2026-07-06",
      callsign: "njtv",
      entries: [nova, news, frontline, nature], // deliberately shuffled
    };
    const { onNow, upNext } = deriveNowNext(unsorted, at("2026-07-06T19:30:00-04:00"));
    expect(onNow).toBe(news);
    expect(upNext).toBe(nature);
  });
});
