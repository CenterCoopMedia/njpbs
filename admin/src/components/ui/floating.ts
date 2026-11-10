import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useOverlayOwner } from "../EditorOverlayOwner";
import {
  placeFloating,
  type AnchorRect,
  type FloatingPlacement,
  type FloatingPosition,
} from "../../lib/floating-position";

// Shared plumbing for anchored panels: where they mount and where they sit.

/** The layer anchored panels mount into: the open editor modal when there is one. */
export function useOverlayRoot(): HTMLElement | null {
  const owner = useOverlayOwner();
  if (typeof document === "undefined") return null;
  return owner ?? document.getElementById("admin-overlay-root") ?? document.body;
}

export function useMediaQuery(query: string): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener?.("change", update);
    return () => list.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}

const samePosition = (a: FloatingPosition | null, b: FloatingPosition) =>
  a !== null && a.left === b.left && a.top === b.top && a.placement === b.placement && a.maxHeight === b.maxHeight;

/**
 * Keeps an open panel beside its anchor through window resizes, scrolls and size changes of
 * the panel or anchor, such as a web font arriving or a panel swapping its content.
 */
export function useFloatingPosition(
  open: boolean,
  getAnchor: () => AnchorRect | null,
  floatingRef: RefObject<HTMLElement | null>,
  placement: FloatingPlacement,
  /** The anchor element, watched for size changes. Without it only the panel is watched. */
  getAnchorElement?: () => Element | null,
  fitBelow = false,
): FloatingPosition | null {
  const anchorReader = useRef(getAnchor);
  anchorReader.current = getAnchor;
  const anchorElementReader = useRef(getAnchorElement);
  anchorElementReader.current = getAnchorElement;
  const [position, setPosition] = useState<FloatingPosition | null>(null);

  const update = useCallback(() => {
    const anchor = anchorReader.current();
    const floating = floatingRef.current;
    if (!anchor || !floating) return;
    const size = floating.getBoundingClientRect();
    const next = placeFloating(
      anchor,
      { width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight },
      placement,
      { fitBelow },
    );
    setPosition((current) => (samePosition(current, next) ? current : next));
  }, [floatingRef, placement, fitBelow]);

  useLayoutEffect(() => {
    if (open) update();
    else setPosition(null);
  }, [open, update]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, update]);

  // Only a real size change places the panel again, and an unchanged result is not stored,
  // so a placement cannot feed back into another observation.
  useEffect(() => {
    if (!open || typeof ResizeObserver !== "function") return;
    const sizes = new WeakMap<Element, string>();
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const size = `${entry.contentRect?.width}x${entry.contentRect?.height}`;
        if (sizes.get(entry.target) !== size) changed = true;
        sizes.set(entry.target, size);
      }
      if (changed) update();
    });
    const floating = floatingRef.current;
    const anchor = anchorElementReader.current?.();
    if (floating) observer.observe(floating);
    if (anchor) observer.observe(anchor);
    return () => observer.disconnect();
  }, [floatingRef, open, update]);

  return position;
}

export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
