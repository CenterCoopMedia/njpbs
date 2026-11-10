"use strict";

const MAX_ENTRIES = 4;
const MAX_BYTES = 64 * 1024 * 1024;
const entries = new Map();
const scopes = new WeakMap();
let nextScope = 0, retainedBytes = 0;

function drop(key) {
  const entry = entries.get(key);
  if (!entry) return;
  retainedBytes -= entry.bytes;
  entries.delete(key);
}
function oldestSettled() {
  return [...entries].find(([, entry]) => entry.settled)?.[0];
}
function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value.qualifiedCode)) + Buffer.byteLength(JSON.stringify(value.authority)) +
    Buffer.byteLength(JSON.stringify(value.packet.schedule)) +
    value.packet.json.length + value.packet.pdf.length;
}

/** Only immutable verified data is retained. Callers must qualify fresh
 * authority on both sides and seal their own original request deadline. */
async function readCachedPageSchedule({ firestore, identity, load }) {
  if (!scopes.has(firestore)) scopes.set(firestore, ++nextScope);
  const key = `${scopes.get(firestore)}:${identity}`;
  let entry = entries.get(key);
  if (entry) { entries.delete(key); entries.set(key, entry); return entry.promise; }
  // Wait on actual in-flight IO when every bounded slot is busy. No new
  // shared load or unbounded pending map is created; caller deadlines apply.
  while (entries.size >= MAX_ENTRIES && oldestSettled() === undefined) {
    await Promise.race([...entries.values()].map(value => value.promise.then(() => {}, () => {})));
    entry = entries.get(key);
    if (entry) return entry.promise;
  }
  if (entries.size >= MAX_ENTRIES) drop(oldestSettled());
  entry = { bytes: 0, settled: false, promise: null };
  entry.promise = Promise.resolve().then(load).then(value => {
    const bytes = byteSize(value);
    if (bytes > MAX_BYTES) { drop(key); return value; }
    while (retainedBytes + bytes > MAX_BYTES) drop(oldestSettled());
    entry.bytes = bytes; entry.settled = true; retainedBytes += bytes;
    return value;
  }).catch(error => { drop(key); throw error; });
  entries.set(key, entry);
  return entry.promise;
}

module.exports = { readCachedPageSchedule };
