import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import {
  createSavedPreviewOperation,
  PreviewOperationError,
  type PreviewTarget,
  type PreviewJob,
  type PreviewOperationDependencies,
} from "../src/lib/saved-preview-operation";

const queueA = "abcdefghijklmnopqrst";
const queueB = "ABCDEFGHIJKLMNOPQRST";
const rendererSha = "a".repeat(40);
const target: PreviewTarget = { collection: "cmsPages", documentId: "contact", sourceVersion: 2 };
function job(overrides: Partial<PreviewJob> = {}): PreviewJob {
  return { ...target, queueId: queueA, rendererSha, status: "ready",
    previewUrl: `https://preview.njpbs.org/p/${queueA}/`, pagePath: "/contact/", ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides: Partial<PreviewOperationDependencies> = {}) {
  const calls = { save: 0, request: 0, read: 0 };
  const operation = createSavedPreviewOperation({
    ensureSaved: async () => { calls.save++; return target; },
    request: async () => { calls.request++; return job(); },
    read: async () => { calls.read++; return job(); },
    ...overrides,
  });
  return { operation, calls };
}
function protocol(error: unknown) {
  return error instanceof PreviewOperationError && error.code === "protocol";
}

describe("saved preview operation contract", () => {
  it("shows refreshing progress for the addressed version before it opens", async () => {
    const states: string[] = [];
    const { operation } = harness({ request: async () => job({ status: "building", contextRefreshing: true }),
      onProgress: state => states.push(state) });
    assert.equal((await operation.run()).status, "ready");
    assert.deepEqual(states, ["requesting", "refreshing"]);
  });

  it("preserves the typed refresh failure through the addressed status read", async () => {
    const { operation } = harness({ request: async () => job({ status: "building" }),
      read: async () => job({ status: "failed", failureReason: "preview_context_refreshing" }) });
    await assert.rejects(operation.run(), error => error instanceof PreviewOperationError && error.code === "refreshing");
  });

  it("reports only validated progress for the requested version", async () => {
    const states: string[] = [];
    const receipts = [job({ status: "building" }), job()];
    const { operation } = harness({ request: async () => job({ status: "pending" }),
      read: async () => receipts.shift()!, onProgress: state => states.push(state) });
    assert.equal((await operation.run()).status, "ready");
    assert.deepEqual(states, ["requesting", "pending", "building"]);
  });

  it("labels an older blocking job as waiting and rejects substituted progress", async () => {
    const states: string[] = [];
    const { operation } = harness({ request: async () => job({ sourceVersion: 1, status: "building" }),
      read: async () => job({ sourceVersion: 2, status: "building" }),
      onProgress: state => states.push(state) });
    await assert.rejects(operation.run(), protocol);
    assert.deepEqual(states, ["requesting", "waiting"]);
  });

  it("reads status immediately without a fixed delay before opening ready output", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => job());
    const { operation } = harness({ request: async () => job({ status: "pending" }), read });
    try {
      const result = operation.run();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(read.mock.calls.length, 1);
      assert.equal((await result).status, "ready");
      assert.equal(vi.getTimerCount(), 0);
    } finally { operation.dispose(); vi.useRealTimers(); }
  });

  it("does not overlap pending server waits and cancels the next in-flight read", async () => {
    vi.useFakeTimers();
    const first = deferred<PreviewJob>();
    const second = deferred<PreviewJob>();
    const read = vi.fn().mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { operation } = harness({ request: async () => job({ status: "pending" }), read });
    try {
      const result = operation.run();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(read.mock.calls.length, 1);
      await vi.advanceTimersByTimeAsync(5_000);
      assert.equal(read.mock.calls.length, 1);
      first.resolve(job({ status: "pending" }));
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(read.mock.calls.length, 2);
      operation.dispose();
      assert.deepEqual(await result, { status: "cancelled" });
      second.resolve(job());
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(read.mock.calls.length, 2);
      assert.equal(vi.getTimerCount(), 0);
    } finally { operation.dispose(); vi.useRealTimers(); }
  });

  it("continues server waits immediately after building and cancels an in-flight wait", async () => {
    vi.useFakeTimers();
    const status = deferred<PreviewJob>();
    const read = vi.fn().mockResolvedValueOnce(job({ status: "building" }))
      .mockImplementationOnce(() => status.promise);
    const { operation } = harness({ request: async () => job({ status: "pending" }), read });
    try {
      const result = operation.run();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(read.mock.calls.length, 2);
      assert.equal(read.mock.calls[1][2], "building");
      const signal = read.mock.calls[1][1] as AbortSignal;
      operation.dispose();
      assert.equal(signal.aborted, true);
      assert.deepEqual(await result, { status: "cancelled" });
      status.resolve(job());
      await vi.advanceTimersByTimeAsync(5_000);
      assert.equal(read.mock.calls.length, 2);
      assert.equal(vi.getTimerCount(), 0);
    } finally { operation.dispose(); vi.useRealTimers(); }
  });

  it("paces status reads when a server returns the same pending state immediately", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(job({ status: "pending" }))
      .mockResolvedValueOnce(job());
    const { operation } = harness({ request: async () => job({ status: "pending" }), read });
    try {
      const result = operation.run();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(read.mock.calls.length, 1);
      await vi.advanceTimersByTimeAsync(999);
      assert.equal(read.mock.calls.length, 1);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(read.mock.calls.length, 2);
      assert.equal((await result).status, "ready");
      assert.equal(vi.getTimerCount(), 0);
    } finally { operation.dispose(); vi.useRealTimers(); }
  });

  it("cancels the fallback pacing delay when the editor closes", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(job({ status: "pending" }));
    const { operation } = harness({ request: async () => job({ status: "pending" }), read });
    try {
      const result = operation.run();
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(read.mock.calls.length, 1);
      operation.dispose();
      assert.deepEqual(await result, { status: "cancelled" });
      await vi.advanceTimersByTimeAsync(1_000);
      assert.equal(read.mock.calls.length, 1);
      assert.equal(vi.getTimerCount(), 0);
    } finally { operation.dispose(); vi.useRealTimers(); }
  });

  it("waits for an exact save receipt and coalesces repeated activation", async () => {
    const saved = deferred<PreviewTarget>();
    const entered = deferred<void>();
    const { operation, calls } = harness({ ensureSaved: async () => {
      calls.save++; entered.resolve(); return saved.promise;
    } });
    const first = operation.run();
    const second = operation.run();
    assert.equal(first, second);
    await entered.promise;
    assert.equal(calls.save, 1);
    assert.equal(calls.request, 0);
    saved.resolve(target);
    const result = await first;
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.url, `https://preview.njpbs.org/p/${queueA}/contact/`);
    assert.equal(calls.request, 1);
    assert.equal(calls.read, 0);
  });

  it("does not request anything without a confirmed save", async () => {
    const failure = new Error("Save acknowledgment unavailable");
    const { operation, calls } = harness({ ensureSaved: async () => { throw failure; } });
    await assert.rejects(operation.run(), error => error === failure);
    assert.equal(calls.request, 0);
  });

  it("copies and freezes the acknowledged target before asynchronous work", async () => {
    const mutable = { ...target };
    const entered = deferred<void>();
    const response = deferred<PreviewJob>();
    const { operation } = harness({ ensureSaved: async () => mutable,
      request: async receipt => {
        assert.equal(Object.isFrozen(receipt), true);
        assert.equal(receipt.sourceVersion, 2);
        entered.resolve(); return response.promise;
      },
    });
    const result = operation.run();
    await entered.promise;
    mutable.sourceVersion = 99;
    response.resolve(job());
    const ready = await result;
    assert.equal(ready.status, "ready");
    if (ready.status === "ready") assert.equal(ready.target.sourceVersion, 2);
  });

  it("remembers the requested version while an older job finishes", async () => {
    let requests = 0;
    const { operation, calls } = harness({ request: async receipt => {
      assert.deepEqual(receipt, target);
      return ++requests === 1 ? job({ sourceVersion: 1, status: "building" }) : job({ queueId: queueB, previewUrl: `https://preview.njpbs.org/p/${queueB}/` });
    }, read: async queue => {
      calls.read++; assert.equal(queue, queueA); return job({ sourceVersion: 1 });
    } });
    const result = await operation.run();
    assert.equal(requests, 2);
    assert.equal(calls.read, 1);
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.queueId, queueB);
  });

  it("requests the target after an unrelated older job fails", async () => {
    let requests = 0;
    const { operation } = harness({ request: async () => ++requests === 1
      ? job({ sourceVersion: 1, status: "pending" }) : job({ queueId: queueB, previewUrl: `https://preview.njpbs.org/p/${queueB}/` }),
      read: async () => job({ sourceVersion: 1, status: "failed" }),
    });
    assert.equal((await operation.run()).status, "ready");
    assert.equal(requests, 2);
  });

  it("polls the accepted queue rather than a mutable latest head", async () => {
    const { operation, calls } = harness({ request: async () => job({ status: "pending" }),
      read: async queue => { calls.read++; assert.equal(queue, queueA); return job(); },
    });
    assert.equal((await operation.run()).status, "ready");
    assert.equal(calls.read, 1);
  });

  for (const [name, changed] of Object.entries({
    "older ready output": { sourceVersion: 1 },
    "a newer unrequested version": { sourceVersion: 3 },
    "another document": { documentId: "about" },
    "another collection": { collection: "cmsPosts" as const },
    "an invalid renderer": { rendererSha: "unknown" },
    "an invalid queue": { queueId: "not-a-queue" },
    "an unknown status": { status: "done" as PreviewJob["status"] },
  })) {
    it(`rejects ${name} instead of substituting content`, async () => {
      const { operation } = harness({ request: async () => job(changed) });
      await assert.rejects(operation.run(), protocol);
    });
  }

  for (const [name, changed] of Object.entries({
    queue: { queueId: queueB },
    version: { sourceVersion: 3 },
    renderer: { rendererSha: "b".repeat(40) },
    document: { documentId: "about" },
    collection: { collection: "cmsPosts" as const },
  })) {
    it(`rejects a changed ${name} during addressed polling`, async () => {
      const { operation } = harness({ request: async () => job({ status: "building" }),
        read: async () => job(changed),
      });
      await assert.rejects(operation.run(), protocol);
    });
  }

  it("rejects an endlessly reused completed blocker instead of looping", async () => {
    const { operation } = harness({ request: async () => job({ sourceVersion: 1, status: "pending" }),
      read: async () => job({ sourceVersion: 1 }),
    });
    await assert.rejects(operation.run(), protocol);
  });

  for (const status of ["failed", "expired"] as const) {
    it(`does not convert an exact ${status} job into an old ready page`, async () => {
      const { operation } = harness({ request: async () => job({ status }),
      });
      await assert.rejects(operation.run(), error => error instanceof PreviewOperationError && error.code === "unavailable");
    });
  }

  for (const [name, changed] of Object.entries({
    "off-origin URL": { previewUrl: `https://evil.example/s/${queueA}/` },
    traversal: { pagePath: "../../admin/" },
    "another export URL": { previewUrl: `https://preview.njpbs.org/p/${queueB}/` },
    "legacy public preview": { previewUrl: "https://branch.njpbs-preview.pages.dev/" },
    "missing route": { pagePath: "" },
  })) {
    it(`rejects ${name}`, async () => {
      const { operation } = harness({ request: async () => job(changed) });
      await assert.rejects(operation.run(), protocol);
    });
  }

  it("settles disposal during an uncooperative save without dispatching later", async () => {
    const saved = deferred<PreviewTarget>();
    const entered = deferred<void>();
    const { operation, calls } = harness({ ensureSaved: async () => {
      entered.resolve(); return saved.promise;
    } });
    const result = operation.run();
    await entered.promise;
    operation.dispose();
    assert.deepEqual(await result, { status: "cancelled" });
    saved.resolve(target);
    await Promise.resolve();
    assert.equal(calls.request, 0);
    assert.deepEqual(await operation.run(), { status: "cancelled" });
  });

  it("ignores a late status after the editor has been disposed", async () => {
    const status = deferred<PreviewJob>();
    const entered = deferred<void>();
    const { operation } = harness({ request: async () => job({ status: "building" }),
      read: async () => { entered.resolve(); return status.promise; },
    });
    const result = operation.run();
    await entered.promise;
    operation.dispose();
    assert.deepEqual(await result, { status: "cancelled" });
    status.resolve(job());
    await Promise.resolve();
  });

  it("releases a rejected operation so a deliberate retry can recover", async () => {
    let attempts = 0;
    const { operation, calls } = harness({ request: async () => {
      if (++attempts === 1) throw new Error("Transport unavailable");
      return job();
    } });
    await assert.rejects(operation.run(), /Transport unavailable/);
    assert.equal(attempts, 1);
    assert.equal((await operation.run()).status, "ready");
    assert.equal(calls.save, 2);
  });

  it("supports an exact Post target without borrowing a Page receipt", async () => {
    const post: PreviewTarget = { collection: "cmsPosts", documentId: "story-id", sourceVersion: 4 };
    const { operation } = harness({ ensureSaved: async () => post,
      request: async receipt => {
        assert.deepEqual(receipt, post);
        return job({ ...post, pagePath: "/posts/story-slug/" });
      },
    });
    const result = await operation.run();
    assert.equal(result.status, "ready");
    if (result.status === "ready") {
      assert.deepEqual(result.target, post);
      assert.equal(result.url, `https://preview.njpbs.org/p/${queueA}/posts/story-slug/`);
    }
  });

  it("does no work when disposed before the first callback starts", async () => {
    const { operation, calls } = harness();
    const result = operation.run();
    operation.dispose();
    assert.deepEqual(await result, { status: "cancelled" });
    assert.deepEqual(calls, { save: 0, request: 0, read: 0 });
  });

  it("rejects a missing receipt as a protocol defect, not successful publication", async () => {
    const { operation } = harness({ request: async () => null as unknown as PreviewJob });
    await assert.rejects(operation.run(), protocol);
  });

  it("starts a fresh operation after an earlier preview completes", async () => {
    const { operation, calls } = harness();
    await operation.run();
    await operation.run();
    assert.equal(calls.save, 2);
    assert.equal(calls.request, 2);
  });

  for (const sourceVersion of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects an invalid acknowledged version (${sourceVersion}) before requesting`, async () => {
      const { operation, calls } = harness({ ensureSaved: async () => ({ ...target, sourceVersion }) });
      await assert.rejects(operation.run(), protocol);
      assert.equal(calls.request, 0);
    });
  }
});
