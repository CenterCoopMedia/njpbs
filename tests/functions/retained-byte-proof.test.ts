import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publicationTarget } from "../../functions/lib/publication-target";
import { createRetainedByteObservation, createRetainedByteProofHandler, RETAINED_PROOF_HEADER, RETAINED_PROOF_TYPE, type RetainedProofOwnerContext } from "../../workers/src/retained-byte-proof";
import { lastGoodObjectKey } from "../../workers/src/public-content-last-good";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const target = publicationTarget("production");
const deployment = { rendererSha: "a".repeat(40), versionId: "immutable-worker-version-7", codeGeneration: 7 };
const html = '<!doctype html><html><body>Exact origin é bytes</body></html><script type="module" src="/layout.js"></script>\n';
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bodyDigest = sha(html);
async function setup(path = "/contact/", context = false, selectedTarget = target) {
  const target = selectedTarget;
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
  let time = 1_800_000_000_000;
  const now = () => time;
  const authority = {
    "x-njpbs-content-source": path.startsWith("/posts/") ? "cms-no-build" : context ? "cms-page-context" : "cms-page-no-build",
    "x-njpbs-context-sha256": "b".repeat(64), "x-njpbs-public-context-revision": context ? "21" : null,
    "x-njpbs-publication-operation": context ? null : "A".repeat(20), "x-njpbs-source-version": context ? null : "9",
    "x-njpbs-snapshot-sha256": context ? null : "c".repeat(64), "x-njpbs-admission-revision": context ? null : "1",
  };
  const expected = { path, bodyDigest, authority };
  const headers = { "content-type": "text/html; charset=utf-8", "x-njpbs-renderer-sha": deployment.rendererSha,
    "x-njpbs-code-generation": "7", "x-njpbs-html-sha256": bodyDigest,
    ...Object.fromEntries(Object.entries(authority).filter(([, value]) => value !== null)) };
  const entries = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; etag: string }>();
  const store = {
    async head(key: string) { const value = entries.get(key); return value ? { size: value.bytes.length, customMetadata: value.metadata, etag: value.etag } : null; },
    async get(key: string) { const value = entries.get(key); return value ? { size: value.bytes.length, body: new Response(value.bytes).body!, customMetadata: value.metadata } : null; },
    async put(key: string, bytes: Uint8Array, options: R2PutOptions) {
      entries.set(key, { bytes: bytes.slice(), metadata: { ...options.customMetadata }, etag: "fixture-etag" });
    },
  };
  const serve = vi.fn(async (request: Request, proof?: RetainedProofOwnerContext) => {
    const response = new Response(html, { headers });
    if (proof) await proof.lastGood.store(request, response);
    return response;
  });
  const cacheEntries = new Map<string, Response>();
  const cache = {
    async match(input: RequestInfo | URL) { return cacheEntries.get(new Request(input).url)?.clone(); },
    async put(input: RequestInfo | URL, response: Response) { cacheEntries.set(new Request(input).url, response.clone()); },
  };
  const handler = createRetainedByteProofHandler({ target, deployment, key, store, cache, serve, now });
  const observe = (changes = {}) => createRetainedByteObservation({ target, deployment, expected, key, now, ...changes });
  return { key, expected, headers, entries, store, cache, cacheEntries, serve, handler, observe, advance: (ms: number) => { time += ms; } };
}

it.each([["/contact/", false], ["/about/", true], ["/posts/published-post/", false]])(
  "proves full origin/R2 bytes at the public canonical %s while ordinary HTML receives analytics", async (path, context) => {
    const s = await setup(path as string, context as boolean);
    const edge = async (request: Request) => {
      const response = await s.handler.fetch(request);
      return response.headers.get("content-type") === "text/html; charset=utf-8"
        ? new Response((await response.text()).replace("</body>", '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script></body>'), { headers: response.headers })
        : response;
    };
    const viewer = await edge(new Request(`${target.origin}${path}`));
    expect(sha(await viewer.text())).not.toBe(bodyDigest);
    expect(viewer.headers.get("cache-control") ?? "").not.toContain("no-transform");
    const observation = await s.observe();
    const proof = await edge(observation.request);
    expect(proof.headers.get("content-type")).toBe(RETAINED_PROOF_TYPE);
    expect(proof.headers.get("cache-control")).toBe("no-store");
    expect(await observation.verify(proof, s.store)).toEqual({ boundary: "origin-html", url: `${target.origin}${path}`, deployment, bodyDigest,
      size: new TextEncoder().encode(html).length, objectKey: lastGoodObjectKey(target, deployment.rendererSha, 7, path as string) });
    expect(s.serve.mock.calls[1][0].headers.has(RETAINED_PROOF_HEADER)).toBe(false);
    await expect(observation.verify(proof, s.store)).rejects.toThrow("refused");
  });

it("proves retained origin bytes for the canonical development target", async () => {
  const target = publicationTarget("development");
  const s = await setup("/contact/", false, target);
  const observation = await s.observe();
  const response = await s.handler.fetch(observation.request);
  expect(response.status).toBe(200);
  expect(await observation.verify(response, s.store)).toMatchObject({
    boundary: "origin-html", url: `${target.origin}/contact/`, deployment, bodyDigest,
  });
  expect(s.entries.size).toBe(1);
});

it.each(["uncorrupted", "body", "header-digest", "renderer", "generation", "operation", "snapshot", "source", "partial", "cookie", "trailer"])(
  "validates origin bytes and identity before retention (%s)", async change => {
    const s = await setup();
    const put = vi.spyOn(s.store, "put");
    s.serve.mockImplementation(async (request, proof) => {
      const response = new Response(change === "body" ? html.replace("Exact", "Altered") :
        change === "trailer" ? html + "<div>unrelated trailer</div>" : html, { headers: s.headers });
      const edits: Record<string, [string, string]> = { "header-digest": ["x-njpbs-html-sha256", "d".repeat(64)],
        renderer: ["x-njpbs-renderer-sha", "d".repeat(40)], generation: ["x-njpbs-code-generation", "8"],
        operation: ["x-njpbs-publication-operation", "invalid"], snapshot: ["x-njpbs-snapshot-sha256", "invalid"],
        source: ["x-njpbs-content-source", "r2-last-good"], partial: ["content-range", "bytes 0-10/100"], cookie: ["set-cookie", "fixture"] };
      if (edits[change]) response.headers.set(...edits[change]);
      await proof!.lastGood.store(request, response);
      return response;
    });
    const observation = await s.observe();
    const response = await s.handler.fetch(observation.request);
    const uncorrupted = change === "uncorrupted";
    expect(response.status).toBe(uncorrupted ? 200 : 503);
    expect(s.entries.size).toBe(uncorrupted ? 1 : 0);
    expect(put).toHaveBeenCalledTimes(uncorrupted ? 1 : 0);
    if (uncorrupted) expect(await observation.verify(response, s.store)).toMatchObject({ bodyDigest });
  });

it.each(["body", "digest", "path", "renderer", "schema", "generation", "missing"])(
  "independently reads exact R2 bytes and refuses %s", async change => {
    const s = await setup("/posts/published-post/");
    const observation = await s.observe();
    const response = await s.handler.fetch(observation.request);
    const object = [...s.entries.values()][0];
    if (change === "body") object.bytes = new TextEncoder().encode(html.replace("Exact", "Wrong"));
    if (change === "digest") object.metadata.bodyDigest = "d".repeat(64);
    if (change === "path") object.metadata.path = "/about/";
    if (change === "renderer") object.metadata.rendererSha = "d".repeat(40);
    if (change === "schema") object.metadata.schemaVersion = "2";
    if (change === "generation") object.metadata.codeGeneration = "8";
    if (change === "missing") s.entries.clear();
    await expect(observation.verify(response, s.store)).rejects.toThrow("refused");
  });

it.each(["digest", "operation", "context", "snapshot", "revision", "version", "generation", "renderer", "path", "worker"])(
  "rejects a signed response whose %s differs from independent expectations", async change => {
    const s = await setup();
    const observation = await s.observe();
    const response = await s.handler.fetch(observation.request);
    const envelope = await response.json() as { proof: any; mac: string };
    const proof = envelope.proof;
    if (change === "digest") proof.bodyDigest = "d".repeat(64);
    if (change === "operation") proof.authority["x-njpbs-publication-operation"] = "B".repeat(20);
    if (change === "context") proof.authority["x-njpbs-context-sha256"] = "d".repeat(64);
    if (change === "snapshot") proof.authority["x-njpbs-snapshot-sha256"] = "d".repeat(64);
    if (change === "revision") proof.authority["x-njpbs-source-version"] = "10";
    if (change === "version") proof.deployment.versionId = "old-version";
    if (change === "generation") proof.deployment.codeGeneration = 6;
    if (change === "renderer") proof.deployment.rendererSha = "d".repeat(40);
    if (change === "path") proof.url = `${target.origin}/unrelated/`;
    if (change === "worker") proof.worker = "njpbs-dev-public";
    // Even an authentic response from a mismatched deployment/operation refuses.
    envelope.mac = Buffer.from(await crypto.subtle.sign("HMAC", s.key,
      new TextEncoder().encode(JSON.stringify(["njpbs-retained-response-v1", proof])))).toString("hex");
    await expect(observation.verify(new Response(JSON.stringify(envelope), { headers: { "content-type": RETAINED_PROOF_TYPE } }), s.store)).rejects.toThrow("refused");
  });

it.each(["forged-mac", "changed-body", "extra-fields", "html-injection", "html-fallback", "redirect", "oversize", "whitespace"])(
  "refuses an unrelated or altered public response (%s)", async change => {
    const s = await setup();
    const observation = await s.observe();
    const response = await s.handler.fetch(observation.request);
    const envelope = await response.json() as { proof: any; mac: string; untrusted?: string };
    if (change === "forged-mac") envelope.mac = "0".repeat(64);
    if (change === "changed-body") envelope.proof.body = btoa(html.replace("Exact", "Forged"));
    if (change === "extra-fields") envelope.untrusted = "extra";
    let text = JSON.stringify(envelope);
    if (change === "html-injection") text += '<script src="beacon.js"></script>';
    if (change === "whitespace") text += "\n";
    if (change === "oversize") text = " ".repeat(6 * 1024 * 1024 + 1);
    const publicResponse = change === "html-fallback" ? new Response(html, { headers: s.headers }) :
      change === "redirect" ? Response.redirect(`${target.origin}/unrelated/`) :
      new Response(text, { headers: { "content-type": RETAINED_PROOF_TYPE } });
    await expect(observation.verify(publicResponse, s.store)).rejects.toThrow("refused");
  });

it("rejects response replay into a new observation and tampered request challenges before rendering", async () => {
  const s = await setup();
  const first = await s.observe(), second = await s.observe();
  const response = await s.handler.fetch(first.request);
  await expect(second.verify(response, s.store)).rejects.toThrow("refused");
  const headers = new Headers(second.request.headers);
  headers.set(RETAINED_PROOF_HEADER, headers.get(RETAINED_PROOF_HEADER)!.replace('"mac":"', '"mac":"0'));
  expect((await s.handler.fetch(new Request(second.request, { headers }))).status).toBe(503);
  expect(s.serve).toHaveBeenCalledTimes(1);
});

it.each([5000, -1])("refuses stale/future challenges and responses at clock delta %s", async delta => {
  const s = await setup();
  const observation = await s.observe();
  const response = await s.handler.fetch(observation.request);
  s.advance(delta);
  expect((await s.handler.fetch(observation.request)).status).toBe(503);
  await expect(observation.verify(response, s.store)).rejects.toThrow("refused");
});

it("expires across slow retention and independently authenticated R2 I/O", async () => {
  const s = await setup();
  const observation = await s.observe();
  const response = await s.handler.fetch(observation.request);
  await expect(observation.verify(response, { get: async key => { s.advance(5000); return s.store.get(key); } })).rejects.toThrow("refused");
  const next = await s.observe();
  const put = s.store.put;
  s.entries.clear();
  s.store.put = async (...args) => { s.advance(5000); return put(...args); };
  expect((await s.handler.fetch(next.request)).status).toBe(503);
});

it("preserves an ordinary GET exactly without retention or proof settings", async () => {
  const s = await setup();
  const response = await s.handler.fetch(new Request(`${target.origin}/contact/`));
  expect(await response.text()).toBe(html);
  expect(response.headers.get("x-njpbs-publication-operation")).toBe("A".repeat(20));
  expect(response.headers.has(RETAINED_PROOF_HEADER)).toBe(false);
  expect(s.entries.size).toBe(0);
});

it.each(["route", "origin", "query", "fragment", "method", "cookie", "authorization", "range", "invalid-json"])(
  "refuses a proof requested through the wrong or unsafe public route (%s)", async change => {
    const s = await setup(), observation = await s.observe();
    const headers = new Headers(observation.request.headers);
    let url = observation.request.url, method = "GET";
    if (change === "route") url = `${target.origin}/other/`;
    if (change === "origin") url = "https://dev.njpbs.org/contact/";
    if (change === "query") url += "?preview=1";
    if (change === "fragment") url += "#other";
    if (change === "method") method = "HEAD";
    if (["cookie", "authorization", "range"].includes(change)) headers.set(change, "synthetic");
    if (change === "invalid-json") headers.set(RETAINED_PROOF_HEADER, "malformed");
    expect((await s.handler.fetch(new Request(url, { method, headers }))).status).toBe(503);
    expect(s.serve).not.toHaveBeenCalled();
  });

it("bounds a stalled real owner call and aborts its request without returning a proof", async () => {
  const s = await setup(), observation = await s.observe();
  let signal: AbortSignal | undefined;
  s.serve.mockImplementation(async request => { signal = request.signal; return new Promise<Response>(() => {}); });
  vi.useFakeTimers();
  try {
    const result = s.handler.fetch(observation.request);
    // Crypto runs outside fake timers; flush its microtasks before the deadline.
    await vi.waitFor(() => expect(s.serve).toHaveBeenCalled(), { interval: 1 });
    s.advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).status).toBe(503);
    expect(signal!.aborted).toBe(true);
    expect(s.entries.size).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("hashes all decoded origin bytes even when a tampered body has an authentic signature", async () => {
  const s = await setup(), observation = await s.observe();
  const response = await s.handler.fetch(observation.request);
  const envelope = await response.json() as { proof: { body: string }; mac: string };
  envelope.proof.body = Buffer.from(html + "\n").toString("base64");
  envelope.mac = Buffer.from(await crypto.subtle.sign("HMAC", s.key,
    new TextEncoder().encode(JSON.stringify(["njpbs-retained-response-v1", envelope.proof])))).toString("hex");
  await expect(observation.verify(new Response(JSON.stringify(envelope), { headers: { "content-type": RETAINED_PROOF_TYPE } }), s.store)).rejects.toThrow("refused");
});

it("bounds a stalled public proof stream and returns only a bounded error on private storage failure", async () => {
  const s = await setup(), observation = await s.observe();
  const response = await s.handler.fetch(observation.request);
  await expect(observation.verify(response, { get: async () => { throw new Error("synthetic provider diagnostic must stay private"); } })).rejects.toThrow(/^Retained byte proof refused$/);
  const next = await s.observe();
  vi.useFakeTimers();
  try {
    const verification = next.verify(new Response(new ReadableStream<Uint8Array>({ start() {} }),
      { headers: { "content-type": RETAINED_PROOF_TYPE } }), s.store);
    const rejected = expect(verification).rejects.toThrow("refused");
    s.advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
  } finally { vi.useRealTimers(); }
});

it("refuses real Page churn without writing over a newer retained copy", async () => {
  const { createNoBuildPageWorker } = await import("../../workers/src/no-build-page-worker");
  const s = await setup("/contact/", true);
  // Existing current owner retained revision 21. A later bounded-churn
  // response has valid headers/bytes, but its owner refuses retention.
  const baseline = await s.observe();
  expect((await s.handler.fetch(baseline.request)).status).toBe(200);
  const before = [...s.entries.values()].map(value => ({ bytes: value.bytes.slice(), metadata: { ...value.metadata }, etag: value.etag }));
  const put = vi.spyOn(s.store, "put");
  const pending: Promise<unknown>[] = [];
  let revision = 0;
  const getDecision = async () => {
    revision++;
    const contextDigest = sha(`njpbs-public-context-v1:${revision}`);
    return { kind: "context-page" as const,
      contextReceipt: { rendererSha: deployment.rendererSha, contextRevision: revision, contextDigest,
        codeGeneration: 7, path: "/contact/", source: "site" as const },
      renderContext: { kind: "published-page-context" as const, pageId: "contact", path: "/contact/", page: null,
        sourceSeal: { rendererSha: deployment.rendererSha, contextRevision: revision, contextDigest, codeGeneration: 7 },
        posts: [], assets: [], joinedRecords: [], settings: [], navigationPages: [] } };
  };
  s.serve.mockImplementation(async (request, proof) => (await createNoBuildPageWorker({ target,
    rendererSha: deployment.rendererSha, rendererReady: true, ...proof!, getDecision,
    render: async () => "<!doctype html><html>Unused receipt lane</html>",
    renderContext: async content => `<!doctype html><html>Churning revision ${content.target.contextRevision}</html>`,
    readWithdrawal: async () => null, fetchAsset: async () => new Response("Assets"),
    waitUntil: task => { pending.push(task); } }).fetch(request))!);
  const observation = await s.observe();
  expect((await s.handler.fetch(observation.request)).status).toBe(503);
  expect(revision).toBeGreaterThan(1);
  await Promise.all(pending);
  expect(put).not.toHaveBeenCalled();
  expect([...s.entries.values()]).toEqual(before);
  expect(console.warn).toHaveBeenCalledWith("public-last-good-retention", {
    outcome: "failed", stage: "proof-retention", reason: "unavailable" });
});

it("reports proof failures with bounded categories and keeps provider diagnostics private", async () => {
  const s = await setup(), observation = await s.observe();
  s.store.put = async () => { throw new Error("synthetic private provider diagnostic"); };
  expect((await s.handler.fetch(observation.request)).status).toBe(503);
  expect(console.warn).toHaveBeenCalledWith("public-last-good-retention", {
    outcome: "failed", stage: "proof-origin", reason: "unavailable" });
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("synthetic private provider diagnostic");
});

it("refuses proof while the real Post owner keeps observing publication purges", async () => {
  const { createTransitionalPostReadWorker } = await import("../../workers/src/transitional-post-read-worker");
  const fixture = (await import("../../site/tests/fixtures/shadow-posts/post.json")).default;
  const s = await setup("/posts/shadow-fixture/");
  const receipt = { schemaVersion: 1 as const, postId: fixture.document.id, operationId: "A".repeat(20),
    rendererSha: deployment.rendererSha, sourceVersion: 7, slug: "shadow-fixture", ownedSlugs: ["shadow-fixture"],
    generation: 999, visible: true, contextDigest: "b".repeat(64), snapshotDigest: "c".repeat(64), admissionRevision: 1 };
  const pending: Promise<unknown>[] = [];
  let purge = false;
  const match = s.cache.match;
  s.cache.match = async input => {
    // Ongoing purges remove the tagged witness even after each fresh read.
    if (purge && new URL(new Request(input).url).searchParams.has("purge-fence")) return undefined;
    return match(input);
  };
  const render = vi.fn(async () => html);
  s.expected.authority["x-njpbs-source-version"] = "7";
  s.serve.mockImplementation(async (request, proof) => (await createTransitionalPostReadWorker({ target,
    rendererSha: deployment.rendererSha, rendererReady: true, ...proof!, render,
    readWithdrawal: async () => null, waitUntil: task => { pending.push(task); },
    fetchAsset: async request => new URL(request.url).pathname === "/_publication.json"
      ? Response.json({ schemaVersion: 1, commitSha: deployment.rendererSha, generation: 7 }) : new Response("Assets"),
    getDecision: async path => path === "/_publication.json"
      ? { kind: "receipts", catalog: { schemaVersion: 1, rendererSha: deployment.rendererSha, generation: 999,
        contextDigest: "b".repeat(64), admissionRevision: 1, posts: [receipt] } }
      : { kind: "post", receipt, published: fixture } }).fetch(request))!);
  const baseline = await s.observe();
  expect((await s.handler.fetch(baseline.request)).status).toBe(200);
  const before = [...s.entries.values()].map(value => ({ bytes: value.bytes.slice(), metadata: { ...value.metadata }, etag: value.etag }));
  const put = vi.spyOn(s.store, "put");
  purge = true;
  const observation = await s.observe();
  const refused = await s.handler.fetch(observation.request);
  expect(refused.status).toBe(503);
  await Promise.all(pending);
  expect(render).toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect([...s.entries.values()]).toEqual(before);
});

it.each([["proof", "viewer"], ["viewer", "proof"], ["proof", "proof"]] as const)(
  "isolates overlapping republished Post authority for %s then %s", async (firstKind, secondKind) => {
    const { createTransitionalPostReadWorker } = await import("../../workers/src/transitional-post-read-worker");
    const fixture = (await import("../../site/tests/fixtures/shadow-posts/post.json")).default;
    const s = await setup("/posts/shadow-fixture/");
    s.expected.authority["x-njpbs-source-version"] = "7";
    const receipt = { schemaVersion: 1 as const, postId: fixture.document.id, operationId: "A".repeat(20),
      rendererSha: deployment.rendererSha, sourceVersion: 7, slug: "shadow-fixture", ownedSlugs: ["shadow-fixture"],
      generation: 999, visible: true, contextDigest: "b".repeat(64), snapshotDigest: "c".repeat(64), admissionRevision: 1 };
    const withdrawal = { postId: receipt.postId, operationId: "B".repeat(20), sourceVersion: 6,
      revision: 998, ownedSlugs: receipt.ownedSlugs, verifiedAt: 1_800_000_000_000 };
    let release!: () => void, started!: () => void, secondLookup!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    const overlapping = new Promise<void>(resolve => { secondLookup = resolve; });
    const pending: Promise<unknown>[] = [];
    let reads = 0, lookups = 0;
    const match = s.cache.match;
    s.cache.match = async input => {
      const url = new URL(new Request(input).url);
      if (url.pathname === "/__post-withdrawal-authority/v1" && !url.searchParams.has("purge-fence") && ++lookups === 2) secondLookup();
      return match(input);
    };
    s.serve.mockImplementation(async (request, proof) => (await createTransitionalPostReadWorker({ target,
      rendererSha: deployment.rendererSha, rendererReady: true, cache: s.cache, ...proof,
      render: async () => html, readWithdrawal: async () => withdrawal,
      waitUntil: task => { pending.push(task); },
      fetchAsset: async request => new URL(request.url).pathname === "/_publication.json"
        ? Response.json({ schemaVersion: 1, commitSha: deployment.rendererSha, generation: 7 }) : new Response("Assets"),
      getDecision: async () => {
        if (++reads === 1) { started(); await held; }
        return { kind: "post", receipt, published: fixture };
      } }).fetch(request))!);
    const observations = await Promise.all([s.observe(), s.observe()]);
    const requests = [firstKind, secondKind].map((kind, index) => kind === "proof"
      ? observations[index].request : new Request(`${target.origin}${s.expected.path}`));
    const first = s.handler.fetch(requests[0]);
    await reading;
    const second = s.handler.fetch(requests[1]);
    try {
      await overlapping;
      // Let the second cache miss reach the in-flight join before unblocking
      // the first authority read. No publication or cache purge is simulated.
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally { release(); }
    const responses = await Promise.all([first, second]);
    await Promise.all(pending);
    for (const [index, kind] of [firstKind, secondKind].entries()) {
      expect(responses[index].status, `${kind} request ${index + 1}`).toBe(200);
      if (kind === "proof") expect((await observations[index].verify(responses[index], s.store)).bodyDigest).toBe(bodyDigest);
      else {
        expect(await responses[index].text()).toBe(html);
        expect(responses[index].headers.get("x-njpbs-content-source")).toBe("cms-no-build");
        expect(responses[index].headers.has("x-robots-tag")).toBe(false);
      }
    }
    expect(reads).toBe(2);
  });

it.each(["/contact/", "/posts/published-post/"])("accepts independently reordered authority/deployment fields for %s", async path => {
  const s = await setup(path);
  const observation = await s.observe({
    deployment: Object.fromEntries(Object.entries(deployment).reverse()),
    expected: { ...s.expected, authority: Object.fromEntries(Object.entries(s.expected.authority).reverse()) },
  });
  const response = await s.handler.fetch(observation.request);
  expect(response.status).toBe(200);
  expect((await observation.verify(response, s.store)).bodyDigest).toBe(bodyDigest);
});

it("cancels and unlocks a partial proof stream when the lifetime expires", async () => {
  const s = await setup(), observation = await s.observe();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"proof":')); }, cancel });
  const response = new Response(body, { headers: { "content-type": RETAINED_PROOF_TYPE } });
  vi.useFakeTimers();
  try {
    const verification = observation.verify(response, s.store);
    const rejected = expect(verification).rejects.toThrow("refused");
    await vi.advanceTimersByTimeAsync(0);
    s.advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body!.locked).toBe(false);
  } finally { vi.useRealTimers(); }
});

it("cancels and unlocks a stalled independent R2 readback at expiry", async () => {
  const s = await setup(), observation = await s.observe();
  const response = await s.handler.fetch(observation.request);
  const cancel = vi.fn(), reached = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('<!doctype html>')); }, cancel });
  const r2 = { get: async (key: string) => {
    const object = await s.store.get(key);
    reached();
    return { ...object!, body };
  } };
  vi.useFakeTimers();
  try {
    const verification = observation.verify(response, r2);
    const rejected = expect(verification).rejects.toThrow("refused");
    await vi.waitFor(() => expect(reached).toHaveBeenCalled(), { interval: 1 });
    s.advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  } finally { vi.useRealTimers(); }
});

it("cancels and unlocks a partial origin HTML stream when the proof expires", async () => {
  const s = await setup(), observation = await s.observe();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('<!doctype html>')); }, cancel });
  const origin = new Response(body, { headers: s.headers });
  s.serve.mockImplementation(async () => origin);
  vi.useFakeTimers();
  try {
    const result = s.handler.fetch(observation.request);
    await vi.waitFor(() => expect(s.serve).toHaveBeenCalled(), { interval: 1 });
    await vi.advanceTimersByTimeAsync(0);
    s.advance(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await result).status).toBe(503);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(origin.body!.locked).toBe(false);
    expect(s.entries.size).toBe(0);
  } finally { vi.useRealTimers(); }
});
