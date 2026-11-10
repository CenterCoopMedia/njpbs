import { useEffect, useRef, useState } from "react";
import {
  listMediaFavoriteStates,
  setMediaFavorite,
  type MediaFavoriteRef,
} from "./media-favorites";

type FavoriteSeed = { states?: readonly { ref: MediaFavoriteRef; favorite: boolean }[] };

export function mediaFavoriteKey(ref: MediaFavoriteRef): string {
  return JSON.stringify(ref.backend === "r2"
    ? [ref.backend, ref.id]
    : [ref.backend, ref.sourceId, ref.id]);
}

function uniqueMediaFavoriteRefs(refs: readonly MediaFavoriteRef[]): MediaFavoriteRef[] {
  return [...new Map(refs.map(ref => [mediaFavoriteKey(ref), ref])).values()];
}

type FavoriteState = {
  context: string;
  values: Record<string, boolean>;
  loadError: string;
  saveError: string;
};

type PendingMutation = {
  id: symbol;
  userId: string;
};

// Each visible page shares one bounded lookup. Confirmed writes invalidate older reads, while
// ambiguous outcomes reload the current projection. A seed is the same projection returned with
// the list; it replaces the first lookup only when it covers exactly these refs, and only once.
// While awaitingSeed is set, a list load that returns a seed is in flight, so no lookup starts.
export function useMediaFavorites(
  userId: string,
  refs: readonly MediaFavoriteRef[],
  getIdToken: () => Promise<string | null>,
  seed?: FavoriteSeed,
  awaitingSeed?: { readonly current: boolean },
) {
  const requestedRefs = uniqueMediaFavoriteRefs(refs);
  const refsKey = JSON.stringify(requestedRefs);
  const context = JSON.stringify([userId, refsKey]);
  const contextRef = useRef({ context, userId });
  contextRef.current = { context, userId };
  const [attempt, setAttempt] = useState(0);
  const [mutationRevision, setMutationRevision] = useState(0);
  const [state, setState] = useState<FavoriteState>({
    context: "",
    values: {},
    loadError: "",
    saveError: "",
  });
  const generation = useRef(0);
  const pendingMutations = useRef(new Map<string, PendingMutation>());
  const usedSeeds = useRef(new WeakSet<FavoriteSeed>());
  const [, renderPending] = useState(0);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    setState(previous => ({
      context,
      values: previous.context === context ? previous.values : {},
      loadError: "",
      saveError: previous.context === context ? previous.saveError : "",
    }));
    const pageRefs = JSON.parse(refsKey) as MediaFavoriteRef[];
    if (!userId || pageRefs.length === 0) return;
    if (awaitingSeed?.current) return;
    const states = seed?.states;
    if (seed && states && !usedSeeds.current.has(seed) &&
        JSON.stringify(uniqueMediaFavoriteRefs(states.map(item => item.ref))) === refsKey) {
      usedSeeds.current.add(seed);
      setState(previous => ({
        context,
        values: Object.fromEntries(states.map(item => [mediaFavoriteKey(item.ref), item.favorite])),
        loadError: "",
        saveError: previous.context === context ? previous.saveError : "",
      }));
      return;
    }
    async function load() {
      try {
        const token = await getIdToken();
        if (
          generation.current !== currentGeneration ||
          contextRef.current.context !== context
        ) return;
        const result = await listMediaFavoriteStates(token, pageRefs);
        if (
          generation.current !== currentGeneration ||
          contextRef.current.context !== context
        ) return;
        setState(previous => ({
          context,
          values: Object.fromEntries(result.states.map(item => [
            mediaFavoriteKey(item.ref),
            item.favorite,
          ])),
          loadError: "",
          saveError: previous.context === context ? previous.saveError : "",
        }));
      } catch {
        if (
          generation.current === currentGeneration &&
          contextRef.current.context === context
        ) {
          setState(previous => ({
            context,
            values: previous.context === context ? previous.values : {},
            loadError: "Favorites could not be loaded.",
            saveError: previous.context === context ? previous.saveError : "",
          }));
        }
      }
    }
    void load();
    return () => { generation.current++; };
  }, [attempt, context, getIdToken, mutationRevision, refsKey, seed, userId]);

  const visible = state.context === context ? state : undefined;
  const operationKey = (ref: MediaFavoriteRef) => JSON.stringify([
    userId,
    mediaFavoriteKey(ref),
  ]);
  const hasPendingForCurrentUser = () => [...pendingMutations.current.values()]
    .some(mutation => mutation.userId === userId);

  async function setFavorite(ref: MediaFavoriteRef, favorite: boolean,
    options: { throwOnError?: boolean; canWrite?: () => boolean } = {}) {
    const key = mediaFavoriteKey(ref);
    const scopedKey = operationKey(ref);
    if (!userId || pendingMutations.current.has(scopedKey)) return;
    const mutation: PendingMutation = { id: Symbol(key), userId };
    pendingMutations.current.set(scopedKey, mutation);
    renderPending(value => value + 1);
    setState(previous => previous.context === context
      ? { ...previous, saveError: "" }
      : previous);
    let reconcile = false;
    try {
      const token = await getIdToken();
      if (
        contextRef.current.userId !== mutation.userId ||
        options.canWrite?.() === false ||
        pendingMutations.current.get(scopedKey)?.id !== mutation.id
      ) return;
      const result = await setMediaFavorite(token, ref, favorite);
      if (
        mediaFavoriteKey(result.ref) !== key ||
        result.favorite !== favorite
      ) throw new Error("Favorite response identity mismatch");
      if (
        contextRef.current.userId === mutation.userId &&
        pendingMutations.current.get(scopedKey)?.id === mutation.id
      ) {
        if (contextRef.current.context === context) {
          // A read that started before this confirmed write cannot replace it with an older
          // projection. Invalidating its generation keeps the authoritative mutation result.
          generation.current++;
          setState(previous => previous.context === context
            ? {
                ...previous,
                values: { ...previous.values, [key]: result.favorite },
                saveError: "",
              }
            : previous);
        } else {
          // The visible page changed while the write was pending. Refresh that page once so a
          // matching reference, if present there too, cannot keep its pre-write value.
          reconcile = true;
        }
      }
      return contextRef.current.userId === mutation.userId ? result : undefined;
    } catch (error) {
      reconcile = true;
      if (
        contextRef.current.userId === mutation.userId &&
        pendingMutations.current.get(scopedKey)?.id === mutation.id
      ) {
        setState(previous => previous.context === context
          ? { ...previous, saveError: "The favorite could not be saved. Try again." }
          : previous);
      }
      if (options.throwOnError) throw error;
    } finally {
      if (pendingMutations.current.get(scopedKey)?.id === mutation.id) {
        pendingMutations.current.delete(scopedKey);
        renderPending(value => value + 1);
      }
      if (reconcile && contextRef.current.userId === mutation.userId) {
        setMutationRevision(value => value + 1);
      }
    }
  }

  async function toggle(ref: MediaFavoriteRef) {
    const favorite = visible?.values[mediaFavoriteKey(ref)];
    if (favorite === undefined) return;
    return setFavorite(ref, !favorite);
  }

  return {
    value: (ref: MediaFavoriteRef) => visible?.values[mediaFavoriteKey(ref)],
    pending: (ref: MediaFavoriteRef) => pendingMutations.current.has(operationKey(ref)),
    loadError: visible?.loadError ?? "",
    saveError: visible?.saveError ?? "",
    retryDisabled: hasPendingForCurrentUser(),
    retry: () => {
      if (!hasPendingForCurrentUser()) setAttempt(value => value + 1);
    },
    // A batch can finish after the server saved some items and the request still failed,
    // and a single-item write must not swallow that reload.
    reconcile: () => setAttempt(value => value + 1),
    setFavorite,
    toggle,
  };
}
