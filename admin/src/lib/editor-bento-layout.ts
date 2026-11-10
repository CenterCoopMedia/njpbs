// The arrangement model for the editor's bento layout: a set of named panels distributed across
// two zones (a wide main column and a narrow side column), each panel ordered within its zone and
// independently collapsible. Pure data logic with no React or storage, so the rules — what a move
// does to the other zone, how a saved layout reconciles against the current panel set — are proven
// in unit tests rather than asserted in the UI. The component and the persistence store are thin
// shells over this module.

export type BentoZone = "main" | "side";

// One panel's placement. `zone` is which column it sits in; `collapsed` hides its body down to just
// the header so an editor keeps the section reachable without it filling the column.
export interface BentoPanelState {
  id: string;
  zone: BentoZone;
  collapsed: boolean;
}

// The whole arrangement as a flat, ordered list. A panel's order *within* its zone is its relative
// order among that zone's entries; the two zones' entries may interleave in the array, but only
// same-zone relative order carries meaning. One flat list (rather than a map of two arrays) keeps a
// move a single splice and makes serialize/parse trivial.
export type BentoLayout = readonly BentoPanelState[];

// What panels exist and where they sit before an editor has rearranged anything.
export interface BentoPanelDef {
  id: string;
  defaultZone: BentoZone;
  // Omit this to permit both zones. A restricted panel can still reorder within an allowed zone.
  allowedZones?: readonly [BentoZone, ...BentoZone[]];
  defaultCollapsed?: boolean;
}

// A parsed persisted entry. Only `id` is guaranteed; a missing or malformed zone/collapsed is left
// absent so reconciliation restores that field to the panel's declared default rather than a
// hardcoded value. `BentoPanelState` (which fills both) is assignable to this, so a live layout can
// be reconciled too.
export interface SavedBentoEntry {
  id: string;
  zone?: BentoZone;
  collapsed?: boolean;
}

export const BENTO_ZONES: readonly BentoZone[] = ["main", "side"];

function isZone(value: unknown): value is BentoZone {
  return value === "main" || value === "side";
}

export function isPanelAllowedInZone(
  def: BentoPanelDef,
  zone: BentoZone,
): boolean {
  return def.allowedZones === undefined || def.allowedZones.includes(zone);
}

function defaultZoneForPanel(def: BentoPanelDef): BentoZone {
  if (isPanelAllowedInZone(def, def.defaultZone)) return def.defaultZone;
  return def.allowedZones?.[0] ?? def.defaultZone;
}

export function defaultBentoLayout(defs: readonly BentoPanelDef[]): BentoPanelState[] {
  return defs.map((def) => ({
    id: def.id,
    zone: defaultZoneForPanel(def),
    collapsed: def.defaultCollapsed ?? false,
  }));
}

// The panels in one zone, in their display order.
export function panelsInZone(layout: BentoLayout, zone: BentoZone): BentoPanelState[] {
  return layout.filter((panel) => panel.zone === zone);
}

// Move a panel into `zone` at `indexInZone` — the position among that zone's panels *after the
// panel is removed*, so the caller reasons about the destination list it can see. Omitting the
// index appends to the end of the target zone. The other zone's ordering is never disturbed. The
// input is never mutated.
export function movePanel(
  layout: BentoLayout,
  defs: readonly BentoPanelDef[],
  id: string,
  zone: BentoZone,
  indexInZone?: number,
): BentoPanelState[] {
  const existing = layout.find((panel) => panel.id === id);
  const def = defs.find((panel) => panel.id === id);
  if (!existing || !def || !isPanelAllowedInZone(def, zone)) {
    return layout.slice();
  }
  const without = layout.filter((panel) => panel.id !== id);
  const moved: BentoPanelState = { ...existing, zone };

  // Array positions of the target zone's panels, in order, within `without`.
  const zonePositions: number[] = [];
  without.forEach((panel, position) => {
    if (panel.zone === zone) zonePositions.push(position);
  });

  const clamped =
    indexInZone === undefined
      ? zonePositions.length
      : Math.max(0, Math.min(indexInZone, zonePositions.length));

  let insertAt: number;
  if (clamped >= zonePositions.length) {
    // After the last same-zone panel, or — if the zone is empty — at the very end of the list.
    insertAt =
      zonePositions.length === 0 ? without.length : zonePositions[zonePositions.length - 1] + 1;
  } else {
    insertAt = zonePositions[clamped];
  }

  const result = without.slice();
  result.splice(insertAt, 0, moved);
  return result;
}

// Nudge a panel one step up (-1) or down (+1) within its own zone. Past either end is a no-op.
export function reorderPanel(
  layout: BentoLayout,
  defs: readonly BentoPanelDef[],
  id: string,
  direction: -1 | 1,
): BentoPanelState[] {
  const entry = layout.find((panel) => panel.id === id);
  if (!entry) return layout.slice();
  const zonePanels = panelsInZone(layout, entry.zone);
  const current = zonePanels.findIndex((panel) => panel.id === id);
  const target = current + direction;
  if (target < 0 || target >= zonePanels.length) return layout.slice();
  return movePanel(layout, defs, id, entry.zone, target);
}

export function setPanelCollapsed(
  layout: BentoLayout,
  id: string,
  collapsed: boolean,
): BentoPanelState[] {
  return layout.map((panel) => (panel.id === id ? { ...panel, collapsed } : { ...panel }));
}

// Bring a saved layout back into agreement with the current panel set: keep known ids in their
// saved order and placement, drop ids that no longer exist, and append any panel the save never
// mentioned at its declared default. This is what lets the panel catalog change (a section added or
// retired) without stranding a persisted layout or losing an editor's arrangement of the rest.
export function reconcileBentoLayout(
  saved: readonly SavedBentoEntry[],
  defs: readonly BentoPanelDef[],
): BentoPanelState[] {
  const byId = new Map(defs.map((def) => [def.id, def]));
  const seen = new Set<string>();
  const result: BentoPanelState[] = [];

  for (const entry of saved) {
    const def = byId.get(entry.id);
    if (!def || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push({
      id: entry.id,
      zone:
        isZone(entry.zone) && isPanelAllowedInZone(def, entry.zone)
          ? entry.zone
          : defaultZoneForPanel(def),
      collapsed:
        typeof entry.collapsed === "boolean" ? entry.collapsed : def.defaultCollapsed ?? false,
    });
  }

  for (const def of defs) {
    if (seen.has(def.id)) continue;
    const zone = defaultZoneForPanel(def);
    const panel: BentoPanelState = {
      id: def.id,
      zone,
      collapsed: def.defaultCollapsed ?? false,
    };
    const defIndex = defs.findIndex((candidate) => candidate.id === def.id);
    let insertAt = result.length;
    for (let index = 0; index < result.length; index += 1) {
      if (result[index].zone !== zone) continue;
      const otherIndex = defs.findIndex((candidate) => candidate.id === result[index].id);
      if (otherIndex > defIndex) {
        insertAt = index;
        break;
      }
    }
    result.splice(insertAt, 0, panel);
  }

  return result;
}

export function serializeBentoLayout(layout: BentoLayout): string {
  return JSON.stringify(
    layout.map((panel) => ({ id: panel.id, zone: panel.zone, collapsed: panel.collapsed })),
  );
}

// Read a persisted layout back leniently: a JSON string or an already-parsed value is accepted, and
// entries without a string id are skipped. A malformed zone or collapsed flag is left *absent* on
// the entry rather than coerced, so `reconcileBentoLayout` restores that one field to the panel's
// declared default instead of a hardcoded value — a partially-corrupt entry fails safe per field
// rather than silently jumping zones or expanding a default-collapsed panel. Reconciliation still
// has the final say about which ids survive, so parsing errs toward keeping data. Returns null only
// when the top level is not an array (or not parseable JSON), which the store treats as "no saved
// layout".
export function parseBentoLayout(raw: unknown): SavedBentoEntry[] | null {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(data)) return null;

  const result: SavedBentoEntry[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== "string") continue;
    const entry: SavedBentoEntry = { id: candidate.id };
    if (isZone(candidate.zone)) entry.zone = candidate.zone;
    if (typeof candidate.collapsed === "boolean") entry.collapsed = candidate.collapsed;
    result.push(entry);
  }
  return result;
}
