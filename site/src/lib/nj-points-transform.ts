// Pure geometry for the particle-NJ hero — no Babylon, so it tests without a GPU.
// Two responsibilities: place a normalized NJ point into its "home" position with a
// little deterministic depth jitter, and map native scroll position to a 0..1
// dissolve progress. The scroll mapping is pure and bounded ON PURPOSE: the hero
// READS scroll, it never drives it, so there is no path to scroll-jacking here.

export interface HomePoint {
  hx: number;
  hy: number;
  hz: number;
  /** per-point phase offset so idle drift is not synchronized */
  phase: number;
}

const TWO_PI = Math.PI * 2;

/**
 * Map a normalized NJ point (x,y in roughly [-1,1]) to its home position, scaled to
 * fill the frame. hz is a small deterministic depth jitter (|hz| <= 0.09) so the
 * cloud has thickness; phase seeds the idle drift.
 */
export function toHomePoint(x: number, y: number, scale: number): HomePoint {
  return {
    hx: x * scale,
    hy: y * scale,
    hz: Math.sin(x * 12.9 + y * 78.2) * 0.5 * 0.18,
    phase: (x * 53.3 + y * 17.7) % TWO_PI,
  };
}

/**
 * Scroll-driven dissolve progress, clamped to [0,1]. 0 while the hero top is at or
 * below the fold; 1 once it has scrolled a full viewport above the fold. Guards a
 * zero/negative viewport height (returns 0) so it is safe on first paint.
 */
export function scrollProgress(rectTop: number, viewportHeight: number): number {
  if (viewportHeight <= 0) return 0;
  return Math.min(1, Math.max(0, -rectTop / viewportHeight));
}

export interface RepelOffset {
  dx: number;
  dy: number;
}

/**
 * Target pointer-repel offset for a point at (baseX, baseY) pushed away from a pointer
 * at (pointerX, pointerY). Writes the result into `out` and returns it — the caller
 * reuses one scratch object across the whole point cloud so the per-frame hot loop
 * allocates nothing. Sets {dx, dy} = 0 when repel is off (radius <= 0), the point is
 * outside the radius, or it is effectively on top of the pointer (guards a
 * divide-by-zero). The push is radial and falls off linearly to 0 at the edge, so the
 * field is continuous in space. This is only the per-frame *target*; the frame-to-frame
 * smoothing that removes the snap lives in `approach`.
 */
export function repelOffset(
  out: RepelOffset,
  baseX: number,
  baseY: number,
  pointerX: number,
  pointerY: number,
  radius: number,
  strength: number,
): RepelOffset {
  out.dx = 0;
  out.dy = 0;
  if (radius <= 0) return out;
  const dx = baseX - pointerX;
  const dy = baseY - pointerY;
  const dist = Math.hypot(dx, dy);
  if (dist >= radius || dist <= 1e-4) return out;
  const push = (1 - dist / radius) * strength;
  out.dx = (dx / dist) * push;
  out.dy = (dy / dist) * push;
  return out;
}

/**
 * One exponential easing step from `current` toward `target`. `ease` in [0,1] is the
 * fraction of the remaining gap to close (0 = no move, 1 = instant jump). With ease in
 * that range the result never overshoots `target`, so the cloud settles without ringing.
 * Pair it with `easeFactor` to make the settle time frame-rate independent.
 */
export function approach(current: number, target: number, ease: number): number {
  return current + (target - current) * ease;
}

/**
 * Frame-rate-independent easing fraction for one step of `dtSeconds`, given a time
 * constant `tauSeconds` (the gap shrinks by ~63% every tau). Derived from continuous
 * exponential decay (1 - e^(-dt/tau)), so feeding it into `approach` settles in the
 * same wall-clock time whether the loop runs at 60 or 144 Hz — a fixed per-frame
 * fraction would instead settle faster on high-refresh displays. Returns 0 for a
 * non-positive dt (no time elapsed) and 1 for a non-positive tau (degenerate: snap).
 */
export function easeFactor(dtSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return 1;
  if (dtSeconds <= 0) return 0;
  return 1 - Math.exp(-dtSeconds / tauSeconds);
}
