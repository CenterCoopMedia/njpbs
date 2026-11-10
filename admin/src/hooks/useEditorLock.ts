import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EDITOR_LOCK_HEARTBEAT_MS,
  editorLockObservationNow,
  isEditorLockAbandoned,
  isEditorLockStale,
  type EditorLock,
  type EditorLockActor,
  type EditorLockClient,
  type EditorLockRequest,
} from "../lib/editor-locks";

type Presence =
  | { status: "disabled" }
  | { status: "checking" }
  | { status: "ready"; lock: EditorLock | null }
  | { status: "error" };

const STALE_CLAIM_RETRY_MS = 1_000;

interface UseEditorLockOptions {
  actor?: EditorLockActor;
  canTakeOver: boolean;
  client?: EditorLockClient;
  // Whether the loaded document can actually be changed by this person. The lease actor only
  // proves a site-wide content-write floor; a record's own lifecycle decision can still refuse
  // the save (a contributor reading back their submitted or published piece). Reserving there
  // would hold a record against an editor who can genuinely work on it, so an automatic claim
  // waits for this. An explicit takeover is unaffected: it is a deliberate act.
  mutable: boolean;
  surfaceKey: string | null;
}

export function useEditorLock({
  actor,
  canTakeOver,
  client,
  mutable,
  surfaceKey,
}: UseEditorLockOptions) {
  const actorId = actor?.id;
  const [restoredVisit, setRestoredVisit] = useState(0);
  const pageHidden = useRef(false);
  // A session identifies one mounted visit to one persisted surface, not the whole browser tab.
  // Returning to a surface therefore gets a fresh generation token: a delayed release from the
  // earlier visit cannot match and clear the newer reservation in Firestore.
  const sessionId = useMemo(
    () => globalThis.crypto.randomUUID(),
    [actorId, client, restoredVisit, surfaceKey],
  );
  const actorNameRef = useRef(actor?.name);
  actorNameRef.current = actor?.name;
  // Lease identity is owner id plus this surface visit's session id. Keep the subscription keyed
  // only to those values so a display-name/profile refresh cannot release a dirty editor; claims
  // still read the latest display name through actorNameRef when they write a new lease.
  const [presence, setPresence] = useState<Presence>({ status: "disabled" });
  const [claiming, setClaiming] = useState(false);
  // A stale claim can reach Firestore just before the server's authoritative expiry boundary.
  // Preserve the elapsed observation age, but pause before retrying so the denial cannot create
  // a tight transaction loop or reset the abandoned lease for another full window.
  const [retryingStaleClaim, setRetryingStaleClaim] = useState(false);
  // A deliberate hand-off releases the lease this tab holds. Treat that lease as unavailable
  // while the transaction is in flight: the subscription may still show this session as owner,
  // but enabling Save in that window would let the late release drop a lease underneath work.
  const [releasing, setReleasing] = useState(false);
  const [yielded, setYielded] = useState(false);
  // Set once another session takes a lease this tab was holding. The workspace uses it to keep
  // the displaced draft and offer recovery; it clears only when this tab owns the lease again.
  const [displacedBy, setDisplacedBy] = useState<string | null>(null);
  const [observationNowMs, setObservationNowMs] = useState(editorLockObservationNow);
  const ownership = useRef<{ surfaceKey: string; actorId: string; sessionId: string } | null>(
    null,
  );
  const generation = useRef(0);
  // The context currently mounted in this hook. A superseded claim may finish after navigation;
  // it may release its result only when this tab has not since returned to the same surface with
  // the same lease identity. Cleanup clears the context so an unmounted hook still releases.
  const activeLeaseContext = useRef<{
    actorId: string;
    client: EditorLockClient;
    generation: number;
    sessionId: string;
    surfaceKey: string;
  } | null>(null);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setClaiming(false);
    setRetryingStaleClaim(false);
    setReleasing(false);
    setYielded(false);
    setDisplacedBy(null);
    if (!client || actorId === undefined || !surfaceKey) {
      setPresence({ status: "disabled" });
      return;
    }
    activeLeaseContext.current = {
      actorId,
      client,
      generation: currentGeneration,
      sessionId,
      surfaceKey,
    };
    setPresence({ status: "checking" });
    const unsubscribe = client.subscribe(
      surfaceKey,
      (lock) => {
        if (generation.current !== currentGeneration) return;
        if (lock && lock.ownerId === actorId && lock.sessionId === sessionId) {
          ownership.current = { surfaceKey, actorId, sessionId };
          setDisplacedBy(null);
        } else if (ownership.current?.surfaceKey === surfaceKey) {
          // This tab held the lease and a different session now does. Name who displaced it so
          // the editor can say so and keep the unsaved work reachable.
          ownership.current = null;
          if (lock) setDisplacedBy(lock.ownerName);
        }
        setPresence({ status: "ready", lock });
      },
      () => {
        if (generation.current === currentGeneration) setPresence({ status: "error" });
      },
    );
    return () => {
      if (activeLeaseContext.current?.generation === currentGeneration) {
        activeLeaseContext.current = null;
      }
      unsubscribe();
      const held = ownership.current;
      if (held?.surfaceKey === surfaceKey) {
        ownership.current = null;
        void client.release(held.surfaceKey, held.actorId, held.sessionId).catch(() => {});
      }
    };
  }, [actorId, client, sessionId, surfaceKey]);

  useEffect(() => {
    if (!client || actorId === undefined || !surfaceKey) return;
    let disposed = false;
    let exitRelease: (() => void) | undefined;
    const prepare = () => {
      if (!client.prepareExitRelease || pageHidden.current) return;
      void client.prepareExitRelease(surfaceKey, actorId, sessionId).then((release) => {
        if (!disposed) exitRelease = release;
      }).catch(() => {});
    };
    prepare();
    // getIdToken refreshes expiring tokens while the page is active, never during unload.
    const tokenTimer = globalThis.setInterval(prepare, 60_000);
    const onPageHide = () => {
      if (pageHidden.current) return;
      pageHidden.current = true;
      ++generation.current;
      activeLeaseContext.current = null;
      const held = ownership.current;
      ownership.current = null;
      if (held?.surfaceKey !== surfaceKey || held.sessionId !== sessionId) return;
      if (exitRelease) exitRelease();
      else void client.release(surfaceKey, actorId, sessionId).catch(() => {});
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      pageHidden.current = false;
      // BFCache preserves the draft and hook. Rotate its lease identity so a delayed exit
      // request cannot clear the lease acquired when this document returns.
      setRestoredVisit((visit) => visit + 1);
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      disposed = true;
      globalThis.clearInterval(tokenTimer);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [actorId, client, sessionId, surfaceKey]);

  const lock = presence.status === "ready" ? presence.lock : null;
  const subscribedOwnsLock =
    lock !== null &&
    actorId !== undefined &&
    lock.ownerId === actorId &&
    lock.sessionId === sessionId;
  const ownsLock = subscribedOwnsLock && !releasing;
  // One refused wall-clock attempt per heartbeat value. A workstation whose clock runs fast will
  // therefore cost one denied transaction per remote heartbeat instead of a retry loop, and the
  // elapsed-observation test still reaches the same conclusion on its own timetable.
  const refusedAbandonedHeartbeat = useRef<number | null>(null);
  const stale =
    lock !== null &&
    !subscribedOwnsLock &&
    (isEditorLockStale(lock, observationNowMs) ||
      (isEditorLockAbandoned(lock) &&
        refusedAbandonedHeartbeat.current !== lock.heartbeatAtMs));
  const blockingLock = lock !== null && !subscribedOwnsLock && !stale ? lock : null;

  useEffect(() => {
    if (!lock || subscribedOwnsLock) return;
    const timer = globalThis.setInterval(
      () => setObservationNowMs(editorLockObservationNow()),
      5_000,
    );
    return () => globalThis.clearInterval(timer);
  }, [lock, subscribedOwnsLock]);

  const claim = useCallback(
    async (
      force = false,
      observedStale = false,
      observedLock?: EditorLock,
    ): Promise<boolean> => {
      const actorName = actorNameRef.current;
      if (
        pageHidden.current || !client || actorId === undefined ||
        actorName === undefined || !surfaceKey || claiming
      ) {
        return false;
      }
      const currentGeneration = generation.current;
      setClaiming(true);
      try {
        const result = await client.claim(surfaceKey, { id: actorId, name: actorName }, sessionId, {
          force,
          ...(observedStale ? { observedStale: true } : {}),
          ...(observedStale && observedLock ? { observedLock } : {}),
        });
        const active = activeLeaseContext.current;
        const claimIsStillActive =
          generation.current === currentGeneration &&
          active?.actorId === actorId &&
          active.client === client &&
          active.generation === currentGeneration &&
          active.sessionId === sessionId &&
          active.surfaceKey === surfaceKey;
        if (!claimIsStillActive) {
          const sameActiveLease =
            active?.actorId === actorId &&
            active.client === client &&
            active.sessionId === sessionId &&
            active.surfaceKey === surfaceKey;
          if (result.status === "acquired" && !sameActiveLease) {
            await client.release(surfaceKey, actorId, sessionId).catch(() => {});
          }
          return false;
        }
        if (result.status === "acquired") {
          ownership.current = { surfaceKey, actorId, sessionId };
          setDisplacedBy(null);
          setYielded(false);
        }
        if (
          result.status === "blocked" &&
          observedStale &&
          observedLock &&
          result.lock.surfaceKey === observedLock.surfaceKey &&
          result.lock.ownerId === observedLock.ownerId &&
          result.lock.sessionId === observedLock.sessionId &&
          result.lock.acquiredAtMs === observedLock.acquiredAtMs &&
          result.lock.heartbeatAtMs === observedLock.heartbeatAtMs &&
          result.lock.observedAtMs === observedLock.observedAtMs
        ) {
          setRetryingStaleClaim(true);
        }
        if (result.status === "blocked" && observedStale) {
          refusedAbandonedHeartbeat.current = result.lock.heartbeatAtMs;
        }
        setPresence({ status: "ready", lock: result.lock });
        return result.status === "acquired";
      } catch {
        const active = activeLeaseContext.current;
        const claimIsStillActive =
          generation.current === currentGeneration &&
          active?.generation === currentGeneration;
        if (claimIsStillActive) {
          setPresence({ status: "error" });
          // Presence is advisory and deliberately fails open. The version-conflict boundary still
          // protects this save when Firestore presence itself is unavailable.
          return true;
        }
        return false;
      } finally {
        if (
          generation.current === currentGeneration &&
          activeLeaseContext.current?.generation === currentGeneration
        ) {
          setClaiming(false);
        }
      }
    },
    [actorId, claiming, client, sessionId, surfaceKey],
  );

  useEffect(() => {
    if (!retryingStaleClaim) return;
    const timer = globalThis.setTimeout(() => {
      setObservationNowMs(editorLockObservationNow());
      setRetryingStaleClaim(false);
    }, STALE_CLAIM_RETRY_MS);
    return () => globalThis.clearTimeout(timer);
  }, [retryingStaleClaim]);

  // Opening an editable record reserves it, rather than waiting for the first keystroke. Before
  // this, a second editor could sit on the same untouched record and see no presence at all, and
  // a lease that only existed while the editor was dirty vanished the moment a save settled
  // (#1047). The lease is held for the whole visit and released on the way out.
  useEffect(() => {
    if (
      !mutable ||
      claiming ||
      releasing ||
      retryingStaleClaim ||
      yielded ||
      presence.status !== "ready" ||
      ownsLock ||
      blockingLock
    ) {
      return;
    }
    void claim(false, stale, stale ? lock ?? undefined : undefined);
  }, [
    blockingLock,
    claim,
    claiming,
    lock,
    mutable,
    ownsLock,
    presence.status,
    releasing,
    retryingStaleClaim,
    stale,
    yielded,
  ]);

  // The lease is renewed for as long as this tab holds it, so a person reading or thinking on an
  // open record keeps it reserved. Losing the renewal — a closed tab, a crash, an offline
  // browser — lets the lease age out on its own after EDITOR_LOCK_LEASE_MS.
  useEffect(() => {
    if (!ownsLock || !client || actorId === undefined || !surfaceKey) return;
    const heartbeatGeneration = generation.current;
    const timer = globalThis.setInterval(() => {
      if (pageHidden.current) return;
      void client.heartbeat(surfaceKey, actorId, sessionId).then((retained) => {
        if (generation.current !== heartbeatGeneration) return;
        if (!retained && ownership.current?.surfaceKey === surfaceKey) {
          ownership.current = null;
          // The transaction has authoritatively said this exact session no longer owns the
          // document. Do not leave Save enabled from a lagging snapshot; clear only this tab's
          // stale local lease and let the claim effect recover or surface the new owner.
          setPresence((current) =>
            current.status === "ready" &&
            current.lock?.ownerId === actorId &&
            current.lock.sessionId === sessionId
              ? { status: "ready", lock: null }
              : current,
          );
        }
      }).catch(() => {
        // The live subscription is authoritative. A transient heartbeat failure leaves the
        // lease to expire and the optimistic version guard still protects every save.
      });
    }, EDITOR_LOCK_HEARTBEAT_MS);
    return () => globalThis.clearInterval(timer);
  }, [actorId, client, ownsLock, sessionId, surfaceKey]);

  const takeoverAllowed = Boolean(
    blockingLock && actorId !== undefined && (blockingLock.ownerId === actorId || canTakeOver),
  );

  // An ask recorded against the lease this tab holds, from somebody else.
  const incomingRequest: EditorLockRequest | null =
    ownsLock && lock?.request && lock.request.byId !== actorId ? lock.request : null;
  // This tab's own ask, still attached to the holder's lease.
  const outgoingRequestPending = Boolean(
    blockingLock && actorId !== undefined && blockingLock.request?.byId === actorId,
  );
  // Somebody else is already waiting. The lease carries one ask, so a later asker joins no queue
  // and must not silently replace the person ahead of them.
  const requestedByOther: EditorLockRequest | null =
    blockingLock && blockingLock.request && blockingLock.request.byId !== actorId
      ? blockingLock.request
      : null;

  const requestTakeover = useCallback(async (): Promise<boolean> => {
    const actorName = actorNameRef.current;
    if (
      !client ||
      actorId === undefined ||
      actorName === undefined ||
      !surfaceKey ||
      !blockingLock ||
      (blockingLock.request !== undefined && blockingLock.request.byId !== actorId)
    ) {
      return false;
    }
    try {
      return await client.requestTakeover(
        surfaceKey,
        { id: actorId, name: actorName },
        blockingLock.sessionId,
      );
    } catch {
      return false;
    }
  }, [actorId, blockingLock, client, surfaceKey]);

  const dismissRequest = useCallback(async (): Promise<void> => {
    if (!client || actorId === undefined || !surfaceKey || !ownsLock) return;
    await client.clearRequest(surfaceKey, actorId, sessionId).catch(() => {});
  }, [actorId, client, ownsLock, sessionId, surfaceKey]);

  // Hand the record to whoever asked. The lease is released rather than transferred, so the
  // waiting editor's own claim-on-open takes it under the same rules as any other claim.
  const yieldEditor = useCallback(async (): Promise<boolean> => {
    if (!client || actorId === undefined || !surfaceKey || !ownsLock) return false;
    const currentGeneration = generation.current;
    ownership.current = null;
    setYielded(true);
    setReleasing(true);
    try {
      await client.release(surfaceKey, actorId, sessionId);
      if (generation.current !== currentGeneration) return true;
      setPresence((current) =>
        current.status === "ready" &&
        current.lock?.ownerId === actorId &&
        current.lock.sessionId === sessionId
          ? { status: "ready", lock: null }
          : current,
      );
      return true;
    } catch {
      if (generation.current !== currentGeneration) return false;
      // A failed release leaves the subscribed lease authoritative and this tab still holding it.
      ownership.current = { surfaceKey, actorId, sessionId };
      setYielded(false);
      return false;
    } finally {
      if (generation.current === currentGeneration) setReleasing(false);
    }
  }, [actorId, client, ownsLock, sessionId, surfaceKey]);

  // A yielded tab stops competing for the lease until the person asks for it back.
  const reclaim = useCallback(async (): Promise<boolean> => {
    setYielded(false);
    return claim(false);
  }, [claim]);

  const reserveForSave = useCallback(async (): Promise<boolean> => {
    if (pageHidden.current) return false;
    if (ownsLock || presence.status === "error") return true;
    if (
      presence.status !== "ready" ||
      blockingLock ||
      claiming ||
      releasing ||
      retryingStaleClaim ||
      // A tab that handed the record over must not take it back through the side door. Save,
      // lifecycle, history and assignment actions all reserve before they write, and doing so
      // here would reclaim the record from the person it was just given to. Only the explicit
      // "Take the record back" restores eligibility.
      yielded
    ) {
      return false;
    }
    return claim(false, stale, stale ? lock ?? undefined : undefined);
  }, [
    blockingLock,
    claim,
    claiming,
    lock,
    ownsLock,
    presence.status,
    releasing,
    retryingStaleClaim,
    stale,
    yielded,
  ]);

  return useMemo(
    () => ({
      blockingLock,
      canTakeOver: takeoverAllowed,
      checking: presence.status === "checking",
      claiming: claiming || retryingStaleClaim,
      // This tab held the lease and another session now does. Its unsaved work is still local.
      displacedBy: blockingLock ? displacedBy : null,
      dismissRequest,
      incomingRequest,
      lockUnavailable: presence.status === "error",
      outgoingRequestPending,
      ownsLock,
      ready: presence.status === "ready",
      reclaim,
      requestTakeover,
      requestedByOther,
      reserveForSave,
      retryingStaleClaim,
      staleLock: stale ? lock : null,
      takeOver: () => claim(true),
      yieldEditor,
      yielded,
    }),
    [
      blockingLock,
      claim,
      claiming,
      dismissRequest,
      displacedBy,
      incomingRequest,
      lock,
      outgoingRequestPending,
      ownsLock,
      presence.status,
      reclaim,
      requestTakeover,
      requestedByOther,
      reserveForSave,
      retryingStaleClaim,
      stale,
      takeoverAllowed,
      yieldEditor,
      yielded,
    ],
  );
}
