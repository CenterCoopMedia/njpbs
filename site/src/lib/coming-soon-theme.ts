// Signal-palette tokens and the NJ hero config for the public coming-soon page.
//
// Pure data on purpose: index.astro stays declarative, and the contrast test
// (tests/coming-soon-theme.test.ts) feeds every text/surface pairing through
// contrastRatio so a sub-AA choice fails the build. The Signal palette uses
// PBS blue at full strength.

import { mergeHeroConfig, type NJHeroConfig } from "./hero-config";

export const SIGNAL = {
  /** deep navy "on-air" field — Signal's optional darker surface */
  surface: "var(--color-signal-surface)",
  /** primary PBS blue — the particle interior fill */
  pbsBlue: "var(--pbs-blue)",
  /** cool near-white tint — the crisp particle outline, and muted body text */
  nearWhite: "var(--color-signal-near-white)",
  white: "var(--color-white)",
} as const;

// Each text role on the navy surface and the AA floor it must clear. The test
// asserts contrastRatio(fg, bg) >= minRatio for every entry.
export const COMING_SOON_TEXT = [
  {
    name: "mark",
    fg: "var(--color-text-on-surface)",
    bg: SIGNAL.surface,
    minRatio: 4.5,
  },
  {
    name: "tagline",
    fg: "var(--color-text-on-surface)",
    bg: SIGNAL.surface,
    minRatio: 4.5,
  },
  { name: "status", fg: SIGNAL.nearWhite, bg: SIGNAL.surface, minRatio: 4.5 },
  // The forward-link slots below: the active link uses the shared on-surface role,
  // while the "coming soon" affordance uses muted near-white. Both are checked here.
  {
    name: "link",
    fg: "var(--color-text-on-surface)",
    bg: SIGNAL.surface,
    minRatio: 4.5,
  },
  {
    name: "link-pending",
    fg: SIGNAL.nearWhite,
    bg: SIGNAL.surface,
    minRatio: 4.5,
  },
] as const;

// Optional links on the coming-soon page. A null href renders a non-link
// "coming soon" affordance; a configured URL renders a real link. Labels stay
// neutral and no placeholder "#" link is emitted.
export interface ComingSoonLink {
  name: string;
  label: string;
  href: string | null;
  pending: string;
}

export const COMING_SOON_LINKS: ComingSoonLink[] = [
  {
    name: "announcement",
    label: "Read the announcement",
    href: null,
    pending: "Coming soon",
  },
  {
    name: "jobs",
    label: "See open positions",
    href: null,
    pending: "Coming soon",
  },
];

// The NJ particle map in the Signal look: PBS-blue interior, near-white outline,
// over a transparent scene so the navy page surface shows through. Slightly
// larger points and a touch more idle drift than the engine default give it a
// livelier "on-air" feel. Motion still only reads scroll — never intercepts it.
export const SIGNAL_HERO: NJHeroConfig = mergeHeroConfig({
  background: "transparent",
  fill: SIGNAL.pbsBlue,
  edge: SIGNAL.nearWhite,
  pointSize: 2.6,
  drift: 0.016,
});
