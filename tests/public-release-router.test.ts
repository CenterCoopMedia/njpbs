import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePair, releaseSelector } from "./helpers/private-public-release-pair.js";
import { createSelectorCache, createPublicReleaseRouter, type PairProofEvidence } from "../workers/src/public-release-router";
import { bytesDigest, responseCacheKey, stripInternalHeaders } from "../packages/content-core/src/public-release-routing";

const pair = releasePair();
const other = releasePair("b", "b".repeat(40));
const receipt = (selector = releaseSelector()) => ({ environment: "development" as const, selector, readStartedAt: Date.now() });
const slots = () => [pair, other].map(identity => ({ identity, serve: vi.fn(async () => ({ kind: "response" as const,
  evidence: { epoch: 1, pairId: identity.pairId, manifestDigest: releaseSelector().contentHead.manifestDigest,
    operationId: "O".repeat(20), sourceVersion: 7, snapshotDigest: "d".repeat(64), rendererSha: identity.commitSha,
    bodyDigest: await bytesDigest(new TextEncoder().encode("current")) } satisfies PairProofEvidence,
  response: new Response("current", { headers: { "x-njpbs-publication-operation": "forged", "content-security-policy": "default-src 'self'" } }) })) }));
afterEach(() => vi.useRealTimers());

describe("absolute routing cache", () => {
  it("private proof never joins an anonymous forced batch whose budget refuses", async () => {
    const calls: boolean[] = [];
    const cache = createSelectorCache({ environment: "development", readSelector: async (_signal, proof = false) => {
      calls.push(proof); if (!proof) throw new Error("Anonymous budget exhausted"); return receipt();
    } });
    const publicRead = cache.get(true, false), privateRead = cache.get(true, true);
    const [anonymous, proof] = await Promise.allSettled([publicRead, privateRead]);
    expect(anonymous.status).toBe("rejected"); expect(proof.status).toBe("fulfilled");
    expect(calls.sort()).toEqual([false, true]);
  });
  it("refuses invalid selector budgets before starting or joining authority", async () => {
    const read = vi.fn(async () => receipt());
    const cache = createSelectorCache({ environment: "development", readSelector: read });
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(cache.get(false, false, budget)).rejects.toThrow("unavailable");
    }
    expect(read).not.toHaveBeenCalled();
  });
  it.each([{ force: false, expired: true }, { force: true, expired: true },
    { force: false, expired: false }, { force: true, expired: false }])(
    "separates a short shared deadline from live joiners without retrying early failures %j", async ({ force, expired }) => {
      let at = 0, rejectRead!: (error: Error) => void, markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const read = vi.fn(async (_signal: AbortSignal, _proof?: boolean, _budget?: number) => {
        if (read.mock.calls.length === 1) return new Promise<ReturnType<typeof receipt>>((_resolve, reject) => {
          rejectRead = reject; markStarted();
        });
        return receipt();
      });
      const cache = createSelectorCache({ environment: "development", now: () => at, readSelector: read });
      const results = Promise.allSettled([cache.get(force, false, 100), cache.get(force, false, 1_000)]);
      await started; at = expired ? 100 : 50; rejectRead(new Error("External selector read refused"));
      const [short, longer] = await results;
      expect(short.status).toBe("rejected");
      expect(longer.status).toBe(expired ? "fulfilled" : "rejected");
      expect(read).toHaveBeenCalledTimes(expired ? 2 : 1);
      expect(read.mock.calls[0][2]).toBe(100);
      if (expired) expect(read.mock.calls[1][2]).toBe(900);
    });
  it("coalesces cold starts, consumes transfer time, and never renews on a hit", async () => {
    let now = 0;
    const read = vi.fn(async () => { now += 2000; return receipt(); });
    const cache = createSelectorCache({ environment: "development", readSelector: read, now: () => now });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(read).toHaveBeenCalledTimes(1);
    now = 4999; await cache.get(); expect(read).toHaveBeenCalledTimes(1);
    now = 5000; await cache.get(); expect(read).toHaveBeenCalledTimes(2);
  });
  it("rejects late, failed and invalidated reads without extending expired authority", async () => {
    let now = 0;
    let finish!: (value: ReturnType<typeof receipt>) => void;
    const read = vi.fn(() => new Promise<ReturnType<typeof receipt>>(resolve => { finish = resolve; }));
    const cache = createSelectorCache({ environment: "development", readSelector: read, now: () => now });
    const pending = cache.get(); await Promise.resolve(); cache.invalidate(2); finish(receipt());
    await expect(pending).rejects.toThrow();
    const next = cache.get(); await Promise.resolve(); now = 5001; finish(receipt({ ...releaseSelector(), epoch: 2 }));
    await expect(next).rejects.toThrow();
  });
  it("ignores old/duplicate pushes and converges after a lost push on next request", async () => {
    let now = 0, selector = releaseSelector();
    const read = vi.fn(async () => receipt(selector));
    const cache = createSelectorCache({ environment: "development", readSelector: read, now: () => now });
    await cache.get(); cache.invalidate(1); cache.invalidate(1); await cache.get();
    expect(read).toHaveBeenCalledTimes(1);
    selector = { ...selector, epoch: 2 }; now = 5000;
    expect((await cache.get()).selector.epoch).toBe(2);
    cache.invalidate(1); await cache.get(); expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("private pair routing", () => {
  it("strips viewer identities and ordinary proof while preserving HTTP representation/security headers", async () => {
    const bindings = slots();
    const router = createPublicReleaseRouter({ environment: "development", slots: bindings, readSelector: async () => receipt() });
    const request = new Request("https://dev-public.example.org/a/", { method: "HEAD", headers: {
      "x-njpbs-pair": other.pairId, "x-njpbs-publication-proof": "yes", range: "bytes=0-3", "if-none-match": '"etag"', cookie: "a=b" } });
    const response = await router.fetch(request);
    const passed = bindings[0].serve.mock.calls[0] as unknown as [Request];
    expect(passed[0].headers.has("x-njpbs-pair")).toBe(false);
    expect(passed[0].headers.has("x-njpbs-publication-proof")).toBe(false);
    expect(passed[0].headers.get("range")).toBe("bytes=0-3");
    expect(passed[0].method).toBe("HEAD");
    expect(response.headers.has("x-njpbs-publication-operation")).toBe(false);
    expect(response.headers.get("content-security-policy")).toContain("default-src");
    expect(await response.text()).toBe("");
    expect(bindings[1].serve).not.toHaveBeenCalled();
  });
  it("allows one private reselection and refuses a second miss", async () => {
    const bindings = slots(); bindings[0].serve.mockResolvedValue({ kind: "reselect" } as never);
    const selector = releaseSelector();
    const switched = { ...selector, epoch: 2, activeCommitSha: other.commitSha, selectedPair: selector.recoveryPair,
      recoveryPair: selector.selectedPair, contentHead: { ...selector.contentHead, pairId: other.pairId } };
    const read = vi.fn().mockResolvedValueOnce(receipt()).mockResolvedValue(receipt(switched));
    const router = createPublicReleaseRouter({ environment: "development", slots: bindings, readSelector: read });
    expect((await router.fetch(new Request("https://dev-public.example.org/a/"))).status).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
    bindings[1].serve.mockResolvedValue({ kind: "reselect" } as never);
    expect((await router.fetch(new Request("https://dev-public.example.org/a/"))).status).toBe(503);
  });
  it("shares one three-second budget across selector, slot and reselection", async () => {
    vi.useFakeTimers();
    const bindings = slots(); bindings[0].serve.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 1200)); return { kind: "reselect" } as never;
    });
    const read = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 1000)); return receipt(); });
    const router = createPublicReleaseRouter({ environment: "development", slots: bindings, readSelector: read, now: Date.now });
    const result = router.fetch(new Request("https://dev-public.example.org/a/"));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).status).toBe(503); expect(read).toHaveBeenCalledTimes(2);
  });
  it("keeps bootstrap on OLD, fails identity mismatches, and never exposes candidates", async () => {
    const bindings = slots(), selector = releaseSelector();
    const router = createPublicReleaseRouter({ environment: "development", slots: bindings, bootstrapPairId: other.pairId,
      readSelector: async () => receipt(selector) });
    expect((await router.fetch(new Request("https://dev-public.example.org/"))).status).toBe(503);
    expect(bindings[0].serve).not.toHaveBeenCalled(); expect(bindings[1].serve).not.toHaveBeenCalled();
    expect((await router.fetch(new Request("https://candidate.invalid/"))).status).toBe(404);
  });
  it("authoritative root reads always bypass the routing cache and fail on outage", async () => {
    const bindings = slots(), read = vi.fn(async () => receipt());
    const router = createPublicReleaseRouter({ environment: "development", slots: bindings, readSelector: read });
    await router.fetch(new Request("https://dev-public.example.org/"));
    const response = await router.fetch(new Request("https://dev-public.example.org/_publication-v2.json"));
    expect(response.status).toBe(200); expect(read).toHaveBeenCalledTimes(2);
    expect((await response.json()).schemaVersion).toBe(2);
    read.mockRejectedValue(new Error("offline"));
    expect((await router.fetch(new Request("https://dev-public.example.org/_publication-v2.json"))).status).toBe(503);
  });
  it("checks epoch and content head after a private exact-byte GET", async () => {
    const bindings = slots(), selector = releaseSelector();
    const read = vi.fn().mockResolvedValueOnce(receipt()).mockResolvedValue(receipt({ ...selector,
      contentHead: { ...selector.contentHead, manifestDigest: "d".repeat(64) } }));
    const router = createPublicReleaseRouter({ environment: "development", slots: bindings, readSelector: read });
    expect((await router.prove(new Request("https://dev-public.example.org/a/"), await bytesDigest(new TextEncoder().encode("current")))).status).toBe(503);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("uses verified recovery for warm/cold authority loss, strips proof, and refuses unsafe fallback", async () => {
    const bindings = slots(), read = vi.fn(async () => receipt());
    const recover = vi.fn(async () => new Response("safe", { headers: { "x-njpbs-html-sha256": "bad" } }));
    const router = createPublicReleaseRouter({ environment: "development", slots: bindings, readSelector: read,
      readRecovery: async () => receipt(), serveRecovery: recover });
    read.mockRejectedValue(new Error("offline"));
    const response = await router.fetch(new Request("https://dev-public.example.org/a/"));
    expect(await response.text()).toBe("safe"); expect(response.headers.get("publication-refresh")).toBe("pending");
    expect(response.headers.has("x-njpbs-html-sha256")).toBe(false);
    recover.mockResolvedValue(null as never);
    expect((await router.fetch(new Request("https://dev-public.example.org/a/"))).status).toBe(503);
  });
});

it("removes every adjacent internal header without changing representation headers", () => {
  const headers = stripInternalHeaders(new Headers({
    "publication-refresh": "pending", "x-njpbs-html-sha256": "digest", "x-njpbs-pair": "pair",
    "x-njpbs-publication-proof": "proof", "x-njpbs-selector-sha256": "selector", "content-type": "text/html",
  }));
  expect([...headers.entries()]).toEqual([["content-type", "text/html"]]);
});

it("versions every response branch by epoch, pair/incarnation, content head and representation", async () => {
  const selection = receipt(); const request = new Request("https://dev-public.example.org/a/?x=1", { headers: { range: "bytes=1-2" } });
  const key = await responseCacheKey(selection, request);
  for (const changed of [ { ...selection, selector: { ...selection.selector, epoch: 2 } },
    { ...selection, selector: { ...selection.selector, contentHead: { ...selection.selector.contentHead, manifestDigest: "d".repeat(64) } } },
    { ...selection, selector: { ...selection.selector, selectedPair: { ...selection.selector.selectedPair, pairId: other.pairId } } } ]) {
    expect(await responseCacheKey(changed, request)).not.toBe(key);
  }
  expect(await responseCacheKey(selection, new Request(request, { method: "HEAD" }))).not.toBe(key);
  expect(await responseCacheKey(selection, new Request(request, { headers: { range: "bytes=1-3" } }))).not.toBe(key);
  expect(stripInternalHeaders(new Headers({ "x-njpbs-internal-anything": "a", accept: "text/html" })).has("x-njpbs-internal-anything")).toBe(false);
});

it("does not let a late older epoch or content head replace fresh knowledge", async () => {
  const selector = releaseSelector();
  const read = vi.fn().mockResolvedValueOnce(receipt({ ...selector, epoch: 2, contentHead: { ...selector.contentHead, contextSequence: 4 } }))
    .mockResolvedValueOnce(receipt({ ...selector, epoch: 1 })).mockResolvedValueOnce(receipt({ ...selector, epoch: 2 }));
  const cache = createSelectorCache({ environment: "development", readSelector: read });
  await cache.get(); await expect(cache.get(true)).rejects.toThrow(); await expect(cache.get(true)).rejects.toThrow();
});

it("certifies matching complete bytes only with stable fresh authority", async () => {
  const router = createPublicReleaseRouter({ environment: "development", slots: slots(), readSelector: async () => receipt() });
  const digest = await bytesDigest(new TextEncoder().encode("current"));
  const response = await router.prove(new Request("https://dev-public.example.org/a/"), digest);
  expect(response.status).toBe(200); expect(response.headers.get("x-njpbs-html-sha256")).toBe(digest);
});
it("reuses the newer forced content head and counts one refresh per actual read", async () => {
  const selector = releaseSelector(), observe = vi.fn();
  const read = vi.fn().mockResolvedValueOnce(receipt()).mockResolvedValue(receipt({ ...selector, contentHead: { ...selector.contentHead, contextSequence: 1 } }));
  const cache = createSelectorCache({ environment: "development", readSelector: read, observe });
  await cache.get(); await cache.get(true);
  expect((await cache.get()).selector.contentHead.contextSequence).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(observe.mock.calls.filter(([event]) => event === "refresh")).toHaveLength(2);
  expect(observe.mock.calls.filter(([event]) => event === "refresh-complete")).toHaveLength(2);
});
it("batches concurrent fresh root reads without reusing authority from before arrival", async () => {
  const read = vi.fn(async () => receipt());
  const router = createPublicReleaseRouter({ environment: "development", slots: slots(), readSelector: read });
  const responses = await Promise.all(Array.from({ length: 20 }, () => router.fetch(new Request("https://dev-public.example.org/_publication-v2.json"))));
  expect(responses.every(response => response.status === 200)).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  expect((await router.fetch(new Request("https://dev-public.example.org/_publication-v2.json"))).status).toBe(200);
  expect(read).toHaveBeenCalledTimes(2);
});
it("never joins a forced authority read that already started", async () => {
  const finish: Array<(value: ReturnType<typeof receipt>) => void> = [];
  const cache = createSelectorCache({ environment: "development", readSelector: () => new Promise(resolve => { finish.push(resolve); }) });
  const first = cache.get(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = cache.get(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(finish).toHaveLength(2);
  finish.forEach(resolve => resolve(receipt()));
  await Promise.all([first, second]);
});
it.each([false, true])("reserves recovery time within three seconds when authority hangs (warm=%s)", async warm => {
  vi.useFakeTimers();
  const read = vi.fn(async () => receipt());
  const router = createPublicReleaseRouter({ environment: "development", slots: slots(), readSelector: read,
    now: Date.now, readRecovery: async () => receipt(), serveRecovery: async () => new Response("safe") });
  if (warm) { await router.fetch(new Request("https://dev-public.example.org/")); await vi.advanceTimersByTimeAsync(5000); }
  read.mockImplementation(() => new Promise(() => {}));
  const response = router.fetch(new Request("https://dev-public.example.org/"));
  await vi.advanceTimersByTimeAsync(2250);
  expect(await (await response).text()).toBe("safe");
});
it("uses the canonical development origin marker for authoritative receipts", async () => {
  const router = createPublicReleaseRouter({ environment: "development", slots: slots(), readSelector: async () => receipt() });
  const response = await router.fetch(new Request("https://dev-public.example.org/_publication-v2.json"));
  expect(response.headers.get("x-njpbs-publication-origin")).toBe("template-dev-public");
});
it("starts a post-push read without joining the invalidated read or clearing its replacement", async () => {
  const finish: Array<(value: ReturnType<typeof receipt>) => void> = [];
  const cache = createSelectorCache({ environment: "development", readSelector: () => new Promise(resolve => { finish.push(resolve); }) });
  const old = cache.get(); const rejected = expect(old).rejects.toThrow();
  await Promise.resolve(); cache.invalidate(2);
  const current = cache.get(); await Promise.resolve();
  expect(finish).toHaveLength(2);
  finish[1](receipt({ ...releaseSelector(), epoch: 2 })); await current;
  finish[0](receipt()); await rejected;
  expect((await cache.get()).selector.epoch).toBe(2); expect(finish).toHaveLength(2);
});
