import { createMeaningSearch } from "../../../packages/browser-search";

type MeaningSearch = ReturnType<typeof createMeaningSearch>;

// One local meaning index per search surface for this page session. Clearing the search
// field, changing a filter, or returning to the tab reuses its vectors instead of encoding
// the corpus again. Vectors stay in worker memory and never persist. A different key
// (account, source or scan) replaces the surface's index.
const indexes = new Map<string, { key: string; client: MeaningSearch }>();

export function sessionMeaningSearch(surface: string, key: string): MeaningSearch {
  const existing = indexes.get(surface);
  if (existing?.key === key) return existing.client;
  existing?.client.dispose();
  const client = createMeaningSearch();
  indexes.set(surface, { key, client });
  return client;
}

/** Drop one surface's index, or every index when the account signs out. */
export function disposeSessionMeaningSearch(surface?: string) {
  for (const [name, index] of indexes) {
    if (surface !== undefined && name !== surface) continue;
    index.client.dispose();
    indexes.delete(name);
  }
}
