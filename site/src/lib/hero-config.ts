// Pure, render-free configuration + color math for the NJ particle hero.
//
// No Babylon import here on purpose. This is the logic the engine depends on,
// so keeping it pure means it tests fast (no WebGL/GPU) and stays the single
// source of truth for NJHeroConfig + DEFAULT_CONFIG. nj-hero.ts imports these
// and adapts the plain RGBA into Babylon Color4 at the rendering boundary.

export interface NJHeroConfig {
  /** scene clear color; use "transparent" to let the page background show */
  background: string | "transparent";
  /** interior fill point color */
  fill: string;
  /** boundary/edge point color (the crisp outline) */
  edge: string;
  /** rendered point size in px */
  pointSize: number;
  /** rendered point size in px on coarse mobile pointers */
  compactPointSize: number;
  /** calmer interior fill on coarse mobile pointers */
  compactFill: string;
  /** calmer edge color on coarse mobile pointers */
  compactEdge: string;
  /** idle drift amplitude in world units (0 disables drift) */
  drift: number;
  /** pointer repel radius in world units (0 disables repel) */
  repelRadius: number;
  /** repel strength multiplier */
  repelStrength: number;
  /** how far points scatter at full scroll-dissolve (world units) */
  dissolve: number;
}

export const DEFAULT_CONFIG: NJHeroConfig = {
  background: "transparent",
  fill: "var(--color-hero-default-fill)",
  edge: "var(--color-hero-default-edge)",
  pointSize: 2.2,
  compactPointSize: 1.8,
  compactFill: "var(--color-hero-default-compact-fill)",
  compactEdge: "var(--color-hero-default-compact-edge)",
  drift: 0.012,
  // The cloud spans ~2.6 world units tall; a 0.32 radius only ever rippled a
  // small puddle. 0.5 reaches a meaningful share of the state under the cursor.
  repelRadius: 0.5,
  repelStrength: 0.45,
  dissolve: 1.6,
};

/** Public-homepage particle palette, kept out of component-authored styles. */
export const CINEMATIC_HERO_CONFIG: Partial<NJHeroConfig> = {
  background: "transparent",
  fill: "var(--color-hero-cinematic-fill)",
  edge: "var(--color-hero-cinematic-edge)",
  pointSize: 2.6,
  compactFill: "var(--color-hero-cinematic-compact-fill)",
  compactEdge: "var(--color-hero-cinematic-compact-edge)",
  compactPointSize: 1.55,
  repelRadius: 0.6,
  repelStrength: 0.5,
};

/** RGBA channels in 0..1 — the shape both a 2D canvas and a Babylon Color4 accept. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Merge a partial theme config over the defaults, returning a fresh object. */
export function mergeHeroConfig(
  userConfig: Partial<NJHeroConfig> = {},
): NJHeroConfig {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  if (userConfig.fill !== undefined && userConfig.compactFill === undefined) {
    config.compactFill = config.fill;
  }
  if (userConfig.edge !== undefined && userConfig.compactEdge === undefined) {
    config.compactEdge = config.edge;
  }
  return config;
}

/**
 * Parse a "#rrggbb" (or shorthand "#rgb") hex string into 0..1 RGBA.
 * Tolerates surrounding whitespace, a missing "#", and any case.
 * Alpha is always 1 — opacity is handled by the engine, not the color string.
 */
export function parseHexColor(hex: string): RGBA {
  let h = hex.trim().toLowerCase();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: 1,
  };
}
