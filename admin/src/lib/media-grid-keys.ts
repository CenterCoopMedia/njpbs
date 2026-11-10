// Keyboard rules for the shared media grid (the WAI-ARIA APG grid pattern). One function maps a key event and the focused position to one action.
// The grid wires the action; this module never touches the DOM beyond reading the event
// target and checking for an open modal.

export interface MediaGridPosition {
  /** The focused item's index in the visible page. */
  index: number;
  /** Items per row in the current layout; 1 for the list layout. */
  columns: number;
  /** Items on the visible page. */
  count: number;
  /** Whole rows that fit in the results region, for PageUp and PageDown. */
  rowsPerScreen: number;
}

export type MediaGridAction =
  | { type: "move"; index: number }
  | { type: "extend"; index: number }
  | { type: "toggle"; index: number }
  | { type: "open"; index: number }
  | { type: "quick-look"; index: number }
  | { type: "context-menu"; index: number }
  | { type: "select-page" }
  | { type: "escape" }
  | { type: "none" };

/** The event fields the rules read; a DOM or React keyboard event both fit. */
export interface MediaGridKeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  composedPath?: () => EventTarget[];
}

// The WorkspaceFinder guard (WorkspaceFinder.tsx): no grid key from text entry or while a
// modal is open. Cmd or Ctrl+A keeps its text meaning in fields.
const TEXT_ENTRY = [
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "input:not([type='checkbox']):not([type='button']):not([type='submit']):not([type='reset'])",
].join(", ");
// A checkbox or button inside a card handles Space and Enter itself (Tab walks a card's checkbox and quick actions). Arrow keys still move between cards.
const NATIVE_CONTROL = "button, input, [role='button'], [role='checkbox'], a[href]";
const MODAL = "dialog[open], [aria-modal='true']";

const NONE: MediaGridAction = { type: "none" };

function eventTarget(event: MediaGridKeyEvent): Element | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const first = path[0] ?? event.target ?? null;
  return first instanceof Element ? first : null;
}

function clamp(value: number, count: number): number {
  return Math.min(Math.max(value, 0), count - 1);
}

/** The index an arrow, Home, End or Page key moves to, or null for any other key. */
function movedIndex(event: MediaGridKeyEvent, { index, columns, count, rowsPerScreen }: MediaGridPosition): number | null {
  const width = Math.max(1, columns);
  const rowStart = index - (index % width);
  const column = index % width;
  const lastRowStart = Math.floor((count - 1) / width) * width;
  const page = width * Math.max(1, rowsPerScreen);
  const modified = event.ctrlKey || event.metaKey;
  switch (event.key) {
    case "ArrowRight": return clamp(index + 1, count);
    case "ArrowLeft": return clamp(index - 1, count);
    // Down into a short last row lands on its last item; the last row stays put.
    case "ArrowDown": return rowStart >= lastRowStart ? index : clamp(index + width, count);
    case "ArrowUp": return index - width >= 0 ? index - width : index;
    case "Home": return modified ? 0 : rowStart;
    case "End": return modified ? count - 1 : clamp(rowStart + width - 1, count);
    case "PageDown": {
      if (index + page <= count - 1) return index + page;
      return clamp(lastRowStart + column, count);
    }
    case "PageUp": return index - page >= 0 ? index - page : column;
    default: return null;
  }
}

export function mediaGridKeyAction(event: MediaGridKeyEvent, position: MediaGridPosition): MediaGridAction {
  if (event.defaultPrevented || event.altKey || position.count <= 0) return NONE;
  const target = eventTarget(event);
  if (target?.closest(TEXT_ENTRY)) return NONE;
  if ((target?.ownerDocument ?? document).querySelector(MODAL)) return NONE;
  const index = clamp(position.index, position.count);
  const modified = event.ctrlKey || event.metaKey;

  if (event.key === "Escape") return { type: "escape" };
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey && !modified)) {
    return { type: "context-menu", index };
  }
  if (modified && !event.shiftKey && event.key.toLowerCase() === "y") {
    return { type: "quick-look", index };
  }
  if (modified && !event.shiftKey && event.key.toLowerCase() === "a") return { type: "select-page" };

  if (event.key === " " || event.key === "Enter") {
    if (modified || event.shiftKey || target?.closest(NATIVE_CONTROL)) return NONE;
    return event.key === " " ? { type: "toggle", index } : { type: "open", index };
  }

  const moved = movedIndex(event, { ...position, index });
  if (moved === null) return NONE;
  if (event.shiftKey) {
    return event.key.startsWith("Arrow") && !modified ? { type: "extend", index: moved } : NONE;
  }
  if (modified && event.key !== "Home" && event.key !== "End") return NONE;
  return { type: "move", index: moved };
}
