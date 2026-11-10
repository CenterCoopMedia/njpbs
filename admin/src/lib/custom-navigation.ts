import { ICON_NAMES, type IconName } from "./icon-names";

export const MAX_CUSTOM_NAVIGATION_ITEMS = 10;
export const MAX_NAVIGATION_LABEL_LENGTH = 60;
export const MAX_NAVIGATION_URL_LENGTH = 2048;
// Use the existing icon vocabulary. This small selection keeps the picker easy to scan.
export const CUSTOM_NAVIGATION_ICONS = ["link", "file", "folder", "home", "calendar", "media", "users", "settings", "external-link"] as const satisfies readonly IconName[];
export type CustomDestination = { kind: "url"; url: string } | { kind: "post" | "page"; id: string };
export interface CustomNavLink { id: string; kind: "link"; label: string; icon?: IconName; destination: CustomDestination }
export interface CustomNavSection { id: string; kind: "section"; label: string; icon?: IconName; links: CustomNavLink[] }
export type CustomNavItem = CustomNavLink | CustomNavSection;

/** A portable stored address: local CMS path or HTTPS, never an origin-relative authority. */
export function isSafeNavigationUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_NAVIGATION_URL_LENGTH || /[^\x21-\x7e]|\\/.test(value)) return false;
  if (/%(?:2e|2f|5c)/i.test(value) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(value)) return false;
  if (value.startsWith("/")) {
    return /^\/(?:[?#].*)?$/.test(value) || /^\/(?:content|media|voiceovers|dashboard|activity|analytics|publish-queue|reports|guide|resources|schedule|staff-access|staff-profiles|admin|account|post-templates|premiere|live-production|cuez-storydesk)(?:[/?#].*)?$/.test(value);
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:[/?#].*)?$/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}

/** Convert a pasted same-origin address to the stored CMS path form. */
export function normalizeNavigationUrl(value: string, origin: string): string {
  const trimmed = value.trim();
  try { const url = new URL(trimmed, origin); if (url.origin === origin && trimmed.startsWith("https://")) return `${url.pathname}${url.search}${url.hash}`; } catch { /* Validation below supplies the error. */ }
  return trimmed;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && /^custom:[A-Za-z0-9_-]{1,73}$/.test(value);
const validLabel = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_NAVIGATION_LABEL_LENGTH;
export function customNavigationCount(items: readonly CustomNavItem[]): number {
  return items.reduce((count, item) => count + 1 + (item.kind === "section" ? item.links.length : 0), 0);
}
export function parseCustomNavigation(value: unknown): CustomNavItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_NAVIGATION_ITEMS) return null;
  const ids = new Set<string>();
  function link(entry: unknown): entry is CustomNavLink {
    if (!identity(entry) || entry.kind !== "link" || !record(entry.destination)) return false;
    const target = entry.destination;
    if (target.kind === "url") return isSafeNavigationUrl(target.url);
    return (target.kind === "post" || target.kind === "page") && typeof target.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(target.id);
  }
  function identity(entry: unknown): entry is Record<string, unknown> {
    if (!record(entry) || !validId(entry.id) || ids.has(entry.id) || !validLabel(entry.label)) return false;
    if (entry.icon !== undefined && (typeof entry.icon !== "string" || !ICON_NAMES.includes(entry.icon as IconName))) return false;
    ids.add(entry.id); return true;
  }
  for (const item of value) {
    if (record(item) && item.kind === "section") {
      if (!identity(item) || !Array.isArray(item.links) || !item.links.every(link)) return null;
    } else if (!link(item)) return null;
  }
  const items = value as CustomNavItem[];
  return customNavigationCount(items) <= MAX_CUSTOM_NAVIGATION_ITEMS ? items : null;
}
