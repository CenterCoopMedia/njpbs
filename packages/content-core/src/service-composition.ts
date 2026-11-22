import type { LayoutBlock } from "./content-layout.ts";
import { publicPage } from "./public-pages.ts";

/** A persisted opt-in survives removal of every authored block. */
export function serviceCompositionError(pageId: string, version: unknown): string | null {
  if (version === undefined) return null;
  if (version !== 1) return "The service composition version is invalid.";
  if (publicPage(pageId)?.family !== "service") return "Only service pages can use a service composition.";
  return null;
}

export function usesOrderedGivingBlocks(pageId: string | undefined): boolean {
  return pageId === "give" || pageId === "passport";
}

export function givingDonationBlock<B extends LayoutBlock>(pageId: string | undefined, blocks: readonly B[]): B | undefined {
  if (!usesOrderedGivingBlocks(pageId)) return undefined;
  return blocks.find(block => block.type === "cta_row" && block.section === "hero-actions");
}

export function givingBlocksInDisplayOrder<B extends LayoutBlock>(pageId: string, blocks: B[]): B[] {
  const donation = givingDonationBlock(pageId, blocks);
  if (!donation || blocks[0] === donation) return blocks;
  return [donation, ...blocks.filter(block => block !== donation)]
    .map((block, order) => block.order === order ? block : { ...block, order });
}

export function usesServiceComposition(page: {
  pageId: string;
  family: string;
  serviceCompositionVersion?: unknown;
}): boolean {
  return page.family === "service" &&
    (page.serviceCompositionVersion === 1 || usesOrderedGivingBlocks(page.pageId));
}
