import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import background from "../../functions/lib/post-background-outputs.js";
import { fakeFirestore } from "../helpers/master-cleanup-firestore.js";

const rendererSha = "a".repeat(40);
const contextDigest = "b".repeat(64);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const start = Date.parse("2026-10-29T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  // Node's native AbortSignal timer is outside Vitest's fake clock. Keep the
  // product's requested deadline, but drive its abort with the same clock as I/O.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Deadline", "TimeoutError")), ms);
    return controller.signal;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture({ latency = () => 100, corrupt = false, count = 110, countHint = count } = {}) {
  const { firestore, rows } = fakeFirestore();
  const taskPath = "cmsPublishQueue/search-budget/backgroundOutputs/search";
  const after = background.dependency(null);
  const task = { schemaVersion: 1, owner: "post-background-v1", output: "search", contextOnly: true,
    revision: 1, status: "pending", attempts: 0, nextAttemptAt: start, contextDigest,
    dependencies: { after } };
  rows.set(taskPath, task);
  rows.set("cmsBackgroundOutputs/search", { ...task, taskPath, after });
  // Match the observed receipt's 110 files / 2.93 MB, including its 2 MB index.
  const files = [
    { path: "/pagefind/pagefind.js", bytes: Buffer.alloc(12_000, 1), contentType: "application/javascript" },
    ...Array.from({ length: count - 2 }, (_, i) => ({ path: `/pagefind/fragment/${i}.pf_fragment`,
      bytes: Buffer.alloc(8_500, i), contentType: "application/octet-stream" })),
    { path: "/search/meaning-index.json", bytes: Buffer.alloc(2_000_000, 2), contentType: "application/json" },
  ];
  const stored = new Map();
  const operations = [];
  const readOrder = [];
  let active = 0;
  let peak = 0;
  const io = async (kind, key, signal) => {
    signal.throwIfAborted();
    operations.push({ kind, key, signal });
    peak = Math.max(peak, ++active);
    try {
      await new Promise(resolve => setTimeout(resolve, latency(kind, key)));
      signal.throwIfAborted();
    } finally { active--; }
  };
  const owner = background.createPostBackgroundOutputs({ firestore, enabled: true, recoveryOutputs: ["search"], searchFileCount: countHint,
    readContextInTransaction: async () => ({ rendererSha, digest: contextDigest, withdrawalRevision: 0 }),
    build: async () => ({ input: { kind: "public-background", rendererSha, contextDigest, routes: [] }, files }),
    artifacts: {
      async put(key, bytes, { signal }) { await io("put", key, signal); stored.set(key, bytes); },
      async get(key, { signal }) {
        await io("get", key, signal);
        readOrder.push(key);
        const bytes = stored.get(key);
        return corrupt && bytes.length === 2_000_000 ? Buffer.alloc(bytes.length, 3) : bytes;
      },
    } });
  return { owner, files, rows, taskPath, operations, readOrder, peak: () => peak,
    manifest: () => JSON.parse(stored.get(rows.get("cmsBackgroundOutputs/search").receipt.fileManifest.key).toString()),
    state: () => rows.get("cmsBackgroundOutputs/search") };
}

it("verifies 110 search files at 100 ms per storage operation with margin in the minimum 20 s attempt", async () => {
  const f = fixture();
  const recovery = f.owner.recover();
  await vi.advanceTimersByTimeAsync(20_000);
  await recovery;
  const state = f.state();
  expect(state.status).toBe("verified");
  expect(state.receipt.totalBytes).toBe(f.files.reduce((sum, file) => sum + file.bytes.length, 0));
  expect(state.receipt.verifiedAt - start).toBe(3_000);
  expect(f.peak()).toBe(8);
  expect(f.operations).toHaveLength(222);
  expect(new Set(f.operations.map(operation => operation.signal)).size).toBe(1);
  expect(f.manifest().map(({ path, digest, size }) => ({ path, digest, size })))
    .toEqual(f.files.map(({ path, bytes }) => ({ path, digest: hash(bytes), size: bytes.length })));
  expect(f.rows.get(f.taskPath)).toMatchObject({ status: "verified", attempts: 1, error: null, claim: null });
});

it("retains manifest order when readbacks finish out of order", async () => {
  let read = 0;
  const f = fixture({ latency: kind => kind === "put" ? 100 : 100 - (read++ % 8) });
  const recovery = f.owner.recover();
  await vi.advanceTimersByTimeAsync(5_000);
  await recovery;
  const manifest = f.manifest();
  expect(f.readOrder.filter(key => key !== f.state().receipt.fileManifest.key)).not.toEqual(manifest.map(file => file.key));
  expect(manifest.map(file => file.path)).toEqual(f.files.map(file => file.path));
  expect(f.peak()).toBe(8);
});

it("refuses the entire receipt if any concurrent readback has the wrong digest", async () => {
  const f = fixture({ corrupt: true });
  const recovery = f.owner.recover();
  await vi.advanceTimersByTimeAsync(5_000);
  await recovery;
  expect(f.operations).toHaveLength(220);
  expect(f.state()).toMatchObject({ status: "failed", receipt: null });
  expect(f.rows.get(f.taskPath)).toMatchObject({ error: "background_generation_failed", attempts: 1 });
});

it("keeps the shared abort deadline and never starts a later batch after expiry", async () => {
  const f = fixture({ latency: () => 10_001 });
  const recovery = f.owner.recover();
  await vi.advanceTimersByTimeAsync(20_000);
  await recovery;
  expect(AbortSignal.timeout).toHaveBeenCalledWith(20_000);
  expect(f.operations).toHaveLength(16);
  expect(f.operations.every(operation => operation.signal.aborted)).toBe(true);
  expect(f.state()).toMatchObject({ status: "failed", receipt: null });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.operations).toHaveLength(16);
  expect(f.state()).toMatchObject({ status: "failed", receipt: null });
});

it("scales a 512-file search attempt and its claim beyond the former 60 s lease", async () => {
  const f = fixture({ count: 512, latency: () => 500 });
  const recovery = f.owner.recover();
  await vi.advanceTimersByTimeAsync(60_001);
  expect(f.rows.get(f.taskPath)).toMatchObject({ attempts: 1, nextAttemptAt: start + 106_000 });
  await f.owner.recover();
  expect(f.rows.get(f.taskPath).attempts).toBe(1);
  await vi.advanceTimersByTimeAsync(5_999);
  await recovery;
  expect(f.state().status).toBe("verified");
  expect(f.state().receipt.verifiedAt - start).toBe(65_000);
  expect(f.manifest()).toHaveLength(512);
  expect(f.operations).toHaveLength(1026);
  expect(f.peak()).toBe(8);
});

it("aborts an oversized search attempt at its count-scaled deadline without starting another batch", async () => {
  const f = fixture({ count: 512, latency: () => 10_001 });
  const recovery = f.owner.recover();
  await vi.advanceTimersByTimeAsync(66_000);
  await recovery;
  expect(AbortSignal.timeout).toHaveBeenCalledWith(66_000);
  expect(f.state()).toMatchObject({ status: "failed", receipt: null });
  const operations = f.operations.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.operations).toHaveLength(operations);
  expect(f.rows.get(f.taskPath)).toMatchObject({ attempts: 1, error: "background_generation_failed" });
});

it("refuses an understated count before uploading search bytes", async () => {
  const f = fixture({ count: 512, countHint: 110 });
  const recovery = f.owner.recover();
  await vi.advanceTimersByTimeAsync(20_000);
  await recovery;
  expect(f.state()).toMatchObject({ status: "failed", receipt: null });
  expect(f.operations).toHaveLength(0);
});
