import type { Loader } from "astro/loaders";
import committedSpotlight from "../data/spotlight-news.json";
import { dataHubPageEnabled } from "./build-target";
import { loadSpotlightNewsData } from "./spotlight-news-data";
import { parseSpotlightReportingSnapshot } from "../../../packages/content-core/src/data-hub-reporting-sources.ts";

/** Full builds capture the existing provider file during content loading.
 * Callable renderers receive only their sealed context and never import Node I/O. */
export async function loadDataHubReportingSnapshot(env: Record<string,string | undefined> = process.env) {
  try {
    const data = await loadSpotlightNewsData(committedSpotlight,env) as typeof committedSpotlight & {dataHubReporting?:unknown};
    return parseSpotlightReportingSnapshot(data.dataHubReporting);
  } catch { return undefined; }
}

export function dataHubReportingLoader(): Loader {
  return {name:"public-data-hub-reporting",load:async ({store,parseData}) => {
    store.clear();
    if (!dataHubPageEnabled(process.env)) return;
    const data = await loadDataHubReportingSnapshot();
    if (data) store.set({id:"reporting",data:await parseData({id:"reporting",data:{...data}})});
  }};
}
