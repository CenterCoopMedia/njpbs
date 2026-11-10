// Single source of truth for the landing-page chooser: the candidate design
// directions, in the order the team sees them. Each entry carries the heroConfig the
// shared particle-NJ engine uses while that direction is active, so flipping tabs
// re-themes one Babylon scene instead of standing up four WebGL contexts.
//
// The hero fill/edge here mirror each kit's own palette (public/kits/<id>/tokens.json).
// Blurbs are short, factual, and guardrail-safe — they describe the visual character,
// not any operator/launch claim.

import type { NJHeroConfig } from "./hero-config";

export interface ChooserKit {
  /** namespace id; matches public/kits/<id>/ and the <id> opt-in wrapper class */
  id: string;
  /** human title shown on the tab */
  title: string;
  /** one-line description of the visual direction */
  blurb: string;
  /** hero look + motion for this direction, merged over DEFAULT_CONFIG at mount */
  heroConfig: Partial<NJHeroConfig>;
  /**
   * Color overrides applied over heroConfig when the chooser is in dark mode. Only
   * needed where the light-mode fill/edge would disappear or read poorly on the dark
   * page — e.g. gs, whose ink fill is the same near-black as its own dark background.
   * Omitted for kits whose light colors already read on their dark palette.
   */
  heroConfigDark?: Partial<NJHeroConfig>;
}

export const CHOOSER_KITS: ChooserKit[] = [
  {
    id: "gs",
    title: "Garden State public",
    blurb:
      "Calm editorial newsroom — serif headlines, a steady grid, public-media restraint.",
    heroConfig: {
      background: "transparent",
      fill: "#16181d",
      edge: "#b11e3c",
      pointSize: 2,
      drift: 0.01,
      repelRadius: 0.3,
      repelStrength: 0.4,
      dissolve: 1.5,
    },
    // Light gs is dark ink on warm paper; its dark page is paper-light text on ink.
    // The cloud inverts to match: cream fill (--gs-ink in dark = #F2F0EA) so it stays
    // visible — the light #16181d fill is the same near-black as the gs dark bg — and
    // the lightened cranberry edge (--gs-cranberry in dark = #FF8DA3).
    heroConfigDark: {
      fill: "#f2f0ea",
      edge: "#ff8da3",
    },
  },
  {
    id: "sig",
    title: "Signal",
    blurb:
      "Broadcast control room — bold sans, a channel clock, on-air energy.",
    heroConfig: {
      background: "transparent",
      fill: "#2638c4",
      edge: "#f2f5ff",
      pointSize: 2.6,
      drift: 0.014,
      repelRadius: 0.3,
      repelStrength: 0.5,
      dissolve: 1.5,
    },
  },
  {
    id: "post",
    title: "Garden State poster",
    blurb:
      "WPA poster heritage — heavy display type, halftone texture, civic boldness.",
    heroConfig: {
      background: "transparent",
      fill: "#1d4e89",
      edge: "#c8102e",
      pointSize: 3,
      drift: 0.014,
      repelRadius: 0.34,
      repelStrength: 0.5,
      dissolve: 1.8,
    },
  },
  {
    id: "glasshouse",
    title: "Garden signal glasshouse",
    blurb:
      "Flourishing garden growth inside retro television glass, with 3D signal bloom.",
    heroConfig: {
      background: "transparent",
      fill: "#2f8f46",
      edge: "#f7f3df",
      pointSize: 2.8,
      drift: 0.018,
      repelRadius: 0.28,
      repelStrength: 0.38,
      dissolve: 1.35,
    },
    heroConfigDark: {
      fill: "#b7ffd8",
      edge: "#f0b23e",
    },
  },
];

export function getChooserKit(id: string): ChooserKit {
  const kit = CHOOSER_KITS.find((k) => k.id === id);
  if (!kit) {
    throw new Error(
      `unknown chooser kit: ${id} (expected one of ${CHOOSER_KITS.map((k) => k.id).join(", ")})`,
    );
  }
  return kit;
}
