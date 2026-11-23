import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { buildSpotlightArchiveRedirectShards } from "../../lib/spotlight-archive-redirect-shards";

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = (await getCollection("cmsPosts")).map(entry => entry.data);
  return Array.from(buildSpotlightArchiveRedirectShards(posts), ([shard, paths]) => ({
    params: { shard }, props: { redirects: Object.fromEntries(paths) },
  }));
};

export const GET: APIRoute<{ redirects: Record<string, string> }> = ({ props }) => Response.json(props.redirects);
