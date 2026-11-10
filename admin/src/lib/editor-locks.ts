export const EDITOR_LOCK_HEARTBEAT_MS = 15_000;
export const EDITOR_LOCK_LEASE_MS = 120_000;

export interface EditorLockActor {
  id: string;
  name: string;
}

export interface EditorLockContentAddress {
  contentCollection: "cmsPages" | "cmsPosts";
  contentId: string;
}

// A waiting editor's advisory ask, attached to a live lease. It transfers nothing on its own:
// the holder decides whether to hand off, and a lease with an ignored request still expires or
// is forced through the ordinary path.
export interface EditorLockRequest {
  byId: string;
  byName: string;
  atMs: number;
}

export interface EditorLock {
  surfaceKey: string;
  ownerId: string;
  ownerName: string;
  sessionId: string;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  // Monotonic time when this client observed the server-stamped heartbeat. Lease expiry uses
  // elapsed observation time, not the workstation's wall clock, so a fast local clock cannot
  // silently turn an active remote session into a stale one.
  observedAtMs: number;
  request?: EditorLockRequest;
}

export type EditorLockClaim =
  | { status: "acquired"; lock: EditorLock }
  | { status: "blocked"; lock: EditorLock };

export interface EditorLockClient {
  subscribe: (
    surfaceKey: string,
    onLock: (lock: EditorLock | null) => void,
    onError: () => void,
  ) => () => void;
  claim: (
    surfaceKey: string,
    actor: EditorLockActor,
    sessionId: string,
    options?: {
      force?: boolean;
      observedStale?: boolean;
      // The exact subscription value whose elapsed observation window led to a stale claim.
      // The store preserves its monotonic age only if the transaction reads that same unchanged
      // lease; a newer heartbeat is a fresh observation and resets normally.
      observedLock?: EditorLock;
    },
  ) => Promise<EditorLockClaim>;
  heartbeat: (
    surfaceKey: string,
    actorId: string,
    sessionId: string,
  ) => Promise<boolean>;
  release: (
    surfaceKey: string,
    actorId: string,
    sessionId: string,
  ) => Promise<void>;
  // Prepare credentials while the document is active. The returned function must start its
  // keepalive request synchronously because pagehide cannot wait for token retrieval.
  prepareExitRelease?: (
    surfaceKey: string,
    actorId: string,
    sessionId: string,
  ) => Promise<() => void>;
  // Attach this actor's ask to the live lease named by `ownerSessionId`. Resolves false when the
  // lease moved on, so the caller re-reads the subscription rather than asking a session that
  // no longer holds the record.
  requestTakeover: (
    surfaceKey: string,
    actor: EditorLockActor,
    ownerSessionId: string,
  ) => Promise<boolean>;
  // Clear the request from this session's own lease, after answering it either way.
  clearRequest: (
    surfaceKey: string,
    actorId: string,
    sessionId: string,
  ) => Promise<void>;
}

export function editorLockDocumentId(surfaceKey: string): string {
  // Surface keys are deliberately slash-free and are themselves the canonical document ID.
  // Firestore rules can therefore bind lockId == surfaceKey and reject invisible duplicates.
  return surfaceKey;
}

export function editorLockContentAddress(
  surfaceKey: string,
): EditorLockContentAddress | null {
  const match = /^(cmsPages|cmsPosts):([A-Za-z0-9_-]{1,128})$/.exec(surfaceKey);
  if (!match) return null;
  return {
    contentCollection: match[1] as EditorLockContentAddress["contentCollection"],
    contentId: match[2]!,
  };
}

export function editorLockObservationNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function isEditorLockStale(
  lock: EditorLock,
  observationNowMs = editorLockObservationNow(),
): boolean {
  return observationNowMs - lock.observedAtMs >= EDITOR_LOCK_LEASE_MS;
}

// A tab that opens a record long after the last heartbeat has no observation window to wait out,
// so the elapsed-observation test alone would show an abandoned session as an active editor for
// a further two minutes. Reading the stored heartbeat against the workstation clock closes that,
// and it is safe to act on because the workstation never decides the outcome: the Firestore rule
// re-checks the same age against server request time, so a fast local clock produces a refused
// claim rather than an evicted editor (#1047).
export function isEditorLockAbandoned(
  lock: EditorLock,
  wallNowMs = Date.now(),
): boolean {
  return wallNowMs - lock.heartbeatAtMs >= EDITOR_LOCK_LEASE_MS;
}

export function normalizeEditorLockName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.slice(0, 100) || "Another editor";
}
