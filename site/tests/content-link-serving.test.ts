import { expect, it } from "vitest";
import { createNoBuildPostWorker } from "../../workers/src/no-build-post-worker";
import { createNoBuildPageWorker } from "../../workers/src/no-build-page-worker";
import fixture from "./fixtures/shadow-posts/post.json";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const { readPostSettingsReceipt } = createRequire(import.meta.url)("../../functions/lib/no-build-post-settings-confirmation.js");
const rendererSha = "a".repeat(40);
const target = "https://example.test/article?utm_source=njpbs";
const settings = { contentLinkMode: "custom", contentLinkUrl: target, contentLinkNewTab: true };
const contextDigest = createHash("sha256").update("njpbs-public-context-v1:1").digest("hex");
const cache = { async match() { return undefined; }, async put() {} };
it.each(["GET", "HEAD"])("serves the published Post as 302 with %s and restores 200 when off", async method => {
  const published = structuredClone(fixture);
  Object.assign(published.document.published.metadata, settings);
  const receipt = { schemaVersion: 1 as const, postId: "shadow-fixture", operationId: "A".repeat(20), rendererSha, sourceVersion: 7,
    slug: "shadow-fixture", ownedSlugs: ["shadow-fixture"], generation: 1, visible: true, contextDigest: "b".repeat(64), admissionRevision: 1 };
  const worker = createNoBuildPostWorker({ rendererSha, cache, render: async () => "<!doctype html><html><body>Retained body</body></html>",
    getDecision: async () => ({ kind: "post", receipt, published }), fetchAsset: async () => new Response(null, { status: 404 }) });
  const request = () => new Request("https://njpbs.org/posts/shadow-fixture/", { method });
  const response = (await worker.fetch(request()))!;
  expect(response.status).toBe(302); expect(response.headers.get("location")).toBe(target);
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow"); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
  if (method === "GET") {
    const entry = { postId: "shadow-fixture", receipt, contentRedirectUrl: target };
    const read = (fetchPublic: () => Promise<Response | null>) => readPostSettingsReceipt({ entry, target: { origin: "https://njpbs.org" },
      headers: new Headers(), signal: new AbortController().signal, fetchPublic });
    await expect(read(() => worker.fetch(request()))).resolves.toEqual({ postId: "shadow-fixture", path: "/posts/shadow-fixture/", htmlDigest: null });
    await expect(read(async () => {
      const changed = (await worker.fetch(request()))!;
      changed.headers.delete("x-robots-tag");
      return changed;
    })).rejects.toThrow("unavailable public receipt");
  }
  Object.assign(published.document.published.metadata, { contentLinkMode: "normal" });
  const restored = (await worker.fetch(request()))!;
  expect(restored.status).toBe(200); expect(restored.headers.has("location")).toBe(false);
  expect(await restored.text()).toBe(method === "HEAD" ? "" : "<!doctype html><html><body>Retained body</body></html>");
});
it.each(["GET", "HEAD"])("serves the published Page as 302 with %s and restores 200 when off", async method => {
  const page = { pageId: "contact", path: "/contact/", template: "genericPage", family: "article", contentMode: "published", sourceVersion: 7,
    title: "Contact", description: "Contact NJ PBS", blocks: [], assets: {}, publishedAt: "2026-11-01T12:00:00.000Z", noindex: false, ...settings };
  const published = { kind: "published-page", page, sourceSeal: { rendererSha, contextRevision: 1, contextDigest }, assets: [], joinedRecords: [], posts: [], authors: [], settings: [], navigationPages: [] };
  const receipt = { schemaVersion: 1 as const, pageId: "contact", operationId: "A".repeat(20), rendererSha, sourceVersion: 7,
    path: "/contact/", ownedPaths: ["/contact/"], generation: 1, visible: true, contextDigest, snapshotDigest: "c".repeat(64), contextRevision: 1, codeGeneration: 1, admissionRevision: 1 };
  const worker = createNoBuildPageWorker({ rendererSha, rendererReady: true, cache, render: async () => "<!doctype html><html><body>Retained Page</body></html>",
    getDecision: async () => ({ kind: "page", receipt, published }), fetchAsset: async () => new Response(null, { status: 404 }) });
  const request = () => new Request("https://dev-public.example.org/contact/", { method });
  const response = (await worker.fetch(request()))!;
  expect(response.status).toBe(302); expect(response.headers.get("location")).toBe(target);
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  page.contentLinkMode = "normal";
  const restored = (await worker.fetch(request()))!;
  expect(restored.status).toBe(200); expect(restored.headers.has("location")).toBe(false);
});

it("redirects only the static Post detail and leaves its shared catalogs and receipt files alone", async () => {
  const receipt = { schemaVersion: 1 as const, postId: "shadow-fixture", operationId: "A".repeat(20), rendererSha, sourceVersion: 7,
    slug: "shadow-fixture", ownedSlugs: ["shadow-fixture"], generation: 1, visible: true, contextDigest: "b".repeat(64), mode: "static" as const, contentRedirectUrl: target };
  const worker = createNoBuildPostWorker({ rendererSha, cache, render: async () => "unused", getDecision: async path => ({ kind: "static", receipt, staticFile: { path, bytes: new TextEncoder().encode("Catalog bytes").length, digest: createHash("sha256").update("Catalog bytes").digest("hex") } }),
    fetchAsset: async () => new Response("Catalog bytes", { headers: { "content-type": "application/json" } }) });
  expect((await worker.fetch(new Request("https://njpbs.org/posts/shadow-fixture/")))!.status).toBe(302);
  for (const path of ["/_publication.json", "/_content-status.json", "/posts/", "/feeds/news.xml", "/sitemap-0.xml", "/pagefind/pagefind.js"]) {
    const response = (await worker.fetch(new Request(`https://njpbs.org${path}`)))!;
    expect(response.status).toBe(200); expect(response.headers.has("location")).toBe(false); expect(await response.text()).toBe("Catalog bytes");
  }
});
