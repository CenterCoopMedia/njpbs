import { DATA_HUB_FIGURES, emptyReportingMapping, parseDataHubReporting, selectReportingStories,
  type DataHubReporting, type ReportingStory } from "../../../packages/content-core/src/data-hub-reporting.ts";
import { parseSpotlightReportingSnapshot, spotlightReportingFor } from "../../../packages/content-core/src/data-hub-reporting-sources.ts";

/** Replace the staff-owned reporting payload and its status in the compiled reader. */
export function dataHubReportingHtml(html: string, rawConfig: unknown, posts: readonly ReportingStory[], rawSpotlight: unknown, cutoffAt: number): string {
  const config = parseDataHubReporting(rawConfig);
  if (!config) return html;
  let spotlight: ReturnType<typeof parseSpotlightReportingSnapshot>;
  try { spotlight = parseSpotlightReportingSnapshot(rawSpotlight); } catch { /* A failed optional source cannot suppress the figures. */ }
  const rows = (mapping: ReturnType<typeof emptyReportingMapping>) => selectReportingStories(mapping,
    [...posts, ...spotlightReportingFor(mapping, spotlight).stories], cutoffAt).map(story => ({
      publication: story.source === "posts" ? "NJ PBS" : "NJ Spotlight News", title: story.title, href: story.href,
      publishedDay: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(story.publishedAt)), ...(story.byline ? { byline: story.byline } : {}), ...(story.note ? { connection: story.note } : {}),
    }));
  const reporting = Object.fromEntries(Object.keys(DATA_HUB_FIGURES).map(id => [id, rows(config.figures[id as keyof DataHubReporting["figures"]] ?? emptyReportingMapping())]));
  const payload = JSON.stringify({ schemaVersion: 1, reporting, featuredReporting: config.featured.inheritFigure
    ? reporting.minimumwage : rows(config.featured.mapping) }).replace(/</g,"\\u003c").replace(/>/g,"\\u003e").replace(/&/g,"\\u0026");
  const pattern = /(<script\b[^>]*\bid="editorial-data"[^>]*>)[\s\S]*?(<\/script>)/;
  if (!pattern.test(html)) throw new Error("The compiled Data Hub reporting slot is missing.");
  return html.replace(pattern, (_whole, open, close) => `${open}${payload}${close}`)
    .replace(/(<p\b[^>]*\bid="reporting-status"[^>]*>)[\s\S]*?(<\/p>)/,
      "$1Related NJ PBS and NJ Spotlight News reporting refreshes from staff-selected topics.$2");
}
