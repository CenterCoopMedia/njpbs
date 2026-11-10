// Viewer stepping. The viewer
// steps through the page order it was opened with and stops at the first and last item. It
// never loads another page.

export type StepDirection = "previous" | "next";

/** The previous or next id in page order, or null at either end or when the id is not on the page. */
export function stepTarget(order: readonly string[], currentId: string, direction: StepDirection): string | null {
  const index = order.indexOf(currentId);
  if (index < 0) return null;
  return order[direction === "next" ? index + 1 : index - 1] ?? null;
}

/** "3 of 24", or empty when the id is not on the page. */
export function stepPosition(order: readonly string[], id: string): string {
  const index = order.indexOf(id);
  return index < 0 ? "" : `${index + 1} of ${order.length}`;
}

export type ViewerKeyResult = StepDirection | "close" | "quick-look" | "none";

export interface ViewerKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

// Keys belong to these instead: text entry, choices, media controls and the transcript.
const OWNS_KEYS = 'input, textarea, select, video, audio, [role="menu"], [role="listbox"], [contenteditable]:not([contenteditable="false"]), [data-viewer-keys="off"]';

function ownsKeys(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest(OWNS_KEYS) !== null;
}

/**
 * The viewer frame's keys: ArrowLeft and ArrowRight step, Escape closes and Cmd or Ctrl+Y opens
 * Quick Look. An arrow at a page edge does nothing. Keys typed in a field, on a video or its
 * controls, or in a region marked data-viewer-keys="off" (the transcript) are left alone.
 */
export function viewerKeyAction(
  event: ViewerKeyEvent,
  edges: { previous: boolean; next: boolean } = { previous: true, next: true },
): ViewerKeyResult {
  if (event.defaultPrevented || event.isComposing || ownsKeys(event.target)) return "none";
  if (event.altKey || event.shiftKey) return "none";
  const command = event.metaKey || event.ctrlKey;
  if (command) return event.key.toLowerCase() === "y" ? "quick-look" : "none";
  if (event.key === "ArrowLeft") return edges.previous ? "previous" : "none";
  if (event.key === "ArrowRight") return edges.next ? "next" : "none";
  if (event.key === "Escape") return "close";
  return "none";
}
