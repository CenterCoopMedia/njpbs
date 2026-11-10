// Network-preference logic — decides which enhancements to load on constrained
// connections (low bandwidth, metered/data-saver, slow mobile).
//
// These signals are progressive enhancement hints that only ever downgrade.
// They are never the gate that
// decides whether content is reachable. The Network Information API
// (navigator.connection) and Save-Data are Chromium-only — Safari and Firefox
// report nothing — so an absent/unknown signal MUST resolve to the full
// experience. Every predicate here defaults to "load it" when the signal is
// missing; only an explicit constrained signal flips it off. That keeps the
// normal-bandwidth experience identical while giving slow connections a lighter
// path instead of a broken or impossible one.

/** The subset of NetworkInformation we read. Shaped for easy unit testing. */
export interface ConnectionLike {
  /** the user's data-saver toggle (Chromium). undefined elsewhere. */
  saveData?: boolean;
  /** round-trip-estimated bucket: "slow-2g" | "2g" | "3g" | "4g". */
  effectiveType?: string;
}

// The "very slow" buckets — small enough that even modest enhancements hurt.
const VERY_SLOW = new Set(["slow-2g", "2g"]);

/** The user has explicitly asked to conserve data (Save-Data: on). */
export function isDataSaver(conn?: ConnectionLike | null): boolean {
  return !!conn && conn.saveData === true;
}

/**
 * The connection is in a slow bucket. By default that means 2g/slow-2g; pass
 * `include3g` for heavier enhancements (e.g. a WebGL engine) where 3g is also
 * too slow to be worth the payload. Unknown/absent effectiveType → false.
 */
export function isSlowConnection(
  conn?: ConnectionLike | null,
  opts: { include3g?: boolean } = {},
): boolean {
  const et = conn?.effectiveType;
  if (!et) return false;
  if (VERY_SLOW.has(et)) return true;
  return opts.include3g === true && et === "3g";
}

/**
 * Umbrella "constrained" check used for CSS-level downgrades (heavy GPU effects,
 * decorative background images): true on Save-Data OR a 2g bucket. Mirrors the
 * inline <head> script in Base.astro that sets `html[data-saver]`.
 */
export function isConstrainedConnection(conn?: ConnectionLike | null): boolean {
  return isDataSaver(conn) || isSlowConnection(conn);
}

/**
 * Whether to boot a heavy client-side enhancement — the Babylon WebGL hero is
 * the one that matters here (hundreds of KB of engine + a ~90 KB point cloud).
 * Skipped on Save-Data or any slow bucket including 3g; the static SVG fallback
 * already covers the no-enhancement path.
 */
export function shouldLoadHeavyEnhancement(conn?: ConnectionLike | null): boolean {
  return !isDataSaver(conn) && !isSlowConnection(conn, { include3g: true });
}

/**
 * Whether to fetch the self-hosted web fonts (~118 KB). Skipped on Save-Data or
 * a very-slow bucket; the system-font stack carries the constrained path. The
 * CSS does the actual skipping (no glyph references the family, so no download);
 * this predicate exists for any script-level decision and for parity testing.
 */
export function shouldLoadWebFonts(conn?: ConnectionLike | null): boolean {
  return !isDataSaver(conn) && !isSlowConnection(conn);
}

/**
 * Read the live browser connection, normalized to ConnectionLike. Returns null
 * when the API is unavailable (SSR, Safari, Firefox) so callers fall through to
 * the full-experience default.
 */
export function readConnection(): ConnectionLike | null {
  if (typeof navigator === "undefined") return null;
  const c = (navigator as unknown as { connection?: ConnectionLike }).connection;
  if (!c) return null;
  return { saveData: c.saveData, effectiveType: c.effectiveType };
}
