import { publicationTarget } from "../../functions/lib/publication-target.js";
// @vitest-environment node
// Worker requests must retain Cookie headers, which happy-dom removes.
import { describe, expect, it } from "vitest";
import { servePublicRequest } from "../../workers/src/public-worker";
import { createNoBuildPostWorker, type NoBuildPostConfig } from "../../workers/src/no-build-post-worker";
import { createFakePublishedPostReader } from "../src/lib/published-post-shadow";
import fixture from "./fixtures/shadow-posts/post.json";
import type { NoBuildPostReply } from "../../cms-api/src/index";
import { createHash } from "node:crypto";

const url = "https://njpbs.org/posts/shadow-fixture/";
const config = { enabled: true, allowlist: [{ documentId: "shadow-fixture", slug: "shadow-fixture" }] };
function harness(settings?: NoBuildPostConfig, options: { cacheFailure?: boolean; incompleteHtml?: boolean; rendererSha?: string } = {}) {
  const reader = createFakePublishedPostReader({ "shadow-fixture": fixture });
  const entries = new Map<string, Response>();
  const noBuildPosts = createNoBuildPostWorker({ reader, rendererSha: options.rendererSha ?? "a".repeat(40),
    now: () => new Date("2026-10-08T12:00:00Z"),
    cache: {
      async match(key) {
        if (options.cacheFailure) throw new Error("Cache unavailable");
        return entries.get(String(key instanceof Request ? key.url : key))?.clone();
      },
      async put(key, value) {
        if (options.cacheFailure) throw new Error("Cache unavailable");
        entries.set(String(key instanceof Request ? key.url : key), value.clone());
      },
    },
    async render(content) {
      if (options.incompleteHtml) return "<p>Partial render</p>";
      return `<!doctype html><html><title>${content.posts[0].title}</title><main>${content.posts[0].summary}</main></html>`;
    },
  }, settings);
  return { reader, entries, request: (target = url, method = "GET") => servePublicRequest(new Request(target, { method }), {
    noBuildPosts,
    async fetchAsset() { return new Response("Old static Post", { headers: { "Content-Type": "text/html" } }); },
    async getPublishedPage() { throw new Error("Unexpected Contact lookup"); },
  }) };
}

describe("Public no-build Post request boundary", () => {
  it("serves the listed published Post without replacing unrelated static routes", async () => {
    const h = harness(config);
    const response = await h.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Njpbs-Content-Source")).toBe("cms-no-build");
    expect(response.headers.get("X-Njpbs-Source-Version")).toBe("7");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBeNull();
    expect(await response.text()).toContain("A published fixture");
    for (const target of ["https://njpbs.org/posts/another/", "https://njpbs.org/posts/", "https://njpbs.org/"]) {
      expect(await (await h.request(target)).text()).toBe("Old static Post");
    }
  });

  it("defaults off with an empty allowlist and requires both explicit gates", async () => {
    for (const settings of [undefined, {}, { enabled: true }, { enabled: true, allowlist: [] }]) {
      expect(await (await harness(settings).request()).text()).toBe("Old static Post");
    }
    for (const enabled of [undefined, false]) {
      const response = await harness({ ...config, enabled }).request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("Old static Post");
    }
  });

  it("cannot revive cached or static HTML after withdrawal, outage or a changed route owner", async () => {
    for (const state of [null, { kind: "gone" }, "outage", "other-owner"] as const) {
      const h = harness(config);
      expect((await h.request()).status).toBe(200);
      expect(h.entries.size).toBe(1);
      if (state === "outage") h.reader.fail(new Error("Private backend details"));
      else if (state === "other-owner") h.reader.set("shadow-fixture", { ...fixture, document: { ...fixture.document, id: "different-post" } });
      else h.reader.set("shadow-fixture", state);
      const response = await h.request();
      expect(response.status).toBe(state === null ? 404 : typeof state === "object" ? 410 : 503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).not.toMatch(/Old static|A published|Private backend/);
    }
  });

  it("serves an updated snapshot on the ordinary URL while keeping drafts private", async () => {
    const h = harness(config);
    await h.request();
    const next = structuredClone(fixture);
    next.document.published.sourceVersion = 8;
    next.document.published.metadata.title = "Updated published Post";
    h.reader.set("shadow-fixture", next);
    const response = await h.request();
    expect(response.headers.get("X-Njpbs-Source-Version")).toBe("8");
    const html = await response.text();
    expect(html).toContain("Updated published Post");
    expect(html).not.toMatch(/Old static|Private working/);
  });

  it("keeps URL variants, HEAD and unsupported methods inside the owned route", async () => {
    const h = harness(config);
    const variants = [url + "?utm_source=mail", url.slice(0, -1), url + "index.html",
      url + "index.html/", url.replace("/posts/", "/posts//"), url + "/",
      url.replace("shadow-fixture", "%73hadow-fixture")];
    for (const target of variants) {
      expect((await h.request(target)).headers.get("X-Njpbs-Source-Version")).toBe("7");
    }
    expect(await (await h.request(url, "HEAD")).text()).toBe("");
    h.reader.set("shadow-fixture", { kind: "gone" });
    for (const target of variants) {
      const gone = await h.request(target, "HEAD");
      expect(gone.status).toBe(410);
      expect(await gone.text()).toBe("");
    }
  });

  it("advertises GET and HEAD when refusing another HTTP method", async () => {
    for (const method of ["POST", "PUT", "OPTIONS"]) {
      const response = await harness(config).request(url, method);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD");
    }
  });

  it("rejects a malformed renderer release before accepting requests", () => {
    for (const rendererSha of ["", "main", "a".repeat(39), "A".repeat(40)]) {
      expect(() => harness(config, { rendererSha })).toThrow("Invalid no-build renderer release");
    }
  });

  it("rejects private, malformed and unsupported reads without exposing static content", async () => {
    const unsupported = structuredClone(fixture);
    Object.assign(unsupported.document.published.blocks[0], { type: "cards" });
    for (const input of [{ ...fixture, kind: "private-preview" }, { kind: "published-post" }, unsupported]) {
      const h = harness(config);
      h.reader.set("shadow-fixture", input);
      const response = await h.request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(/Old static|Private working/);
    }
  });

  it("honors published noindex and keeps cache outages independent from rendering", async () => {
    const h = harness(config, { cacheFailure: true });
    const noindex = structuredClone(fixture);
    Object.assign(noindex.document.published.metadata, { seo: { noindex: true } });
    h.reader.set("shadow-fixture", noindex);
    const response = await h.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toContain("A published fixture");
    const failed = await harness(config, { incompleteHtml: true }).request();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toMatch(/Partial render|Old static/);
  });

  it("does not admit another host or expand beyond one configured Post", async () => {
    const settings = structuredClone(config);
    const h = harness(settings);
    settings.allowlist[0].slug = "another";
    expect((await h.request()).headers.get("X-Njpbs-Source-Version")).toBe("7");
    for (const origin of ["https://dev-public.example.org", "https://www.njpbs.org", "http://njpbs.org"]) {
      expect(await (await h.request(url.replace("https://njpbs.org", origin))).text()).toBe("Old static Post");
    }
    expect(() => harness({ enabled: true, allowlist: [...config.allowlist, { documentId: "other", slug: "other" }] })).toThrow();
    expect(() => harness({ enabled: true, allowlist: [{ documentId: "", slug: "shadow-fixture" }] })).toThrow();
    expect(() => harness({ enabled: true, allowlist: [{ documentId: "shadow-fixture", slug: "../about" }] })).toThrow();
  });
});

function authoritativeHarness(target = publicationTarget("production")) {
  const entries = new Map<string, Response>();
  const receipt = { schemaVersion: 1 as const, rendererSha: "a".repeat(40), operationId: "A".repeat(20),
    sourceVersion: 7, generation: 1, postId: "shadow-fixture", slug: "shadow-fixture", visible: true,
    ownedSlugs: ["shadow-fixture"], contextDigest: "b".repeat(64), admissionRevision: 1 };
  let reply: NoBuildPostReply = { kind: "post", receipt, published: structuredClone(fixture) };
  let reads = 0;
  const hooks = { afterRead: (_count: number) => {}, afterPut: () => {}, failCache: false };
  const staticHtml = "<!doctype html><html>Verified static return</html>";
  const worker = createNoBuildPostWorker({ target, rendererSha: receipt.rendererSha,
    cache: {
      async match(key) {
        if (hooks.failCache) throw new Error("Cache offline");
        return entries.get(String(key instanceof Request ? key.url : key))?.clone();
      },
      async put(key, response) {
        if (hooks.failCache) throw new Error("Cache offline");
        entries.set(String(key instanceof Request ? key.url : key), response.clone());
        hooks.afterPut();
      },
    },
    async getDecision() { hooks.afterRead(++reads); return structuredClone(reply); },
    async render(content) { return `<!doctype html><html>${content.posts[0].title}</html>`; },
    async fetchAsset() { return new Response(staticHtml, { headers: { "Content-Type": "text/html" } }); },
  });
  return { entries, hooks, receipt, staticHtml,
    setReply(value: NoBuildPostReply) { reply = value; reads = 0; },
    request: (target = url, init?: RequestInit) => worker.fetch(new Request(target, init)),
  };
}

describe("authoritative Post edge cache", () => {
  it("emits exact snapshot and data figure receipt digests while old receipts remain valid", async () => {
    const h = authoritativeHarness();
    const snapshotDigest = "c".repeat(64), datasetFiguresDigest = "d".repeat(64);
    h.setReply({ kind: "post", receipt: { ...h.receipt, snapshotDigest, datasetFiguresDigest },
      published: structuredClone(fixture) });
    const current = (await h.request())!;
    expect(current.status).toBe(200);
    expect(current.headers.get("x-njpbs-snapshot-sha256")).toBe(snapshotDigest);
    expect(current.headers.get("x-njpbs-dataset-figures-sha256")).toBe(datasetFiguresDigest);
    expect(current.headers.get("access-control-expose-headers")).toContain("x-njpbs-dataset-figures-sha256");

    const legacy = authoritativeHarness();
    const old = (await legacy.request())!;
    expect(old.status).toBe(200);
    expect(old.headers.get("x-njpbs-snapshot-sha256")).toBeNull();
    expect(old.headers.get("x-njpbs-dataset-figures-sha256")).toBeNull();

    h.setReply({ kind: "post", receipt: { ...h.receipt, datasetFiguresDigest }, published: structuredClone(fixture) });
    expect((await h.request())!.status).toBe(503);
  });
  it.each(["njpbs-dev-post-background", "njpbs-post-background"])("never caches a dev background response under production tag %s", async tag => {
    const target = publicationTarget("development");
    const entries: Response[] = [];
    const worker = createNoBuildPostWorker({ target, rendererSha: "a".repeat(40),
      cache: { async match() { return undefined; }, async put(_key, response) { entries.push(response); } },
      fetchAsset: async () => { throw new Error("Unexpected Assets read"); },
      render: async () => { throw new Error("Unexpected detail render"); },
      getDecision: async () => ({ kind: "background", status: 200, bytes: btoa("Public fixture"), headers: {
        "x-njpbs-admission-revision": "1", "x-njpbs-background-renderer-sha": "a".repeat(40),
        "x-njpbs-background-purge-tag": tag,
      } }),
    });
    const response = await worker.fetch(new Request(`${target.origin}/posts/`));
    expect(response!.status).toBe(200);
    expect(entries.map(entry => entry.headers.get("Cache-Tag")))
      .toEqual(tag === "njpbs-dev-post-background" ? [tag] : []);
    expect(response!.headers.has("x-njpbs-background-purge-tag")).toBe(false);
  });
  it("stores dev detail HTML exclusively under dev purge tags", async () => {
    const target = publicationTarget("development");
    const h = authoritativeHarness(target);
    const response = await h.request(`${target.origin}/posts/shadow-fixture/`);
    expect(response!.status).toBe(200);
    expect(h.entries.size).toBe(1);
    expect([...h.entries.values()][0].headers.get("cache-tag")).toBe("njpbs-dev-post-shadow-fixture");
  });
  it("reuses public HTML with a one-day edge TTL and no browser storage", async () => {
    const h = authoritativeHarness();
    expect((await h.request())!.headers.get("x-njpbs-render-cache")).toBe("MISS");
    for (const target of [url, url.slice(0, -1), `${url}index.html`, url.replace("posts", "%70osts")]) {
      const response = (await h.request(target))!;
      expect(response.headers.get("x-njpbs-render-cache")).toBe("HIT");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.has("cache-tag")).toBe(false);
      expect(await response.text()).toContain("A published fixture");
    }
    const head = (await h.request(url, { method: "HEAD" }))!;
    expect(head.headers.get("x-njpbs-render-cache")).toBe("HIT");
    expect(await head.text()).toBe("");
    expect(h.entries.size).toBe(1);
    const entry = [...h.entries.values()][0];
    expect(entry.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(entry.headers.get("cache-tag")).toBe("njpbs-post-shadow-fixture");
  });

  it("never reuses an earlier version, input or context even when purge has not propagated", async () => {
    const h = authoritativeHarness();
    await h.request();
    const published = structuredClone(fixture);
    published.document.published.metadata.title = "The newly published title";
    published.document.published.sourceVersion = 8;
    const receipt = { ...h.receipt, sourceVersion: 8, operationId: "C".repeat(20) };
    h.setReply({ kind: "post", receipt, published });
    expect(await (await h.request())!.text()).toContain("The newly published title");
    // Even changes outside the version counter cannot reuse a different input.
    published.document.published.metadata.title = "Corrected public input";
    h.setReply({ kind: "post", receipt, published });
    expect(await (await h.request())!.text()).toContain("Corrected public input");
    h.setReply({ kind: "post", receipt: { ...receipt, contextDigest: "d".repeat(64) }, published });
    expect((await h.request())!.headers.get("x-njpbs-render-cache")).toBe("MISS");
    expect(h.entries.size).toBe(4);
  });

  it("bypasses retained bytes for rename, withdrawal and verified static return", async () => {
    const h = authoritativeHarness();
    await h.request();
    const renamed = { ...h.receipt, slug: "renamed", ownedSlugs: ["shadow-fixture", "renamed"] };
    h.setReply({ kind: "alias", receipt: renamed, location: "/posts/renamed/" });
    const alias = (await h.request())!;
    expect(alias.status).toBe(308);
    expect(alias.headers.get("location")).toBe("/posts/renamed/");
    h.setReply({ kind: "gone", receipt: { ...renamed, visible: false } });
    expect((await h.request())!.status).toBe(410);
    h.setReply({ kind: "static", receipt: { ...h.receipt, mode: "static" }, staticFile: {
      path: "/posts/shadow-fixture/", bytes: Buffer.byteLength(h.staticHtml),
      digest: createHash("sha256").update(h.staticHtml).digest("hex"),
    } });
    const response = (await h.request())!;
    expect(await response.text()).toBe(h.staticHtml);
    expect(response.headers.get("x-njpbs-content-source")).toBe("cms-static-return");
    expect(h.entries.size).toBe(1);
  });

  it("checks authority after both a cache hit and a late cache fill", async () => {
    for (const hit of [true, false]) {
      const h = authoritativeHarness();
      if (hit) await h.request();
      h.setReply({ kind: "post", receipt: h.receipt, published: fixture });
      h.hooks.afterRead = count => {
        if (count === 2) h.setReply({ kind: "gone", receipt: { ...h.receipt, visible: false } });
      };
      expect((await h.request())!.status).toBe(503);
    }
    const h = authoritativeHarness();
    h.hooks.afterPut = () => h.setReply({ kind: "gone", receipt: { ...h.receipt, visible: false } });
    expect((await h.request())!.status).toBe(503);
    expect((await h.request())!.status).toBe(410);
  });

  it("never stores drafts, private requests, previews or failures", async () => {
    const h = authoritativeHarness();
    const privateRequests: RequestInit[] = [{ headers: { authorization: "Bearer fixture" } }, { headers: { cookie: "staff=fixture" } }];
    for (const init of privateRequests) {
      const response = (await h.request(url, init))!;
      expect(response.headers.get("x-njpbs-render-cache")).toBe("BYPASS");
      expect(await response.text()).not.toContain("Private working title");
    }
    expect((await h.request(`${url}?preview=fixture`))!.headers.get("x-njpbs-render-cache")).toBe("BYPASS");
    const draft = structuredClone(fixture);
    draft.document.publiclyVisible = false;
    h.setReply({ kind: "post", receipt: h.receipt, published: draft });
    expect((await h.request())!.status).toBe(503);
    expect(h.entries.size).toBe(0);
    h.setReply({ kind: "post", receipt: h.receipt, published: fixture });
    h.hooks.failCache = true;
    expect((await h.request())!.status).toBe(200);
    expect(h.entries.size).toBe(0);
  });
});


it("invalidates populated GET/HEAD cache on current image credit edits and refuses lost media eligibility", async () => {
  const h = harness(config);
  const image = { id: "upload", url: "https://media.njpbs.org/cms-media/news/image/hash.webp", mimeType: "image/webp", width: 1600, height: 900 };
  const read = { ...structuredClone(fixture), assets: [{ ...image, credit: "First credit" }] };
  Object.assign(read.document.published.metadata, { heroImage: "upload", heroImageCaption: "Frozen caption" });
  h.reader.set("shadow-fixture", read);
  const first = await h.request();
  expect(first.status).toBe(200);
  const before = first.headers.get("x-njpbs-input-sha256");
  h.reader.set("shadow-fixture", { ...read, assets: [{ ...image, credit: "Current credit" }] });
  const changed = await h.request();
  expect(changed.status).toBe(200);
  expect(changed.headers.get("x-njpbs-input-sha256")).not.toBe(before);
  const head = await h.request(url, "HEAD");
  expect(head.status).toBe(200);
  expect(head.headers.get("x-njpbs-input-sha256")).toBe(changed.headers.get("x-njpbs-input-sha256"));
  expect(await head.text()).toBe("");
  h.reader.set("shadow-fixture", { ...read, assets: [image] });
  expect((await h.request()).headers.get("x-njpbs-input-sha256")).not.toBe(changed.headers.get("x-njpbs-input-sha256"));
  h.reader.fail(new Error("reader_media_fence"));
  expect((await h.request()).status).toBe(503);
  expect((await h.request(url, "HEAD")).status).toBe(503);
});
