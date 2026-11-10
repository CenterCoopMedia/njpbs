import { describe, expect, it } from "vitest";

import scheduleData from "../src/data/schedule-fixture.json";
import type { BakedScheduleData } from "../src/lib/schedule-feed";
import { getScheduleClockState } from "../src/lib/schedule-view";
import {
  createScheduleSourceSnapshot,
  readScheduleSourceSnapshot,
  type ScheduleSourceSnapshot,
} from "../src/lib/schedule-source-snapshot";

const data = scheduleData as BakedScheduleData;
const publication = {
  schemaVersion: 1 as const,
  buildBatchId: "cms-AbCdEfGhIjKlMnOpQrSt",
  generation: 62,
  commitSha: "fad5533bfaaafae7de2beb57294a0b43fc4ce671",
  artifactDigest: "not-part-of-the-schedule-source-contract",
};

function verifiedSnapshot(): ScheduleSourceSnapshot {
  return createScheduleSourceSnapshot(data, publication);
}

interface MutableSnapshot {
  schemaVersion: number;
  timeZone: string;
  days: Array<{
    date: string;
    callsign: string;
    entries: Array<{
      title: string;
      startsAt: string;
      endsAt: string;
      episodeTitle?: string;
    }>;
  }>;
}

function mutableSnapshot(): MutableSnapshot {
  return structuredClone(verifiedSnapshot()) as unknown as MutableSnapshot;
}

function comparableClockState(
  state: ReturnType<typeof getScheduleClockState>,
) {
  const program = (entry: NonNullable<typeof state>["onNow"]) =>
    entry && {
      title: entry.title,
      episodeTitle: entry.episodeTitle,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
    };
  return state && {
    date: state.date,
    onNow: program(state.onNow),
    upNext: program(state.upNext),
    elapsedMinutes: state.elapsedMinutes,
    remainingMinutes: state.remainingMinutes,
    progressPercent: state.progressPercent,
  };
}

describe("schedule source snapshot", () => {
  it("projects only the committed schedule fields used by now and next", () => {
    const snapshot = verifiedSnapshot();

    expect(snapshot).toEqual({
      schemaVersion: 1,
      publication: {
        buildBatchId: publication.buildBatchId,
        generation: publication.generation,
        commitSha: publication.commitSha,
      },
      source: data.source,
      checkedAt: data.generatedAt,
      timeZone: data.timeZone,
      days: data.days.broadcast.map((day) => ({
        date: day.date,
        callsign: day.callsign,
        entries: day.entries.map((entry) => ({
          title: entry.title,
          startsAt: entry.startsAt,
          endsAt: entry.endsAt,
          ...(entry.episodeTitle === undefined
            ? {}
            : { episodeTitle: entry.episodeTitle }),
        })),
      })),
    });
    expect(snapshot).not.toHaveProperty("request");
    expect(snapshot.days[0]).not.toHaveProperty("feedCid");
    expect(snapshot.days[0].entries[0]).not.toHaveProperty("description");
  });

  it("does not accept an ordinary-build snapshot without a publication receipt", () => {
    const snapshot = createScheduleSourceSnapshot(data, null);

    expect(snapshot.publication).toBeNull();
    expect(() => readScheduleSourceSnapshot(snapshot, publication)).toThrow();
  });

  it("accepts a snapshot bound to the matching publication receipt", () => {
    const snapshot = verifiedSnapshot();

    expect(readScheduleSourceSnapshot(snapshot, publication)).toEqual(snapshot);
  });

  it("rejects schema and publication identity mismatches", () => {
    const snapshot = verifiedSnapshot();
    const mismatches: Array<[string, unknown, unknown]> = [
      ["snapshot schema", { ...snapshot, schemaVersion: 2 }, publication],
      ["publication schema", snapshot, { ...publication, schemaVersion: 2 }],
      ["build batch", snapshot, { ...publication, buildBatchId: "cms-OtherBatch123456789" }],
      ["generation", snapshot, { ...publication, generation: publication.generation + 1 }],
      ["commit", snapshot, { ...publication, commitSha: "b".repeat(40) }],
    ];

    for (const [name, value, receipt] of mismatches) {
      expect(
        () => readScheduleSourceSnapshot(value, receipt),
        name,
      ).toThrow(/receipts do not match/);
    }
  });

  it("rejects invalid schedule identity, dates, times and intervals", () => {
    const cases: Array<[string, (value: MutableSnapshot) => void]> = [
      ["duplicate dates", (value) => {
        value.days[1].date = value.days[0].date;
      }],
      ["wrong station", (value) => {
        value.days[0].callsign = "other";
      }],
      ["wrong time zone", (value) => {
        value.timeZone = "UTC";
      }],
      ["malformed start time", (value) => {
        value.days[0].entries[0].startsAt = "not-an-instant";
      }],
      ["nonpositive interval", (value) => {
        value.days[0].entries[0].endsAt = value.days[0].entries[0].startsAt;
      }],
    ];

    for (const [name, mutate] of cases) {
      const value = mutableSnapshot();
      mutate(value);
      expect(
        () => readScheduleSourceSnapshot(value, publication),
        name,
      ).toThrow();
    }
  });

  it("accepts an empty source as unavailable without inventing listings", () => {
    const emptyData = {
      ...data,
      days: { ...data.days, broadcast: [] },
    } as BakedScheduleData;
    const snapshot = createScheduleSourceSnapshot(emptyData, publication);
    const verified = readScheduleSourceSnapshot(snapshot, publication);

    expect(verified.days).toEqual([]);
    expect(
      getScheduleClockState(
        verified.days,
        new Date(data.days.broadcast[0].entries[0].startsAt),
      ),
    ).toBeNull();
  });

  it("keeps now and next output equal across program and day boundaries", () => {
    const snapshot = verifiedSnapshot();
    const firstDay = data.days.broadcast[0];
    const secondDay = data.days.broadcast[1];
    const firstEntry = firstDay.entries[0];
    const lastEntry = firstDay.entries[firstDay.entries.length - 1];
    const instants = [
      new Date((Date.parse(firstEntry.startsAt) + Date.parse(firstEntry.endsAt)) / 2),
      new Date(firstEntry.endsAt),
      new Date(Date.parse(lastEntry.endsAt) - 1),
      new Date(secondDay.entries[0].startsAt),
    ];

    for (const instant of instants) {
      expect(
        comparableClockState(getScheduleClockState(snapshot.days, instant)),
      ).toEqual(
        comparableClockState(getScheduleClockState(data.days.broadcast, instant)),
      );
    }
  });
});
