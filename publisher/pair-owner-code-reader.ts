import { jsonResponse } from "./pending-work";

export type PairCodeSnapshotRead = (path: string) => Promise<Record<string, unknown> | null>;
/** Server-created read-only transaction. No transaction identifier, token or
 * document value is returned to the private request or written to a log. */
export function pairOwnerCodeSnapshotReader({ projectId, token, decode, request = fetch }: {
  projectId: string; token: string; decode(value: unknown): Record<string, unknown>; request?: typeof fetch;
}) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(projectId)) throw new Error("Invalid private CODE project");
  const resource = `projects/${projectId}/databases/(default)/documents`, base = `https://firestore.googleapis.com/v1/${resource}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return async function readCodeTransaction<T>(run: (read: PairCodeSnapshotRead) => Promise<T>): Promise<T> {
    const signal = AbortSignal.timeout(3_000);
    const opened = await jsonResponse(await request(`${base}:beginTransaction`, { method: "POST", headers,
      redirect: "error", signal, body: JSON.stringify({ options: { readOnly: {} } }) })) as Record<string, unknown> | null;
    if (!opened || typeof opened.transaction !== "string" || !/^[A-Za-z0-9+/]{1,2048}={0,2}$/.test(opened.transaction))
      throw new Error("Private CODE transaction is unavailable");
    const transaction = opened.transaction, cache = new Map<string, Promise<Record<string, unknown> | null>>();
    try {
      const read: PairCodeSnapshotRead = path => {
        if (typeof path !== "string" || !/^[A-Za-z0-9._:/-]+$/.test(path) || path.includes("..") ||
            path.startsWith("/") || path.split("/").length % 2 !== 0) throw new Error("Invalid private CODE document");
        const existing = cache.get(path); if (existing) return existing;
        if (cache.size >= 100) throw new Error("Private CODE transaction exceeds its read budget");
        const result = (async () => {
          signal.throwIfAborted();
          const name = `${resource}/${path}`;
          const response = await request(`${base}:batchGet`, { method: "POST", headers, redirect: "error", signal,
            body: JSON.stringify({ documents: [name], transaction, ...(path === "system/billing" ? { mask: { fieldPaths: ["disabled"] } } : {}) }) });
          const rows = await jsonResponse(response, 2 * 1024 * 1024);
          if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Private CODE batch differs");
          const document = rows[0];
          if (document?.missing === name && !document.found) return null;
          if (document?.found?.name !== name || document.missing) throw new Error("Private CODE document differs");
          return decode(document.found.fields ?? {});
        })();
        cache.set(path, result); return result;
      };
      const result = await run(read); signal.throwIfAborted(); return result;
    } finally {
      const closed = await request(`${base}:rollback`, { method: "POST", headers, redirect: "error",
        signal: AbortSignal.timeout(3_000), body: JSON.stringify({ transaction }) });
      await jsonResponse(closed);
    }
  };
}
