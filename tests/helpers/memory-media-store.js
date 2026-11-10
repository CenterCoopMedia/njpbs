// Firestore boundary fake for focused media unit tests; no emulator or network.
export function memoryMediaStore() {
  const records = new Map();
  function doc(id) {
    const ref = {
      id,
      async get() {
        const value = records.get(id);
        return { id, ref, exists: value !== undefined, data: () => structuredClone(value) };
      },
      async set(value) { records.set(id, structuredClone(value)); },
      async update(patch) { records.set(id, { ...records.get(id), ...structuredClone(patch) }); },
    };
    return ref;
  }
  function query(cursor = null, count = 100) {
    return {
      doc,
      orderBy() { return this; },
      limit(value) { return query(cursor, value); },
      startAfter(value) { return query(value, count); },
      async get() {
        const ids = [...records.keys()].sort().filter((id) => cursor === null || id > cursor).slice(0, count);
        const docs = await Promise.all(ids.map((id) => doc(id).get()));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }
  return {
    collection: () => query(),
    async runTransaction(run) {
      const writes = [];
      const result = await run({
        get: (ref) => ref.get(),
        update: (ref, patch) => writes.push(() => ref.update(patch)),
      });
      for (const write of writes) await write();
      return result;
    },
  };
}
