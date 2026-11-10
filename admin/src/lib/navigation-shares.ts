import { parseCustomNavigation, type CustomNavItem } from "./custom-navigation";
import type { NavigationPreferences } from "./navigation-preferences";

// Adopted shares have their own ten-entry budget. They do not spend the personal
// custom cap: the owner already stores the item there, and a recipient should be
// able to keep personal links while turning a share on.
export const MAX_SHARED_NAVIGATION_ENTRIES = 10;
export const SHARED_ITEM_UNSHARED = "The owner stopped sharing this plank.";
export const SHARED_ITEM_DELETED = "The owner deleted this plank.";

const SHARE_ID = /^custom:[A-Za-z0-9_-]{1,73}$/;

export type ShareRemovalReason = "unshared" | "deleted" | "owner_removed";

export interface NavigationShare {
  id: string;
  ownerUid: string;
  ownerName: string;
  status: "active" | "removed";
  removedReason?: ShareRemovalReason;
  item: CustomNavItem;
}

export interface SharedNavigationRow {
  id: string;
  label: string;
  ownerName: string;
  ownerUid: string;
  enabled: boolean;
  owned: boolean;
  reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function shareEntryIds(item: CustomNavItem): string[] {
  return item.kind === "link" ? [item.id] : [item.id, ...item.links.map((link) => link.id)];
}

export function sharedItemReason(reason: ShareRemovalReason, kind: CustomNavItem["kind"] = "link"): string {
  if (reason === "owner_removed") return "The owner no longer has staff access.";
  if (kind === "section") {
    return reason === "unshared"
      ? "The owner stopped sharing this span."
      : "The owner deleted this span.";
  }
  return reason === "unshared" ? SHARED_ITEM_UNSHARED : SHARED_ITEM_DELETED;
}

export function parseSharedNavigationIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SHARED_NAVIGATION_ENTRIES) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !SHARE_ID.test(entry) || ids.includes(entry)) return null;
    ids.push(entry);
  }
  return ids;
}

export interface SharedCapOmission {
  id: string;
  label: string;
  omittedChildren: number;
}

const NO_OWN_IDS: ReadonlySet<string> = new Set();

function countsTowardSharedCap(share: NavigationShare, viewerUid: string, ownIds: ReadonlySet<string>): boolean {
  return share.status === "active" && share.ownerUid !== viewerUid && !ownIds.has(share.item.id);
}

/** Entry ids on active shares this viewer turned on. The viewer's own shares and custom items do not count. Removed children are absent, so they do not count. */
export function countedSharedEntries(
  shares: readonly NavigationShare[],
  enabled: readonly string[],
  viewerUid = "",
  ownIds: ReadonlySet<string> = NO_OWN_IDS,
): string[] {
  const ids: string[] = [];
  for (const share of shares) {
    if (!countsTowardSharedCap(share, viewerUid, ownIds)) continue;
    const entries = shareEntryIds(share.item);
    if (!entries.some((id) => enabled.includes(id))) continue;
    for (const id of entries) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function sharedEntriesFit(
  current: readonly string[],
  item: CustomNavItem,
  shares?: readonly NavigationShare[],
  viewerUid = "",
  ownIds: ReadonlySet<string> = NO_OWN_IDS,
): boolean {
  const base = shares ? countedSharedEntries(shares, current, viewerUid, ownIds) : current;
  const next = new Set(base);
  for (const id of shareEntryIds(item)) next.add(id);
  return next.size <= MAX_SHARED_NAVIGATION_ENTRIES;
}

/**
 * Keep adopted shares inside the ten-entry cap. A span stays on when it fits, and only the
 * leading child planks that still fit are returned. Removed children are not in the body.
 */
export function capAdoptedShares(
  shares: readonly NavigationShare[],
  preferences: NavigationPreferences | null,
  viewerUid: string,
): { items: CustomNavItem[]; omissions: SharedCapOmission[] } {
  const enabled = preferences?.shared ?? [];
  const ownIds = new Set((preferences?.custom ?? []).map((item) => item.id));
  const ranked = shares
    .filter((share) => countsTowardSharedCap(share, viewerUid, ownIds))
    .map((share) => {
      const positions = shareEntryIds(share.item).map((id) => enabled.indexOf(id)).filter((index) => index >= 0);
      return { share, at: positions.length ? Math.min(...positions) : -1 };
    })
    .filter((entry) => entry.at >= 0)
    .sort((left, right) => left.at - right.at || left.share.id.localeCompare(right.share.id));
  let used = 0;
  const items: CustomNavItem[] = [];
  const omissions: SharedCapOmission[] = [];
  for (const { share } of ranked) {
    const item = share.item;
    if (item.kind === "link") {
      if (used + 1 > MAX_SHARED_NAVIGATION_ENTRIES) {
        omissions.push({ id: item.id, label: item.label, omittedChildren: 0 });
        continue;
      }
      used += 1;
      items.push(item);
      continue;
    }
    if (used + 1 > MAX_SHARED_NAVIGATION_ENTRIES) {
      omissions.push({ id: item.id, label: item.label, omittedChildren: item.links.length });
      continue;
    }
    const room = MAX_SHARED_NAVIGATION_ENTRIES - used - 1;
    const links = item.links.slice(0, room);
    used += 1 + links.length;
    if (links.length < item.links.length) {
      omissions.push({ id: item.id, label: item.label, omittedChildren: item.links.length - links.length });
    }
    items.push(links.length === item.links.length ? item : { ...item, links });
  }
  return { items, omissions };
}

export function sharedCapMessage(omission: SharedCapOmission, onRail: boolean): string {
  if (!onRail) return `${omission.label} does not fit in the 10 shared planks and spans on your rail.`;
  const noun = omission.omittedChildren === 1 ? "1 extra plank stays" : `${omission.omittedChildren} extra planks stay`;
  return `${omission.label} is over the 10 shared planks and spans on your rail. ${noun} off your rail.`;
}

function canonicalItem(item: CustomNavItem): unknown {
  const base = { id: item.id, kind: item.kind, label: item.label, icon: item.icon ?? null };
  if (item.kind === "link") return { ...base, destination: item.destination };
  return { ...base, links: item.links.map((link) => canonicalItem(link)) };
}

export function sameCustomItem(left: CustomNavItem, right: CustomNavItem): boolean {
  return JSON.stringify(canonicalItem(left)) === JSON.stringify(canonicalItem(right));
}

/** Drop a malformed share. One bad document must not blank the list. */
export function parseNavigationShare(id: string, value: unknown): NavigationShare | null {
  if (!isRecord(value) || !SHARE_ID.test(id)) return null;
  const keys = Object.keys(value);
  const allowed = ["ownerUid", "ownerName", "status", "item", "updatedAt", "removedReason"];
  if (keys.some((key) => !allowed.includes(key))) return null;
  if (typeof value.ownerUid !== "string" || !value.ownerUid || value.ownerUid.includes("/")) return null;
  if (typeof value.ownerName !== "string" || !value.ownerName.trim() || value.ownerName.length > 100) return null;
  if (value.status !== "active" && value.status !== "removed") return null;
  if (value.status === "active" && value.removedReason !== undefined) return null;
  const removedReason = value.removedReason === "unshared" || value.removedReason === "deleted" || value.removedReason === "owner_removed"
    ? value.removedReason : undefined;
  if (value.status === "removed" && !removedReason) return null;
  const items = parseCustomNavigation([value.item]);
  if (!items || items[0].id !== id) return null;
  return {
    id,
    ownerUid: value.ownerUid,
    ownerName: value.ownerName,
    status: value.status,
    ...(removedReason ? { removedReason } : {}),
    item: items[0],
  };
}

/** Active shares this viewer turned on, excluding items already on the viewer's own rail. Bodies that exceed the cap are trimmed. */
export function adoptedCustomItems(
  shares: readonly NavigationShare[],
  preferences: NavigationPreferences | null,
  viewerUid: string,
): CustomNavItem[] {
  return capAdoptedShares(shares, preferences, viewerUid).items;
}

export function sharedNavigationRows(
  shares: readonly NavigationShare[],
  preferences: NavigationPreferences | null,
  viewerUid: string,
): SharedNavigationRow[] {
  const enabled = new Set(preferences?.shared ?? []);
  const rows: SharedNavigationRow[] = [];
  for (const share of shares) {
    const turnedOn = shareEntryIds(share.item).some((id) => enabled.has(id));
    if (share.status === "removed" && !turnedOn) continue;
    rows.push({
      id: share.item.id,
      label: share.item.label,
      ownerName: share.ownerName,
      ownerUid: share.ownerUid,
      enabled: share.status === "active" && enabled.has(share.item.id),
      owned: share.ownerUid === viewerUid,
      reason: share.status === "removed" && share.removedReason ? sharedItemReason(share.removedReason, share.item.kind) : null,
    });
  }
  return rows;
}

