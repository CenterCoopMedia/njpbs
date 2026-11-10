// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sourceUrl = (relativePath: string) =>
  new URL(relativePath, import.meta.url);

const readSource = (relativePath: string) =>
  readFileSync(sourceUrl(relativePath), "utf8");

const readOptionalSource = (relativePath: string) => {
  const url = sourceUrl(relativePath);
  return existsSync(url) ? readFileSync(url, "utf8") : "";
};

describe("native schedule source wiring", () => {
  const page = readOptionalSource("../src/pages/schedule/[...schedule].astro");
  const catchAllPage = readSource("../src/pages/[...slug].astro");
  const schedule = readSource("../src/components/NativeSchedule.astro");
  const panel = readSource("../src/components/ScheduleDayPanel.astro");
  const client = readSource("../src/lib/native-schedule-dom.ts");
  const combined = `${page}\n${schedule}\n${panel}\n${client}`;

  it("uses the dedicated public route and baked schedule contract", () => {
    expect(page).toContain(
      'import PublicSiteLayout from "../../layouts/PublicSiteLayout.astro"',
    );
    expect(page).toContain(
      'import NativeSchedule from "../../components/NativeSchedule.astro"',
    );
    expect(page).toContain(
      'import scheduleData from "../../data/schedule.json"',
    );
    expect(page).toMatch(/import\s+type\s*\{\s*BakedScheduleData\s*\}/);
    expect(page).toContain("scheduleData as BakedScheduleData");
    expect(page).toContain('cmsSchedule?.data.title ?? "TV schedule"');
    expect(page).toContain("cmsSchedule?.data.description");
    expect(page).toContain(
      'preview={cmsSchedule?.data.contentMode === "draft"}',
    );
    expect(page).toContain(
      'canonicalPath={cmsSchedule?.data.path ?? "/schedule/"}',
    );
    expect(page).toContain(
      'metaRefreshTo={cmsSchedule && cmsSchedule.data.path !== "/schedule/" ? cmsSchedule.data.path : undefined}',
    );
    expect(page).toContain(
      'noindex={Boolean(cmsSchedule && cmsSchedule.data.path !== "/schedule/") || (cmsSchedule?.data.noindex ?? false)}',
    );
    expect(page).toContain("heroBackgroundImage={heroBackgroundImage}");
    expect(page).toContain(
      "heroBackgroundPosition={cmsSchedule?.data.heroBackgroundPosition}",
    );
    expect(page).toContain("<CmsBlocks entry={cmsSchedule} readerControls />");
  });

  it("gates the native schedule route out of PUBLIC_ONLY builds", () => {
    expect(page).toContain(
      'import { publicRootRoutesEnabled } from "../../lib/build-target"',
    );
    expect(page).toContain("export function getStaticPaths()");
    expect(page).toMatch(
      /if\s*\(!publicRootRoutesEnabled\(process\.env\)\)\s*return\s*\[\]/,
    );
    expect(page).toContain("params: { schedule: undefined }");
  });

  it("keeps the dedicated schedule route as the only full-build owner for /schedule/", () => {
    expect(catchAllPage).toContain("launchFallbackRoutePages");
    expect(catchAllPage).not.toContain("Object.values(launchFallbackPages)");
    expect(catchAllPage).toContain(
      '(definition.family === "schedule" && path === "/schedule/")',
    );
    expect(catchAllPage).toContain('cmsEntry?.data.family === "schedule"');
    expect(page).toContain("params: { schedule: undefined }");
  });

  it("renders the approved schedule landmarks and shared full summary", () => {
    expect(schedule).toContain("data-native-schedule");
    expect(schedule).toContain("TV schedule");
    expect(schedule).toContain("WNJTDT");
    expect(schedule).toContain("Listings supplied by PBS");
    expect(schedule).toMatch(/<ScheduleNowNext[^>]*variant="full"/s);
    expect(schedule).toContain("data-schedule-day-switcher");
    expect(schedule).toContain("Jump to now");
    expect(schedule).toContain("Primetime");
    expect(schedule).toContain('type="search"');
    expect(schedule).toContain("Find a program");
    expect(schedule).toContain("Search title or episode");
    expect(schedule).toContain("data-schedule-search-clear");
    expect(schedule).toContain("data-schedule-search-status");
    expect(schedule).toContain("data-schedule-search-results");
    expect(schedule).toContain("data-schedule-search-groups");
    expect(schedule).toContain("updateScheduleSearch");
    expect(schedule).toContain("clearScheduleSearch");
    expect(schedule).toContain("Full broadcast day");
    expect(schedule).toContain("Eastern time");
    expect(schedule).toContain("resolveInitialScheduleDay");
    expect(schedule).toContain(
      "resolveInitialScheduleDay(broadcastDays, new Date())",
    );
    expect(schedule).toContain(
      'aria-current={!initialScheduleExpired && day.date === initialDay.date ? "date" : undefined}',
    );
  });

  it("keeps prose boundaries explicit across Astro-rendered inline elements", () => {
    expect(schedule).toMatch(
      /<strong>NJ PBS broadcast<\/strong>\s*\{" "\}\s*WNJTDT/,
    );
    expect(schedule).toMatch(
      /<span class="sr-only">This episode:<\/span>\s*\{" "\}\s*<span data-program-dialog-episode-description-text>/,
    );
    expect(schedule).toMatch(
      /<span class="sr-only">About the series:<\/span>\s*\{" "\}\s*<span data-program-dialog-description/,
    );
  });

  it("keeps search absent without JavaScript and preserves the server-rendered day", () => {
    expect(schedule).toMatch(/data-schedule-search[^>]*hidden/s);
    expect(schedule).toMatch(/data-schedule-search-results[^>]*hidden/s);
    expect(schedule).toMatch(
      /<ScheduleDayPanel[\s\S]*broadcastDay=\{initialDay\}/,
    );
    expect(schedule).toContain('root.dataset.scheduleWindowExpired !== "true"');
  });

  it("presents fourteen dates as two readable desktop weeks and one mobile select", () => {
    expect(schedule).toContain("repeat(7, minmax(0, 1fr))");
    expect(schedule).toContain("Search all {broadcastDays.length} days");
    expect(schedule).toContain("data-schedule-day-select");
  });

  it("renders disabled day controls for a build-time expired schedule window", () => {
    expect(schedule).toContain(
      "const initialScheduleExpired = !broadcastDays.some",
    );
    expect(schedule).toContain(
      'data-schedule-window-expired={initialScheduleExpired ? "true" : undefined}',
    );
    expect(schedule).toMatch(
      /data-schedule-jump-now[\s\S]*disabled=\{initialScheduleExpired \? true : undefined\}/,
    );
    expect(schedule).toMatch(
      /data-schedule-jump-prime[\s\S]*disabled=\{initialScheduleExpired \? true : undefined\}/,
    );
    expect(schedule).toMatch(
      /data-schedule-day[\s\S]*disabled=\{initialScheduleExpired \? true : undefined\}/,
    );
    expect(schedule).toMatch(
      /data-schedule-day-select[\s\S]*disabled=\{initialScheduleExpired \? true : undefined\}/,
    );
    expect(schedule).toContain(
      '<option value="" selected={initialScheduleExpired}>',
    );
    expect(schedule).toContain("Listings unavailable");
  });

  it("marks the build-time initial day in the mobile day select", () => {
    expect(schedule).toContain(
      "selected={!initialScheduleExpired && day.date === initialDay.date}",
    );
    expect(schedule).not.toContain(
      "<option value={day.date}>{formatScheduleDateLabel(day.date)}</option>",
    );
    expect(schedule).toContain(
      '<option value="" selected={initialScheduleExpired}>',
    );
  });

  it("renders stable timeline, kids, fallback, and details hooks", () => {
    expect(panel).toContain("data-schedule-timeline");
    expect(panel).toContain("data-schedule-empty-state");
    expect(panel).toContain("data-kids-empty-state");
    expect(panel).toContain("data-schedule-primetime");
    expect(panel).toMatch(/data-schedule-now-line[^>]*aria-hidden="true"/s);
    expect(panel).toContain("data-program-details");
    expect(panel).toContain("HD");
    expect(panel).toContain("CC");
    expect(panel).toContain("PBS Kids 24/7");
    expect(panel).toContain("Listings temporarily unavailable");
    expect(panel).toContain(
      "Watch NJ PBS live or browse programs on demand while the schedule catches up.",
    );
    expect(panel).toContain('href="/live/"');
    expect(panel).toContain('href="https://watch.njpbs.org/"');
    expect(panel).toContain("No kids block airs on NJ PBS this day.");
    expect(panel).toContain("The PBS Kids 24/7 livestream is still available.");
    expect(panel).toContain('href="https://pbskids.org/videos/watch/live"');
    expect(panel).toContain("opens in new tab");
  });

  it("uses only settled kids derivation outside the feed contract", () => {
    for (const source of [schedule, panel, client]) {
      expect(source).not.toMatch(/\.\s*kids\b/);
      expect(source).not.toMatch(/\[\s*["']kids["']\s*\]/);
    }
    expect(panel).toMatch(/getScheduleDayState|filterKidsListings/);
    expect(client).not.toContain("isKids");
  });

  it("keeps all baked broadcast and kids days for page controls, search and templates", () => {
    expect(schedule).toContain("const { broadcast: broadcastDays, kids: kidsDays } = data.days;");
    expect(schedule).toContain("const useDaySelect = broadcastDays.length > 14;");
    expect(schedule).not.toContain("scheduleExport.days");
    expect(schedule).not.toContain("scheduleExport.dates");
    expect(schedule).toContain("broadcastDays.map");
    expect(schedule).toContain("<template");
    expect(schedule).toContain("data-schedule-day-template");
    expect(schedule).toMatch(
      /<ScheduleDayPanel[\s\S]*broadcastDay=\{initialDay\}/,
    );
    expect(schedule.indexOf("data-schedule-panel-host")).toBeLessThan(
      schedule.indexOf("<template"),
    );
  });

  it("prints a readable static listing and hides schedule controls", () => {
    expect(schedule).toContain("@media print");
    expect(schedule).toMatch(
      /@media print[\s\S]*schedule-toolbar[\s\S]*display:\s*none/,
    );
    expect(schedule).toMatch(
      /@media print[\s\S]*data-schedule-panel-host[\s\S]*display:\s*block\s*!important/,
    );
    expect(schedule).toMatch(
      /@media print[\s\S]*program-slot[\s\S]*position:\s*static/,
    );
    expect(schedule).toMatch(
      /@media print[\s\S]*color:\s*var\(--color-print-ink\)/,
    );
  });

  it("bakes supported desktop and mobile pixel positions", () => {
    expect(panel).toContain("--schedule-desktop-top");
    expect(panel).toContain("--schedule-mobile-top");
    expect(panel).toContain("--schedule-desktop-height");
    expect(panel).toContain("--schedule-mobile-height");
    expect(panel).toContain("scheduleDayLengthMinutes");
    expect(panel).toContain("scheduleLocalHourMinute");
    expect(panel).toContain("--schedule-desktop-day-height");
    expect(panel).toContain("--schedule-mobile-day-height");
    expect(schedule).toContain("height: var(--schedule-desktop-day-height)");
    expect(schedule).toContain("height: var(--schedule-mobile-day-height)");
    expect(schedule).not.toContain("height: 3456px");
    expect(schedule).not.toContain("height: 3312px");
    expect(schedule).toContain("top: var(--schedule-desktop-top)");
    expect(schedule).toContain("height: var(--schedule-desktop-height)");
    expect(schedule).toContain("top: var(--schedule-mobile-top)");
    expect(schedule).toContain("height: var(--schedule-mobile-height)");
    expect(schedule).not.toContain("--schedule-unit");
    expect(schedule).not.toMatch(
      /--schedule-(?:hour-minute|prime-start|prime-duration|start|duration|now-minute)/,
    );
    expect(panel).toContain("scheduleRowHeightPx");
    expect(panel).not.toContain("Math.max(68");
    expect(panel).not.toContain("Math.max(65");
  });

  it("builds hour rail labels without a fixed UTC offset", () => {
    expect(panel).toContain("buildScheduleHourMarks(broadcastDay.date)");
    expect(panel).not.toMatch(/[+-]\d{2}:\d{2}/);
  });

  it("keeps the sticky day switcher below the measured public header", () => {
    expect(schedule).toContain("--schedule-header-offset: 92px");
    expect(schedule).toContain("--schedule-header-offset: 74px");
    expect(schedule).toContain("top: var(--schedule-header-offset)");
    expect(schedule).toContain("ResizeObserver");
    expect(schedule).toContain(
      'root.style.setProperty("--schedule-header-offset"',
    );
    expect(schedule).not.toContain("top: 71.2px");
    expect(schedule).not.toContain("top: 61.6px");
  });

  it("collapses the desktop date grid after the toolbar becomes sticky", () => {
    expect(schedule).toContain('id="schedule-page-title" tabindex="-1"');
    expect(schedule).toContain("data-schedule-day-switcher");
    expect(schedule).toContain('role="region"');
    expect(schedule).toContain('aria-label="Schedule controls"');
    expect(schedule).toContain("data-schedule-toolbar-sentinel");
    expect(schedule).toContain("data-schedule-dates-toggle");
    expect(schedule).toContain('aria-controls="schedule-day-tabs"');
    expect(schedule).toContain('id="schedule-day-tabs"');
    expect(schedule).toContain("updateScheduleDateGridVisibility");
    expect(schedule).toContain("resolveScheduleToolbarSticky");
    expect(schedule).toContain("expandedToolbarHeight");
    expect(schedule).toContain('window.addEventListener("scroll"');
    expect(schedule).toContain("{ passive: true }");
    expect(schedule).toContain('window.matchMedia("(min-width: 701px)")');
    expect(schedule).toContain('root.addEventListener("keydown"');
    expect(schedule).toContain('root.addEventListener("pointerdown"');
    // Collapsing the date grid changes the sticky toolbar's height. Disabling
    // anchoring on its shell prevents the browser from moving the scroll
    // position across the sticky threshold and repeatedly toggling the grid.
    expect(schedule).toMatch(
      /\.schedule-shell\s*\{[^}]*overflow-anchor:\s*none/s,
    );
    expect(schedule).toMatch(
      /data-schedule-dates-collapsed="true"[^}]*schedule-day-tabs[^{]*\{[^}]*display:\s*none/s,
    );
  });

  it("does not load the retired external schedule widget on this route", () => {
    expect(combined).not.toMatch(/tvschedule|JAWS|gc\.js|PBS_CHROME_CONFIG/i);
  });

  it("keeps the padded page containers inside the phone viewport", () => {
    // The shared container rule pairs width: min(100%, 84rem) with inline
    // padding. Without border-box sizing the padding lands outside the 100%
    // arm, so every phone viewport overflows 2rem to the right.
    const containerRule = schedule.match(
      /\.schedule-intro,\s*\.schedule-toolbar__inner,\s*\.schedule-content\s*\{[^}]*\}/,
    )?.[0];
    expect(containerRule).toBeDefined();
    expect(containerRule).toContain("box-sizing: border-box");
    expect(containerRule).toContain("width: min(100%, 84rem)");
  });
});
