import type { HomepageBannerSchedule } from "./cms-settings";
import { homepageBannerWindow } from "./homepage-banner-window";

export interface ElectionBannerSchedule extends HomepageBannerSchedule {
  enabled?: boolean;
  njDecides?: boolean;
}

/** Match the canonical page, including aliases that render the same destination. */
export function electionBannerExcluded(excludedPaths: readonly string[] | undefined, path: string): boolean {
  const canonical = path.endsWith("/") ? path : `${path}/`;
  return excludedPaths?.includes(canonical) ?? false;
}

export function electionBannerWindow(setting: ElectionBannerSchedule, now: number) {
  return homepageBannerWindow({ ...setting, enabled: setting.enabled === true && setting.njDecides === true }, now);
}
