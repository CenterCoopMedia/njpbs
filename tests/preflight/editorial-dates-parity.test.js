import { describe, expect, it } from "vitest";
import mirror from "../../functions/lib/editorial-dates.js";
import * as core from "../../packages/content-core/src/editorial-dates";

// Firebase deploys functions/ without the TypeScript workspace, so the date
// contract exists twice. Two copies can disagree, and a disagreement here would put
// a different publication date on the page than the one the CMS shows the editor.
// Every case runs through both implementations and has to come back identical.

// Fixed instants only. A day boundary or a daylight-saving transition asserted
// against a live clock is a test that passes for eleven months.
const INSTANTS = [
  "2026-08-14T03:30:00.000Z", // 11:30 p.m. Aug. 13 in New Jersey
  "2026-08-14T13:00:00.000Z",
  "2026-03-08T06:30:00.000Z", // 1:30 a.m. EST, before the spring gap
  "2026-03-08T07:30:00.000Z", // 3:30 a.m. EDT, after it
  "2026-11-01T05:30:00.000Z", // the first 1:30 a.m., EDT
  "2026-11-01T06:30:00.000Z", // the repeated 1:30 a.m., EST
  "2026-01-01T04:59:00.000Z", // 11:59 p.m. Dec. 31 in New Jersey
  "2019-04-02T18:00:00.000Z",
];

const RECORDS = [
  {},
  { date: "2019-04-02" },
  { date: "2019-04-02", publiclyVisible: true },
  { date: "2019-04-02", editorialDateSource: "legacy", publiclyVisible: true },
  { editorialDateSource: "firstPublish", firstPublishedAt: INSTANTS[0], date: "2026-08-13" },
  { editorialDateSource: "firstPublish", firstPublishedAt: INSTANTS[3], date: "2026-03-08" },
  { editorialDateSource: "backdated", firstPublishedAt: INSTANTS[1], date: "2026-07-04" },
  { editorialDateSource: "backdated", firstPublishedAt: INSTANTS[6], date: "2026-01-15" },
  { editorialDateSource: "whatever", date: "2020-02-29" },
  { date: "2026-02-30" },
  {
    editorialDateSource: "firstPublish",
    firstPublishedAt: INSTANTS[0],
    meaningfulUpdatedAt: INSTANTS[1],
    showUpdatedDate: true,
  },
  {
    editorialDateSource: "firstPublish",
    firstPublishedAt: INSTANTS[0],
    meaningfulUpdatedAt: INSTANTS[1],
  },
  {
    editorialDateSource: "firstPublish",
    firstPublishedAt: INSTANTS[0],
    showUpdatedDate: true,
  },
  {
    date: "2019-04-02",
    publiclyVisible: true,
    published: { publishedAt: INSTANTS[1] },
  },
];

const SUBMISSIONS = [undefined, null, "", "   ", "2026-08-13", "2026-07-04", "2026-02-30", 7];

describe("editorial date contract parity", () => {
  it.each([
    ["ACA", { editorialDateSource: "backdated", date: "2026-10-19", firstPublishedAt: "2026-10-19T14:01:26.827Z" }, "2026-10-19T14:01:26.827Z"],
    ["congestion tolls", { editorialDateSource: "backdated", date: "2026-10-19", firstPublishedAt: "2026-10-19T16:20:52.363Z" }, "2026-10-19T16:20:52.363Z"],
    ["same-day legacy", { editorialDateSource: "legacy", date: "2026-10-19", firstPublishedAt: "2026-10-19T16:20:52.363Z" }, "2026-10-19T16:20:52.363Z"],
    ["different-day backdate", { editorialDateSource: "backdated", date: "2026-10-18", firstPublishedAt: "2026-10-19T16:20:52.363Z" }, "2026-10-18T04:00:00.000Z"],
    ["legacy without first publish", { date: "2026-01-15" }, "2026-01-15T05:00:00.000Z"],
    ["invalid first publish", { editorialDateSource: "backdated", date: "2026-10-19", firstPublishedAt: "2026-10-19" }, "2026-10-19T04:00:00.000Z"],
    ["station day across UTC midnight", { editorialDateSource: "backdated", date: "2026-08-13", firstPublishedAt: INSTANTS[0] }, INSTANTS[0]],
    ["spring before gap", { editorialDateSource: "backdated", date: "2026-03-08", firstPublishedAt: INSTANTS[2] }, INSTANTS[2]],
    ["spring after gap", { editorialDateSource: "backdated", date: "2026-03-08", firstPublishedAt: INSTANTS[3] }, INSTANTS[3]],
    ["fall first hour", { editorialDateSource: "legacy", date: "2026-11-01", firstPublishedAt: INSTANTS[4] }, INSTANTS[4]],
    ["fall repeated hour", { editorialDateSource: "legacy", date: "2026-11-01", firstPublishedAt: INSTANTS[5] }, INSTANTS[5]],
  ])("sorts %s by the specified station-day instant in both implementations", (_label, record, expected) => {
    // Expected instants come from publication receipts and New York's UTC offsets.
    expect(core.editorialSortInstant(record)).toBe(Date.parse(expected));
    expect(mirror.editorialSortInstant(record)).toBe(Date.parse(expected));
  });



  it("reads the same station calendar day for every instant", () => {
    for (const instant of [...INSTANTS, "2026-08-13", "not an instant"]) {
      expect(mirror.stationCalendarDay(instant), instant).toBe(
        core.stationCalendarDay(instant),
      );
    }
  });

  it("resolves the same source, display date, update display, and sort order", () => {
    for (const record of RECORDS) {
      const label = JSON.stringify(record);
      expect(mirror.resolveEditorialDateSource(record), label).toBe(
        core.resolveEditorialDateSource(record),
      );
      expect(mirror.resolveDisplayDate(record), label).toBe(core.resolveDisplayDate(record));
      expect(mirror.resolveUpdateDisplay(record), label).toEqual(
        core.resolveUpdateDisplay(record),
      );
      expect(mirror.editorialSortInstant(record), label).toBe(
        core.editorialSortInstant(record),
      );
    }
  });

  it("stamps the same first publish for every record and instant", () => {
    for (const record of RECORDS) {
      for (const at of INSTANTS) {
        const label = `${JSON.stringify(record)} @ ${at}`;
        expect(mirror.applyFirstPublish(record, { at, by: "uid" }), label).toEqual(
          core.applyFirstPublish(record, { at, by: "uid" }),
        );
      }
    }
  });

  it("records the same meaningful-update decision", () => {
    for (const requested of [true, false, undefined, null, "yes", 1]) {
      const options = { requested, at: INSTANTS[1], by: "uid" };
      expect(mirror.applyMeaningfulUpdate(options), String(requested)).toEqual(
        core.applyMeaningfulUpdate(options),
      );
    }
  });

  it("reads the same meaning out of every submitted editorial date", () => {
    for (const record of RECORDS) {
      for (const submitted of SUBMISSIONS) {
        const label = `${JSON.stringify(record)} <- ${String(submitted)}`;
        expect(mirror.resolveEditorialDateWrite(record, submitted), label).toEqual(
          core.resolveEditorialDateWrite(record, submitted),
        );
      }
    }
  });

  it("agrees on station midnight across both daylight-saving transitions", () => {
    for (const day of ["2026-03-08", "2026-11-01", "2026-01-15", "2026-07-04"]) {
      expect(mirror.stationDayStartInstant(day), day).toBe(
        core.editorialSortInstant({ editorialDateSource: "backdated", date: day }),
      );
    }
  });
});
