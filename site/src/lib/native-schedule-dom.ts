import {
  easternStartMinute,
  formatScheduleDateLabel,
  formatScheduleTime,
} from "./schedule-timeline.ts";
import {
  resolveScheduleClock,
  scheduleDateKey,
} from "./schedule-view.ts";
import {
  matchesScheduleSearch,
  normalizeScheduleSearchText,
} from "./schedule-search.ts";

export interface ScheduleScrollTarget {
  readonly date: string;
  readonly element: HTMLElement;
}

export interface ScheduleSearchSummary {
  readonly query: string;
  readonly showings: number;
  readonly days: number;
}

export interface ScheduleDateGridVisibility {
  readonly isDesktop: boolean;
  readonly isSticky: boolean;
  readonly forceExpanded: boolean;
  readonly preserveFocusedDate: boolean;
}

export interface ScheduleToolbarStickyState {
  readonly sentinelTop: number;
  readonly headerHeight: number;
  readonly datesCollapsed: boolean;
  readonly expandedToolbarHeight: number;
  readonly toolbarHeight: number;
}

export function resolveInitialScheduleDate(
  dates: readonly string[],
  search: string,
  realNow: Date,
): string | null {
  const first = dates[0] ?? null;
  if (!first) return null;

  const mockTime = new URLSearchParams(search).get("mock-time");
  if (mockTime) {
    const mock = resolveScheduleClock(new Date(Number.NaN), mockTime);
    if (!Number.isNaN(mock.getTime())) {
      const mockDate = scheduleDateKey(mock);
      return dates.includes(mockDate) ? mockDate : null;
    }
  }

  const currentDate = scheduleDateKey(realNow);
  return dates.includes(currentDate) ? currentDate : null;
}

export function activateInitialScheduleState(
  root: HTMLElement,
  dates: readonly string[],
  search: string,
  realNow: Date,
): boolean {
  const selectedDate = resolveInitialScheduleDate(dates, search, realNow);
  if (selectedDate) return activateScheduleDay(root, selectedDate);
  if (dates.length === 0) return false;

  const mockTime = new URLSearchParams(search).get("mock-time");
  return activateExpiredScheduleWindow(
    root,
    resolveScheduleClock(realNow, mockTime),
  );
}

export function activateScheduleDay(root: HTMLElement, date: string): boolean {
  if (root.dataset.scheduleWindowExpired === "true") return false;

  const host = root.querySelector<HTMLElement>("[data-schedule-panel-host]");
  const template = findTemplate(root, date);
  const dateLabel = root.querySelector<HTMLElement>("[data-schedule-active-date]");
  const count = root.querySelector<HTMLElement>("[data-schedule-active-count]");
  const announcer = root.querySelector<HTMLElement>("[data-schedule-announcer]");
  const select = root.querySelector<HTMLSelectElement>("[data-schedule-day-select]");
  if (!host || !template || !dateLabel || !count || !announcer || !select) {
    return false;
  }

  const panel = template.content.querySelector<HTMLElement>(
    `[data-schedule-day-panel][data-schedule-date="${date}"]`,
  );
  const label = template.dataset.scheduleDateLabel;
  const programCount = template.dataset.scheduleCount;
  if (!panel || !label || !programCount) return false;

  host.replaceChildren(panel.cloneNode(true));
  root.querySelectorAll<HTMLElement>("[data-schedule-day]").forEach((button) => {
    if (button.dataset.scheduleDate === date) {
      button.setAttribute("aria-current", "date");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  select.value = date;
  dateLabel.textContent = label;
  count.textContent = programCount;
  announcer.textContent = `Showing ${label}, ${programCount}.`;
  root.dataset.scheduleActiveDate = date;
  delete root.dataset.scheduleWindowExpired;
  setScheduleDayControlsDisabled(root, false);
  setScheduleShortcutsDisabled(root, false);
  return true;
}

export function activateExpiredScheduleWindow(
  root: HTMLElement,
  at: Date,
): boolean {
  const host = root.querySelector<HTMLElement>("[data-schedule-panel-host]");
  const panel = host?.querySelector<HTMLElement>("[data-schedule-day-panel]");
  const dateLabel = root.querySelector<HTMLElement>("[data-schedule-active-date]");
  const count = root.querySelector<HTMLElement>("[data-schedule-active-count]");
  const announcer = root.querySelector<HTMLElement>("[data-schedule-announcer]");
  const select = root.querySelector<HTMLSelectElement>("[data-schedule-day-select]");
  const empty = panel?.querySelector<HTMLElement>("[data-schedule-empty-state]");

  if (!host || !panel || !dateLabel || !count || !announcer || !select || !empty) {
    return false;
  }

  const date = scheduleDateKey(at);
  const label = formatScheduleDateLabel(date);
  const headingMeta = panel.querySelector<HTMLElement>(".schedule-board-heading p");
  const timeline = panel.querySelector<HTMLElement>("[data-schedule-timeline]");
  const nowLine = panel.querySelector<HTMLElement>("[data-schedule-now-line]");
  const kidsList = panel.querySelector<HTMLElement>(".schedule-kids__list");
  const kidsEmpty = panel.querySelector<HTMLElement>("[data-kids-empty-state]");

  panel.dataset.scheduleDate = date;
  panel.setAttribute("aria-label", `NJ PBS schedule for ${label}`);
  if (headingMeta) headingMeta.textContent = "0 programs · current listings unavailable · ET";
  if (timeline) timeline.hidden = true;
  if (nowLine) nowLine.hidden = true;
  if (kidsList) kidsList.hidden = true;
  if (kidsEmpty) {
    setKidsUnavailableCopy(kidsEmpty);
    kidsEmpty.hidden = false;
  }
  empty.hidden = false;

  root.querySelectorAll<HTMLElement>("[data-schedule-day]").forEach((button) => {
    button.removeAttribute("aria-current");
  });
  select.selectedIndex = -1;
  dateLabel.textContent = label;
  count.textContent = "0 programs";
  announcer.textContent = `Showing ${label}, 0 programs. Listings are temporarily unavailable.`;
  root.dataset.scheduleActiveDate = date;
  root.dataset.scheduleWindowExpired = "true";
  setScheduleDayControlsDisabled(root, true);
  setScheduleShortcutsDisabled(root, true);
  return true;
}

export function updateScheduleNowLine(
  root: HTMLElement,
  activeDate: string,
  at: Date,
): boolean {
  const line = root.querySelector<HTMLElement>("[data-schedule-now-line]");
  if (!line) return false;
  line.hidden = true;

  if (scheduleDateKey(at) !== activeDate) return false;
  const label = line.querySelector<HTMLElement>("[data-schedule-now-label]");
  const minute = easternStartMinute(at.toISOString());
  if (!label || !Number.isFinite(minute)) return false;

  line.style.setProperty("--schedule-desktop-top", `${(minute * 2.4).toFixed(1)}px`);
  line.style.setProperty("--schedule-mobile-top", `${(minute * 2.3).toFixed(1)}px`);
  label.textContent = `${formatScheduleTime(at.toISOString())} · Now`;
  line.hidden = false;
  return true;
}

export function resolveJumpToNowTarget(
  root: HTMLElement,
  dates: readonly string[],
  at: Date,
): ScheduleScrollTarget | null {
  const date = scheduleDateKey(at);
  if (!dates.includes(date) || !activateScheduleDay(root, date)) return null;
  if (!updateScheduleNowLine(root, date, at)) return null;
  const element = root.querySelector<HTMLElement>("[data-schedule-now-line]");
  return element ? { date, element } : null;
}

export function resolvePrimetimeTarget(
  root: HTMLElement,
  date: string,
): ScheduleScrollTarget | null {
  if (!activateScheduleDay(root, date)) return null;
  const element = root.querySelector<HTMLElement>("[data-schedule-primetime]");
  return element ? { date, element } : null;
}

export function getScheduleScrollBehavior(
  root: HTMLElement,
  prefersReducedMotion: boolean,
): ScrollBehavior {
  const motionOff =
    root.ownerDocument.documentElement.getAttribute("data-motion") === "off";
  return prefersReducedMotion || motionOff ? "auto" : "smooth";
}

export function resolveScheduleToolbarSticky(
  state: ScheduleToolbarStickyState,
): boolean {
  const stickyThreshold = state.headerHeight + 1;
  if (state.sentinelTop <= stickyThreshold) return true;
  if (!state.datesCollapsed) return false;

  const collapsedHeightDelta = Math.max(
    0,
    state.expandedToolbarHeight - state.toolbarHeight,
  );
  return state.sentinelTop <= stickyThreshold + collapsedHeightDelta;
}

export function updateScheduleDateGridVisibility(
  root: HTMLElement,
  state: ScheduleDateGridVisibility,
): boolean {
  const grid = root.querySelector<HTMLElement>("[data-schedule-date-grid]");
  const toggle = root.querySelector<HTMLButtonElement>(
    "[data-schedule-dates-toggle]",
  );
  if (!grid || !toggle) return false;

  const focusWithinDates =
    state.preserveFocusedDate &&
    grid.contains(root.ownerDocument.activeElement);
  const collapsed =
    state.isDesktop &&
    state.isSticky &&
    !state.forceExpanded &&
    !focusWithinDates;
  const hideToggle = !state.isDesktop || !state.isSticky;
  const moveFocusFromCollapsedDate =
    collapsed && grid.contains(root.ownerDocument.activeElement);

  if (hideToggle && root.ownerDocument.activeElement === toggle) {
    const select = root.querySelector<HTMLSelectElement>("[data-schedule-day-select]");
    const heading = root.querySelector<HTMLElement>("#schedule-page-title");
    const toolbar = root.querySelector<HTMLElement>("[data-schedule-day-switcher]");
    const headingRect = heading?.getBoundingClientRect();
    const viewportHeight = root.ownerDocument.defaultView?.innerHeight ?? 0;
    const headingIsVisible = Boolean(
      headingRect && headingRect.bottom > 0 && headingRect.top < viewportHeight,
    );
    const focusTarget = !state.isDesktop && select && !select.disabled
      ? select
      : headingIsVisible
        ? heading
        : toolbar ?? heading;
    focusTarget?.focus({ preventScroll: true });
  }

  root.dataset.scheduleDatesCollapsed = collapsed ? "true" : "false";
  toggle.hidden = hideToggle;
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.textContent = collapsed ? "Show dates" : "Hide dates";
  if (moveFocusFromCollapsedDate) toggle.focus({ preventScroll: true });
  return collapsed;
}

export function updateScheduleSearch(
  root: HTMLElement,
  value: string,
): ScheduleSearchSummary | null {
  const input = root.querySelector<HTMLInputElement>("[data-schedule-search-input]");
  const clear = root.querySelector<HTMLButtonElement>("[data-schedule-search-clear]");
  const status = root.querySelector<HTMLElement>("[data-schedule-search-status]");
  const host = root.querySelector<HTMLElement>("[data-schedule-panel-host]");
  const results = root.querySelector<HTMLElement>("[data-schedule-search-results]");
  const groups = root.querySelector<HTMLElement>("[data-schedule-search-groups]");
  const empty = root.querySelector<HTMLElement>("[data-schedule-search-empty]");
  const emptyCopy = root.querySelector<HTMLElement>(
    "[data-schedule-search-empty-copy]",
  );
  if (!input || !clear || !status || !host || !results || !groups || !empty || !emptyCopy) {
    return null;
  }

  const query = normalizeScheduleSearchText(value);
  input.value = value;
  if (!query) {
    clearScheduleSearch(root);
    return { query: "", showings: 0, days: 0 };
  }

  groups.replaceChildren();
  let showings = 0;
  let days = 0;
  const templates = root.querySelectorAll<HTMLTemplateElement>(
    "template[data-schedule-day-template]",
  );

  for (const template of templates) {
    const date = template.dataset.scheduleDate;
    const dateLabel = template.dataset.scheduleDateLabel;
    if (!date || !dateLabel) continue;

    const matches = Array.from(
      template.content.querySelectorAll<HTMLElement>("[data-program-details]"),
    ).filter((button) =>
      matchesScheduleSearch(
        {
          title: button.dataset.programTitle ?? "",
          episodeTitle: button.dataset.programEpisode,
        },
        query,
      ),
    );
    if (matches.length === 0) continue;

    days += 1;
    showings += matches.length;
    groups.append(buildScheduleSearchGroup(root.ownerDocument, date, dateLabel, matches));
  }

  host.hidden = true;
  results.hidden = false;
  clear.hidden = false;
  empty.hidden = showings > 0;
  if (showings === 0) {
    status.textContent = `No showings found for “${query}.”`;
    emptyCopy.textContent = `${status.textContent} Try another program or episode title.`;
  } else {
    status.textContent = formatScheduleSearchSummary(showings, days);
    emptyCopy.textContent = "";
  }

  return { query, showings, days };
}

export function clearScheduleSearch(root: HTMLElement): boolean {
  const input = root.querySelector<HTMLInputElement>("[data-schedule-search-input]");
  const clear = root.querySelector<HTMLButtonElement>("[data-schedule-search-clear]");
  const status = root.querySelector<HTMLElement>("[data-schedule-search-status]");
  const host = root.querySelector<HTMLElement>("[data-schedule-panel-host]");
  const results = root.querySelector<HTMLElement>("[data-schedule-search-results]");
  const groups = root.querySelector<HTMLElement>("[data-schedule-search-groups]");
  const empty = root.querySelector<HTMLElement>("[data-schedule-search-empty]");
  const templates = root.querySelectorAll("template[data-schedule-day-template]");
  if (!input || !clear || !status || !host || !results || !groups || !empty) {
    return false;
  }

  input.value = "";
  clear.hidden = true;
  host.hidden = false;
  results.hidden = true;
  groups.replaceChildren();
  empty.hidden = true;
  status.textContent = `Search all ${templates.length} days.`;
  return true;
}

/**
 * Fill the program dialog from a schedule button's data attributes.
 *
 * Populating only. Opening belongs to the caller, which holds the modal
 * controller and, unlike this function, knows which button was pressed -- the
 * controller needs that element to return focus there on close. Returns false
 * when the markup or the button is missing a required piece, so the caller can
 * decline to open a dialog it would show empty.
 */
export function populateProgramDialog(
  dialog: HTMLDialogElement,
  button: HTMLElement,
): boolean {
  const title = dialog.querySelector<HTMLElement>("[data-program-dialog-title]");
  const episode = dialog.querySelector<HTMLElement>("[data-program-dialog-episode]");
  const time = dialog.querySelector<HTMLElement>("[data-program-dialog-time]");
  const meta = dialog.querySelector<HTMLElement>("[data-program-dialog-meta]");
  const description = dialog.querySelector<HTMLElement>(
    "[data-program-dialog-description]",
  );
  const episodeDescription = dialog.querySelector<HTMLElement>(
    "[data-program-dialog-episode-description]",
  );
  const episodeDescriptionText = dialog.querySelector<HTMLElement>(
    "[data-program-dialog-episode-description-text]",
  );
  const programTitle = button.dataset.programTitle;
  if (
    !title || !episode || !time || !meta || !description ||
    !episodeDescription || !episodeDescriptionText || !programTitle
  ) {
    return false;
  }

  title.textContent = programTitle;
  episode.textContent = button.dataset.programEpisode ?? "";
  episode.hidden = !button.dataset.programEpisode;
  time.textContent = button.dataset.programTime ?? "Time unavailable";
  meta.textContent = button.dataset.programMeta ?? "Program details unavailable";
  // What this airing is about goes first, because that is the question a viewer
  // deciding whether to watch tonight is asking. The series blurb stays underneath
  // for anyone meeting the show for the first time. The text lands on the inner
  // span so the sr-only label naming which paragraph is which survives the write.
  episodeDescriptionText.textContent =
    button.dataset.programEpisodeDescription ?? "";
  episodeDescription.hidden = !button.dataset.programEpisodeDescription;
  description.textContent =
    button.dataset.programDescription ??
    "A program description is not available in the feed.";

  return true;
}

function findTemplate(
  root: HTMLElement,
  date: string,
): HTMLTemplateElement | null {
  return Array.from(
    root.querySelectorAll<HTMLTemplateElement>("template[data-schedule-day-template]"),
  ).find((template) => template.dataset.scheduleDate === date) ?? null;
}

function buildScheduleSearchGroup(
  document: Document,
  date: string,
  dateLabel: string,
  matches: readonly HTMLElement[],
): HTMLElement {
  const group = document.createElement("section");
  group.className = "schedule-search-group";
  group.dataset.scheduleSearchGroup = "";
  group.setAttribute("aria-labelledby", `schedule-search-day-${date}`);

  const heading = document.createElement("h3");
  heading.id = `schedule-search-day-${date}`;
  heading.textContent = dateLabel;
  const count = document.createElement("p");
  count.textContent = `${matches.length} ${matches.length === 1 ? "showing" : "showings"}`;
  const headingRow = document.createElement("div");
  headingRow.className = "schedule-search-group__heading";
  headingRow.append(heading, count);

  const list = document.createElement("ol");
  list.className = "schedule-search-group__list";
  for (const match of matches) {
    const item = document.createElement("li");
    item.dataset.scheduleSearchResult = "";
    const button = match.cloneNode(true) as HTMLElement;
    button.classList.add("schedule-search-result__button");
    item.append(button);
    list.append(item);
  }

  group.append(headingRow, list);
  return group;
}

function formatScheduleSearchSummary(showings: number, days: number): string {
  if (showings === 1) return "1 showing on 1 day.";
  if (days === 1) return `${showings} showings on 1 day.`;
  return `${showings} showings across ${days} days.`;
}

function setScheduleShortcutsDisabled(root: HTMLElement, disabled: boolean): void {
  root
    .querySelectorAll<HTMLButtonElement>(
      "[data-schedule-jump-now], [data-schedule-jump-prime]",
    )
    .forEach((button) => {
      button.disabled = disabled;
    });
}

function setScheduleDayControlsDisabled(root: HTMLElement, disabled: boolean): void {
  root
    .querySelectorAll<HTMLButtonElement>("[data-schedule-day]")
    .forEach((button) => {
      button.disabled = disabled;
    });

  const select = root.querySelector<HTMLSelectElement>("[data-schedule-day-select]");
  if (select) select.disabled = disabled;
}

function setKidsUnavailableCopy(kidsEmpty: HTMLElement): void {
  const headline = kidsEmpty.querySelector<HTMLElement>("strong");
  const detail = kidsEmpty.querySelector<HTMLElement>("span");
  if (headline && detail) {
    headline.textContent = "Kids listings are temporarily unavailable.";
    detail.textContent = "PBS Kids 24/7 livestream is still available.";
    return;
  }

  kidsEmpty.textContent =
    "Kids listings are temporarily unavailable. PBS Kids 24/7 livestream is still available.";
}
