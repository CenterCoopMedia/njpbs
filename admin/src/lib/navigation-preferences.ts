import { parseCustomNavigation, type CustomNavItem } from "./custom-navigation";
import { parseSharedNavigationIds } from "./navigation-shares";
// Per-account arrangement of the primary navigation rail: which destinations an editor sees and
// in what order (#1045). Pure data logic with no React and no storage, so the load-bearing rules —
// what a stale record does, what a role change does, what may never be hidden — are proven in unit
// tests rather than asserted in the shell.
//
// Two invariants hold everywhere in this module:
//
//   1. Hiding is presentation only. The rail decides what it *offers*; it never decides what an
//      account may open. Routes stay mounted and every capability check stays exactly where it is,
//      so a hidden destination remains reachable by address, by search, and by any link to it.
//   2. Authorization wins over preference. The eligible set handed in is already the set this
//      role may see; a stored id outside it is dropped silently rather than resurrected.

export const NAVIGATION_PREFERENCES_VERSION = 4;

// The stored record. `order` is the account's arrangement by destination id; `hidden` is the set
// it has taken out of its own rail. Both are stored as plain id lists so the catalog can change
// shape — a new destination, a retired one, a renamed label — without a migration.
export interface NavigationPreferences {
  version: number;
  order: string[];
  hidden: string[];
  custom?: CustomNavItem[];
  // Entry ids of shared items this account turned on. Absent on records saved before sharing.
  shared?: string[];
}

// All this module needs to know about a destination. The rail's catalog carries labels, icons and
// capability checks; those never reach the arrangement rules.
export interface OrganizableDestination {
  id: string;
  // A destination an account may reorder but never hide. Required entries stay in the rail
  // whatever the record says.
  required?: boolean;
}

export interface ResolvedNavDestination<
  T extends OrganizableDestination = OrganizableDestination,
> {
  destination: T;
  hidden: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || result.includes(entry)) continue;
    result.push(entry);
  }
  return result;
}

// Broadcast schedule left the Content group for Workflow. Version 2's default catalog, and
// insertAtDefaultPosition for a missing schedule against that catalog, placed it immediately
// after Home — or first when Home was not stored. Exact custom intent cannot be inferred from a
// saved id list, so only those two default-derived slots migrate. Any other saved index,
// including a later Content-group position, is treated as an explicit customization and kept.
function isDefaultDerivedSchedulePlacement(order: readonly string[]): boolean {
  const scheduleIndex = order.indexOf("schedule");
  if (scheduleIndex < 0) return false;
  const homeIndex = order.indexOf("home");
  if (homeIndex < 0) return scheduleIndex === 0;
  return scheduleIndex === homeIndex + 1;
}

function repositionScheduleWithWorkflow(order: string[]): string[] {
  if (!isDefaultDerivedSchedulePlacement(order)) return order;
  const next = order.filter((id) => id !== "schedule");
  const workflowIndex = Math.max(
    next.indexOf("editorial-queue"),
    next.indexOf("activity"),
  );
  // Editorial queue and Activity are permission-gated. With neither saved, keep the original
  // schedule position rather than appending below Administration.
  if (workflowIndex < 0) return order;
  next.splice(workflowIndex + 1, 0, "schedule");
  return next;
}

/**
 * Read a stored record leniently, but fail whole rather than in part. A missing record, a
 * malformed one, and one written by an unsupported schema version all resolve to `null`, which every
 * caller treats as "use the approved default". A record of the right shape keeps only its string
 * entries, de-duplicated; reconciliation against the live catalog happens later, in
 * `resolveNavigation`. Version 1 arrangements migrate the retired Voiceover destination into Media.
 * Version 2 arrangements move Broadcast schedule after Editorial queue and Activity only when the
 * saved order still has the old default-derived slot (immediately after Home, or first when Home is
 * absent) and either Workflow anchor is present. An explicit custom schedule position, hidden ids,
 * unrelated relative order, and current-schema records stay as stored.
 */
export function parseNavigationPreferences(
  value: unknown,
): NavigationPreferences | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== 1 &&
    value.version !== 2 &&
    value.version !== 3 &&
    value.version !== NAVIGATION_PREFERENCES_VERSION
  ) {
    return null;
  }
  const order = idList(value.order);
  const hidden = idList(value.hidden);
  if (!order || !hidden) return null;
  const custom = value.version === 4 ? parseCustomNavigation(value.custom ?? []) : [];
  const shared = value.version === NAVIGATION_PREFERENCES_VERSION ? parseSharedNavigationIds(value.shared) : [];
  if (!custom || !shared) return null;
  let nextOrder = order;
  let nextHidden = hidden;
  if (value.version === 1) {
    // Keep the combined library visible when either former destination was visible.
    const hideMedia = hidden.includes("media") && hidden.includes("voiceovers");
    nextOrder = order.filter((id) => id !== "voiceovers");
    nextHidden = hidden.filter((id) => id !== "voiceovers" && (id !== "media" || hideMedia));
  }
  if (value.version === 1 || value.version === 2) {
    nextOrder = repositionScheduleWithWorkflow(nextOrder);
  }
  const parsed = { version: NAVIGATION_PREFERENCES_VERSION, order: nextOrder, hidden: nextHidden, custom };
  if (value.version === NAVIGATION_PREFERENCES_VERSION && value.shared !== undefined) return { ...parsed, shared };
  return parsed;
}

/**
 * The same read, starting from the signed-in staff profile document the shell already holds. The
 * shell reads its arrangement from the live profile listener rather than fetching, so a save in
 * one tab reaches the rail in every tab of that account.
 */
export function readNavigationPreferences(
  profile: unknown,
): NavigationPreferences | null {
  if (!isRecord(profile)) return null;
  const preferences = profile.preferences;
  if (!isRecord(preferences)) return null;
  return parseNavigationPreferences(preferences.navigation);
}

// Insert `id` into `result` directly after the nearest destination that precedes it in the
// approved default order and is already placed. With no such destination it goes to the front.
// This is what "append a new destination at its default position" means: an editor who arranged
// the rail before a destination existed finds it where the default would have put it, not dumped
// at the bottom.
function insertAtDefaultPosition(
  result: string[],
  id: string,
  defaultOrder: readonly string[],
): void {
  const defaultIndex = defaultOrder.indexOf(id);
  for (let index = defaultIndex - 1; index >= 0; index -= 1) {
    const anchor = defaultOrder[index];
    const position = result.indexOf(anchor);
    if (position >= 0) {
      result.splice(position + 1, 0, id);
      return;
    }
  }
  result.unshift(id);
}

/**
 * The rail this account should see: the stored arrangement intersected with the destinations the
 * current role allows, with anything new placed at its default position and anything unknown or
 * ineligible dropped without comment. Required destinations are never returned hidden.
 *
 * `eligible` is the catalog already filtered by capability, in approved default order.
 */
export function resolveNavigation<T extends OrganizableDestination>(
  stored: NavigationPreferences | null,
  eligible: readonly T[],
): Array<ResolvedNavDestination<T>> {
  const byId = new Map(eligible.map((destination) => [destination.id, destination]));
  const defaultOrder = eligible.map((destination) => destination.id);

  const order: string[] = [];
  for (const id of stored?.order ?? []) {
    if (!byId.has(id) || order.includes(id)) continue;
    order.push(id);
  }
  for (const id of defaultOrder) {
    if (order.includes(id)) continue;
    insertAtDefaultPosition(order, id, defaultOrder);
  }

  const hidden = new Set(stored?.hidden ?? []);
  return order.map((id) => {
    const destination = byId.get(id) as T;
    return {
      destination,
      hidden: destination.required !== true && hidden.has(id),
    };
  });
}

/** The rows the rail actually renders. */
export function visibleNavigation<T extends OrganizableDestination>(
  rows: ReadonlyArray<ResolvedNavDestination<T>>,
): Array<ResolvedNavDestination<T>> {
  return rows.filter((row) => !row.hidden);
}

/** Move one destination a single step up (-1) or down (1). Past either end is a no-op. */
export function moveDestination<T extends OrganizableDestination>(
  rows: ReadonlyArray<ResolvedNavDestination<T>>,
  id: string,
  direction: -1 | 1,
): Array<ResolvedNavDestination<T>> {
  const current = rows.findIndex((row) => row.destination.id === id);
  const target = current + direction;
  if (current < 0 || target < 0 || target >= rows.length) {
    return rows.map((row) => ({ ...row }));
  }
  const next = rows.map((row) => ({ ...row }));
  const [moved] = next.splice(current, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Hide or show one destination. A required destination refuses to be hidden. */
export function setDestinationHidden<T extends OrganizableDestination>(
  rows: ReadonlyArray<ResolvedNavDestination<T>>,
  id: string,
  hidden: boolean,
): Array<ResolvedNavDestination<T>> {
  return rows.map((row) =>
    row.destination.id === id
      ? { ...row, hidden: hidden && row.destination.required !== true }
      : { ...row },
  );
}

/** Whether these rows are exactly the approved default: default order, nothing hidden. */
export function isDefaultArrangement<T extends OrganizableDestination>(
  rows: ReadonlyArray<ResolvedNavDestination<T>>,
  eligible: readonly T[],
): boolean {
  if (rows.some((row) => row.hidden)) return false;
  const defaultOrder = eligible.map((destination) => destination.id);
  const current = rows.map((row) => row.destination.id);
  return (
    current.length === defaultOrder.length &&
    current.every((id, index) => id === defaultOrder[index])
  );
}

/**
 * The record to store for these rows. The arrangement an account can see is authoritative for the
 * destinations it can see; a destination that is still in the catalog but outside this session's
 * eligible set (a grant this account does not hold right now) keeps its stored place and hidden
 * state, so a temporary role change does not quietly erase an arrangement. An id that has left the
 * catalog entirely is forgotten.
 */
export function storedFromResolved<T extends OrganizableDestination>(
  rows: ReadonlyArray<ResolvedNavDestination<T>>,
  stored: NavigationPreferences | null,
  catalog: readonly OrganizableDestination[],
): NavigationPreferences {
  const known = new Set(catalog.map((destination) => destination.id));
  const eligible = new Set(rows.map((row) => row.destination.id));
  const order = rows.map((row) => row.destination.id);

  const storedOrder = stored?.order ?? [];
  for (const id of storedOrder) {
    if (!known.has(id) || eligible.has(id) || order.includes(id)) continue;
    // Re-place it relative to the stored arrangement it came from, not the live default.
    insertAtDefaultPosition(order, id, storedOrder);
  }

  const hidden = order.filter((id) =>
    eligible.has(id)
      ? rows.some((row) => row.destination.id === id && row.hidden)
      : (stored?.hidden ?? []).includes(id),
  );

  return { version: NAVIGATION_PREFERENCES_VERSION, order, hidden, custom: stored?.custom ?? [] };
}
