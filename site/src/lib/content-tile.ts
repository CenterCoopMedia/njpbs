// The content tile's status model and badge logic.
//
// Members repeatedly hit dead-end "unavailable" surprises because a tile does not
// say what is free, what needs Passport, or what is leaving before they click. This
// module is the design-system primitive that fixes that: it turns a tile's data into
// an ordered list of status badges, each carrying both a text label and an icon so
// the meaning survives with colour removed (WCAG 1.4.1 -- never signal by colour
// alone). ContentTile.astro is a thin template over this; the logic lives here so it
// is testable without a browser, the same split the dialog controller uses.
//
// Availability and entitlement presentation states are driven by plain data.

export type TileAccess = "free" | "passport";
export type TileMediaKind = "episode" | "clip";

export interface ContentTileData {
  title: string;
  href: string;
  /** Free to stream vs behind a PBS Passport membership. */
  access: TileAccess;
  /** A full episode or a short clip, so people do not dig for an episode that is
   *  not there. */
  mediaKind: TileMediaKind;
  /** Legacy ISO date (YYYY-MM-DD) for one shared catalogue exit. */
  leavingOn?: string;
  /** ISO date when free public access ends but Passport access can continue. */
  leavingPublicOn?: string;
  /** ISO date when Passport or catalogue availability ends, when known. */
  leavingPassportOn?: string;
  /** Series or genre line shown under the title. */
  meta?: string;
}

export type BadgeTone = "free" | "passport" | "leaving" | "media";
export type BadgeIcon = "unlock" | "lock" | "clock" | "film" | "clip";

export interface TileBadge {
  /** Stable slot id: at most one badge per id on a tile. */
  id: "access" | "leaving" | "media";
  tone: BadgeTone;
  /** Visible text. Never empty: status is never signalled by colour alone (1.4.1). */
  label: string;
  /** Icon paired with the text, so the badge still reads with colour removed. */
  icon: BadgeIcon;
  /** Fuller context announced to assistive tech, e.g. the complete leaving date. */
  srText?: string;
}

// Foreground/background pair per tone. Kept here as the single source the component
// and the contrast test both read, so a colour that slips below AA fails the build
// rather than shipping an unreadable badge. Verified AA in content-tile.test.ts.
export const BADGE_COLORS: Record<BadgeTone, { bg: string; fg: string }> = {
  free: { bg: "var(--color-badge-free-bg)", fg: "var(--color-badge-free-fg)" },
  passport: {
    bg: "var(--color-badge-passport-bg)",
    fg: "var(--color-badge-passport-fg)",
  },
  leaving: {
    bg: "var(--color-badge-leaving-bg)",
    fg: "var(--color-badge-leaving-fg)",
  },
  media: { bg: "var(--color-badge-media-bg)", fg: "var(--color-badge-media-fg)" },
};

// Inner SVG markup per icon, wrapped by the component's <svg aria-hidden> shell,
// which supplies fill/stroke. Decorative: the text label carries the meaning.
export const BADGE_ICONS: Record<BadgeIcon, string> = {
  unlock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9.7h17M9 5v14M15 5v14"/>',
  clip: '<circle cx="7" cy="6.5" r="2.5"/><circle cx="7" cy="17.5" r="2.5"/><path d="M9.2 7.9 19 16.5M9.2 16.1 19 7.5"/>',
};

// The tile link is the interactive target; the badges are non-interactive status.
// 44px keeps the tap target comfortable (past the 24px 2.5.8 AA floor). The
// component applies this as a min touch height; exported so the test pins it.
export const TILE_MIN_TARGET_PX = 44;

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Parse a YYYY-MM-DD string by hand rather than via Date, which would apply the
// runner's timezone and can shift the day across a UTC boundary.
function parseISODate(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** Short visible label for a leaving badge, e.g. "Leaving Jul 10". */
export function formatLeavingLabel(iso: string): string {
  const p = parseISODate(iso);
  if (!p) return "Leaving soon";
  return `Leaving ${MONTHS_SHORT[p.m - 1]} ${p.d}`;
}

/** Short visible label for the end of a free viewing window. */
export function formatFreeUntilLabel(iso: string): string {
  const p = parseISODate(iso);
  if (!p) return "Free until soon";
  return `Free until ${MONTHS_SHORT[p.m - 1]} ${p.d}`;
}

/** Full date for the badge's assistive-tech text, e.g. "July 10, 2026". */
export function formatLeavingDateLong(iso: string): string {
  const p = parseISODate(iso);
  if (!p) return "soon";
  return `${MONTHS_LONG[p.m - 1]} ${p.d}, ${p.y}`;
}

/**
 * The ordered status badges for a tile: access first (free vs Passport), then the
 * availability date that affects the current viewer, then the media kind (full
 * episode vs clip). A free viewer sees the public-window end when it is known. A
 * Passport viewer never sees that date as a catalogue exit. The legacy leavingOn
 * field remains a shared fallback for existing callers.
 */
export function tileBadges(
  tile: ContentTileData,
  viewerAccess: TileAccess = "free",
): TileBadge[] {
  const badges: TileBadge[] = [];

  badges.push(
    tile.access === "free"
      ? { id: "access", tone: "free", label: "Free", icon: "unlock" }
      : { id: "access", tone: "passport", label: "Passport", icon: "lock" },
  );

  const publicWindowEnds = viewerAccess === "free" && tile.leavingPublicOn;
  const leavingOn = publicWindowEnds
    ? tile.leavingPublicOn
    : tile.leavingPassportOn ?? tile.leavingOn;

  if (leavingOn) {
    const prefix = publicWindowEnds ? "Free until" : "Leaving";
    badges.push({
      id: "leaving",
      tone: "leaving",
      label: publicWindowEnds
        ? formatFreeUntilLabel(leavingOn)
        : formatLeavingLabel(leavingOn),
      icon: "clock",
      srText: `${prefix} ${formatLeavingDateLong(leavingOn)}`,
    });
  }

  badges.push(
    tile.mediaKind === "clip"
      ? { id: "media", tone: "media", label: "Clip", icon: "clip" }
      : { id: "media", tone: "media", label: "Full episode", icon: "film" },
  );

  return badges;
}
