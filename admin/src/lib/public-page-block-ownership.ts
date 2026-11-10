import type { AdminBlock } from "./block-factory";
import {
  parseBlocks,
  type BlockType,
} from "../../../packages/content-core/src/content-model";
import { homeCompositionError } from "../../../packages/content-core/src/home-composition-contract";
import type { PublicPageId } from "../../../packages/content-core/src/public-pages";

// Legacy Home documents expose only the optional manual shelf and preserve every other stored
// block. A marked Home document exposes its complete composition while the versioned contract
// fixes its regions. Keep both ownership policies beside the authenticated ContentTab adapter.
export const HOME_EDITABLE_BLOCK_TYPES: readonly BlockType[] = Object.freeze([
  "promotion_playlist",
]);

function isHomeEditableBlock(block: AdminBlock): boolean {
  return block.type === "promotion_playlist";
}

function completeHomeComposition(
  pageId: PublicPageId,
  blocks: readonly AdminBlock[],
  homeCompositionVersion: unknown,
): AdminBlock[] {
  const parsed = parseBlocks(blocks, { complete: false });
  if (!parsed.ok) {
    throw new Error("This Home page does not match the saved block format.");
  }
  const error = homeCompositionError(
    pageId,
    homeCompositionVersion,
    parsed.blocks,
    { complete: false },
  );
  if (error) throw new Error(error);
  return blocks.slice();
}

export function editableBlocksForPublicPage(
  pageId: PublicPageId,
  blocks: readonly AdminBlock[],
  homeCompositionVersion?: unknown,
): AdminBlock[] {
  if (homeCompositionVersion !== undefined) {
    return completeHomeComposition(pageId, blocks, homeCompositionVersion);
  }
  if (pageId !== "home") return blocks.slice();

  // The standalone shelf editor treats its own array as the complete editing order. Renumber the
  // projection so opening an existing shelf at position 11 does not look like an unsaved edit.
  return blocks
    .filter(isHomeEditableBlock)
    .map((block, order) => (block.order === order ? block : { ...block, order }));
}

export function blocksForPublicPageSave(
  pageId: PublicPageId,
  storedBlocks: readonly AdminBlock[],
  editableBlocks: readonly AdminBlock[],
  homeCompositionVersion?: unknown,
): AdminBlock[] {
  if (homeCompositionVersion !== undefined) {
    completeHomeComposition(pageId, storedBlocks, homeCompositionVersion);
    const proposed = completeHomeComposition(
      pageId,
      editableBlocks,
      homeCompositionVersion,
    );
    if (homeCompositionVersion !== 2) return proposed;
    // The editor supplies internal item identities to loaded grids. Start has
    // no editing surface, so those local identities must not alter its recovery
    // payload. Only its position follows the new array.
    return proposed.map(block => {
      if (!["home-start", "home-start-action"].includes(block.section ?? "")) return block;
      const stored = storedBlocks.find(previous => previous.id === block.id && previous.section === block.section);
      return stored ? { ...stored, order: block.order } : block;
    });
  }
  if (pageId !== "home") return editableBlocks.slice();
  if (editableBlocks.some((block) => !isHomeEditableBlock(block))) {
    throw new Error("Only the manual content shelf can be changed on the Home page.");
  }
  if (editableBlocks.length > 8) {
    throw new Error("The Home page can have up to eight manual content shelves.");
  }

  let shelfIndex = 0;
  const composed: AdminBlock[] = [];
  for (const stored of storedBlocks) {
    if (!isHomeEditableBlock(stored)) {
      // Preserve the complete recovery copy, including its original order.
      composed.push(stored);
      continue;
    }
    const shelf = editableBlocks[shelfIndex++];
    if (shelf) composed.push({ ...shelf, order: stored.order });
  }
  const lastOrder = storedBlocks.reduce((maximum, block) => Math.max(maximum, block.order), -1);
  for (const [index, shelf] of editableBlocks.slice(shelfIndex).entries()) {
    composed.push({ ...shelf, order: lastOrder + index + 1 });
  }
  return composed;
}
