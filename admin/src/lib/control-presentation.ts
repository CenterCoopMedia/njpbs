export const CONTROL_PRESENTATIONS = ["text", "icons"] as const;

export type ControlPresentation = (typeof CONTROL_PRESENTATIONS)[number];

export const DEFAULT_CONTROL_PRESENTATION: ControlPresentation = "icons";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readControlPresentation(profile: unknown): ControlPresentation {
  const preferences = record(record(profile)?.preferences);
  const display = record(preferences?.display);
  const value = display?.controlPresentation;
  return value === "icons" || value === "text"
    ? value
    : DEFAULT_CONTROL_PRESENTATION;
}
