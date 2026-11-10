import { liveBlogVideoBlocks } from "../../../packages/content-core/src/live-blog";
import { videosForPublication } from "./publication-video-set";
import { cmsSaveContent, type SaveContentRequest } from "./functions";
import { publishSourceVideo } from "./source-media";

export { videosForPublication, type PublicationVideo } from "./publication-video-set";

export const COPYING_VIDEO_MESSAGE = "Copying video to the public site…";

export interface PublicationVideoOptions {
  /** The stored blocks of the version to publish or schedule. */
  blocks?: unknown;
  leadMedia?: unknown;
  liveBlog?: unknown;
  onProgress?: (message: string) => void;
}

/**
 * Entry videos a direct live update must copy: those not already in the public live
 * blog. Existing public copies remain, and the copy endpoint needs Publish access.
 */
export function newLiveBlogVideoBlocks(liveBlog: unknown, publishedLiveBlog: unknown) {
  const published = new Set(liveBlogVideoBlocks(publishedLiveBlog).map((block) => block.data.assetId));
  return liveBlogVideoBlocks(liveBlog).filter((block) => !published.has(block.data.assetId));
}

export function videoAssetIdsForPublication(blocks: unknown, leadMedia?: unknown, liveBlog?: unknown): string[] {
  return videosForPublication(blocks, leadMedia, liveBlog).map((video) => video.assetId);
}

/**
 * A publish or schedule save. It first copies each visible video to the public site, one at
 * a time, and stops before the save when a copy fails. A draft save sends no copy request.
 */
export async function saveContentWithPublicVideos(
  idToken: string,
  body: SaveContentRequest,
  options: PublicationVideoOptions = {},
) {
  if (body.publish === true || typeof body.scheduleAt === "string") {
    const assetIds = videoAssetIdsForPublication(options.blocks, options.leadMedia, options.liveBlog);
    if (!assetIds.length) return cmsSaveContent(idToken, body);
    const { collection, id } = body;
    if (!id || (collection !== "cmsPages" && collection !== "cmsPosts")) {
      throw new Error("Save this content before publishing its videos.");
    }
    options.onProgress?.(COPYING_VIDEO_MESSAGE);
    for (const assetId of assetIds) {
      try {
        await publishSourceVideo(idToken, assetId, { collection, id });
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : "The request failed.";
        throw new Error(`The video could not be copied to the public site: ${reason}`);
      }
    }
    options.onProgress?.("");
  }
  return cmsSaveContent(idToken, body);
}
