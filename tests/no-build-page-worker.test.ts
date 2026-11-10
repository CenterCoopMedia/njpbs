import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { loadScheduleSourceSnapshot } from "../admin/src/lib/schedule-source-snapshot";
import { publicationTarget } from "../functions/lib/publication-target";
import { createNoBuildPageWorker, PUBLIC_PAGE_WAIT_MS } from "../workers/src/no-build-page-worker";
import { readDurablePageWithdrawal, encodePageWithdrawalManifest, pageWithdrawalManifestKey } from "../workers/src/durable-page-withdrawals";
import { publishedPageRead, fallbackPageRead, retainedHomeSources, now } from "../site/tests/fixtures/published-pages/fixtures";
import type { NoBuildPageReply } from "../cms-api/src/index";
import scheduleFixture from "../site/src/data/schedule-fixture.json";
import { buildScheduleExport } from "../site/src/lib/schedule-export";
import type { BakedScheduleData } from "../site/src/lib/schedule-feed";

const { fixture: _scheduleFixture, ...scheduleData } = scheduleFixture;
const rendererSha = "a".repeat(40);
function homeDecision(revision: number): NoBuildPageReply {
  const published = publishedPageRead("home", rendererSha);
  published.posts[0].document.published.metadata.title = `Election update ${revision}`;
  return { kind: "page", published, homeSources: retainedHomeSources(rendererSha),
    receipt: { schemaVersion: 1, pageId: "home", operationId: "H".repeat(20), rendererSha,
      sourceVersion: published.page.sourceVersion, snapshotDigest: "b".repeat(64),
      contextDigest: published.sourceSeal.contextDigest, path: "/", ownedPaths: ["/", "/_home-sources.json"],
      generation: 5, operationGeneration: 5, codeGeneration: 5, visible: true, admissionRevision: 1,
      homeRefreshRevision: revision } };
}
function contextDecision(revision: number, pageId = "home"): NoBuildPageReply {
  const renderContext = fallbackPageRead(pageId, rendererSha);
  const contextDigest = createHash("sha256").update(`njpbs-public-context-v1:${revision}`).digest("hex");
  Object.assign(renderContext.sourceSeal, { contextRevision: revision, contextDigest });
  if (pageId === "home") renderContext.posts[0].document.published.metadata.title = `Election update ${revision}`;
  return { kind: "context-page", renderContext, homeSources: retainedHomeSources(rendererSha),
    contextReceipt: { rendererSha, contextRevision: revision, contextDigest, codeGeneration: 5,
      path: renderContext.path, source: "site" } };
}
function liveDecision(revision: number, lane: string): NoBuildPageReply {
  const published = publishedPageRead("live", rendererSha);
  // The synthetic schedule clock must not precede the Page's publication.
  published.page.publishedAt = scheduleData.generatedAt;
  const reply: NoBuildPageReply = lane === "context" ? contextDecision(revision, "live") : {
    ...homeDecision(revision), published,
    receipt: { ...homeDecision(revision).receipt!, pageId: "live", path: "/live/", ownedPaths: ["/live/"] },
  };
  const input = (reply.renderContext ?? reply.published) as Record<string, any>;
  const seal = input.sourceSeal;
  Object.assign(seal, { contextRevision: revision, codeGeneration: 5,
    contextDigest: createHash("sha256").update(`njpbs-public-context-v1:${revision}`).digest("hex") });
  if (reply.receipt) {
    reply.receipt.contextDigest = seal.contextDigest;
    delete reply.receipt.homeRefreshRevision;
  }
  delete reply.homeSources;
  const data = { ...scheduleData, days: { broadcast: scheduleData.days.broadcast.slice(0, 1), kids: scheduleData.days.kids.slice(0, 1) } } as BakedScheduleData;
  const exported = buildScheduleExport(data, new Date(data.generatedAt));
  input.schedule = { data, exported, receipt: { schemaVersion: 1, contextRevision: seal.contextRevision,
    contextDigest: seal.contextDigest, code: { commitSha: rendererSha, generation: 5 },
    source: { runtime: { owner: "cloudflare" }, checkedAt: Date.parse(exported.exportedAt) },
    generatedAt: data.generatedAt, exportedAt: exported.exportedAt,
    inputDigest: createHash("sha256").update(JSON.stringify({ data, exported })).digest("hex") } };
  return reply;
}

it.each(["GET", "HEAD"])("renders the newer homepage decision when publishing moves during %s", async method => {
  const first = homeDecision(1), newer = homeDecision(2);
  const getDecision = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(newer);
  const render = vi.fn(async content => `<!doctype html><html>${content.posts[0].title}</html>`);
  const fetchAsset = vi.fn(async () => new Response("Older Assets homepage"));
  const worker = createNoBuildPageWorker({ target: publicationTarget("production"), rendererSha, rendererReady: true,
    getDecision, render, fetchAsset, now: () => now, cache: { async match() {}, async put() {} } });
  const response = (await worker.fetch(new Request("https://njpbs.org/", { method })))!;
  expect(response.headers.get("x-njpbs-content-source")).toBe("cms-page-no-build");
  expect(response.headers.get("x-njpbs-home-refresh-revision")).toBe("2");
  expect(await response.text()).toBe(method === "HEAD" ? "" : "<!doctype html><html>Election update 2</html>");
  expect(render.mock.calls.map(([content]) => content.posts[0].title)).toEqual(["Election update 1", "Election update 2"]);
  expect(getDecision).toHaveBeenCalledTimes(3);
  expect(fetchAsset).not.toHaveBeenCalled();
});

it.each(["GET", "HEAD"])("rerenders a committed homepage frame from the newer context during %s", async method => {
  const getDecision = vi.fn().mockResolvedValueOnce(contextDecision(1)).mockResolvedValue(contextDecision(2));
  const renderContext = vi.fn(async content => `<!doctype html><html>${content.posts[0].title}</html>`);
  const fetchAsset = vi.fn(async () => new Response("Older Assets homepage"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, renderContext,
    render: async () => "", fetchAsset, now: () => now, cache: { async match() {}, async put() {} } });
  const response = (await worker.fetch(new Request("https://dev-public.example.org/", { method })))!;
  expect(response.headers.get("x-njpbs-content-source")).toBe("cms-page-context");
  expect(response.headers.get("x-njpbs-public-context-revision")).toBe("2");
  expect(await response.text()).toBe(method === "HEAD" ? "" : "<!doctype html><html>Election update 2</html>");
  expect(renderContext).toHaveBeenCalledTimes(2);
  expect(getDecision).toHaveBeenCalledTimes(3);
  expect(fetchAsset).not.toHaveBeenCalled();
});

it("serves the newest completed render after three attempts during continuous publishing", async () => {
  let revision = 0;
  const getDecision = vi.fn(async () => homeDecision(++revision));
  const render = vi.fn(async content => `<!doctype html><html>${content.posts[0].title}</html>`);
  const fetchAsset = vi.fn(async () => new Response("Old Assets"));
  const read = vi.fn(async () => new Response("Old last-good"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, render, fetchAsset,
    lastGood: { read, store: vi.fn() }, readWithdrawal: async () => null, now: () => now,
    cache: { async match() {}, async put() {} } });
  const response = (await worker.fetch(new Request("https://dev-public.example.org/")))!;
  expect(response.status).toBe(200);
  expect(response.headers.get("x-njpbs-home-refresh-revision")).toBe("3");
  expect(await response.text()).toBe("<!doctype html><html>Election update 3</html>");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(render).toHaveBeenCalledTimes(3);
  expect(getDecision).toHaveBeenCalledTimes(4);
  expect(fetchAsset).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it.each(["receipt", "context"])("retains only rechecked-current %s renders after serving bounded churn", async lane => {
  let revision = 0, churn = true;
  const getDecision = async () => {
    if (churn) revision++;
    return lane === "receipt" ? homeDecision(revision) : contextDecision(revision);
  };
  const render = async content => `<!doctype html><html>${content.posts[0].title}</html>`;
  const store = vi.fn(async () => {}), pending: Promise<unknown>[] = [];
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, render, renderContext: render,
    lastGood: { read: async () => null, store }, waitUntil: task => { pending.push(task); },
    readWithdrawal: async () => null, fetchAsset: async () => new Response("Assets"), now: () => now,
    cache: { async match() {}, async put() {} } });
  expect(await (await worker.fetch(new Request("https://dev-public.example.org/")))!.text()).toContain("Election update 3");
  expect(store).not.toHaveBeenCalled();
  churn = false;
  expect(await (await worker.fetch(new Request("https://dev-public.example.org/")))!.text()).toContain("Election update 4");
  await Promise.all(pending);
  expect(store).toHaveBeenCalledTimes(1);
});

it.each(["receipt", "context"].flatMap(lane => ["body", "response"].map(stage => ({ lane, stage }))))(
  "keeps freshly rendered content when an optional cache write stalls (%j)", async ({ lane, stage }) => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    try {
      let reached!: () => void;
      const started = new Promise<void>(resolve => { reached = resolve; });
      const reply = { ...(lane === "receipt" ? homeDecision(1) : contextDecision(1)),
        decisionCacheUntil: now.getTime() + 60_000 };
      const getDecision = vi.fn(async () => reply);
      const render = async () => { vi.setSystemTime(Date.now() + PUBLIC_PAGE_WAIT_MS - 10);
        return "<!doctype html><html>Fresh Home</html>"; };
      const fetchAsset = vi.fn(async () => new Response("Older Assets"));
      const worker = createNoBuildPageWorker({ target: publicationTarget("production"), rendererSha, rendererReady: true,
        getDecision, render, renderContext: render, fetchAsset, now: () => new Date(),
        cache: { async match() {}, async put(key) {
          const responseWrite = (key as Request).url.includes("__public-page-response");
          if ((stage === "response") === responseWrite) { reached(); await new Promise<void>(() => {}); }
        } } });
      const pending = worker.fetch(new Request("https://njpbs.org/"));
      await started;
      await vi.advanceTimersByTimeAsync(100);
      const response = (await pending)!;
      expect(response.headers.get("x-njpbs-content-source")).toBe(lane === "receipt" ? "cms-page-no-build" : "cms-page-context");
      expect(await response.text()).toContain("Fresh Home");
      expect(getDecision).toHaveBeenCalledTimes(2);
      expect(fetchAsset).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

it.each(["receipt", "context"].flatMap(lane => ["candidate", "body-match", "body-text"].map(stage => ({ lane, stage }))))(
  "treats an optional cache read timeout as a miss (%j)", async ({ lane, stage }) => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    try {
      let active = stage !== "candidate", reached!: () => void;
      const started = new Promise<void>(resolve => { reached = resolve; });
      const reply = { ...(lane === "receipt" ? homeDecision(1) : contextDecision(1)),
        decisionCacheUntil: now.getTime() + 60_000 };
      const entries = new Map<string, Response>();
      const getDecision = vi.fn(async () => reply);
      const render = vi.fn(async () => {
        if (active) vi.setSystemTime(Date.now() + PUBLIC_PAGE_WAIT_MS - 10);
        return "<!doctype html><html>Fresh Home</html>";
      });
      const fetchAsset = vi.fn(async () => new Response("Older Assets"));
      const worker = createNoBuildPageWorker({ target: publicationTarget("production"), rendererSha, rendererReady: true,
        getDecision, render, renderContext: render, fetchAsset, now: () => new Date(),
        cache: { async match(key) {
          const url = (key as Request).url, candidate = url.includes("__public-page-response");
          if (active && (stage === "candidate" ? candidate : !candidate)) {
            reached();
            if (stage === "body-text") return new Response(new ReadableStream());
            return new Promise<Response>(() => {});
          }
          return entries.get(url)?.clone();
        }, async put(key, response) { entries.set((key as Request).url, response.clone()); } } });
      if (stage === "candidate") {
        await (await worker.fetch(new Request("https://njpbs.org/")))!.text();
        active = true; getDecision.mockClear(); render.mockClear();
      }
      const pending = worker.fetch(new Request("https://njpbs.org/"));
      await started;
      await vi.advanceTimersByTimeAsync(100);
      const response = (await pending)!;
      expect(response.headers.get("x-njpbs-content-source")).toBe(lane === "receipt" ? "cms-page-no-build" : "cms-page-context");
      expect(await response.text()).toContain("Fresh Home");
      expect(getDecision).toHaveBeenCalledTimes(2);
      expect(render).toHaveBeenCalledTimes(1);
      expect(fetchAsset).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

it.each([false, true])("shares one cache allowance while preserving withdrawal (%s)", async withdrawn => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  try {
    let waiting = false, reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const marker = { pageId: "home", operationId: "W".repeat(20), sourceVersion: 8,
      revision: 9, ownedPaths: ["/"], verifiedAt: 1234 };
    const reply = { ...homeDecision(1), decisionCacheUntil: now.getTime() + 60_000 };
    const getDecision = vi.fn(async () => reply);
    const put = vi.fn(async (key: Request) => {
      if (key.url.includes("__public-home-response-fence")) return;
      waiting = true; reached(); await new Promise<void>(() => {});
    });
    const worker = createNoBuildPageWorker({ target: publicationTarget("production"), rendererSha, rendererReady: true,
      getDecision, now: () => new Date(), readWithdrawal: async () => withdrawn && waiting ? marker : null,
      render: async () => { vi.setSystemTime(Date.now() + PUBLIC_PAGE_WAIT_MS - 10); return "<!doctype html><html>Fresh Home</html>"; },
      fetchAsset: async () => new Response("Older Assets"),
      cache: { async match(key) {
        if (!(key as Request).url.includes("__public-page-response")) vi.setSystemTime(Date.now() + 80);
        return undefined;
      }, put } });
    const pending = worker.fetch(new Request("https://njpbs.org/"));
    await started;
    await vi.advanceTimersByTimeAsync(20);
    const response = (await pending)!;
    expect(Date.now() - now.getTime()).toBe(PUBLIC_PAGE_WAIT_MS + 90);
    expect(getDecision).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2); // Home witness, then the stalled body write.
    if (withdrawn) expect(response.status).toBe(410);
    else expect(await response.text()).toContain("Fresh Home");
  } finally { vi.useRealTimers(); }
});

it.each(["receipt", "context"].flatMap(lane => [false, true].map(withdrawn => ({ lane, withdrawn }))))(
  "honors a final serving refusal (%j)", async ({ lane, withdrawn }) => {
    let calls = 0, rendered = 0;
    const marker = { pageId: "home", operationId: "W".repeat(20), sourceVersion: 8,
      revision: 9, ownedPaths: ["/"], verifiedAt: 1234 };
    const getDecision = vi.fn(async (): Promise<NoBuildPageReply> => ++calls === 4 ? { kind: "pass", path: "/" }
      : lane === "receipt" ? homeDecision(calls) : contextDecision(calls));
    const render = vi.fn(async () => { rendered++; return "<!doctype html><html>Home</html>"; });
    const store = vi.fn(async () => {}), fetchAsset = vi.fn(async () => new Response("Assets"));
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, render, renderContext: render,
      lastGood: { read: async () => null, store }, waitUntil: task => { void task; },
      readWithdrawal: async () => withdrawn && rendered === 3 ? marker : null, fetchAsset, now: () => now,
      cache: { async match() {}, async put() {} } });
    const response = await worker.fetch(new Request("https://dev-public.example.org/"));
    if (withdrawn) expect(response!.status).toBe(410);
    else expect(response).toBeNull();
    expect(render).toHaveBeenCalledTimes(3);
    expect(getDecision).toHaveBeenCalledTimes(4);
    expect(store).not.toHaveBeenCalled();
    expect(fetchAsset).not.toHaveBeenCalled();
  });

it.each(["receipt", "context"])("honors a final Live schedule refusal in the %s lane", async lane => {
  let calls = 0;
  const getDecision = vi.fn(async (): Promise<NoBuildPageReply> => ++calls === 4
    ? { kind: "schedule-unavailable", pageId: "live", path: "/live/" } : liveDecision(calls, lane));
  const render = vi.fn(async () => "<!doctype html><html>Live</html>");
  const store = vi.fn(async () => {}), fetchAsset = vi.fn(async () => new Response("Available Live Assets"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, render, renderContext: render,
    lastGood: { read: async () => null, store }, waitUntil: task => { void task; },
    fetchAsset, now: () => new Date(scheduleData.generatedAt), cache: { async match() {}, async put() {} } });
  const response = (await worker.fetch(new Request("https://dev-public.example.org/live/")))!;
  expect(response.headers.get("x-njpbs-content-source")).toBe("assets");
  expect(await response.text()).toBe("Available Live Assets");
  expect(render).toHaveBeenCalledTimes(3);
  expect(getDecision).toHaveBeenCalledTimes(4);
  expect(store).not.toHaveBeenCalled();
});

it("shares the total time budget across newer renders", async () => {
  let time = now.getTime();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  const getDecision = vi.fn(async () => { time += 600; return homeDecision(getDecision.mock.calls.length); });
  const render = vi.fn(async () => { time += 500; return "<!doctype html><html>In flight</html>"; });
  const fetchAsset = vi.fn(async () => new Response("Old Assets"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, render, fetchAsset,
    now: () => new Date(time), cache: { async match() {}, async put() {} } });
  try {
    expect((await worker.fetch(new Request("https://dev-public.example.org/")))!.headers.get("x-njpbs-content-source")).toBe("assets");
    expect(render).toHaveBeenCalledTimes(2);
    expect(getDecision).toHaveBeenCalledTimes(3);
    expect(fetchAsset).toHaveBeenCalledTimes(1);
  } finally { clock.mockRestore(); }
});

it.each(["GET", "HEAD"])("preserves the cold first-decision allowance for public %s", async method => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  try {
    const fetchAsset = vi.fn(async () => new Response("Available Assets"));
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true,
      getDecision: () => new Promise(() => {}), render: async () => "", fetchAsset,
      cache: { async match() {}, async put() {} } });
    const pending = worker.fetch(new Request("https://dev-public.example.org/", { method }));
    await vi.advanceTimersByTimeAsync(10_000 - 1);
    expect(fetchAsset).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const response = (await pending)!;
    expect(response.headers.get("x-njpbs-content-source")).toBe("assets");
    expect(await response.text()).toBe(method === "HEAD" ? "" : "Available Assets");
    expect(Date.now() - now.getTime()).toBe(10_000);
  } finally { vi.useRealTimers(); }
});

it.each([false, true])("renders fresh after a six-second cold decision (continued churn: %s)", async churn => {
  let time = now.getTime(), decisions = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const getDecision = vi.fn(async () => {
      time += ++decisions === 1 ? 6_000 : churn ? 100 : 0;
      return homeDecision(churn ? decisions : 1);
    });
    const render = vi.fn(async content => {
      time += churn ? 400 : 40;
      return `<!doctype html><html>${content.posts[0].title}</html>`;
    });
    const fetchAsset = vi.fn(async () => new Response("Older Assets"));
    const read = vi.fn(async () => new Response("Older last-good"));
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, render, fetchAsset,
      lastGood: { read, store: vi.fn() }, readWithdrawal: async () => null, now: () => now,
      cache: { async match() {}, async put() {} } });
    const response = (await worker.fetch(new Request("https://dev-public.example.org/")))!;
    expect(response.headers.get("x-njpbs-content-source")).toBe("cms-page-no-build");
    expect(await response.text()).toContain(`Election update ${churn ? 3 : 1}`);
    expect(time - now.getTime()).toBe(churn ? 7_500 : 6_040);
    expect(render).toHaveBeenCalledTimes(churn ? 3 : 1);
    expect(getDecision).toHaveBeenCalledTimes(churn ? 4 : 2);
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

it("bounds a stalled homepage baseline without waiting ten seconds", async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  try {
    const reply = homeDecision(1); delete reply.homeSources; reply.needsBaseline = true;
    const render = vi.fn(async () => "");
    const fetchAsset = vi.fn(async request => new URL(request.url).pathname === "/"
      ? new Response("Available Assets") : new Promise<Response>(() => {}));
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true,
      getDecision: async () => reply, render, fetchAsset, cache: { async match() {}, async put() {} } });
    const pending = worker.fetch(new Request("https://dev-public.example.org/"));
    await vi.advanceTimersByTimeAsync(PUBLIC_PAGE_WAIT_MS);
    expect((await pending)!.headers.get("x-njpbs-content-source")).toBe("assets");
    expect(render).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it.each(["render", "second decision"])("keeps a stalled %s inside the original public Page deadline", async phase => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  try {
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const getDecision = vi.fn(async () => {
      if (phase === "second decision" && getDecision.mock.calls.length === 2) {
        reached(); return new Promise<NoBuildPageReply>(() => {});
      }
      return homeDecision(1);
    });
    const render = vi.fn(async () => {
      vi.setSystemTime(now.getTime() + 750);
      if (phase === "render") { reached(); return new Promise<string>(() => {}); }
      return "<!doctype html><html>Home</html>";
    });
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, render,
      fetchAsset: async () => new Response("Assets"), cache: { async match() {}, async put() {} } });
    const pending = worker.fetch(new Request("https://dev-public.example.org/"));
    await started;
    await vi.advanceTimersByTimeAsync(PUBLIC_PAGE_WAIT_MS - 750);
    expect((await pending)!.headers.get("x-njpbs-content-source")).toBe("assets");
    expect(Date.now() - now.getTime()).toBe(PUBLIC_PAGE_WAIT_MS);
  } finally { vi.useRealTimers(); }
});

it.each(["/_home-sources.json", "/_schedule-sources.json?cms-schedule=proof"])("keeps the Admin source wait unchanged (%s)", async path => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  try {
    let done = false;
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true,
      getDecision: () => new Promise(() => {}), render: async () => "", fetchAsset: async () => new Response("Assets"),
      cache: { async match() {}, async put() {} } });
    const pending = worker.fetch(new Request(`https://dev-public.example.org${path}`)).then(response => { done = true; return response; });
    await vi.advanceTimersByTimeAsync(PUBLIC_PAGE_WAIT_MS);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000 - PUBLIC_PAGE_WAIT_MS);
    await pending;
    expect(done).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("honors a durable withdrawal appearing during a context rerender", async () => {
  let withdrawn = false;
  const marker = { pageId: "contact", operationId: "A".repeat(20), sourceVersion: 7,
    revision: 3, ownedPaths: ["/contact/"], verifiedAt: 1234 };
  const getDecision = vi.fn().mockResolvedValueOnce(contextDecision(1, "contact")).mockResolvedValue(contextDecision(2, "contact"));
  const renderContext = vi.fn(async () => { if (renderContext.mock.calls.length === 2) withdrawn = true;
    return "<!doctype html><html>Contact</html>"; });
  const fetchAsset = vi.fn(async () => new Response("Old contact"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, renderContext,
    readWithdrawal: async () => withdrawn ? marker : null, render: async () => "", fetchAsset,
    now: () => now, cache: { async match() {}, async put() {} } });
  expect((await worker.fetch(new Request("https://dev-public.example.org/contact/")))!.status).toBe(410);
  expect(fetchAsset).not.toHaveBeenCalled();
});

it("serves a newer gone decision instead of the Page that just rendered", async () => {
  const first = contextDecision(1, "contact"), gone = { ...contextDecision(2, "contact"), kind: "gone" as const };
  const getDecision = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(gone);
  const renderContext = vi.fn(async () => "<!doctype html><html>Old contact</html>");
  const fetchAsset = vi.fn(async () => new Response("Older contact"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, renderContext,
    render: async () => "", fetchAsset, cache: { async match() {}, async put() {} } });
  const response = (await worker.fetch(new Request("https://dev-public.example.org/contact/")))!;
  expect(response.status).toBe(410);
  expect(await response.text()).toBe("");
  expect(renderContext).toHaveBeenCalledTimes(1);
  expect(getDecision).toHaveBeenCalledTimes(3);
  expect(fetchAsset).not.toHaveBeenCalled();
});

it("lets withdrawal win even when publishing exhausts the rerender limit", async () => {
  let revision = 0, withdrawn = false;
  const marker = { pageId: "home", operationId: "A".repeat(20), sourceVersion: 7,
    revision: 7, ownedPaths: ["/"], verifiedAt: 1234 };
  const render = vi.fn(async () => { if (render.mock.calls.length === 3) withdrawn = true;
    return "<!doctype html><html>Home</html>"; });
  const fetchAsset = vi.fn(async () => new Response("Older Home"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true,
    getDecision: async () => { const reply = homeDecision(++revision);
      reply.receipt!.operationGeneration = revision + 4; return reply; }, render, fetchAsset, now: () => now,
    readWithdrawal: async () => withdrawn ? marker : null, cache: { async match() {}, async put() {} } });
  expect((await worker.fetch(new Request("https://dev-public.example.org/")))!.status).toBe(410);
  expect(fetchAsset).not.toHaveBeenCalled();
});

it("honors a gone decision received after the last allowed Page render", async () => {
  const getDecision = vi.fn(async () => {
    const reply = contextDecision(getDecision.mock.calls.length, "contact");
    return getDecision.mock.calls.length >= 4 ? { ...reply, kind: "gone" as const } : reply;
  });
  const renderContext = vi.fn(async () => "<!doctype html><html>Contact</html>");
  const fetchAsset = vi.fn(async () => new Response("Old contact"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, renderContext,
    render: async () => "", fetchAsset, cache: { async match() {}, async put() {} } });
  expect((await worker.fetch(new Request("https://dev-public.example.org/contact/")))!.status).toBe(410);
  expect(renderContext).toHaveBeenCalledTimes(3);
  expect(getDecision).toHaveBeenCalledTimes(5);
  expect(fetchAsset).not.toHaveBeenCalled();
});

it.each(["receipt", "context"])("keeps a validated %s response when its final withdrawal read finishes past the render budget", async lane => {
  let time = now.getTime(), reads = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const render = async () => "<!doctype html><html>Current Home</html>";
    const fetchAsset = vi.fn(async () => new Response("Older Home"));
    const reply = lane === "receipt" ? homeDecision(1) : contextDecision(1);
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision: async () => reply,
      render, renderContext: render, fetchAsset, now: () => now,
      readWithdrawal: async () => { if (++reads === 2) time += PUBLIC_PAGE_WAIT_MS + 100; return null; },
      cache: { async match() {}, async put() {} } });
    expect(await (await worker.fetch(new Request("https://dev-public.example.org/")))!.text()).toContain("Current Home");
    expect(fetchAsset).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

// Exception: Home is never a withdrawn identity. Its publication, serving and recovery paths refuse
// an unpublish (functions/lib/no-build-page-publication.js, no-build-page-serving.js, no-build-page-recovery.js),
// and only Home owns "/". The fresh validated render may serve; no static copy is read.
it.each([false, true])("keeps a validated context Home, which cannot be withdrawn, on an unknown final withdrawal read (rerender: %s)", async rerender => {
  const first = contextDecision(1), newer = contextDecision(2);
  const getDecision = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(rerender ? newer : first);
  const fetchAsset = vi.fn(async () => new Response("Older Home"));
  const readWithdrawal = vi.fn().mockResolvedValueOnce(null).mockRejectedValue(new Error("Storage unavailable"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, readWithdrawal,
    renderContext: async () => "<!doctype html><html>Current Home</html>", render: async () => "", fetchAsset,
    now: () => now, cache: { async match() {}, async put() {} } });
  expect(await (await worker.fetch(new Request("https://dev-public.example.org/")))!.text()).toContain("Current Home");
  expect(fetchAsset).not.toHaveBeenCalled();
});

it("validates the new decision identity before a rerender can be served", async () => {
  const newer = homeDecision(2); newer.receipt!.rendererSha = "c".repeat(40);
  const getDecision = vi.fn().mockResolvedValueOnce(homeDecision(1)).mockResolvedValue(newer);
  const render = vi.fn(async () => "<!doctype html><html>Home</html>");
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision, render,
    fetchAsset: async () => new Response("Assets"), now: () => now, cache: { async match() {}, async put() {} } });
  expect((await worker.fetch(new Request("https://dev-public.example.org/")))!.headers.get("x-njpbs-content-source")).toBe("assets");
  expect(render).toHaveBeenCalledTimes(1);
});

it("reports current public Page phase durations on cold and warm replies", async () => {
  let time = now.getTime(), decisions = 0, withdrawals = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const reply = { ...homeDecision(1), decisionCacheUntil: now.getTime() + 60_000 };
    const entries = new Map<string, Response>();
    const worker = createNoBuildPageWorker({ target: publicationTarget("production"), rendererSha, rendererReady: true,
      now: () => now, getDecision: async () => { time += ++decisions === 2 ? 80 : 120; return reply; },
      render: async () => { time += 40; return "<!doctype html><html>Current Home</html>"; },
      readWithdrawal: async () => { time += ++withdrawals % 2 ? 5 : 7; return null; },
      fetchAsset: async () => new Response("Assets"),
      cache: { async match(key) { return entries.get((key as Request).url)?.clone(); },
        async put(key, response) { entries.set((key as Request).url, response.clone()); } } });
    const first = (await worker.fetch(new Request("https://njpbs.org/")))!;
    expect(first.headers.get("server-timing")).toBe("decision;dur=120.0, render;dur=40.0, recheck;dur=80.0, withdrawal;dur=12.0, fallback;dur=0.0");
    const warm = (await worker.fetch(new Request("https://njpbs.org/")))!;
    expect(warm.headers.get("x-njpbs-page-cache")).toBe("hit");
    expect(warm.headers.get("server-timing")).toBe("decision;dur=0.0, render;dur=0.0, recheck;dur=0.0, withdrawal;dur=12.0, fallback;dur=0.0");
    expect(await warm.text()).toContain("Current Home");
  } finally { clock.mockRestore(); }
});

it.each(["GET", "HEAD"])("reports authority and fallback durations without identifiers on public %s", async method => {
  let time = now.getTime(), withdrawals = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => time);
  try {
    const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true,
      getDecision: async () => { time += 100; throw new Error("Authority unavailable"); }, render: async () => "",
      readWithdrawal: async () => { time += ++withdrawals === 1 ? 2 : 3; return null; },
      fetchAsset: async () => { time += 50; return new Response("Assets"); },
      cache: { async match() {}, async put() {} } });
    const response = (await worker.fetch(new Request("https://dev-public.example.org/", { method })))!;
    expect(response.headers.get("server-timing")).toBe("decision;dur=100.0, render;dur=0.0, recheck;dur=0.0, withdrawal;dur=5.0, fallback;dur=53.0");
    expect(await response.text()).toBe(method === "HEAD" ? "" : "Assets");
  } finally { clock.mockRestore(); }
});

it("leaves Admin Home source timing headers unchanged", async () => {
  const reply = { ...homeDecision(1), kind: "home-sources" as const };
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision: async () => reply,
    render: async () => "", fetchAsset: async () => new Response("Assets"), now: () => now,
    cache: { async match() {}, async put() {} } });
  const response = (await worker.fetch(new Request("https://dev-public.example.org/_home-sources.json")))!;
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.has("server-timing")).toBe(false);
});

it("keeps the Admin Home source identity-change fallback unchanged", async () => {
  const first = { ...homeDecision(1), kind: "home-sources" as const };
  const newer = { ...homeDecision(2), kind: "home-sources" as const };
  const getDecision = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(newer);
  const fetchAsset = vi.fn(async () => new Response("Asset source catalog"));
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, getDecision,
    render: async () => "", fetchAsset, now: () => now, cache: { async match() {}, async put() {} } });
  const response = (await worker.fetch(new Request("https://dev-public.example.org/_home-sources.json")))!;
  expect(await response.text()).toBe("Asset source catalog");
  expect(response.headers.get("x-njpbs-content-source")).toBe("assets");
  expect(response.headers.has("server-timing")).toBe(false);
  expect(getDecision).toHaveBeenCalledTimes(2);
});

it("preserves ordinary Post-only dev routing when only the durable Page guard is enabled", async () => {
  const fetchAsset = vi.fn(async () => new Response("Static Assets"));
  const getDecision = vi.fn(async () => { throw new Error("No Page capability"); });
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady: false, withdrawalsOnly: true,
    getDecision, fetchAsset, readWithdrawal: async () => null,
    cache: { async match() {}, async put() {} }, render: async () => "" });
  for (const path of ["/", "/contact/", "/posts/"]) expect(await worker.fetch(new Request(`https://dev-public.example.org${path}`))).toBeNull();
  expect(fetchAsset).not.toHaveBeenCalled();
  expect(getDecision).not.toHaveBeenCalled();
});
it.each([true, false])("refuses Assets and last-good copies when Page withdrawal state is unknown (withdrawals only: %s)", async withdrawalsOnly => {
  const fetchAsset = vi.fn(async () => new Response("Old withdrawn Page"));
  const lastGood = { store: vi.fn(async () => {}), read: vi.fn(async () => new Response("Retained withdrawn Page")) };
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady: !withdrawalsOnly, withdrawalsOnly,
    readWithdrawal: async () => { throw new Error("Storage unavailable"); }, lastGood, fetchAsset,
    getDecision: async () => { throw new Error("Authority unavailable"); },
    cache: { async match() {}, async put() {} }, render: async () => "" });
  for (const method of ["GET", "HEAD"]) {
    const response = (await worker.fetch(new Request("https://dev-public.example.org/contact/", { method })))!;
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(fetchAsset).not.toHaveBeenCalled();
  expect(lastGood.read).not.toHaveBeenCalled();
});
it("keeps routes no Page can own on Assets when the Page catalog is malformed", async () => {
  const store = { async get() { return { etag: "fixture", size: 2, body: new Response("{}").body! }; } };
  const fetchAsset = vi.fn(async () => new Response("Search shell"));
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady: false, withdrawalsOnly: true,
    readWithdrawal: path => readDurablePageWithdrawal(store, "template-dev-public", path), fetchAsset,
    getDecision: async () => { throw new Error("No Page capability"); },
    cache: { async match() {}, async put() {} }, render: async () => "" });
  for (const path of ["/search/", "/wiki/"]) expect(await worker.fetch(new Request(`https://dev-public.example.org${path}`))).toBeNull();
  expect((await worker.fetch(new Request("https://dev-public.example.org/contact/")))!.status).toBe(503);
});
it("rechecks durable absence before Assets when a marker appears during authority refusal", async () => {
  const marker = { pageId: "contact", operationId: "A".repeat(20), sourceVersion: 7,
    revision: 3, ownedPaths: ["/contact/"], verifiedAt: 1234 };
  const readWithdrawal = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(marker);
  const fetchAsset = vi.fn(async () => new Response("Old withdrawn Page"));
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady: true, readWithdrawal,
    getDecision: async () => { throw new Error("Authority unavailable"); }, fetchAsset,
    cache: { async match() {}, async put() {} }, render: async () => "" });
  expect((await worker.fetch(new Request("https://dev-public.example.org/contact/")))!.status).toBe(410);
  expect(readWithdrawal).toHaveBeenCalledTimes(2);
  expect(fetchAsset).not.toHaveBeenCalled();
});

it.each(["deploying", "mismatch", "missing claim", "timeout", "renderer unavailable"])("keeps canonical and alias Page withdrawals absent during %s", async reason => {
  const marker = { pageId: "contact", operationId: "A".repeat(20), sourceVersion: 7,
    revision: 3, ownedPaths: ["/contact/", "/old-contact/"], verifiedAt: 1234 };
  const text = encodePageWithdrawalManifest({ schemaVersion: 1, workerName: "template-dev-public", contextRevision: 3,
    withdrawals: [marker] }, "template-dev-public");
  const store = { async get(key: string) {
    expect(key).toBe(pageWithdrawalManifestKey("template-dev-public"));
    return { etag: "fixture", size: new TextEncoder().encode(text).length, body: new Response(text).body! };
  } };
  const fetchAsset = vi.fn(async () => new Response("Old withdrawn Page"));
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady: reason !== "renderer unavailable",
    getDecision: async () => { throw new Error(reason); }, fetchAsset,
    readWithdrawal: path => readDurablePageWithdrawal(store, "template-dev-public", path),
    cache: { async match() { return undefined; }, async put() {} }, render: async () => "" });
  for (const path of marker.ownedPaths) for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request(`https://dev-public.example.org${path}`, { method }));
    expect(response!.status).toBe(410);
    expect(await response!.text()).toBe("");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    expect(response!.headers.get("x-njpbs-content-source")).toBe("durable-page-withdrawal");
  }
  expect(fetchAsset).not.toHaveBeenCalled();
});

it.each([true, false])("defers Post background paths before Page authority or Assets fallback (renderer ready: %s)", async rendererReady => {
  const getDecision = vi.fn(async () => { throw new Error("Page authority unavailable"); });
  const fetchAsset = vi.fn(async () => new Response("Static Page copy"));
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady, getDecision, fetchAsset,
    cache: { async match() { return undefined; }, async put() {} }, render: async () => "" });
  for (const path of ["/posts/", "/posts", "/posts/index.html", "/authors/", "/authors/index.html"]) {
    expect(await worker.fetch(new Request(`https://dev-public.example.org${path}`))).toBeNull();
  }
  expect(getDecision).not.toHaveBeenCalled();
  expect(fetchAsset).not.toHaveBeenCalled();
  expect(await (await worker.fetch(new Request("https://dev-public.example.org/contact/")))!.text()).toBe("Static Page copy");
});

it.each([true, false])("preserves Schedule and Live Assets during authority outages (renderer ready: %s)", async rendererReady => {
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady,
    getDecision: async () => { throw new Error("Authority outage"); },
    fetchAsset: async () => new Response("Static schedule and download link", { headers: { "x-njpbs-publication-operation": "stale" } }),
    cache: { async match() {}, async put() {} }, render: async () => "" });
  for (const path of ["/schedule/", "/live/"]) for (const method of ["GET", "HEAD"]) {
    const response = await worker.fetch(new Request(`https://dev-public.example.org${path}`, { method }));
    expect(response!.status).toBe(200);
    expect(response!.headers.get("x-njpbs-content-source")).toBe("assets");
    expect(response!.headers.get("x-njpbs-publication-operation")).toBeNull();
    expect(await response!.text()).toBe(method === "HEAD" ? "" : "Static schedule and download link");
  }
});

it.each([true, false])("lets the existing download and refresh requests reach Assets when unavailable (renderer ready: %s)", async rendererReady => {
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady,
    getDecision: async () => { throw new Error("No Page authority"); }, fetchAsset: async () => new Response("Unused"),
    cache: { async match() {}, async put() {} }, render: async () => "" });
  for (const path of ["/_schedule-sources.json", "/schedule/downloads/nj-pbs-schedule.pdf"])
    for (const query of ["", "?_njpbs_refresh=11111111-1111-4111-8111-111111111111"])
      for (const method of ["GET", "HEAD"]) {
        expect(await worker.fetch(new Request(`https://dev-public.example.org${path}${query}`, { method }))).toBeNull();
      }
  expect(await worker.fetch(new Request("https://dev-public.example.org/_schedule-sources.json?cms-schedule=proof"))).toBeNull();
});

it("keeps a withdrawn Schedule absent during the same authority outage", async () => {
  const marker = { pageId: "schedule", operationId: "A".repeat(20), sourceVersion: 7,
    revision: 3, ownedPaths: ["/schedule/"], verifiedAt: 1234 };
  const worker = createNoBuildPageWorker({ rendererSha: "a".repeat(40), rendererReady: true,
    readWithdrawal: async () => marker, getDecision: async () => { throw new Error("No authority"); },
    fetchAsset: async () => new Response("Old Schedule"), cache: { async match() {}, async put() {} }, render: async () => "" });
  const response = await worker.fetch(new Request("https://dev-public.example.org/schedule/"));
  expect(response!.status).toBe(410); expect(response!.headers.get("x-njpbs-content-source")).toBe("durable-page-withdrawal");
  expect(await response!.text()).toBe("");
});

it.each([false, true])("loads the actual Admin freshness request from Assets while the Page lane is unavailable (%s)", async rendererReady => {
  const identity = { schemaVersion: 1, buildBatchId: "cms-" + "C".repeat(20), generation: 1, commitSha: "a".repeat(40) };
  const schedule = { schemaVersion: 1, publication: { buildBatchId: identity.buildBatchId, generation: identity.generation, commitSha: identity.commitSha },
    source: "pbs-tvss", checkedAt: "2026-10-12T10:00:00.000Z",
    timeZone: "America/New_York", days: [] };
  const worker = createNoBuildPageWorker({ target: publicationTarget("production"), rendererSha: identity.commitSha, rendererReady,
    getDecision: async () => { throw new Error("Page authority outage"); }, fetchAsset: async () => new Response("Unused"),
    cache: { async match() {}, async put() {} }, render: async () => "" });
  const seen: URL[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "https://njpbs.org"); seen.push(url);
    const result = await worker.fetch(new Request(url));
    if (result) { response.writeHead(result.status).end(await result.text()); return; }
    response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "https://admin.njpbs.org" })
      .end(JSON.stringify(url.pathname === "/_publication.json" ? identity : schedule));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, request = fetch;
  vi.stubGlobal("fetch", (url: string, options: RequestInit) => request(`${origin}${new URL(url).pathname}${new URL(url).search}`, options));
  try {
    expect(await loadScheduleSourceSnapshot(new AbortController().signal)).toEqual(schedule);
    expect(seen).toHaveLength(2);
    expect(seen.every(url => /^[a-z0-9]{1,32}$/.test(url.searchParams.get("cms-schedule")!))).toBe(true);
    expect(seen.find(url => url.pathname === "/_publication.json")!.searchParams.get("cms-context")).toBe("code");
  } finally { vi.unstubAllGlobals(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
