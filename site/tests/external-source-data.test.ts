// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLaunchContentData } from "../src/lib/launch-content-data";
import { loadScheduleData } from "../src/lib/schedule-data";
import type { BakedScheduleData } from "../src/lib/schedule-feed";
// Fixed October input; the rolling schedule.json is allowed to move beyond October.
import scheduleFixture from "../src/data/schedule-fixture.json";
import octoberFeed from "./fixtures/schedule-corrections-2026-10-source.json";

const directories: string[] = [];

async function fixturePath(name: string, value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "njpbs-source-data-"));
  directories.push(directory);
  const inputPath = path.join(directory, name);
  await writeFile(inputPath, `${JSON.stringify(value)}\n`, "utf8");
  return inputPath;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("private public-build source data", () => {
  it("uses committed inputs when no private path is selected", async () => {
    const launch = { source: "media-manager", checkedAt: "2026-06-29T19:43:58.507Z", cards: [{}] };
    const schedule = {
      source: "pbs-tvss",
      generatedAt: "2026-09-18T13:32:43.252Z",
      timeZone: "America/New_York",
      request: { station: "WNJT", dates: ["2026-09-18"] },
      days: { broadcast: [{}], kids: [{}] },
    } as unknown as BakedScheduleData;

    await expect(loadLaunchContentData(launch, {})).resolves.toBe(launch);
    await expect(loadScheduleData(schedule, {})).resolves.toBe(schedule);
  });

  it("loads exact generated Media Manager and schedule files", async () => {
    const launch = {
      source: "media-manager",
      checkedAt: "2026-09-21T21:00:00.000Z",
      cards: [{ title: "Current program" }],
    };
    const { fixture: _marker, ...schedule } = structuredClone(scheduleFixture);
    const launchPath = await fixturePath("launch.json", launch);
    const schedulePath = await fixturePath("schedule.json", schedule);

    await expect(loadLaunchContentData(
      { source: "manual-fallback", cards: [] },
      { LAUNCH_CONTENT_DATA_PATH: launchPath },
    )).resolves.toEqual(launch);
    await expect(loadScheduleData(
      {} as BakedScheduleData,
      { SCHEDULE_DATA_PATH: schedulePath },
    )).resolves.toEqual(schedule);
  });

  it("applies approved October corrections after selecting the publisher's external schedule file", async () => {
    const schedulePath = await fixturePath("october.json", octoberFeed);
    const corrected = await loadScheduleData({} as BakedScheduleData, { SCHEDULE_DATA_PATH: schedulePath });
    expect(corrected.source).toBe("pbs-tvss-with-njpbs-corrections");
    expect(corrected.request.dates).toHaveLength(31);
    expect(corrected.days.broadcast.find((day) => day.date === "2026-10-02")?.entries).toContainEqual(
      expect.objectContaining({ title: "Steve Adubato's Media Matters", startsAt: "2026-10-02T20:00:00-04:00" }),
    );
  });

  const invalidScheduleFiles = () => {
    const { fixture: _marker, ...data } = structuredClone(scheduleFixture);
    const emptyDay = structuredClone(data);
    emptyDay.days.broadcast[0].entries = [];
    const reversedInterval = structuredClone(data);
    reversedInterval.days.broadcast[0].entries[0].endsAt = reversedInterval.days.broadcast[0].entries[0].startsAt;
    return [
      ["fixture marker", { ...data, fixture: true }],
      ["missing day fields", { ...data, days: { ...data.days, broadcast: [{}] } }],
      ["duplicate request dates", { ...data, request: { ...data.request, dates: [...data.request.dates, data.request.dates[0]] } }],
      ["empty listing day", emptyDay],
      ["reversed program interval", reversedInterval],
    ] as const;
  };

  it.each(invalidScheduleFiles())("refuses a generated schedule with %s", async (_reason, value) => {
    const inputPath = await fixturePath("invalid-schedule.json", value);
    await expect(loadScheduleData({} as BakedScheduleData, { SCHEDULE_DATA_PATH: inputPath }))
      .rejects.toThrow("Generated PBS schedule data is invalid");
  });

  it.each([
    ["Media Manager", "LAUNCH_CONTENT_DATA_PATH", { source: "manual-fallback", checkedAt: "2026-09-21T21:00:00Z", cards: [{}] }],
    ["Media Manager", "LAUNCH_CONTENT_DATA_PATH", { source: "media-manager", checkedAt: "invalid", cards: [{}] }],
    ["Media Manager", "LAUNCH_CONTENT_DATA_PATH", { source: "media-manager", checkedAt: "2026-09-21T21:00:00Z", cards: [] }],
    ["PBS schedule", "SCHEDULE_DATA_PATH", { source: "pbs-tvss", generatedAt: "invalid", timeZone: "America/New_York", request: { station: "WNJT", dates: [] }, days: { broadcast: [], kids: [] } }],
  ])("refuses invalid generated %s data", async (label, field, value) => {
    const inputPath = await fixturePath("invalid.json", value);
    const environment = { [field]: inputPath };
    const read = label === "Media Manager"
      ? loadLaunchContentData({ cards: [] }, environment)
      : loadScheduleData({} as BakedScheduleData, environment);
    await expect(read).rejects.toThrow(`Generated ${label}`);
  });
});
