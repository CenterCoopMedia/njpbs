import { createApp } from "astro/app/entrypoint";
import type { PublishedPostContent } from "../src/lib/published-post-shadow";
import type { HomeSourceSnapshot } from "../src/lib/home-sources";

declare const __CMS_RENDERER_SHA__: string;
export const rendererSha = __CMS_RENDERER_SHA__;
const app = createApp({ streaming: false });

/** Callable compiled Post template. Only published-snapshot admission supplies
 * locals; private-preview input cannot enter this separate server entry.
 */
export async function renderPublishedPost(content: PublishedPostContent): Promise<string> {
  if (content.kind !== "public-post-shadow" || content.target.rendererSha !== rendererSha ||
    content.posts.length !== 1 || content.posts[0].postId !== content.target.documentId ||
    content.posts[0].sourceVersion !== content.target.sourceVersion ||
    content.posts[0].path !== content.target.pagePath) throw new Error("Invalid published Post target");
  const request = new Request(new URL(content.target.pagePath, "https://njpbs.org"));
  // Only the Post route is compiled. Home sources have no consumer here.
  const response = await app.render(request, { locals: { cmsRender: {
    content, homeSources: { schemaVersion: 1, publication: null, heroCatalog: [], pbs: { source: "manual", checkedAt: null, featured: [], more: [] }, spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } } satisfies HomeSourceSnapshot,
  } } });
  if (response.status !== 200) throw new Error("Published Post rendering failed");
  return response.text();
}
