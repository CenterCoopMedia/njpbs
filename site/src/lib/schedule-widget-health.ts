// Graceful degradation for the PBS JAWS schedule widget.
//
// The schedule page embeds one PBS-hosted widget: gc.js (loaded from PBS's CDN)
// reads PBS_CHROME_CONFIG and renders the full-week grid into its placeholder at
// runtime (see schedule-widget.ts). That embed is the one live PBS surface whose
// failure this origin can DETECT: gc.js writes into our own DOM, so a failed
// render leaves an observable empty box we can replace with a fallback. The other
// live PBS surface, the livestream player iframe on /live/, is cross-origin, so
// same-origin policy hides its load state from us; its degradation is a
// persistent escape hatch next to the frame, not a detected fallback (see
// PublicSubpage.astro, data-player-fallback). Everything else on the page
// (editorial prose, navigation, the donate path) is static and renders with no
// PBS call, so it already survives an outage for free.
//
// The static markup ships a fallback paragraph inside the placeholder, which covers
// one failure mode: gc.js never loads at all (CDN down, DNS failure, the script
// blocked), so nothing replaces the paragraph and the links stay. It does NOT
// cover the other mode: gc.js loads but its own upstream fetch to PBS 403s (access
// lapsed), 429s (rate limited), or times out. In that case gc.js can clear the
// placeholder and leave an empty box that requires a fallback.
//
// This module is the decision layer for both modes. It is pure and DOM-light so
// the interesting logic is unit-tested; the island wiring in PublicSubpage.astro
// is a thin delegate that reveals an honest, announced fallback when the status
// here resolves to "unavailable".

/** What the schedule frame should show. */
export type ScheduleWidgetStatus =
  /** Within the grace window, no failure seen yet: keep waiting on gc.js. */
  | "loading"
  /** gc.js populated the placeholder with real widget content. */
  | "ready"
  /** gc.js failed to load, or rendered nothing by the deadline: show fallback. */
  | "unavailable";

/** How long to wait for gc.js to render before treating the widget as down. */
export const SCHEDULE_RENDER_DEADLINE_MS = 8000;

/**
 * The selector that signals real listing data has rendered inside the
 * placeholder. See {@link isWidgetRendered} for why this follows listing data
 * rather than the widget's row-shaped layout.
 */
export const SCHEDULE_GRID_SELECTOR = "[data-program-title]";

/** Inputs the status decision is made from. All three are observable in the DOM. */
export interface ScheduleWidgetSignals {
  /** The gc.js loader `<script>` fired an `error` event (it failed to load). */
  readonly loaderErrored: boolean;
  /** The placeholder holds real widget content, per {@link isWidgetRendered}. */
  readonly widgetRendered: boolean;
  /** The render grace window has elapsed without the widget rendering. */
  readonly deadlineReached: boolean;
}

/**
 * Resolve what the schedule frame should show from the three observable signals.
 *
 * A rendered widget wins outright: if gc.js put real content in the placeholder
 * the schedule is up, regardless of any earlier error flag or the deadline. Only
 * when nothing rendered does a loader error or an elapsed deadline resolve to
 * "unavailable"; until then the frame is still "loading". The function is total
 * and order-independent, so the caller can re-run it on any signal change (an
 * error event, the deadline firing) and get a stable answer.
 */
export function resolveScheduleWidgetStatus(
  signals: ScheduleWidgetSignals,
): ScheduleWidgetStatus {
  if (signals.widgetRendered) return "ready";
  if (signals.loaderErrored) return "unavailable";
  if (signals.deadlineReached) return "unavailable";
  return "loading";
}

/**
 * Whether gc.js has rendered the real schedule grid into the placeholder.
 *
 * The signal is at least one element carrying JAWS's data-program-title
 * attribute. Layout scaffolding can already contain rows, controls and time
 * headers before listing data arrives. Following the data-bearing attribute
 * accepts both desktop and mobile presentations while rejecting an empty scaffold.
 *
 * The threshold is one because a single listing is usable. A higher count would
 * depend on incidental schedule density and could reject a sparse valid response.
 * This remains a DOM heuristic against an opaque third-party script, so a future
 * JAWS release that removes the attribute needs a new live observation before
 * this selector changes.
 */
export function isWidgetRendered(placeholder: Element): boolean {
  return placeholder.querySelector(SCHEDULE_GRID_SELECTOR) !== null;
}

/**
 * The screen-reader line announced when the widget resolves to unavailable. It
 * carries the same next step the visible fallback offers (livestream, video on
 * demand) so a screen-reader user hears where to go, not just a dead end. Plain
 * text, no links: it is spoken from a live region, and the revealed fallback
 * holds the actual links to navigate to.
 */
export const SCHEDULE_UNAVAILABLE_MESSAGE =
  "Live TV listings are temporarily unavailable. Watch the NJ PBS livestream or browse video on demand.";

/**
 * The three DOM handles {@link applyScheduleWidgetStatus} reconciles. Typed
 * structurally, not as HTMLElement, so a real element and a plain test object
 * both satisfy it and the policy stays unit-testable without a rendered DOM --
 * the same DOM-light stance as the rest of this module.
 */
export interface ScheduleWidgetElements {
  /** The grid block wrapping the placeholder; hidden once the widget is down. */
  readonly block: { hidden: boolean };
  /** The temporarily-unavailable notice; revealed once the widget is down. */
  readonly fallback: { hidden: boolean };
  /**
   * The polite live region carrying the failure announcement, or null if the
   * page has none. Cleared on recovery so a late render leaves no stale notice.
   */
  readonly announcer: { textContent: string | null } | null;
}

/**
 * Reconcile the schedule frame to a resolved status, and report whether the
 * widget has settled so the caller can stop watching.
 *
 * This is the status-to-DOM policy the island delegates to: "ready" reveals the
 * grid, hides the fallback, and clears any prior notice (so a late render after
 * an earlier failure does not leave a stale "unavailable" line in the live
 * region); "unavailable" hides the dead grid and reveals the honest fallback,
 * announcing it once -- it rewrites the live region only when the message is not
 * already there, so a second unavailable pass does not re-announce; "loading"
 * touches nothing. Only "ready" is terminal (returns true): a deadline-driven
 * "unavailable" can still recover if gc.js renders late, so the caller keeps the
 * observer running until this returns true. Pure but for the element mutations,
 * so it is unit-testable with plain objects.
 */
export function applyScheduleWidgetStatus(
  status: ScheduleWidgetStatus,
  elements: ScheduleWidgetElements,
): boolean {
  const { block, fallback, announcer } = elements;
  if (status === "loading") return false;
  if (status === "ready") {
    block.hidden = false;
    fallback.hidden = true;
    if (announcer) announcer.textContent = "";
    return true;
  }
  // unavailable
  block.hidden = true;
  fallback.hidden = false;
  if (announcer && announcer.textContent !== SCHEDULE_UNAVAILABLE_MESSAGE) {
    announcer.textContent = SCHEDULE_UNAVAILABLE_MESSAGE;
  }
  return false;
}
