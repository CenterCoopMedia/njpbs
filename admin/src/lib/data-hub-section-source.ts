import html from "../../../site/src/data/njpbs-data-hub-v16.html?raw";
import { DATA_HUB_SECTIONS, type DataHubSectionId } from "../../../packages/content-core/src/data-hub-composition";

export interface DataHubSectionSource {
  heading: string;
  introduction: string;
  display?: string;
  period?: string;
  checked?: string;
  benchmarks?: {label: string; display: string; period: string}[];
}

// This module is loaded only with Data Hub fields/previews. The approved reader
// is parsed as an inert document; none of its scripts or markup enter the editor.
const document = new DOMParser().parseFromString(html, "text/html");
const seed = JSON.parse(document.getElementById("source-data")!.textContent!) as {
  metrics: {id: string; title: string; description: string; display: string; period: string; checked: string}[];
};
const sectionSelectors = {
  introduction: ["#main-title", ".intro__lead"],
  featured: ["#featured-title", ".featured-finding__lead"],
  latest: ["#latest-findings-title", ".latest-findings__intro"],
  finder: ["#data-finder-title", ".data-finder__head p"],
  overview: ["#glance-title", ".summary__stamp"],
  collection: ["#browse-title", ".section-lead"],
  methodology: ["#methodology-title", ".notes__body p"],
} as const;
const text = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";

export function dataHubSectionSource(id: DataHubSectionId): DataHubSectionSource {
  const metric = seed.metrics.find(metric => metric.id === (id === "featured" ? "minimumwage" : id));
  const selectors = sectionSelectors[id as keyof typeof sectionSelectors];
  return {
    heading: selectors ? text(selectors[0]) || DATA_HUB_SECTIONS[id] : metric?.title ?? DATA_HUB_SECTIONS[id],
    introduction: selectors ? text(selectors[1]) : metric?.description ?? "",
    ...(metric ? { checked: metric.checked } : {}),
    ...(id === "featured" ? { benchmarks: [...document.querySelectorAll(".featured-finding__numbers > div")].map(item => ({
      label: item.querySelector("dt")!.textContent!, display: item.querySelector("dd")!.firstChild!.textContent!, period: item.querySelector("dd span")!.textContent!,
    })) } : metric ? { display: metric.display, period: metric.period } : {}),
  };
}
