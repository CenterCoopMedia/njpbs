// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildScheduleConfig,
  mapWithConcurrency,
} from "../scripts/sync-schedule.mjs";

describe("schedule request concurrency", () => {
  it("uses a conservative default and rejects an upstream-hostile override", () => {
    expect(buildScheduleConfig({}).requestConcurrency).toBe(4);
    expect(
      buildScheduleConfig({ SCHEDULE_REQUEST_CONCURRENCY: "6" })
        .requestConcurrency,
    ).toBe(6);
    expect(() =>
      buildScheduleConfig({ SCHEDULE_REQUEST_CONCURRENCY: "9" }),
    ).toThrow("SCHEDULE_REQUEST_CONCURRENCY must not exceed 8");
  });

  it("runs several requests at once without exceeding the limit or reordering output", async () => {
    let active = 0;
    let maximumActive = 0;
    const items = Array.from({ length: 12 }, (_, index) => index);

    const result = await mapWithConcurrency(items, 3, async (item: number) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return item * 2;
    });

    expect(maximumActive).toBe(3);
    expect(result).toEqual(items.map((item) => item * 2));
  });

  it("stops claiming new work after the first failure and waits for active work to settle", async () => {
    const started: number[] = [];
    const settled: number[] = [];

    await expect(
      mapWithConcurrency(
        Array.from({ length: 10 }, (_, index) => index),
        2,
        async (item: number) => {
          started.push(item);
          if (item === 0) throw new Error("upstream failed");
          await new Promise((resolve) => setTimeout(resolve, 2));
          settled.push(item);
          return item;
        },
      ),
    ).rejects.toThrow("upstream failed");

    expect(started).toEqual([0, 1]);
    expect(settled).toEqual([1]);
  });
});
