import { beforeEach, expect, it, vi } from "vitest";
import { HttpError, postFunction } from "../src/lib/functions";
import { loadVideoSearchShards } from "../src/lib/video-search-shards";
import type { ShardCache, ShardStore, SearchShard } from "../src/lib/video-search-shard-cache";
vi.mock("../src/lib/functions", () => ({ postFunction: vi.fn(), HttpError: class extends Error { constructor(public status: number) { super("Request failed"); } } }));
const coverage = { assetsScanned: 1, assetsIndexed: 1, assetsWithoutTranscript: 0, assetsUnavailable: 0, truncatedAssets: 0 };
const shard = (id: string, version = "v1"): SearchShard => ({ id, version,
  asset: { id, sourceId: "video-library", name: id, tags: [] } as unknown as SearchShard["asset"],
  chunks: [], revision: null, coverage });
const manifest = (shards = [shard("a"), shard("b")], fields = {}) => ({ schema: 1, identity: "source-v1", usersView: false,
  shards: shards.map(({ id, version }) => ({ id, version, coverage })), tombstones: [], initializing: false, pending: 0, freshnessMs: 60_000, ...fields });
let records: Map<string, ShardCache>;
let store: ShardStore;
let emitted: SearchShard[];
const run = (fields = {}) => loadVideoSearchShards({ userId: "staff", sourceId: "video-library", signal: new AbortController().signal,
  getIdToken: async () => "token", store, onItem: item => { emitted.push(item); return true; }, ...fields });
beforeEach(() => {
  vi.clearAllMocks(); records = new Map(); emitted = [];
  store = { read: async key => structuredClone(records.get(key)), write: async (key, value) => { records.set(key, structuredClone(value)); }, remove: async key => { records.delete(key); } };
  vi.mocked(postFunction).mockImplementation(async (_name, _token, body: unknown) => {
    const request = body as { action: string; shards: { id: string; version: string }[] };
    return (request.action === "manifest" ? manifest() : { schema: 1, items: request.shards.map(item => shard(item.id, item.version)) }) as never;
  });
});
it("validates each new session and downloads only changed shards", async () => {
  await run(); expect(emitted.map(item => item.id)).toEqual(["a", "b"]); expect(postFunction).toHaveBeenCalledTimes(2);
  emitted = []; vi.mocked(postFunction).mockClear();
  await run(); expect(emitted.map(item => item.id)).toEqual(["a", "b"]); expect(postFunction).toHaveBeenCalledTimes(1);
  vi.mocked(postFunction).mockResolvedValueOnce(manifest([shard("a", "v2"), shard("b")]) as never);
  emitted = []; await run();
  expect(vi.mocked(postFunction).mock.lastCall?.[2]).toEqual({ sourceId: "video-library", action: "shards", shards: [{ id: "a", version: "v2" }] });
  expect(emitted.map(item => item.version)).toEqual(["v2", "v1"]);
});
it("does not release stored text before a successful authenticated manifest", async () => {
  await run(); emitted = [];
  let finish!: (value: unknown) => void;
  vi.mocked(postFunction).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
  const pending = run(); await Promise.resolve(); await Promise.resolve(); expect(emitted).toEqual([]);
  finish(manifest()); await pending; expect(emitted).toHaveLength(2);
});
it("removes explicit tombstones and omitted entries before emitting results", async () => {
  await run(); emitted = [];
  vi.mocked(postFunction).mockResolvedValueOnce(manifest([shard("a")], { tombstones: ["a"] }) as never);
  await run(); expect(emitted).toEqual([]); expect([...records.values()][0].shards).toEqual({});
});
it("clears private bytes and emits no text on denied or failed validation", async () => {
  for (const status of [401, 403, 404]) {
    await run(); emitted = [];
    vi.mocked(postFunction).mockRejectedValueOnce(new HttpError(status, "Denied"));
    await expect(run()).rejects.toBeInstanceOf(HttpError);
    expect(emitted).toEqual([]); expect(records.size).toBe(0);
  }
});
it("does not reuse bytes across users, source configuration or uploader permission", async () => {
  await run(); vi.mocked(postFunction).mockClear(); await run({ userId: "other" });
  expect(postFunction).toHaveBeenCalledTimes(2);
  for (const fields of [{ identity: "changed-source" }, { usersView: true }]) {
    vi.mocked(postFunction).mockClear(); vi.mocked(postFunction).mockResolvedValueOnce(manifest(undefined, fields) as never);
    await run(); expect(postFunction).toHaveBeenCalledTimes(2);
  }
});
it("does not emit an aborted response and uses the legacy scan during initialization", async () => {
  await run(); emitted = [];
  const controller = new AbortController();
  vi.mocked(postFunction).mockImplementationOnce(async () => { controller.abort(); return manifest() as never; });
  await expect(run({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" }); expect(emitted).toEqual([]);
  vi.mocked(postFunction).mockResolvedValueOnce(manifest([], { initializing: true }) as never);
  expect(await run()).toEqual({ supported: false, warming: true }); expect(records.size).toBe(0);
});
it("retains the browser cap when a shard response contains more results", async () => {
  expect(await run({ onItem: () => false })).toMatchObject({ capped: true });
});

it("supports valid video IDs that match JavaScript object properties", async () => {
  const values = [shard("__proto__"), shard("constructor")];
  vi.mocked(postFunction).mockResolvedValueOnce(manifest(values) as never);
  await run(); expect(emitted.map(item => item.id)).toEqual(["__proto__", "constructor"]);
  emitted = []; vi.mocked(postFunction).mockClear(); vi.mocked(postFunction).mockResolvedValueOnce(manifest(values) as never);
  await run(); expect(postFunction).toHaveBeenCalledTimes(1); expect(emitted.map(item => item.id)).toEqual(["__proto__", "constructor"]);
});

it("saves each downloaded batch and resumes after a local abort", async () => {
  const values = Array.from({ length: 9 }, (_, index) => shard(`v${index}`));
  const controller = new AbortController();
  vi.mocked(postFunction).mockImplementation(async (_name, _token, body: unknown) => {
    const request = body as { action: string; shards: { id: string; version: string }[] };
    if (request.action === "manifest") return manifest(values) as never;
    if (request.shards[0].id === "v8") { controller.abort(); throw new DOMException("abort", "AbortError"); }
    return { schema: 1, items: request.shards.map(item => shard(item.id, item.version)) } as never;
  });
  await expect(run({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(Object.keys([...records.values()][0].shards)).toHaveLength(8);
  vi.mocked(postFunction).mockClear();
  vi.mocked(postFunction).mockImplementation(async (_name, _token, body: unknown) => {
    const request = body as { action: string; shards: { id: string; version: string }[] };
    return (request.action === "manifest" ? manifest(values) : { schema: 1, items: request.shards.map(item => shard(item.id, item.version)) }) as never;
  });
  await run(); expect(vi.mocked(postFunction).mock.lastCall?.[2]).toEqual({ sourceId: "video-library", action: "shards", shards: [{ id: "v8", version: "v1" }] });
});
it("keeps stored bytes through a temporary outage while releasing no results", async () => {
  await run(); emitted = [];
  vi.mocked(postFunction).mockRejectedValueOnce(new HttpError(503, "Unavailable"));
  await expect(run()).rejects.toBeInstanceOf(HttpError); expect(emitted).toEqual([]); expect(records.size).toBe(1);
});

it("retains completed batches on a concurrent revision conflict and revalidates before reuse", async () => {
  await run(); emitted = [];
  vi.mocked(postFunction).mockResolvedValueOnce(manifest([shard("a", "v2"), shard("b")]) as never)
    .mockRejectedValueOnce(new HttpError(409, "Changed"));
  await expect(run()).rejects.toBeInstanceOf(HttpError); expect(records.size).toBe(1);
  vi.mocked(postFunction).mockResolvedValueOnce(manifest([shard("a", "v2"), shard("b")]) as never);
  emitted = []; await run();
  expect(emitted.map(item => item.version)).toEqual(["v2", "v1"]);
});
it("uses the bounded legacy scan when the manifest exceeds its source cap", async () => {
  vi.mocked(postFunction).mockRejectedValueOnce(new HttpError(413, "Limit"));
  expect(await run()).toEqual({ supported: false }); expect(emitted).toEqual([]);
});
