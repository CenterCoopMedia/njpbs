import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { FloatingPlacement } from "../../lib/floating-position";
import { Icon } from "./Icon";
import { Button } from "./Primitives";
import { FOCUSABLE, useFloatingPosition, useMediaQuery, useOverlayRoot } from "./floating";
import "./Popover.css";

declare const CloseWatcher: (new () => EventTarget & { destroy(): void }) | undefined;

export interface PopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  /** The panel's accessible name, usually the trigger's label. */
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  placement?: FloatingPlacement;
  className?: string;
  /** Show a close button and accept platform close requests in the phone sheet. */
  dismissibleSheet?: boolean;
  /** The control to focus on open, such as a checked radio. Without it, or outside the panel, the first control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

// Only one popover is open at a time (HIG: never show a cascade).
let closeActivePopover: (() => void) | null = null;

// A nonmodal panel anchored to a trigger, such as Filter or Display. On phone widths it
// becomes a bottom sheet over a scrim. Escape closes and returns focus to the trigger;
// an outside press or tabbing away closes without pulling focus back.
export function Popover({
  anchorRef,
  children,
  className,
  dismissibleSheet = false,
  initialFocusRef,
  label,
  onOpenChange,
  open,
  placement = "bottom-start",
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const compact = useMediaQuery("(max-width: 47.99rem)");
  const showSheetClose = compact && dismissibleSheet;
  const root = useOverlayRoot();
  const position = useFloatingPosition(
    open && !compact,
    () => anchorRef.current?.getBoundingClientRect() ?? null,
    panelRef,
    placement,
    () => anchorRef.current,
  );
  const changeOpen = useRef(onOpenChange);
  changeOpen.current = onOpenChange;

  const close = useCallback((returnFocus: boolean) => {
    changeOpen.current(false);
    if (returnFocus) anchorRef.current?.focus();
  }, [anchorRef]);

  useEffect(() => {
    if (!open) return;
    const closeThis = () => changeOpen.current(false);
    closeActivePopover?.();
    closeActivePopover = closeThis;
    return () => {
      if (closeActivePopover === closeThis) closeActivePopover = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !showSheetClose || typeof CloseWatcher === "undefined") return;
    // Android Back sends a close request to the active watcher before navigating.
    const watcher = new CloseWatcher();
    watcher.addEventListener("close", () => close(true));
    return () => watcher.destroy();
  }, [close, open, showSheetClose]);

  // Focus moves in once the panel is placed: until then it is hidden, and a hidden control
  // cannot take focus, so focus would stay on the trigger.
  const placed = open && (compact || position !== null);
  useEffect(() => {
    if (!placed) return;
    const panel = panelRef.current;
    const initial = initialFocusRef?.current;
    if (initial && panel?.contains(initial)) {
      initial.focus();
      return;
    }
    const controls = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = controls.find((control) => control !== closeButtonRef.current);
    (first ?? closeButtonRef.current ?? panel)?.focus();
  }, [initialFocusRef, placed]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (panelRef.current && path.includes(panelRef.current)) return;
      if (anchorRef.current && path.includes(anchorRef.current)) return;
      close(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [anchorRef, close, open]);

  if (!open || !root) return null;

  const classes = ["ui-popover", compact ? "ui-popover-sheet" : null, className].filter(Boolean).join(" ");
  return createPortal(
    <>
      {compact ? <div aria-hidden="true" className="ui-popover-scrim" /> : null}
      <div
        aria-label={label}
        aria-modal="false"
        className={classes}
        data-positioned={compact || position ? "true" : "false"}
        onBlur={(event) => {
          // A click on plain content focuses the panel itself (tabIndex -1), so a null target
          // means focus left the page, for example by tabbing into the browser chrome.
          const next = event.relatedTarget as Node | null;
          if (next && (panelRef.current?.contains(next) || anchorRef.current?.contains(next))) return;
          close(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }}
        ref={panelRef}
        role="dialog"
        style={!compact && position ? { left: position.left, top: position.top } : undefined}
        tabIndex={-1}
      >
        {compact ? <div aria-hidden="true" className="ui-popover-grabber" /> : null}
        {showSheetClose ? (
          <div className="ui-popover-sheet-actions">
            <Button
              aria-label={`Close ${label}`}
              className="action-control-icon"
              onClick={() => close(true)}
              ref={closeButtonRef}
              size="comfortable"
              variant="ghost"
            >
              <Icon name="close" />
            </Button>
          </div>
        ) : null}
        {children}
      </div>
    </>,
    root,
  );
}
