import type {
  PageBlock,
  PromotionPlaylistBlock,
} from "../../../packages/content-core/src/content-model";

/**
 * Select manual shelves in their saved order.
 *
 * The CMS loader supplies visible, model-valid, Home-valid blocks in saved order.
 * This route-family boundary therefore selects from that trusted list; it does not
 * validate blocks or admit any other saved Home content.
 */
export function admittedHomePromotions(
  blocks: readonly PageBlock[],
): PromotionPlaylistBlock[] {
  return blocks.filter(
    (block): block is PromotionPlaylistBlock => block.type === "promotion_playlist",
  );
}
