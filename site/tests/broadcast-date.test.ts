import { describe, expect, it } from "vitest";
import { assertBroadcastDate, isBroadcastDate } from "../src/lib/broadcast-date";

// This module exists to be the one definition of a broadcast day's date (#753),
// so it gets its own tests rather than being covered incidentally through a
// consumer. Two consumers rely on it now — the static feed's shapeTvssScheduleDay
// and the proxy contract's isScheduleDay — and the reason #753 happened is that
// each used to carry its own check and they drifted apart.

describe("isBroadcastDate", () => {
  it("accepts a real ISO day", () => {
    expect(isBroadcastDate("2026-07-10")).toBe(true);
    expect(isBroadcastDate("2026-01-01")).toBe(true);
    expect(isBroadcastDate("2026-12-31")).toBe(true);
  });

  it("accepts a genuine leap day and rejects one that did not happen", () => {
    // The pair that proves the calendar round-trip runs, rather than a regex
    // that happens to allow 29 in February.
    expect(isBroadcastDate("2028-02-29")).toBe(true);
    expect(isBroadcastDate("2026-02-29")).toBe(false);
  });

  it("rejects TVSS's dashless form, the value most likely to arrive", () => {
    // The proxy is called with YYYYMMDD and hands it to the transform, so this
    // is the wrong shape a served day is most likely to carry.
    expect(isBroadcastDate("20260710")).toBe(false);
  });

  it("rejects shapes that look close enough to slip through", () => {
    for (const value of [
      "2026-7-10",
      "07-10-2026",
      "2026/07/10",
      "2026-07-10T00:00:00Z",
      "2026-07-10 ",
      "today",
      "",
    ]) {
      expect(isBroadcastDate(value)).toBe(false);
    }
  });

  it("rejects a day that never happened even though the shape is right", () => {
    // Date.UTC rolls Sep 31 into Oct 1 rather than refusing it, so shape alone
    // would accept every one of these.
    for (const value of [
      "2026-09-31",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-07-32",
      "2026-07-00",
    ]) {
      expect(isBroadcastDate(value)).toBe(false);
    }
  });

  it("rejects a non-string without throwing, so it can guard an untrusted body", () => {
    // isScheduleDay calls this on a parsed JSON value, where anything can arrive.
    for (const value of [null, undefined, 20260710, {}, [], new Date()]) {
      expect(isBroadcastDate(value)).toBe(false);
    }
  });
});

describe("assertBroadcastDate", () => {
  it("names the offending value, so a failed build says which day broke it", () => {
    // The bake path runs over many days; an error without the value would send
    // someone hunting through the whole feed.
    expect(() => assertBroadcastDate("20260710")).toThrow(
      /Invalid broadcast date: 20260710/,
    );
  });
});
