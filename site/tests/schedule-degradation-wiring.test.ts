import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The schedule degradation script (PublicSubpage.astro) queries five hooks in the
// same file's markup: the grid placeholder, the block that wraps it, the fallback
// notice, the live-region announcer, and the gc.js loader tag. If any one drifts
// -- a renamed class, a dropped data-attribute -- the island's guard
// `if (mount && block && fallback)` silently evaluates false and the WHOLE
// fallback path no-ops, with no failure from the policy unit tests (those drive
// applyScheduleWidgetStatus with plain objects, never the rendered component).
// This is the source-level contract that turns that drift into a red test, the
// same way schedule-print.test.ts asserts on this component's source (issue #189).

// Resolve relative to this file, not the working dir, so the read is
// cwd-independent (matching schedule-print.test.ts, the sibling source test).
// The URL must be built where it is used, inside the describe callback: under the
// happy-dom test env a module-top-level import.meta.url is not yet a file: URL.
const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

// Each hook must exist at BOTH ends in the file: its markup definition and the
// script's query for it. The markup patterns use a negative lookbehind/lookahead
// so a bare attribute (data-schedule-fallback) is told apart from its bracketed
// query form ([data-schedule-fallback]); otherwise deleting the markup attribute
// would still pass on the query string alone.
const hooks: ReadonlyArray<{ name: string; markup: RegExp; query: string }> = [
  {
    name: "grid placeholder",
    markup: /id="tvschedule"/,
    query: 'getElementById("tvschedule")',
  },
  {
    name: "schedule block",
    markup: /class="public-page__schedule-block"/,
    query: '".public-page__schedule-block"',
  },
  {
    name: "fallback notice",
    markup: /(?<!\[)data-schedule-fallback(?!\])/,
    query: '"[data-schedule-fallback]"',
  },
  {
    name: "live-region announcer",
    markup: /(?<!\[)data-schedule-announce(?!\])/,
    query: '"[data-schedule-announce]"',
  },
  {
    name: "gc.js loader",
    markup: /(?<!\[)data-schedule-loader(?!\])/,
    query: '"[data-schedule-loader]"',
  },
];

describe("schedule island stays wired to the markup it degrades (issue #189)", () => {
  const subpage = readSource("../src/components/PublicSubpage.astro");

  it.each(hooks)(
    "keeps the $name hook defined in markup and queried by the script",
    ({ markup, query }) => {
      expect(subpage).toMatch(markup);
      expect(subpage).toContain(query);
    },
  );

  it("keeps the guard that no-ops safely when a hook is missing", () => {
    // The script must not run the degradation logic against a partly-missing set
    // of hooks; the guard is what makes a drift fail closed (dead grid left as-is)
    // rather than throwing. If this guard is refactored away, the wiring above is
    // no longer enough to reason about the failure mode.
    expect(subpage).toContain("if (mount && block && fallback)");
  });

  it("observes listing attributes as well as inserted nodes", () => {
    const observerOptions = subpage.match(
      /observer\.observe\(mount,\s*(\{[^}]*\})\);/,
    )?.[1];

    expect(observerOptions).toContain("childList: true");
    expect(observerOptions).toContain("subtree: true");
    expect(observerOptions).toContain("attributes: true");
    expect(observerOptions).toContain('attributeFilter: ["data-program-title"]');
  });
});
