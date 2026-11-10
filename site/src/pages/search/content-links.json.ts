import { getCollection } from "astro:content";
import { contentLink } from "../../../../packages/content-core/src/content-link.ts";
import type { ContentLinkSearchRecord } from "../../lib/content-link-search";
export async function GET() {
  const records: ContentLinkSearchRecord[] = [...(await getCollection("cmsPosts")).map(entry => entry.data), ...(await getCollection("cmsPages")).map(entry => entry.data)]
    .filter(entry => entry.contentLinkMode === "custom" && !entry.noindex).map(entry => ({
      path: entry.path, title: entry.title, text: ("summary" in entry ? entry.summary || entry.excerpt : entry.description) || entry.title,
      contentLinkMode: "custom", contentLinkUrl: contentLink(entry, entry.path).href, contentLinkNewTab: contentLink(entry, entry.path).newTab,
    }));
  return new Response(JSON.stringify(records), { headers: { "content-type": "application/json" } });
}
