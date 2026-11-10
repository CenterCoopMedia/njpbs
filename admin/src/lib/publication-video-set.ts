// The videos a publish copies to the public site. Pure, so the editor and the content API
// (#4716) copy the same set.
import { liveBlogVideoBlocks } from "../../../packages/content-core/src/live-blog";
import { visibleLayoutBlocks, type LayoutBlock } from "../../../packages/content-core/src/content-layout";
import { leadVideoBlocks } from "../../../packages/content-core/src/post-lead-media";

/** Distinct asset ids of the visible video blocks, the same set the server checks (#2751). */
/** A visible video block in the saved version: its asset and the title staff gave it. */
export interface PublicationVideo {
  assetId: string;
  title: string;
}

/** The distinct visible videos, the first block's title per asset. Publish copies this set. */
export function videosForPublication(blocks: unknown, leadMedia?: unknown, liveBlog?: unknown): PublicationVideo[] {
  const candidates = [...leadVideoBlocks(leadMedia), ...liveBlogVideoBlocks(liveBlog), ...(Array.isArray(blocks) ? blocks : [])].filter(
    (block): block is LayoutBlock & { data?: { assetId?: unknown; title?: unknown; caption?: unknown } } =>
      typeof block === "object" && block !== null && typeof (block as { type?: unknown }).type === "string",
  );
  if (!candidates.some((block) => block.type === "video")) return [];
  const videos = new Map<string, PublicationVideo>();
  for (const block of visibleLayoutBlocks(candidates)) {
    const assetId = block.data?.assetId;
    if (block.type !== "video" || typeof assetId !== "string" || assetId.trim() === "" || videos.has(assetId)) continue;
    videos.set(assetId, { assetId, title: typeof block.data?.title === "string" && block.data.title.trim() ? block.data.title.trim() : typeof block.data?.caption === "string" ? block.data.caption.trim() : "" });
  }
  return [...videos.values()];
}
