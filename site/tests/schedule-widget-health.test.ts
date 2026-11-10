import { describe, expect, it } from "vitest";
import {
  applyScheduleWidgetStatus,
  isWidgetRendered,
  resolveScheduleWidgetStatus,
  SCHEDULE_RENDER_DEADLINE_MS,
  SCHEDULE_UNAVAILABLE_MESSAGE,
} from "../src/lib/schedule-widget-health";

// The gap this covers: the schedule page's one live PBS-dependent surface is the
// gc.js JAWS widget. Its static fallback survives "gc.js never loads", but not
// "gc.js loads and its upstream PBS fetch 403s / 429s / times out", which leaves
// an empty box. resolveScheduleWidgetStatus is the decision that turns that empty
// box into an honest, announced fallback; isWidgetRendered is how the island
// tells a rendered grid from a placeholder that is empty or only a loading shell.

const FALLBACK_CLASS = "public-page__schedule-fallback";

// Reduced from the live JAWS 1.65.0 DOM observed on 2026-07-09. These fixtures
// preserve the boundary documented in docs/research/2026-07-09-schedule-widget-render-phases.md:
// layout rows exist before PBS data, while data-program-title appears only with
// real listings.
const JAWS_SCAFFOLD_HTML = `
  <div role="table" aria-label="Schedule grid">
    <div role="row" class="schedulesMenu">
      <div role="columnheader" class="schedulesTime">7:00 pm</div>
    </div>
  </div>
`;

const JAWS_DESKTOP_LISTING_HTML = `
  <div id="sRow0" class="schedulesRow video" role="row">
    <div
      role="cell"
      class="calendarEntry time30"
      data-program-title="Drive by History"
    >
      <span class="gridProgram">Drive by History</span>
    </div>
  </div>
`;

const JAWS_MOBILE_LISTING_HTML = `
  <div role="listitem" class="scheduleItem">
    <div class="verticalProgram" data-program-title="Drive by History">
      Drive by History
    </div>
  </div>
`;

describe("resolveScheduleWidgetStatus", () => {
  it("is ready once the widget has rendered, whatever else happened", () => {
    // A rendered grid is up. An earlier loader error or an elapsed deadline must
    // not override real content the user can see.
    expect(
      resolveScheduleWidgetStatus({
        loaderErrored: false,
        widgetRendered: true,
        deadlineReached: false,
      }),
    ).toBe("ready");
    expect(
      resolveScheduleWidgetStatus({
        loaderErrored: true,
        widgetRendered: true,
        deadlineReached: true,
      }),
    ).toBe("ready");
  });

  it("is unavailable when the loader errored and nothing rendered", () => {
    // gc.js failed to load (CDN down, DNS failure, blocked).
    expect(
      resolveScheduleWidgetStatus({
        loaderErrored: true,
        widgetRendered: false,
        deadlineReached: false,
      }),
    ).toBe("unavailable");
  });

  it("is unavailable when the deadline passes with nothing rendered", () => {
    // gc.js loaded but its upstream fetch 403d / 429d / hung, so the placeholder
    // is still empty when the grace window closes.
    expect(
      resolveScheduleWidgetStatus({
        loaderErrored: false,
        widgetRendered: false,
        deadlineReached: true,
      }),
    ).toBe("unavailable");
  });

  it("is loading before any failure signal, while still waiting", () => {
    expect(
      resolveScheduleWidgetStatus({
        loaderErrored: false,
        widgetRendered: false,
        deadlineReached: false,
      }),
    ).toBe("loading");
  });

  it("exposes a positive render deadline", () => {
    expect(SCHEDULE_RENDER_DEADLINE_MS).toBeGreaterThan(0);
  });
});

describe("isWidgetRendered", () => {
  function placeholder(html = ""): HTMLElement {
    const mount = document.createElement("div");
    mount.id = "tvschedule";
    mount.innerHTML = html;
    return mount;
  }

  function fallbackParagraph(): HTMLElement {
    const p = document.createElement("p");
    p.className = FALLBACK_CLASS;
    p.textContent = "Live TV listings load here.";
    return p;
  }

  it("is false when only the seeded fallback paragraph is present", () => {
    const el = placeholder();
    el.append(fallbackParagraph());
    expect(isWidgetRendered(el)).toBe(false);
  });

  it("is false when gc.js cleared the fallback and rendered nothing", () => {
    expect(isWidgetRendered(placeholder())).toBe(false);
  });

  it("is false for a bare loading shell before the upstream fetch resolves", () => {
    // The two-phase-render trap: gc.js injects a wrapper first. Counting that as
    // rendered would stop the watch before a 403 / 429 / timeout clears it.
    const el = placeholder();
    el.append(document.createElement("div"));
    expect(isWidgetRendered(el)).toBe(false);
  });

  it("is false for an empty skeleton table with no rows", () => {
    const el = placeholder();
    el.append(document.createElement("table"));
    expect(isWidgetRendered(el)).toBe(false);
  });

  it("is false for the recorded rowed JAWS scaffold before listings arrive", () => {
    expect(isWidgetRendered(placeholder(JAWS_SCAFFOLD_HTML))).toBe(false);
  });

  it("is true for a recorded populated JAWS desktop listing", () => {
    expect(isWidgetRendered(placeholder(JAWS_DESKTOP_LISTING_HTML))).toBe(true);
  });

  it("is true for a recorded populated JAWS mobile listing", () => {
    expect(isWidgetRendered(placeholder(JAWS_MOBILE_LISTING_HTML))).toBe(true);
  });
});

// resolveScheduleWidgetStatus decides the status; applyScheduleWidgetStatus is
// the delegate that turns it into what the user sees -- hide the dead grid,
// reveal the honest fallback, announce it to a screen reader, and recover if a
// late render arrives. The gap this closes: nothing asserted the "unavailable"
// outcome (the 403 / 429 / timeout the issue names) actually swaps the DOM and
// announces, only that the status resolved. These pin that behavior.
describe("applyScheduleWidgetStatus", () => {
  // The markup ships with the grid block visible and the fallback hidden, and an
  // empty live region. Start from those states so each assertion is a transition
  // from the real starting point.
  function frame() {
    return { block: { hidden: false }, fallback: { hidden: true } };
  }

  // A live region that counts writes, so "announce once" and "clear on recovery"
  // can be asserted as write behavior, not just final text.
  function announcerDouble(initial: string | null = "") {
    let value = initial;
    let writes = 0;
    return {
      get textContent() {
        return value;
      },
      set textContent(next: string | null) {
        value = next;
        writes += 1;
      },
      get writes() {
        return writes;
      },
    };
  }

  it("touches nothing while loading and is not settled", () => {
    const els = { ...frame(), announcer: announcerDouble() };
    expect(applyScheduleWidgetStatus("loading", els)).toBe(false);
    expect(els.block.hidden).toBe(false);
    expect(els.fallback.hidden).toBe(true);
    expect(els.announcer.textContent).toBe("");
    expect(els.announcer.writes).toBe(0);
  });

  it("reveals the grid, hides the fallback, and settles when ready", () => {
    const els = { ...frame(), announcer: announcerDouble() };
    expect(applyScheduleWidgetStatus("ready", els)).toBe(true);
    expect(els.block.hidden).toBe(false);
    expect(els.fallback.hidden).toBe(true);
  });

  it("clears a stale unavailable notice when a late render recovers", () => {
    // The deadline fired first and announced unavailable; then gc.js rendered
    // late. Recovery must reveal the grid and wipe the stale live-region line.
    const els = {
      block: { hidden: true },
      fallback: { hidden: false },
      announcer: announcerDouble(SCHEDULE_UNAVAILABLE_MESSAGE),
    };
    expect(applyScheduleWidgetStatus("ready", els)).toBe(true);
    expect(els.block.hidden).toBe(false);
    expect(els.fallback.hidden).toBe(true);
    expect(els.announcer.textContent).toBe("");
  });

  it("hides the grid, reveals the fallback, and announces once when unavailable", () => {
    // The 403 / 429 / timeout outcome: the empty box becomes an honest, announced
    // fallback rather than a broken-looking blank.
    const els = { ...frame(), announcer: announcerDouble() };
    expect(applyScheduleWidgetStatus("unavailable", els)).toBe(false);
    expect(els.block.hidden).toBe(true);
    expect(els.fallback.hidden).toBe(false);
    expect(els.announcer.textContent).toBe(SCHEDULE_UNAVAILABLE_MESSAGE);
    expect(els.announcer.writes).toBe(1);
  });

  it("does not re-announce when a second unavailable pass runs", () => {
    // The observer can fire reconcile repeatedly while the outage persists; a
    // polite live region must not repeat the same line on every pass.
    const els = { ...frame(), announcer: announcerDouble() };
    applyScheduleWidgetStatus("unavailable", els);
    applyScheduleWidgetStatus("unavailable", els);
    expect(els.announcer.textContent).toBe(SCHEDULE_UNAVAILABLE_MESSAGE);
    expect(els.announcer.writes).toBe(1);
  });

  it("degrades without a live region present", () => {
    // announcer is null when the page has no live region; the visual fallback
    // must still swap in without throwing.
    const els = { block: { hidden: false }, fallback: { hidden: true }, announcer: null };
    expect(() => applyScheduleWidgetStatus("unavailable", els)).not.toThrow();
    expect(els.block.hidden).toBe(true);
    expect(els.fallback.hidden).toBe(false);
  });
});
