// A forced takeover moves the lease while the displaced editor may still be holding unsaved
// work. The workspace already keeps that draft in memory for the rest of the visit, but memory
// does not survive a reload, a crash, or the person closing the tab to get out of the way. This
// module writes one displaced-work snapshot per person per record so the draft is still there to
// recover afterwards.
// Recovery lasts only while the same account stays signed in. Auth resolution sweeps stale
// entries across every record, and ending the session removes all displaced work in this browser.
//
// It is deliberately per-browser and per-person: the displaced draft is unreviewed work that was
// never accepted by the version guard, so it must not be published to anyone else through a
// shared store. Every entry is total and fail-quiet — a browser that blocks site data loses the
// recovery affordance, never the running editing session.

export const EDITOR_WORK_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const KEY_PREFIX = "njpbs-admin:displaced-work";

export interface RecoveredEditorWork {
  actorId: string;
  surfaceKey: string;
  // The record's human title at the moment of displacement, so the recovery prompt can name what
  // the draft belongs to without re-reading the document.
  label: string;
  // Who took the lease. Named in the prompt so the person knows why their editor went read-only.
  displacedBy: string;
  savedAtMs: number;
  payload: unknown;
}

export interface EditorWorkStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export function editorWorkRecoveryKey(actorId: string, surfaceKey: string): string {
  return `${KEY_PREFIX}:${actorId}:${surfaceKey}`;
}

function isRecoveredEditorWork(value: unknown): value is RecoveredEditorWork {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const work = value as Record<string, unknown>;
  return (
    typeof work.actorId === "string" &&
    work.actorId.length > 0 &&
    typeof work.surfaceKey === "string" &&
    work.surfaceKey.length > 0 &&
    typeof work.label === "string" &&
    typeof work.displacedBy === "string" &&
    typeof work.savedAtMs === "number" &&
    Number.isFinite(work.savedAtMs) &&
    "payload" in work &&
    work.payload !== undefined
  );
}

export function writeRecoveredWork(
  storage: EditorWorkStorage,
  work: RecoveredEditorWork,
): boolean {
  if (!isRecoveredEditorWork(work)) return false;
  try {
    storage.setItem(
      editorWorkRecoveryKey(work.actorId, work.surfaceKey),
      JSON.stringify(work),
    );
    return true;
  } catch {
    // A private window, a quota, or a browser configured to block site data. The in-memory draft
    // is untouched; only the durable copy is unavailable.
    return false;
  }
}

export function readRecoveredWork(
  storage: EditorWorkStorage,
  actorId: string,
  surfaceKey: string,
  nowMs: number = Date.now(),
): RecoveredEditorWork | null {
  const key = editorWorkRecoveryKey(actorId, surfaceKey);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecoveredEditorWork(parsed) ||
    parsed.actorId !== actorId ||
    parsed.surfaceKey !== surfaceKey
  ) {
    return null;
  }
  // Unsaved work stops being a useful offer long before it stops being a liability. Expire it so
  // an old snapshot cannot be restored over content other people have since edited.
  if (nowMs - parsed.savedAtMs > EDITOR_WORK_RECOVERY_TTL_MS) {
    clearRecoveredWork(storage, actorId, surfaceKey);
    return null;
  }
  return parsed;
}

export function clearRecoveredWork(
  storage: EditorWorkStorage,
  actorId: string,
  surfaceKey: string,
): void {
  try {
    storage.removeItem(editorWorkRecoveryKey(actorId, surfaceKey));
  } catch {
    // Nothing to do: the read path already treats an unreachable store as empty.
  }
}

// The browser store, when this build has one. Kept behind an accessor so the pure functions above
// stay testable and so a context with no localStorage (a thumbnail capture, a locked-down
// browser) degrades to "no recovery offered" instead of throwing during render.
export function browserEditorWorkStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    return storage ? storage : null;
  } catch {
    return null;
  }
}

// A null actor ends recovery for the browser, including records left by earlier accounts or
// older builds. Never clear unrelated preferences or Firebase's own session storage.
export function pruneBrowserRecoveredWork(actorId: string | null): void {
  const storage = browserEditorWorkStorage();
  if (!storage) return;
  const actorPrefix = `${KEY_PREFIX}:${actorId}:`;
  const nowMs = Date.now();
  try {
    // Walk backwards because removing a key shifts the remaining storage indexes.
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (!key?.startsWith(`${KEY_PREFIX}:`)) continue;
      if (
        actorId !== null &&
        key.startsWith(actorPrefix) &&
        readRecoveredWork(storage, actorId, key.slice(actorPrefix.length), nowMs)
      ) {
        continue;
      }
      storage.removeItem(key);
    }
  } catch {
    // Blocked site storage must not prevent authentication or sign-out.
  }
}
