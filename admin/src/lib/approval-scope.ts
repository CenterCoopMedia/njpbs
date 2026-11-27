import { visibleLayoutBlocks, type LayoutBlock } from "../../../packages/content-core/src/content-layout";

/**
 * Whether saved blocks hold a visible election results block. Approval is offered
 * only for these documents, Spanish editions, and library cards; the lifecycle
 * server applies the same rule to the stored blocks.
 */
export function hasVisibleElectionResults(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false;
  const layoutBlocks = blocks.filter((block): block is LayoutBlock =>
    typeof block === "object" && block !== null &&
    typeof (block as { id?: unknown }).id === "string" &&
    typeof (block as { type?: unknown }).type === "string");
  return visibleLayoutBlocks(layoutBlocks).some(block => block.type === "election_results");
}
