import { isPostLeadMedia } from "./post-lead-media.ts";
import { visibleLayoutBlocks } from "./content-layout";
import {
  safeHref,
  type PageBlock,
} from "./content-model";

export interface PostMediaInventory {
  images: number;
  galleries: number;
  videos: number;
  mediaLinks: number;
  totalModules: number;
}

export interface PostMediaSource {
  heroImage: unknown | null;
  leadMedia?: unknown;
  blocks: readonly PageBlock[];
}

/** Count the media a reader will actually encounter in the published snapshot. */
export function postMediaInventory(post: PostMediaSource): PostMediaInventory {
  const lead = isPostLeadMedia(post.leadMedia, false) ? post.leadMedia : null;
  const hasLeadImage = post.leadMedia !== undefined ? lead?.kind === "image" : typeof post.heroImage === "string" ? post.heroImage.trim().length > 0 : Boolean(post.heroImage);
  let images = hasLeadImage ? 1 : 0;
  let galleries = 0;
  let videos = lead?.kind === "library-video" ? 1 : 0;
  let mediaLinks = lead?.kind === "embed" || lead?.kind === "linked-video" ? 1 : 0;

  for (const block of visibleLayoutBlocks(post.blocks)) {
    if (block.visible === false) continue;
    if (block.type === "image" && block.data.assetId.trim()) images += 1;
    if (block.type === "image_gallery") {
      galleries += 1;
      images += block.data.images.filter(image => image.assetId.trim()).length;
    }
    if (block.type === "video" && block.data.assetId.trim()) videos += 1;
    if (block.type === "embed" && safeHref(block.data.url) !== null) {
      mediaLinks += 1;
    }
  }

  return {
    images,
    galleries,
    videos,
    mediaLinks,
    totalModules: images + videos + mediaLinks,
  };
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Plain reader-facing inventory; no genre claim or promotional language. */
export function postMediaInventoryText(inventory: PostMediaInventory): string {
  const parts: string[] = [];
  if (inventory.images > 0) parts.push(countLabel(inventory.images, "image"));
  if (inventory.videos > 0) parts.push(countLabel(inventory.videos, "video"));
  if (inventory.mediaLinks > 0) {
    parts.push(countLabel(inventory.mediaLinks, "media link"));
  }
  return parts.join(" · ");
}

export function assertMultimediaInventory(inventory: PostMediaInventory): void {
  if (inventory.totalModules < 1) {
    throw new Error(
      "A Multimedia Feature must include a lead image, image block, gallery image, uploaded video, or media link.",
    );
  }
}
