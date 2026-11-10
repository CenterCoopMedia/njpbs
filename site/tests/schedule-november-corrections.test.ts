// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyScheduleCorrections, uncorrectedScheduleDates } from "../src/lib/schedule-corrections";
import { loadScheduleData } from "../src/lib/schedule-data";
import type { BakedScheduleData, ScheduleListing } from "../src/lib/schedule-feed";
import { buildScheduleExport } from "../src/lib/schedule-export";
import { main } from "../scripts/sync-schedule.mjs";

afterEach(() => vi.restoreAllMocks());

// November 2 intervals and titles from the October 26 captured PBS schedule.
function feed(date = "2026-11-02"): BakedScheduleData {
  const listing = (title: string, start: string, end: string): ScheduleListing => ({
    title, startsAt: `${date}T${start}:00-05:00`, endsAt: `${date}T${end}:00-05:00`,
    description: "Interviews with notable people in New Jersey.",
    episodeTitle: "Old episode", episodeDescription: "Old synopsis",
    seasonNumber: null, episodeNumber: null, nolaRoot: "OONJ",
    programId: 4569, programExternalId: "SH006930630000", cid: null,
    isKids: false, kids: false, feedKind: "broadcast",
  });
  const day = {
    date, callsign: "wnjt", kind: "broadcast" as const, feedCid: "fixture-wnjt",
    timeZone: "America/New_York" as const, sourceCheckedAt: "2026-10-26T18:30:31.300Z",
    entries: [
      listing("One on One With Steve Adubato", "04:30", "05:00"),
      listing("State of the Arts", "05:30", "06:00"),
      listing("One on One With Steve Adubato", "19:00", "19:30"),
    ],
  };
  return {
    source: "pbs-tvss", generatedAt: "2026-11-02T12:00:00Z", timeZone: "America/New_York",
    request: { station: "WNJT", dates: [date] },
    days: { broadcast: [day], kids: [{ ...day, kind: "kids", entries: day.entries.map((entry) => ({ ...entry, feedKind: "kids" })) }] },
  };
}

function oneOnOne(data: BakedScheduleData, date: string) {
  return data.days.broadcast.find((day) => day.date === date)!.entries
    .filter((entry) => entry.title === "One on One With Steve Adubato");
}

describe("November One-on-One episode corrections", () => {
  it("keeps approved episode details on the workbook airings in both views", async () => {
    const input = feed();
    const result = await loadScheduleData(input, {});
    expect(result.source).toBe("pbs-tvss-with-njpbs-corrections");
    expect(result.request.dates).toHaveLength(30);
    for (const kind of ["broadcast", "kids"] as const) {
      const day = result.days[kind].find((day) => day.date === "2026-11-02")!;
      expect(day.sourceRevision).toBe("2026-11-02");
      expect(day.sourceCheckedAt).toBeUndefined();
      const airings = day.entries.filter((entry) => entry.title === "One on One With Steve Adubato");
      expect(airings.map((entry) => entry.startsAt.slice(11, 16))).toEqual(["05:30", "19:00", "23:30"]);
      for (const airing of airings) {
        expect(airing).toMatchObject({
          episodeNumber: 2950,
          episodeTitle: "Jessica Jenkins; Bryan Felt; Emmie Bleznick",
          episodeDescription: expect.stringContaining("Senior Correspondent Jacqui Tricarico speaks with Jessica Jenkins"),
        });
      }
    }
    expect(input.days.broadcast[0].entries[0].episodeTitle).toBe("Old episode");
    expect(applyScheduleCorrections(result)).toEqual(result);
  });

  it.each([
    ["2026-11-03", 2826, "Remembering NJ Political Figures"],
    ["2026-11-08", 2976, "Alfa M. Demmellash; Raeshem Nijhon"],
    ["2026-11-12", 2934, "Making a Difference: Environmental Justice and Sustainability"],
    ["2026-11-15", 2979, "Chris Brancato; Allan Wylie"],
    ["2026-11-26", 2954, "Celebrating 30 Years of the Russ Berrie Making A Difference Award"],
    ["2026-11-29", 2981, "Lisa Marie Falbo; Jocelyn Carley"],
  ])("uses the approved source decision for %s", (date, episodeNumber, episodeTitle) => {
    expect(oneOnOne(applyScheduleCorrections(feed(String(date))), String(date))[0])
      .toMatchObject({ episodeNumber, episodeTitle });
  });

  it("keeps PBS metadata retrieval and restores missing airings from the workbook", () => {
    expect(uncorrectedScheduleDates(["2026-10-31", "2026-11-01", "2026-11-30"]))
      .toEqual(["2026-11-01", "2026-11-30"]);
    const input = feed();
    const day = { ...input.days.broadcast[0], entries: [input.days.broadcast[0].entries[1]] };
    const noAirings = { ...input, days: { broadcast: [day], kids: [] } };
    expect(oneOnOne(applyScheduleCorrections(noAirings), "2026-11-02")).toHaveLength(3);
    expect(applyScheduleCorrections(feed("2026-12-01")).days.broadcast[0].sourceRevision).toBe("2026-11-09");
  });

  it("exports approved episode details with workbook times and revision evidence", () => {
    const result = buildScheduleExport(applyScheduleCorrections(feed()), new Date("2026-11-02T13:00:00Z"));
    expect(result.days[0].entries.find((entry) => entry.title === "One on One With Steve Adubato")).toMatchObject({
      episodeTitle: "Jessica Jenkins; Bryan Felt; Emmie Bleznick",
      startsAt: "2026-11-02T05:30:00-05:00", endsAt: "2026-11-02T06:00:00-05:00",
    });
    expect(result.sourceRevisionDates).toEqual(["2026-11-02"]);
    expect(result.correctedDayCount).toBe(14);
    expect(result.pbsCheckedDayCount).toBe(0);
    expect(result.missingDates).toHaveLength(0);
  });

  it("keeps the original DOCX separators between description segments", () => {
    const description = (date: string) => oneOnOne(applyScheduleCorrections(feed(date)), date)[0].episodeDescription;
    expect(description("2026-11-01")).toContain("New Jersey. Cost n’ Mayor");
    expect(description("2026-11-09")).toContain("New Jersey Globe Milton Allimadi");
    expect(description("2026-11-12")).toContain("Panelists Include: Jose German-Gomez");
    expect(description("2026-11-12")).toContain("Northeast Earth Coalition Kim Gaddy");
  });
  // Expected values are copied from Brent's source packet, not the correction output.
  const laterEpisodes = [
    ["2026-11-09", 2923, "Remembering NJ Journalists"],
    ["2026-11-10", 2972, "Sylvester P. Lukasiewicz; Debi Weiss & Charles Farber, MD, PhD; Bond Benton, PhD"],
    ["2026-11-11", 2864, "Caring for Our Veterans"],
    ["2026-11-12", 2934, "Making a Difference: Environmental Justice and Sustainability"],
    ["2026-11-13", 2940, "Howard Reid and Bridget Nkatta, DNP; Angelica Berrie; Jess Rauchberg, PhD"],
    ["2026-11-14", 2979, "Chris Brancato; Allan Wylie"],
    ["2026-11-15", 2979, "Chris Brancato; Allan Wylie"],
    ["2026-11-16", 2963, "Ryan DePersio; Holly Moscatiello"],
    ["2026-11-17", 2956, "Eddie S. Glaude Jr., PhD"],
    ["2026-11-18", 2974, "Balpreet Grewal-Virk, PhD; John Schreiber; Franco Miyashiro"],
    ["2026-11-19", 2927, "Remembering Elston Howard and Pete Carril"],
    ["2026-11-20", 2958, "Darryl McDaniels"],
    ["2026-11-21", 2975, "Anjanette Christy; Nicole McGrath-Barnes, DDS; Mariekarl Vilceus-Talty"],
    ["2026-11-22", 2975, "Anjanette Christy; Nicole McGrath-Barnes, DDS; Mariekarl Vilceus-Talty"],
    ["2026-11-23", 2959, "Jeremy Jordan; Cost n’ Mayor"],
    ["2026-11-24", 2970, "Samuel Kim; Katharine Clouser, MD, MBA; Michele Russo"],
    ["2026-11-25", 2952, "Vanrick Vandenburg; Scott J. Mariani and Peter Hartney; Jacqueline Foley"],
    ["2026-11-26", 2954, "Celebrating 30 Years of the Russ Berrie Making A Difference Award"],
    ["2026-11-27", 2855, "Remembering Pat Nixon"],
    ["2026-11-28", 2981, "Lisa Marie Falbo; Jocelyn Carley"],
    ["2026-11-29", 2981, "Lisa Marie Falbo; Jocelyn Carley"],
    ["2026-11-30", 2953, "2026 New Jersey Sharing Network Celebration of Life"],
  ] as const;

  it.each(["2026-11-09", "2026-11-17"])("corrects a later bake from %s and preserves outage fallback", async (start) => {
    const directory = await mkdtemp(path.join(tmpdir(), "november-schedule-"));
    const outputPath = path.join(directory, "schedule.json");
    const now = new Date(`${start}T12:00:00Z`);
    const upstream = `cb(${JSON.stringify({ headends: [{ name: "Broadcast", feeds: [{
      cid: "4211290e-ce30-49e5-9be1-2c412c5b3278",
      listings: [{ title: "One on One With Steve Adubato", start_time: "0430", duration: 30, kids: false }],
    }] }] })})`;
    const fetchFeed = vi.fn(async () => new Response(upstream));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await main({ SCHEDULE_OUTPUT: outputPath }, fetchFeed, now);
      if (!("days" in result)) throw new Error("Expected a fresh later November bake");
      expect(fetchFeed).toHaveBeenCalledTimes(28);
      expect(result.source).toBe("pbs-tvss-with-njpbs-corrections");
      expect(result.request.dates).toHaveLength(30);
      for (const kind of ["broadcast", "kids"] as const) {
        for (const day of result.days[kind].filter((day) => day.date >= start && day.date <= "2026-11-30")) {
          const expected = laterEpisodes.find(([date]) => date === day.date)!;
          const airings = day.entries.filter((entry) => entry.title === "One on One With Steve Adubato");
          const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
          expect(airings).toHaveLength(weekday === 0 || weekday === 6 ? 1 : 3);
          for (const airing of airings) {
            expect(airing).toMatchObject({
              episodeNumber: expected[1], episodeTitle: expected[2],
              episodeDescription: expect.any(String),
            });
          }
        }
      }
      const saved = await readFile(outputPath, "utf8");
      const outage = async () => { throw new Error("ECONNRESET"); };
      await expect(main({ SCHEDULE_OUTPUT: outputPath }, outage, now)).resolves.toEqual({ reusedCommittedData: true });
      await expect(main({ SCHEDULE_OUTPUT: outputPath, REQUIRE_FRESH_CONTENT: "1" }, outage, now))
        .rejects.toThrow("scheduled refresh requires fresh schedule data");
      expect(await readFile(outputPath, "utf8")).toBe(saved);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});
