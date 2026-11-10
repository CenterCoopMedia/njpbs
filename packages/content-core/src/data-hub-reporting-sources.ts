import { isPublishable } from "./publish-gate.ts";
import { editorialSortInstant } from "./editorial-dates.ts";
// Boundary helpers for the existing aggregate refresh's Spotlight input.
import { parseReportingMapping, reportingIdentity, reportingStoryUrl,
  type DataHubReporting, type ReportingMapping, type ReportingStory } from "./data-hub-reporting.ts";
export interface ReportingQuerySnapshot { checkedAt: string | null; failed: boolean; stories: ReportingStory[] }
export interface SpotlightReportingSnapshot {
  schemaVersion: 1;
  queries: Record<string, ReportingQuerySnapshot>;
  pins: ReportingQuerySnapshot & { key: string };
}
export function reportingMappings(config: DataHubReporting): ReportingMapping[] {
  return [...Object.values(config.figures), ...(config.featured.inheritFigure ? [] : [config.featured.mapping])];
}
export function reportingQueryKey(mapping: ReportingMapping): string {
  parseReportingMapping(mapping);
  return `t:${mapping.spotlight.tags.map(term => term.id).sort((a,b) => a-b).join(",")};c:${mapping.spotlight.categories.map(term => term.id).sort((a,b) => a-b).join(",")};x:${mapping.hidden.filter(item => item.source === "spotlight").map(item => Number(item.id)).sort((a,b) => a-b).join(",")}`;
}
export const reportingPinsKey = (mappings: ReportingMapping[]) => [...new Set(mappings.flatMap(mapping => mapping.pins
  .filter(pin => pin.source === "spotlight").map(pin => Number(pin.id))))].sort((a,b) => a-b).join(",");
function fail(): never { throw new Error("Invalid retained Data Hub reporting."); }
function object(value: unknown, keys?: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  if (keys && (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)))) fail();
}
function instant(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && !!value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
export function parseReportingStory(raw: unknown): ReportingStory {
  object(raw);
  const keys = ["source", "id", "href", "title", "publishedAt", "tags", "categories"];
  for (const optional of ["byline", "canonicalHref"]) if (Object.hasOwn(raw, optional)) keys.push(optional);
  object(raw, keys);
  reportingIdentity({ source: raw.source, id: raw.id });
  if (!text(raw.title,300) || !instant(raw.publishedAt) || reportingStoryUrl(raw.href) !== raw.href ||
      (raw.source === "posts" ? !String(raw.href).startsWith("https://njpbs.org/") : !String(raw.href).startsWith("https://www.njspotlightnews.org/")) ||
      raw.byline !== undefined && !text(raw.byline,300) || raw.canonicalHref !== undefined && reportingStoryUrl(raw.canonicalHref) !== raw.canonicalHref) fail();
  for (const kind of ["tags", "categories"]) {
    const terms = raw[kind];
    if (!Array.isArray(terms) || terms.length > 500 || new Set(terms).size !== terms.length || terms.some(term =>
      raw.source === "posts" ? !text(term,200) : !Number.isSafeInteger(term) || term < 1)) fail();
  }
  return structuredClone(raw) as unknown as ReportingStory;
}
export function parseSpotlightReportingSnapshot(raw: unknown): SpotlightReportingSnapshot | undefined {
  if (raw === undefined) return undefined;
  object(raw,["schemaVersion","queries","pins"]);
  if (raw.schemaVersion !== 1 || new TextEncoder().encode(JSON.stringify(raw)).length > 2*1024*1024) fail();
  object(raw.queries);
  const keys = Object.keys(raw.queries);
  if (keys.length > 19 || keys.some(key => key.length > 600 || !/^t:[0-9,]*;c:[0-9,]*;x:[0-9,]*$/.test(key))) fail();
  function query(value: unknown, pin = false) {
    object(value,pin ? ["key","checkedAt","failed","stories"] : ["checkedAt","failed","stories"]);
    if ((value.checkedAt !== null && !instant(value.checkedAt)) || typeof value.failed !== "boolean" ||
        !Array.isArray(value.stories) || value.stories.length > (pin ? 57 : 25)) fail();
    const rows = value.stories.map(parseReportingStory);
    if (rows.some(story => story.source !== "spotlight") || new Set(rows.map(story => story.id)).size !== rows.length ||
        rows.length && value.checkedAt === null) fail();
    if (pin && (typeof value.key !== "string" || value.key.length > 1000 || !/^[0-9,]*$/.test(value.key))) fail();
  }
  Object.values(raw.queries).forEach(value => query(value)); query(raw.pins,true);
  return structuredClone(raw) as unknown as SpotlightReportingSnapshot;
}
export function spotlightReportingFor(mapping: ReportingMapping, snapshot?: SpotlightReportingSnapshot): ReportingQuerySnapshot {
  const query = snapshot?.queries[reportingQueryKey(mapping)];
  const pinIds = new Set(mapping.pins.filter(pin => pin.source === "spotlight").map(pin => pin.id));
  const hasQuery = mapping.spotlight.tags.length+mapping.spotlight.categories.length > 0;
  return { checkedAt: hasQuery ? query?.checkedAt ?? null : pinIds.size ? snapshot?.pins.checkedAt ?? null : null,
    failed: Boolean(hasQuery && query?.failed || pinIds.size && snapshot?.pins.failed),
    stories: [...(query?.stories ?? []), ...(snapshot?.pins.stories.filter(story => pinIds.has(story.id)) ?? [])]
      .filter((story,index,rows) => rows.findIndex(row => row.id === story.id) === index) };
}

/** Accept only the immutable public metadata; the caller uses the existing Post visibility query. */
export function projectReportingPost(id: string, document: Record<string, unknown>, cutoffAt: number): ReportingStory | null {
  if (!isPublishable(document as unknown as Parameters<typeof isPublishable>[0], new Date(cutoffAt))) return null;
  const published = document.published;
  if (!published || typeof published !== "object" || Array.isArray(published)) return null;
  const snapshot = published as Record<string, unknown>;
  const metadata = snapshot.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const data = metadata as Record<string, unknown>;
  if (data.type !== "post" || !Number.isSafeInteger(snapshot.sourceVersion) || Number(snapshot.sourceVersion) < 1 ||
      !Number.isSafeInteger(document.version) || Number(snapshot.sourceVersion) > Number(document.version) ||
      Number.isSafeInteger(document.publicSourceVersion) && Number(snapshot.sourceVersion) < Number(document.publicSourceVersion)) return null;
  const at = editorialSortInstant(data);
  if (at === null || at > cutoffAt) return null;
  const byline = Array.isArray(data.credits) && data.credits.length <= 12 ? data.credits.flatMap(credit => {
    if (!credit || typeof credit !== "object") return [];
    const name = credit.kind === "registered" ? credit.displayName : credit.kind === "custom" ? credit.name : null;
    return text(name,120) ? [name] : [];
  }).join(", ") : "";
  try { return parseReportingStory({ source: "posts", id, href: `https://njpbs.org/posts/${data.slug}/`, title: data.title,
    publishedAt: new Date(at).toISOString(), ...(byline && byline.length <= 300 ? {byline} : {}), tags: data.tags ?? [], categories: data.categories ?? [] }); } catch { return null; }
}

export interface DataHubSources {cutoffAt:string;posts:ReportingStory[];spotlight?:SpotlightReportingSnapshot}
export function parseDataHubSources(raw: unknown, now: number): DataHubSources | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(now)) fail();
  object(raw);
  object(raw,Object.hasOwn(raw,"spotlight") ? ["cutoffAt","posts","spotlight"] : ["cutoffAt","posts"]);
  if (!instant(raw.cutoffAt) || Date.parse(raw.cutoffAt) > now || !Array.isArray(raw.posts) || raw.posts.length > 1000 ||
      new TextEncoder().encode(JSON.stringify(raw)).length > 3*1024*1024) fail();
  const posts = raw.posts.map(parseReportingStory);
  if (posts.some(story => story.source !== "posts" || Date.parse(story.publishedAt) > Date.parse(String(raw.cutoffAt))) ||
      new Set(posts.map(story => story.id)).size !== posts.length || new Set(posts.map(story => story.href)).size !== posts.length) fail();
  const spotlight = parseSpotlightReportingSnapshot(raw.spotlight);
  return {cutoffAt:raw.cutoffAt,posts,...(spotlight ? {spotlight} : {})};
}
