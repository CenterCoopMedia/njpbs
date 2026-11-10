import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createHash } from "node:crypto";
import { releasePair, pairReference } from "../helpers/private-public-release-pair";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input";
import { writePublicReleasePairView, readPublicReleasePairView, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { readReplayProofBatch, readPublicReleasePairReplayProofView } from "../../site/scripts/public-release-replay-proof-reads";
async function collect<T>(stream: AsyncIterable<T>) { const rows: T[] = []; for await (const row of stream) rows.push(row); return rows; }
it("settles at most four reads and exposes their original order even when later reads finish first", async () => {
  const started: number[] = [], resolve = new Map<number, (value: number) => void>();
  const iterator = readReplayProofBatch([0, 1, 2, 3, 4], item => {
    started.push(item); return new Promise<number>(done => resolve.set(item, done));
  });
  const first = iterator.next(); await Promise.resolve();
  expect(started).toEqual([0, 1, 2, 3]);
  for (const item of [3, 2, 1, 0]) resolve.get(item)!(item);
  expect(await first).toMatchObject({ value: 0 });
  expect((await iterator.next()).value).toBe(1); expect((await iterator.next()).value).toBe(2);
  expect((await iterator.next()).value).toBe(3); expect(started).toHaveLength(4);
  const last = iterator.next(); await Promise.resolve(); resolve.get(4)!(4);
  expect((await last).value).toBe(4); expect((await iterator.next()).done).toBe(true);
});
it("retains earlier read errors and waits for every in-flight read before surfacing them", async () => {
  const firstError = new Error("first"), laterError = new Error("later");
  let release!: () => void, completed = false;
  const iterator = readReplayProofBatch([0, 1, 2, 3], async item => {
    if (item === 0) { await new Promise<void>(done => { release = done; }); throw firstError; }
    if (item === 1) throw laterError;
    completed = true; return item;
  });
  const next = iterator.next(); await Promise.resolve(); expect(completed).toBe(true);
  const rejected = expect(next).rejects.toBe(firstError); release(); await rejected;
});
const pair = releasePair(), captured = capturedPairInput(pair);
const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...captured.taskInput };
const claimDigest = "e".repeat(64), cursor = captured.root.cursor;
let runtime: Miniflare, store: R2Bucket;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "replay-proof-reads", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "replay-proof-reads" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => { const listed = await store.list(); if (listed.objects.length) await store.delete(listed.objects.map(row => row.key)); });
afterAll(async () => { await runtime?.dispose(); });
async function fixture(count = 9, shared = false) {
  async function* outputs() { for (let index = 0; index < count; index++) yield {
    path: `/routes/${String(index).padStart(4, "0")}/`, status: 200 as const,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha },
    bytes: new TextEncoder().encode(shared ? "verified-shared" : `verified-${index}`),
  }; }
  const receipt = await writePublicReleasePairView({ store, pair, identity, claimDigest, cursor, outputs: outputs() });
  return { store, pair, identity, claimDigest, manifestDigest: receipt.manifestDigest, manifestBytes: receipt.manifestBytes };
}
it("reads the same actual R2 bytes and metadata as the complete view reader, within four active gets", async () => {
  const options = await fixture(), expected = await collect(readPublicReleasePairView(options));
  let active = 0, maximum = 0;
  const tracked = { ...options, store: { get: async (key: string) => {
    active++; maximum = Math.max(maximum, active);
    try { return await store.get(key); } finally { active--; }
  } } as PairViewStore };
  expect(await collect(readPublicReleasePairReplayProofView(tracked))).toEqual(expected);
  expect(maximum).toBe(4); expect(active).toBe(0);
});
it("preserves consecutive shared-blob reuse and independent consumer bytes across batches", async () => {
  const options = await fixture(9, true);
  let bodyGets = 0;
  const tracked = { ...options, store: { get: async (key: string) => {
    if (key.includes("/objects/")) bodyGets++; return store.get(key);
  } } as PairViewStore };
  const iterator = readPublicReleasePairReplayProofView(tracked);
  const first = (await iterator.next()).value!; first.body.fill(0);
  const rest = await collect(iterator);
  expect(rest).toHaveLength(8);
  expect(rest.every(row => new TextDecoder().decode(row.body) === "verified-shared")).toBe(true);
  expect(bodyGets).toBe(1);
});
it.each(["missing", "digest", "size", "metadata"])("refuses actual R2 %s body evidence", async mode => {
  const options = await fixture(), rows = await collect(readPublicReleasePairView(options)), target = rows[1];
  const object = await store.get(target.objectKey), metadata = object!.customMetadata;
  if (mode === "missing") await store.delete(target.objectKey);
  else await store.put(target.objectKey, mode === "size" ? new Uint8Array([1]) :
    mode === "digest" ? new Uint8Array(target.bytes).fill(1) : target.body,
    { customMetadata: mode === "metadata" ? {} : metadata });
  await expect(collect(readPublicReleasePairReplayProofView(options))).rejects.toThrow("Private pair view bytes differ");
});
it("surfaces an earlier body failure before opening a later missing page", async () => {
  const options = await fixture(), rows = await collect(readPublicReleasePairView(options));
  const prefix = rows[0].objectKey.split("objects/")[0];
  const rootObject = (await store.get(`${prefix}views/${options.manifestDigest}.json`))!;
  const root = JSON.parse(await rootObject.text());
  const originalPage = JSON.parse(await (await store.get(`${prefix}pages/${root.pages[0].digest}.json`))!.text());
  // Two valid small pages exercise the boundary without 257 irrelevant puts.
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const pages = [originalPage.outputs.slice(0, 8), originalPage.outputs.slice(8)];
  root.pages = [];
  for (const [index, outputs] of pages.entries()) {
    const bytes = encode({ ...originalPage, index, outputs }), digest = sha(bytes);
    root.pages.push({ index, digest, count: outputs.length, bytes: outputs.reduce((sum: number, row: any) => sum + row.bytes, 0),
      firstPath: outputs[0].path, lastPath: outputs.at(-1).path });
    if (!index) await store.put(`${prefix}pages/${digest}.json`, bytes,
      { customMetadata: { ...rootObject.customMetadata, bodydigest: digest } });
  }
  const bytes = encode(root); options.manifestDigest = sha(bytes); options.manifestBytes = bytes.length;
  await store.put(`${prefix}views/${options.manifestDigest}.json`, bytes,
    { customMetadata: { ...rootObject.customMetadata, bodydigest: options.manifestDigest } });
  const later = `${prefix}pages/${root.pages[1].digest}.json`;
  await store.delete(rows[7].objectKey);
  let openedLater = false;
  const tracked = { ...options, store: { get: async (key: string) => { if (key === later) openedLater = true; return store.get(key); } } as PairViewStore };
  await expect(collect(readPublicReleasePairReplayProofView(tracked))).rejects.toThrow();
  expect(openedLater).toBe(false);
});
