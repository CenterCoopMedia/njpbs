import { assertScheduleInputShape } from "./schedule-input-shape.mjs";
import type { BakedScheduleData } from "./schedule-feed";

export function isScheduleFixture(value: unknown): boolean {
  return typeof value === "object" && value !== null && "fixture" in value;
}

/** A provider input must contain actual listings in both feeds. */
export function assertScheduleInput(value: unknown): asserts value is BakedScheduleData {
  assertScheduleInputShape(value);
}

