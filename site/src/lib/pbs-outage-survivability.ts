// Pure model of independent fallback behavior across PBS-backed surfaces.
// For any set of upstream failures, assess the modeled page's usable surfaces.
// Editorial content, navigation and the donation landing page make no PBS call.
// PBS-hosted payment completion is assessed separately from that landing page.
// The model performs no network, DOM or clock access; callers verify that their
// rendered surface graph satisfies these same independence constraints.

/**
 * Surface taxonomy for the outage model. The player, schedule embed, now/next
 * proxy, Media Manager cards, membership gate and donation transaction depend on
 * PBS services. Editorial content, navigation and the donation landing page are
 * modeled independently. A usable landing page does not prove that an upstream
 * payment transaction can complete.
 */
export type PbsSurface =
  | "livestreamPlayer"
  | "scheduleGrid"
  | "nowNextStrip"
  | "vodLaunchCards"
  | "memberGatedPlayback"
  | "donateTransaction"
  | "editorialContent"
  | "navigation"
  | "giveLandingPage";

/**
 * The surfaces backed by a live PBS call, in the contract's surface order for a
 * stable, reviewable listing. Each is usable in an outage only if it also appears
 * in {@link SURFACES_WITH_FALLBACK}; a backed surface not listed there is broken
 * when it fails, and {@link assessOutage} reports it as such. One of these
 * (`donateTransaction`) has no fallback in this model, so a full lapse
 * leaves it broken.
 */
export const PBS_BACKED_SURFACES = [
  "livestreamPlayer",
  "scheduleGrid",
  "nowNextStrip",
  "vodLaunchCards",
  "memberGatedPlayback",
  "donateTransaction",
] as const;

/** Editorial content, navigation and the donation landing page make no PBS call.
 * Upstream failure cannot break these independently modeled surfaces. */
export const PBS_FREE_SURFACES = [
  "editorialContent",
  "navigation",
  "giveLandingPage",
] as const;

/**
 * The PBS-backed surfaces whose fallback a component renders today: the player's
 * persistent escape hatch ships in PublicSubpage, and the schedule grid's
 * widget-health state and the VOD launch cards ship in components. A visitor in a
 * live outage sees these.
 */
export const SURFACES_WITH_WIRED_FALLBACK = [
  "livestreamPlayer",
  "scheduleGrid",
  "vodLaunchCards",
] as const;

/**
 * Policy-only surfaces are kept separate from modeled wired fallback coverage.
 * assessOutage reports them through surfacesAwaitingWiring, so noSurfaceBroken
 * does not imply that these policies were exercised by a rendered surface.
 */
export const SURFACES_WITH_POLICY_ONLY_FALLBACK = [
  "nowNextStrip",
  "memberGatedPlayback",
] as const;

/**
 * Every PBS-backed surface with a defined, built fallback, wired or policy-ready.
 * Derived from the two lists above, so a surface cannot be counted as covered
 * without declaring which kind of fallback it has. A surface's usability in an
 * outage is membership here, not an assumption.
 *
 * `donateTransaction` (no CCM-hosted fallback donation path, not even a policy) is
 * deliberately absent, so the full-lapse test reports it broken -- the contract's
 * one remaining coverage gap -- instead of overstating coverage.
 */
export const SURFACES_WITH_FALLBACK = [
  ...SURFACES_WITH_WIRED_FALLBACK,
  ...SURFACES_WITH_POLICY_ONLY_FALLBACK,
] as const;

/**
 * The outcome for one surface under a given outage, as two booleans encoding the
 * three reachable states:
 *   - live:     usable && !degraded  -- serving its own content (PBS call fine, or
 *               a PBS-free surface)
 *   - degraded: usable &&  degraded  -- PBS call failing, serving a built fallback
 *   - broken:  !usable &&  degraded  -- PBS call failing with no built fallback
 * (`!usable && !degraded` never occurs: a surface is broken only by failing.)
 *
 * `usable` is the contract's whole point: a surface is usable when it renders its
 * content or an honest fallback, and broken when it can only fail. `degraded`
 * marks a PBS-backed surface whose own live call is failing, whether it falls back
 * or breaks; a PBS-free surface is never degraded, because it has no live PBS path
 * to lose.
 */
export interface SurfaceOutcome {
  readonly usable: boolean;
  readonly degraded: boolean;
}

/** What the whole page exposes under a set of failing PBS surfaces. */
export interface PageOutage {
  /** Every surface's outcome, keyed by surface, always fully populated. */
  readonly surfaces: Readonly<Record<PbsSurface, SurfaceOutcome>>;
  /** True when editorial content, navigation and the donation landing page are
   * usable. Payment completion is assessed separately. */
  readonly editorialShellUsable: boolean;
  /**
   * True when no surface is broken -- every one is live or on an honest fallback.
   * Under a full lapse this holds only because every PBS surface has a declared
   * fallback, so the flag is a real check on {@link SURFACES_WITH_FALLBACK}
   * coverage, not a constant. It counts a policy-ready fallback the same as a
   * wired one; read it with {@link surfacesAwaitingWiring} to tell the two apart.
   */
  readonly noSurfaceBroken: boolean;
  /** Failing surfaces covered only by a policy-only fallback, in taxonomy order.
   * Read alongside noSurfaceBroken to distinguish modeled policy coverage from
   * the wired fallback coverage represented by this model. */
  readonly surfacesAwaitingWiring: readonly PbsSurface[];
}

const PBS_BACKED = new Set<PbsSurface>(PBS_BACKED_SURFACES);
const HAS_FALLBACK = new Set<PbsSurface>(SURFACES_WITH_FALLBACK);
const POLICY_ONLY_FALLBACK = new Set<PbsSurface>(SURFACES_WITH_POLICY_ONLY_FALLBACK);
const ALL_SURFACES: readonly PbsSurface[] = [
  ...PBS_BACKED_SURFACES,
  ...PBS_FREE_SURFACES,
];

/**
 * The outcome for a single surface, as a pure truth table over its three facts:
 * whether it is PBS-backed, whether its own call is failing, and whether it has a
 * built fallback. Split out from {@link assessOutage} so the derivation is
 * unit-testable directly, including the broken case (backed, failing, no fallback)
 * in isolation.
 *
 * A PBS-free surface is always usable and never degraded; `failing` is not even a
 * parameter, so its survival cannot depend on PBS state. A PBS-backed surface is
 * live when its call is fine, and `degraded` once it is failing -- usable if it
 * has a built fallback to serve, broken if it does not.
 */
export function surfaceOutcome(
  pbsBacked: boolean,
  failing: boolean,
  hasFallback: boolean,
): SurfaceOutcome {
  if (!pbsBacked) return { usable: true, degraded: false };
  return { usable: !failing || hasFallback, degraded: failing };
}

/**
 * Assess what the page still exposes when a given set of PBS surfaces is failing.
 *
 * Total and pure: it returns an outcome for every declared surface, never throws,
 * and never mutates its input. A surface's outcome depends only on the taxonomy
 * and on whether *that same surface* is in `failing` -- never on any other
 * surface -- so the surfaces are independent by construction.
 *
 * The `failing` set is read only for PBS-backed surfaces. A PBS-free surface
 * listed in it is ignored: the editorial shell has no PBS call to fail, so its
 * survival is fixed by the classification here and a caller cannot revoke it with
 * a bad set. A PBS-backed surface that is failing is usable only if it has a
 * declared fallback ({@link SURFACES_WITH_FALLBACK}); otherwise it is broken.
 *
 * Usable does not mean shipped. A surface covered only by a policy fallback counts
 * as usable here and is also named in {@link PageOutage.surfacesAwaitingWiring},
 * so a caller can ask either what the contract covers or what a visitor would see
 * today.
 */
export function assessOutage(failing: ReadonlySet<PbsSurface>): PageOutage {
  const surfaces = {} as Record<PbsSurface, SurfaceOutcome>;

  for (const surface of ALL_SURFACES) {
    if (PBS_BACKED.has(surface)) {
      // Reads this surface's own status only, never a sibling's.
      surfaces[surface] = surfaceOutcome(
        true,
        failing.has(surface),
        HAS_FALLBACK.has(surface),
      );
    } else {
      // A PBS-free surface never consults `failing` -- there is no PBS call
      // behind it to have failed.
      surfaces[surface] = surfaceOutcome(false, false, false);
    }
  }

  const editorialShellUsable = PBS_FREE_SURFACES.every(
    (surface) => surfaces[surface].usable,
  );
  const noSurfaceBroken = ALL_SURFACES.every(
    (surface) => surfaces[surface].usable,
  );
  // Read off `failing` rather than off `surfaces`, because a policy-ready surface
  // that is not failing is serving its own live content and is waiting on nothing.
  const surfacesAwaitingWiring = PBS_BACKED_SURFACES.filter(
    (surface) => failing.has(surface) && POLICY_ONLY_FALLBACK.has(surface),
  );

  return {
    surfaces,
    editorialShellUsable,
    noSurfaceBroken,
    surfacesAwaitingWiring,
  };
}
