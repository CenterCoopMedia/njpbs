// Persistence for the editor bento layout. A layout is an ergonomic per-browser preference, so it
// lives in localStorage rather than the user's Firestore profile: it never needs to travel between
// devices to be useful, and a storage outage must never break editing. Every path fails safe to the
// reconciled default and swallows write errors. The store is injectable so components take the
// shared localStorage-backed instance in the app and a deterministic memory instance in tests.

import {
  defaultBentoLayout,
  parseBentoLayout,
  reconcileBentoLayout,
  serializeBentoLayout,
  type BentoLayout,
  type BentoPanelDef,
  type BentoPanelState,
} from "./editor-bento-layout";

export interface BentoLayoutStore {
  // Read the saved layout for `key`, reconciled against the current `defs` so a changed panel set
  // never strands the persisted arrangement. Always returns a usable layout.
  load(key: string, defs: readonly BentoPanelDef[]): BentoPanelState[];
  save(key: string, layout: BentoLayout): void;
  // Remove a saved preference and return the declared default so the mounted editor and storage
  // reset in one operation.
  reset(key: string, defs: readonly BentoPanelDef[]): BentoPanelState[];
}

// Version the preference key when the declared task flow changes. This release starts every
// browser from the same reviewed section order instead of inheriting an older free-form layout.
const STORAGE_PREFIX = "njpbs.admin.editor-bento.v2.";

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

// A localStorage-backed store. Pass a Storage explicitly (tests, or a non-default store); otherwise
// it resolves the ambient localStorage, tolerating environments that have none.
export function createLocalBentoStore(storage?: Storage): BentoLayoutStore {
  const resolve = (): Storage | null => {
    if (storage) return storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      // Accessing localStorage can itself throw (sandboxed frames, disabled storage).
      return null;
    }
  };

  return {
    load(key, defs) {
      const store = resolve();
      if (!store) return defaultBentoLayout(defs);
      try {
        const raw = store.getItem(storageKey(key));
        if (raw === null) return defaultBentoLayout(defs);
        return reconcileBentoLayout(parseBentoLayout(raw) ?? [], defs);
      } catch {
        return defaultBentoLayout(defs);
      }
    },
    save(key, layout) {
      const store = resolve();
      if (!store) return;
      try {
        store.setItem(storageKey(key), serializeBentoLayout(layout));
      } catch {
        // A full or unavailable quota must not interrupt editing; the layout simply is not saved.
      }
    },
    reset(key, defs) {
      const next = defaultBentoLayout(defs);
      const store = resolve();
      if (!store) return next;
      try {
        store.removeItem(storageKey(key));
      } catch {
        // An unavailable store must not prevent the live editor from returning to its default.
      }
      return next;
    },
  };
}

export interface MemoryBentoStore extends BentoLayoutStore {
  snapshot(): Record<string, BentoPanelState[]>;
}

// A deterministic in-memory store for tests: no Storage, no reconciliation surprises, and a
// snapshot() to assert what was persisted.
export function createMemoryBentoStore(
  initial?: Record<string, BentoPanelState[]>,
): MemoryBentoStore {
  const map = new Map<string, BentoPanelState[]>(
    Object.entries(initial ?? {}).map(([key, value]) => [key, value.map((p) => ({ ...p }))]),
  );
  return {
    load(key, defs) {
      return reconcileBentoLayout(map.get(key) ?? [], defs);
    },
    save(key, layout) {
      map.set(
        key,
        layout.map((panel) => ({ ...panel })),
      );
    },
    reset(key, defs) {
      map.delete(key);
      return defaultBentoLayout(defs);
    },
    snapshot() {
      return Object.fromEntries(
        [...map].map(([key, value]) => [key, value.map((panel) => ({ ...panel }))]),
      );
    },
  };
}
