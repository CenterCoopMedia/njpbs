import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const serverPolicy = createRequire(import.meta.url)("../../functions/lib/publication-schedule.js") as typeof import("../../packages/content-core/src/publication-schedule");
import { publicationScheduleDeadline, publicationScheduleError } from "../../packages/content-core/src/publication-schedule";
import { publicationTimeOptions, resolvePublicationSchedule } from "../src/lib/publication-schedule";

describe("New York publication scheduling", () => {
  it.each([
    ["2026-01-31T15:30:12.345Z", "2026-02-28T15:30:12.345Z"],
    ["2028-01-31T15:30:00.000Z", "2028-02-29T15:30:00.000Z"],
    ["2026-02-16T15:30:00.000Z", "2026-03-16T14:30:00.000Z"],
    ["2026-10-16T14:30:00.000Z", "2026-11-16T15:30:00.000Z"],
    ["2026-12-31T15:30:00.000Z", "2027-01-31T15:30:00.000Z"],
    ["2027-02-14T07:30:00.000Z", "2027-03-14T07:30:00.000Z"],
    ["2026-10-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"],
  ])("caps %s at one calendar month, %s, in both runtimes", (now, deadline) => {
    for (const policy of [{ publicationScheduleDeadline, publicationScheduleError }, serverPolicy]) {
      expect(new Date(policy.publicationScheduleDeadline(Date.parse(now))).toISOString()).toBe(deadline);
      expect(policy.publicationScheduleError(Date.parse(deadline), Date.parse(now))).toBeNull();
      expect(policy.publicationScheduleError(Date.parse(deadline) + 1, Date.parse(now))).toMatch(/one calendar month/);
      expect(policy.publicationScheduleError(Date.parse(now), Date.parse(now))).toMatch(/future/);
    }
  });

  it("converts New York time independently of the device zone", () => {
    const result = resolvePublicationSchedule("2026-09-17T10:30", "", Date.parse("2026-09-16T12:00:00Z"));
    expect(result).toMatchObject({ instant: "2026-09-17T14:30:00.000Z", error: null });
    expect(result.options).toHaveLength(1);
  });

  it("requires an explicit choice in the repeated fall hour", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const options = publicationTimeOptions("2026-11-01T01:30");
    expect(options.map(option => option.instant)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
    expect(options[0].label).toContain("EDT");
    expect(options[1].label).toContain("EST");
    expect(resolvePublicationSchedule("2026-11-01T01:30", "", now).error).toMatch(/occurs twice/);
    expect(resolvePublicationSchedule("2026-11-01T01:30", options[1].instant, now).instant).toBe(options[1].instant);
  });

  it("allows a lower wall-clock time in the second fall occurrence when it is still in the future", () => {
    expect(resolvePublicationSchedule("2026-11-01T01:15", "2026-11-01T06:15:00.000Z", Date.parse("2026-11-01T05:45:00Z")))
      .toMatchObject({ instant: "2026-11-01T06:15:00.000Z", error: null });
  });

  it("allows a later wall-clock minute in the first occurrence before a second-occurrence ceiling", () => {
    expect(resolvePublicationSchedule("2026-11-01T01:45", "2026-11-01T05:45:00.000Z", Date.parse("2026-10-01T05:30:00Z")))
      .toMatchObject({ instant: "2026-11-01T05:45:00.000Z", error: null });
  });

  it.each(["2027-03-14T02:30", "2026-02-30T12:00", "", "bad date"])("refuses a missing or impossible time: %s", local => {
    const result = resolvePublicationSchedule(local, "", Date.parse("2027-03-01T12:00:00Z"));
    expect(result.instant).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("rejects invalid instants and selections beyond the window", () => {
    expect(publicationScheduleError(NaN, Date.now())).toMatch(/valid/);
    expect(resolvePublicationSchedule("2026-11-20T12:00", "", Date.parse("2026-09-16T12:00:00Z")).error).toMatch(/one calendar month/);
  });
});
