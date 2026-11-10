// Where an anchored panel (popover, menu, hover card) goes, as pure arithmetic so the rule
// is tested without layout. It prefers the requested side, flips to the other vertical side
// when the panel does not fit, and always stays inside the viewport margin.

export type FloatingPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

export interface FloatingPosition {
  left: number;
  top: number;
  placement: FloatingPlacement;
  maxHeight?: number;
}

const GAP = 4;
const MARGIN = 8;

export function placeFloating(
  anchor: AnchorRect,
  size: FloatingSize,
  viewport: FloatingSize,
  requested: FloatingPlacement = "bottom-start",
  { fitBelow = false }: { fitBelow?: boolean } = {},
): FloatingPosition {
  const [side, align] = requested.split("-") as ["bottom" | "top", "start" | "end"];
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  const fitsBelow = below + size.height <= viewport.height - MARGIN;
  const fitsAbove = above >= MARGIN;
  const rawLeft = align === "start" ? anchor.left : anchor.right - size.width;
  const left = Math.max(MARGIN, Math.min(rawLeft, viewport.width - MARGIN - size.width));

  if (fitBelow) {
    // Keep the page actions above a long menu. Near the bottom, retain at least
    // one touch-sized row inside the viewport; the menu itself scrolls.
    const top = Math.max(MARGIN, Math.min(below, viewport.height - MARGIN - 44));
    return { left, top, placement: `bottom-${align}`, maxHeight: Math.max(0, viewport.height - MARGIN - top) };
  }

  let vertical: "bottom" | "top" = side;
  if (side === "bottom" && !fitsBelow && fitsAbove) vertical = "top";
  if (side === "top" && !fitsAbove && fitsBelow) vertical = "bottom";

  const rawTop = vertical === "bottom" ? below : above;
  const top = Math.max(MARGIN, Math.min(rawTop, viewport.height - MARGIN - size.height));
  return { left, top, placement: `${vertical}-${align}` };
}
