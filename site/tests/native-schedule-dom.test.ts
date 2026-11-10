import { beforeEach, describe, expect, it, vi } from "vitest";
import * as nativeScheduleDom from "../src/lib/native-schedule-dom.ts";
import {
  activateScheduleDay,
  clearScheduleSearch,
  getScheduleScrollBehavior,
  populateProgramDialog,
  resolveInitialScheduleDate,
  resolveJumpToNowTarget,
  resolvePrimetimeTarget,
  resolveScheduleToolbarSticky,
  updateScheduleDateGridVisibility,
  updateScheduleSearch,
  updateScheduleNowLine,
} from "../src/lib/native-schedule-dom.ts";

function activateInitialScheduleState(
  root: HTMLElement,
  dates: readonly string[],
  search: string,
  realNow: Date,
): boolean {
  const fn = (
    nativeScheduleDom as typeof nativeScheduleDom & {
      activateInitialScheduleState?: (
        root: HTMLElement,
        dates: readonly string[],
        search: string,
        realNow: Date,
      ) => boolean;
    }
  ).activateInitialScheduleState;
  expect(fn).toBeTypeOf("function");
  return fn?.(root, dates, search, realNow) ?? false;
}

function mount(): HTMLElement {
  document.body.innerHTML = `
    <section data-native-schedule>
      <h1 id="schedule-page-title" tabindex="-1">TV schedule</h1>
      <div data-schedule-day-switcher role="region" aria-label="Schedule controls" tabindex="-1"></div>
      <strong data-schedule-active-date></strong>
      <span data-schedule-active-count></span>
      <span data-schedule-announcer></span>
      <button type="button" data-schedule-jump-now>Jump to now</button>
      <button type="button" data-schedule-jump-prime>Primetime</button>
      <button
        type="button"
        data-schedule-dates-toggle
        aria-controls="schedule-day-tabs"
        aria-expanded="true"
        hidden
      >Hide dates</button>
      <div data-schedule-search hidden>
        <input type="search" data-schedule-search-input>
        <button type="button" data-schedule-search-clear hidden>Clear</button>
        <p data-schedule-search-status></p>
      </div>
      <div id="schedule-day-tabs" data-schedule-date-grid>
        <button data-schedule-day data-schedule-date="2026-07-10" aria-current="date">Friday</button>
        <button data-schedule-day data-schedule-date="2026-07-11">Saturday</button>
      </div>
      <select data-schedule-day-select>
        <option value="2026-07-10">Friday</option>
        <option value="2026-07-11">Saturday</option>
      </select>
      <div data-schedule-panel-host>
        <section data-schedule-day-panel data-schedule-date="2026-07-10">
          <div data-schedule-timeline>
            <button data-program-details data-program-title="Stale listing">Stale listing</button>
            <div data-schedule-now-line aria-hidden="true" hidden><span data-schedule-now-label></span></div>
            <div data-schedule-primetime></div>
          </div>
          <div data-schedule-empty-state hidden>Listings temporarily unavailable</div>
          <ol class="schedule-kids__list"><li>Kids listing</li></ol>
          <div data-kids-empty-state hidden>No kids block airs on NJ PBS this day.</div>
        </section>
      </div>
      <section data-schedule-search-results hidden>
        <div data-schedule-search-groups></div>
        <div data-schedule-search-empty hidden>
          <p data-schedule-search-empty-copy></p>
        </div>
      </section>
      <template data-schedule-day-template data-schedule-date="2026-07-10" data-schedule-date-label="Friday, July 10" data-schedule-count="39 programs">
        <section data-schedule-day-panel data-schedule-date="2026-07-10">
          <div data-schedule-now-line aria-hidden="true" hidden><span data-schedule-now-label></span></div>
          <div data-schedule-primetime></div>
          <button
            class="schedule-program"
            data-program-details
            data-program-title="Antiques Roadshow"
            data-program-episode="Special edition"
            data-program-time="8:00–9:00 p.m. ET"
          >
            <span class="schedule-program__time">8:00 p.m.</span>
            <span class="schedule-program__copy">
              <strong class="schedule-program__title">Antiques Roadshow</strong>
              <span class="schedule-program__episode">Special edition</span>
            </span>
          </button>
        </section>
      </template>
      <template data-schedule-day-template data-schedule-date="2026-07-11" data-schedule-date-label="Saturday, July 11" data-schedule-count="40 programs">
        <section data-schedule-day-panel data-schedule-date="2026-07-11">
          <div data-schedule-now-line aria-hidden="true" hidden><span data-schedule-now-label></span></div>
          <div data-schedule-primetime></div>
          <button
            class="schedule-program"
            data-program-details
            data-program-title="Antiques Roadshow"
            data-program-episode="New Jersey Hour"
            data-program-time="7:00–8:00 p.m. ET"
          >
            <span class="schedule-program__time">7:00 p.m.</span>
            <span class="schedule-program__copy">
              <strong class="schedule-program__title">Antiques Roadshow</strong>
              <span class="schedule-program__episode">New Jersey Hour</span>
            </span>
          </button>
          <button
            class="schedule-program"
            data-program-details
            data-program-title="NOVA"
            data-program-episode="Hidden Worlds"
            data-program-time="9:00–10:00 p.m. ET"
          >
            <span class="schedule-program__time">9:00 p.m.</span>
            <span class="schedule-program__copy">
              <strong class="schedule-program__title">NOVA</strong>
              <span class="schedule-program__episode">Hidden Worlds</span>
            </span>
          </button>
        </section>
      </template>
    </section>
  `;
  return document.querySelector<HTMLElement>("[data-native-schedule]")!;
}

describe("native schedule DOM adapter", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.removeAttribute("data-motion");
  });

  it("selects the strict mock Eastern date only when it is baked", () => {
    const dates = ["2026-07-10", "2026-07-11"];
    const realNow = new Date("2026-07-20T12:00:00-04:00");

    expect(
      resolveInitialScheduleDate(
        dates,
        "?mock-time=2026-07-11T20%3A15%3A00-04%3A00",
        realNow,
      ),
    ).toBe("2026-07-11");
    expect(resolveInitialScheduleDate(dates, "?mock-time=invalid", realNow)).toBeNull();
    expect(
      resolveInitialScheduleDate(
        dates,
        "?mock-time=2026-07-12T20%3A15%3A00-04%3A00",
        realNow,
      ),
    ).toBeNull();
    expect(resolveInitialScheduleDate(dates, "", realNow)).toBeNull();
  });

  it("collapses the desktop date grid once the toolbar is sticky", () => {
    const root = mount();
    const toggle = root.querySelector<HTMLButtonElement>("[data-schedule-dates-toggle]")!;

    expect(
      updateScheduleDateGridVisibility(root, {
        isDesktop: true,
        isSticky: true,
        forceExpanded: false,
        preserveFocusedDate: false,
      }),
    ).toBe(true);
    expect(root.dataset.scheduleDatesCollapsed).toBe("true");
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("Show dates");
  });

  it("latches a collapsed toolbar across its own height change", () => {
    const shared = {
      headerHeight: 92,
      expandedToolbarHeight: 292,
      toolbarHeight: 87,
    };

    expect(
      resolveScheduleToolbarSticky({
        ...shared,
        sentinelTop: 101,
        datesCollapsed: true,
      }),
    ).toBe(true);
    expect(
      resolveScheduleToolbarSticky({
        ...shared,
        sentinelTop: 101,
        datesCollapsed: false,
      }),
    ).toBe(false);
    expect(
      resolveScheduleToolbarSticky({
        ...shared,
        sentinelTop: 300,
        datesCollapsed: true,
      }),
    ).toBe(false);
  });

  it("keeps sticky dates open after an explicit expansion or while a date has focus", () => {
    const root = mount();
    const toggle = root.querySelector<HTMLButtonElement>("[data-schedule-dates-toggle]")!;
    const date = root.querySelector<HTMLButtonElement>("[data-schedule-day]")!;

    expect(
      updateScheduleDateGridVisibility(root, {
        isDesktop: true,
        isSticky: true,
        forceExpanded: true,
        preserveFocusedDate: false,
      }),
    ).toBe(false);
    expect(root.dataset.scheduleDatesCollapsed).toBe("false");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide dates");

    date.focus();
    expect(
      updateScheduleDateGridVisibility(root, {
        isDesktop: true,
        isSticky: true,
        forceExpanded: false,
        preserveFocusedDate: true,
      }),
    ).toBe(false);
  });

  it("collapses after pointer interaction even when the clicked date retains focus", () => {
    const root = mount();
    const date = root.querySelector<HTMLButtonElement>("[data-schedule-day]")!;

    date.focus();
    expect(
      updateScheduleDateGridVisibility(root, {
        isDesktop: true,
        isSticky: true,
        forceExpanded: false,
        preserveFocusedDate: false,
      }),
    ).toBe(true);
    expect(document.activeElement).toBe(
      root.querySelector("[data-schedule-dates-toggle]"),
    );
  });

  it("leaves dates expanded and hides the toggle outside the desktop sticky state", () => {
    const root = mount();
    const toggle = root.querySelector<HTMLButtonElement>("[data-schedule-dates-toggle]")!;

    for (const state of [
      {
        isDesktop: true,
        isSticky: false,
        forceExpanded: false,
        preserveFocusedDate: false,
      },
      {
        isDesktop: false,
        isSticky: true,
        forceExpanded: false,
        preserveFocusedDate: false,
      },
    ]) {
      expect(updateScheduleDateGridVisibility(root, state)).toBe(false);
      expect(root.dataset.scheduleDatesCollapsed).toBe("false");
      expect(toggle.hidden).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    }
  });

  it("hands keyboard focus off before hiding the sticky-only dates toggle", () => {
    const root = mount();
    const toggle = root.querySelector<HTMLButtonElement>("[data-schedule-dates-toggle]")!;
    const heading = root.querySelector<HTMLHeadingElement>("#schedule-page-title")!;
    const toolbar = root.querySelector<HTMLElement>("[data-schedule-day-switcher]")!;
    const select = root.querySelector<HTMLSelectElement>("[data-schedule-day-select]")!;

    toggle.hidden = false;
    toggle.focus();
    updateScheduleDateGridVisibility(root, {
      isDesktop: true,
      isSticky: false,
      forceExpanded: false,
      preserveFocusedDate: false,
    });
    expect(document.activeElement).toBe(toolbar);
    expect(toggle.hidden).toBe(true);

    vi.spyOn(heading, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 40,
    } as DOMRect);
    toggle.hidden = false;
    toggle.focus();
    updateScheduleDateGridVisibility(root, {
      isDesktop: true,
      isSticky: false,
      forceExpanded: false,
      preserveFocusedDate: false,
    });
    expect(document.activeElement).toBe(heading);

    toggle.hidden = false;
    toggle.focus();
    updateScheduleDateGridVisibility(root, {
      isDesktop: false,
      isSticky: true,
      forceExpanded: false,
      preserveFocusedDate: false,
    });
    expect(document.activeElement).toBe(select);
    expect(toggle.hidden).toBe(true);
  });

  it("shows an empty current-day state when the runtime clock is past the baked window", () => {
    const root = mount();

    expect(
      activateInitialScheduleState(
        root,
        ["2026-07-10", "2026-07-11"],
        "?mock-time=2026-07-20T12%3A00%3A00-04%3A00",
        new Date("2026-07-10T12:00:00-04:00"),
      ),
    ).toBe(true);

    const timeline = root.querySelector<HTMLElement>("[data-schedule-timeline]")!;
    const empty = root.querySelector<HTMLElement>("[data-schedule-empty-state]")!;
    const kidsList = root.querySelector<HTMLElement>(".schedule-kids__list")!;
    const kidsEmpty = root.querySelector<HTMLElement>("[data-kids-empty-state]")!;
    const select = root.querySelector<HTMLSelectElement>("[data-schedule-day-select]")!;

    expect(root.dataset.scheduleActiveDate).toBe("2026-07-20");
    expect(root.querySelector("[data-schedule-active-date]")?.textContent).toBe(
      "Monday, July 20",
    );
    expect(root.querySelector("[data-schedule-active-count]")?.textContent).toBe(
      "0 programs",
    );
    expect(root.querySelector("[data-schedule-announcer]")?.textContent).toContain(
      "Showing Monday, July 20, 0 programs.",
    );
    expect(timeline.hidden).toBe(true);
    expect(empty.hidden).toBe(false);
    expect(kidsList.hidden).toBe(true);
    expect(kidsEmpty.hidden).toBe(false);
    expect(kidsEmpty.textContent).toContain("Kids listings are temporarily unavailable.");
    expect(kidsEmpty.textContent).toContain("PBS Kids 24/7 livestream is still available.");
    expect(kidsEmpty.textContent).not.toContain("No kids block airs on NJ PBS this day.");
    expect(root.querySelector("[aria-current='date']")).toBeNull();
    expect(select.selectedIndex).toBe(-1);
    expect(select.disabled).toBe(true);
    const dayButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>("[data-schedule-day]"),
    );
    expect(dayButtons.length).toBeGreaterThan(0);
    expect(dayButtons.every((button) => button.disabled)).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("[data-schedule-jump-now]")?.disabled).toBe(
      true,
    );
    expect(
      root.querySelector<HTMLButtonElement>("[data-schedule-jump-prime]")?.disabled,
    ).toBe(true);
  });

  it("does not let a stale baked day reactivate after the runtime window expires", () => {
    const root = mount();

    expect(
      activateInitialScheduleState(
        root,
        ["2026-07-10", "2026-07-11"],
        "?mock-time=2026-07-20T12%3A00%3A00-04%3A00",
        new Date("2026-07-10T12:00:00-04:00"),
      ),
    ).toBe(true);

    const expiredPanel = root.querySelector("[data-schedule-day-panel]")?.cloneNode(true);

    expect(activateScheduleDay(root, "2026-07-11")).toBe(false);
    expect(root.dataset.scheduleActiveDate).toBe("2026-07-20");
    expect(root.querySelector("[data-schedule-active-count]")?.textContent).toBe(
      "0 programs",
    );
    expect(root.querySelector("[data-schedule-active-date]")?.textContent).toBe(
      "Monday, July 20",
    );
    expect(root.querySelector("[aria-current='date']")).toBeNull();
    expect(root.querySelector("[data-schedule-day-panel]")?.isEqualNode(expiredPanel ?? null)).toBe(
      true,
    );
    expect(root.querySelector<HTMLSelectElement>("[data-schedule-day-select]")?.disabled).toBe(
      true,
    );
    expect(root.querySelector<HTMLButtonElement>("[data-schedule-jump-now]")?.disabled).toBe(
      true,
    );
    expect(
      root.querySelector<HTMLButtonElement>("[data-schedule-jump-prime]")?.disabled,
    ).toBe(true);
  });

  it("activates only the matching template and updates day context", () => {
    const root = mount();
    expect(root.querySelector("[data-kids-empty-state]")?.textContent).toContain(
      "No kids block airs on NJ PBS this day.",
    );

    expect(activateScheduleDay(root, "2026-07-11")).toBe(true);
    expect(root.querySelectorAll("[data-schedule-day-panel]")).toHaveLength(1);
    expect(
      root.querySelector<HTMLElement>("[data-schedule-day-panel]")?.dataset
        .scheduleDate,
    ).toBe("2026-07-11");
    expect(root.querySelector("[aria-current='date']")?.getAttribute("data-schedule-date")).toBe(
      "2026-07-11",
    );
    expect(root.querySelector<HTMLSelectElement>("[data-schedule-day-select]")?.value).toBe(
      "2026-07-11",
    );
    expect(root.querySelector("[data-schedule-active-date]")?.textContent).toBe(
      "Saturday, July 11",
    );
    expect(root.querySelector("[data-schedule-active-count]")?.textContent).toBe(
      "40 programs",
    );
    expect(root.querySelector("[data-schedule-announcer]")?.textContent).toBe(
      "Showing Saturday, July 11, 40 programs.",
    );

    const panel = root.querySelector("[data-schedule-day-panel]")?.cloneNode(true);
    expect(activateScheduleDay(root, "2026-07-12")).toBe(false);
    expect(root.querySelector("[data-schedule-day-panel]")?.isEqualNode(panel ?? null)).toBe(
      true,
    );
  });

  it("groups title matches across every baked day and clears back to the active day", () => {
    const root = mount();
    const search = root.querySelector<HTMLElement>("[data-schedule-search]")!;
    const input = root.querySelector<HTMLInputElement>("[data-schedule-search-input]")!;
    const host = root.querySelector<HTMLElement>("[data-schedule-panel-host]")!;
    const results = root.querySelector<HTMLElement>("[data-schedule-search-results]")!;

    search.hidden = false;
    input.value = "ANTIQUES";
    expect(updateScheduleSearch(root, input.value)).toEqual({
      query: "antiques",
      showings: 2,
      days: 2,
    });

    expect(host.hidden).toBe(true);
    expect(results.hidden).toBe(false);
    expect(root.querySelectorAll("[data-schedule-search-group]")).toHaveLength(2);
    expect(root.querySelectorAll("[data-schedule-search-result]")).toHaveLength(2);
    expect(root.querySelector("[data-schedule-search-status]")?.textContent).toBe(
      "2 showings across 2 days.",
    );
    expect(
      root.querySelector<HTMLButtonElement>("[data-schedule-search-clear]")?.hidden,
    ).toBe(false);
    expect(root.querySelector<HTMLElement>("[data-schedule-search-empty]")?.hidden).toBe(
      true,
    );

    expect(clearScheduleSearch(root)).toBe(true);
    expect(input.value).toBe("");
    expect(host.hidden).toBe(false);
    expect(results.hidden).toBe(true);
    expect(root.querySelectorAll("[data-schedule-search-group]")).toHaveLength(0);
    expect(root.querySelector("[data-schedule-search-status]")?.textContent).toBe(
      "Search all 2 days.",
    );
  });

  it("matches episode titles and reports an honest empty result", () => {
    const root = mount();

    expect(updateScheduleSearch(root, " hidden   worlds ")).toEqual({
      query: "hidden worlds",
      showings: 1,
      days: 1,
    });
    expect(root.querySelectorAll("[data-schedule-search-result]")).toHaveLength(1);
    expect(root.querySelector("[data-schedule-search-result]")?.textContent).toContain(
      "NOVA",
    );

    expect(updateScheduleSearch(root, "not airing")).toEqual({
      query: "not airing",
      showings: 0,
      days: 0,
    });
    expect(root.querySelectorAll("[data-schedule-search-result]")).toHaveLength(0);
    expect(root.querySelector<HTMLElement>("[data-schedule-search-empty]")?.hidden).toBe(
      false,
    );
    expect(root.querySelector("[data-schedule-search-empty-copy]")?.textContent).toBe(
      'No showings found for “not airing.” Try another program or episode title.',
    );
    expect(root.querySelector("[data-schedule-search-status]")?.textContent).toBe(
      'No showings found for “not airing.”',
    );
  });

  it("shows the visual now line only on the active Eastern date", () => {
    const root = mount();
    const line = root.querySelector<HTMLElement>("[data-schedule-now-line]")!;

    expect(
      updateScheduleNowLine(
        root,
        "2026-07-10",
        new Date("2026-07-11T00:17:00Z"),
      ),
    ).toBe(true);
    expect(line.hidden).toBe(false);
    expect(line.getAttribute("aria-hidden")).toBe("true");
    expect(line.style.getPropertyValue("--schedule-now-minute")).toBe("");
    expect(line.style.getPropertyValue("--schedule-desktop-top")).toBe("2920.8px");
    expect(line.style.getPropertyValue("--schedule-mobile-top")).toBe("2799.1px");
    expect(line.querySelector("[data-schedule-now-label]")?.textContent).toBe(
      "8:17 p.m. · Now",
    );

    expect(
      updateScheduleNowLine(
        root,
        "2026-07-11",
        new Date("2026-07-11T00:17:00Z"),
      ),
    ).toBe(false);
    expect(line.hidden).toBe(true);
  });

  it("chooses the current day now target and selected-day primetime target", () => {
    const root = mount();
    const nowTarget = resolveJumpToNowTarget(
      root,
      ["2026-07-10", "2026-07-11"],
      new Date("2026-07-11T00:17:00Z"),
    );
    expect(nowTarget?.date).toBe("2026-07-10");
    expect(nowTarget?.element.matches("[data-schedule-now-line]")).toBe(true);

    const primeTarget = resolvePrimetimeTarget(root, "2026-07-11");
    expect(primeTarget?.date).toBe("2026-07-11");
    expect(primeTarget?.element.matches("[data-schedule-primetime]")).toBe(true);
  });

  it("uses smooth scrolling only when motion is allowed", () => {
    const root = mount();
    expect(getScheduleScrollBehavior(root, false)).toBe("smooth");
    expect(getScheduleScrollBehavior(root, true)).toBe("auto");
    document.documentElement.setAttribute("data-motion", "off");
    expect(getScheduleScrollBehavior(root, false)).toBe("auto");
  });

  it("copies program data into one dialog with an honest description fallback", () => {
    document.body.innerHTML = `
      <button
        data-program-details
        data-program-title="Nature"
        data-program-episode="Wild hope"
        data-program-time="8:00–9:00 p.m. ET"
        data-program-meta="60 min · HD · CC"
        data-program-description="A wildlife story."
        data-program-episode-description="Whale song, and the lemur that sings back."
      ></button>
      <dialog data-program-dialog>
        <h2 data-program-dialog-title></h2>
        <p data-program-dialog-episode></p>
        <p data-program-dialog-time></p>
        <p data-program-dialog-meta></p>
        <p data-program-dialog-episode-description hidden>
          <span class="sr-only">This episode:</span>
          <span data-program-dialog-episode-description-text></span>
        </p>
        <p><span class="sr-only">About the series:</span><span data-program-dialog-description></span></p>
      </dialog>
    `;
    const button = document.querySelector<HTMLElement>("[data-program-details]")!;
    const dialog = document.querySelector<HTMLDialogElement>("[data-program-dialog]")!;

    expect(populateProgramDialog(dialog, button)).toBe(true);
    expect(dialog.querySelector("[data-program-dialog-title]")?.textContent).toBe("Nature");
    expect(dialog.querySelector("[data-program-dialog-episode]")?.textContent).toBe("Wild hope");
    expect(dialog.querySelector("[data-program-dialog-time]")?.textContent).toBe(
      "8:00–9:00 p.m. ET",
    );
    expect(dialog.querySelector("[data-program-dialog-meta]")?.textContent).toBe(
      "60 min · HD · CC",
    );
    expect(dialog.querySelector("[data-program-dialog-description]")?.textContent).toBe(
      "A wildlife story.",
    );
    // The airing's own synopsis is what a viewer opens the dialog for, so it shows
    // above the series blurb rather than replacing it.
    const episodeDescription = dialog.querySelector<HTMLElement>(
      "[data-program-dialog-episode-description]",
    );
    expect(
      episodeDescription?.querySelector("[data-program-dialog-episode-description-text]")
        ?.textContent,
    ).toBe("Whale song, and the lemur that sings back.");
    expect(episodeDescription?.hidden).toBe(false);
    // The label naming which paragraph is which is the only thing separating the two
    // synopses for a screen reader, so writing the text must not overwrite it.
    expect(episodeDescription?.querySelector(".sr-only")?.textContent).toBe(
      "This episode:",
    );
    // Populating does not open. Opening is the caller's, because only the caller
    // knows which button was pressed, and the modal controller needs that element
    // to return focus there on close.
    expect(dialog.open).toBe(false);

    delete button.dataset.programDescription;
    populateProgramDialog(dialog, button);
    expect(dialog.querySelector("[data-program-dialog-description]")?.textContent).toBe(
      "A program description is not available in the feed.",
    );

    // Most listings carry no episode synopsis at all. The line is hidden rather than
    // left as an empty paragraph, so the dialog does not open with a gap where the
    // interesting sentence would be.
    delete button.dataset.programEpisodeDescription;
    populateProgramDialog(dialog, button);
    expect(
      dialog.querySelector<HTMLElement>("[data-program-dialog-episode-description]")?.hidden,
    ).toBe(true);
  });

  // The return value is what stops a half-filled dialog from opening, so it has to
  // be false for every missing piece, not merely for the one case that happened to
  // get tested. Each slot is dropped in turn rather than checking a single sample.
  it("reports failure when the dialog or the button is missing a required piece", () => {
    const SLOTS = [
      "title",
      "episode",
      "time",
      "meta",
      "episode-description",
      "episode-description-text",
      "description",
    ];

    function build(): { dialog: HTMLDialogElement; button: HTMLElement } {
      document.body.replaceChildren();
      const button = document.createElement("button");
      button.setAttribute("data-program-details", "");
      button.dataset.programTitle = "Nature";
      const dialog = document.createElement("dialog");
      dialog.setAttribute("data-program-dialog", "");
      for (const slot of SLOTS) {
        const el = document.createElement("p");
        el.setAttribute(`data-program-dialog-${slot}`, "");
        dialog.append(el);
      }
      document.body.append(button, dialog);
      return { dialog, button };
    }

    for (const missing of SLOTS) {
      const { dialog, button } = build();
      dialog.querySelector(`[data-program-dialog-${missing}]`)!.remove();
      expect(
        populateProgramDialog(dialog, button),
        `a dialog missing its ${missing} slot must not report success`,
      ).toBe(false);
    }

    // A button carrying no program title has nothing to show, however complete the
    // dialog markup is.
    const { dialog, button } = build();
    delete button.dataset.programTitle;
    expect(populateProgramDialog(dialog, button)).toBe(false);

    // And the fully-formed case still succeeds, so the loop above is proving the
    // guard rather than a build() that never works.
    const ok = build();
    expect(populateProgramDialog(ok.dialog, ok.button)).toBe(true);
  });
});
