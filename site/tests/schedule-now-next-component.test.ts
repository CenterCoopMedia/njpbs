import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("shared on-now and up-next component wiring", () => {
  const component = readSource("../src/components/ScheduleNowNext.astro");
  const domModule = readSource("../../packages/content-core/src/schedule-now-next-dom.ts");
  const styles = readSource("../src/styles/schedule-now-next.css");
  const subpage = readSource("../src/components/PublicSubpage.astro");

  it("keeps the fallback out of layout after successful hydration hides it", () => {
    expect(styles).toMatch(
      /\.now-next__fallback\[hidden\]\s*\{[\s\S]*?display:\s*none/,
    );
  });

  it("serializes baked days beside the component", () => {
    expect(component).toContain('type="application/json"');
    expect(component).toContain("data-now-next-data");
    expect(component).toMatch(/JSON\.stringify\(days\).*replace/s);
  });

  it("uses the shared clock with a deterministic query override and minute refresh", () => {
    expect(component).toContain("resolveNowNextClock");
    expect(component).toContain("renderScheduleNowNext");
    expect(component).toContain("millisecondsToNextMinute");
    expect(component).toContain("nowNextMounted");
    expect(component).toContain("if (clock.fixed) return");
    expect(domModule).toContain("resolveScheduleClock");
    expect(domModule).toContain("getScheduleClockState");
    expect(domModule).toContain("SCHEDULE_TIME_ZONE");
    expect(domModule).not.toContain('"America/New_York"');
    expect(domModule).toContain("URLSearchParams");
    expect(domModule).toContain('"mock-time"');
    expect(component).toMatch(/60_?000/);
  });

  it("never reads the kids collection or a raw kids property", () => {
    expect(component).not.toMatch(/\.\s*kids\b/);
    expect(component).not.toMatch(/\[\s*["']kids["']\s*\]/);
    expect(component).not.toMatch(/\{[^}\n]*\bkids\s*[,}:]/);
    expect(domModule).not.toMatch(/\.\s*kids\b/);
    expect(domModule).not.toMatch(/\[\s*["']kids["']\s*\]/);
  });

  it("mounts the compact broadcast strip only on the live page after the player", () => {
    expect(subpage).toContain('import ScheduleNowNext from "./ScheduleNowNext.astro"');
    expect(subpage).toContain('import scheduleData from "../data/schedule.json"');
    expect(subpage).toMatch(/import\s+type\s*\{\s*BakedScheduleData\s*\}/);
    expect(subpage).toMatch(/scheduleData\s+as\s+BakedScheduleData/);
    expect(subpage).toMatch(/page\.slug\s*===\s*["']live["'][\s\S]*<ScheduleNowNext/);
    expect(subpage).toMatch(/<ScheduleNowNext[\s\S]*variant=["']compact["']/);
    expect(subpage).toContain("days={bakedSchedule.days.broadcast}");

    const player = subpage.indexOf("detail.player &&");
    const strip = subpage.indexOf("<ScheduleNowNext");
    const schedule = subpage.indexOf("detail.scheduleWidget &&", player + 1);
    expect(player).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(player);
    expect(schedule).toBeGreaterThan(strip);
  });
});
