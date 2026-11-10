// Heading-rank logic, shared by the renderer, the admin's block editor, and its outline.
//
// It lives apart from content-render.ts because the pieces that need it are not the pieces
// that need a renderer. The admin's block-editor state and its outline only ever ask what
// rank a block would carry, and importing that answer from the renderer dragged the whole
// render graph -- the shelf resolver and the committed shelf catalogs among it -- into the
// admin's entry chunk, which every signed-in editor downloads before any route mounts.
// content-render.ts re-exports both functions, so no existing call site changed.

import { isRichTextDoc } from "./content-model";
import type { RichTextNode } from "./content-model";

// The heading levels the model allows. Mirrors renderNode's heading clamp in
// content-model.ts: a non-integer or out-of-range level falls back to 2 rather than
// emitting an invalid tag, so a malformed stored `level` can never break the markup.
export function clampHeadingLevel(raw: number | undefined): number {
  const level = raw ?? 2;
  return Number.isInteger(level) ? Math.min(6, Math.max(1, level)) : 2;
}

interface HeadingContextBlock {
  type: string;
  visible: boolean;
  data: unknown;
}

function lastRichTextHeadingLevel(
  nodes: readonly RichTextNode[] | undefined,
): number | undefined {
  let last: number | undefined;
  for (const node of nodes ?? []) {
    if (node.type === "heading") {
      last = clampHeadingLevel(Number(node.attrs?.level ?? 2));
    }
    const nested = lastRichTextHeadingLevel(node.content);
    if (nested !== undefined) last = nested;
  }
  return last;
}

/**
 * Determine the rank for a generated card title or FAQ question at one page
 * position. The public page supplies the surrounding h1; authored headline and
 * prose headings establish deeper sections. Generated headings do not deepen
 * later sibling blocks, and hidden headings do not affect the published outline.
 */
export function generatedHeadingLevelAt<T extends HeadingContextBlock>(
  blocks: readonly T[],
  index: number,
): number {
  let authoredLevel = 1;
  const end = Math.min(Math.max(0, index), blocks.length);
  for (let position = 0; position < end; position += 1) {
    authoredLevel = authoredLevelAfter(blocks[position], authoredLevel);
  }
  return Math.min(6, authoredLevel + 1);
}

/**
 * The generated heading rank for every position on a page, in one forward pass.
 *
 * `generatedHeadingLevelAt` rescans the whole prefix for each position it is asked about, so a
 * caller that needs the answer for every block -- the admin's block editor renders one card per
 * block -- turns a render of the list into a quadratic rescan (#511). This walks the list once and
 * returns `levels[i] === generatedHeadingLevelAt(blocks, i)` for every i.
 */
export function generatedHeadingLevels<T extends HeadingContextBlock>(
  blocks: readonly T[],
): number[] {
  const levels: number[] = [];
  let authoredLevel = 1;
  for (const block of blocks) {
    // A block's own generated rank comes from the context the blocks before it established, so
    // record the rank first and let this block contribute to the next one.
    levels.push(Math.min(6, authoredLevel + 1));
    authoredLevel = authoredLevelAfter(block, authoredLevel);
  }
  return levels;
}

// The authored heading context after this block. Shared by both readings above so the rule --
// an authored headline sets the rank, a prose heading sets it, a generated heading does not, and a
// hidden block contributes nothing -- has exactly one definition.
function authoredLevelAfter<T extends HeadingContextBlock>(
  block: T,
  current: number,
): number {
  if (!block.visible || typeof block.data !== "object" || block.data === null) return current;
  const data = block.data as Record<string, unknown>;
  if (block.type === "headline") {
    return clampHeadingLevel(typeof data.level === "number" ? data.level : undefined);
  }
  if (block.type === "prose" && isRichTextDoc(data.content)) {
    const lastLevel = lastRichTextHeadingLevel(data.content.content);
    if (lastLevel !== undefined) return lastLevel;
  }
  return current;
}
