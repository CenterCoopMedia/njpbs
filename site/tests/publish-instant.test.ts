import { describe, expect, it } from "vitest";
import { parsePublishInstant } from "../../packages/content-core/src/publish-instant";

describe("parsePublishInstant", () => {
  it("reads the canonical UTC form the write boundary stores", () => {
    expect(parsePublishInstant("2026-07-14T00:00:00.000Z")).toBe(Date.UTC(2026, 6, 14));
  });

  it("reads the same instant with the milliseconds omitted", () => {
    expect(parsePublishInstant("2026-07-14T00:00:00Z")).toBe(Date.UTC(2026, 6, 14));
  });

  it.each([
    ["2026-07-14T00:00:00.5Z", 500],
    ["2026-07-14T00:00:00.05Z", 50],
    ["2026-07-14T00:00:00.005Z", 5],
  ])("reads %s as a fraction of a second, not a raw millisecond count", (value, millis) => {
    // ".5" is half a second, not 5ms. Reading the digits as-written would put the
    // instant 495ms early, so the fraction is padded out to three places.
    expect(parsePublishInstant(value)).toBe(Date.UTC(2026, 6, 14, 0, 0, 0, millis));
  });

  it.each([
    "2026-02-30T00:00:00.000Z", // Date.parse rolls this forward to Mar 2
    "2026-04-31T00:00:00.000Z",
    "2027-02-29T00:00:00.000Z", // not a leap year
    "2026-13-01T00:00:00.000Z",
    "2026-00-01T00:00:00.000Z",
    "2026-07-00T00:00:00.000Z",
    "2026-07-14T24:00:00.000Z",
    "2026-07-14T00:60:00.000Z",
  ])("rejects the impossible calendar date %j rather than moving it", (value) => {
    expect(parsePublishInstant(value)).toBeNull();
  });

  it("accepts a leap day in a real leap year", () => {
    expect(parsePublishInstant("2028-02-29T00:00:00.000Z")).toBe(Date.UTC(2028, 1, 29));
  });

  it.each([
    "2026-07-14T00:00:00", // zone-less: no instant until someone picks a zone
    "2026-07-14T00:00:00.000", // zone-less with millis
    "2026-07-14T00:00:00.000+05:00", // an offset, not the canonical UTC form
    "2026-07-14T00:00:00.000z", // lowercase zone marker
    "2026-07-14 00:00:00Z", // space separator
    "2026-07-14", // date only
    "not-a-date",
    "",
  ])("rejects %j as not an absolute UTC instant", (value) => {
    expect(parsePublishInstant(value)).toBeNull();
  });

  it("rejects a two-digit year written into four places", () => {
    // Date.UTC maps years 0-99 onto 1900+year, so "0099" would silently become 1999.
    // The round-trip check is what catches it.
    expect(parsePublishInstant("0099-07-14T00:00:00.000Z")).toBeNull();
  });

  // Each row is wrapped so vitest passes it as one argument: a bare `[]` row would be
  // spread into no arguments at all and the case would silently test `undefined` twice.
  it.each([[null], [undefined], [0], [1752451200000], [{}], [[]]])(
    "rejects the non-string stored value %j instead of throwing",
    (value) => {
      // A scan of stored rows must survive one bad row; .match() on a non-string would
      // throw and take out the whole batch.
      expect(parsePublishInstant(value as unknown as string)).toBeNull();
    },
  );
});
