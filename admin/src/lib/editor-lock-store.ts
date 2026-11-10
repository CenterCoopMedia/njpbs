import {
  deleteField,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  type DocumentData,
} from "firebase/firestore";
import { db } from "./firebase";
import { prepareEditorLockExitRelease } from "./editor-lock-exit";
import {
  editorLockContentAddress,
  editorLockDocumentId,
  editorLockObservationNow,
  normalizeEditorLockName,
  type EditorLock,
  type EditorLockActor,
  type EditorLockClaim,
  type EditorLockClient,
  type EditorLockRequest,
} from "./editor-locks";

const LOCK_COLLECTION = "cmsEditorLocks";
const LEGACY_LOCK_FIELDS = new Set([
  "surfaceKey",
  "ownerId",
  "ownerName",
  "sessionId",
  "acquiredAt",
  "heartbeatAt",
  "takeoverAt",
]);
const LEGACY_RELEASE_FIELDS = new Set([
  "surfaceKey",
  "ownerId",
  "sessionId",
  "releasedAt",
]);

function hasOnlyFields(
  data: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean {
  return Object.keys(data).every((field) => fields.has(field));
}

function hasNoPersistedContentAddress(data: Record<string, unknown>): boolean {
  return !("contentCollection" in data) && !("contentId" in data);
}

function timestampMillis(value: unknown): number | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "toMillis" in value &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    const milliseconds = (value as { toMillis: () => unknown }).toMillis();
    if (typeof milliseconds === "number" && Number.isFinite(milliseconds)) {
      return milliseconds;
    }
  }
  return undefined;
}

export function parseEditorLock(
  value: unknown,
  observedAtMs = editorLockObservationNow(),
): EditorLock | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const acquiredAtMs = timestampMillis(data.acquiredAt);
  const heartbeatAtMs = timestampMillis(data.heartbeatAt);
  const surfaceKey = typeof data.surfaceKey === "string" ? data.surfaceKey : null;
  const contentAddress = surfaceKey ? editorLockContentAddress(surfaceKey) : null;
  const isLegacy = hasNoPersistedContentAddress(data);
  if (
    !surfaceKey ||
    !contentAddress ||
    (isLegacy
      ? !hasOnlyFields(data, LEGACY_LOCK_FIELDS)
      : data.contentCollection !== contentAddress.contentCollection ||
        data.contentId !== contentAddress.contentId) ||
    (isLegacy &&
      "takeoverAt" in data &&
      timestampMillis(data.takeoverAt) === undefined) ||
    typeof data.ownerId !== "string" ||
    typeof data.ownerName !== "string" ||
    typeof data.sessionId !== "string" ||
    acquiredAtMs === undefined ||
    heartbeatAtMs === undefined
  ) {
    return null;
  }
  return {
    surfaceKey,
    ownerId: data.ownerId,
    ownerName: normalizeEditorLockName(data.ownerName),
    sessionId: data.sessionId,
    acquiredAtMs,
    heartbeatAtMs,
    observedAtMs,
    ...(parseEditorLockRequest(data) ?? {}),
  };
}

// A request triple is optional and advisory. A half-written or malformed one is dropped rather
// than failing the whole lease read: presence must keep naming the holder even if the ask is
// unreadable.
function parseEditorLockRequest(
  data: Record<string, unknown>,
): { request: EditorLockRequest } | null {
  const atMs = timestampMillis(data.requestedAt);
  if (
    typeof data.requestedById !== "string" ||
    data.requestedById.length === 0 ||
    typeof data.requestedByName !== "string" ||
    atMs === undefined
  ) {
    return null;
  }
  return {
    request: {
      byId: data.requestedById,
      byName: normalizeEditorLockName(data.requestedByName),
      atMs,
    },
  };
}

function lockRef(surfaceKey: string) {
  return doc(db, LOCK_COLLECTION, editorLockDocumentId(surfaceKey));
}

function lockWrite(
  surfaceKey: string,
  actor: EditorLockActor,
  sessionId: string,
  force = false,
) {
  const contentAddress = editorLockContentAddress(surfaceKey);
  if (!contentAddress) throw new Error("Unsupported editor lock surface key.");
  return {
    surfaceKey,
    ...contentAddress,
    ownerId: actor.id,
    ownerName: normalizeEditorLockName(actor.name),
    sessionId,
    acquiredAt: serverTimestamp(),
    heartbeatAt: serverTimestamp(),
    ...(force ? { takeoverAt: serverTimestamp() } : {}),
  };
}

function lockReleaseWrite(surfaceKey: string, actorId: string, sessionId: string) {
  const contentAddress = editorLockContentAddress(surfaceKey);
  if (!contentAddress) throw new Error("Unsupported editor lock surface key.");
  return {
    surfaceKey,
    ...contentAddress,
    ownerId: actorId,
    sessionId,
    releasedAt: serverTimestamp(),
  };
}

function isEditorLockRelease(value: unknown, surfaceKey: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const contentAddress = editorLockContentAddress(surfaceKey);
  const isLegacy = hasNoPersistedContentAddress(data);
  return (
    contentAddress !== null &&
    data.surfaceKey === surfaceKey &&
    (isLegacy
      ? hasOnlyFields(data, LEGACY_RELEASE_FIELDS)
      : data.contentCollection === contentAddress.contentCollection &&
        data.contentId === contentAddress.contentId) &&
    typeof data.ownerId === "string" &&
    typeof data.sessionId === "string" &&
    timestampMillis(data.releasedAt) !== undefined
  );
}

function localLock(
  surfaceKey: string,
  actor: EditorLockActor,
  sessionId: string,
  wallNowMs: number,
  observedAtMs: number,
): EditorLock {
  return {
    surfaceKey,
    ownerId: actor.id,
    ownerName: normalizeEditorLockName(actor.name),
    sessionId,
    acquiredAtMs: wallNowMs,
    heartbeatAtMs: wallNowMs,
    observedAtMs,
  };
}

function isPermissionDenied(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "permission-denied" || code === "firestore/permission-denied";
}

function isSameObservedLease(current: EditorLock, observed: EditorLock): boolean {
  return (
    current.surfaceKey === observed.surfaceKey &&
    current.ownerId === observed.ownerId &&
    current.sessionId === observed.sessionId &&
    current.acquiredAtMs === observed.acquiredAtMs &&
    current.heartbeatAtMs === observed.heartbeatAtMs
  );
}

function withObservedAt(lock: EditorLock, observedAtMs: number): EditorLock {
  return { ...lock, observedAtMs };
}

export const editorLockClient: EditorLockClient = {
  prepareExitRelease: prepareEditorLockExitRelease,
  subscribe(surfaceKey, onLock, onError) {
    return onSnapshot(
      lockRef(surfaceKey),
      (snapshot) => {
        if (!snapshot.exists()) {
          onLock(null);
          return;
        }
        const data = snapshot.data({ serverTimestamps: "estimate" }) as DocumentData;
        if (isEditorLockRelease(data, surfaceKey)) {
          onLock(null);
          return;
        }
        const parsed = parseEditorLock(data);
        if (!parsed || parsed.surfaceKey !== surfaceKey) {
          onError();
          return;
        }
        onLock(parsed);
      },
      () => onError(),
    );
  },

  async claim(surfaceKey, actor, sessionId, options): Promise<EditorLockClaim> {
    const wallNowMs = Date.now();
    const observedAtMs = editorLockObservationNow();
    let serverRejectedLock: EditorLock | null = null;
    try {
      return await runTransaction(db, async (transaction) => {
        const reference = lockRef(surfaceKey);
        const snapshot = await transaction.get(reference);
        if (snapshot.exists()) {
          const current = parseEditorLock(snapshot.data());
          if (
            current &&
            current.surfaceKey === surfaceKey &&
            current.ownerId === actor.id &&
            current.sessionId === sessionId
          ) {
            return { status: "acquired" as const, lock: current };
          }
          if (
            current &&
            current.surfaceKey === surfaceKey &&
            !(current.ownerId === actor.id && current.sessionId === sessionId)
          ) {
            if (options?.force !== true && options?.observedStale !== true) {
              return { status: "blocked" as const, lock: current };
            }
            // A non-forced stale replacement is still authorized against request.time by the
            // Firestore rule. Retain the fresh transaction read so a denied write can return to
            // the blocked state instead of degrading the whole presence service to fail-open.
            if (options?.force !== true) serverRejectedLock = current;
          }
        }
        transaction.set(reference, lockWrite(surfaceKey, actor, sessionId, options?.force));
        return {
          status: "acquired" as const,
          lock: localLock(surfaceKey, actor, sessionId, wallNowMs, observedAtMs),
        };
      });
    } catch (error) {
      if (serverRejectedLock && isPermissionDenied(error)) {
        const observedLock = options?.observedLock;
        return {
          status: "blocked",
          lock:
            observedLock && isSameObservedLease(serverRejectedLock, observedLock)
              ? withObservedAt(serverRejectedLock, observedLock.observedAtMs)
              : serverRejectedLock,
        };
      }
      throw error;
    }
  },

  async heartbeat(surfaceKey, actorId, sessionId): Promise<boolean> {
    return runTransaction(db, async (transaction) => {
      const reference = lockRef(surfaceKey);
      const snapshot = await transaction.get(reference);
      const current = snapshot.exists() ? parseEditorLock(snapshot.data()) : null;
      if (
        !current ||
        current.surfaceKey !== surfaceKey ||
        current.ownerId !== actorId ||
        current.sessionId !== sessionId
      ) {
        return false;
      }
      transaction.update(reference, { heartbeatAt: serverTimestamp() });
      return true;
    });
  },

  async requestTakeover(surfaceKey, actor, ownerSessionId): Promise<boolean> {
    return runTransaction(db, async (transaction) => {
      const reference = lockRef(surfaceKey);
      const snapshot = await transaction.get(reference);
      const current = snapshot.exists() ? parseEditorLock(snapshot.data()) : null;
      // Ask the exact session the waiting editor was shown. If the lease has since moved, the
      // subscription is about to deliver the new holder and the person decides again.
      if (
        !current ||
        current.surfaceKey !== surfaceKey ||
        current.sessionId !== ownerSessionId ||
        current.ownerId === actor.id ||
        // The lease carries one ask and nothing queues behind it, so overwriting somebody else's
        // pending request would drop the editor already waiting. Their ask stands until the
        // holder answers it.
        (current.request !== undefined && current.request.byId !== actor.id)
      ) {
        return false;
      }
      transaction.update(reference, {
        requestedById: actor.id,
        requestedByName: normalizeEditorLockName(actor.name),
        requestedAt: serverTimestamp(),
      });
      return true;
    });
  },

  async clearRequest(surfaceKey, actorId, sessionId): Promise<void> {
    await runTransaction(db, async (transaction) => {
      const reference = lockRef(surfaceKey);
      const snapshot = await transaction.get(reference);
      const current = snapshot.exists() ? parseEditorLock(snapshot.data()) : null;
      if (
        !current ||
        current.surfaceKey !== surfaceKey ||
        current.ownerId !== actorId ||
        current.sessionId !== sessionId ||
        !current.request
      ) {
        return;
      }
      transaction.update(reference, {
        requestedById: deleteField(),
        requestedByName: deleteField(),
        requestedAt: deleteField(),
      });
    });
  },

  async release(surfaceKey, actorId, sessionId): Promise<void> {
    await runTransaction(db, async (transaction) => {
      const reference = lockRef(surfaceKey);
      const snapshot = await transaction.get(reference);
      const current = snapshot.exists() ? parseEditorLock(snapshot.data()) : null;
      if (
        current &&
        current.surfaceKey === surfaceKey &&
        current.ownerId === actorId &&
        current.sessionId === sessionId
      ) {
        transaction.set(reference, lockReleaseWrite(surfaceKey, actorId, sessionId));
      }
    });
  },
};
