// The videos a publish copies to the public site. Pure, so the editor and the content API
// (#4716) copy the same set.
import { liveBlogVideoBlocks } from "../../../packages/content-core/src/live-blog";
import { visibleLayoutBlocks, type LayoutBlock } from "../../../packages/content-core/src/content-layout";
import { leadVideoBlocks } from "../../../packages/content-core/src/post-lead-media";
import { blockVideoSelections } from "../../../packages/content-core/src/video-block";

/** Distinct asset ids of the visible video blocks, the same set the server checks (#2751). */
/** A visible video block in the saved version: its asset and the title staff gave it. */
export interface PublicationVideo {
  assetId: string;
  title: string;
}

/** The distinct visible videos, the first block's title per asset. Publish copies this set. */
export function videosForPublication(blocks: unknown, leadMedia?: unknown, liveBlog?: unknown): PublicationVideo[] {
  const candidates = [...leadVideoBlocks(leadMedia), ...liveBlogVideoBlocks(liveBlog), ...(Array.isArray(blocks) ? blocks : [])].filter(
    (block): block is LayoutBlock =>
      typeof block === "object" && block !== null && typeof (block as { type?: unknown }).type === "string",
  );
  if (!candidates.some(block => block.type === "video" || block.type === "scroll_story")) return [];
  const videos = new Map<string, PublicationVideo>();
  for (const { assetId, title, caption } of visibleLayoutBlocks(candidates).flatMap(blockVideoSelections)) {
    if (typeof assetId !== "string" || assetId.trim() === "" || videos.has(assetId)) continue;
    videos.set(assetId, { assetId, title: typeof title === "string" && title.trim() ? title.trim() : typeof caption === "string" ? caption.trim() : "" });
  }
  return [...videos.values()];
}
