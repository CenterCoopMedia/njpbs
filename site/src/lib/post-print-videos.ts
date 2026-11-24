import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout";
import type { PageBlock } from "../../../packages/content-core/src/content-model";
import { embedPlayer, xVideoLink } from "../../../packages/content-core/src/embed-player";
import { isPostLeadMedia } from "../../../packages/content-core/src/post-lead-media";
import { safeHref } from "../../../packages/content-core/src/safe-href";
import { blockVideoSelections, isPublicVideoData } from "../../../packages/content-core/src/video-block";

export function postPrintVideoUrls(lead: unknown, blocks: readonly PageBlock[]): string[] {
  const urls = new Set<string>();
  if (isPostLeadMedia(lead) && lead.kind !== "image") {
    const url = lead.kind === "library-video" ? lead.data.public?.url
      : embedPlayer(lead.data.url, false)?.src ?? xVideoLink(lead.data.url) ?? safeHref(lead.data.url);
    if (url) urls.add(url);
  }

  for (const block of visibleLayoutBlocks(blocks)) {
    for (const { public: copy } of blockVideoSelections(block)) {
      if (isPublicVideoData(copy)) urls.add(copy.url);
    }
    const url = block.type === "embed" ? embedPlayer(block.data.url, false)?.src : undefined;
    if (url) urls.add(url);
  }
  return [...urls];
}
