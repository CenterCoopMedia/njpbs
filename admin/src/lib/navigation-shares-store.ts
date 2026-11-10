import { useSyncExternalStore } from "react";
import { collection, documentId, getDocs, limit, onSnapshot, query, where, type Unsubscribe } from "firebase/firestore";
import { SHARE_LISTENER_LIMIT } from "./listener-limits";
import { db } from "./firebase";
import {
  MAX_SHARED_NAVIGATION_ENTRIES,
  parseNavigationShare,
  shareEntryIds,
  type NavigationShare,
} from "./navigation-shares";

const EMPTY: readonly NavigationShare[] = [];
const EMPTY_STATE = { shares: EMPTY, ready: true };
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const FIRESTORE_IN_LIMIT = 30;
let snapshot: { shares: readonly NavigationShare[]; ready: boolean } = { shares: EMPTY, ready: false };
let activeShares: NavigationShare[] = [];
let referencedIds: readonly string[] = [];
let activeReady = false;
let tombstoneGeneration = 0;
let tombstoneReloadQueued = false;
let settledMissing: readonly string[] = [];
let pendingMissing: readonly string[] = [];
const listeners = new Set<() => void>();
let stop: Unsubscribe | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelayMs = RETRY_MIN_MS;

function publish(next: { shares: readonly NavigationShare[]; ready: boolean }): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function clearRetry(): void {
  if (retryTimer === null) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every((id) => seen.has(id));
}

function referencedMissing(): string[] {
  const present = new Set<string>();
  for (const share of activeShares) {
    if (share.status !== "active") continue;
    present.add(share.id);
    for (const id of shareEntryIds(share.item)) present.add(id);
  }
  const missing: string[] = [];
  for (const id of referencedIds) {
    if (present.has(id) || missing.includes(id)) continue;
    missing.push(id);
    if (missing.length === MAX_SHARED_NAVIGATION_ENTRIES) break;
  }
  return missing;
}

function withTombstones(missing: readonly string[]): NavigationShare[] {
  const activeIds = new Set(activeShares.map((share) => share.id));
  const kept = snapshot.shares.filter((share) => missing.includes(share.id) && !activeIds.has(share.id));
  return [...activeShares, ...kept];
}

function scheduleShareRetry(): void {
  clearRetry();
  if (listeners.size === 0) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (listeners.size === 0 || stop) return;
    attachShareListener();
  }, delay);
}

function scheduleTombstoneRetry(): void {
  clearRetry();
  if (listeners.size === 0) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (listeners.size === 0 || !stop) return;
    syncTombstones();
  }, delay);
}

async function loadTombstones(ids: readonly string[]): Promise<void> {
  const generation = ++tombstoneGeneration;
  publish({ shares: snapshot.shares, ready: false });
  try {
    const found: NavigationShare[] = [];
    for (let index = 0; index < ids.length; index += FIRESTORE_IN_LIMIT) {
      const chunk = ids.slice(index, index + FIRESTORE_IN_LIMIT);
      const tombstoneQuery = query(collection(db, "navigationShares"), where(documentId(), "in", chunk));
      const tombstoneSnapshot = await getDocs(tombstoneQuery);
      tombstoneSnapshot.forEach((entry) => {
        const parsed = parseNavigationShare(entry.id, entry.data());
        if (parsed?.status === "removed") found.push(parsed);
      });
    }
    if (generation !== tombstoneGeneration || !stop) return;
    settledMissing = ids.slice();
    if (sameIdSet(pendingMissing, ids)) pendingMissing = [];
    const activeIds = new Set(activeShares.map((share) => share.id));
    publish({ shares: [...activeShares, ...found.filter((share) => !activeIds.has(share.id))], ready: true });
  } catch {
    if (generation !== tombstoneGeneration || !stop) return;
    if (sameIdSet(pendingMissing, ids)) pendingMissing = [];
    publish({ shares: snapshot.shares, ready: false });
    scheduleTombstoneRetry();
  }
}

function syncTombstones(): void {
  const missing = referencedMissing();
  if (missing.length === 0) {
    tombstoneGeneration += 1;
    settledMissing = [];
    pendingMissing = [];
    publish({ shares: activeShares, ready: true });
    return;
  }
  if (sameIdSet(missing, settledMissing)) {
    publish({ shares: withTombstones(missing), ready: true });
    return;
  }
  if (sameIdSet(missing, pendingMissing)) {
    publish({ shares: withTombstones(missing), ready: false });
    return;
  }
  pendingMissing = missing.slice();
  void loadTombstones(missing);
}

function applyActiveSnapshot(querySnapshot: { forEach: (visit: (entry: { id: string; data: () => unknown }) => void) => void }): void {
  retryDelayMs = RETRY_MIN_MS;
  clearRetry();
  const shares: NavigationShare[] = [];
  let rowCount = 0;
  querySnapshot.forEach((entry) => {
    rowCount += 1;
    const parsed = parseNavigationShare(entry.id, entry.data());
    if (parsed) shares.push(parsed);
  });
  if (rowCount > SHARE_LISTENER_LIMIT) {
    activeReady = false;
    tombstoneGeneration += 1;
    pendingMissing = [];
    settledMissing = [];
    publish({ shares: EMPTY, ready: false });
    return;
  }
  activeShares = shares;
  activeReady = true;
  syncTombstones();
}

function attachShareListener(): void {
  let unsubscribe: Unsubscribe | null = null;
  let failed = false;
  const activeQuery = query(collection(db, "navigationShares"), where("status", "==", "active"),
    limit(SHARE_LISTENER_LIMIT + 1));
  unsubscribe = onSnapshot(activeQuery, (querySnapshot) => {
    applyActiveSnapshot(querySnapshot);
  }, () => {
    failed = true;
    tombstoneGeneration += 1;
    activeReady = false;
    pendingMissing = [];
    const current = unsubscribe;
    unsubscribe = null;
    if (stop === current) stop = null;
    publish({ shares: snapshot.shares, ready: false });
    scheduleShareRetry();
    if (current) current();
  });
  if (failed) {
    stop = null;
    if (unsubscribe) unsubscribe();
    return;
  }
  stop = unsubscribe;
}

function refreshReferencedTombstones(): void {
  if (!stop || !activeReady) return;
  syncTombstones();
}

function setReferencedShareIds(ids: readonly string[]): void {
  if (sameIds(ids, referencedIds)) return;
  referencedIds = ids.slice();
  if (!stop || !activeReady || tombstoneReloadQueued) return;
  tombstoneReloadQueued = true;
  queueMicrotask(() => {
    tombstoneReloadQueued = false;
    refreshReferencedTombstones();
  });
}

function subscribeNavigationShares(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop && retryTimer === null) attachShareListener();
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    clearRetry();
    retryDelayMs = RETRY_MIN_MS;
    tombstoneGeneration += 1;
    activeReady = false;
    activeShares = [];
    referencedIds = [];
    settledMissing = [];
    pendingMissing = [];
    if (stop) {
      stop();
      stop = null;
    }
    snapshot = { shares: EMPTY, ready: false };
  };
}

function emptySubscribe(): () => void {
  return () => {};
}

/**
 * One listener on active shares for every signed-in surface. Referenced removed
 * shares are read by document id. A fixture list skips the listener.
 * `ready` stays false until the active snapshot and those reads finish.
 * A listener error keeps the last shares and retries while a subscriber remains.
 */
export function useNavigationShares(
  injected: readonly NavigationShare[] | undefined,
  live: boolean,
  adoptedIds: readonly string[] = [],
): { shares: readonly NavigationShare[]; ready: boolean } {
  if (live && injected === undefined) setReferencedShareIds(adoptedIds);
  const watched = useSyncExternalStore(
    live && injected === undefined ? subscribeNavigationShares : emptySubscribe,
    live && injected === undefined ? () => snapshot : () => EMPTY_STATE,
    () => EMPTY_STATE,
  );
  if (injected) return { shares: injected, ready: true };
  if (!live) return EMPTY_STATE;
  return watched;
}
