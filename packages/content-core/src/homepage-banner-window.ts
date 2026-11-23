import type { HomepageBannerSchedule } from "./cms-settings";

function instant(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

/** One clock rule serves rendered HTML and already-open browser tabs. */
export function homepageBannerWindow(setting: HomepageBannerSchedule & { enabled?: boolean }, now: number) {
  const start = instant(setting.startsAt);
  const end = instant(setting.endsAt);
  if (setting.enabled !== true || !Number.isFinite(now) ||
      Number.isNaN(start) || Number.isNaN(end) ||
      (start !== undefined && end !== undefined && start >= end)) {
    return { visible: false, nextBoundary: undefined };
  }
  return {
    visible: (start === undefined || now >= start) && (end === undefined || now < end),
    nextBoundary: [start, end].find(time => time !== undefined && time > now),
  };
}
