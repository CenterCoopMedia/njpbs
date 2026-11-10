import { publicPostTopics } from "./post-formats";

export type PostLayout = "visual" | "mixed" | "text";

export interface PostLayoutBlock {
  type: string;
  visible?: boolean;
}

export interface PostLayoutSource {
  heroImage: unknown | null;
  leadMedia?: unknown;
  blocks: readonly PostLayoutBlock[];
}

export interface PostEyebrow {
  category: string;
  tag: string | null;
}

const MIXED_LAYOUT_BLOCKS = new Set([
  "image",
  "image_gallery",
  "embed",
  "html",
  "data_table",
  "card_grid",
  "content_shelf",
  "promotion_playlist",
  "topic_shelf",
  "video_playlist",
  "cta_row",
  "link_card",
]);

/**
 * Choose one deterministic public composition from the published snapshot.
 *
 * Editors do not have to understand or maintain a separate layout toggle. A
 * lead image is the strongest visual signal. Without one, admitted wide/visual
 * blocks select the mixed layout; prose-led Posts retain the quieter text
 * layout. Hidden blocks cannot change the public composition.
 */
export function choosePostLayout(post: PostLayoutSource): PostLayout {
  if (post.leadMedia || post.heroImage) return "visual";

  const hasVisibleWideBlock = post.blocks.some(
    (block) =>
      block.visible !== false && MIXED_LAYOUT_BLOCKS.has(block.type),
  );

  return hasVisibleWideBlock ? "mixed" : "text";
}

function firstNonEmpty(values: readonly string[]): string | null {
  return values.map((value) => value.trim()).find(Boolean) ?? null;
}

/**
 * The main category and first reader-facing tag shown above a Post headline.
 *
 * Snapshots published before categories existed used their first tag in the
 * category position. Keep that presentation and use the second tag beside it,
 * without writing inferred categories back into stored content.
 */
export function postEyebrow(
  categories: readonly string[],
  tags: readonly string[],
): PostEyebrow {
  const visibleTags = publicPostTopics(tags);
  const category = firstNonEmpty(categories);
  if (category) {
    return { category, tag: firstNonEmpty(visibleTags) };
  }
  const legacyCategory = firstNonEmpty(visibleTags);
  if (!legacyCategory) return { category: "NJ PBS", tag: null };
  const categoryIndex = visibleTags.findIndex(
    (tag) => tag.trim() === legacyCategory,
  );
  return {
    category: legacyCategory,
    tag: firstNonEmpty(visibleTags.slice(categoryIndex + 1)),
  };
}
