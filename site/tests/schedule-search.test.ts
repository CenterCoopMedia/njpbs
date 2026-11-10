import { describe, expect, it } from "vitest";
import {
  matchesScheduleSearch,
  normalizeScheduleSearchText,
} from "../src/lib/schedule-search.ts";

describe("schedule search", () => {
  it("normalizes case, accents, and repeated whitespace", () => {
    expect(normalizeScheduleSearchText("  CAFE\u0301   NJ  ")).toBe("cafe nj");
  });

  it("matches program and episode titles but not unrelated metadata", () => {
    const listing = {
      title: "Antiques Roadshow",
      episodeTitle: "New Jersey Hour",
    };

    expect(matchesScheduleSearch(listing, "ANTIQUES")).toBe(true);
    expect(matchesScheduleSearch(listing, "  jersey   hour ")).toBe(true);
    expect(matchesScheduleSearch(listing, "8:00 p.m.")).toBe(false);
    expect(matchesScheduleSearch(listing, "   ")).toBe(false);
  });
});
