import type { RefObject } from "react";
import { Popover } from "../ui/Popover";
import "./MediaShortcuts.css";

/** True on Apple platforms, where Select this page is Command+A rather than Control+A. */
export function applePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || nav.platform || "");
  } catch {
    // A wrapped or stubbed navigator can refuse the read; Control+A is the safe default.
    return false;
  }
}

/** Select this page's shortcut, as the More menu and the shortcuts list show it. */
export function selectPageShortcut(apple = applePlatform()) {
  return apple ? { label: "⌘A", keys: "Meta+A" } : { label: "Ctrl+A", keys: "Control+A" };
}

// The images page's keys. Only keys the page handles are
// listed; each follows the WorkspaceFinder guards, so a field keeps its own keys.
function shortcuts(apple: boolean): [string, string][] {
  return [
    ["/", "Search"],
    ["Esc", "Step back: clear the selection, close details, then clear the search"],
    [selectPageShortcut(apple).label, "Select this page, from the results"],
    [apple ? "⌘Y" : "Ctrl+Y", "Open or close Quick Look for the focused item"],
    ["Shift+V", "Open Display"],
    ["Shift+F10", "Open the focused item's actions. The Menu key does too."],
    ["Space", "Select or clear the focused item"],
    ["Enter", "Open the focused item's details"],
    ["Arrow keys", "Move between items. Hold Shift to select as you move."],
  ];
}

export interface MediaShortcutsProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Keyboard shortcuts, opened from the toolbar's More. A nonmodal popover like Display: Escape
// closes it and returns focus to More.
export function MediaShortcuts({ anchorRef, onOpenChange, open }: MediaShortcutsProps) {
  const apple = applePlatform();
  return (
    <Popover
      anchorRef={anchorRef}
      className="media-shortcuts"
      label="Keyboard shortcuts"
      onOpenChange={onOpenChange}
      open={open}
      placement="bottom-end"
    >
      <h3 className="media-shortcuts-title">Keyboard shortcuts</h3>
      <dl className="media-shortcuts-list">
        {shortcuts(apple).map(([key, action]) => (
          <div className="media-shortcuts-row" key={key}>
            <dt><kbd>{key}</kbd></dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
      <p className="media-shortcuts-note">
        While you type in a field, keys keep their usual meaning, so {selectPageShortcut(apple).label} selects the
        text. The shortcuts also wait while a dialog is open.
      </p>
    </Popover>
  );
}
