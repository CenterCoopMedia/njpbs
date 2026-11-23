import { visibleLayoutBlocks } from "../../../packages/content-core/src/content-layout";
import type { PageBlock } from "../../../packages/content-core/src/content-model";
import { embedPlayer, xVideoLink } from "../../../packages/content-core/src/embed-player";
import { isPostLeadMedia } from "../../../packages/content-core/src/post-lead-media";
import { safeHref } from "../../../packages/content-core/src/safe-href";

export function postPrintVideoUrls(lead: unknown, blocks: readonly PageBlock[]): string[] {
  const urls = new Set<string>();
  if (isPostLeadMedia(lead) && lead.kind !== "image") {
    const url = lead.kind === "library-video" ? lead.data.public?.url
      : embedPlayer(lead.data.url, false)?.src ?? xVideoLink(lead.data.url) ?? safeHref(lead.data.url);
    if (url) urls.add(url);
  }

  for (const block of visibleLayoutBlocks(blocks)) {
    const url = block.type === "video" ? block.data.public?.url
      : block.type === "embed" ? embedPlayer(block.data.url, false)?.src : undefined;
    if (url) urls.add(url);
  }
  return [...urls];
}
