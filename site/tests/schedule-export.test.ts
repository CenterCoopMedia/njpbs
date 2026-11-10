// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import workbook from "../src/data/schedule-corrections-2026-10.json";
import { loadScheduleData } from "../src/lib/schedule-data";
import type { BakedScheduleData, ScheduleFeedDay } from "../src/lib/schedule-feed";
import { buildScheduleExport, scheduleExportTime, SCHEDULE_STALE_AFTER_MS } from "../src/lib/schedule-export";
import { formatScheduleStartTime, SCHEDULE_PDF_COLORS } from "../src/lib/schedule-pdf";

afterEach(() => vi.useRealTimers());

// Explicit fixture dates cross both a month boundary and the fall DST change.
const dates = [
  "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02",
  "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
  "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10",
  "2026-11-11", "2026-11-12",
];
const checkedAt = "2026-10-30T12:00:00.000Z";
const exportedAt = new Date("2026-10-30T15:00:00.000Z");
const day = (date: string): ScheduleFeedDay => ({
  date, callsign: "wnjt", kind: "broadcast", feedCid: "fixture-wnjt",
  timeZone: "America/New_York", sourceCheckedAt: checkedAt,
  entries: [{
    title: `Fixture program for ${date}`,
    startsAt: `${date}T12:00:00${date < "2026-11-01" ? "-04:00" : "-05:00"}`,
    endsAt: `${date}T13:00:00${date < "2026-11-01" ? "-04:00" : "-05:00"}`,
    seasonNumber: null, episodeNumber: null, nolaRoot: null,
    programId: null, programExternalId: null, cid: null,
    isKids: false, kids: false, feedKind: "broadcast",
  }],
});
const fixture = (broadcast = dates.map(day)): BakedScheduleData => ({
  source: "pbs-tvss", generatedAt: "2026-10-30T13:00:00.000Z",
  timeZone: "America/New_York", request: { station: "WNJT", dates },
  days: { broadcast, kids: broadcast.map((item) => ({ ...item, kind: "kids", entries: [] })) },
});

describe("baked 14-day schedule export", () => {
  it("keeps one export timestamp when a build crosses Eastern midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T03:59:59.900Z"));
    const beforeMidnight = scheduleExportTime();
    vi.setSystemTime(new Date("2026-10-31T04:00:00.100Z"));
    expect(scheduleExportTime()).toEqual(beforeMidnight);
  });

  it("covers exactly fourteen calendar dates from the bake, across months and DST", () => {
    const result = buildScheduleExport(fixture(), exportedAt);
    expect(result).toMatchObject({
      startDate: "2026-10-30", endDate: "2026-11-12", dates,
      dayCount: 14, listingCount: 14, missingDates: [],
      rangeLabel: "October 30, 2026 – November 12, 2026",
      shortRangeLabel: "October 30 - November 12",
    });
    expect(result.days).toEqual(dates.map(day));
  });

  it("uses the Eastern bake date and does not advance old data on a new build", () => {
    const result = buildScheduleExport({ ...fixture(), generatedAt: "2026-10-31T03:59:59.000Z" }, new Date("2026-11-10T18:00:00.000Z"));
    expect(result.startDate).toBe("2026-10-30");
    expect(result.endDate).toBe("2026-11-12");
    expect(result.title).toBe("NJ PBS schedule");
    expect(result.generatedAt).toBe("2026-10-31T03:59:59.000Z");
    expect(result.sourceCheckedAt).toBe(checkedAt);
  });

  it("uses a stable route with a filename dated by both window bounds", () => {
    const result = buildScheduleExport(fixture(), exportedAt);
    expect(result.filename).toBe("nj-pbs-schedule-2026-10-30-to-2026-11-12.pdf");
    expect(result.href).toBe("/schedule/downloads/nj-pbs-schedule.pdf");
    const nextBuild = buildScheduleExport(fixture(), new Date("2026-11-10T18:00:00.000Z"));
    expect(nextBuild.filename).toBe("nj-pbs-schedule-2026-10-30-to-2026-11-12.pdf");
    expect(nextBuild.href).toBe("/schedule/downloads/nj-pbs-schedule.pdf");
  });

  it("excludes dates outside the window and sorts the supplied days", () => {
    const result = buildScheduleExport(fixture([day("2026-11-13"), ...dates.map(day).reverse(), day("2026-10-29")]), exportedAt);
    expect(result.days.map((item) => item.date)).toEqual(dates);
    expect(result.listingCount).toBe(14);
  });

  it("keeps the download when the first, middle and last dates are missing", () => {
    const result = buildScheduleExport(fixture(dates.slice(1, -1).filter((date) => date !== "2026-11-05").map(day)), exportedAt);
    expect(result.missingDates).toEqual(["2026-10-30", "2026-11-05", "2026-11-12"]);
    expect(result.coverageNotice).toBe("Missing listings for: October 30, 2026; November 5, 2026; November 12, 2026.");
    expect(result.filename).toBe("nj-pbs-schedule-2026-10-30-to-2026-11-12.pdf");
    expect(result.dayCount).toBe(11);
  });

  it("discloses an empty listing day as missing", () => {
    const result = buildScheduleExport(fixture(dates.map((date) => date === "2026-11-05" ? { ...day(date), entries: [] } : day(date))), exportedAt);
    expect(result.missingDates).toEqual(["2026-11-05"]);
    expect(result.coverageNotice).toBe("Missing listings for: November 5, 2026.");
  });

  it("still provides a route when all fourteen days are missing", () => {
    const result = buildScheduleExport(fixture([]), exportedAt);
    expect(result.missingDates).toEqual(dates);
    expect(result.days).toEqual([]);
    expect(result.href).toBe("/schedule/downloads/nj-pbs-schedule.pdf");
    expect(result.coverageNotice).toContain("November 12, 2026");
  });

  it("applies the page's active corrections before selecting the window", async () => {
    const data = { ...fixture([day("2026-10-06")]), generatedAt: "2026-10-06T15:00:00.000Z", request: { station: "WNJT" as const, dates: ["2026-10-06"] } };
    const result = buildScheduleExport(await loadScheduleData(data, {}), new Date("2026-10-06T16:00:00.000Z"));
    const expected = workbook.days.find((item) => item.date === "2026-10-06")!;
    expect(result.startDate).toBe("2026-10-06");
    expect(result.endDate).toBe("2026-10-19");
    expect(result.shortRangeLabel).toBe("October 6 - 19");
    expect(result.dayCount).toBe(14);
    expect(result.days[0].entries.map(({ title, startsAt, endsAt }) => ({ title, startsAt, endsAt }))).toEqual(expected.entries.map((entry) => ({
      title: entry.title, startsAt: `2026-10-06T${entry.startTime}:00-04:00`,
      endsAt: entry.endTime === "24:00" ? "2026-10-07T00:00:00-04:00" : `2026-10-06T${entry.endTime}:00-04:00`,
    })));
    expect(result.sourceRevisionDates).toEqual([workbook.source.revision]);
    expect(result.sourceCheckedAt).toBeNull();
    expect(result).toMatchObject({ correctedDayCount: 14, pbsCheckedDayCount: 0, unknownDayCount: 0 });
    expect(result.sourceLabel).toBe("NJ PBS replacement lineup");
    expect(result.sourceCheckText).toBe("Last checked with PBS: Not applicable to the 14 corrected listing dates.");
    expect(result.notice).toBe("14 corrected listing dates come from the NJ PBS replacement lineup dated October 14, 2026. PBS retrieval checks do not apply to these corrected dates. Listings may change.");
    expect(result.sourceStatus).toBe("corrected");
  });

  it("labels the recorded PBS check separately from bake and export times", () => {
    const result = buildScheduleExport(fixture(), exportedAt);
    expect(result.sourceCheckedAt).toBe(checkedAt);
    expect(result).toMatchObject({ correctedDayCount: 0, pbsCheckedDayCount: 14, unknownDayCount: 0 });
    expect(result.sourceCheckText).toBe("Last checked with PBS: Oct 30, 2026, 8:00 AM EDT (oldest recorded check across 14 PBS listing dates).");
    expect(result.sourceStatus).toBe("fresh");
  });

  it("keeps the oldest retained check and warns when it is over twenty hours old", () => {
    const oldCheck = "2026-10-29T12:00:00.000Z";
    const result = buildScheduleExport(fixture(dates.map((date) => ({ ...day(date), sourceCheckedAt: date === "2026-11-05" ? oldCheck : checkedAt }))), exportedAt);
    expect(exportedAt.getTime() - Date.parse(oldCheck)).toBeGreaterThan(SCHEDULE_STALE_AFTER_MS);
    expect(result.sourceCheckedAt).toBe(oldCheck);
    expect(result.sourceCheckText).toBe("Last checked with PBS: Oct 29, 2026, 8:00 AM EDT (oldest recorded check across 14 PBS listing dates).");
    expect(result.sourceStatus).toBe("stale");
    expect(result.notice).toMatch(/may have changed/i);
  });

  it("does not infer a PBS check from a legacy bake timestamp", () => {
    const result = buildScheduleExport(fixture(dates.map((date) => ({ ...day(date), sourceCheckedAt: undefined }))), exportedAt);
    expect(result.sourceCheckedAt).toBeNull();
    expect(result.sourceStatus).toBe("unknown");
    expect(result).toMatchObject({ correctedDayCount: 0, pbsCheckedDayCount: 0, unknownDayCount: 14 });
    expect(result.sourceCheckText).toBe("Last checked with PBS: No valid check recorded. No check recorded for 14 listing dates with no correction revision.");
  });

  it("retains known evidence while disclosing a partially unrecorded check", () => {
    const result = buildScheduleExport(fixture(dates.map((date) => ({ ...day(date), sourceCheckedAt: date === "2026-11-05" ? undefined : checkedAt }))), exportedAt);
    expect(result.sourceCheckedAt).toBe(checkedAt);
    expect(result.sourceStatus).toBe("unknown");
    expect(result.unknownDayCount).toBe(1);
    expect(result.sourceCheckText).toBe("Last checked with PBS: Oct 30, 2026, 8:00 AM EDT (oldest recorded check across 13 PBS listing dates). No check recorded for 1 listing date with no correction revision.");
  });

  it("separates corrected and PBS-checked dates in a mixed month-boundary window", () => {
    const broadcast = dates.map((date) => date < "2026-11-01"
      ? { ...day(date), sourceRevision: "2026-09-28", sourceCheckedAt: undefined }
      : day(date));
    const result = buildScheduleExport(fixture(broadcast), exportedAt);
    expect(result).toMatchObject({ correctedDayCount: 2, pbsCheckedDayCount: 12, unknownDayCount: 0, sourceStatus: "fresh" });
    expect(result.sourceLabel).toBe("PBS TVSS and NJ PBS replacement lineup");
    expect(result.notice).toBe("2 corrected listing dates come from the NJ PBS replacement lineup dated September 28, 2026. Every supplied PBS date was retrieved within 20 hours of export. Listings may still change.");
    expect(result.sourceCheckText).toBe("Last checked with PBS: Oct 30, 2026, 8:00 AM EDT (oldest recorded check across 12 PBS listing dates).");
  });

  it("counts only dates with neither evidence type as unknown in a mixed window", () => {
    const broadcast = dates.map((date) => date < "2026-11-01"
      ? { ...day(date), sourceRevision: date === "2026-10-30" ? "2026-09-28" : "2026-09-29", sourceCheckedAt: undefined }
      : date === "2026-11-05" ? { ...day(date), sourceCheckedAt: undefined } : day(date));
    const result = buildScheduleExport(fixture(broadcast), exportedAt);
    expect(result).toMatchObject({ correctedDayCount: 2, pbsCheckedDayCount: 11, unknownDayCount: 1, sourceStatus: "unknown" });
    expect(result.sourceRevisionDates).toEqual(["2026-09-28", "2026-09-29"]);
    expect(result.notice).toBe("1 corrected listing date comes from the NJ PBS replacement lineup dated September 28, 2026. 1 corrected listing date comes from the NJ PBS replacement lineup dated September 29, 2026. Source freshness is unknown for 1 listing date with neither a PBS check nor a correction revision. Listings may have changed.");
    expect(result.sourceCheckText).toBe("Last checked with PBS: Oct 30, 2026, 8:00 AM EDT (oldest recorded check across 11 PBS listing dates). No check recorded for 1 listing date with no correction revision.");
  });

  it("does not label a corrected date's replaced PBS evidence as a retrieval of the replacement lineup", () => {
    const result = buildScheduleExport(fixture(dates.map((date) => ({ ...day(date), sourceRevision: "2026-09-28" }))), exportedAt);
    expect(result).toMatchObject({ correctedDayCount: 14, pbsCheckedDayCount: 0, unknownDayCount: 0, sourceCheckedAt: null, sourceStatus: "corrected" });
  });

  it("reports invalid correction evidence without formatting an invalid revision", () => {
    const result = buildScheduleExport(fixture(dates.map((date) => ({ ...day(date), sourceRevision: "invalid", sourceCheckedAt: undefined }))), exportedAt);
    expect(result.sourceStatus).toBe("invalid");
    expect(result.sourceRevisionDates).toEqual([]);
    expect(result.notice).toBe("Source evidence is invalid or later than the export. Source freshness is unknown; listings may have changed.");
  });

  it.each(["invalid", "2026-10-30T15:00:00.001Z"])("warns about invalid or future check evidence: %s", (sourceCheckedAt) => {
    const result = buildScheduleExport(fixture(dates.map((date) => ({ ...day(date), sourceCheckedAt }))), exportedAt);
    expect(result.sourceStatus).toBe("invalid");
    expect(result.sourceCheckedAt).toBeNull();
    expect(result.notice).toMatch(/invalid or later than the export/i);
  });

  it("counts leap day as a calendar date in the window", () => {
    const result = buildScheduleExport({ ...fixture(), generatedAt: "2028-02-20T18:00:00.000Z" }, new Date("2028-02-20T19:00:00.000Z"));
    expect(result.startDate).toBe("2028-02-20");
    expect(result.endDate).toBe("2028-03-04");
    expect(result.dates).toContain("2028-02-29");
  });

  it("keeps both years in a short range that crosses New Year's Day", () => {
    const result = buildScheduleExport({ ...fixture(), generatedAt: "2026-12-26T18:00:00.000Z" }, new Date("2026-12-26T19:00:00.000Z"));
    expect(result.shortRangeLabel).toBe("December 26, 2026 - January 8, 2027");
  });

  it("distinguishes repeated Eastern daylight-saving times in the PDF", () => {
    expect(formatScheduleStartTime("2026-11-01T01:30:00-04:00")).toBe("1:30 a.m. EDT");
    expect(formatScheduleStartTime("2026-11-01T01:30:00-05:00")).toBe("1:30 a.m. EST");
  });
});

describe("schedule PDF design tokens", () => {
  it("mirrors the accepted light-document and NJ PBS brand tokens", async () => {
    const css = await readFile("src/styles/design-tokens.css", "utf8");
    for (const [token, value] of [
      ["--color-theme-navy", SCHEDULE_PDF_COLORS.navy], ["--pbs-blue", SCHEDULE_PDF_COLORS.blue],
      ["--color-print-ink", SCHEDULE_PDF_COLORS.ink], ["--color-light-text-muted", SCHEDULE_PDF_COLORS.muted],
      ["--color-light-line", SCHEDULE_PDF_COLORS.rule], ["--color-light-surface-blue", SCHEDULE_PDF_COLORS.lightBlue],
      ["--color-light-note", SCHEDULE_PDF_COLORS.note],
    ]) expect(css).toContain(`${token}: ${value}`);
  });
});
