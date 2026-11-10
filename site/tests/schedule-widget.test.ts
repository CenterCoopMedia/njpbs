import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCHEDULE_WIDGETS,
  SCHEDULE_WIDGET_API_KEY,
  buildScheduleWidgetConfig,
} from "../src/lib/schedule-widget";

// Root cause this pins: the schedule page embedded three PBS JAWS widgets
// (whatson, whatsonkids, tvschedules) in one PBS_CHROME_CONFIG. gc.js loads a
// private copy of jQuery 1.8.2 + jQuery UI 1.10.4 for each declared widget, so
// three widgets reload jQuery three times. The reloads trip History.js, leave
// window.jQuery undefined, and make the datepicker-backed full-week grid throw
// "datepicker is not a function" so its table never renders. Only the
// first-declared widget survives. That is the "incomplete / goes nowhere / does
// not print" a viewer reported for the full week grid. Declaring a single widget
// fixes it, and the full grid is the complete, printable schedule on its own.

describe("schedule widget config", () => {
  it("declares exactly one JAWS widget, the full week grid", () => {
    // More than one widget reloads jQuery and collides. The full grid is the
    // widget the report is about and covers "now" and every channel on its own.
    expect(SCHEDULE_WIDGETS).toHaveLength(1);
    expect(SCHEDULE_WIDGETS[0]).toEqual({
      name: "tvschedules",
      placeholderId: "tvschedule",
    });
  });

  it("builds a PBS_CHROME_CONFIG that declares only the full-grid widget", () => {
    const config = buildScheduleWidgetConfig();
    expect(config).toContain(`api_key: '${SCHEDULE_WIDGET_API_KEY}'`);
    expect(config).toContain(
      `tvschedules: { placeholder: '#${SCHEDULE_WIDGETS[0]?.placeholderId}' }`,
    );
    // The partial widgets that collided with the grid must not come back.
    // ("whatson" is also a prefix of "whatsonkids", so this covers both.)
    expect(config).not.toContain("whatson");
  });

  it("declares every widget it is given, so a second widget is a visible re-add", () => {
    // Shows what a second widget would put back: gc.js would load jQuery once per
    // entry here and reload it, which is the collision this embed avoids by
    // passing a single widget. The builder itself declares whatever it is handed.
    const config = buildScheduleWidgetConfig([
      { name: "tvschedules", placeholderId: "tvschedule" },
      { name: "whatson", placeholderId: "jaws_whatson" },
    ]);
    expect(config).toContain(
      `tvschedules: { placeholder: '#${SCHEDULE_WIDGETS[0]?.placeholderId}' }`,
    );
    expect(config).toContain("whatson: { placeholder: '#jaws_whatson' }");
  });
});

describe("schedule page embed", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "components", "PublicSubpage.astro"),
    "utf8",
  );

  it("builds its embed config from the shared, tested module", () => {
    expect(source).toContain('from "../lib/schedule-widget"');
    expect(source).toContain("buildScheduleWidgetConfig");
  });

  it("renders only the full-week-grid placeholder", () => {
    expect(source).toContain('id="tvschedule"');
    // Re-adding a second JAWS placeholder reintroduces the jQuery double-load
    // that broke the grid, so hold the line here too.
    expect(source).not.toContain('id="jaws_whatson"');
    expect(source).not.toContain('id="jaws_whatsonkids"');
  });
});
