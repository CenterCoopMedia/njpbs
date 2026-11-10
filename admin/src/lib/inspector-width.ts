// The inspector's width in rem. It drags and steps
// between the inspector-min and inspector-max tokens and is stored per person.

export const INSPECTOR_MIN_REM = 18;
export const INSPECTOR_MAX_REM = 28;
export const INSPECTOR_DEFAULT_REM = 20;
const KEY_STEP_REM = 1;

export interface InspectorWidthBounds {
  min: number;
  max: number;
  defaultWidth: number;
}

export const INSPECTOR_WIDTH_BOUNDS: InspectorWidthBounds = {
  min: INSPECTOR_MIN_REM, max: INSPECTOR_MAX_REM, defaultWidth: INSPECTOR_DEFAULT_REM,
};

export function clampInspectorWidth(rem: number, bounds = INSPECTOR_WIDTH_BOUNDS): number {
  if (!Number.isFinite(rem)) return bounds.defaultWidth;
  const clamped = Math.min(bounds.max, Math.max(bounds.min, rem));
  return Math.round(clamped * 4) / 4;
}

/** The new width for a window-splitter key, or null when the key does not resize. */
export function stepInspectorWidth(rem: number, key: string, bounds = INSPECTOR_WIDTH_BOUNDS, edge: "left" | "right" = "left"): number | null {
  const step = edge === "left" ? KEY_STEP_REM : -KEY_STEP_REM;
  switch (key) {
    case "ArrowLeft": return clampInspectorWidth(rem + step, bounds);
    case "ArrowRight": return clampInspectorWidth(rem - step, bounds);
    case "Home": return bounds.min;
    case "End": return bounds.max;
    default: return null;
  }
}

export function readStoredInspectorWidth(raw: string | null, bounds = INSPECTOR_WIDTH_BOUNDS): number {
  if (raw === null || raw.trim() === "") return bounds.defaultWidth;
  return clampInspectorWidth(Number(raw), bounds);
}

export function rootFontSize(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}
