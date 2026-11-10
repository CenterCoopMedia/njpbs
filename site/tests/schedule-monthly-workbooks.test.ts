// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import captured from "./fixtures/schedule-2026-11-15-pbs.json";
import november23 from "./fixtures/schedule-2026-11-23-pbs.json";
import november from "../src/data/schedule-corrections-2026-11.json";
import december from "../src/data/schedule-corrections-2026-12.json";
import { applyScheduleCorrections, sameScheduleProgram, scheduleEpisodeDiffers } from "../src/lib/schedule-corrections";
import type { BakedScheduleData } from "../src/lib/schedule-feed";
import { getEtBroadcastDates, main } from "../scripts/sync-schedule.mjs";

const input = captured as BakedScheduleData;
function windowAt(date: string): BakedScheduleData {
  return { ...input, request: { station: "WNJT", dates: getEtBroadcastDates(new Date(`${date}T12:00:00Z`)) },
    days: { broadcast: [], kids: [] } };
}

describe("approved November and December lineups", () => {
  it("replaces the confirmed November 15 error and retains matching PBS details", () => {
    const original = input.days.broadcast[0];
    const corrected = applyScheduleCorrections(input).days.broadcast.find((day) => day.date === "2026-11-15")!;
    const at = (time: string) => corrected.entries.find((entry) => entry.startsAt.includes(`T${time}:`))!;
    expect(original.entries.find((entry) => entry.startsAt.includes("T09:00:"))?.title).toBe("Inside the NJAC");
    expect(at("09:00")).toMatchObject({ title: "Live From the LBJ Library With Mark Updegrove",
      startsAt: "2026-11-15T09:00:00-05:00", endsAt: "2026-11-15T09:30:00-05:00", programId: null, cid: null });
    expect(at("09:00")).not.toHaveProperty("episodeDescription");
    expect(at("09:00")).not.toHaveProperty("description");
    const motorWeek = original.entries.find((entry) => entry.startsAt.includes("T06:00:"))!;
    expect(at("06:00")).toMatchObject({ episodeTitle: motorWeek.episodeTitle,
      episodeDescription: motorWeek.episodeDescription, description: motorWeek.description,
      programId: motorWeek.programId, cid: motorWeek.cid });
    expect(at("11:00")).toMatchObject({ episodeNumber: 2979, episodeTitle: "Chris Brancato; Allan Wylie" });
    const truncated = original.entries.find((entry) => entry.startsAt.includes("T16:00:"))!;
    expect(at("16:00")).toMatchObject({
      title: "Remember Them with Steve Adubato and Jacqui Tricarico",
      programId: truncated.programId,
    });
    expect(at("16:00").description).toBe(truncated.description);
    expect(at("16:00").episodeDescription).toBe(truncated.episodeDescription);
    expect(applyScheduleCorrections(applyScheduleCorrections(input))).toEqual(applyScheduleCorrections(input));
  });

  it("recognizes the observed title variants without merging different programs", () => {
    for (const [pbs, workbook] of [
      ["The Tuskegee Airmen: Return to Ramitelli", "Tuskegee Airmen: Return to Ramitelli"],
      ["Rick Steves' Europe: A Symphonic Journey", "Rick Steves' Europe"],
      ["Remember Them with Steve Adubato and Jacqui Tricar", "Remember Them with Steve Adubato and Jacqui Tricarico"],
    ]) expect(sameScheduleProgram(pbs, workbook)).toBe(true);
    expect(sameScheduleProgram("Inside the NJAC", "Live From the LBJ Library With Mark Updegrove")).toBe(false);
    expect(sameScheduleProgram("Nature Cat", "Nature")).toBe(false);
    const changed = { ...input, days: { ...input.days,
      broadcast: input.days.broadcast.map((day) => ({ ...day, entries: day.entries.map((entry) =>
        entry.startsAt.includes("T06:00:") ? { ...entry, title: "The MotorWeek" } : entry) })),
    } };
    expect(applyScheduleCorrections(changed).days.broadcast.find((day) => day.date === "2026-11-15")!
      .entries.find((entry) => entry.startsAt.includes("T06:00:"))?.title).toBe("The MotorWeek");
  });

  it("compares episode titles and keeps house numbers separate from PBS episode identities", () => {
    const before = input.days.broadcast[0].entries[0];
    expect(before).toMatchObject({ title: "The Caverns Sessions", seasonNumber: 5, episodeNumber: 1, episodeTitle: "Jeff Tweedy" });
    const after = applyScheduleCorrections(input).days.broadcast.find((day) => day.date === "2026-11-15")!.entries[0];
    expect(after).toMatchObject({ title: before.title, description: before.description, programId: before.programId,
      seasonNumber: 5, episodeNumber: 1, cid: before.cid, episodeTitle: before.episodeTitle,
      episodeDescription: before.episodeDescription });
    expect(scheduleEpisodeDiffers({ episodeTitle: "John McEuen and Wyatt Ellis" }, "JOHN MCEUEN AND WYATT ELLIS")).toBe(false);
    expect(scheduleEpisodeDiffers({ episodeTitle: "Jeff Tweedy" }, "JOHN MCEUEN AND WYATT ELLIS")).toBe(true);
    expect(scheduleEpisodeDiffers({ episodeTitle: "Jeff Tweedy" }, undefined)).toBe(false);
    for (const [pbs, workbook] of [
      ["Tiger Island Part II", "TIGER ISLAND PART 2"],
      ["Maigret's Revolver, Part One", "MAIGRET'S REVOLVER, Part 1"],
      ["Sebastián Yatra", "SEBASTIAN YATRA"],
      ["Tragedy Plus Time Equals Comedy", "TRAGEDY+TIME= COMEDY"],
      ["Man of the Year", "THE MAN OF THE YEAR"],
    ]) expect(scheduleEpisodeDiffers({ episodeTitle: pbs }, workbook)).toBe(false);
    const damaged = { ...input, days: { ...input.days, broadcast: input.days.broadcast.map((day) => ({
      ...day, entries: day.entries.map((entry) => entry.startsAt.includes("T02:00:")
        ? { ...entry, episodeTitle: before.episodeTitle, episodeDescription: before.episodeDescription } : entry),
    })) } };
    const repaired = applyScheduleCorrections(damaged).days.broadcast.find((day) => day.date === "2026-11-15")!
      .entries.find((entry) => entry.startsAt.includes("T02:00:"))!;
    expect(repaired).toMatchObject({ title: "Woodsongs", episodeTitle: "JOHN MCEUEN AND WYATT ELLIS",
      seasonNumber: null, episodeNumber: null, cid: null });
    expect(repaired).not.toHaveProperty("episodeDescription");
    expect(repaired).not.toHaveProperty("airingType");
    expect(applyScheduleCorrections(applyScheduleCorrections(damaged))).toEqual(applyScheduleCorrections(damaged));
  });

  it("keeps internal fill and feed notes out of public listings without losing part names", () => {
    const source = november23 as BakedScheduleData;
    const original = source.days.broadcast[0].entries[0];
    const corrected = applyScheduleCorrections(source);
    const airing = corrected.days.broadcast.find((day) => day.date === "2026-11-23")!.entries
      .find((entry) => entry.startsAt.includes("T20:30:"))!;
    expect(airing).toMatchObject({ title: "The American Revolution: Timing to be confirmed",
      endsAt: "2026-11-23T23:00:00-05:00", description: original.description,
      episodeTitle: original.episodeTitle, episodeDescription: original.episodeDescription, cid: original.cid });
    expect(applyScheduleCorrections(corrected)).toEqual(corrected);
    for (const date of ["2026-11-01", "2026-12-01"]) {
      const output = applyScheduleCorrections(windowAt(date));
      expect(output.days.broadcast.flatMap((day) => day.entries)
        .some((entry) => /\bFill\b|FED\. EAR\./.test(`${entry.title} ${entry.episodeTitle ?? ""} ${entry.description ?? ""}`))).toBe(false);
    }
    const entries = november.workbook.days.flatMap((day) => day.entries);
    expect(entries.find((entry) => entry.episodeCode === "5650")?.episodeTitle).toBe("MAIGRET'S REVOLVER, Part 1");
    expect(entries.find((entry) => entry.episodeCode === "5651")?.episodeTitle).toBe("MAIGRET'S REVOLVER, Part 2");
    expect(entries.find((entry) => entry.title === "Weathered: Earth's Extremes" && entry.episodeCode === "105")?.episodeTitle)
      .toBe("NOT BUSINESS AS USUAL");
  });

  it("covers each source day continuously, including the 25-hour November 1", () => {
    expect(november.workbook.source.sha256).toBe("838d4231219e840647d8018261e165149d965b042b7cbb5be293631efc1c3a89");
    expect(december.source.sha256).toBe("b79698acfe092fa9614167a6fcfff07e943f7b18eb9d31457c8dd0f49bbdf479");
    for (const [date, count] of [["2026-11-01", 30], ["2026-12-01", 31]] as const) {
      const corrected = applyScheduleCorrections(windowAt(date));
      expect(corrected.days.broadcast).toHaveLength(count);
      for (const day of corrected.days.broadcast) {
        let end = Date.parse(day.entries[0].startsAt);
        for (const entry of day.entries) {
          expect(Date.parse(entry.startsAt), `${day.date} ${entry.title}`).toBe(end);
          expect(Date.parse(entry.endsAt)).toBeGreaterThan(end);
          end = Date.parse(entry.endsAt);
        }
        expect(end - Date.parse(day.entries[0].startsAt)).toBe(day.date === "2026-11-01" ? 90_000_000 : 86_400_000);
        expect(corrected.days.kids.find((item) => item.date === day.date)?.entries)
          .toEqual(day.entries.map((entry) => ({ ...entry, feedKind: "kids" })));
      }
    }
    const december18 = applyScheduleCorrections(windowAt("2026-12-01")).days.broadcast.find((day) => day.date === "2026-12-18")!;
    expect(december18.entries.find((entry) => entry.startsAt.includes("T20:30:"))).toMatchObject({
      title: "Death in Paradise / Miss Fisher's Murder Mysteries / Sister Boniface Mysteries: Timing to be confirmed",
      endsAt: "2026-12-18T23:00:00-05:00", cid: null,
    });
    expect(applyScheduleCorrections(windowAt("2026-12-01")).days.broadcast
      .find((day) => day.date === "2026-12-17")!.entries.find((entry) => entry.startsAt.includes("T13:30:")))
      .toMatchObject({ title: "Downton Abbey on Masterpiece / Miss Scarlet and the Duke on Masterpiece: Timing to be confirmed",
        endsAt: "2026-12-17T16:00:00-05:00", cid: null });
    expect(applyScheduleCorrections(windowAt("2026-11-30")).request.dates).toHaveLength(43);
    expect(applyScheduleCorrections(windowAt("2026-12-31")).request.dates).toHaveLength(44);
    const january = windowAt("2027-01-01");
    expect(applyScheduleCorrections(january)).toBe(january);
  });

  it.each(["2026-11-15", "2026-12-18"])("keeps the workbook lineup in a later bake for %s", async (date) => {
    const rawFeed = `cb(${JSON.stringify({ headends: [{ name: "Broadcast", feeds: [{
      cid: "4211290e-ce30-49e5-9be1-2c412c5b3278", listings: [{
        title: "Inside the NJAC", start_time: "0900", duration: 30, kids: false,
      }],
    }] }] })})`;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const write = vi.fn();
      const result = await main({ SCHEDULE_OUTPUT: "/tmp/unused-monthly-schedule-test" },
        async () => new Response(rawFeed), new Date(`${date}T12:00:00Z`), write);
      if (!("days" in result)) throw new Error("Expected corrected bake");
      const day = result.days.broadcast.find((day) => day.date === date)!;
      expect(day.sourceRevision).toBe(date.startsWith("2026-11") ? "2026-11-02" : "2026-11-09");
      expect(day.entries.find((entry) => entry.startsAt.includes("T09:00:"))?.title)
        .toBe(date.startsWith("2026-11") ? "Live From the LBJ Library With Mark Updegrove" : "Donkey Hodie");
      expect(write).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
});
