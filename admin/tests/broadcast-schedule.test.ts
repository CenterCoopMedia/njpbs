import { render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import {
  adjacentScheduleWeek,
  scheduleDaysForWeek,
  scheduleWeekForDate,
  scheduleWeekStarts,
  validateBroadcastSchedule,
  type BroadcastSchedule,
} from "../src/data/broadcast-schedule";
import {
  ScheduleSurface,
  groupEpisodeAirings,
  todayInTimeZone,
} from "../src/routes/ScheduleRoute";

const schedule: BroadcastSchedule = {
  source: {
    coverageStart: "2026-10-01",
    coverageEnd: "2026-11-05",
    label: "Verified test packet",
    received: "2026-09-16",
    timezone: "America/New_York",
  },
  airings: [
    {
      date: "2026-10-01",
      detailsStatus: "provided",
      episode: "2951",
      premiere: false,
      program: "One-on-One with Steve Adubato",
      station: "NJ PBS",
      status: "scheduled",
      time: "5:30 a.m.",
      title: "Joe Yaccarino; Steve Evert; Alisha Langford",
    },
    {
      date: "2026-10-01",
      detailsStatus: "provided",
      episode: "2951",
      premiere: false,
      program: "One-on-One with Steve Adubato",
      station: "Thirteen",
      status: "preempted",
      time: "12 a.m.",
      title: "Joe Yaccarino; Steve Evert; Alisha Langford",
    },
    {
      date: "2026-11-05",
      detailsStatus: "pending",
      episode: "1022",
      premiere: false,
      program: "State of Affairs with Steve Adubato",
      station: "NJ PBS",
      status: "scheduled",
      time: "6 a.m.",
      title: "Guest details pending",
    },
  ],
};

function LocationProbe() {
  const location = useLocation();
  return createElement(
    "output",
    { "aria-label": "Current location" },
    `${location.pathname}${location.search}`,
  );
}

describe("verified broadcast schedule", () => {
  it("accepts a complete private API response", () => {
    expect(() => validateBroadcastSchedule(schedule)).not.toThrow();
  });

  it("derives every source week from the coverage boundary", () => {
    expect(scheduleWeekStarts(schedule.source)).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
    ]);
    expect(scheduleWeekForDate(schedule.source, "2026-09-16"))
      .toBe("2026-09-28");
  });

  it("keeps all seven days and identifies dates outside packet coverage", () => {
    const days = scheduleDaysForWeek(schedule, "2026-09-28");
    expect(days).toHaveLength(7);
    expect(days.map((day) => day.date)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(days[0]?.withinCoverage).toBe(false);
    expect(days[3]?.withinCoverage).toBe(true);

    const finalDays = scheduleDaysForWeek(schedule, "2026-11-02");
    expect(finalDays[3]?.withinCoverage).toBe(true);
    expect(finalDays[4]?.withinCoverage).toBe(false);
    expect(finalDays[6]?.withinCoverage).toBe(false);
  });

  it("clamps requested dates and bounds adjacent week controls", () => {
    expect(scheduleWeekForDate(schedule.source, "2026-09-16", "2026-09-01"))
      .toBe("2026-09-28");
    expect(scheduleWeekForDate(schedule.source, "2026-09-16", "2026-11-09"))
      .toBe("2026-11-02");
    expect(scheduleWeekForDate(schedule.source, "2026-09-16", "2026-10-08"))
      .toBe("2026-10-05");
    expect(adjacentScheduleWeek(schedule.source, "2026-09-28", -1)).toBeNull();
    expect(adjacentScheduleWeek(schedule.source, "2026-11-02", 1)).toBeNull();
  });

  it("canonicalizes an out-of-range week in the address", async () => {
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/schedule?week=2026-11-09"] },
        createElement(ScheduleSurface, { schedule, today: "2026-09-16" }),
        createElement(LocationProbe),
      ),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Current location")).toHaveTextContent(
        "/schedule?week=2026-11-02",
      );
    });
  });

  it("groups repeated station times under one episode card", () => {
    const groups = groupEpisodeAirings(schedule.airings.slice(0, 2));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slots).toHaveLength(2);
  });

  it("derives a source-local date", () => {
    expect(
      todayInTimeZone("America/New_York", new Date("2026-10-01T02:00:00Z")),
    ).toBe("2026-09-30");
  });
});
