export interface ElectionBannerSchedule {
  enabled?: boolean;
  njDecides?: boolean;
  startsAt?: string;
  endsAt?: string;
}

/** Match the canonical page, including aliases that render the same destination. */
export function electionBannerExcluded(excludedPaths: readonly string[] | undefined, path: string): boolean {
  const canonical = path.endsWith("/") ? path : `${path}/`;
  return excludedPaths?.includes(canonical) ?? false;
}

/** One clock rule serves built HTML and already-open browser tabs. */
export function electionBannerWindow(setting: ElectionBannerSchedule, now: number) {
  const instant = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
  };
  const start = instant(setting.startsAt);
  const end = instant(setting.endsAt);
  if (setting.enabled !== true || setting.njDecides !== true || !Number.isFinite(now) ||
      Number.isNaN(start) || Number.isNaN(end) ||
      (start !== undefined && end !== undefined && start >= end)) {
    return { visible: false, nextBoundary: undefined };
  }
  return {
    visible: (start === undefined || now >= start) && (end === undefined || now < end),
    nextBoundary: [start, end].filter((time): time is number => time !== undefined && time > now)
      .sort((a, b) => a - b)[0],
  };
}
