import { isDeepStrictEqual } from "node:util";

// Offline boundary with atomic writes, read-before-write enforcement, ordered
// bounded pages, and deterministic optimistic retries. It is not an emulator.
export function fakeFirestore() {
  const rows = new Map();
  const queries = [];
  const hooks = { beforeCommit: null };
  let nextId = 0;
  const field = (row, path) => path.split(".").reduce((value, key) => value?.[key], row);
  const snapshot = (ref) => {
    const value = structuredClone(rows.get(ref.path));
    return { ref, id: ref.id, exists: rows.has(ref.path), data: () => structuredClone(value) };
  };
  const doc = (path) => ({ path, id: path.split("/").at(-1),
    collection: (name) => collection(`${path}/${name}`), get: async () => snapshot(doc(path)) });
  const collection = (path, filters = [], cap = Infinity, cursor = null, group = false) => ({
    path, filters, cap, cursor, group,
    doc: (id = `auto-${++nextId}`) => doc(`${path}/${id}`),
    where: (key, op, value) => {
      if (!["==", "array-contains"].includes(op)) throw new Error(`Unsupported fake operator ${op}`);
      return collection(path, [...filters, [key, op, value]], cap, cursor, group);
    },
    orderBy: () => collection(path, filters, cap, cursor, group),
    startAfter: (id) => collection(path, filters, cap, id, group),
    limit: (limit) => collection(path, filters, limit, cursor, group),
    get: async () => read(collection(path, filters, cap, cursor, group)),
  });
  function read(ref) {
    if (!ref.filters) return snapshot(ref);
    queries.push({ path: ref.path, cap: ref.cap });
    const docs = [...rows.keys()].sort().filter((path) =>
      (ref.group ? path.split("/").at(-2) === ref.path :
        path.startsWith(`${ref.path}/`) && path.split("/").length === ref.path.split("/").length + 1) &&
      (!ref.cursor || path.split("/").at(-1) > ref.cursor) &&
      ref.filters.every(([key, op, value]) => op === "array-contains"
        ? field(rows.get(path), key)?.includes(value) : field(rows.get(path), key) === value))
      .slice(0, ref.cap).map((path) => snapshot(doc(path)));
    return { docs, empty: !docs.length, size: docs.length };
  }
  const signature = (snapshot) => snapshot.docs
    ? snapshot.docs.map((document) => [document.ref.path, document.data()]) : snapshot.data();
  const firestore = { doc, collection,
    collectionGroup: (name) => collection(name, [], Infinity, null, true),
    async runTransaction(fn) {
    for (let retry = 0; retry < 5; retry++) {
      const reads = [];
      const writes = [];
      const result = await fn({
        async get(ref) {
          if (writes.length) throw new Error("Read after write");
          const value = read(ref);
          reads.push([ref, signature(value)]);
          return value;
        },
        set: (ref, value) => writes.push({ kind: "set", ref, value }),
        update: (ref, value) => writes.push({ kind: "update", ref, value }),
        create: (ref, value) => writes.push({ kind: "create", ref, value }),
        delete: (ref) => writes.push({ kind: "delete", ref }),
      });
      await hooks.beforeCommit?.(writes);
      if (reads.some(([ref, old]) => !isDeepStrictEqual(signature(read(ref)), old))) continue;
      const next = new Map(rows);
      for (const { kind, ref, value } of writes) {
        if (kind === "delete") next.delete(ref.path);
        else {
          if (kind === "create" && next.has(ref.path)) throw new Error("Already exists");
          if (kind === "update" && !next.has(ref.path)) throw new Error("Missing update");
          next.set(ref.path, structuredClone(kind === "update" ? { ...next.get(ref.path), ...value } : value));
        }
      }
      rows.clear();
      for (const [path, value] of next) rows.set(path, value);
      return result;
    }
    throw new Error("Transaction contention");
  } };
  return { firestore, rows, hooks, queries };
}
