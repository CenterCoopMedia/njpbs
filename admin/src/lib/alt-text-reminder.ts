import {
  editorFieldsForBlock,
} from "../../../packages/content-core/src/editor-admin";
import {
  BLOCK_TYPES,
  type BlockType,
} from "../../../packages/content-core/src/content-model";
import {
  missingRecommendedContent,
} from "./field-validation";
import { readPostLeadMedia } from "../../../packages/content-core/src/post-lead-media";
import {
  HOME_HERO_LIMIT,
  homeHeroHref,
  parseHomeHero,
} from "../../../packages/content-core/src/home-hero";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isBlockType(value: unknown): value is BlockType {
  return (BLOCK_TYPES as readonly unknown[]).includes(value);
}

// Counts the images in a published document that still have no alt text: post lead
// images, visible block images, and manual Home hero slides. Hidden blocks publish
// nothing, so they are skipped. Legacy and body images can lack descriptions
// (#242); this count only feeds the reminder shown after publication.
export function missingAltTextCount(
  collection: "cmsPages" | "cmsPosts",
  document: Record<string, unknown>,
): number {
  let count = 0;
  if (collection === "cmsPosts") {
    const lead = readPostLeadMedia(document);
    if (lead?.kind === "image") {
      count += missingRecommendedContent(editorFieldsForBlock("image"), { ...lead.data }).length;
    }
  }
  count += missingHomeHeroAltCount(document.homeHero);
  const blocks = Array.isArray(document.blocks) ? document.blocks : [];
  for (const block of blocks) {
    if (!isRecord(block) || block.visible === false || !isBlockType(block.type)) continue;
    const data = isRecord(block.data) ? block.data : {};
    count += missingRecommendedContent(editorFieldsForBlock(block.type), data).length;
  }
  return count;
}

// Counts only the manual slides that resolveHomeHero would publish: a titled slide
// with a valid, unique destination, up to the configured limit.
function missingHomeHeroAltCount(value: unknown): number {
  let config;
  try {
    config = parseHomeHero(value);
  } catch {
    return 0;
  }
  if (config?.mode !== "manual") return 0;
  const seen = new Set<string>();
  const published = (config.items ?? []).filter((item) => {
    if (!item.title.trim() || !homeHeroHref(item.href) || seen.has(item.href)) return false;
    seen.add(item.href);
    return true;
  }).slice(0, config.limit ?? HOME_HERO_LIMIT);
  return published.filter(
    (item) => item.imageAssetId && !item.altDecorative && !item.alt?.trim(),
  ).length;
}

export function altTextReminder(count: number): string | null {
  if (count < 1) return null;
  const images = count === 1 ? "1 image has" : `${count} images have`;
  return `${images} no alt text. Add it when you can, or mark the image decorative.`;
}
