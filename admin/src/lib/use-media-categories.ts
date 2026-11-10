import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import type { AuthState } from "../context/authReducer";
import {
  cmsListMediaCategories,
  type MediaCategoryDefinition,
} from "./functions";
import { subscribeMediaCacheIdentity } from "./media-session-cache";

export type MediaCategoryRegistryState =
  | { status: "loading"; categories: [] }
  | { status: "error"; categories: [] }
  | { status: "ready"; categories: MediaCategoryDefinition[] };

/** A signed-in mount reuses a copy this new. An older copy is read again. */
export const CATEGORY_REGISTRY_MAX_AGE_MS = 60_000;

let generation = 0;
let cacheKey: string | null = null;
let cachedCategories: MediaCategoryDefinition[] | null = null;
let cachedAt = 0;
let inFlightKey: string | null = null;
let inFlight: Promise<MediaCategoryDefinition[]> | null = null;

export function resetMediaCategoryRegistry() {
  generation += 1;
  cacheKey = null;
  cachedCategories = null;
  cachedAt = 0;
  inFlightKey = null;
  inFlight = null;
}

// Account and role changes drop the list. A refreshed ID token does not: the
// registry is caller-specific, and the token is only the credential for a miss.
// Subscribe on first load, not at import: an import-time call can run before the
// shared session cache module has initialized when the bundler splits them into
// chunks that import each other, which left Boardwalk blank.
let identitySubscribed = false;
function subscribeIdentityOnce() {
  if (identitySubscribed) return;
  identitySubscribed = true;
  subscribeMediaCacheIdentity(resetMediaCategoryRegistry);
}

export function mediaCategoryIdentity(state: AuthState | null | undefined): string | null {
  if (!state || state.status !== "signed-in") return null;
  return JSON.stringify([state.user.uid, state.principal]);
}

function accountKey(identity: string): string {
  return `account:${identity}`;
}

function readCache(key: string): { categories: MediaCategoryDefinition[]; fresh: boolean } | null {
  if (cacheKey !== key || !cachedCategories) return null;
  return {
    categories: cachedCategories,
    fresh: Date.now() - cachedAt < CATEGORY_REGISTRY_MAX_AGE_MS,
  };
}

function readyOrLoading(key: string | null): MediaCategoryRegistryState {
  const hit = key ? readCache(key) : null;
  return hit
    ? { status: "ready", categories: hit.categories }
    : { status: "loading", categories: [] };
}

function loadMediaCategoryRegistry(token: string, key: string) {
  subscribeIdentityOnce();
  const hit = readCache(key);
  if (hit?.fresh) return Promise.resolve(hit.categories);
  if (inFlight && inFlightKey === key) return inFlight;
  const requestGeneration = generation;
  inFlightKey = key;
  inFlight = cmsListMediaCategories(token)
    .then((response) => {
      if (requestGeneration !== generation || inFlightKey !== key) {
        return response.categories;
      }
      cacheKey = key;
      cachedCategories = response.categories;
      cachedAt = Date.now();
      return response.categories;
    })
    .finally(() => {
      if (requestGeneration === generation && inFlightKey === key) {
        inFlight = null;
        inFlightKey = null;
      }
    });
  return inFlight;
}

export function useMediaCategories(enabled = true): {
  state: MediaCategoryRegistryState;
  reload: () => void;
} {
  const { getIdToken, state } = useAuth();
  const identity = mediaCategoryIdentity(state);
  const key = identity ? accountKey(identity) : null;
  const [attempt, setAttempt] = useState(0);
  const [trackedIdentity, setTrackedIdentity] = useState(identity);
  const [registry, setRegistry] = useState<MediaCategoryRegistryState>(() => readyOrLoading(key));

  if (identity !== trackedIdentity) {
    setTrackedIdentity(identity);
    setRegistry(readyOrLoading(key));
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    if (key) {
      const hit = readCache(key);
      if (hit?.fresh) {
        setRegistry({ status: "ready", categories: hit.categories });
        return;
      }
      if (hit) setRegistry({ status: "ready", categories: hit.categories });
    }
    if (!key || !readCache(key)) setRegistry({ status: "loading", categories: [] });
    getIdToken()
      .then((token) => {
        if (cancelled) return undefined;
        const requestKey = key ?? token;
        if (cacheKey !== requestKey) {
          setRegistry({ status: "loading", categories: [] });
        }
        return loadMediaCategoryRegistry(token, requestKey);
      })
      .then((categories) => {
        if (!cancelled && categories) {
          setRegistry({ status: "ready", categories });
        }
      })
      .catch(() => {
        if (cancelled) return;
        const current = key ? readCache(key) : null;
        setRegistry(current
          ? { status: "ready", categories: current.categories }
          : { status: "error", categories: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, enabled, getIdToken, identity, key]);

  const reload = useCallback(() => {
    resetMediaCategoryRegistry();
    setAttempt((value) => value + 1);
  }, []);
  return { state: registry, reload };
}

export function mediaCategoryLabel(
  categories: readonly MediaCategoryDefinition[],
  id: string,
): string {
  return categories.find((category) => category.id === id)?.label ?? seededCategoryText(id)?.label ?? id;
}

// Presentation fallback for pickers without a registry prop. These two descriptions
// are the existing seed text in functions/lib/media-categories.js, not an access list.
function seededCategoryText(id: string): { label: string; description: string } | undefined {
  if (id === "general") return {
    label: "General",
    description: "Station-wide media without a more specific editorial category.",
  };
  if (id === "staff-profile") return {
    label: "Staff profiles",
    description: "Portraits attached to NJ PBS staff and author profiles.",
  };
  return undefined;
}

export function mediaCategoryDescription(
  categories: readonly MediaCategoryDefinition[],
  id: string,
): string | undefined {
  return categories.find((category) => category.id === id)?.description ?? seededCategoryText(id)?.description;
}
