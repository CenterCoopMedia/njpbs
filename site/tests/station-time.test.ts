import { describe, expect, it } from "vitest";
import {
  instantToStationLocal,
  stationLocalToInstant,
  STATION_TIME_ZONE,
  zonedLocalInstants,
} from "../../packages/content-core/src/station-time";
import { parsePublishInstant } from "../../packages/content-core/src/publish-instant";

// The two ends this module connects. Anything the editor writes has to survive the
// publish gate's reader, so that reader is the assertion here rather than a regex of
// our own that could agree with a bug.
function storedInstantIsReadable(value: string): boolean {
  return parsePublishInstant(value) !== null;
}

describe("shared wall-clock candidates", () => {
  const instants = (date: string, time: string, zone = STATION_TIME_ZONE) =>
    zonedLocalInstants(date, time, zone).map((instant) => new Date(instant).toISOString());

  it("returns one unique instant on an ordinary date", () => {
    expect(instants("2026-07-10", "1600")).toEqual(["2026-07-10T20:00:00.000Z"]);
  });

  it("leaves a skipped hour empty and both repeated-hour choices in order", () => {
    expect(instants("2026-03-08", "0230")).toEqual([]);
    expect(instants("2026-11-01", "0130")).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
  });

  it("uses the zone data for a half-hour transition", () => {
    expect(instants("2026-10-04", "0215", "Australia/Lord_Howe")).toEqual([]);
    expect(instants("2026-04-05", "0145", "Australia/Lord_Howe")).toEqual([
      "2026-04-04T14:45:00.000Z",
      "2026-04-04T15:15:00.000Z",
    ]);
  });
});

describe("station time round trip", () => {
  it("shows a stored instant as New Jersey wall time during daylight saving", () => {
    expect(instantToStationLocal("2026-07-10T20:00:00.000Z")).toBe("2026-07-10T16:00");
  });

  it("shows a stored instant as New Jersey wall time in standard time", () => {
    expect(instantToStationLocal("2026-01-10T20:00:00.000Z")).toBe("2026-01-10T15:00");
  });

  it("returns an instant the publish gate accepts", () => {
    const stored = stationLocalToInstant("2026-07-10T16:00");
    expect(stored).toBe("2026-07-10T20:00:00.000Z");
    expect(storedInstantIsReadable(stored as string)).toBe(true);
  });

  it("carries an editor's pick back to the same instant, in both halves of the year", () => {
    for (const local of ["2026-07-10T16:00", "2026-01-10T15:00", "2026-12-31T23:59"]) {
      const stored = stationLocalToInstant(local);
      expect(stored).not.toBeNull();
      expect(instantToStationLocal(stored as string)).toBe(local);
    }
  });

  it("resolves the autumn hour that happens twice to its first occurrence", () => {
    // 2026-11-01, 01:30 in New Jersey is both 05:30Z (still EDT) and 06:30Z (EST).
    // A person writing 1:30 that morning means the first one.
    expect(stationLocalToInstant("2026-11-01T01:30")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("carries the spring hour that never happens forward by the gap", () => {
    // 2026-03-08, 02:30 does not exist: the clock jumps 02:00 to 03:00. Refusing it
    // would leave an editor with a field that silently will not take their input, so
    // it becomes 03:30 EDT and re-renders that way.
    const stored = stationLocalToInstant("2026-03-08T02:30");
    expect(stored).toBe("2026-03-08T07:30:00.000Z");
    expect(instantToStationLocal(stored as string)).toBe("2026-03-08T03:30");
  });

  it("refuses a day the calendar does not have instead of rolling it forward", () => {
    expect(stationLocalToInstant("2026-02-30T10:00")).toBeNull();
    expect(stationLocalToInstant("2026-13-01T10:00")).toBeNull();
  });

  it("refuses a year that is still being typed", () => {
    // The control fills the year a digit at a time. 0002 is caught by the round trip
    // (Date.UTC reads a two-digit year as 19xx), but 0202 is a date Date.UTC accepts
    // as written, so without the floor an editor storing 2026 passes through the year
    // 202 on the way.
    for (const partial of ["0002-07-10T16:00", "0020-07-10T16:00", "0202-07-10T16:00"]) {
      expect(stationLocalToInstant(partial)).toBeNull();
    }
    expect(stationLocalToInstant("2026-07-10T16:00")).toBe("2026-07-10T20:00:00.000Z");
  });

  it("refuses a value that is not a local date and time", () => {
    for (const bad of ["", "2026-07-10", "2026-07-10T16:00:00Z", "tomorrow", "16:00"]) {
      expect(stationLocalToInstant(bad)).toBeNull();
    }
  });

  it("shows an empty control for a blank or unreadable stored value", () => {
    for (const bad of ["", "   ", "not a date", "2026-13-45T10:00:00Z"]) {
      expect(instantToStationLocal(bad)).toBe("");
    }
    expect(instantToStationLocal(undefined)).toBe("");
    expect(instantToStationLocal(null)).toBe("");
    expect(instantToStationLocal(1_752_177_600_000)).toBe("");
  });

  it("shows what a legacy publishAt really holds, which is the evening before", () => {
    // The old date control's YYYY-MM-DD never reached storage: normalizePublishAt in
    // functions/lib/content-metadata.js canonicalized it to midnight UTC first. So the
    // damage was never an unreadable field, it was the record quietly moving to 8 PM
    // the previous evening in station time, and that is what an editor must now see.
    const canonicalizedByTheServer = "2026-07-24T00:00:00.000Z";
    expect(storedInstantIsReadable(canonicalizedByTheServer)).toBe(true);
    expect(instantToStationLocal(canonicalizedByTheServer)).toBe("2026-07-23T20:00");
  });

  it("shows nothing for a stored value the publish gate cannot read", () => {
    // startsAt and endsAt have no server normalizer, so a legacy event really can hold
    // a bare day. `new Date` would read it as UTC midnight and state a wrong day
    // confidently enough to be corrected into a real schedule.
    const leftByAnEventEdit = "2026-08-01";
    expect(new Date(leftByAnEventEdit).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(storedInstantIsReadable(leftByAnEventEdit)).toBe(false);
    expect(instantToStationLocal(leftByAnEventEdit)).toBe("");

    // Same rule for a zoned instant. It names a real moment, but the gate refuses it,
    // so the record is not publishing either way and the editor is told so.
    const withAnOffset = "2026-07-24T23:30:00-04:00";
    expect(storedInstantIsReadable(withAnOffset)).toBe(false);
    expect(instantToStationLocal(withAnOffset)).toBe("");
  });

  it("drops seconds, because the control has none to show", () => {
    const local = instantToStationLocal("2026-07-10T20:00:30.000Z");
    expect(local).toBe("2026-07-10T16:00");
    expect(stationLocalToInstant(local)).toBe("2026-07-10T20:00:00.000Z");
  });

  it("reads the same in a session running outside the station's zone", () => {
    // The failure this rules out: relying on the browser's own reading of a bare
    // wall-clock time, which is the machine's zone and is right only in New Jersey.
    expect(instantToStationLocal("2026-07-10T20:00:00.000Z", "Europe/Berlin")).toBe(
      "2026-07-10T22:00",
    );
    expect(stationLocalToInstant("2026-07-10T22:00", "Europe/Berlin")).toBe(
      "2026-07-10T20:00:00.000Z",
    );
    expect(STATION_TIME_ZONE).toBe("America/New_York");
  });
});
