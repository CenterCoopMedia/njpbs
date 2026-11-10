// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import workbook from "../src/data/schedule-corrections-2026-10.json";
import octoberSource from "./fixtures/schedule-corrections-2026-10-source.json";
import { applyScheduleCorrections, uncorrectedScheduleDates } from "../src/lib/schedule-corrections";
import type { BakedScheduleData, ScheduleFeedDay } from "../src/lib/schedule-feed";
import { loadScheduleData } from "../src/lib/schedule-data";
import { createScheduleSourceSnapshot, readScheduleSourceSnapshot } from "../src/lib/schedule-source-snapshot";
import { getScheduleClockState } from "../src/lib/schedule-view";
import { getEtBroadcastDates, main } from "../scripts/sync-schedule.mjs";
import { checkScheduleRefresh } from "../scripts/check-schedule-refresh.mjs";

// Fixed PBS input from bf5a92bbeb5e4c13d737ba0c9aac4de30c332fb7, before corrections:
// the matching Westward Bound episode and the news slot that swallowed Media Matters.
// The rolling schedule.json is allowed to move beyond October.
const data = octoberSource as BakedScheduleData;
const publication = { schemaVersion: 1, generation: 190, buildBatchId: "cms-october", commitSha: "a".repeat(40) };

function rawWindow(now: string): BakedScheduleData {
  const dates = getEtBroadcastDates(new Date(now));
  const days = dates.map((date: string) => ({
    ...data.days.broadcast[0], date,
    entries: [{ ...data.days.broadcast[0].entries[0], title: "PBS program",
      startsAt: `${date}T00:00:00-04:00`, endsAt: `${date}T01:00:00-04:00` }],
  }));
  return { ...data, source: "pbs-tvss", request: { station: "WNJT", dates },
    days: { broadcast: days, kids: days.map((day: ScheduleFeedDay) => ({ ...day, kind: "kids" })) } };
}

describe("approved October schedule", () => {
  it("preserves the workbook provenance, all 31 days and eight unresolved transitions", () => {
    expect(workbook.source.sha256).toBe("f85fd189a0fb713b57331b5aa30875d4a2ca84cda86e9723a94580c3d2d9e52d");
    expect(workbook.days).toHaveLength(31);
    expect(workbook.days.flatMap((day) => day.entries)).toHaveLength(1140);
    expect(workbook.unresolved).toHaveLength(8);
    expect(workbook.days.flatMap((day) => day.entries).filter((entry) => entry.startTime === null)).toHaveLength(8);
  });

  it("covers every October day once without gaps, overlaps or guessed transitions", () => {
    const corrected = applyScheduleCorrections(data);
    expect(corrected.source).toBe("pbs-tvss-with-njpbs-corrections");
    expect(corrected.days.broadcast).toHaveLength(31);
    expect(corrected.days.broadcast.flatMap((day) => day.entries)).toHaveLength(1132);
    for (const day of corrected.days.broadcast) {
      expect(day.entries[0].startsAt).toBe(`${day.date}T00:00:00-04:00`);
      let end = Date.parse(day.entries[0].startsAt);
      for (const entry of day.entries) {
        expect(Date.parse(entry.startsAt), `${day.date}: ${entry.title}`).toBe(end);
        expect(Date.parse(entry.endsAt)).toBeGreaterThan(end);
        end = Date.parse(entry.endsAt);
      }
      expect(end - Date.parse(day.entries[0].startsAt)).toBe(86_400_000);
    }
    const oct29 = corrected.days.broadcast.find((day) => day.date === "2026-10-29")!;
    expect(oct29.entries.find((entry) => entry.title.includes("Timing to be confirmed"))).toMatchObject({
      title: "Downton Abbey on Masterpiece / Miss Scarlet and the Duke on Masterpiece: Timing to be confirmed",
      startsAt: "2026-10-29T13:30:00-04:00", endsAt: "2026-10-29T16:00:00-04:00",
      cid: null, programId: null, episodeNumber: null, isKids: false,
      description: expect.stringContaining("exact changeover time is awaiting confirmation"),
    });
  });

  it("uses the three verified PBS transitions and all five explicit workbook start notes", () => {
    const corrected = applyScheduleCorrections(data);
    for (const [date, title, time] of [
      ["2026-10-02", "Sister Boniface Mysteries", "22:14"],
      ["2026-10-05", "Sister Boniface Mysteries", "14:14"],
      ["2026-10-09", "Sister Boniface Mysteries", "22:15"],
      ["2026-10-26", "Live From the LBJ Library With Mark Updegrove", "22:35"],
      ["2026-10-27", "Lucy Worsley Investigates: The American Revolution", "02:05"],
      ["2026-10-27", "Bergerac", "22:10"],
      ["2026-10-28", "Bergerac", "01:40"],
      ["2026-10-28", "Lucy Worsley Investigates: The American Revolution", "15:35"],
    ]) {
      expect(corrected.days.broadcast.find((day) => day.date === date)?.entries).toContainEqual(
        expect.objectContaining({ title, startsAt: `${date}T${time}:00-04:00` }),
      );
    }
  });

  it("replaces the swallowed Media Matters slot without carrying news metadata", () => {
    const corrected = applyScheduleCorrections(data);
    const day = corrected.days.broadcast.find((day) => day.date === "2026-10-02")!;
    expect(day.entries.find((entry) => entry.startsAt.includes("T20:00:"))).toMatchObject({
      title: "Steve Adubato's Media Matters", endsAt: "2026-10-02T20:30:00-04:00",
      cid: null, programId: null, nolaRoot: null, episodeNumber: null,
    });
    expect(day.entries.find((entry) => entry.startsAt.includes("T20:00:"))).not.toHaveProperty("description");
    expect(getScheduleClockState(corrected.days.broadcast, new Date("2026-10-02T20:10:00-04:00"))?.onNow?.title)
      .toBe("Steve Adubato's Media Matters");
  });

  it("keeps matching episode metadata and rejects details for a different episode", () => {
    const input = structuredClone(data);
    const day = input.days.broadcast.find((day) => day.date === "2026-10-02")!;
    const matching = day.entries.find((entry) => entry.title.startsWith("Finding Your Roots"))!;
    const expectedDescription = matching.description;
    expect(expectedDescription).toBeTruthy();
    const corrected = applyScheduleCorrections(input).days.broadcast.find((item) => item.date === day.date)!;
    expect(corrected.entries.find((entry) => entry.title === matching.title)?.description).toBe(expectedDescription);
    const wrong = {
      ...matching,
      episodeTitle: "A different episode",
      episodeDescription: "Wrong episode metadata",
    };
    const replaced = { ...input, days: { ...input.days, broadcast: [{ ...day, entries: [wrong] }] } };
    const replacement = applyScheduleCorrections(replaced).days.broadcast
      .find((item) => item.date === day.date)?.entries
      .find((entry) => entry.title === matching.title);
    expect(replacement?.description).toBe(expectedDescription);
    expect(replacement).not.toHaveProperty("episodeDescription");
    expect(replacement?.programId).toBeNull();
  });

  it("keeps one consistent series description across corrected airings", () => {
    const source = data.days.broadcast[0].entries.find((entry) =>
      entry.title === "Finding Your Roots With Henry Louis Gates, Jr."
    )!;
    const futureDay = {
      ...data.days.broadcast[0],
      date: "2026-11-02",
      entries: [{
        ...source,
        episodeTitle: "A different episode",
        episodeDescription: "This belongs only to the different episode.",
        startsAt: "2026-11-02T00:00:00-05:00",
        endsAt: "2026-11-02T01:00:00-05:00",
      }],
    };
    const input = {
      ...data,
      request: { ...data.request, dates: [...data.request.dates, futureDay.date] },
      days: { ...data.days, broadcast: [...data.days.broadcast, futureDay] },
    };

    const corrected = applyScheduleCorrections(input);
    const airing = corrected.days.broadcast.find((day) => day.date === "2026-10-23")!
      .entries.find((entry) => entry.title === source.title)!;
    expect(airing.description).toBe(source.description);
    expect(airing).not.toHaveProperty("episodeDescription");
    expect(airing.programId).toBeNull();

    const conflictDay = {
      ...futureDay,
      date: "2026-11-03",
      entries: [{
        ...futureDay.entries[0],
        description: "A conflicting series description.",
        startsAt: "2026-11-03T00:00:00-05:00",
        endsAt: "2026-11-03T01:00:00-05:00",
      }],
    };
    const conflicting = applyScheduleCorrections({
      ...input,
      request: { ...input.request, dates: [...input.request.dates, conflictDay.date] },
      days: { ...input.days, broadcast: [...input.days.broadcast, conflictDay] },
    });
    expect(conflicting.days.broadcast.find((day) => day.date === "2026-10-23")!
      .entries.find((entry) => entry.title === source.title)).not.toHaveProperty("description");
  });

  it("keeps the kids view on the same corrected channel timeline", () => {
    const corrected = applyScheduleCorrections(data);
    for (const [index, day] of corrected.days.broadcast.entries()) {
      expect(corrected.days.kids[index].entries).toEqual(day.entries.map((entry) => ({ ...entry, feedKind: "kids" })));
    }
    const oct20 = corrected.days.kids.find((day) => day.date === "2026-10-20")!;
    expect(oct20.entries.find((entry) => entry.startsAt.includes("T09:00:"))).toMatchObject({ title: "Nature", isKids: true });
    expect(oct20.entries.filter((entry) => entry.title.includes("Timing to be confirmed")).every((entry) => !entry.isKids)).toBe(true);
  });

  it("is idempotent, includes 44 dates on October 31, and expires on November 1", () => {
    const october31 = rawWindow("2026-10-31T12:00:00Z");
    const corrected = applyScheduleCorrections(october31);
    expect(corrected.request.dates).toHaveLength(44);
    expect(corrected.request.dates.at(-1)).toBe("2026-11-13");
    expect(corrected.days.broadcast.at(-1)).toBe(october31.days.broadcast.at(-1));
    expect(applyScheduleCorrections(corrected)).toEqual(corrected);
    const november = rawWindow("2026-11-01T12:00:00Z");
    expect(applyScheduleCorrections(november)).toBe(november);
    expect(november.request.dates).toHaveLength(14);
    expect(november.source).toBe("pbs-tvss");
    expect(uncorrectedScheduleDates(["2025-10-02", "2026-10-02", "2026-11-01"])).toEqual(["2025-10-02", "2026-11-01"]);
  });

  it("exposes truthful source identity to the updated Admin contract and keeps a bounded date union", () => {
    const corrected = applyScheduleCorrections(rawWindow("2026-10-31T12:00:00Z"));
    const snapshot = createScheduleSourceSnapshot(corrected, publication);
    expect(readScheduleSourceSnapshot(snapshot, publication)).toEqual(snapshot);
    expect(snapshot.source).toBe("pbs-tvss-with-njpbs-corrections");
    expect(readScheduleSourceSnapshot({ ...snapshot,
      days: [...snapshot.days, { date: "2026-11-14", callsign: "wnjt", entries: [] }],
    }, publication).days).toHaveLength(45);
    const tooMany = { ...snapshot, days: [...snapshot.days, { ...snapshot.days[0], date: "2026-11-14" }, { ...snapshot.days[0], date: "2026-11-15" }] };
    expect(() => readScheduleSourceSnapshot(tooMany, publication)).toThrow("list is invalid");
  });

  it("applies the correction to the committed loader and the publisher sync without PBS calls for October", async () => {
    expect(await loadScheduleData(data, {})).toEqual(applyScheduleCorrections(data));
    const fetchImpl = vi.fn(() => { throw new Error("October must use the approved source"); });
    const write = vi.fn();
    const output = await main({ SCHEDULE_OUTPUT: "/tmp/nonexistent-october-test-output" }, fetchImpl,
      new Date("2026-10-02T16:00:00Z"), write);
    if (!("days" in output)) throw new Error("Expected a fresh October schedule.");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(output.days.broadcast).toHaveLength(31);
    expect(output.source).toBe("pbs-tvss-with-njpbs-corrections");
  });

  it("does not repeatedly refresh because the raw PBS feed conflicts with the approved workbook", async () => {
    const corrected = applyScheduleCorrections({ ...data, days: { broadcast: [], kids: [] } });
    const snapshot = createScheduleSourceSnapshot(corrected, publication);
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return Response.json(url.pathname === "/_publication.json" ? publication : snapshot);
    });
    await expect(checkScheduleRefresh(fetchImpl, new Date("2026-10-02T16:00:00Z"))).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    snapshot.days[1] = { ...snapshot.days[1], entries: snapshot.days[1].entries.map((entry, index) =>
      index === 0 ? { ...entry, title: "Stale public title" } : entry) };
    await expect(checkScheduleRefresh(fetchImpl, new Date("2026-10-02T16:00:00Z"))).resolves.toBe(true);
  });

  it("continues PBS reads for November, detects November changes and expires the October source", async () => {
    const fixture = await readFile(new URL("./fixtures/tvss-wnjt-20260710.jsonp", import.meta.url), "utf8");
    const fetchFeed = vi.fn(async () => new Response(fixture));
    const october31 = new Date("2026-10-31T16:00:00Z");
    const output = await main({ SCHEDULE_OUTPUT: "/tmp/nonexistent-october-test-output" }, fetchFeed, october31, vi.fn());
    if (!("days" in output)) throw new Error("Expected a fresh October and November schedule.");
    expect(fetchFeed).toHaveBeenCalledTimes(26);
    expect(output.days.broadcast).toHaveLength(44);
    const snapshot = createScheduleSourceSnapshot(output, publication);
    const fetchRefresh = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return url.hostname === "jaws.pbs.org"
        ? new Response(fixture)
        : Response.json(url.pathname === "/_publication.json" ? publication : snapshot);
    });
    await expect(checkScheduleRefresh(fetchRefresh, october31)).resolves.toBe(false);
    expect(fetchRefresh).toHaveBeenCalledTimes(15);
    snapshot.days = snapshot.days.map((day) => day.date === "2026-11-01"
      ? { ...day, entries: day.entries.map((entry, index) => index === 0 ? { ...entry, title: "Stale November title" } : entry) }
      : day);
    await expect(checkScheduleRefresh(fetchRefresh, october31)).resolves.toBe(true);

    fetchFeed.mockClear();
    const november = await main({ SCHEDULE_OUTPUT: "/tmp/nonexistent-october-test-output" }, fetchFeed,
      new Date("2026-11-01T16:00:00Z"), vi.fn());
    if (!("days" in november)) throw new Error("Expected a fresh November schedule.");
    expect(fetchFeed).toHaveBeenCalledTimes(28);
    expect(november.source).toBe("pbs-tvss");
    expect(november.days.broadcast).toHaveLength(14);
    expect(november.request.dates[0]).toBe("2026-11-01");
  });
});
