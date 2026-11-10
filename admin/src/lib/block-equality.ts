import { recordsEqual } from "./record-equality";
import type { AdminBlock } from "./block-factory";

// Whether two block lists hold the same content, position by position.
//
// The page draft contract (#595) asks whether a hydrated page still holds unsaved work. The block
// reducer replaces the block array on every op, so array identity cannot answer it: a block added
// and then undone, or a word typed and deleted, leaves a new array holding the content that was
// loaded. Identity reads that as unsaved work, so leaving and returning restores the stale snapshot
// instead of re-reading -- and a change someone else saved meanwhile stays hidden until the next
// save is refused with a conflict.
//
// Order is content here: a reorder is a real edit, so two lists with the same blocks in a different
// order are not equal. Each block is compared by the same canonical value walk the record form uses
// (`recordsEqual`), so a block's id, type, order, visibility, and data payload -- including stored
// rich-text documents -- all count, and key order does not.
//
// This is the surface-switch comparison, run once when the host decides restore-versus-re-read, not
// per keystroke: a structural walk of a page of rich-text blocks is not free at typing speed, and
// the answer is only needed at the boundary.
export function blocksEqual(a: readonly AdminBlock[], b: readonly AdminBlock[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!recordsEqual(a[i] as unknown as Record<string, unknown>, b[i] as unknown as Record<string, unknown>)) {
      return false;
    }
  }
  return true;
}
