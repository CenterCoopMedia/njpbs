import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransitionalPostReadWorker } from "../workers/src/transitional-post-read-worker";
import { createNoBuildCodePostWorker } from "../workers/src/no-build-code-post-worker";
import type { Withdrawal } from "../workers/src/durable-post-withdrawals";
import type { NoBuildPostReply } from "../cms-api/src/index";
import { publicationTarget } from "../functions/lib/publication-target.js";
import type { PublishedPostContent } from "../site/src/lib/published-post-shadow";
import fixture from "../site/tests/fixtures/shadow-posts/post.json";
import { createHash } from "node:crypto";
import { renderLiveBlog } from "../packages/content-core/src/live-blog-render";

const rendererSha = "a".repeat(40);
const origin = "https://njpbs.org";
const path = "/posts/shadow-fixture/";
const receipt = { schemaVersion: 1 as const, postId: fixture.document.id, operationId: "A1b2C3d4E5f6G7h8I9j0",
  rendererSha, sourceVersion: 7, slug: "shadow-fixture", ownedSlugs: ["shadow-fixture", "old-fixture"],
  generation: 1, visible: true, contextDigest: "b".repeat(64), admissionRevision: 1 };
const post: NoBuildPostReply = { kind: "post", receipt, published: fixture };
const catalog: NoBuildPostReply = { kind: "receipts", catalog: { schemaVersion: 1, rendererSha,
  generation: 1, contextDigest: "b".repeat(64), admissionRevision: 1, posts: [receipt] } };

// Cache API boundary. Entries can be shared by different entry/factory wrappers;
// tag deletion models the existing provider purge, not a repository cache mock.
function cacheBoundary(fail = false, failWrites = false) {
  const entries = new Map<string, Response>();
  // Older Node/Undici finalizes a discarded clone by cancelling its sibling
  // stream. Keep Cache API handles alive for this fixture, including failed puts.
  const responses = new Set<Response>();
  function retain(response: Response) { responses.add(response); return response; }
  return {
    async match(key: RequestInfo | URL) {
      if (fail) throw new Error("Cache unavailable");
      const response = entries.get(key instanceof Request ? key.url : String(key));
      return response ? retain(response.clone()) : undefined;
    },
    async put(key: RequestInfo | URL, response: Response) {
      retain(response);
      if (fail || failWrites) throw new Error("Cache unavailable");
      entries.set(key instanceof Request ? key.url : String(key), response);
    },
    purge(tag: string) {
      for (const [key, value] of entries) if (value.headers.get("Cache-Tag")?.split(",").includes(tag)) entries.delete(key);
    },
    values() { return [...entries.values()].map(value => retain(value.clone())); },
    async corruptCatalog(reply: unknown) {
      for (const [key, value] of entries) {
        if (new URL(key).searchParams.get("kind") !== "catalog") continue;
        const stored = await retain(value.clone()).json() as Record<string, unknown>;
        entries.set(key, new Response(JSON.stringify({ ...stored, reply }), { headers: value.headers }));
      }
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(cache = cacheBoundary()) {
  let clock = Date.parse("2026-10-11T12:00:00.000Z");
  let catalogReply: NoBuildPostReply = { kind: "pass" };
  let routeReply: NoBuildPostReply = structuredClone(post);
  let authority: ((path: string, method: string, probe?: { buildBatchId: string; versionId: string }) => Promise<NoBuildPostReply>) | undefined;
  let render = async (content: PublishedPostContent) => `<!doctype html><html><main>${content.posts[0].title}</main></html>`;
  let assetStatus = 200;
  let codeInventory: unknown = { schemaVersion: 1, commitSha: rendererSha, generation: 1,
    buildBatchId: "cms-A1b2C3d4E5f6G7h8I9j0", routes: [{ path, source: "cms", recordContext: true, contentKey: "b".repeat(64), sourceVersion: 7 }] };
  const assetPaths: string[] = [];
  let codeReader: ((request: Request) => Promise<Response | null>) | undefined;
  let withdrawalReader: ((slug: string) => Promise<Withdrawal | null>) | undefined;
  const calls: { path: string; method: string; probe?: { buildBatchId: string; versionId: string } }[] = [];
  const pending: Promise<unknown>[] = [];
  function worker(target = publicationTarget("production"), rendererReady = true) {
    return createTransitionalPostReadWorker({ target, rendererSha, rendererReady, cache, now: () => clock,
      waitUntil: task => { pending.push(task); },
      async getDecision(path, method, probe) {
        calls.push({ path, method, probe });
        if (authority) return authority(path, method, probe);
        return structuredClone(path === "/_publication.json" ? catalogReply : routeReply);
      },
      async fetchAsset(request) {
        assetPaths.push(new URL(request.url).pathname);
        if (codeReader && new URL(request.url).pathname === "/_content-status.json") return Response.json(codeInventory);
        return new Response(request.method === "HEAD" ? null : "Full-build Assets", { status: assetStatus, headers: { "content-type": "text/html" } });
      },
      render: content => render(content),
      readCodePost: codeReader,
      readWithdrawal: withdrawalReader,
    });
  }
  return {
    cache, calls, worker, assetPaths, get clock() { return clock; },
    assets(status: number) { assetStatus = status; },
    codeInventory(value: unknown) { codeInventory = value; },
    advance(ms: number) { clock += ms; },
    catalog(value: NoBuildPostReply) { catalogReply = structuredClone(value); },
    route(value: NoBuildPostReply) { routeReply = structuredClone(value); },
    authority(value: typeof authority) { authority = value; },
    render(value: typeof render) { render = value; },
    codePosts(value: typeof codeReader) { codeReader = value; },
    withdrawals(value: typeof withdrawalReader) { withdrawalReader = value; },
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); },
    request(worker = this.worker(), pathname = path, init?: RequestInit) { return worker.fetch(new Request(`${origin}${pathname}`, init)); },
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); });

it.each(["empty", "other-owned"])("serves current code Post cards after fresh %s catalog absence", async kind => {
  const h = harness();
  if (kind === "other-owned") h.catalog({ ...catalog, catalog: { ...catalog.catalog!, posts: [{ ...receipt,
    postId: "other", slug: "other", ownedSlugs: ["other"] }] } });
  h.codePosts(async () => new Response("Current approved cards", { headers: { "x-njpbs-content-source": "cms-code-post-context" } }));
  const response = await h.request();
  expect(await response!.text()).toBe("Current approved cards");
  expect(response!.headers.get("x-njpbs-content-source")).toBe("cms-code-post-context");
});

it.each([503, "throw"])("keeps static code Assets pending when card context returns %s", async failure => {
  const h = harness();
  h.codePosts(async () => { if (failure === "throw") throw new Error("Private context unavailable"); return new Response(null, { status: failure }); });
  const response = await h.request();
  expect(response!.status).toBe(200);
  expect(await response!.text()).toBe("Full-build Assets");
  expect(response!.headers.get("x-njpbs-publication-refresh")).toBe("pending");
});

it.each(["first", "recheck"])("refuses static code Assets when card context loses withdrawal state at its %s read", async mode => {
  const h = harness();
  let reads = 0;
  const code = createNoBuildCodePostWorker({ rendererSha, target: publicationTarget("production"),
    getDecision: async () => { throw new Error("Private context unavailable"); },
    render: async () => "<!doctype html><html></html>",
    readWithdrawal: async () => {
      if (mode === "first" || ++reads > 1) throw new Error("Durable withdrawal manifest is invalid");
      return null;
    } });
  h.codePosts(request => code.fetch(request));
  for (const method of ["GET", "HEAD"]) {
    const response = await h.request(h.worker(), path, { method });
    expect(response!.status).toBe(503);
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(await response!.text()).not.toContain("Full-build Assets");
  }
  expect(h.assetPaths.filter(asset => asset !== "/_content-status.json")).toEqual([]);
});

it.each(["withdrawn", "unknown"])("refuses static code Assets after a card context timeout when the Post is %s", async state => {
  const h = harness();
  const marker = { postId: fixture.document.id, sourceVersion: 7, revision: 2, operationId: "W".repeat(20), ownedSlugs: ["shadow-fixture"], verifiedAt: 1234 };
  let reads = 0;
  // The first read precedes the withdrawal; the code context never answers.
  h.withdrawals(async () => {
    if (++reads === 1) return null;
    if (state === "unknown") throw new Error("Durable withdrawal manifest is invalid");
    return marker;
  });
  const started = deferred<void>();
  h.codePosts(() => { started.resolve(); return new Promise<Response | null>(() => {}); });
  const pending = h.request();
  await started.promise;
  await vi.advanceTimersByTimeAsync(3_000);
  const response = await pending;
  expect(response!.status).toBe(state === "withdrawn" ? 410 : 503);
  expect(response!.headers.get("cache-control")).toBe("no-store");
  expect(await response!.text()).not.toContain("Full-build Assets");
  expect(h.assetPaths.filter(asset => asset !== "/_content-status.json")).toEqual([]);
});

it.each(["known", "unknown"])("answers a stale-window Post during a CMS outage with %s withdrawal state", async state => {
  const h = harness();
  h.catalog(catalog);
  let unknown = false;
  h.withdrawals(async () => { if (unknown) throw new Error("Durable withdrawal manifest is invalid"); return null; });
  expect(await (await h.request())!.text()).toContain("A published fixture");
  await h.drain();
  h.advance(15_000);
  h.authority(async () => { throw new Error("CMS authority unavailable"); });
  unknown = state === "unknown";
  const response = await h.request();
  const body = await response!.text();
  if (state === "known") {
    expect(response!.status).toBe(200);
    expect(body).toContain("A published fixture");
  } else {
    expect(response!.status).toBe(503);
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain("A published fixture");
    expect(body).not.toContain("Full-build Assets");
  }
  await h.drain();
});

it("refuses a static-return Post when card context loses withdrawal state", async () => {
  const h = harness();
  const staticReceipt = { ...receipt, mode: "static" as const, visible: true };
  h.catalog({ ...catalog, catalog: { ...catalog.catalog!, posts: [staticReceipt] } });
  h.route({ kind: "static", receipt: staticReceipt, staticFile: { path,
    bytes: Buffer.byteLength("Full-build Assets"), digest: createHash("sha256").update("Full-build Assets").digest("hex") } });
  h.codePosts(createNoBuildCodePostWorker({ rendererSha, target: publicationTarget("production"),
    getDecision: async () => { throw new Error("Private context unavailable"); },
    render: async () => "<!doctype html><html></html>",
    readWithdrawal: async () => { throw new Error("Durable withdrawal manifest is invalid"); } }).fetch);
  for (const method of ["GET", "HEAD"]) {
    const response = await h.request(h.worker(), path, { method });
    expect(response!.status).toBe(503);
    expect(await response!.text()).not.toContain("Full-build Assets");
  }
});

it.each([200, 302, 308, 410])("preserves a verified static-return %s during a code context outage", async status => {
  const h = harness();
  const staticReceipt = { ...receipt, mode: "static" as const, visible: status !== 410, ...(status === 302 ? { contentRedirectUrl: "https://example.test/linked-static" } : {}) };
  h.catalog({ ...catalog, catalog: { ...catalog.catalog!, posts: [staticReceipt] } });
  h.route(status === 410 ? { kind: "gone", receipt: staticReceipt } : status === 308
    ? { kind: "alias", receipt: staticReceipt, location: path }
    : { kind: "static", receipt: staticReceipt, staticFile: { path,
      bytes: Buffer.byteLength("Full-build Assets"), digest: createHash("sha256").update("Full-build Assets").digest("hex") } });
  h.codePosts(async () => new Response(null, { status: 503 }));
  const response = await h.request(h.worker(), status === 308 ? "/posts/old-fixture/" : path);
  expect(response!.status).toBe(status);
  if (status === 302) expect(response!.headers.get("location")).toBe("https://example.test/linked-static");
  expect(response!.headers.get("x-njpbs-content-source")).toBe("cms-static-return");
  expect(await response!.text()).toBe(status === 200 ? "Full-build Assets" : "");
});

it.each(["unknown", "no-joins", "overflow", "old-release", "oversized"])("skips private CODE reads for %s released route hints", async mode => {
  const h = harness();
  let reads = 0;
  h.codePosts(async () => { reads++; return new Response("Current cards"); });
  if (mode === "no-joins") h.codeInventory({ schemaVersion: 1, commitSha: rendererSha, generation: 1,
    buildBatchId: "cms-A1b2C3d4E5f6G7h8I9j0", routes: [{ path, source: "cms", contentKey: "b".repeat(64), sourceVersion: 7 }] });
  const eligible = { schemaVersion: 1, commitSha: rendererSha, generation: 1,
    buildBatchId: "cms-A1b2C3d4E5f6G7h8I9j0", routes: [{ path, source: "cms", recordContext: true,
      contentKey: "b".repeat(64), sourceVersion: 7 }] };
  if (mode === "overflow") h.codeInventory({ ...eligible, routes: Array(10_001).fill(eligible.routes[0]) });
  if (mode === "old-release") h.codeInventory({ ...eligible, commitSha: "f".repeat(40) });
  if (mode === "oversized") h.codeInventory({ ...eligible, padding: "x".repeat(2 * 1024 * 1024) });
  const response = await h.request(h.worker(), mode === "unknown" ? "/posts/unknown/" : path);
  expect(await response!.text()).toBe("Full-build Assets");
  expect(reads).toBe(0);
  expect(response!.headers.has("x-njpbs-publication-refresh")).toBe(false);
  expect(h.calls.map(call => call.path)).toEqual(["/_publication.json"]);
});

it("retains static Assets when optional CODE context exceeds its three-second deadline", async () => {
  const h = harness();
  const started = deferred<void>();
  h.codePosts(async () => { started.resolve(); return new Promise(() => {}); });
  const pending = h.request();
  await started.promise;
  await vi.advanceTimersByTimeAsync(3_000);
  const response = await pending;
  expect(response!.status).toBe(200);
  expect(await response!.text()).toBe("Full-build Assets");
});

it.each(["/posts/shadow-fixture", "/posts/shadow-fixture/index.html", "/posts/%73hadow-fixture/"])(
  "keeps the original Assets URL for unowned %s", async pathname => {
    const h = harness();
    let reads = 0;
    h.codePosts(async () => { reads++; return new Response("Current cards"); });
    await h.request(h.worker(), pathname);
    expect(h.assetPaths).toEqual([pathname]);
    expect(reads).toBe(0);
  });

it("keeps static owner provenance and bytes for candidate readback while context is available", async () => {
  const h = harness();
  const staticReceipt = { ...receipt, mode: "static" as const };
  h.catalog({ ...catalog, catalog: { ...catalog.catalog!, posts: [staticReceipt] } });
  h.route({ kind: "static", receipt: staticReceipt, staticFile: { path,
    bytes: Buffer.byteLength("Full-build Assets"), digest: createHash("sha256").update("Full-build Assets").digest("hex") } });
  let reads = 0;
  h.codePosts(async () => { reads++; return new Response("Current cards"); });
  const response = await h.request(h.worker(), `${path}?cms-code=release-readback`);
  expect(response!.status).toBe(200);
  expect(await response!.text()).toBe("Full-build Assets");
  expect(response!.headers.get("x-njpbs-content-source")).toBe("cms-static-return");
  expect(response!.headers.get("x-njpbs-publication-operation")).toBe(receipt.operationId);
  expect(reads).toBe(0);
});

async function warm(h: ReturnType<typeof harness>) {
  h.catalog(catalog);
  let body = "";
  for (let index = 0; index < 3; index++) {
    const response = await h.request();
    expect(response!.status).toBe(200);
    body = await response!.text();
    await h.drain();
    if (body.includes("A published fixture")) break;
  }
  expect(body).toContain("A published fixture");
}

function nextVersion() {
  const published = structuredClone(fixture);
  published.document.published.sourceVersion = 8;
  published.document.published.metadata.title = "New published version";
  const nextReceipt = { ...receipt, sourceVersion: 8, operationId: "B1b2C3d4E5f6G7h8I9j0" };
  return { post: { kind: "post", receipt: nextReceipt, published } as NoBuildPostReply,
    catalog: { ...catalog, catalog: { ...catalog.catalog!, posts: [nextReceipt] } } as NoBuildPostReply };
}

describe("transitional public Post authority", () => {
  it("serves a cached live blog feed through the existing published authority without another snapshot read", async () => {
    const h = harness();
    const stamp = fixture.document.published.publishedAt;
    const liveBlog = { schemaVersion: 1 as const, coverageState: "ongoing" as const, updatedAt: stamp, updates: [{
      id: "entry-one", headline: "Public reporting", body: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Published update." }] }] },
      credits: [{ kind: "custom" as const, name: "Newsroom" }], keyUpdate: false, publishedAt: stamp, updatedAt: stamp,
    }] };
    h.catalog(catalog);
    h.route({ ...post, published: { ...fixture, document: { ...fixture.document, published: { ...fixture.document.published,
      metadata: { ...fixture.document.published.metadata, liveBlog } } } } });
    h.render(async () => `<!doctype html><html>${renderLiveBlog(liveBlog, { id: fixture.document.id, asOf: stamp })}</html>`);
    const worker = h.worker();
    const response = (await h.request(worker, `${path}?live-blog=updates`))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toContain("s-maxage=20");
    expect(await response.json()).toMatchObject({ postId: fixture.document.id, updates: [{ id: "entry-one", updatedAt: stamp }] });
    const reads = h.calls.length;
    h.advance(19_000);
    expect((await h.request(worker, `${path}?live-blog=updates`))!.status).toBe(200);
    expect(h.calls).toHaveLength(reads);
    const ordinary = (await h.request(worker, `${path}?live-blog=other`))!;
    expect(ordinary.headers.get("content-type")).toContain("text/html");
  });
  it("keeps dev authority purge tags independent of production in a shared cache", async () => {
    const cache = cacheBoundary();
    const prod = harness(cache);
    const dev = harness(cache);
    await prod.request(); await prod.drain();
    const target = publicationTarget("development");
    const request = () => dev.worker(target).fetch(new Request(`${target.origin}${path}`));
    await request(); await dev.drain();
    expect([...new Set(cache.values().map(entry => entry.headers.get("cache-tag")))].sort())
      .toEqual(["njpbs-dev-post-background", "njpbs-post-background"]);
    cache.purge("njpbs-dev-post-background");
    expect([...new Set(cache.values().map(entry => entry.headers.get("cache-tag")))]).toEqual(["njpbs-post-background"]);
    const before = dev.calls.length;
    const productionReads = prod.calls.length;
    await request(); await dev.drain();
    expect(dev.calls.length).toBe(before + 1);
    await prod.request(); await prod.drain();
    expect(prod.calls.length).toBe(productionReads);
    cache.purge("njpbs-post-background");
    expect([...new Set(cache.values().map(entry => entry.headers.get("cache-tag")))]).toEqual(["njpbs-dev-post-background"]);
  });

  it("awaits cold authority before answering a Post absent from full-build Assets", async () => {
    const h = harness();
    h.assets(404);
    const held = deferred<NoBuildPostReply>();
    const started = deferred<void>();
    h.authority(async route => {
      if (route !== "/_publication.json") return post;
      started.resolve();
      return held.promise;
    });
    const response = h.request();
    await started.promise;
    held.resolve(catalog);
    const result = await response;
    expect(result!.status).toBe(200);
    expect(result!.headers.has("x-njpbs-publication-refresh")).toBe(false);
    expect(await result!.text()).toContain("A published fixture");
    await h.drain();
  });

  it("keeps unowned detail catalog warm while checking independent aggregate ownership", async () => {
    const h = harness();
    h.route({ kind: "pass" });
    for (const pathname of [path, "/posts/another-post/", "/authors/ada/", "/feeds/news.xml", "/_content-status.json", "/"]) {
      expect(await (await h.request(h.worker(), pathname))!.text()).toBe("Full-build Assets");
    }
    expect(h.calls.map(call => call.path)).toEqual(["/_publication.json", "/authors/ada/", "/feeds/news.xml"]);
    h.advance(10_000);
    expect(await (await h.request())!.text()).toBe("Full-build Assets");
    await h.drain();
    expect(h.calls).toHaveLength(4);
  });

  it("serves context-owned feed/search bytes without any Post ownership and preserves the Assets outage copy", async () => {
    const h = harness();
    h.route({ kind: "background", status: 200, bytes: btoa("Current context without withdrawn content"), headers: {
      "x-njpbs-public-context-revision": "1", "x-njpbs-background-renderer-sha": rendererSha,
      "x-njpbs-background-context-sha256": "b".repeat(64),
      "x-njpbs-background-purge-tag": "njpbs-post-background",
    } });
    for (const path of ["/feeds/news.xml", "/search/meaning-index.json"]) {
      const response = await h.request(h.worker(), path);
      expect(response!.status).toBe(200);
      expect(await response!.text()).toBe("Current context without withdrawn content");
    }
    await h.drain();
    h.advance(40_000);
    h.authority(async () => { throw new Error("Context authority unavailable"); });
    for (const path of ["/feeds/news.xml", "/search/meaning-index.json"]) {
      const response = await h.request(h.worker(), path);
      expect(response!.status).toBe(200);
      expect(await response!.text()).toBe("Full-build Assets");
    }
    await h.drain();
  });

  it.each(["/feeds/news.xml", "/pagefind/large.pf_fragment"])("serves and caches a valid family above the small authority DTO limit at %s", async pathname => {
    const h = harness();
    const content = "A".repeat(1_600_000);
    h.route({ kind: "background", status: 200, bytes: btoa(content), headers: {
      "x-njpbs-public-context-revision": "1", "x-njpbs-background-renderer-sha": rendererSha,
      "x-njpbs-background-context-sha256": "b".repeat(64), "x-njpbs-background-purge-tag": "njpbs-post-background",
    } });
    const first = await h.request(h.worker(), pathname);
    expect(await first!.text()).toBe(content);
    await h.drain();
    const calls = h.calls.length;
    const cached = await h.request(h.worker(), pathname, { method: "HEAD" });
    expect(cached!.status).toBe(200);
    expect(await cached!.text()).toBe("");
    expect(h.calls).toHaveLength(calls);
    expect(h.calls.every(call => call.path === pathname)).toBe(true);
  });


  it("awaits healthy catalog revalidation before serving an unowned static Post", async () => {
    const h = harness();
    await warm(h);
    h.advance(10_000);
    const held = deferred<NoBuildPostReply>();
    const started = deferred<void>();
    h.authority(() => { started.resolve(); return held.promise; });
    const request = h.request(h.worker(), "/posts/unowned/");
    await started.promise;
    held.resolve(catalog);
    const response = await request;
    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe("Full-build Assets");
    await h.drain();
  });


  it("selects a newly owned tombstone when the unowned catalog refresh completes", async () => {
    const h = harness();
    await warm(h);
    const gone = { ...receipt, postId: "new-post", slug: "new-withdrawal", ownedSlugs: ["new-withdrawal"], visible: false };
    h.catalog({ ...catalog, catalog: { ...catalog.catalog!, posts: [receipt, gone] } });
    h.route({ kind: "gone", receipt: gone });
    h.advance(10_000);
    const response = await h.request(h.worker(), "/posts/new-withdrawal/");
    expect(response!.status).toBe(410);
    expect(response!.headers.get("x-njpbs-publication-operation")).toBe(gone.operationId);
    expect(await response!.text()).toBe("");
    await h.drain();
  });


  it("joins simultaneous cold reads in one isolate", async () => {
    const h = harness();
    h.assets(404);
    const held = deferred<NoBuildPostReply>();
    const started = deferred<void>();
    h.authority(async route => {
      if (route !== "/_publication.json") return post;
      started.resolve();
      return held.promise;
    });
    const responses = Promise.all(Array.from({ length: 6 }, () => h.request(h.worker())));
    await started.promise;
    held.resolve(catalog);
    expect((await responses).every(response => response!.status === 200)).toBe(true);
    await h.drain();
    expect(h.calls.filter(call => call.path === "/_publication.json")).toHaveLength(1);
    expect(h.calls.filter(call => call.path === path)).toHaveLength(1);
  });

  it("negative-caches sanitized failures for only one second", async () => {
    const h = harness();
    h.assets(404);
    h.authority(async () => { throw new Error("Private provider error details"); });
    const failed = await h.request();
    expect(failed!.status).toBe(404);
    expect(failed!.headers.get("x-njpbs-publication-refresh")).toBe("pending");
    await h.drain();
    for (let index = 0; index < 4; index++) expect((await h.request())!.status).toBe(404);
    expect(h.calls).toHaveLength(1);
    for (const entry of h.cache.values()) expect(await entry.text()).not.toContain("Private provider error");
    h.catalog(catalog);
    h.authority(undefined);
    h.advance(1_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
  });

  it("refuses malformed and oversized authority and retries after one second", async () => {
    for (const reply of [{ kind: "receipts" }, { kind: "pass", unexpected: "a".repeat(2 * 1024 * 1024) }]) {
      const h = harness();
      h.authority(async () => reply as NoBuildPostReply);
      expect(await (await h.request())!.text()).toBe("Full-build Assets");
      expect(await (await h.request())!.text()).toBe("Full-build Assets");
      expect(h.calls).toHaveLength(1);
      h.advance(1_000);
      h.authority(undefined);
      await warm(h);
    }
  });

  it("refreshes a corrupted catalog before selecting dynamic HTML", async () => {
    const h = harness();
    await warm(h);
    h.assets(404);
    await h.cache.corruptCatalog({ kind: "receipts" });
    const response = await h.request();
    expect(response!.status).toBe(200);
    expect(await response!.text()).toContain("A published fixture");
    await h.drain();
  });

  it("bounds a cold authority timeout to three seconds and recovers after one second", async () => {
    const h = harness();
    h.assets(404);
    const held = deferred<NoBuildPostReply>();
    const started = deferred<void>();
    h.authority(() => { started.resolve(); return held.promise; });
    const request = h.request();
    await started.promise;
    await vi.advanceTimersByTimeAsync(3_000);
    const failed = await request;
    expect(failed!.status).toBe(404);
    expect(failed!.headers.get("x-njpbs-publication-refresh")).toBe("pending");
    await h.drain();
    held.resolve(catalog);
    h.authority(undefined);
    h.catalog(catalog);
    h.advance(1_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
  });

  it("bounds unavailable route authority without discarding the warm catalog", async () => {
    const h = harness();
    h.assets(404);
    h.authority(async route => {
      if (route === "/_publication.json") return catalog;
      throw new Error("Private route outage");
    });
    expect((await h.request())!.status).toBe(404);
    for (let index = 0; index < 3; index++) expect((await h.request())!.status).toBe(404);
    expect(h.calls.map(call => call.path)).toEqual(["/_publication.json", path]);
    for (const entry of h.cache.values()) expect(await entry.text()).not.toContain("Private route outage");
    h.authority(undefined);
    h.advance(1_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
  });

  it("does not flap at independent catalog and route expiry or on a cold HEAD", async () => {
    const h = harness();
    h.catalog(catalog);
    h.assets(404);
    expect((await h.request(h.worker(), "/posts/unowned/"))!.status).toBe(404);
    h.advance(2_000);
    expect((await h.request())!.status).toBe(200);
    h.advance(8_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
    h.advance(2_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
    const head = await h.request(h.worker(), path, { method: "HEAD" });
    expect(head!.status).toBe(200);
    expect(head!.headers.get("x-njpbs-source-version")).toBe("7");
    expect(await head!.text()).toBe("");
    expect(h.calls.filter(call => call.method === "HEAD")).toHaveLength(0);
  });

  it("serves bounded last-good HTML while authority revalidation is in flight", async () => {
    const h = harness();
    await warm(h);
    h.assets(404);
    const held = deferred<NoBuildPostReply>();
    const started = deferred<void>();
    h.authority(() => { started.resolve(); return held.promise; });
    h.advance(10_000);
    const response = await h.request();
    expect(response!.status).toBe(200);
    expect(await response!.text()).toContain("A published fixture");
    await started.promise;
    held.resolve(catalog);
    await h.drain();
  });

  it("retains last-good HTML on refresh failure with one-second retry throttling", async () => {
    const h = harness();
    await warm(h);
    h.assets(404);
    h.authority(async () => { throw new Error("Authority outage"); });
    h.advance(10_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
    const calls = h.calls.length;
    for (let index = 0; index < 3; index++) expect((await h.request())!.status).toBe(200);
    expect(h.calls).toHaveLength(calls);
    h.advance(1_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
    expect(h.calls.length).toBeGreaterThan(calls);
  });

  it("does not extend last-good authority forever during an outage", async () => {
    const h = harness();
    await warm(h);
    h.assets(404);
    h.authority(async () => { throw new Error("Authority outage"); });
    h.advance(39_999);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
    h.advance(1);
    expect((await h.request())!.status).toBe(404);
    await h.drain();
  });

  it.each(["paused", "removed"])("rechecks %s authority during last-good serving", async mode => {
    const h = harness();
    await warm(h);
    if (mode === "paused") h.authority(async () => { throw new Error("Admission unavailable"); });
    else h.catalog({ kind: "pass" });
    h.advance(10_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
    if (mode === "removed") expect(await (await h.request())!.text()).toBe("Full-build Assets");
    else {
      expect(await (await h.request())!.text()).toContain("A published fixture");
      h.advance(30_000);
      expect(await (await h.request())!.text()).toBe("Full-build Assets");
    }
    await h.drain();
  });

  it("keeps a slow render within its bounded authority snapshot and renews expired input", async () => {
    const h = harness();
    h.catalog(catalog);
    h.render(async () => { h.advance(10_000); return "<!doctype html><html>Slow current body</html>"; });
    expect(await (await h.request())!.text()).toContain("Slow current body");
    await h.drain();
    h.cache.purge("njpbs-post-background");
    h.cache.purge("njpbs-post-shadow-fixture");
    const next = nextVersion();
    let renders = 0;
    h.render(async content => {
      if (++renders === 1) {
        h.advance(40_000);
        h.catalog(next.catalog);
        h.route(next.post);
        return "<!doctype html><html>Expired body</html>";
      }
      return `<!doctype html><html>${content.posts[0].title}</html>`;
    });
    const renewed = await h.request();
    expect(renewed!.status).toBe(200);
    expect(renewed!.headers.get("x-njpbs-source-version")).toBe("8");
    expect(await renewed!.text()).toContain("New published version");
    await h.drain();
  });

  it("renews a last-good catalog that expires during a healthy cold route read", async () => {
    const h = harness();
    h.catalog(catalog);
    await h.request(h.worker(), "/posts/unowned/");
    h.assets(404);
    h.advance(39_500);
    h.authority(async pathname => {
      if (pathname === "/_publication.json") return catalog;
      h.advance(1_000);
      return post;
    });
    const response = await h.request();
    expect(response!.status).toBe(200);
    expect(await response!.text()).toContain("A published fixture");
    await h.drain();
  });

  it("serves the new stored snapshot on the first request after purge without old render bytes", async () => {
    const h = harness();
    await warm(h);
    h.assets(404);
    const next = nextVersion();
    h.catalog(next.catalog);
    h.route(next.post);
    h.cache.purge("njpbs-post-background");
    for (let index = 0; index < 4; index++) {
      const response = await h.request(h.worker());
      expect(response!.status).toBe(200);
      expect(response!.headers.get("x-njpbs-source-version")).toBe("8");
      expect(response!.headers.get("x-njpbs-publication-operation")).toBe(next.post.receipt!.operationId);
      expect(response!.headers.has("x-njpbs-publication-refresh")).toBe(false);
      expect(await response!.text()).toContain("New published version");
    }
    await h.drain();
  });

  it.each([
    ["publish", "completed"], ["publish", "in-flight"],
    ["withdraw", "completed"], ["withdraw", "in-flight"],
  ])("fences %s across %s refreshes after publication purge", async (operation, completion) => {
    const h = harness();
    await warm(h);
    h.assets(404);
    const heldCatalog = deferred<NoBuildPostReply>();
    const heldRoute = deferred<NoBuildPostReply>();
    const catalogStarted = deferred<void>();
    const routeStarted = deferred<void>();
    h.authority(async pathname => {
      if (pathname === "/_publication.json") {
        catalogStarted.resolve();
        return heldCatalog.promise;
      }
      routeStarted.resolve();
      return heldRoute.promise;
    });
    h.advance(10_000);
    expect((await h.request())!.status).toBe(200);
    await Promise.all([catalogStarted.promise, routeStarted.promise]);

    const next = nextVersion();
    const gone = { ...receipt, visible: false, operationId: "C1b2C3d4E5f6G7h8I9j0" };
    h.catalog(operation === "publish" ? next.catalog : { ...catalog, catalog: { ...catalog.catalog!, posts: [gone] } });
    h.route(operation === "publish" ? next.post : { kind: "gone", receipt: gone });
    h.authority(undefined);
    h.cache.purge("njpbs-post-background");
    let first: Response | null;
    if (completion === "completed") {
      heldCatalog.resolve(catalog);
      heldRoute.resolve(post);
      await h.drain();
      first = await h.request(h.worker());
    } else {
      try {
        // The fresh response is the barrier; old refreshes stay unresolved.
        first = await h.request(h.worker());
      } finally {
        heldCatalog.resolve(catalog);
        heldRoute.resolve(post);
        await h.drain();
      }
    }

    // The ordinary post-purge view must use the accepted operation. Assets has
    // no detail for this Post, so a cache race cannot be masked by static HTML.
    for (const method of ["GET", "HEAD"]) {
      const response = method === "GET" ? first : await h.request(h.worker(), path, { method });
      expect(response!.status).toBe(operation === "publish" ? 200 : 410);
      expect(response!.headers.get("x-njpbs-publication-operation")).toBe(operation === "publish" ? next.post.receipt!.operationId : gone.operationId);
      expect(response!.headers.has("x-njpbs-publication-refresh")).toBe(false);
      if (method === "GET" && operation === "publish") expect(await response!.text()).toContain("New published version");
      else expect(await response!.text()).toBe("");
    }
    await h.drain();
  });

  it.each(["publish", "withdraw"])("fences %s while old authority cache puts cross the purge", async operation => {
    const h = harness();
    await warm(h);
    h.assets(404);
    const held = deferred<void>();
    const catalogPut = deferred<void>();
    const routePut = deferred<void>();
    const put = h.cache.put;
    h.cache.put = async (key, response) => {
      const url = new URL(key instanceof Request ? key.url : String(key));
      if (response.headers.get("content-type") === "application/json" && url.searchParams.has("kind")) {
        if (url.searchParams.get("kind") === "catalog") catalogPut.resolve();
        else routePut.resolve();
        await held.promise;
      }
      await put(key, response);
    };
    h.advance(10_000);
    expect((await h.request())!.status).toBe(200);
    await Promise.all([catalogPut.promise, routePut.promise]);

    const next = nextVersion();
    const gone = { ...receipt, visible: false, operationId: "C1b2C3d4E5f6G7h8I9j0" };
    h.catalog(operation === "publish" ? next.catalog : { ...catalog, catalog: { ...catalog.catalog!, posts: [gone] } });
    h.route(operation === "publish" ? next.post : { kind: "gone", receipt: gone });
    h.cache.purge("njpbs-post-background");
    held.resolve();
    await h.drain();
    const response = await h.request(h.worker());
    expect(response!.status).toBe(operation === "publish" ? 200 : 410);
    expect(response!.headers.get("x-njpbs-publication-operation")).toBe(operation === "publish" ? next.post.receipt!.operationId : gone.operationId);
    expect(response!.headers.has("x-njpbs-publication-refresh")).toBe(false);
    if (operation === "publish") expect(await response!.text()).toContain("New published version");
    else expect(await response!.text()).toBe("");
    await h.drain();
  });

  it.each(["publish", "withdraw"])("renews %s authority if a purge crosses rendering", async operation => {
    const h = harness();
    await warm(h);
    h.assets(404);
    const next = nextVersion();
    const gone = { ...receipt, visible: false, operationId: "C1b2C3d4E5f6G7h8I9j0" };
    let renders = 0;
    h.render(async content => {
      if (++renders === 1) {
        h.catalog(operation === "publish" ? next.catalog : { ...catalog, catalog: { ...catalog.catalog!, posts: [gone] } });
        h.route(operation === "publish" ? next.post : { kind: "gone", receipt: gone });
        h.cache.purge("njpbs-post-background");
      }
      return `<!doctype html><html>${content.posts[0].title}</html>`;
    });
    const response = await h.request(h.worker(), `${path}?uncached-render=1`);
    expect(response!.status).toBe(operation === "publish" ? 200 : 410);
    expect(response!.headers.get("x-njpbs-publication-operation")).toBe(operation === "publish" ? next.post.receipt!.operationId : gone.operationId);
    if (operation === "publish") expect(await response!.text()).toContain("New published version");
    else expect(await response!.text()).toBe("");
    await h.drain();
  });

  it("refreshes new bytes after expiry without a purge or a 404 response", async () => {
    const h = harness();
    await warm(h);
    h.assets(404);
    const next = nextVersion();
    h.catalog(next.catalog);
    h.route(next.post);
    h.advance(10_000);
    expect((await h.request())!.status).toBe(200);
    await h.drain();
    const response = await h.request();
    expect(response!.status).toBe(200);
    expect(await response!.text()).toContain("New published version");
    await h.drain();
  });

  it("returns 410 for every retained withdrawn slug on the first purged request", async () => {
    const h = harness();
    await warm(h);
    h.assets(404);
    const gone = { ...receipt, visible: false, operationId: "C1b2C3d4E5f6G7h8I9j0" };
    h.catalog({ ...catalog, catalog: { ...catalog.catalog!, posts: [gone] } });
    h.route({ kind: "gone", receipt: gone });
    h.cache.purge("njpbs-post-background");
    for (const slug of receipt.ownedSlugs) {
      for (const method of ["GET", "HEAD"]) {
        const response = await h.request(h.worker(), `/posts/${slug}/`, { method });
        expect(response!.status).toBe(410);
        expect(response!.headers.get("x-njpbs-publication-operation")).toBe(gone.operationId);
        expect(await response!.text()).toBe("");
      }
    }
    await h.drain();
  });

  it("keeps rename aliases inside authority on a cold route", async () => {
    const h = harness();
    h.catalog(catalog);
    h.route({ kind: "alias", receipt, location: path });
    h.assets(404);
    const response = await h.request(h.worker(), "/posts/old-fixture/");
    expect(response!.status).toBe(308);
    expect(response!.headers.get("location")).toBe(path);
    await h.drain();
  });

  it("does not consult authority for unrelated Assets, Contact or static client assets", async () => {
    const h = harness();
    for (const pathname of ["/about/", "/contact/", "/brand/logo.svg", "/posts/_no-build-assets/client.js"]) {
      expect(await h.request(h.worker(), pathname)).toBeNull();
    }
    expect(await (await h.request(h.worker(), "/_astro/client.js"))!.text()).toBe("Full-build Assets");
    expect(h.calls).toHaveLength(0);
  });

  it("shares normalized ownership across encoded and directory-index spellings", async () => {
    const h = harness();
    h.catalog(catalog);
    h.assets(404);
    for (const pathname of ["/posts/%73hadow-fixture/", "/posts/shadow-fixture/index.html", "/posts/shadow-fixture"]) {
      expect((await h.request(h.worker(), pathname))!.status).toBe(200);
    }
    expect(h.calls.map(call => call.path)).toEqual(["/_publication.json", path]);
    expect((await h.request(h.worker(), "/posts/%255cshadow-fixture/"))!.status).toBe(404);
    await h.drain();
  });

  it("can serve current HTML when Cache API storage is unavailable", async () => {
    const h = harness(cacheBoundary(true));
    h.catalog(catalog);
    h.assets(404);
    const response = await h.request();
    expect(response!.status).toBe(200);
    expect(await response!.text()).toContain("A published fixture");
    await h.drain();
  });

  it.each(["failed", "slow"])("keeps fresh Post HTML when Cache API lookups are %s but writes succeed", async mode => {
    // Native Web Crypto digests must settle while the lookup deadlines elapse.
    vi.useRealTimers();
    const cache = cacheBoundary();
    cache.match = async () => {
      if (mode === "failed") throw new Error("Cache lookup unavailable");
      return new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 200));
    };
    const h = harness(cache);
    h.catalog(catalog);
    h.assets(404);
    const response = await h.request();
    expect(response!.status).toBe(200);
    expect(response!.headers.has("x-njpbs-publication-refresh")).toBe(false);
    expect(await response!.text()).toContain("A published fixture");
    await h.drain();
    for (const entry of cache.values()) expect(entry.headers.has("x-njpbs-authority-expires-at")).toBe(false);
  });

  it("keeps concurrent uncached Post reads within three seconds during a cache write outage", async () => {
    vi.useRealTimers();
    const cache = cacheBoundary(false, true);
    const h = harness(cache);
    h.assets(404);
    h.authority(async pathname => {
      await new Promise<void>(resolve => setTimeout(resolve, 500));
      return pathname === "/_publication.json" ? catalog : post;
    });
    const responses = await Promise.all(Array.from({ length: 6 }, () => h.request(h.worker())));
    await h.drain();
    for (const response of responses) {
      expect(response!.status).toBe(200);
      expect(response!.headers.has("x-njpbs-publication-refresh")).toBe(false);
      expect(await response!.text()).toContain("A published fixture");
    }
  });

  it.each(["/feeds/news.xml", "/sitemap-index.xml", "/search/meaning-index.json"])("keeps cold background bytes on %s", async pathname => {
    const h = harness();
    h.catalog(catalog);
    const bytes = pathname.endsWith(".json") ? '{"entries":[]}' : '<root>Current public output</root>';
    h.route({ kind: "background", status: 200, bytes: btoa(bytes), headers: {
      "x-njpbs-admission-revision": "1", "x-njpbs-background-renderer-sha": rendererSha,
      "x-njpbs-background-purge-tag": "njpbs-post-background",
    } });
    h.assets(404);
    const head = await h.request(h.worker(), pathname, { method: "HEAD" });
    expect(head!.status).toBe(200);
    expect(await head!.text()).toBe("");
    const response = await h.request(h.worker(), pathname);
    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe(bytes);
    await h.drain();
  });

  it("keeps target identities distinct and preserves a sealed dev origin", async () => {
    const h = harness();
    await warm(h);
    h.authority(async () => ({ kind: "pass" }));
    const dev = h.worker(publicationTarget("development"));
    const response = await dev.fetch(new Request("https://dev-public.example.org/_publication.json"));
    expect(response!.headers.get("x-njpbs-publication-origin")).toBe("template-dev-public");
    expect(h.calls).toHaveLength(3);
    expect(await dev.fetch(new Request(`${origin}${path}`))).toBeNull();
    const sealed = h.worker(publicationTarget("development"), false);
    expect(await (await sealed.fetch(new Request(`https://dev-public.example.org${path}`)))!.text()).toBe("Full-build Assets");
    expect(h.calls).toHaveLength(3);
    await h.drain();
  });

  it("bypasses all caches for leased candidate probes and refuses unknown or pass probes", async () => {
    const h = harness();
    h.authority(async (_path, _method, probe) => {
      if (probe?.buildBatchId === "known" && probe.versionId === "known-version") return { kind: "baseline-probe" };
      if (probe?.buildBatchId === "pass") return { kind: "pass" };
      throw new Error("Unknown candidate");
    });
    const worker = h.worker();
    expect(await h.request(worker, "/_publication.json?candidate=known&version=known-version")).toBeNull();
    expect(await h.request(worker, "/_publication.json?candidate=known&version=known-version")).toBeNull();
    for (const candidate of ["unknown", "pass"]) {
      const response = await h.request(worker, `/_publication.json?candidate=${candidate}&version=known-version`);
      expect(response!.status).toBe(503);
      expect(response!.headers.has("x-njpbs-publication-origin")).toBe(false);
      expect(await response!.text()).not.toBe("Full-build Assets");
    }
    expect(h.calls.filter(call => call.probe)).toHaveLength(4);
  });
});

it.each(["GET", "HEAD"])("keeps a republished custom-link Post visible through its retained withdrawal fence with %s", async method => {
  const published = structuredClone(fixture);
  Object.assign(published.document.published.metadata, { contentLinkMode: "custom", contentLinkUrl: "https://example.test/reopened", contentLinkNewTab: true });
  const marker = { postId: fixture.document.id, sourceVersion: 6, revision: 1, operationId: "W".repeat(20), ownedSlugs: ["shadow-fixture"], verifiedAt: 1234 };
  const current = { ...receipt, generation: 2 };
  const cache = cacheBoundary();
  const worker = createTransitionalPostReadWorker({ rendererSha, cache, now: () => Date.parse("2026-11-02T20:00:00.000Z"),
    getDecision: async () => ({ kind: "post", receipt: current, published }), readWithdrawal: async () => marker,
    fetchAsset: async () => new Response("Stale body"), render: async () => "<!doctype html><html><body>Retained body</body></html>" });
  const response = (await worker.fetch(new Request(origin + path, { method })))!;
  expect(response.status).toBe(302); expect(response.headers.get("location")).toBe("https://example.test/reopened");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  Object.assign(published.document.published.metadata, { contentLinkMode: "normal" });
  published.document.published.sourceVersion = 8; current.sourceVersion = 8; current.generation = 3;
  cache.purge("njpbs-post-background");
  const restored = (await worker.fetch(new Request(origin + path, { method })))!;
  expect(restored.status).toBe(200); expect(restored.headers.has("location")).toBe(false);
});
