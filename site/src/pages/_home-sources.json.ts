import type { APIRoute } from "astro";
import { getCollection, getEntry } from "astro:content";

import { homeSelectedPostIds } from "../../../packages/content-core/src/home-source-catalog";
import { homeSourcePreviewSnapshot } from "../lib/home-hero-items";

export const prerender = true;

export const GET: APIRoute = async () => {
  const entry = await getEntry("publicHomeSources", "home");
  if (!entry) throw new Error("The Home source snapshot is missing");
  const posts = await getCollection("cmsPosts");
  const authors = await getCollection("cmsAuthorsPublic");
  const home = await getEntry("cmsPages", "home");
  const sources = homeSourcePreviewSnapshot(entry.data, posts.map(post => post.data), homeSelectedPostIds(home?.data ?? {}), authors.map(author => author.data));
  return new Response(`${JSON.stringify(sources)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
