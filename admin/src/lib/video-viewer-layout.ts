export const VIDEO_CONTEXT_MIN_PERCENT = 30;
export const VIDEO_CONTEXT_MAX_PERCENT = 70;
const VIDEO_CONTEXT_STEP_PERCENT = 2;
const VIDEO_CONTEXT_WIDTH_KEY = "cms.video-viewer.context-width";
const VIDEO_PANE_MIN_REM = 18;
export const VIDEO_RESIZE_TRACK_PX = 44;
export const VIDEO_SIDE_BY_SIDE_QUERY = "(min-width: 48.8125rem)";

export interface VideoContextBounds { min: number; max: number }

export function clampVideoContextWidth(value: number, bounds: VideoContextBounds = {
  min: VIDEO_CONTEXT_MIN_PERCENT,
  max: VIDEO_CONTEXT_MAX_PERCENT,
}): number {
  if (!Number.isFinite(value)) return 35;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)) * 4) / 4;
}

export function videoPaneMinimumPixels(): number {
  if (typeof document === "undefined") return VIDEO_PANE_MIN_REM * 16;
  const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return VIDEO_PANE_MIN_REM * (Number.isFinite(rootSize) ? rootSize : 16);
}

export function videoContextBounds(workspaceWidth: number, paneMinimum = videoPaneMinimumPixels()): VideoContextBounds {
  if (workspaceWidth <= 0) return { min: VIDEO_CONTEXT_MIN_PERCENT, max: VIDEO_CONTEXT_MAX_PERCENT };
  const min = Math.max(VIDEO_CONTEXT_MIN_PERCENT, paneMinimum / workspaceWidth * 100);
  const max = Math.min(VIDEO_CONTEXT_MAX_PERCENT,
    (workspaceWidth - VIDEO_RESIZE_TRACK_PX - paneMinimum) / workspaceWidth * 100);
  if (max < min) return { min: 50, max: 50 };
  const roundedMin = Math.ceil(min * 4) / 4;
  const roundedMax = Math.floor(max * 4) / 4;
  if (roundedMax >= roundedMin) return { min: roundedMin, max: roundedMax };
  // Rounding can cross bounds that only just fit; keep one consistent separator value.
  const only = Math.round((min + max) / 2 * 4) / 4;
  return { min: only, max: only };
}

export function readVideoContextWidth(): number | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(VIDEO_CONTEXT_WIDTH_KEY);
    if (raw === null || raw === undefined || raw.trim() === "") return undefined;
    return clampVideoContextWidth(Number(raw));
  } catch {
    return undefined;
  }
}

export function storeVideoContextWidth(value: number) {
  try {
    globalThis.localStorage?.setItem(VIDEO_CONTEXT_WIDTH_KEY, String(value));
  } catch {
    // Blocked storage keeps the resized panes for this open viewer only.
  }
}

const TABBABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

export function tabbableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)]
    .filter(element => element.tabIndex >= 0 && !element.closest("[hidden], [inert]"));
}

export function stepVideoContextWidth(value: number, key: string, bounds: VideoContextBounds): number | null {
  if (key === "ArrowLeft") return clampVideoContextWidth(value - VIDEO_CONTEXT_STEP_PERCENT, bounds);
  if (key === "ArrowRight") return clampVideoContextWidth(value + VIDEO_CONTEXT_STEP_PERCENT, bounds);
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  return null;
}
