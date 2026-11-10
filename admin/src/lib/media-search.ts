// Keyboard rules for the media toolbar:
// "/" focuses search and Shift+V opens Display, unless the person is typing in a field
// (including one inside a shadow root) or a modal dialog or media popover is open.

export type MediaShortcut = "focus-search" | "open-display";
export type EscapeSearchAction = "clear-and-commit" | "clear-draft" | "blur";

const TEXT_ENTRY = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";
const BLOCKING_LAYER = "[role='dialog'][aria-modal='true'], dialog[open], .ui-popover, .media-quick-look";

function eventTarget(event: KeyboardEvent): Element | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const first = path[0] ?? event.target;
  return first instanceof Element ? first : null;
}

/** Shared field and overlay guard for media workspace shortcuts. */
export function mediaShortcutBlocked(event: KeyboardEvent, doc: Document = document): boolean {
  if (event.defaultPrevented || event.repeat) return true;
  const target = eventTarget(event);
  if (target?.closest(TEXT_ENTRY)) return true;
  return Boolean(doc.querySelector(BLOCKING_LAYER));
}

export function mediaShortcut(event: KeyboardEvent, doc: Document = document): MediaShortcut | null {
  if (event.ctrlKey || event.metaKey || event.altKey || mediaShortcutBlocked(event, doc)) return null;
  const shortcut: MediaShortcut | null = event.key === "/" && !event.shiftKey
    ? "focus-search"
    : (event.key === "V" || event.key === "v") && event.shiftKey
      ? "open-display"
      : null;
  if (!shortcut) return null;
  return shortcut;
}

/**
 * Escape in the search field: with text and saved details, clear and apply; with unsaved
 * details, clear only the typed draft so no leave prompt appears; on an empty field, blur.
 */
export function escapeSearchAction(value: string, detailsDirty: boolean): EscapeSearchAction {
  if (value === "") return "blur";
  return detailsDirty ? "clear-draft" : "clear-and-commit";
}
