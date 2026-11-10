import { publicPage } from "./public-pages.ts";

/** A persisted opt-in survives removal of every authored block. */
export function serviceCompositionError(pageId: string, version: unknown): string | null {
  if (version === undefined) return null;
  if (version !== 1) return "The service composition version is invalid.";
  if (publicPage(pageId)?.family !== "service") return "Only service pages can use a service composition.";
  return null;
}

export function usesServiceComposition(page: {
  family: string;
  serviceCompositionVersion?: unknown;
  blocks?: unknown;
}): boolean {
  return page.family === "service" && page.serviceCompositionVersion === 1;
}
