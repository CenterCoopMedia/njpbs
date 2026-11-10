// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ScheduleListing } from "../src/lib/schedule-feed.ts";
import * as scheduleTimeline from "../src/lib/schedule-timeline.ts";
import {
  PRIMETIME_END_MINUTE,
  PRIMETIME_START_MINUTE,
  buildScheduleRows,
  easternStartMinute,
  formatScheduleDateLabel,
  formatScheduleRange,
  formatScheduleTime,
  scheduleDurationMinutes,
} from "../src/lib/schedule-timeline.ts";

interface ScheduleHourMark {
  readonly hour: number;
  readonly minute: number;
  readonly label: string;
}

interface ScheduleRowHeightOptions {
  readonly startMinute: number;
  readonly durationMinutes: number;
  readonly nextStartMinute: number | null;
  readonly pixelsPerMinute: number;
  readonly minHeightPx: number;
}

function scheduleHourMarks(date: string): readonly ScheduleHourMark[] {
  const buildScheduleHourMarks = (
    scheduleTimeline as typeof scheduleTimeline & {
      buildScheduleHourMarks?: (value: string) => readonly ScheduleHourMark[];
    }
  ).buildScheduleHourMarks;
  expect(buildScheduleHourMarks).toBeTypeOf("function");
  return buildScheduleHourMarks?.(date) ?? [];
}

function scheduleDayLength(date: string): number {
  const scheduleDayLengthMinutes = (
    scheduleTimeline as typeof scheduleTimeline & {
      scheduleDayLengthMinutes?: (value: string) => number;
    }
  ).scheduleDayLengthMinutes;
  expect(scheduleDayLengthMinutes).toBeTypeOf("function");
  return scheduleDayLengthMinutes?.(date) ?? Number.NaN;
}

function scheduleRowHeight(options: ScheduleRowHeightOptions): number {
  const scheduleRowHeightPx = (
    scheduleTimeline as typeof scheduleTimeline & {
      scheduleRowHeightPx?: (value: ScheduleRowHeightOptions) => number;
    }
  ).scheduleRowHeightPx;
  expect(scheduleRowHeightPx).toBeTypeOf("function");
  return scheduleRowHeightPx?.(options) ?? Number.NaN;
}

function scheduleTimelineDuration(date: string): number {
  const scheduleTimelineDurationMinutes = (
    scheduleTimeline as typeof scheduleTimeline & {
      scheduleTimelineDurationMinutes?: (value: string) => number;
    }
  ).scheduleTimelineDurationMinutes;
  expect(scheduleTimelineDurationMinutes).toBeTypeOf("function");
  return scheduleTimelineDurationMinutes?.(date) ?? Number.NaN;
}

function listing(
  title: string,
  startsAt: string,
  endsAt: string,
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
  };
}

describe("schedule timeline math", () => {
  it("finds the Eastern minute at midnight and in the evening", () => {
    expect(easternStartMinute("2026-07-10T00:00:00-04:00")).toBe(0);
    expect(easternStartMinute("2026-07-11T00:17:00Z")).toBe(20 * 60 + 17);
  });

  it("uses epoch math for listing duration", () => {
    expect(
      scheduleDurationMinutes(
        "2026-11-01T01:30:00-04:00",
        "2026-11-01T01:30:00-05:00",
      ),
    ).toBe(60);
  });

  it("keeps fall-back listings monotonic through the repeated Eastern hour", () => {
    const firstOneThirty = listing(
      "First 1:30",
      "2026-11-01T01:30:00-04:00",
      "2026-11-01T01:45:00-04:00",
    );
    const secondOneTen = listing(
      "Second 1:10",
      "2026-11-01T01:10:00-05:00",
      "2026-11-01T01:25:00-05:00",
    );

    expect(buildScheduleRows([firstOneThirty, secondOneTen])).toEqual([
      { listing: firstOneThirty, startMinute: 90, durationMinutes: 15 },
      { listing: secondOneTen, startMinute: 130, durationMinutes: 15 },
    ]);
  });

  it("keeps rows, marks, and total height on fall-back elapsed minutes", () => {
    const firstOneThirty = listing(
      "First 1:30",
      "2026-11-01T01:30:00-04:00",
      "2026-11-01T01:45:00-04:00",
    );
    const secondOneTen = listing(
      "Second 1:10",
      "2026-11-01T01:10:00-05:00",
      "2026-11-01T01:25:00-05:00",
    );

    const marks = scheduleHourMarks("2026-11-01");
    const rows = buildScheduleRows([firstOneThirty, secondOneTen]);

    expect(scheduleTimelineDuration("2026-11-01")).toBe(25 * 60);
    expect(marks).toHaveLength(25);
    expect(marks.filter((mark) => mark.label === "1:00 a.m.")).toEqual([
      { hour: 1, minute: 60, label: "1:00 a.m." },
      { hour: 1, minute: 120, label: "1:00 a.m." },
    ]);
    expect(marks.find((mark) => mark.label === "2:00 a.m.")).toEqual({
      hour: 2,
      minute: 180,
      label: "2:00 a.m.",
    });
    expect(rows[1]?.startMinute).toBe(130);
    expect(rows[1]?.startMinute).toBeLessThan(
      marks.find((mark) => mark.label === "2:00 a.m.")?.minute ?? 0,
    );
  });

  it("keeps rows, marks, and total height on spring-forward elapsed minutes", () => {
    const threeTen = listing(
      "After the skip",
      "2026-03-08T03:10:00-04:00",
      "2026-03-08T03:40:00-04:00",
    );

    const marks = scheduleHourMarks("2026-03-08");
    const rows = buildScheduleRows([threeTen]);

    expect(scheduleTimelineDuration("2026-03-08")).toBe(23 * 60);
    expect(marks).toHaveLength(23);
    expect(marks.some((mark) => mark.label === "2:00 a.m.")).toBe(false);
    expect(marks.find((mark) => mark.label === "3:00 a.m.")).toEqual({
      hour: 3,
      minute: 120,
      label: "3:00 a.m.",
    });
    expect(rows[0]?.startMinute).toBe(130);
    expect(rows[0]?.startMinute).toBe(
      (marks.find((mark) => mark.label === "3:00 a.m.")?.minute ?? 0) + 10,
    );
  });

  it("places fall-back hour marks on elapsed-minute coordinates", () => {
    const marks = scheduleHourMarks("2026-11-01");

    expect(scheduleDayLength("2026-11-01")).toBe(25 * 60);
    expect(marks.slice(0, 4)).toEqual([
      { hour: 0, minute: 0, label: "12:00 a.m." },
      { hour: 1, minute: 60, label: "1:00 a.m." },
      { hour: 1, minute: 120, label: "1:00 a.m." },
      { hour: 2, minute: 180, label: "2:00 a.m." },
    ]);
  });

  it("places spring-forward rows and marks on elapsed-minute coordinates", () => {
    const marks = scheduleHourMarks("2026-03-08");

    expect(scheduleDayLength("2026-03-08")).toBe(23 * 60);
    expect(marks.map((mark) => mark.label)).not.toContain("2:00 a.m.");
    expect(marks.find((mark) => mark.label === "3:00 a.m.")?.minute).toBe(120);
    expect(easternStartMinute("2026-03-08T03:00:00-04:00")).toBe(120);
  });

  it("formats 12-hour times and ranges with explicit Eastern time", () => {
    expect(formatScheduleTime("2026-07-10T00:00:00-04:00")).toBe(
      "12:00 a.m.",
    );
    expect(formatScheduleTime("2026-07-10T20:30:00-04:00")).toBe(
      "8:30 p.m.",
    );
    expect(
      formatScheduleRange(
        listing(
          "Nature",
          "2026-07-10T20:00:00-04:00",
          "2026-07-10T21:00:00-04:00",
        ),
      ),
    ).toBe("8:00–9:00 p.m. ET");
  });

  it("formats date labels in America/New_York", () => {
    expect(formatScheduleDateLabel("2026-07-10")).toBe("Friday, July 10");
    expect(formatScheduleDateLabel(new Date("2026-07-11T03:30:00Z"))).toBe(
      "Friday, July 10",
    );
  });

  it("labels standard-time rail hours in Eastern wall time", () => {
    const marks = scheduleHourMarks("2027-01-15");

    expect(marks[0]).toEqual({ hour: 0, minute: 0, label: "12:00 a.m." });
    expect(marks[20]).toEqual({ hour: 20, minute: 1200, label: "8:00 p.m." });
  });

  it("labels daylight-time rail hours in Eastern wall time", () => {
    const marks = scheduleHourMarks("2026-07-10");

    expect(marks[0]).toEqual({ hour: 0, minute: 0, label: "12:00 a.m." });
    expect(marks[20]).toEqual({ hour: 20, minute: 1200, label: "8:00 p.m." });
  });

  it("preserves each valid listing in a proportional row model", () => {
    const nature = listing(
      "Nature",
      "2026-07-10T20:00:00-04:00",
      "2026-07-10T20:30:00-04:00",
    );

    expect(buildScheduleRows([nature])).toEqual([
      { listing: nature, startMinute: 1200, durationMinutes: 30 },
    ]);
  });

  it("caps a short row height before the next proportional start", () => {
    expect(
      scheduleRowHeight({
        startMinute: 20 * 60,
        durationMinutes: 26,
        nextStartMinute: 20 * 60 + 26,
        pixelsPerMinute: 2.4,
        minHeightPx: 68,
      }),
    ).toBeCloseTo(60.4, 5);
  });

  it("keeps the minimum row height when the next start leaves room", () => {
    expect(
      scheduleRowHeight({
        startMinute: 20 * 60,
        durationMinutes: 26,
        nextStartMinute: 20 * 60 + 45,
        pixelsPerMinute: 2.4,
        minHeightPx: 68,
      }),
    ).toBe(68);
  });

  it("excludes invalid and non-positive intervals", () => {
    const invalid = listing("Invalid", "nope", "still-nope");
    const reversed = listing(
      "Reversed",
      "2026-07-10T21:00:00-04:00",
      "2026-07-10T20:00:00-04:00",
    );

    expect(buildScheduleRows([invalid, reversed])).toEqual([]);
  });

  it("defines primetime from 8 through 11 p.m.", () => {
    expect(PRIMETIME_START_MINUTE).toBe(20 * 60);
    expect(PRIMETIME_END_MINUTE).toBe(23 * 60);
  });
});
