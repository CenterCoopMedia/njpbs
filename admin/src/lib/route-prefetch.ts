// Intent-based route code prefetch (#1065).
//
// The Admin loads only the addressed route graph at startup (#998/PR #1017), which keeps the
// authentication path bounded but leaves a warm navigation waiting for its destination chunk.
// PR #1017 rejected preloading every route after sign-in because it delayed the shell on a
// constrained connection. This is the narrower move: start a destination's JavaScript only
// after the person has indicated they are likely to open it.
//
// What this module does not do.
//
// - It keeps no second route registry. The loaders are `adminRoutePreloaders` -- the same
//   `adminRouteModules` functions React Router's lazy routes call, with the same one composition
//   the addressed startup preload uses, so a content destination starts the routed boundary and
//   the editor workspace behind it together rather than leaving the heaviest graph for after the
//   click. The path-to-loader map is `routeModuleKeyForPath`, again the shared one. A prefetched
//   module is therefore the very promise navigation later awaits: it is evaluated once, not
//   twice.
// - It fetches code only. No CMS content, media, profile, capability, audit, or access-management
//   request is made here, so nothing a person merely hovered can read data they have not asked
//   for, and no authorization boundary is touched or anticipated.
// - It emits no performance marks. The receipt's `route-load` measure (#1064/#1132) answers
//   "how long did the person wait for this route's code," and a speculative download nobody is
//   waiting on is not that. Timing it as `route-load` would inflate the count and the durations
//   with work that cost no one anything; giving it its own mark would enlarge the frozen
//   inventory for a boundary with no waiting person behind it. So prefetch stays out of the
//   receipt entirely, and the honest effect shows up where it belongs: a navigation that was
//   prefetched records a near-zero `route-load`, because that is what the person waited.
// - It queues nothing. One pending intent exists at a time and the pointer or focus can only be
//   in one place, so a sweep across the rail downloads the destination it settled on, not the
//   whole application.
import {
  adminRoutePreloaders,
  routeModuleKeyForPath,
  type RouteModuleKey,
} from "../routes/routeModules";

export type RoutePrefetchModules = Record<
  RouteModuleKey,
  () => Promise<unknown>
>;

/**
 * How the person signalled they may open this destination.
 *
 * `pointer` and `focus` are weak signals and wait out the delay below: a pointer crossing the
 * rail and a keyboard moving through it both pass over every destination in far less time than
 * a person who means to open one. `activation` is a press already under way, so it starts at
 * once — there is nothing left to disambiguate.
 */
export type PrefetchSignal = "pointer" | "focus" | "activation";

// Long enough that crossing or tabbing past a control is not intent, short enough that it still
// finishes ahead of the click for anyone who paused to read the label.
export const ROUTE_PREFETCH_DELAY_MS = 120;

interface NavigatorConnection {
  saveData?: unknown;
}

/**
 * Whether the browser asked for reduced data use. Optional prefetching is exactly the kind of
 * speculative traffic `Save-Data` is about, so the answer is honored wherever it is exposed.
 * A browser that exposes nothing is not treated as a refusal: an absent hint means unknown,
 * and the ordinary behavior stands.
 */
export function saveDataRequested(
  nav: Navigator | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): boolean {
  const connection = (nav as { connection?: NavigatorConnection } | undefined)
    ?.connection;
  return connection?.saveData === true;
}

export interface RoutePrefetchOptions {
  modules?: RoutePrefetchModules;
  delayMs?: number;
  saveData?: () => boolean;
  navigator?: Navigator;
  schedule?: (run: () => void, delayMs: number) => number;
  cancelScheduled?: (handle: number) => void;
}

/** The modalities that can arm a delayed intent, and so the ones that can withdraw it. */
export type PrefetchModality = "pointer" | "focus";

export interface RoutePrefetcher {
  /** Record an intent toward `pathname`. Weak signals wait out the delay; activation starts now. */
  intent(pathname: string, signal: PrefetchSignal): void;
  /**
   * Withdraw one modality's intent. A pending load is dropped only once every modality that
   * armed it has withdrawn: a pointer sliding off a control the keyboard is still focused on is
   * not a withdrawal, and cancelling there would leave Enter navigating cold, because no second
   * focus event follows to re-arm it. Called with no argument it drops the pending load outright.
   */
  cancel(from?: PrefetchModality): void;
  /** The modules this prefetcher has started, for tests and diagnostics. */
  started(): RouteModuleKey[];
}

export function createRoutePrefetcher(
  options: RoutePrefetchOptions = {},
): RoutePrefetcher {
  const modules = options.modules ?? adminRoutePreloaders;
  const delayMs = options.delayMs ?? ROUTE_PREFETCH_DELAY_MS;
  const readSaveData =
    options.saveData ?? (() => saveDataRequested(options.navigator));
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) =>
      globalThis.setTimeout(run, ms) as unknown as number);
  const cancelScheduled =
    options.cancelScheduled ??
    ((handle: number) => globalThis.clearTimeout(handle));

  // Started, not finished: a module already in flight must not be started again, and the
  // module promise itself is what makes a later navigation free.
  const started = new Set<RouteModuleKey>();
  let pending: {
    key: RouteModuleKey;
    handle: number;
    armedBy: Set<PrefetchModality>;
  } | null = null;

  function clearPending(from?: PrefetchModality): void {
    if (!pending) return;
    if (from) {
      pending.armedBy.delete(from);
      if (pending.armedBy.size > 0) return;
    }
    cancelScheduled(pending.handle);
    pending = null;
  }

  function start(key: RouteModuleKey): void {
    if (started.has(key)) return;
    started.add(key);
    const load = modules[key];
    try {
      void Promise.resolve(load()).catch(() => {
        // A chunk that failed to arrive is not a fact about the session: navigation will ask
        // for it again through the router's own lazy boundary, which owns the error surface.
        // Forget it here so a later intent may retry rather than sit on a failed promise.
        started.delete(key);
      });
    } catch {
      started.delete(key);
    }
  }

  return {
    intent(pathname, signal) {
      // Re-read on every intent rather than once at construction: a session outlives a
      // connection, and a person who switches on data saving mid-shift should stop paying for
      // speculation immediately.
      if (readSaveData()) {
        clearPending();
        return;
      }
      const key = routeModuleKeyForPath(pathname);
      if (started.has(key)) {
        clearPending();
        return;
      }
      if (signal === "activation") {
        clearPending();
        start(key);
        return;
      }
      // Re-entering the same control keeps the deadline it already has, so a small pointer
      // jitter cannot push the load past the click it was meant to precede. A second modality
      // arriving on the same control joins the intent rather than replacing it, so either one
      // leaving on its own does not drop what the other still wants.
      if (pending?.key === key) {
        pending.armedBy.add(signal);
        return;
      }
      // Intent toward a different destination supersedes the pending one, whichever modality
      // armed it: one pending intent is the whole queue, and the most recent signal is the
      // better guess at where the person is going.
      clearPending();
      const handle = schedule(() => {
        pending = null;
        // Asked again at the moment the bytes would be spent, not only when the pointer
        // arrived: a person who switches data saving on during the hover window has said no
        // before anything was fetched, and that answer is the one that counts.
        if (readSaveData()) return;
        start(key);
      }, delayMs);
      pending = { key, handle, armedBy: new Set([signal]) };
    },
    cancel: clearPending,
    started: () => Array.from(started),
  };
}

export interface RoutePrefetchHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onPointerDown: () => void;
  onTouchStart: () => void;
}

/**
 * The DOM handlers one route-opening control needs. Every handler is fire-and-forget: nothing
 * here calls preventDefault, awaits, or sits between the control and its own activation, so a
 * link behaves identically whether or not its module was started early.
 *
 * `pointerdown` and `touchstart` both appear because a browser that fires pointer events
 * suppresses neither, and one of them is the first thing a press produces on every input type.
 * Starting the module twice is harmless: the prefetcher only starts a module once.
 */
export function routePrefetchHandlers(
  prefetcher: RoutePrefetcher,
  to: string,
): RoutePrefetchHandlers {
  return {
    onPointerEnter: () => prefetcher.intent(to, "pointer"),
    onPointerLeave: () => prefetcher.cancel("pointer"),
    onFocus: () => prefetcher.intent(to, "focus"),
    onBlur: () => prefetcher.cancel("focus"),
    onPointerDown: () => prefetcher.intent(to, "activation"),
    onTouchStart: () => prefetcher.intent(to, "activation"),
  };
}
