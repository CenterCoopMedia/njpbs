// WCAG 2.x contrast math — pure, render-free, dependency-light.
//
// This makes the design system's computed contrast rule executable: the live token
// gate feeds each documented fg/bg pairing through contrastRatio and asserts it
// clears AA. Hex parsing is reused from hero-config so there is one parser.

import { parseHexColor } from "./hero-config";

/**
 * WCAG relative luminance of a color (0 = black, 1 = white).
 * Channels are linearized per the sRGB transfer function, then weighted.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Contrast ratio between two colors, 1:1 to 21:1. Symmetric in its arguments —
 * the lighter color is always the numerator. https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Flatten a translucent overlay onto an opaque backdrop and return the opaque
 * color a browser would actually paint, per CSS source-over compositing.
 *
 * Contrast math is defined between two opaque colors, so a translucent surface
 * such as the frosted sticky header or a scrim has no single ratio: its effective
 * color depends on whatever renders beneath it. Flattening against the extremes
 * of what can scroll under a surface gives the bounds worth asserting.
 *
 * Compositing happens in gamma-encoded sRGB, which is what browsers do by
 * default, so this must run BEFORE relativeLuminance linearizes the channels.
 */
export function compositeOver(
  overlay: string,
  alpha: number,
  backdrop: string,
): string {
  if (!(alpha >= 0 && alpha <= 1)) {
    // Guards the easy typo of passing a percentage (72) instead of a fraction
    // (0.72), which would otherwise silently return an out-of-gamut color.
    throw new RangeError(`alpha must be between 0 and 1, got ${alpha}`);
  }
  const over = parseHexColor(overlay);
  const under = parseHexColor(backdrop);
  const blend = (o: number, u: number) =>
    Math.round((o * alpha + u * (1 - alpha)) * 255);
  const channel = (n: number) => n.toString(16).padStart(2, "0");
  return `#${channel(blend(over.r, under.r))}${channel(blend(over.g, under.g))}${channel(blend(over.b, under.b))}`;
}

/**
 * Does a ratio clear WCAG AA? Normal text needs 4.5:1; large text (>=24px, or
 * >=19px bold) and UI components need 3:1.
 */
export function meetsAA(ratio: number, opts: { large?: boolean } = {}): boolean {
  return ratio >= (opts.large ? 3 : 4.5);
}
