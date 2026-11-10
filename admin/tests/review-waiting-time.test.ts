import { describe, expect, it } from "vitest";
import { formatReviewWaitingTime } from "../src/lib/review-waiting-time";

const NOW = new Date("2026-09-03T16:00:00.000Z");

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString();
}

describe("review waiting time", () => {
  it.each([
    [ago(59 * 60 * 1_000), "Under 1 hour"],
    [ago(60 * 60 * 1_000), "1 hour"],
    [ago(23 * 60 * 60 * 1_000), "23 hours"],
    [ago(24 * 60 * 60 * 1_000), "1 day"],
    [ago(6 * 24 * 60 * 60 * 1_000), "6 days"],
    [ago(7 * 24 * 60 * 60 * 1_000), "1 week"],
    [ago(29 * 24 * 60 * 60 * 1_000), "4 weeks"],
    [ago(30 * 24 * 60 * 60 * 1_000), "1 month or more"],
  ])("formats %s as %s", (requestedAt, expected) => {
    expect(formatReviewWaitingTime(requestedAt, NOW)).toBe(expected);
  });

  it.each([null, "not-a-date", "2026-09-04T16:00:00.000Z"])(
    "keeps unavailable waiting time explicit for %s",
    (requestedAt) => {
      expect(formatReviewWaitingTime(requestedAt, NOW)).toBe(
        "Waiting time unavailable",
      );
    },
  );
});
