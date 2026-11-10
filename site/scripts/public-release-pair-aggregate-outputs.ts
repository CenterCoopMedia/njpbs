import { publishedContentLinkRecords } from "../src/lib/content-link-search";
import { SitemapIndexStream, SitemapStream, streamToPromise } from "sitemap";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import { projectAuthorSnapshot, assertAuthorRouteUniqueness } from "../src/lib/cms-authors-projection";
import { projectJoinedRecords } from "../src/lib/published-post-shadow";
import joined from "../../functions/lib/joined-records.js";
import { assertPostRouteUniqueness } from "../src/lib/cms-posts-projection";
import { createExternalContentManifest, createExternalContentStaticFeed, renderExternalContentRss } from "../src/lib/external-content-feed";
import { htmlDeclaresNoindex } from "../src/lib/sitemap-noindex";
import work from "../../functions/lib/public-release-pair-work.js";
import views from "../../functions/lib/public-release-pair-view.js";
import type { PairCodePack } from "./public-release-pair-code-pack";
export type PairAggregateFile = { path: string; mime: string; bytes: Uint8Array };
function refuse(): never { throw new work.PairExecutionError("input-unavailable"); }
export class PairAuthorAdapterUnavailable extends work.PairExecutionError {
  readonly reason = "pair-author-adapter-unavailable";
  constructor() { super("input-unavailable"); this.name = "PairAuthorAdapterUnavailable"; }
}
export const publicReleasePairHtmlRoute = (path: string) => path.replace(/(?:^|\/)index\.html$/, match => match.startsWith("/") ? "/" : "");
/** Only the exact source-derived author roster can replace author fallback
 * HTML. An unexplained baseline author path still refuses by name. */
export function assertPublicReleasePairAuthorAdapter(paths: Iterable<string>, ownedPaths: ReadonlySet<string> = new Set()) {
  for (const path of paths) if (path.startsWith("/authors/") && !ownedPaths.has(publicReleasePairHtmlRoute(path))) throw new PairAuthorAdapterUnavailable();
}
export function publicReleasePairRequiredBaselineMembers(pack: PairCodePack, ownedPaths: ReadonlySet<string>) {
  assertPublicReleasePairAuthorAdapter(pack.members.map(member => member.path), ownedPaths);
  const selected = pack.members.filter(member => ["/search/meaning-index.json", "/_publication.json", "/_content-status.json"].includes(member.path) ||
    member.mime.startsWith("text/html") && !ownedPaths.has(publicReleasePairHtmlRoute(member.path)));
  if (!["/search/meaning-index.json", "/_publication.json", "/_content-status.json"].every(path => selected.some(member => member.path === path))) refuse();
  return selected;
}
/** Existing public projections and feed serializers, over current frozen raw
 * documents only. Draft values are never substituted for published snapshots. */
export function derivePublicReleasePairContentFeeds(documents: ReadonlyMap<string, any>, now: Date, origin: string): PairAggregateFile[] {
  const assets = new Map([...documents].filter(([path]) => path.startsWith("media_assets_public/")).map(([path, value]) =>
    [path.split("/").at(-1)!, { ...value, id: path.split("/").at(-1)! }]));
  const history = [...documents].filter(([path]) => path.startsWith("cmsVersionHistory/")).map(([, value]) => value);
  const records = [...documents].filter(([path]) => path.startsWith("cmsPosts/")).map(([path, value]) => ({ ...value, id: path.split("/").at(-1)! }));
  const posts = records.filter(record => !["program", "event", "sponsor", "newsletter"].includes(record.published?.metadata?.type ?? record.type))
    .flatMap(record => { const value = projectCmsPost(record, { now, assets }); return value ? [value] : []; });
  assertPostRouteUniqueness(posts);
  const authors = [...documents].filter(([path]) => path.startsWith("cmsAuthorProfilesPublic/")).flatMap(([path, value]) => {
    const projected = projectAuthorSnapshot(path.split("/").at(-1)!, value); return projected ? [projected] : [];
  });
  assertAuthorRouteUniqueness(authors);
  const joinedRecords = records.flatMap(record => { const value = joined.shapeJoinedRecord(record.id, record,
    history.filter(row => row.collection === "cmsPosts" && row.documentId === record.id)); return value ? [value] : []; });
  const projected = projectJoinedRecords(joinedRecords, assets, now);
  const manifest = createExternalContentManifest({ site: origin, posts, contentLinks: publishedContentLinkRecords(documents, now), programs: projected.programs, authors, recordCards: projected.recordCards });
  const feed = createExternalContentStaticFeed(manifest), encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
  return [{ path: "/api/v1/content.json", mime: "application/json; charset=utf-8", bytes: encode(feed.index) },
    ...feed.pages.map(page => ({ path: `/api/v1/content/${page.page}.json`, mime: "application/json; charset=utf-8", bytes: encode(page) })),
    { path: "/feeds/news.xml", mime: "application/rss+xml; charset=utf-8", bytes: new TextEncoder().encode(renderExternalContentRss(manifest)) }];
}
/** Same public filter, ordering and sitemap package as the existing Astro
 * integration. A changed number/name of sitemap files has no wildcard grant. */
export async function buildPublicReleasePairSitemaps(html: AsyncIterable<{ path: string; bytes: Uint8Array }>, baselinePaths: readonly string[], origin: string): Promise<PairAggregateFile[]> {
  const urls = new Set<string>();
  for await (const file of html) {
    const path = file.path;
    if (!path.endsWith("/") || ["/wiki/", "/prototype/", "/design-system/", "/atlas/", "/resources/nj-politics/", "/admin/docs/"].some(prefix => path.includes(prefix)) ||
        /^\/(?:404|500)\/$/.test(path) || htmlDeclaresNoindex(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))) continue;
    urls.add(new URL(path, origin).href);
  }
  const ordered = [...urls].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (!ordered.length || ordered.length > views.VIEW_OUTPUT_LIMIT) refuse();
  const partCount = Math.ceil(ordered.length / 50_000), expected = ["/sitemap-index.xml", ...Array.from({ length: partCount }, (_, index) => `/sitemap-${index}.xml`)].sort();
  if (JSON.stringify([...baselinePaths].sort()) !== JSON.stringify(expected)) refuse();
  const output: PairAggregateFile[] = [];
  for (let index = 0; index < partCount; index++) {
    const stream = new SitemapStream({ hostname: origin, xmlns: { news: true, xhtml: true, image: true, video: true } }), complete = streamToPromise(stream);
    for (const url of ordered.slice(index * 50_000, (index + 1) * 50_000)) stream.write({ url });
    stream.end(); output.push({ path: `/sitemap-${index}.xml`, mime: "application/xml; charset=utf-8", bytes: new Uint8Array(await complete) });
  }
  const stream = new SitemapIndexStream(), complete = streamToPromise(stream);
  for (let index = 0; index < partCount; index++) stream.write({ url: new URL(`/sitemap-${index}.xml`, origin).href });
  stream.end(); output.push({ path: "/sitemap-index.xml", mime: "application/xml; charset=utf-8", bytes: new Uint8Array(await complete) });
  if (output.some(file => file.bytes.length > views.BODY_BYTES_LIMIT)) refuse();
  return output.sort((a, b) => views.comparePrivatePairArtifactPaths(a.path, b.path));
}
