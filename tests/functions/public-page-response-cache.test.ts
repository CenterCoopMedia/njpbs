import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createNoBuildPageWorker } from "../../workers/src/no-build-page-worker";
import { createPublicPageResponseCache, cacheablePageRequest } from "../../workers/src/public-page-response-cache";
import { publicationTarget } from "../../functions/lib/publication-target";
import type { NoBuildPageReply } from "../../cms-api/src/index";

const rendererSha = "a".repeat(40), initial = Date.parse("2026-10-17T12:00:00Z");
const target = publicationTarget("production");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function decision(revision = 1): NoBuildPageReply {
  const contextDigest = sha(`njpbs-public-context-v1:${revision}`);
  return { kind: "context-page", decisionCacheUntil: initial + 60_000,
    contextReceipt: { rendererSha, contextRevision: revision, contextDigest, codeGeneration: 1, path: "/contact/", source: "site" },
    renderContext: { kind: "published-page-context", pageId: "contact", path: "/contact/", page: null,
      sourceSeal: { rendererSha, contextRevision: revision, contextDigest, codeGeneration: 1 },
      posts: [], assets: [], joinedRecords: [], settings: [], navigationPages: [] } };
}
function setup(environment = "production") {
  let time = initial, current = decision();
  const entries = new Map<string, Response>();
  const cache = { match: vi.fn(async (key: RequestInfo) => entries.get((key as Request).url)?.clone()),
    put: vi.fn(async (key: RequestInfo, response: Response) => { entries.set((key as Request).url, response.clone()); }) };
  const getDecision = vi.fn(async () => structuredClone(current));
  const renderContext = vi.fn(async () => `<!doctype html><html>Public revision ${current.contextReceipt?.contextRevision}</html>`);
  const render = vi.fn(async () => "<!doctype html><html>Published receipt Page</html>");
  const readWithdrawal = vi.fn(async () => null as any);
  const fetchAsset = vi.fn(async () => new Response("Assets fallback"));
  const worker = createNoBuildPageWorker({ target: publicationTarget(environment), rendererSha, rendererReady: true, cache,
    getDecision, renderContext, readWithdrawal, fetchAsset, render, now: () => new Date(time) });
  return { worker, entries, cache, getDecision, renderContext, render, readWithdrawal, fetchAsset,
    setDecision(value: NoBuildPageReply) { current = value; }, setTime(value: number) { time = value; } };
}
const request = (suffix = "", init?: RequestInit) => new Request(`${target.origin}/contact/${suffix}`, init);

it("uses two decisions cold and one fresh decision per warm public response", async () => {
  const s = setup();
  expect((await s.worker.fetch(request()))?.headers.get("x-njpbs-page-cache")).toBe("miss");
  expect(s.getDecision).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 10; i++) {
    const response = await s.worker.fetch(request());
    expect(await response!.text()).toContain("Public revision 1");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(response!.headers.get("x-njpbs-page-cache")).toBe("hit");
  }
  expect(s.getDecision).toHaveBeenCalledTimes(12); // Previously 22; every warm hit still validates authority.
  expect(s.renderContext).toHaveBeenCalledTimes(1);
  expect(s.cache.match).toHaveBeenCalledTimes(12);
  expect(s.cache.put).toHaveBeenCalledTimes(2);
  expect(s.readWithdrawal).toHaveBeenCalledTimes(12); // Cold context renders also fence durable withdrawal.
});

it("discovers completed responses in another isolate before checking fresh authority", async () => {
  const s = setup();
  await s.worker.fetch(request());
  vi.resetModules();
  const { createNoBuildPageWorker: freshWorker } = await import("../../workers/src/no-build-page-worker");
  const worker = freshWorker({ target, rendererSha, rendererReady: true, cache: s.cache,
    getDecision: s.getDecision, renderContext: s.renderContext, render: s.render,
    readWithdrawal: s.readWithdrawal, fetchAsset: s.fetchAsset, now: () => new Date(initial) });
  const response = (await worker.fetch(request()))!;
  expect(response.headers.get("x-njpbs-page-cache")).toBe("hit");
  expect(response.headers.get("x-njpbs-page-cache-revision")).toBeNull();
  expect(response.headers.get("x-njpbs-page-cache-until")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("Public revision 1");
  expect(s.getDecision).toHaveBeenCalledTimes(3);
  expect(s.renderContext).toHaveBeenCalledTimes(1);
});

it.each([
  ["x-njpbs-page-cache-revision", "invalid"],
  ["x-njpbs-page-cache-until", String(initial)],
  ["x-njpbs-page-cache-until", String(initial + 60_001)],
])("ignores unqualified stored metadata (%s: %s)", async (header, value) => {
  const s = setup();
  await s.worker.fetch(request());
  for (const [key, stored] of s.entries) if (key.includes("__public-page-response")) {
    const headers = new Headers(stored.headers);
    headers.set(header, value);
    s.entries.set(key, new Response(await stored.text(), { headers }));
  }
  expect((await s.worker.fetch(request()))!.headers.get("x-njpbs-page-cache")).toBe("miss");
  expect(s.getDecision).toHaveBeenCalledTimes(4);
});

it("keeps a different renderer from discovering a prior release's response", async () => {
  const s = setup();
  await s.worker.fetch(request());
  const next = createPublicPageResponseCache({ cache: s.cache, target, rendererSha: "b".repeat(40), now: () => initial });
  expect(await next.read("/contact/")).toBeUndefined();
  expect(await next.read("/about/")).toBeUndefined();
});

it("sees publication, withdrawal and origin refusal on the next request", async () => {
  const s = setup();
  await s.worker.fetch(request());
  s.setDecision(decision(2));
  expect(await (await s.worker.fetch(request()))!.text()).toContain("Public revision 2");
  expect(s.getDecision).toHaveBeenCalledTimes(4);
  s.setDecision({ ...decision(3), kind: "gone" });
  expect((await s.worker.fetch(request()))!.status).toBe(410);
  s.getDecision.mockRejectedValue(new Error("Authority unavailable"));
  expect(await (await s.worker.fetch(request()))!.text()).toBe("Assets fallback");
});

it("finishes cache reads before fresh authority and honors a new durable withdrawal", async () => {
  const s = setup();
  await s.worker.fetch(request());
  let withdrawing = false;
  s.cache.match.mockImplementation(async key => {
    withdrawing = true;
    return s.entries.get((key as Request).url)?.clone();
  });
  s.getDecision.mockImplementation(async () => {
    expect(withdrawing).toBe(true);
    return { ...decision(2), kind: "gone" };
  });
  expect((await s.worker.fetch(request()))!.status).toBe(410);
  s.getDecision.mockResolvedValue(decision());
  s.readWithdrawal.mockResolvedValue({ pageId: "contact", operationId: "A".repeat(20), sourceVersion: 7,
    revision: 3, ownedPaths: ["/contact/"], verifiedAt: initial });
  expect((await s.worker.fetch(request()))!.status).toBe(410);
});

it("rechecks withdrawal when a retry reuses a newer cached context", async () => {
  const s = setup();
  s.setDecision(decision(2));
  await s.worker.fetch(request());
  s.getDecision.mockReset().mockResolvedValueOnce(decision(1)).mockResolvedValue(decision(2));
  s.renderContext.mockClear().mockImplementationOnce(async () => "<!doctype html><html>Older context 1</html>");
  s.readWithdrawal.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ pageId: "contact",
    operationId: "W".repeat(20), sourceVersion: 7, revision: 3, ownedPaths: ["/contact/"], verifiedAt: initial });
  const response = (await s.worker.fetch(request()))!;
  expect(response.status).toBe(410);
  expect(s.getDecision).toHaveBeenCalledTimes(2);
  expect(s.renderContext).toHaveBeenCalledTimes(1);
  expect(s.readWithdrawal).toHaveBeenCalledTimes(2);
  expect(s.fetchAsset).not.toHaveBeenCalled();
});

it("never extends the origin lease and ignores renewed transport metadata in the render fence", async () => {
  const s = setup();
  await s.worker.fetch(request());
  s.setTime(initial + 60_000);
  s.setDecision({ ...decision(), decisionCacheUntil: initial + 120_000 });
  expect((await s.worker.fetch(request()))!.headers.get("x-njpbs-page-cache")).toBe("miss");
  expect(s.getDecision).toHaveBeenCalledTimes(4);
  s.setDecision({ ...decision(), decisionCacheUntil: undefined });
  expect((await s.worker.fetch(request()))!.headers.get("x-njpbs-page-cache")).toBeNull();
  expect(s.getDecision).toHaveBeenCalledTimes(6);
});

it.each([{ headers: { authorization: "synthetic" } }, { headers: { cookie: "synthetic=1" } }, { method: "HEAD" }])(
  "bypasses all page caches for private or HEAD requests (%j)", async init => {
    const s = setup();
    await s.worker.fetch(request());
    s.cache.match.mockClear(); s.cache.put.mockClear();
    await s.worker.fetch(request("", init));
    expect(s.cache.match).not.toHaveBeenCalled();
    expect(s.cache.put).not.toHaveBeenCalled();
  });

it("does not cache queries, Schedule, Live, exports or preview origins", async () => {
  for (const path of ["/schedule/", "/live/", "/_schedule-sources.json", "/schedule/downloads/nj-pbs-schedule.pdf"]) {
    expect(cacheablePageRequest(new Request(`${target.origin}${path}`), path)).toBe(false);
  }
  const s = setup();
  await s.worker.fetch(request("?preview=1"));
  expect(s.cache.match).not.toHaveBeenCalled(); expect(s.cache.put).not.toHaveBeenCalled();
  const dev = createPublicPageResponseCache({ cache: s.cache, target: publicationTarget("development"), rendererSha, now: () => initial });
  await dev.store("/contact/", decision(), new Response("private")); await dev.read("/contact/");
  expect(s.cache.match).not.toHaveBeenCalled(); expect(s.cache.put).not.toHaveBeenCalled();
});

it("treats corrupt entries and cache failures as a miss", async () => {
  const s = setup();
  await s.worker.fetch(request());
  for (const [key, value] of s.entries) if (key.includes("__public-page-response")) s.entries.set(key, new Response("corrupt", { headers: value.headers }));
  expect((await s.worker.fetch(request()))!.headers.get("x-njpbs-page-cache")).toBe("miss");
  s.cache.match.mockRejectedValue(new Error("Cache unavailable"));
  s.cache.put.mockRejectedValue(new Error("Cache unavailable"));
  expect((await s.worker.fetch(request()))!.status).toBe(200);
});

it("revalidates after cold cache writes when a withdrawal arrives during the write", async () => {
  const s = setup();
  const write = s.cache.put.getMockImplementation()!;
  s.cache.put.mockImplementation(async (key, value) => {
    await write(key, value);
    if ((key as Request).url.includes("__public-page-response")) {
      s.setDecision({ ...decision(2), kind: "gone" });
      s.readWithdrawal.mockResolvedValue({ pageId: "contact", operationId: "A".repeat(20), sourceVersion: 7,
        revision: 3, ownedPaths: ["/contact/"], verifiedAt: initial });
    }
  });
  expect((await s.worker.fetch(request()))!.status).toBe(410);
});


it("does not put private development responses in either page cache", async () => {
  const s = setup("development");
  const response = await s.worker.fetch(new Request("https://dev-public.example.org/contact/"));
  expect(response!.status).toBe(200);
  expect(s.cache.match).not.toHaveBeenCalled();
  expect(s.cache.put).not.toHaveBeenCalled();
});


it.each([false, true])("keeps receipt-backed Page hits current (expiry race: %s)", async expiry => {
  const s = setup();
  const contextDigest = sha("njpbs-public-context-v1:1");
  s.setDecision({ kind: "page", decisionCacheUntil: initial + 60_000,
    receipt: { schemaVersion: 1, pageId: "contact", rendererSha, operationId: "A".repeat(20),
      sourceVersion: 7, snapshotDigest: "b".repeat(64), contextDigest, path: "/contact/", ownedPaths: ["/contact/"],
      generation: 3, operationGeneration: 3, codeGeneration: 1, visible: true, admissionRevision: 1 },
    published: { kind: "published-page", sourceSeal: { rendererSha, contextRevision: 1, contextDigest },
      page: { pageId: "contact", path: "/contact/", family: "article", template: "genericPage", title: "Published contact",
        contentMode: "published", sourceVersion: 7, publishedAt: "2026-10-12T12:00:00Z", blocks: [], assets: {} },
      posts: [], assets: [], joinedRecords: [], settings: [], navigationPages: [] } });
  const first = await s.worker.fetch(request());
  expect(first!.headers.get("x-njpbs-content-source")).toBe("cms-page-no-build");
  expect(first!.headers.get("x-njpbs-page-cache")).toBe("miss");
  const warm = await s.worker.fetch(request());
  expect(warm!.headers.get("x-njpbs-page-cache")).toBe("hit");
  expect(await warm!.text()).toContain("Published receipt Page");
  expect(s.getDecision).toHaveBeenCalledTimes(3);
  expect(s.render).toHaveBeenCalledTimes(1);
  if (expiry) {
    s.readWithdrawal.mockResolvedValueOnce(null).mockImplementationOnce(async () => {
      s.setTime(initial + 60_000); return null;
    });
    const response = await s.worker.fetch(request());
    expect(response!.status).toBe(200);
    expect(response!.headers.get("x-njpbs-page-cache")).toBeNull();
    expect(s.getDecision).toHaveBeenCalledTimes(5);
  } else {
    s.readWithdrawal.mockResolvedValueOnce(null).mockResolvedValue({ pageId: "contact", operationId: "B".repeat(20),
      sourceVersion: 8, revision: 4, ownedPaths: ["/contact/"], verifiedAt: initial });
    expect((await s.worker.fetch(request()))!.status).toBe(410);
    expect(s.getDecision).toHaveBeenCalledTimes(4);
  }
});

it("reuses the same publication across origin instances without extending its original expiry", async () => {
  const s = setup();
  await s.worker.fetch(request());
  s.setTime(initial + 10_000);
  s.setDecision({ ...decision(), decisionCacheUntil: initial + 55_000 });
  expect((await s.worker.fetch(request()))!.headers.get("x-njpbs-page-cache")).toBe("hit");
  expect(s.getDecision).toHaveBeenCalledTimes(3);
  s.setTime(initial + 60_000);
  s.setDecision({ ...decision(), decisionCacheUntil: initial + 120_000 });
  expect((await s.worker.fetch(request()))!.headers.get("x-njpbs-page-cache")).toBe("miss");
  expect(s.getDecision).toHaveBeenCalledTimes(5);
});


it("checks the original lease again after asynchronous digest work", async () => {
  let time = initial;
  const entries = new Map<string, Response>();
  const cache = { async match(key: RequestInfo) { return entries.get((key as Request).url)?.clone(); },
    async put(key: RequestInfo, value: Response) { entries.set((key as Request).url, value.clone()); } };
  const helper = createPublicPageResponseCache({ cache, target, rendererSha, now: () => time });
  const body = "<!doctype html><html>Public fixture</html>";
  await helper.store("/contact/", decision(), new Response(body, { headers: { "content-type": "text/html",
    "x-njpbs-content-source": "cms-page-context", "x-njpbs-html-sha256": sha(body) } }));
  const candidate = (await helper.read("/contact/"))!;
  const native = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    time = initial + 60_000; return native(...args);
  });
  try { expect(await helper.matches(candidate, decision())).toBe(false); }
  finally { spy.mockRestore(); }
});

// The Home lease uses the public fixtures and serialized Cache API responses;
// only the storage/network/clock boundaries are controlled here.
async function homeSetup() {
  const { publishedPageRead, retainedHomeSources } = await import("../../site/tests/fixtures/published-pages/fixtures");
  let time = initial, revision = 1;
  const entries = new Map<string, Response>();
  const cache = { match: vi.fn(async (key: Request) => entries.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, response: Response) => { entries.set(key.url, response.clone()); }) };
  const getDecision = vi.fn(async (): Promise<NoBuildPageReply> => {
    const published = publishedPageRead("home", rendererSha);
    published.posts[0].document.published.metadata.title = `Public Home ${revision}`;
    return { kind: "page", published, homeSources: retainedHomeSources(rendererSha), decisionCacheUntil: initial + 60_000,
      receipt: { schemaVersion: 1, pageId: "home", operationId: "H".repeat(20), rendererSha,
        sourceVersion: published.page.sourceVersion, snapshotDigest: "b".repeat(64),
        contextDigest: published.sourceSeal.contextDigest, path: "/", ownedPaths: ["/", "/_home-sources.json"],
        generation: 5, operationGeneration: 5, codeGeneration: 5, visible: true, admissionRevision: 1,
        homeRefreshRevision: revision } };
  });
  const render = vi.fn(async (content: any) => `<!doctype html><html>${content.posts[0].title}</html>`);
  const readWithdrawal = vi.fn(async () => null as any);
  const worker = createNoBuildPageWorker({ target, rendererSha, rendererReady: true, cache, getDecision, render,
    readWithdrawal, now: () => new Date(time), fetchAsset: async () => new Response("Assets") });
  const purge = async () => {
    for (const [key, response] of entries) if (response.headers.get("Cache-Tag") === "njpbs-post-background") entries.delete(key);
  };
  return { worker, entries, cache, getDecision, readWithdrawal, render, purge,
    setTime(value: number) { time = value; }, publish() { revision++; } };
}
const homeRequest = (init?: RequestInit) => new Request("https://njpbs.org/", init);

it("serves ten witnessed Home hits without origin RPCs and revalidates at ten seconds", async () => {
  const s = await homeSetup();
  expect((await s.worker.fetch(homeRequest()))!.headers.get("x-njpbs-page-cache")).toBe("miss");
  for (let i = 0; i < 10; i++) {
    const response = (await s.worker.fetch(homeRequest()))!;
    expect(await response.text()).toContain("Public Home 1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-njpbs-home-cache-fence")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
  }
  expect(s.getDecision).toHaveBeenCalledTimes(2);
  s.setTime(initial + 10_000);
  await s.worker.fetch(homeRequest());
  expect(s.getDecision).toHaveBeenCalledTimes(3);
  expect(s.render).toHaveBeenCalledTimes(1);
});

it("uses the existing background purge to select newly published Home on the next GET", async () => {
  const s = await homeSetup();
  await s.worker.fetch(homeRequest());
  s.publish(); await s.purge();
  expect(await (await s.worker.fetch(homeRequest()))!.text()).toContain("Public Home 2");
  expect(s.getDecision).toHaveBeenCalledTimes(4);
});

it("cannot resurrect a Home lease when purge races a late cache fill", async () => {
  const s = await homeSetup();
  const write = s.cache.put.getMockImplementation()!;
  let purged = false;
  s.cache.put.mockImplementation(async (key, response) => {
    if (!purged && response.headers.has("x-njpbs-home-cache-fence")) {
      purged = true; s.publish(); await s.purge();
    }
    await write(key, response);
  });
  await s.worker.fetch(homeRequest());
  expect(purged).toBe(true);
  expect(await (await s.worker.fetch(homeRequest()))!.text()).toContain("Public Home 2");
  expect(s.getDecision).toHaveBeenCalledTimes(4);
});

it("honors explicit Home revalidation and durable withdrawals while the lease is warm", async () => {
  const s = await homeSetup();
  await s.worker.fetch(homeRequest()); s.publish();
  expect(await (await s.worker.fetch(homeRequest({ headers: { "cache-control": "no-cache" } })))!.text()).toContain("Public Home 2");
  await s.worker.fetch(homeRequest());
  s.readWithdrawal.mockResolvedValue({ pageId: "home", operationId: "W".repeat(20), sourceVersion: 99,
    revision: 99, ownedPaths: ["/"], verifiedAt: initial });
  expect((await s.worker.fetch(homeRequest()))!.status).toBe(410);
});

it("bounds Home freshness from the start of a slow origin request", async () => {
  const s = await homeSetup();
  const read = s.getDecision.getMockImplementation()!;
  s.getDecision.mockImplementation(async () => { s.setTime(initial + 11_000); return read(); });
  await s.worker.fetch(homeRequest());
  await s.worker.fetch(homeRequest());
  expect(s.getDecision).toHaveBeenCalledTimes(3);
});
