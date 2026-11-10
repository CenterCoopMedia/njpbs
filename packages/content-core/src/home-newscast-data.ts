import { HOME_NEWSCAST_SHOW_ID } from "./home-newscast-source.ts";
import { homeSourceObject } from "./home-source-curation.ts";

export const HOME_NEWSCAST_LAYOUTS = ["feature", "compact"] as const;
export type HomeNewscastLayout = (typeof HOME_NEWSCAST_LAYOUTS)[number];
export interface HomeNewscastData {
  showId: typeof HOME_NEWSCAST_SHOW_ID;
  heading: string;
  summary: string;
  layout: HomeNewscastLayout;
  watchLabel: string;
  pastLabel: string;
  liveLabel: string;
}
export const HOME_NEWSCAST_DEFAULTS: HomeNewscastData = Object.freeze({
  showId: HOME_NEWSCAST_SHOW_ID, heading: "Latest newscast", summary: "", layout: "feature",
  watchLabel: "Watch the latest", pastLabel: "Past newscasts", liveLabel: "Watch live",
});
export function isHomeNewscastData(value: unknown, complete: boolean): value is HomeNewscastData {
  if (!homeSourceObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== 7 || Reflect.ownKeys(value).some(key => typeof key !== "string" ||
      !["showId", "heading", "summary", "layout", "watchLabel", "pastLabel", "liveLabel"].includes(key)) ||
      value.showId !== HOME_NEWSCAST_SHOW_ID || !HOME_NEWSCAST_LAYOUTS.includes(value.layout as HomeNewscastLayout)) return false;
  return ["heading", "watchLabel", "pastLabel", "liveLabel"].every(key => typeof value[key] === "string" &&
    value[key].length <= 120 && !/[\u0000-\u001f\u007f]/.test(value[key]) && (!complete || !!value[key].trim())) &&
    typeof value.summary === "string" && value.summary.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(value.summary);
}
