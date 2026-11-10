"use strict";

const entries = new Map(), scopes = new WeakMap();
const MAX_ENTRIES = 2, MAX_BYTES = 32 * 1024 * 1024;
let nextScope = 0, retainedBytes = 0;
function drop(key) {
  const entry = entries.get(key);
  if (!entry) return;
  retainedBytes -= entry.bytes;
  entries.delete(key);
}
function settled() { return [...entries].find(([, value]) => value.settled)?.[0]; }
function freeze(value, depth = 0) {
  if (depth > 64) throw new Error("Code context exceeds the cache depth limit.");
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child, depth + 1);
    Object.freeze(value);
  }
  return value;
}

/** Only digest-verified immutable code is cached. Every caller qualifies its
 * fresh reference and local authority on both sides of this shared load. */
async function readCachedCodePostContext({ firestore, identity, load }) {
  if (!scopes.has(firestore)) scopes.set(firestore, ++nextScope);
  const key = `${scopes.get(firestore)}:${identity}`;
  let entry = entries.get(key);
  if (entry) { entries.delete(key); entries.set(key, entry); return entry.promise; }
  while (entries.size >= MAX_ENTRIES && settled() === undefined) {
    await Promise.race([...entries.values()].map(entry => entry.promise.then(() => {}, () => {})));
    entry = entries.get(key);
    if (entry) return entry.promise;
  }
  if (entries.size >= MAX_ENTRIES) drop(settled());
  entry = { bytes: 0, settled: false, promise: null };
  entry.promise = Promise.resolve().then(load).then(value => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_BYTES) { drop(key); return freeze(value); }
    while (retainedBytes + bytes > MAX_BYTES) drop(settled());
    entry.bytes = bytes; entry.settled = true; retainedBytes += bytes;
    return freeze(value);
  }).catch(error => { drop(key); throw error; });
  entries.set(key, entry);
  return entry.promise;
}
module.exports = { readCachedCodePostContext };
