import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createPublicContentLastGood, reportLastGoodRetentionFailure } from "../../workers/src/public-content-last-good";
import { createNoBuildPageWorker } from "../../workers/src/no-build-page-worker";
import { publicationTarget } from "../../functions/lib/publication-target";
import { createTransitionalPostReadWorker } from "../../workers/src/transitional-post-read-worker";
import type { NoBuildPostReply } from "../../cms-api/src/index";
import postFixture from "../../site/tests/fixtures/shadow-posts/post.json";
import type { Withdrawal } from "../../workers/src/durable-post-withdrawals";
import type { RecordWithdrawal } from "../../workers/src/durable-record-withdrawals";

const target = publicationTarget("production"), rendererSha = "a".repeat(40);
const html = "<!doctype html><html><body>Verified public Page</body></html>";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const request = (init?: RequestInit) => new Request(`${target.origin}/contact/`, init);
function response(text = html, headers: Record<string, string> = {}) {
  return new Response(text, { headers: { "content-type": "text/html; charset=utf-8",
    "x-njpbs-content-source": "cms-page-no-build", "x-njpbs-renderer-sha": rendererSha, "x-njpbs-code-generation": "1",
    "x-njpbs-html-sha256": sha(text), "x-njpbs-publication-operation": "A".repeat(20), ...headers } });
}
function setup() {
  const entries = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; etag: string }>();
  let writes = 0;
  const store = {
    async head(key: string) {
      const value = entries.get(key);
      return value ? { size: value.bytes.length, customMetadata: value.metadata, etag: value.etag } : null;
    },
    async put(key: string, bytes: Uint8Array, options: R2PutOptions) {
      const condition = options.onlyIf;
      if (condition && !(condition instanceof Headers)) {
        const before = entries.get(key);
        if (condition.etagMatches && condition.etagMatches !== before?.etag ||
            condition.etagDoesNotMatch === "*" && before) return;
      }
      entries.set(key, { bytes: bytes.slice(), metadata: { ...options.customMetadata }, etag: String(++writes) });
    },
    async get(key: string) {
      const value = entries.get(key);
      return value ? { size: value.bytes.length, customMetadata: value.metadata,
        body: new Response(value.bytes).body! } : null;
    },
  };
  return { entries, store, lastGood: createPublicContentLastGood({ store, target, rendererSha }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("retains the complete copy when the viewer consumes the response before R2 metadata arrives", async () => {
  const { lastGood, store } = setup();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  store.head = async () => { await barrier; return null; };
  const viewer = response();
  const retention = lastGood.store(request(), viewer);
  expect(await viewer.text()).toBe(html);
  release();
  await retention;
  expect(await (await lastGood.read(request(), 1))!.text()).toBe(html);
});

it("skips unchanged HTML without replacing its object, then retains changed verified bytes", async () => {
  const { lastGood, entries } = setup();
  await lastGood.store(request(), response());
  const first = [...entries.values()][0].etag;
  await lastGood.store(request(), response());
  expect([...entries.values()][0].etag).toBe(first);
  const changed = "<!doctype html><html>Changed verified copy</html>";
  await lastGood.store(request(), response(changed));
  expect([...entries.values()][0].etag).not.toBe(first);
  expect(await (await lastGood.read(request(), 1))!.text()).toBe(changed);
});

it("does not overwrite a copy that changed during retention", async () => {
  const { lastGood, store } = setup();
  await lastGood.store(request(), response());
  const head = store.head;
  const concurrent = "<!doctype html><html>Concurrent verified copy</html>";
  let injected = false;
  store.head = async key => {
    const before = await head(key);
    if (!injected) { injected = true; await lastGood.store(request(), response(concurrent)); }
    return before;
  };
  await lastGood.store(request(), response("<!doctype html><html>Earlier verified copy</html>"));
  expect(await (await lastGood.read(request(), 1))!.text()).toBe(concurrent);
});

it("returns verified bytes without expiry or editorial proof and keeps HEAD bodyless", async () => {
  const { lastGood } = setup();
  await lastGood.store(request(), response());
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
  const retained = await lastGood.read(request(), 1);
  expect(await retained!.text()).toBe(html);
  expect(retained!.headers.get("x-njpbs-content-source")).toBe("r2-last-good");
  expect(retained!.headers.get("cache-control")).toBe("no-store");
  expect(retained!.headers.get("x-njpbs-publication-refresh")).toBe("pending");
  for (const name of ["x-njpbs-publication-operation", "x-njpbs-html-sha256", "x-njpbs-renderer-sha"])
    expect(retained!.headers.has(name)).toBe(false);
  expect(await (await lastGood.read(request({ method: "HEAD" }), 1))!.text()).toBe("");
});

it.each(["body", "digest", "path", "renderer", "schema", "generation"])("refuses a %s mismatch in retained bytes", async change => {
  const { lastGood, entries } = setup();
  await lastGood.store(request(), response());
  const object = [...entries.values()][0];
  if (change === "body") object.bytes = new TextEncoder().encode("<!doctype html><html>Different bytes</html>");
  if (change === "digest") object.metadata.bodyDigest = "b".repeat(64);
  if (change === "path") object.metadata.path = "/about/";
  if (change === "renderer") object.metadata.rendererSha = "b".repeat(40);
  if (change === "schema") object.metadata.schemaVersion = "2";
  if (change === "generation") object.metadata.codeGeneration = "2";
  expect(await lastGood.read(request(), 1)).toBeNull();
});

it.each([
  { method: "POST" }, { headers: { authorization: "synthetic" } }, { headers: { cookie: "synthetic=1" } },
  { headers: { range: "bytes=0-10" } },
])("does not retain or read unsafe requests (%j)", async init => {
  const { lastGood, entries } = setup();
  await lastGood.store(request(init), response());
  expect(entries.size).toBe(0);
  await lastGood.store(request(), response());
  expect(await lastGood.read(request(init), 1)).toBeNull();
});

it.each(["https://preview.example.test/contact/", `${target.origin}/contact/?preview=1`, `${target.origin}/posts/private/`])(
  "does not share storage with an unsafe address: %s", async url => {
    const { lastGood, entries } = setup();
    await lastGood.store(new Request(url), response());
    expect(entries.size).toBe(0);
    expect(await lastGood.read(new Request(url), 1)).toBeNull();
  });

it("keeps routes and renderer releases in separate storage identities", async () => {
  const { lastGood, store } = setup();
  await lastGood.store(request(), response());
  expect(await lastGood.read(new Request(`${target.origin}/about/`), 1)).toBeNull();
  const other = createPublicContentLastGood({ store, target, rendererSha: "b".repeat(40) });
  expect(await other.read(request(), 1)).toBeNull();
});

it.each([
  { "content-type": "application/json" }, { "content-range": "bytes 0-10/20" }, { "set-cookie": "synthetic=1" },
  { "x-njpbs-content-source": "assets" }, { "x-njpbs-renderer-sha": "b".repeat(40) },
])("refuses a response without a valid public HTML proof (%j)", async headers => {
  const { lastGood, entries } = setup();
  await lastGood.store(request(), response(html, headers));
  expect(entries.size).toBe(0);
});

it.each([
  ['<script type="module" src="/asset.js"></script>', true],
  ['\n<script type="module" src="/one.js"></script>\n<script type="module" src="/two.js"></script>\n', true],
  ['<script type="module" src="/asset.js">', false],
  ['<script>alert("unexpected inline trailer")</script>', false],
  ['<div>Unexpected trailing markup</div>', false],
  ['<script type="module" src="/asset.js"></script>'.repeat(17), false],
  ['<script type="module" src="/' + 'a'.repeat(64 * 1024) + '"></script>', false],
])("accepts only complete bounded Astro module trailers (%#)", async (trailer, valid) => {
  const { lastGood, entries } = setup();
  const storing = lastGood.store(request(), response(html + trailer));
  if (valid) {
    await storing;
    expect(await (await lastGood.read(request(), 1))!.text()).toBe(html + trailer);
  } else {
    await expect(storing).rejects.toThrow("unsupported-html-trailer");
    expect(entries.size).toBe(0);
  }
});

it("refuses a valid document whose trailer differs from the authority's full-body digest", async () => {
  const { lastGood, entries } = setup();
  await expect(lastGood.store(request(), response(html + '<script type="module" src="/asset.js"></script>',
    { "x-njpbs-html-sha256": sha(html) }))).rejects.toThrow("digest-mismatch");
  expect(entries.size).toBe(0);
});

it("keeps the module trailer intact after Unicode text whose lowercase form changes length", async () => {
  const { lastGood } = setup();
  const complete = '<!doctype html><html><body>İzmir</body></HTML>' +
    '<script type="module" src="/layout.js"></script>';
  await lastGood.store(request(), response(complete));
  expect(await (await lastGood.read(request(), 1))!.text()).toBe(complete);
});

it("logs the bounded rejection cause and excludes provider exception text", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { lastGood } = setup();
  try { await lastGood.store(request(), response(html + "Unexpected trailer")); }
  catch (error) { reportLastGoodRetentionFailure("page-store", error); }
  expect(log).toHaveBeenLastCalledWith("public-last-good-retention", {
    outcome: "failed", stage: "page-store", reason: "unsupported-html-trailer",
  });
  reportLastGoodRetentionFailure("post-store", new Error("SYNTHETIC-CREDENTIAL-MUST-NOT-LOG"));
  expect(log).toHaveBeenLastCalledWith("public-last-good-retention", {
    outcome: "failed", stage: "post-store", reason: "unavailable",
  });
});

it("never lets HEAD, partial HTML, an error or an oversized body replace a verified copy", async () => {
  const { lastGood } = setup();
  await lastGood.store(request(), response());
  await lastGood.store(request({ method: "HEAD" }), response());
  await lastGood.store(request(), new Response("Error", { status: 503 }));
  await lastGood.store(request(), new Response(html, { status: 206, headers: response().headers }));
  await expect(lastGood.store(request(), response("<!doctype html><html>Truncated"))).rejects.toThrow("incomplete-html");
  await expect(lastGood.store(request(), response("x".repeat(4 * 1024 * 1024 + 1)))).rejects.toThrow("oversized-html");
  expect(await (await lastGood.read(request(), 1))!.text()).toBe(html);
});

function outageWorker(lastGood: ReturnType<typeof setup>["lastGood"],
  readWithdrawal: Parameters<typeof createNoBuildPageWorker>[0]["readWithdrawal"] = async () => null,
  publication = async () => Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 1 })) {
  return createNoBuildPageWorker({ target, rendererSha, rendererReady: true, lastGood, readWithdrawal,
    cache: { async match() {}, async put() {} }, render: async () => "",
    getDecision: async () => { throw new Error("CMS RPC unavailable"); },
    fetchAsset: async request => new URL(request.url).pathname === "/_publication.json"
      ? publication() : new Response("Assets copy") });
}

it("serves the stored copy before Assets during an authority outage", async () => {
  const { lastGood } = setup();
  await lastGood.store(request(), response());
  expect(await (await outageWorker(lastGood).fetch(request()))!.text()).toBe(html);
});

it("keeps copies separate when a new artifact generation uses the same renderer source", async () => {
  const { lastGood } = setup();
  await lastGood.store(request(), response());
  expect(await lastGood.read(request(), 2)).toBeNull();
  const current = "<!doctype html><html>Current generation copy</html>";
  await lastGood.store(request(), response(current, { "x-njpbs-code-generation": "2" }));
  expect(await (await lastGood.read(request(), 2))!.text()).toBe(current);
  expect(await (await lastGood.read(request(), 1))!.text()).toBe(html);
});

it.each([
  { schemaVersion: 1, commitSha: rendererSha, generation: 2 },
  { schemaVersion: 1, commitSha: "b".repeat(40), generation: 1 },
  { schemaVersion: 2, commitSha: rendererSha, generation: 1 },
  { schemaVersion: 1, commitSha: rendererSha, generation: 0 },
  null,
])("keeps current Assets when retained artifact identity is different or unknown (%j)", async identity => {
  const { lastGood } = setup();
  await lastGood.store(request(), response());
  const worker = outageWorker(lastGood, undefined, async () => Response.json(identity));
  expect(await (await worker.fetch(request()))!.text()).toBe("Assets copy");
});

it.each(["unavailable", "malformed", "oversized"])("keeps Assets when its publication identity is %s", async failure => {
  const { lastGood } = setup();
  await lastGood.store(request(), response());
  const worker = outageWorker(lastGood, undefined, async () => {
    if (failure === "unavailable") throw new Error("Assets publication unavailable");
    return new Response(failure === "oversized" ? "x".repeat(64 * 1024 + 1) : "bad JSON");
  });
  expect(await (await worker.fetch(request()))!.text()).toBe("Assets copy");
});

it("bounds a stalled artifact identity read before falling back to Assets", async () => {
  const { lastGood } = setup();
  await lastGood.store(request(), response());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let started!: () => void;
  const barrier = new Promise<void>(resolve => { started = resolve; });
  const worker = outageWorker(lastGood, undefined, async () => {
    started(); return new Promise<Response>(() => {});
  });
  const pending = worker.fetch(request());
  await barrier;
  await vi.advanceTimersByTimeAsync(501);
  expect(await (await pending)!.text()).toBe("Assets copy");
});

it.each(["", "0", "01", "NaN", "9007199254740992"])("refuses an invalid retained code generation: %s", async generation => {
  const { lastGood, entries } = setup();
  await lastGood.store(request(), response(html, { "x-njpbs-code-generation": generation }));
  expect(entries.size).toBe(0);
});

it.each(["before", "during"])("keeps durable withdrawal ahead of stored HTML (%s storage read)", async when => {
  const { lastGood, store } = setup();
  await lastGood.store(request(), response());
  const marker = { pageId: "contact", operationId: "A".repeat(20), sourceVersion: 7,
    revision: 3, ownedPaths: ["/contact/"], verifiedAt: 1234 };
  let withdrawn = when === "before";
  const get = store.get;
  store.get = async key => { const object = await get(key); withdrawn = true; return object; };
  const worker = outageWorker(lastGood, async () => withdrawn ? marker : null);
  expect((await worker.fetch(request()))!.status).toBe(410);
});

it("refuses static copies when withdrawal state is unknown and keeps Assets when only last-good storage fails", async () => {
  const { lastGood, store } = setup();
  await lastGood.store(request(), response());
  const worker = outageWorker(lastGood, async () => { throw new Error("Withdrawal storage unavailable"); });
  const unknown = (await worker.fetch(request()))!;
  expect(unknown.status).toBe(503);
  expect(await unknown.text()).toBe("Page unavailable");
  store.get = async () => { throw new Error("R2 unavailable"); };
  expect(await (await outageWorker(lastGood).fetch(request()))!.text()).toBe("Assets copy");
});

it.each(["stable", "drift", "storage failure"])("retains only a finally verified Page without delaying the response (%s)", async mode => {
  const { lastGood, entries, store } = setup();
  const pending: Promise<unknown>[] = [];
  const contextDigest = sha("njpbs-public-context-v1:1");
  const decision = { kind: "context-page" as const,
    contextReceipt: { rendererSha, contextRevision: 1, contextDigest, codeGeneration: 1, path: "/contact/", source: "site" as const },
    renderContext: { kind: "published-page-context" as const, pageId: "contact", path: "/contact/", page: null,
      sourceSeal: { rendererSha, contextRevision: 1, contextDigest, codeGeneration: 1 },
      posts: [], assets: [], joinedRecords: [], settings: [], navigationPages: [] } };
  let reads = 0;
  if (mode === "storage failure") store.put = async () => { throw new Error("R2 unavailable"); };
  const worker = createNoBuildPageWorker({ target, rendererSha, rendererReady: true, lastGood,
    waitUntil: task => pending.push(task), readWithdrawal: async () => null,
    cache: { async match() {}, async put() {} }, render: async () => "", renderContext: async () => html,
    getDecision: async () => {
      if (++reads > 1 && mode === "drift") throw new Error("CMS RPC changed during rendering");
      return decision;
    }, fetchAsset: async () => new Response("Assets copy") });
  const result = await worker.fetch(request());
  expect(result!.status).toBe(200);
  expect(await result!.text()).toBe(mode === "drift" ? "Assets copy" : html);
  await Promise.all(pending);
  expect(entries.size).toBe(mode === "stable" ? 1 : 0);
  if (mode === "stable") expect(await (await lastGood.read(request(), 1))!.text()).toBe(html);
});

function postWorker(lastGood: ReturnType<typeof setup>["lastGood"],
  overrides: Partial<Parameters<typeof createTransitionalPostReadWorker>[0]> = {}) {
  const pending: Promise<unknown>[] = [];
  const worker = createTransitionalPostReadWorker({ target, rendererSha, lastGood,
    // A Cache API outage must not prevent fresh CMS authority or R2 fallback.
    cache: { async match() { throw new Error("Cache unavailable"); }, async put() { throw new Error("Cache unavailable"); } },
    render: async () => html, waitUntil: task => pending.push(task),
    readWithdrawal: async () => null, readRecordAuthority: async () => ({ owned: true, withdrawal: null }),
    recordRendererReady: true,
    getDecision: async () => { throw new Error("CMS unavailable"); },
    fetchAsset: async request => new URL(request.url).pathname === "/_publication.json"
      ? Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 7 }) : new Response("Assets copy"),
    ...overrides });
  return { worker, pending };
}
const postPath = "/posts/shadow-fixture/";
const postReceipt = { schemaVersion: 1 as const, postId: postFixture.document.id, operationId: "A".repeat(20),
  rendererSha, sourceVersion: 7, slug: "shadow-fixture", ownedSlugs: ["shadow-fixture", "old-fixture"],
  generation: 999, visible: true, contextDigest: "b".repeat(64), admissionRevision: 1 };
const postMarker: Withdrawal = { postId: postFixture.document.id, operationId: "B".repeat(20),
  sourceVersion: 8, revision: 1000, ownedSlugs: postReceipt.ownedSlugs, verifiedAt: 1 };
const healthyPostDecision = async (path: string): Promise<NoBuildPostReply> => path === "/_publication.json"
  ? { kind: "receipts", catalog: { schemaVersion: 1, rendererSha, generation: 999, contextDigest: "b".repeat(64),
    admissionRevision: 1, posts: [postReceipt] } }
  : { kind: "post", receipt: postReceipt, published: postFixture };

it("retains an actual Post response under its code artifact generation and serves it during an authority outage", async () => {
  const { lastGood, entries } = setup();
  let releaseIdentity!: () => void;
  const identityBarrier = new Promise<void>(resolve => { releaseIdentity = resolve; });
  const healthy = postWorker(lastGood, { getDecision: healthyPostDecision, fetchAsset: async () => {
    await identityBarrier;
    return Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 7 });
  } });
  const fetching = healthy.worker.fetch(new Request(target.origin + postPath));
  releaseIdentity();
  const original = await fetching;
  expect(original!.headers.get("x-njpbs-content-source")).toBe("cms-no-build");
  expect(original!.headers.get("x-njpbs-code-generation")).toBe("7");
  expect(await original!.text()).toBe(html);
  await Promise.all(healthy.pending);
  expect(entries.size).toBe(1);
  expect([...entries.values()][0].metadata.codeGeneration).toBe("7");
  expect(await lastGood.read(new Request(target.origin + postPath), 999)).toBeNull();
  const fallback = await postWorker(lastGood).worker.fetch(new Request(target.origin + postPath));
  expect(await fallback!.text()).toBe(html);
  expect(fallback!.headers.get("x-njpbs-content-source")).toBe("r2-last-good");
  expect(fallback!.headers.has("x-njpbs-publication-operation")).toBe(false);
});

it("labels the live Post artifact generation even without a retention binding", async () => {
  const { lastGood } = setup();
  const healthy = postWorker(lastGood, { getDecision: healthyPostDecision, lastGood: undefined });
  const original = await healthy.worker.fetch(new Request(target.origin + postPath));
  expect(original!.headers.get("x-njpbs-code-generation")).toBe("7");
  expect(original!.headers.get("x-njpbs-code-generation")).not.toBe(String(postReceipt.generation));
  expect(await original!.text()).toBe(html);
  await Promise.all(healthy.pending);
});

it("bounds a stalled Post artifact read and preserves HTML without a false warm certificate", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { lastGood, entries } = setup();
  let started!: () => void;
  const barrier = new Promise<void>(resolve => { started = resolve; });
  const healthy = postWorker(lastGood, { getDecision: healthyPostDecision, fetchAsset: async () => {
    started(); return new Promise<Response>(() => {});
  } });
  const fetching = healthy.worker.fetch(new Request(target.origin + postPath));
  await barrier;
  await vi.advanceTimersByTimeAsync(501);
  const original = await fetching;
  expect(original!.headers.has("x-njpbs-code-generation")).toBe(false);
  expect(await original!.text()).toBe(html);
  await Promise.all(healthy.pending);
  expect(entries.size).toBe(0);
  expect(log).toHaveBeenCalledWith("public-last-good-retention", {
    outcome: "failed", stage: "artifact-identity", reason: "unavailable",
  });
});

it.each(["unavailable", "different"])("keeps a receipt-derived code Post generation when Assets is %s", async mode => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { lastGood, entries } = setup();
  const healthy = postWorker(lastGood, { getDecision: async () => ({ kind: "pass" }),
    readCodePost: async () => response(html, { "x-njpbs-content-source": "cms-code-post-context",
      "x-njpbs-code-generation": "7", "x-njpbs-code-receipt-sha256": "c".repeat(64) }),
    fetchAsset: async request => {
      if (new URL(request.url).pathname === "/_content-status.json") return Response.json({
        schemaVersion: 1, commitSha: rendererSha, generation: 7, buildBatchId: "cms-" + "A".repeat(20),
        routes: [{ path: postPath, source: "cms", recordContext: true, contentKey: "b".repeat(64), sourceVersion: 7 }],
      });
      if (mode === "unavailable") throw new Error("Fixture identity unavailable");
      return Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 8 });
    } });
  const original = await healthy.worker.fetch(new Request(target.origin + postPath));
  expect(original!.headers.get("x-njpbs-content-source")).toBe("cms-code-post-context");
  expect(original!.headers.get("x-njpbs-code-generation")).toBe("7");
  expect(original!.headers.get("x-njpbs-code-receipt-sha256")).toBe("c".repeat(64));
  expect(await original!.text()).toBe(html);
  await Promise.all(healthy.pending);
  expect(entries.size).toBe(0);
  expect(log).toHaveBeenCalledWith("public-last-good-retention", {
    outcome: "failed", stage: "artifact-identity", reason: mode === "different" ? "identity-mismatch" : "unavailable",
  });
});

it.each(["programs", "shows", "events"])("retains verified %s detail bytes with the original publisher unchanged", async familyPath => {
  const { lastGood, entries } = setup();
  const path = `/${familyPath}/existing-record/`, family = familyPath === "events" ? "events" : "programs";
  const healthy = postWorker(lastGood, { getDecision: async () => ({ kind: "background", status: 200,
    bytes: Buffer.from(html).toString("base64"), headers: { "content-type": "text/html; charset=utf-8",
      "x-njpbs-background-renderer-sha": rendererSha, "x-njpbs-background-context-sha256": "b".repeat(64),
      "x-njpbs-background-state": "current", "x-njpbs-public-context-revision": "1",
      "x-njpbs-record-id": "existing-record", "x-njpbs-record-family": family,
      "x-njpbs-record-generation": "999", "x-njpbs-record-visible": "true" } }) });
  const original = await healthy.worker.fetch(new Request(target.origin + path));
  expect(original!.status).toBe(200);
  expect(original!.headers.get("x-njpbs-html-sha256")).toBe(sha(html));
  expect(await original!.text()).toBe(html);
  await Promise.all(healthy.pending);
  expect(entries.size).toBe(1);
  const fallback = await postWorker(lastGood).worker.fetch(new Request(target.origin + path));
  expect(await fallback!.text()).toBe(html);
  expect(fallback!.headers.get("x-njpbs-content-source")).toBe("r2-last-good");
  expect(fallback!.headers.has("x-njpbs-record-id")).toBe(false);
});

async function seedPost(lastGood: ReturnType<typeof setup>["lastGood"]) {
  await lastGood.store(new Request(target.origin + postPath), response(html, {
    "x-njpbs-content-source": "cms-no-build", "x-njpbs-code-generation": "7" }));
}

it.each(["before", "during"])("keeps a durable Post withdrawal ahead of R2 (%s storage read)", async when => {
  const { lastGood, store } = setup();
  await seedPost(lastGood);
  let marker: Withdrawal | null = when === "before" ? postMarker : null;
  const get = store.get;
  store.get = async key => { const object = await get(key); marker = postMarker; return object; };
  const { worker } = postWorker(lastGood, { readWithdrawal: async () => marker });
  const result = await worker.fetch(new Request(target.origin + postPath));
  expect(result!.status).toBe(410);
  expect(result!.headers.get("x-njpbs-content-source")).toBe("durable-post-withdrawal");
});

it.each(["new artifact", "HEAD", "query", "credential"])("keeps the Post fallback boundary: %s", async mode => {
  const { lastGood } = setup();
  await seedPost(lastGood);
  const { worker } = postWorker(lastGood, {
    ...(mode === "new artifact" ? { fetchAsset: async request => new URL(request.url).pathname === "/_publication.json"
      ? Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 8 }) : new Response("Assets copy") } : {}) });
  const result = await worker.fetch(new Request(target.origin + postPath + (mode === "query" ? "?preview=1" : ""), {
    method: mode === "HEAD" ? "HEAD" : "GET", ...(mode === "credential" ? { headers: { authorization: "synthetic" } } : {}) }));
  expect(await result!.text()).toBe(mode === "HEAD" ? "" : "Assets copy");
  expect(result!.headers.get("x-njpbs-content-source")).toBe(mode === "HEAD" ? "r2-last-good" : null);
});

it.each(["Post before", "Post during", "Record before", "Record during"])(
  "refuses Assets and last-good copies when withdrawal state is unknown (%s storage read)", async mode => {
  const { lastGood, store } = setup();
  await seedPost(lastGood);
  const recordPath = "/programs/existing-record/";
  await lastGood.store(new Request(target.origin + recordPath), response(html, { "x-njpbs-code-generation": "7",
    "x-njpbs-background-state": "current", "x-njpbs-background-renderer-sha": rendererSha,
    "x-njpbs-record-id": "existing-record", "x-njpbs-record-family": "programs", "x-njpbs-record-visible": "true" }));
  let unknown = mode.endsWith("before");
  const get = store.get;
  store.get = async key => { const object = await get(key); unknown = true; return object; };
  const assetPaths: string[] = [];
  const read = async () => { if (unknown) throw new Error("Durable withdrawal manifest is invalid"); return null; };
  const { worker } = postWorker(lastGood, {
    ...(mode.startsWith("Post") ? { readWithdrawal: read }
      : { readRecordAuthority: async () => { await read(); return { owned: true, withdrawal: null }; } }),
    fetchAsset: async request => {
      assetPaths.push(new URL(request.url).pathname);
      return new URL(request.url).pathname === "/_publication.json"
        ? Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 7 }) : new Response("Assets copy");
    } });
  for (const method of ["GET", "HEAD"]) {
    const result = await worker.fetch(new Request(target.origin + (mode.startsWith("Post") ? postPath : recordPath), { method }));
    expect(result!.status).toBe(503);
    expect(result!.headers.get("cache-control")).toBe("no-store");
    expect(await result!.text()).not.toContain(html);
  }
  expect(assetPaths.filter(path => path !== "/_publication.json")).toEqual([]);
});

it.each(["known", "unknown"])("does not return an old record when withdrawal arrives during the stored-copy read (%s final read)", async final => {
  const { lastGood, store } = setup();
  const path = "/programs/existing-record/";
  await lastGood.store(new Request(target.origin + path), response(html, { "x-njpbs-code-generation": "7",
    "x-njpbs-background-state": "current", "x-njpbs-background-renderer-sha": rendererSha,
    "x-njpbs-record-id": "existing-record", "x-njpbs-record-family": "programs", "x-njpbs-record-visible": "true" }));
  let marker: RecordWithdrawal | null = null;
  const get = store.get;
  store.get = async key => { const object = await get(key); marker = { recordId: "existing-record", family: "programs",
    operationId: "B".repeat(20), sourceVersion: 8, revision: 1000, ownedPaths: [path], verifiedAt: 1 }; return object; };
  let markerReads = 0;
  const { worker } = postWorker(lastGood, { readRecordAuthority: async () => {
    if (marker && ++markerReads > 1 && final === "unknown") throw new Error("Durable withdrawal manifest is invalid");
    return { owned: true, withdrawal: marker };
  } });
  const result = await worker.fetch(new Request(target.origin + path));
  expect(result!.status).toBe(410);
  expect(result!.headers.get("x-njpbs-content-source")).toBe("durable-record-withdrawal");
  expect(result!.headers.get("x-njpbs-publication-operation")).toBe("B".repeat(20));
  expect(result!.headers.get("x-njpbs-withdrawal-revision")).toBe("1000");
  if (final === "unknown") expect(markerReads).toBe(2);
});

it.each(["stale", "old renderer", "wrong family", "hidden"])("does not retain a record with %s proof", async mode => {
  const { lastGood, entries } = setup();
  await lastGood.store(new Request(target.origin + "/programs/existing-record/"), response(html, {
    "x-njpbs-background-state": mode === "stale" ? "stale" : "current",
    "x-njpbs-background-renderer-sha": mode === "old renderer" ? "b".repeat(40) : rendererSha,
    "x-njpbs-background-assets": "verified", "x-njpbs-record-id": "existing-record",
    "x-njpbs-record-family": mode === "wrong family" ? "events" : "programs",
    "x-njpbs-record-visible": mode === "hidden" ? "false" : "true" }));
  expect(entries.size).toBe(0);
});

it("keeps a current alias redirect without retaining its old route", async () => {
  const { lastGood, entries } = setup();
  const { worker, pending } = postWorker(lastGood, { getDecision: async (path): Promise<NoBuildPostReply> =>
    path === "/_publication.json" ? { kind: "receipts", catalog: { schemaVersion: 1, rendererSha, generation: 999,
      contextDigest: "b".repeat(64), admissionRevision: 1, posts: [postReceipt] } }
      : { kind: "alias", receipt: postReceipt, location: postPath } });
  const result = await worker.fetch(new Request(target.origin + "/posts/old-fixture/"));
  expect(result!.status).toBe(308);
  expect(result!.headers.get("location")).toBe(postPath);
  await Promise.all(pending);
  expect(entries.size).toBe(0);
});
