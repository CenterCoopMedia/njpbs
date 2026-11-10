import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useFloatingPosition, useOverlayRoot } from "./floating";
import "./HoverCard.css";

interface TriggerProps {
  "aria-describedby"?: string;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
}

export interface HoverCardProps {
  children: ReactElement;
  content: ReactNode;
  /** Names the card, such as "Details for Studio B walkthrough". */
  label: string;
  delay?: number;
  /**
   * Waits this long before a keyboard focus opens the card. The default, 0, opens at once. A
   * roving grid passes the hover delay so arrowing across cards does not open one per key.
   */
  focusDelay?: number;
}

const CLOSE_DELAY = 200;

// A supplemental preview built from data already loaded (WCAG 1.4.13): it opens on hover
// after a pause, and on focus at once or after focusDelay. It stays while hovered, and Escape
// dismisses it.
export function HoverCard({ children, content, delay = 600, focusDelay = 0, label }: HoverCardProps) {
  if (!isValidElement<TriggerProps>(children)) throw new Error("HoverCard requires one element");
  const triggerRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  // Focus keeps its own timer so a pointer leaving the trigger cannot cancel a focus opening.
  const focusTimer = useRef<number | null>(null);
  const hovered = useRef({ trigger: false, card: false, focus: false });
  const [open, setOpen] = useState(false);
  const cardId = useId();
  // The description points at the details, not the labeled card: a referenced element's
  // aria-label would replace its text in the computed description.
  const detailsId = `${cardId}-details`;
  const root = useOverlayRoot();
  const position = useFloatingPosition(
    open,
    () => triggerRef.current?.getBoundingClientRect() ?? null,
    cardRef,
    "bottom-start",
    () => triggerRef.current,
  );

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
    focusTimer.current = null;
  }, []);

  const clearFocusTimer = useCallback(() => {
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      const state = hovered.current;
      if (!state.trigger && !state.card && !state.focus) setOpen(false);
    }, CLOSE_DELAY);
  }, []);

  const props = children.props;
  const originalRef = (children as ReactElement & { ref?: Ref<HTMLElement> }).ref;
  const trigger = cloneElement(children, {
    "aria-describedby": open ? detailsId : props["aria-describedby"],
    ref: (element: HTMLElement | null) => {
      triggerRef.current = element;
      if (typeof originalRef === "function") originalRef(element);
      else if (originalRef) (originalRef as { current: HTMLElement | null }).current = element;
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      props.onBlur?.(event);
      hovered.current.focus = false;
      // A focus-delayed card that has not opened yet never opens once focus leaves.
      clearFocusTimer();
      scheduleClose();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      props.onFocus?.(event);
      hovered.current.focus = true;
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
      clearFocusTimer();
      if (focusDelay > 0) focusTimer.current = window.setTimeout(() => setOpen(true), focusDelay);
      else setOpen(true);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      props.onKeyDown?.(event);
      if (event.key === "Escape" && !open && focusDelay > 0) clearTimers();
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      clearTimers();
      setOpen(false);
    },
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      props.onPointerEnter?.(event);
      hovered.current.trigger = true;
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
      openTimer.current = window.setTimeout(() => setOpen(true), delay);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      props.onPointerLeave?.(event);
      hovered.current.trigger = false;
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      openTimer.current = null;
      scheduleClose();
    },
  });

  return (
    <>
      {trigger}
      {open && root ? createPortal(
        <div
          aria-label={label}
          className="ui-hover-card"
          data-positioned={position ? "true" : "false"}
          id={cardId}
          onPointerEnter={() => {
            hovered.current.card = true;
            if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
          }}
          onPointerLeave={() => {
            hovered.current.card = false;
            scheduleClose();
          }}
          ref={cardRef}
          role="group"
          style={position ? { left: position.left, top: position.top } : undefined}
        >
          <div id={detailsId}>{content}</div>
        </div>,
        root,
      ) : null}
    </>
  );
}
