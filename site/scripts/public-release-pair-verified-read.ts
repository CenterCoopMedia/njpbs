import type { PairViewStore } from "./public-release-pair-view-storage";

const MAX_BYTES = 8 * 1024 * 1024, MAX_BODY_BYTES = 1024 * 1024, MAX_ENTRIES = 128;
type Entry = { key: string; size: number; bytes: Promise<Uint8Array> };
type Scope = { entries: Map<string, Entry>; bytes: number; revision: number; active: boolean };
const scopes = new WeakMap<PairViewStore, Scope>();

/** A single executor/staging invocation owns this scope. Authority is never
 * cached; only bytes that an existing codec has fully verified may enter it. */
export async function withPublicReleasePairVerifiedReads<T>(store: PairViewStore, run: (store: PairViewStore) => Promise<T>): Promise<T> {
  const scope: Scope = { entries: new Map(), bytes: 0, revision: 0, active: true };
  const invalidate = (key: string) => {
    scope.revision++;
    for (const [id, entry] of scope.entries) if (entry.key === key) {
      scope.entries.delete(id); scope.bytes -= entry.size;
    }
  };
  const scoped: PairViewStore = {
    get: key => store.get(key),
    async put(key, bytes, options) {
      invalidate(key);
      try { return await store.put(key, bytes, options); }
      finally { invalidate(key); }
    },
  };
  scopes.set(scoped, scope);
  try { return await run(scoped); }
  finally { scope.active = false; scope.entries.clear(); scope.bytes = 0; scopes.delete(scoped); }
}

/** read() retains its original metadata/size/hash checks and error owner.
 * Each caller receives a copy. Raw stores and oversized/full scopes stay fresh.
 * G output bodies always remain fresh for the complete staged byte pass. */
export async function readPublicReleasePairVerifiedBytes(store: PairViewStore, key: string, size: number,
  expected: Record<string, string>, signal: AbortSignal | undefined, read: () => Promise<Uint8Array>) {
  signal?.throwIfAborted();
  const scope = scopes.get(store);
  if (!scope || !scope.active || size < 0 || size > MAX_BODY_BYTES ||
      !(key.startsWith("release-pair-inputs/v2/") || /\/(?:views|pages|metadata)\/[a-f0-9]{64}\.json$/.test(key))) return read();
  const id = JSON.stringify([key, size, Object.entries(expected).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
  let entry = scope.entries.get(id);
  if (!entry) {
    if (scope.entries.size === MAX_ENTRIES || scope.bytes + size > MAX_BYTES) return read();
    const revision = scope.revision;
    entry = { key, size, bytes: Promise.resolve().then(read).then(bytes => new Uint8Array(bytes)) };
    scope.entries.set(id, entry); scope.bytes += size;
    const selected = entry;
    void entry.bytes.then(() => {
      if (scope.revision !== revision && scope.entries.get(id) === selected) {
        scope.entries.delete(id); scope.bytes -= size;
      }
    }, () => {
      if (scope.entries.get(id) === selected) { scope.entries.delete(id); scope.bytes -= size; }
    });
  }
  const bytes = await entry.bytes;
  signal?.throwIfAborted();
  return new Uint8Array(bytes);
}
