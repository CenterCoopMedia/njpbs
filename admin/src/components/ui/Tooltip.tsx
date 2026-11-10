import { useOverlayOwner } from "../EditorOverlayOwner";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

type Placement = "auto" | "bottom" | "left" | "right" | "top";

interface TooltipProps {
  children: ReactElement;
  content: string;
  hoverDelay?: number;
  openOnClick?: boolean;
  placement?: Placement;
}

interface TriggerProps {
  disabled?: boolean;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
}

interface TooltipPosition {
  left: number;
  placement: Exclude<Placement, "auto">;
  top: number;
}

let activeTooltipClose: (() => void) | null = null;
let activeTooltipPendingOpenCancel: (() => void) | null = null;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

function available(
  placement: Exclude<Placement, "auto">,
  trigger: DOMRect,
  tooltip: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const gap = 4;
  if (placement === "top") return trigger.top >= tooltip.height + gap + 8;
  if (placement === "bottom") {
    return viewportHeight - trigger.bottom >= tooltip.height + gap + 8;
  }
  if (placement === "left") return trigger.left >= tooltip.width + gap + 8;
  return viewportWidth - trigger.right >= tooltip.width + gap + 8;
}

function positionTooltip(
  requested: Placement,
  trigger: DOMRect,
  tooltip: DOMRect,
): TooltipPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const candidates: Array<Exclude<Placement, "auto">> =
    requested === "auto"
      ? ["top", "bottom", "right", "left"]
      : [requested, "top", "bottom", "right", "left"];
  const placement =
    candidates.find((candidate) =>
      available(candidate, trigger, tooltip, viewportWidth, viewportHeight),
    ) ?? candidates[0];
  const gap = 4;
  let left = trigger.left + (trigger.width - tooltip.width) / 2;
  let top = trigger.top - tooltip.height - gap;

  if (placement === "bottom") top = trigger.bottom + gap;
  if (placement === "left") {
    left = trigger.left - tooltip.width - gap;
    top = trigger.top + (trigger.height - tooltip.height) / 2;
  }
  if (placement === "right") {
    left = trigger.right + gap;
    top = trigger.top + (trigger.height - tooltip.height) / 2;
  }

  return {
    left: Math.max(8, Math.min(left, viewportWidth - tooltip.width - 8)),
    placement,
    top: Math.max(8, Math.min(top, viewportHeight - tooltip.height - 8)),
  };
}

export function Tooltip({
  children,
  content,
  hoverDelay = 300,
  openOnClick = false,
  placement = "auto",
}: TooltipProps) {
  if (!content.trim()) throw new Error("Tooltip content is required");
  if (!isValidElement<TriggerProps>(children)) {
    throw new Error("Tooltip requires one interactive element");
  }
  if (children.props.disabled) {
    throw new Error("Tooltip cannot wrap a native disabled control");
  }

  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const focused = useRef(false);
  const triggerHovered = useRef(false);
  const tooltipHovered = useRef(false);
  const dismissed = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const cancelPendingOpen = useCallback((event?: Event) => {
    if (event?.type === "scroll" && triggerRef.current?.matches(":hover")) return;
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    showTimer.current = null;
    window.removeEventListener("scroll", cancelPendingOpen, true);
    if (activeTooltipPendingOpenCancel === cancelPendingOpen) {
      activeTooltipPendingOpenCancel = null;
    }
  }, []);

  const clearTimers = useCallback(() => {
    cancelPendingOpen();
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, [cancelPendingOpen]);

  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPosition(null);
    if (activeTooltipClose === close) activeTooltipClose = null;
  }, [clearTimers]);

  const show = useCallback(() => {
    if (dismissed.current) return;
    if (
      activeTooltipPendingOpenCancel &&
      activeTooltipPendingOpenCancel !== cancelPendingOpen
    ) {
      activeTooltipPendingOpenCancel();
    }
    cancelPendingOpen();
    if (activeTooltipClose && activeTooltipClose !== close) activeTooltipClose();
    activeTooltipClose = close;
    setOpen(true);
  }, [cancelPendingOpen, close]);

  const clearDismissalWhenIdle = useCallback(() => {
    if (!focused.current && !triggerHovered.current && !tooltipHovered.current) {
      dismissed.current = false;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (!focused.current && !triggerHovered.current && !tooltipHovered.current) {
        close();
      }
    }, 80);
  }, [close]);

  useEffect(() => {
    return () => {
      clearTimers();
      if (activeTooltipClose === close) activeTooltipClose = null;
    };
  }, [clearTimers, close]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !tooltipRef.current) return;
    setPosition(
      positionTooltip(
        placement,
        triggerRef.current.getBoundingClientRect(),
        tooltipRef.current.getBoundingClientRect(),
      ),
    );
  }, [placement]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handleScroll = () => {
      // Keyboard focus can scroll a help button into view immediately after opening it.
      // Keep that explanation attached until focus moves or the reader dismisses it.
      if (openOnClick && focused.current) updatePosition();
      else close();
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [close, open, openOnClick, updatePosition]);

  // Touch browsers do not all focus a tapped button. Dismiss supplemental help on an
  // outside press as well as blur, without closing when the reader taps the help itself.
  useEffect(() => {
    if (!open || !openOnClick) return;
    const dismissOutside = (event: globalThis.PointerEvent) => {
      const path = event.composedPath();
      if (path.includes(triggerRef.current!) || path.includes(tooltipRef.current!)) return;
      dismissed.current = true;
      close();
    };
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [close, open, openOnClick]);

  const originalProps = children.props;
  const originalRef = (children as ReactElement & { ref?: Ref<HTMLElement> }).ref;
  const trigger = cloneElement(children as ReactElement<TriggerProps>, {
    ref: (element: HTMLElement | null) => {
      triggerRef.current = element;
      assignRef(originalRef, element);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      originalProps.onBlur?.(event);
      focused.current = false;
      clearDismissalWhenIdle();
      scheduleClose();
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      if (openOnClick) {
        dismissed.current = false;
        show();
      } else {
        dismissed.current = true;
        close();
      }
      originalProps.onClick?.(event);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      originalProps.onFocus?.(event);
      focused.current = true;
      show();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      originalProps.onKeyDown?.(event);
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      event.stopPropagation();
      dismissed.current = true;
      close();
    },
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      originalProps.onPointerEnter?.(event);
      triggerHovered.current = true;
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      if (dismissed.current || focused.current) return;
      if (
        activeTooltipPendingOpenCancel &&
        activeTooltipPendingOpenCancel !== cancelPendingOpen
      ) {
        activeTooltipPendingOpenCancel();
      }
      cancelPendingOpen();
      activeTooltipPendingOpenCancel = cancelPendingOpen;
      window.addEventListener("scroll", cancelPendingOpen, true);
      showTimer.current = window.setTimeout(show, hoverDelay);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      originalProps.onPointerLeave?.(event);
      triggerHovered.current = false;
      cancelPendingOpen();
      clearDismissalWhenIdle();
      scheduleClose();
    },
  });

  const overlay = open ? (
    <div
      aria-hidden="true"
      className="tooltip-surface"
      data-placement={position?.placement ?? "top"}
      data-positioned={position ? "true" : "false"}
      onPointerEnter={() => {
        tooltipHovered.current = true;
        if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      }}
      onPointerLeave={() => {
        tooltipHovered.current = false;
        clearDismissalWhenIdle();
        scheduleClose();
      }}
      ref={tooltipRef}
      role="tooltip"
      style={position ? { left: position.left, top: position.top } : undefined}
    >
      {content}
    </div>
  ) : null;

  const inheritedOwner = useOverlayOwner();
  // Retained editor fields can live in a native sheet without changing their React owner.
  const owner = inheritedOwner ?? triggerRef.current?.closest<HTMLElement>('dialog[open]:not([role="presentation"])');
  const overlayRoot =
    typeof document === "undefined"
      ? null
      : owner ?? document.getElementById("admin-overlay-root") ?? document.body;

  return (
    <>
      {trigger}
      {overlay && overlayRoot ? createPortal(overlay, overlayRoot) : null}
    </>
  );
}
