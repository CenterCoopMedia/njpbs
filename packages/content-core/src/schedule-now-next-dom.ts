import type { ScheduleDay, ScheduleEntry } from "./schedule-now-next.ts";
import {
  getScheduleClockState,
  resolveScheduleClock,
  SCHEDULE_TIME_ZONE,
} from "./schedule-clock.ts";

const MINUTE_MS = 60_000;
const clockFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

interface NowNextHooks {
  readonly fallback: HTMLElement;
  readonly fallbackMessage: HTMLElement;
  readonly ready: HTMLElement;
  readonly currentProgram: HTMLElement;
  readonly currentTime: HTMLElement;
  readonly upNextProgram: HTMLElement;
  readonly upNextTime: HTMLElement;
  readonly elapsed: HTMLElement;
  readonly remaining: HTMLElement;
  readonly progress: HTMLElement;
  readonly gapLink: HTMLElement | null;
}

export interface ResolvedNowNextClock {
  readonly at: Date;
  readonly fixed: boolean;
}

export function readNowNextDays(
  root: HTMLElement,
): readonly ScheduleDay[] | null {
  const node = root.nextElementSibling;
  if (
    !(node instanceof HTMLScriptElement) ||
    !node.matches('script[type="application/json"][data-now-next-data]')
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(node.textContent ?? "");
    return Array.isArray(parsed) ? (parsed as readonly ScheduleDay[]) : null;
  } catch {
    return null;
  }
}

export function resolveNowNextClock(
  search: string,
  realNow: Date,
): ResolvedNowNextClock {
  const mockTime = new URLSearchParams(search).get("mock-time");
  const validityProbe = resolveScheduleClock(new Date(Number.NaN), mockTime);
  const fixed = !Number.isNaN(validityProbe.getTime());
  return {
    at: resolveScheduleClock(realNow, mockTime),
    fixed,
  };
}

export function renderScheduleNowNext(
  root: HTMLElement,
  days: readonly ScheduleDay[],
  at: Date,
): boolean {
  const hooks = readHooks(root);
  if (!hooks) return false;

  const state = getScheduleClockState(days, at);
  if (!state || (!state.onNow && !state.upNext)) {
    showFallback(hooks);
    return false;
  }

  if (state.onNow) {
    const durationMinutes = Math.max(
      1,
      Math.round(
        (Date.parse(state.onNow.endsAt) - Date.parse(state.onNow.startsAt)) /
          MINUTE_MS,
      ),
    );
    const elapsedMinutes = Math.min(
      durationMinutes,
      Math.max(0, Math.floor(state.elapsedMinutes)),
    );
    const remainingMinutes = Math.max(0, Math.ceil(state.remainingMinutes));
    const progressPercent = Math.min(
      100,
      Math.max(0, state.progressPercent),
    );

    hooks.currentProgram.textContent = formatProgram(state.onNow);
    hooks.currentTime.textContent = formatRange(state.onNow);
    if (hooks.gapLink) hooks.gapLink.hidden = true;
    hooks.elapsed.textContent = `${elapsedMinutes} min elapsed`;
    hooks.remaining.textContent = `${remainingMinutes} min remaining`;
    hooks.progress.setAttribute("aria-valuemax", String(durationMinutes));
    hooks.progress.setAttribute("aria-valuenow", String(elapsedMinutes));
    hooks.progress.setAttribute(
      "aria-valuetext",
      `${elapsedMinutes} minutes elapsed; ${remainingMinutes} minutes remaining`,
    );
    hooks.progress.style.setProperty(
      "--now-next-progress",
      `${progressPercent}%`,
    );
  } else {
    hooks.currentProgram.textContent = "Current listing unavailable";
    hooks.currentTime.textContent = "No program is listed at this time.";
    if (hooks.gapLink) hooks.gapLink.hidden = false;
    hooks.elapsed.textContent = "0 min elapsed";
    hooks.remaining.textContent = "0 min remaining";
    hooks.progress.setAttribute("aria-valuemax", "100");
    hooks.progress.setAttribute("aria-valuenow", "0");
    hooks.progress.setAttribute(
      "aria-valuetext",
      "No current program is listed",
    );
    hooks.progress.style.setProperty("--now-next-progress", "0%");
  }

  if (state.upNext) {
    hooks.upNextProgram.textContent = formatProgram(state.upNext);
    hooks.upNextTime.textContent = formatRange(state.upNext);
  } else {
    hooks.upNextProgram.textContent = "No later listing";
    hooks.upNextTime.textContent = "See the full schedule for more programs.";
  }

  hooks.fallback.hidden = true;
  hooks.ready.hidden = false;
  return true;
}

export function millisecondsToNextMinute(nowMs: number): number {
  const elapsedInMinute = ((nowMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS;
  return MINUTE_MS - elapsedInMinute;
}

function readHooks(root: HTMLElement): NowNextHooks | null {
  const fallback = root.querySelector<HTMLElement>("[data-now-next-fallback]");
  const fallbackMessage = root.querySelector<HTMLElement>(
    "[data-now-next-fallback-message]",
  );
  const ready = root.querySelector<HTMLElement>("[data-now-next-ready]");
  const currentProgram = root.querySelector<HTMLElement>(
    "[data-now-next-current-program]",
  );
  const currentTime = root.querySelector<HTMLElement>(
    "[data-now-next-current-time]",
  );
  const upNextProgram = root.querySelector<HTMLElement>(
    "[data-now-next-up-next-program]",
  );
  const upNextTime = root.querySelector<HTMLElement>(
    "[data-now-next-up-next-time]",
  );
  const elapsed = root.querySelector<HTMLElement>("[data-now-next-elapsed]");
  const remaining = root.querySelector<HTMLElement>(
    "[data-now-next-remaining]",
  );
  const progress = root.querySelector<HTMLElement>("[data-now-next-progress]");

  if (
    !fallback ||
    !fallbackMessage ||
    !ready ||
    !currentProgram ||
    !currentTime ||
    !upNextProgram ||
    !upNextTime ||
    !elapsed ||
    !remaining ||
    !progress
  ) {
    return null;
  }

  return {
    fallback,
    fallbackMessage,
    ready,
    currentProgram,
    currentTime,
    upNextProgram,
    upNextTime,
    elapsed,
    remaining,
    progress,
    gapLink: root.querySelector<HTMLElement>("[data-now-next-gap-link]"),
  };
}

function showFallback(hooks: NowNextHooks): void {
  hooks.fallbackMessage.textContent =
    "Current live program details are unavailable.";
  hooks.fallback.hidden = false;
  hooks.ready.hidden = true;
}

function formatClock(value: string): string {
  return clockFormatter
    .format(new Date(value))
    .replace(" AM", " a.m.")
    .replace(" PM", " p.m.");
}

function formatRange(listing: ScheduleEntry): string {
  return `${formatClock(listing.startsAt)}–${formatClock(listing.endsAt)} ET`;
}

function formatProgram(listing: ScheduleEntry): string {
  return listing.episodeTitle
    ? `${listing.title} — ${listing.episodeTitle}`
    : listing.title;
}
