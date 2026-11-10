import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import {
  createExternalContentManifest,
  renderExternalContentRss,
} from "../../lib/external-content-feed";

export const prerender = true;

export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error("The public site URL is not configured");
  const [posts, programs, authors, recordCards, pages] = await Promise.all([
    getCollection("cmsPosts"),
    getCollection("cmsPrograms"),
    getCollection("cmsAuthorsPublic"),
    getCollection("cmsRecordCards"),
    getCollection("cmsPages"),
  ]);
  const manifest = createExternalContentManifest({
    site,
    posts: posts.map((entry) => entry.data),
    contentLinks: pages.map((entry) => entry.data),
    programs: programs.map((entry) => entry.data),
    authors: authors.map((entry) => entry.data),
    recordCards: recordCards.map((entry) => entry.data),
  });
  return new Response(renderExternalContentRss(manifest), {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
};
