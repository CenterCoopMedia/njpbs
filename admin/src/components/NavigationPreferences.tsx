import { CustomNavigationEditor, type SearchNavigationContent } from "./CustomNavigationEditor";
import { customSettingsDestinations } from "../lib/custom-nav-destinations";
import { customNavigationCount, MAX_CUSTOM_NAVIGATION_ITEMS, type CustomNavItem } from "../lib/custom-navigation";
import {
  adoptedCustomItems,
  capAdoptedShares,
  MAX_SHARED_NAVIGATION_ENTRIES,
  sameCustomItem,
  sharedCapMessage,
  sharedEntriesFit,
  sharedNavigationRows,
  shareEntryIds,
  type NavigationShare,
} from "../lib/navigation-shares";
import { Button } from "./ui/Primitives";
import { ReorderHandle } from "./ReorderHandle";
import { Menu } from "./ui/Menu";
import { useReorder } from "../hooks/useReorder";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActionControl } from "./ui/ActionControl";
import { Icon } from "./ui/Icon";
import { AsyncActionButton, InlineMessage, Panel } from "./ui/Primitives";
import { NAV_DESTINATIONS, type NavDestinationDef } from "../lib/nav-destinations";
import {
  isDefaultArrangement,
  moveDestination,
  resolveNavigation,
  setDestinationHidden,
  storedFromResolved,
  type NavigationPreferences as StoredNavigationPreferences,
  type ResolvedNavDestination,
} from "../lib/navigation-preferences";
import { useSuccessNotice } from "./ui/SuccessNoticeRegion";

type Row = ResolvedNavDestination<NavDestinationDef>;

function signature(rows: readonly Row[]): string {
  return rows
    .map((row) => `${row.destination.id}:${row.hidden ? "hidden" : "shown"}:${JSON.stringify(row.destination.customItem ?? null)}`)
    .join("|");
}

function arrangementKey(rows: readonly Row[], hiddenChildren: readonly string[], shareIds: readonly string[]): string {
  return `${signature(rows)}|${JSON.stringify(hiddenChildren)}|${JSON.stringify(shareIds)}`;
}

function ownChildHidden(stored: StoredNavigationPreferences | null): string[] {
  return stored?.hidden.filter((id) => (stored.custom ?? []).some((item) => item.kind === "section" && item.links.some((link) => link.id === id))) ?? [];
}

function shareSnapshotKey(shares: readonly NavigationShare[]): string {
  return shares.map((share) => `${share.id}:${share.status}:${share.removedReason ?? ""}:${JSON.stringify(share.item)}`).join("|");
}

function profileKeyFor(stored: StoredNavigationPreferences | null, eligible: readonly NavDestinationDef[]): string {
  const rows = resolveNavigation(stored, [...eligible, ...customSettingsDestinations(stored?.custom ?? [])]);
  return arrangementKey(rows, ownChildHidden(stored), stored?.shared ?? []);
}

function placeSharedRow(rows: readonly Row[], row: Row, storedOrder: readonly string[]): Row[] {
  const at = storedOrder.indexOf(row.destination.id);
  if (at >= 0) {
    for (let index = at - 1; index >= 0; index -= 1) {
      const position = rows.findIndex((entry) => entry.destination.id === storedOrder[index]);
      if (position >= 0) return [...rows.slice(0, position + 1), row, ...rows.slice(position + 1)];
    }
    return [row, ...rows];
  }
  return [...rows, row];
}

/** Put unresolved shared ids back where the stored order kept them. */
function restoreUnresolvedShared(
  next: StoredNavigationPreferences,
  stored: StoredNavigationPreferences | null,
): void {
  const storedOrder = stored?.order ?? [];
  const unresolved = (stored?.shared ?? []).filter((id) => !next.order.includes(id));
  for (const id of storedOrder) {
    if (!unresolved.includes(id) || next.order.includes(id)) continue;
    const at = storedOrder.indexOf(id);
    let anchor = -1;
    for (let index = at - 1; index >= 0; index -= 1) {
      const position = next.order.indexOf(storedOrder[index]);
      if (position >= 0) {
        anchor = position;
        break;
      }
    }
    if (anchor < 0) next.order.unshift(id);
    else next.order.splice(anchor + 1, 0, id);
  }
  for (const id of storedOrder) {
    if (!unresolved.includes(id) || !(stored?.hidden ?? []).includes(id) || next.hidden.includes(id)) continue;
    next.hidden.push(id);
  }
}

/** Refresh shared row data without replacing the local draft. */
function patchSharedRows(
  rows: readonly Row[],
  custom: readonly CustomNavItem[],
  adoptedItems: readonly CustomNavItem[],
  eligibleIds: ReadonlySet<string>,
  storedOrder: readonly string[],
  storedHidden: readonly string[],
): Row[] {
  const destinations = new Map(customSettingsDestinations(adoptedItems).map((destination) => [destination.id, destination]));
  const ownIds = new Set(custom.map((item) => item.id));
  let next = rows.flatMap((row) => {
    const updated = destinations.get(row.destination.id);
    if (updated) return [{ ...row, destination: updated }];
    if (ownIds.has(row.destination.id) || eligibleIds.has(row.destination.id)) return [row];
    if (row.destination.id.startsWith("custom:")) return [];
    return [row];
  });
  for (const item of adoptedItems) {
    if (next.some((row) => row.destination.id === item.id)) continue;
    const destination = destinations.get(item.id);
    if (!destination) continue;
    next = placeSharedRow(next, {
      destination,
      hidden: storedHidden.includes(item.id),
    }, storedOrder);
  }
  return next;
}

// Reset clears the viewer's own planks and spans. A staged delete leaves the screen before save,
// and a staged rename replaces the stored label. Screen order comes first. Stored items that left
// the screen follow, in stored order. The same id keeps the staged label and links. An adopted
// shared plank is turned off, not deleted, so it stays off this list.
function resetRemovalItems(
  rows: readonly Row[],
  persisted: readonly CustomNavItem[] | undefined,
  own: readonly CustomNavItem[],
): CustomNavItem[] {
  const ownIds = new Set<string>();
  for (const item of own) ownIds.add(item.id);
  for (const item of persisted ?? []) ownIds.add(item.id);
  const staged = rows.flatMap((row) => {
    const item = row.destination.customItem;
    return item && ownIds.has(item.id) ? [item] : [];
  });
  const seen = new Set(staged.map((item) => item.id));
  const removed: CustomNavItem[] = [];
  for (const item of persisted ?? []) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    removed.push(item);
  }
  return [...staged, ...removed];
}

// The list names every own plank and span reset removes, including a span's hidden planks.
// A span name sits above its plank labels. An empty span has no nested list.
function resetRemovalList(items: readonly CustomNavItem[]) {
  if (items.length === 0) return null;
  return (
    <ul className="nav-reset-items" aria-label="Planks and spans this reset removes">
      {items.map((item) => (
        <li key={item.id}>
          {item.label}
          {item.kind === "section" && item.links.length > 0 ? (
            <ul>
              {item.links.map((link) => (
                <li key={link.id}>{link.label}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

type SaveStatus = "idle" | "saved" | "error";

/**
 * The organize surface for the navigation rail (#1045): reorder the destinations this account can
 * see, take the ones it rarely opens out of its own rail, and put everything back.
 *
 * Two things are deliberately true here. Hiding is presentation only — the copy says so, and the
 * routes stay authorized and addressable — and required destinations simply have no hide
 * control rather than a disabled one nobody can explain. Every control is an ActionControl, so an
 * account reading text labels and an account reading icons get the same accessible action names.
 *
 * The component owns no persistence. It takes the stored record, hands back the next one, and lets
 * the route decide where that goes, which is what lets the design gallery render it for real.
 */
export function NavigationPreferences({
  eligible,
  onReset,
  onSave,
  stored,
  searchContent,
  shares = [],
  viewerUid = "",
  sharesReady = true,
  onShare,
}: {
  eligible: readonly NavDestinationDef[];
  onReset: () => Promise<void> | void;
  onSave: (preferences: StoredNavigationPreferences) => Promise<void> | void;
  stored: StoredNavigationPreferences | null;
  searchContent?: SearchNavigationContent;
  shares?: readonly NavigationShare[];
  viewerUid?: string;
  sharesReady?: boolean;
  onShare?: (item: CustomNavItem, shared: boolean) => Promise<void> | void;
}) {
  const successNotice = useSuccessNotice();
  const adopted = useMemo(
    () => adoptedCustomItems(shares, stored, viewerUid),
    [shares, stored, viewerUid],
  );
  const upstream = useMemo(
    () => resolveNavigation(stored, [...eligible, ...customSettingsDestinations([...(stored?.custom ?? []), ...adopted])]),
    [stored, eligible, adopted],
  );
  const [rows, setRows] = useState<Row[]>(upstream);
  const [custom, setCustom] = useState<CustomNavItem[]>(stored?.custom ?? []);
  const [childHidden, setChildHidden] = useState<string[]>(ownChildHidden(stored));
  const [enabledIds, setEnabledIds] = useState<string[]>(stored?.shared ?? []);
  const [sharing, setSharing] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomNavItem | "new" | null>(null);
  const editorOpener = useRef<HTMLElement | null>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && editing === null) editorOpener.current?.focus();
    wasEditing.current = editing !== null;
  }, [editing]);
  function beginEditing(item: CustomNavItem | "new"): void {
    editorOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditing(item);
  }
  const [confirmReset, setConfirmReset] = useState(false);
  const addControl = useRef<HTMLButtonElement>(null);
  const resetOpener = useRef<HTMLElement | null>(null);
  const resetCancel = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const [resetFocusRequested, setResetFocusRequested] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  useEffect(() => {
    if (busy) return;
    if (resetFocusRequested) {
      addControl.current?.focus();
      setResetFocusRequested(false);
    } else if (confirmReset && !wasConfirming.current) {
      resetCancel.current?.focus();
      resetCancel.current?.scrollIntoView?.({ block: "nearest" });
    } else if (!confirmReset && wasConfirming.current) {
      if (resetOpener.current?.isConnected && !resetOpener.current.matches(":disabled")) resetOpener.current.focus();
      else addControl.current?.focus();
    }
    wasConfirming.current = confirmReset;
  }, [confirmReset, busy, resetFocusRequested]);
  /*
    Two refs, because "what the stored record says" and "what counts as saved" are different
    questions once a write is in flight.

    `profileRef` is the last stored profile this component saw, without share bodies. The effect
    replaces the draft only when that profile changes, so an unrelated profile refresh — a new
    document with the same arrangement — cannot wipe an edit in progress. A share snapshot is not
    a profile change: it updates shared row data and leaves the draft, order, hidden state, and
    open editor alone.

    `settledRef` is the arrangement the panel treats as persisted, which is what Save being enabled
    is asking about. A completed write sets it, and a stored profile change sets both. Keeping them
    apart is what makes the last write win: if another tab's arrangement arrives while this tab's
    save is pending, it shows (the stored record is still the truth), and then this tab's write
    completes and takes the panel back to what it just wrote, rather than stranding the competing
    arrangement on screen and calling it an unsaved edit.
  */
  const profileKey = profileKeyFor(stored, eligible);
  const shareKey = shareSnapshotKey(shares);
  const profileRef = useRef(profileKey);
  const shareRef = useRef(shareKey);
  const upstreamRef = useRef(upstream);
  upstreamRef.current = upstream;
  const draftRef = useRef({ rows, custom, enabledIds, childHidden });
  draftRef.current = { rows, custom, enabledIds, childHidden };
  const settledRef = useRef(arrangementKey(upstream, ownChildHidden(stored), stored?.shared ?? []));
  const savedDraft = useRef({ rows: upstream, custom: stored?.custom ?? [], childHidden: ownChildHidden(stored), enabledIds: stored?.shared ?? [] });

  useEffect(() => {
    const profileChanged = profileKey !== profileRef.current;
    const sharesChanged = shareKey !== shareRef.current;
    if (!profileChanged && !sharesChanged) return;
    if (profileChanged) {
      profileRef.current = profileKey;
      shareRef.current = shareKey;
      const nextCustom = stored?.custom ?? [];
      const nextChildHidden = ownChildHidden(stored);
      const nextEnabled = stored?.shared ?? [];
      const nextRows = upstreamRef.current;
      settledRef.current = arrangementKey(nextRows, nextChildHidden, nextEnabled);
      savedDraft.current = { rows: nextRows, custom: nextCustom, childHidden: nextChildHidden, enabledIds: nextEnabled };
      setRows(nextRows);
      setCustom(nextCustom);
      setChildHidden(nextChildHidden);
      setEnabledIds(nextEnabled);
      setEditing(null);
      return;
    }
    shareRef.current = shareKey;
    const draft = draftRef.current;
    const wasDirty = arrangementKey(draft.rows, draft.childHidden, draft.enabledIds) !== settledRef.current;
    const liveIds = new Set(shares.filter((share) => share.status === "active").flatMap((share) => shareEntryIds(share.item)));
    // Keep saved references until Save prunes them, so a removed share can still
    // explain why it left the rail (including while its tombstone is loading).
    const nextEnabled = draft.enabledIds.filter((id) => liveIds.has(id) || stored?.shared?.includes(id));
    const adoptedNow = adoptedCustomItems(shares, {
      version: 4,
      order: stored?.order ?? [],
      hidden: stored?.hidden ?? [],
      custom: draft.custom,
      shared: nextEnabled,
    }, viewerUid);
    const nextRows = patchSharedRows(
      draft.rows,
      draft.custom,
      adoptedNow,
      new Set(eligible.map((destination) => destination.id)),
      stored?.order ?? [],
      stored?.hidden ?? [],
    );
    setRows(nextRows);
    setEnabledIds(nextEnabled);
    if (!wasDirty) {
      settledRef.current = arrangementKey(nextRows, draft.childHidden, nextEnabled);
      savedDraft.current = { rows: nextRows, custom: draft.custom, childHidden: draft.childHidden, enabledIds: nextEnabled };
    }
  }, [eligible, profileKey, shareKey, shares, stored, viewerUid]);

  // What a completed write leaves on screen. The rows are passed in rather than read from state
  // because the write that is settling was composed from the rows of the render that started it,
  // which is not necessarily what state holds by the time it lands.
  function settle(next: Row[], hiddenChildren = childHidden, shareIds = enabledIds): void {
    settledRef.current = `${signature(next)}|${JSON.stringify(hiddenChildren)}|${JSON.stringify(shareIds)}`;
    setRows(next);
  }

  // A move relocates the pressed control, and the control that reached an end becomes disabled.
  // This names the control to focus once the new order renders, so a keyboard user is never left
  // on a disabled button or on nothing at all.
  const controlRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    controlRefs.current.get(focusRequest)?.focus();
    setFocusRequest(null);
  }, [focusRequest]);

  // Keyed rows change DOM order immediately; animate only their changed screen positions.
  const listRef = useRef<HTMLOListElement>(null);
  const movePositions = useRef(new Map<Element, number>());
  useLayoutEffect(() => {
    const previous = movePositions.current;
    movePositions.current = new Map();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const tokens = getComputedStyle(document.documentElement);
    for (const [element, top] of previous) {
      const delta = top - element.getBoundingClientRect().top;
      if (delta === 0) continue;
      element.animate?.(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        {
          duration: parseFloat(tokens.getPropertyValue("--cms-motion-normal")),
          easing: tokens.getPropertyValue("--cms-ease").trim(),
        },
      );
    }
  }, [rows]);

  const dirty = `${signature(rows)}|${JSON.stringify(childHidden)}|${JSON.stringify(enabledIds)}` !== settledRef.current;
  const isDefault = isDefaultArrangement(rows, eligible);
  // Reset clears the stored record, so it stays available whenever there is a record to clear —
  // including for an account whose role change left every destination it can still see sitting at
  // the default, while the record goes on holding choices about destinations it cannot. Without
  // that, a demoted account could not clear its own arrangement and the stale choices would come
  // back the moment the grant did.
  const resetUnavailable = stored === null && isDefault && !dirty;

  function move(id: string, direction: -1 | 1): void {
    movePositions.current = new Map(
      Array.from(listRef.current?.children ?? []).map((element) => [
        element,
        element.getBoundingClientRect().top,
      ]),
    );
    const next = moveDestination(rows, id, direction);
    const position = next.findIndex((row) => row.destination.id === id);
    const label = next[position]?.destination.label ?? "";
    setRows(next);
    setSaveStatus("idle");
    setAnnouncement(
      `${label} moved to position ${position + 1} of ${next.length}.`,
    );
    const atStart = position === 0;
    const atEnd = position === next.length - 1;
    setFocusRequest(
      `${id}:${direction === -1 ? (atStart ? "down" : "up") : atEnd ? "up" : "down"}`,
    );
  }

  function placeDestination(id: string, targetId: string, after: boolean): void {
    if (busy !== null || editing !== null) return;
    const row = rows.find(entry => entry.destination.id === id);
    if (!row || id === targetId) return;
    const next = rows.filter(entry => entry.destination.id !== id);
    const index = next.findIndex(entry => entry.destination.id === targetId);
    if (index < 0) return;
    next.splice(index + Number(after), 0, row);
    setRows(next);
    setSaveStatus("idle");
    setError(null);
    setFocusRequest(`${id}:up`);
    setAnnouncement(`${row.destination.label} moved to position ${index + Number(after) + 1} of ${next.length}.`);
  }

  const reorder = useReorder({
    items: rows.map(row => ({ id: row.destination.id, label: row.destination.label })),
    disabled: busy !== null || editing !== null,
    onMove: (id, { targetId, after }) => placeDestination(id, targetId, after),
  });

  useEffect(() => {
    if (reorder.announcement) setAnnouncement(reorder.announcement);
  }, [reorder.announcement]);

  function cancelChanges(): void {
    const saved = savedDraft.current;
    const liveIds = new Set(shares.filter(share => share.status === "active").flatMap(share => shareEntryIds(share.item)));
    const nextEnabled = sharesReady
      ? saved.enabledIds.filter(id => liveIds.has(id) || stored?.shared?.includes(id))
      : saved.enabledIds;
    const savedOrder = saved.rows.map(row => row.destination.id);
    const savedHidden = [...saved.rows.filter(row => row.hidden).map(row => row.destination.id), ...saved.childHidden];
    const adoptedNow = adoptedCustomItems(shares, {
      version: 4, order: savedOrder, hidden: savedHidden, custom: saved.custom, shared: nextEnabled,
    }, viewerUid);
    const nextRows = patchSharedRows(saved.rows, saved.custom, adoptedNow,
      new Set(eligible.map(destination => destination.id)), savedOrder, savedHidden);
    savedDraft.current = { ...saved, rows: nextRows, enabledIds: nextEnabled };
    settledRef.current = arrangementKey(nextRows, saved.childHidden, nextEnabled);
    setRows(nextRows);
    setCustom(saved.custom);
    setChildHidden(saved.childHidden);
    setEnabledIds(nextEnabled);
    setSaveStatus("idle");
    setError(null);
    setAnnouncement("Rail changes canceled.");
    if (nextRows[0]) setFocusRequest(`${nextRows[0].destination.id}:up`);
  }

  function toggleHidden(row: Row): void {
    const hidden = !row.hidden;
    setRows(setDestinationHidden(rows, row.destination.id, hidden));
    setSaveStatus("idle");
    setAnnouncement(
      hidden
        ? `${row.destination.label} hidden from your navigation. It stays open to you by address.`
        : `${row.destination.label} shown in your navigation.`,
    );
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy("save");
    setError(null);
    setSaveStatus("idle");
    const written = rows;
    const customIds = custom.flatMap(item => [item.id, ...(item.kind === "section" ? item.links.map(link => link.id) : [])]);
    const next = storedFromResolved(written, { ...stored, version: 4, order: stored?.order ?? [], hidden: stored?.hidden ?? [], custom }, [...NAV_DESTINATIONS, ...customIds.map(id => ({ id }))]);
    const childIds = custom.flatMap(item => item.kind === "section" ? item.links.map(link => link.id) : []);
    next.hidden = [...next.hidden.filter(id => !childIds.includes(id)), ...childHidden.filter(id => childIds.includes(id))];
    next.order = [...next.order.filter(id => !childIds.includes(id)), ...childIds];
    const liveShareIds = new Set(shares.filter(share => share.status === "active").flatMap(share => shareEntryIds(share.item)));
    const keptShared = sharesReady ? enabledIds.filter(id => liveShareIds.has(id)) : enabledIds;
    if (sharesReady) next.order = [...next.order, ...keptShared.filter(id => !next.order.includes(id))];
    else restoreUnresolvedShared(next, stored);
    if (keptShared.length > 0 || stored?.shared) next.shared = keptShared;
    try {
      await onSave(next);
      settle(written, childHidden, keptShared);
      savedDraft.current = { rows: written, custom, childHidden, enabledIds: keptShared };
      setEnabledIds(keptShared);
      setSaveStatus("saved");
      successNotice.show("Your rail is saved.");
    } catch (failure) {
      setSaveStatus("error");
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : "Your rail could not be saved. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function reset(): Promise<void> {
    if (busy) return;
    setBusy("reset");
    setError(null);
    setSaveStatus("idle");
    try {
      await onReset();
      const defaults = resolveNavigation(null, eligible);
      settle(defaults, [], []);
      savedDraft.current = { rows: defaults, custom: [], childHidden: [], enabledIds: [] };
      setCustom([]);
      setChildHidden([]);
      setEnabledIds([]);
      setEditing(null);
      setConfirmReset(false);
      setResetFocusRequested(true);
      setSaveStatus("saved");
      successNotice.show("Navigation restored to default.");
    } catch (failure) {
      setSaveStatus("error");
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : "Your rail could not be saved. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  function applyCustom(item: CustomNavItem): void {
    const next = custom.some(entry => entry.id === item.id) ? custom.map(entry => entry.id === item.id ? item : entry) : [...custom, item];
    setCustom(next);
    const validChildren = next.flatMap(entry => entry.kind === "section" ? entry.links.map(link => link.id) : []);
    setChildHidden(current => current.filter(id => validChildren.includes(id)));
    const arrangement = { version: 4 as const, custom: next, shared: enabledIds, order: rows.map(row => row.destination.id), hidden: rows.filter(row => row.hidden).map(row => row.destination.id) };
    const nextAdopted = adoptedCustomItems(shares, arrangement, viewerUid);
    const nextRows = resolveNavigation(arrangement, [...eligible, ...customSettingsDestinations([...next, ...nextAdopted])]);
    setRows(nextRows);
    if (editing === "new" && customNavigationCount(next) === MAX_CUSTOM_NAVIGATION_ITEMS && nextRows.length > 1) {
      const position = nextRows.findIndex(row => row.destination.id === item.id);
      setFocusRequest(`${item.id}:${position > 0 ? "up" : "down"}`);
    }
    setEditing(null);
    setSaveStatus("idle");
    setAnnouncement(`${item.label} ready. Save your rail to keep this change.`);
  }

  function shareState(item: CustomNavItem): "shared" | "private" {
    return shares.some(share => share.status === "active" && share.ownerUid === viewerUid && share.item.id === item.id)
      ? "shared" : "private";
  }

  async function shareItem(item: CustomNavItem): Promise<void> {
    if (!onShare || sharing) return;
    const active = shareState(item) === "shared";
    setSharing(item.id);
    setError(null);
    try {
      await onShare(item, !active);
      setAnnouncement(active ? `${item.label} is no longer shared.` : `${item.label} is shared with staff.`);
    } catch (failure) {
      setSaveStatus("error");
      setError(failure instanceof Error && failure.message
        ? failure.message
        : item.kind === "section"
          ? "This span could not be shared. Try again."
          : "This plank could not be shared. Try again.");
    } finally {
      setSharing(null);
    }
  }

  function setShareEnabled(share: NavigationShare, on: boolean): void {
    const ids = shareEntryIds(share.item);
    if (on && !sharedEntriesFit(enabledIds, share.item, shares, viewerUid, new Set(custom.map((item) => item.id)))) {
      setSaveStatus("error");
      setError(`You can turn on up to ${MAX_SHARED_NAVIGATION_ENTRIES} shared planks and spans. A span and each plank count as one entry.`);
      return;
    }
    const nextIds = on
      ? [...enabledIds, ...ids.filter(id => !enabledIds.includes(id))]
      : enabledIds.filter(id => !ids.includes(id));
    setEnabledIds(nextIds);
    if (on) {
      if (!rows.some(row => row.destination.id === share.item.id)) {
        setRows([...rows, { destination: customSettingsDestinations([share.item])[0], hidden: false }]);
      }
    } else {
      setRows(rows.filter(row => row.destination.id !== share.item.id));
      setChildHidden(current => current.filter(id => !ids.includes(id)));
    }
    setSaveStatus("idle");
    setError(null);
    setAnnouncement(on
      ? `${share.item.label} turned on. Save your rail to keep this change.`
      : `${share.item.label} turned off. Save your rail to keep this change.`);
  }

  function removeCustom(item: CustomNavItem): void {
    setCustom(custom.filter(entry => entry.id !== item.id));
    if (item.kind === "section") setChildHidden(current => current.filter(id => !item.links.some(link => link.id === id)));
    const index = rows.findIndex(row => row.destination.id === item.id);
    const next = rows.filter(row => row.destination.id !== item.id);
    setRows(next);
    const survivor = next[Math.min(index, next.length - 1)];
    if (survivor && next.length > 1) setFocusRequest(`${survivor.destination.id}:${Math.min(index, next.length - 1) > 0 ? "up" : "down"}`);
    else addControl.current?.focus();
    setEditing(null);
    setSaveStatus("idle");
    setAnnouncement(`${item.label} removed. Save your rail to keep this change.`);
  }

  const sharePreferences = { version: 4 as const, order: [], hidden: [], custom, shared: enabledIds };
  const shareRows = sharedNavigationRows(shares, sharePreferences, viewerUid);
  const shareCap = capAdoptedShares(shares, sharePreferences, viewerUid);

  function shareControl(item: CustomNavItem | undefined) {
    if (!onShare || !item) return null;
    const active = shareState(item) === "shared";
    const saved = (stored?.custom ?? []).some(entry => sameCustomItem(entry, item));
    return (
      <Button
        aria-label={active ? `Stop sharing ${item.label}` : `Share ${item.label}`}
        aria-pressed={active}
        disabled={busy !== null || editing !== null || sharing !== null || (!active && !saved)}
        onClick={() => void shareItem(item)}
        variant="ghost"
      >
        <Icon name="users" />
        <span>{sharing === item.id ? "Sharing…" : active ? "Stop sharing" : "Share"}</span>
      </Button>
    );
  }

  return (
    <Panel className="nav-preferences" aria-labelledby="navigation-preferences-heading">
      <div className="nav-preferences-scroll">
      <div className="nav-preferences-layout">
        <header className="nav-preferences-intro">
          <h2 id="navigation-preferences-heading">Your rail</h2>
          <p>Reorder or hide your destinations.</p>
          <p className="nav-preferences-helper" id="navigation-preferences-help">
            Hidden destinations still open by address. Drag a grip or open Move for more options.
          </p>
        </header>

        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
        <p className="sr-only" id={reorder.helpId}>{reorder.instructions}</p>

        <ol
          className="nav-preference-list"
          aria-label="Your rail order"
          aria-describedby="navigation-preferences-help"
          ref={listRef}
        >
          {rows.map((row, index) => {
            const ownItem = custom.find((entry) => entry.id === row.destination.id);
            return (
            <li
              {...reorder.itemProps(row.destination.id)}
              className="nav-preference-row"
              data-hidden={row.hidden ? "true" : "false"}
              data-custom={ownItem ? "true" : undefined}
              key={row.destination.id}
            >
              <ReorderHandle {...reorder.handleProps(row.destination.id)} ref={element => {
                reorder.handleProps(row.destination.id).ref(element);
                for (const direction of ["up", "down"]) {
                  const key = `${row.destination.id}:${direction}`;
                  if (element) controlRefs.current.set(key, element);
                  else controlRefs.current.delete(key);
                }
              }} />
              <span className="nav-preference-identity">
                <Icon name={row.destination.icon} />
                <span className="nav-preference-copy">
                  <span className="nav-preference-name" title={row.destination.label}>{row.destination.label}</span>
                  {row.destination.required ? <span className="nav-preference-required">Always shown</span> : null}
                </span>
              </span>
              {/* Every row control is held while a write is in flight. A move or a hide made
                  during a slow save or reset would look accepted and then be replaced when the
                  write settled, so the controls say plainly that they are unavailable instead. */}
              <span className="nav-preference-controls">
                {ownItem ? <>
                  {shareControl(ownItem)}
                  <Button aria-label={`Edit ${row.destination.label}`} disabled={busy !== null || editing !== null} onClick={() => beginEditing(ownItem)} variant="ghost"><Icon name="pencil" /><span>Edit</span></Button>
                  <Button aria-label={`Delete ${row.destination.label}`} disabled={busy !== null || editing !== null} onClick={() => removeCustom(ownItem)} variant="danger-quiet"><Icon name="trash" /><span>Delete</span></Button>
                </> : null}
                <Menu variant="ghost" className="nav-preference-move" icon="sort"
                  label={`Move options for ${row.destination.label}`} disabled={busy !== null || editing !== null || rows.length < 2}
                  items={[
                    { key: "up", label: "Move up", hidden: index === 0, onSelect: () => move(row.destination.id, -1) },
                    { key: "down", label: "Move down", hidden: index === rows.length - 1, onSelect: () => move(row.destination.id, 1) },
                    { key: "first", label: "Move to first", hidden: index === 0, onSelect: () => placeDestination(row.destination.id, rows[0].destination.id, false) },
                    { key: "last", label: "Move to last", hidden: index === rows.length - 1, onSelect: () => placeDestination(row.destination.id, rows[rows.length - 1].destination.id, true) },
                  ]}>
                  <span aria-hidden="true">Move</span><span className="sr-only">{`Move options for ${row.destination.label}`}</span>
                </Menu>
                {row.destination.required ? null : (
                  <ActionControl
                    action={row.hidden ? "show" : "hide"}
                    className="nav-preference-control"
                    contextLabel={row.destination.label}
                    disabled={busy !== null || editing !== null}
                    label={row.hidden ? "Show" : "Hide"}
                    onClick={() => toggleHidden(row)}
                    variant="ghost"
                  />
                )}
              </span>
            </li>
            );
          })}
        </ol>

        <section className="nav-shared" aria-labelledby="shared-navigation-heading">
          <h3 id="shared-navigation-heading">Shared planks</h3>
          <p className="nav-preferences-helper">Turn a plank on to add it to your rail. You can turn on {MAX_SHARED_NAVIGATION_ENTRIES} shared planks and spans. The owner can change a shared plank or span.</p>
          {shareRows.length === 0 ? <p>No shared planks.</p> : (
            <ul className="nav-preference-list" aria-label="Shared planks">
              {shareRows.map((shareRow) => {
                const share = shares.find(entry => entry.item.id === shareRow.id);
                const omission = shareCap.omissions.find(entry => entry.id === shareRow.id);
                const onRail = shareCap.items.some(item => item.id === shareRow.id);
                return (
                  <li className="nav-preference-row" key={shareRow.id}>
                    <span className="nav-preference-identity">
                      <span className="nav-preference-name" title={shareRow.label}>{shareRow.label}</span>
                      <span className="nav-preferences-helper">Shared by {shareRow.ownerName}</span>
                      {omission ? <span className="nav-preferences-helper">{sharedCapMessage(omission, onRail)}</span> : null}
                    </span>
                    <span className="nav-preference-controls">
                      {shareRow.reason ? <span className="nav-preferences-helper">{shareRow.reason}</span> : shareRow.owned || !share ? null : (
                        <Button
                          aria-label={shareRow.enabled ? `Turn off ${shareRow.label}` : `Turn on ${shareRow.label}`}
                          aria-pressed={shareRow.enabled}
                          disabled={busy !== null || editing !== null}
                          onClick={() => setShareEnabled(share, !shareRow.enabled)}
                          variant="ghost"
                        >
                          <Icon name={shareRow.enabled ? "check" : "plus"} />
                          <span>{shareRow.enabled ? "Turn off" : "Turn on"}</span>
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <footer className="nav-preferences-footer">
          <p className="nav-preferences-helper">Use up to {MAX_CUSTOM_NAVIGATION_ITEMS} planks and spans. A span and each plank count as one entry.</p>
          <Button ref={addControl} disabled={busy !== null || editing !== null || customNavigationCount(custom) >= MAX_CUSTOM_NAVIGATION_ITEMS} onClick={() => beginEditing("new")}>Add to your rail</Button>
          {confirmReset ? <div className="nav-preferences-actions" role="group" aria-label="Confirm rail reset">
            <p>Reset removes all your planks and spans, stops sharing them, and restores the built-in order.</p>
            {resetRemovalList(resetRemovalItems(rows, stored?.custom, custom))}
            <AsyncActionButton variant="danger-quiet" disabled={busy !== null || editing !== null} onClick={() => void reset()}
              label="Remove your planks and spans and reset" pending={busy === "reset"} pendingLabel="Resetting…"
              pendingAnnouncement="Reset removes all your planks and spans, stops sharing them, and restores the built-in order." />
            <Button ref={resetCancel} className="nav-reset-cancel" disabled={busy !== null || editing !== null} onClick={() => setConfirmReset(false)}>Cancel reset</Button>
          </div> : null}
          <p className="nav-preferences-change-state">
            {dirty ? "Unsaved changes" : "No unsaved changes"}
          </p>
          {saveStatus === "saved" && !successNotice.available ? (
            <InlineMessage tone="success">Your rail is saved.</InlineMessage>
          ) : null}
          {saveStatus === "error" && error ? (
            <InlineMessage tone="error">{error}</InlineMessage>
          ) : null}

          <div className="nav-preferences-actions">
            <AsyncActionButton
              disabled={!dirty || busy !== null || editing !== null}
              label="Save rail"
              onClick={() => void save()}
              pending={busy === "save"}
              pendingAnnouncement="Saving your rail."
              pendingLabel="Saving…"
              type="button"
              variant="primary"
            />
            <Button disabled={!dirty || busy !== null || editing !== null} onClick={cancelChanges}>Cancel changes</Button>
          </div>
          <div className="nav-preferences-reset">
            <AsyncActionButton
              disabled={resetUnavailable || busy !== null || editing !== null}
              label="Reset to default"
              onClick={() => { if (resetRemovalItems(rows, stored?.custom, custom).length > 0) { resetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setConfirmReset(true); } else void reset(); }}
              pending={busy === "reset" && !confirmReset}
              pendingAnnouncement="Restoring the default navigation."
              pendingLabel="Resetting…"
              type="button"
              variant="secondary"
            />
          </div>
        </footer>
      </div>
      </div>
      {editing ? <CustomNavigationEditor key={editing === "new" ? "new" : editing.id} item={editing === "new" ? undefined : editing}
        remaining={MAX_CUSTOM_NAVIGATION_ITEMS - customNavigationCount(custom) + (editing === "new" ? 0 : customNavigationCount([editing]))}
        searchContent={searchContent} hiddenIds={childHidden} onHiddenChange={(id, hidden) => setChildHidden(current => hidden ? [...new Set([...current, id])] : current.filter(value => value !== id))}
        onApply={applyCustom} onCancel={() => setEditing(null)} /> : null}
    </Panel>
  );
}
