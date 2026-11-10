import { createApp } from "astro/app/entrypoint";
import { publicPage, publicPageAliases } from "../../packages/content-core/src/public-pages";
import { postPublicPath } from "../src/lib/public-content-routes";
import { assertPublishedResources } from "../src/lib/published-resource-check";
import { assertFrozenReplayRequest } from "./public-release-pair-replay-inputs";
import { projectPublicReleasePairReplay, parsePublicReleasePairReplayTargetReceipt, type PairReplayContext } from "./public-release-pair-replay";
import type { PairRenderRoute } from "./public-release-pair-render-plan";
import type { PairRenderRequest } from "./public-release-pair-render-request";
import protocol from "../../functions/lib/public-release-pair.js";
declare const __CMS_RENDERER_SHA__: string;
declare const __CMS_DATA_HUB_PUBLIC__: boolean;
const app = createApp({ streaming: false });
/** Render the existing static alias branch with exact canonical H admission.
 * This is private artifact evidence; the ordinary alias response stays 308. */
export async function renderPublicReleasePairStaticAlias(context: PairReplayContext, targetReceipt: unknown,
  alias: { route: PairRenderRoute; request: PairRenderRequest; inputDigest: string }): Promise<Uint8Array> {
  if (context.pair.commitSha !== __CMS_RENDERER_SHA__ || !["post", "page", "context"].includes(context.route.renderer) ||
      alias.route.renderer !== "redirect" || alias.route.method !== "GET") throw new Error("Static alias source differs");
  await assertFrozenReplayRequest(context.readFrozenFile, context.route.inputFile, context.inputDigest, context.request);
  await assertFrozenReplayRequest(context.readFrozenFile, alias.route.inputFile, alias.inputDigest, alias.request);
  const replay = await projectPublicReleasePairReplay(context);
  parsePublicReleasePairReplayTargetReceipt(targetReceipt, context);
  if (protocol.publicReleaseDigest(targetReceipt) !== protocol.publicReleaseDigest(replay.receipt)) throw new Error("Static alias target differs");
  const content = replay.content, canonicalPath = content.target.pagePath, read = alias.request.read as Record<string, any>;
  if (!read || Object.keys(read).sort().join() !== "kind,location,path" || read.kind !== "redirect" || read.path !== alias.route.path ||
      read.location !== canonicalPath || read.path === canonicalPath) throw new Error("Static alias ownership differs");
  if (context.route.renderer !== "post" && content.target.documentId === "data-hub" && !__CMS_DATA_HUB_PUBLIC__) throw new Error("The Data Hub publication gate is closed");
  let paths: string[];
  if (context.route.renderer === "post") {
    const post = content.posts.find(post => post.postId === content.target.documentId);
    if (!post || post.path !== canonicalPath) throw new Error("Static alias Post is unavailable");
    paths = post.previousSlugs.map(postPublicPath);
  } else {
    const definition = publicPage(content.target.documentId ?? "");
    const page = content.pages.find(page => page.pageId === content.target.documentId);
    if (!definition) throw new Error("Static alias Page is unavailable");
    paths = publicPageAliases(definition, canonicalPath, page?.previousSlugs ?? []);
  }
  if (!paths.includes(alias.route.path)) throw new Error("Static alias is outside the current static artifact");
  const response = await app.render(new Request(new URL(alias.route.path, "https://njpbs.org")), { locals: { cmsRender: {
    content, homeSources: ("homeSources" in content ? content.homeSources : undefined) ?? { schemaVersion: 1, publication: null, heroCatalog: [],
      pbs: { source: "manual", checkedAt: null, featured: [], more: [] }, spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } },
    staticRedirect: { from: alias.route.path, to: canonicalPath },
  } } });
  if (response.status !== 200) throw new Error("Static alias rendering failed");
  const html = await response.text();
  assertPublishedResources(html, alias.route.path, context.pair.environment === "development" ? "https://dev-public.example.org" : "https://njpbs.org");
  return new TextEncoder().encode(html);
}
