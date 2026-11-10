import work from "../../functions/lib/public-release-pair-work.js";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { PAIR_STORAGE_BATCH_PATH, PAIR_STORAGE_BATCH_LIMIT, PAIR_STORAGE_BATCH_BODY_LIMIT,
  pairStorageBatchMetadata, encodePairStorageBatchRequest, parsePairStorageBatchResult, readPairStorageBatchJson,
  type PairStorageBatchResult } from "../../packages/content-core/src/public-release-storage-batch";

type Stored = NonNullable<Awaited<ReturnType<PairViewStore["get"]>>>;
type Result = Stored | null | undefined;
type Job = { key: string; group: string; path: string; body?: Uint8Array<ArrayBuffer>; customMetadata?: Record<string, string>;
  resolve(value: Result): void; reject(error: unknown): void };
const unavailable = () => new work.PairExecutionError("storage-unavailable");
const mismatch = () => new work.PairExecutionError("byte-mismatch");
/** The fixed host is intercepted by this container's private Worker binding.
 * Only concurrent small operations share a request; authority is never cached. */
export function publicReleasePairRpcStore(): PairViewStore {
  const url = (key: string) => {
    if (!/^[A-Za-z0-9._:/-]+$/.test(key) || key.includes("..") || key.startsWith("/")) throw new Error("Invalid private storage key");
    return `http://pair-storage.internal/${key}`;
  };
  const request = async (key: string, options: RequestInit) => {
    try { return await fetch(url(key), { ...options, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
    catch { throw unavailable(); }
  };
  const getOne = async (key: string): Promise<Stored | null> => {
    const response = await request(key, {});
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
    const size = Number(response.headers.get("content-length"));
    let customMetadata: Record<string, string>;
    try { customMetadata = JSON.parse(response.headers.get("x-pair-metadata") ?? "null"); }
    catch { await response.body?.cancel().catch(() => {}); throw mismatch(); }
    if (!response.headers.has("content-length") || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || !customMetadata ||
        Object.values(customMetadata).some(value => typeof value !== "string")) {
      await response.body?.cancel().catch(() => {}); throw mismatch();
    }
    if (!response.body && size !== 0) throw mismatch();
    return { size, customMetadata, body: response.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }) };
  };
  const putOne = async (key: string, bytes: Uint8Array, customMetadata: Record<string, string>, conditional: string) => {
    const response = await request(key, { method: "PUT", body: bytes as BodyInit, headers: {
      "content-length": String(bytes.byteLength), "if-none-match": conditional, "x-pair-metadata": JSON.stringify(customMetadata) } });
    await response.body?.cancel().catch(() => {});
    if (![201, 412].includes(response.status)) throw unavailable();
  };
  let pending: Job[] = [], scheduled = false, held = 0, heldBytes = 0;
  const settle = async (job: Job, execute: () => Promise<Result>) => {
    let result: Result;
    try { result = await execute(); }
    catch (error) { held--; heldBytes -= job.body?.length ?? 0; job.reject(error); return; }
    held--; heldBytes -= job.body?.length ?? 0; job.resolve(result);
  };
  const single = (job: Job) => settle(job, async () => {
    if (job.body) { await putOne(job.key, job.body, job.customMetadata!, "*"); return; }
    return getOne(job.key);
  });
  const resultOf = async (job: Job, result: PairStorageBatchResult): Promise<Result> => {
    if (job.body) { if (![201, 412].includes(result.status)) throw unavailable(); return; }
    if (result.status === 404) return null;
    // An explicitly large body gets a fresh ordinary GET and its own guards.
    if (result.status === 413) return getOne(job.key);
    if (result.status !== 200) throw unavailable();
    return { size: result.size!, customMetadata: result.customMetadata!, body: new ReadableStream<Uint8Array>({
      start(controller) { if (result.body!.length) controller.enqueue(result.body!); controller.close(); },
    }) };
  };
  const batch = async (jobs: Job[]) => {
    if (jobs.length === 1) { await single(jobs[0]); return; }
    let results: PairStorageBatchResult[];
    try {
      const text = encodePairStorageBatchRequest(jobs, !!jobs[0].body);
      const response = await request(jobs[0].path, { method: "POST", body: text,
        headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).length) } });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw unavailable(); }
      let value: unknown;
      try { value = await readPairStorageBatchJson(response); } catch { throw unavailable(); }
      try { results = parsePairStorageBatchResult(value, jobs.map(job => job.key), !!jobs[0].body); }
      catch { throw mismatch(); }
    } catch (error) {
      for (const job of jobs) { held--; heldBytes -= job.body?.length ?? 0; job.reject(error); }
      return;
    }
    await Promise.all(jobs.map((job, index) => settle(job, () => resultOf(job, results[index]))));
  };
  const enqueue = (input: Omit<Job, "resolve" | "reject">): Promise<Result> => new Promise((resolve, reject) => {
    held++; heldBytes += input.body?.length ?? 0; pending.push({ ...input, resolve, reject });
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      const selected = pending; pending = []; scheduled = false;
      const groups = new Map<string, Job[]>();
      for (const job of selected) {
        let group = groups.get(job.group);
        if (!group) { group = []; groups.set(job.group, group); }
        // Duplicate keys stay on the original path, with independent streams.
        if (group.some(item => item.key === job.key)) { void single(job); continue; }
        group.push(job);
        if (group.length === PAIR_STORAGE_BATCH_LIMIT) { void batch(group); groups.set(job.group, []); }
      }
      for (const group of groups.values()) if (group.length) void batch(group);
    });
  });
  const scope = (key: string, write: boolean) => {
    const input = /^release-pair-inputs\/v2\/([^/]+)\/(?:objects|manifests)\/[a-f0-9]{64}\.json$/.exec(key);
    const view = /^release-pairs\/([^/]+)\/([a-f0-9]{64})\/claims\/([a-f0-9]{64})\/(?:objects\/[a-f0-9]{64}|(?:pages|views)\/[a-f0-9]{64}\.json)$/.exec(key);
    if (write) return view ? { group: JSON.stringify(["put", view[1], view[2], view[3]]),
      path: `${PAIR_STORAGE_BATCH_PATH.slice(1)}/put/${view[2]}/${view[3]}` } : null;
    const pair = input?.[1] ?? view?.[1];
    return pair ? { group: JSON.stringify(["get", pair]), path: `${PAIR_STORAGE_BATCH_PATH.slice(1)}/get` } : null;
  };
  return {
    async get(key) {
      url(key);
      const selected = scope(key, false);
      if (!selected || held >= 16) return getOne(key);
      return await enqueue({ key, ...selected }) as Stored | null;
    },
    async put(key, bytes, options) {
      url(key);
      const selected = scope(key, true);
      if (!selected || held >= 16 || bytes.length > PAIR_STORAGE_BATCH_BODY_LIMIT || heldBytes + bytes.length > 16 * 1024 * 1024 ||
          options.onlyIf.etagDoesNotMatch !== "*" || !pairStorageBatchMetadata(options.customMetadata))
        return putOne(key, bytes, options.customMetadata, options.onlyIf.etagDoesNotMatch);
      await enqueue({ key, ...selected, body: new Uint8Array(bytes), customMetadata: JSON.parse(JSON.stringify(options.customMetadata)) });
    },
  };
}
