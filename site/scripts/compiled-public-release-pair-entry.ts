import { createApp } from "astro/app/entrypoint";
import { assertPublishedResources } from "../src/lib/published-resource-check";
import { projectPublicReleasePairReplay, parsePublicReleasePairReplayTargetReceipt, type PairReplayContext } from "./public-release-pair-replay";
import { assertFrozenReplayRequest } from "./public-release-pair-replay-inputs";
import protocol from "../../functions/lib/public-release-pair.js";
export * from "./compiled-public-page-entry";
export { renderPublicReleasePairAuthors, renderPublicReleasePairStaticAuthorAlias } from "./compiled-public-release-pair-author-entry";

declare const __CMS_RENDERER_SHA__: string;
declare const __CMS_DATA_HUB_PUBLIC__: boolean;
const app = createApp({ streaming: false });

/** Only the sealed pair executor imports this entry. Ordinary public builds
 * retain compiled-public-page-entry and its exact current-source checks.
 * Re-project H's original bytes with this sealed NEW graph; no projector or
 * pre-projected content supplied by a caller can cross this boundary. */
export async function renderPublicReleasePairProjection(context: PairReplayContext, targetReceipt: unknown): Promise<string> {
  if (context.pair.commitSha !== __CMS_RENDERER_SHA__ || !["page", "context", "record"].includes(context.route.renderer)) {
    throw new Error("Private pair renderer source differs");
  }
  await assertFrozenReplayRequest(context.readFrozenFile, context.route.inputFile, context.inputDigest, context.request);
  const replay = await projectPublicReleasePairReplay(context);
  parsePublicReleasePairReplayTargetReceipt(targetReceipt, context);
  if (protocol.publicReleaseDigest(targetReceipt) !== protocol.publicReleaseDigest(replay.receipt)) throw new Error("Private pair target differs");
  const content = replay.content;
  if (content.target.documentId === "data-hub" && !__CMS_DATA_HUB_PUBLIC__) throw new Error("The Data Hub publication gate is closed");
  const request = new Request(new URL(content.target.pagePath, "https://njpbs.org"));
  if (new URL(request.url).pathname !== content.target.pagePath) throw new Error("Invalid private pair route");
  const homeSources = content.homeSources ?? { schemaVersion: 1, publication: null, heroCatalog: [],
    pbs: { source: "manual", checkedAt: null, featured: [], more: [] }, spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } };
  const response = await app.render(request, { locals: { cmsRender: { content, homeSources } } });
  if (response.status !== 200) throw new Error("Private pair rendering failed");
  const html = await response.text();
  assertPublishedResources(html, content.target.pagePath, context.pair.environment === "development" ? "https://dev-public.example.org" : "https://njpbs.org");
  return html;
}

export { renderPublicReleasePairStaticAlias } from "./compiled-public-release-pair-static-alias-entry";
