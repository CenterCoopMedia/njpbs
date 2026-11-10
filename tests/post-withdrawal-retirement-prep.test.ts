import { describe, expect, it } from "vitest";
import { createTransitionalPostReadWorker } from "../workers/src/transitional-post-read-worker";
import type { NoBuildPostReply } from "../cms-api/src/index";

const rendererSha = "a".repeat(40);
const receipt = {
  schemaVersion: 1 as const,
  postId: "withdrawal-prep",
  operationId: "A1b2C3d4E5f6G7h8I9j0",
  rendererSha,
  sourceVersion: 7,
  slug: "removed-story",
  ownedSlugs: ["removed-story", "prior-story"],
  generation: 1,
  visible: false,
  contextDigest: "b".repeat(64),
  admissionRevision: 1,
};

// Routes without durable removal authority retain the approved Assets outage copy.
// The durable-withdrawal suite proves known tombstones cannot expose that copy.
describe("Post withdrawal retained outage behavior", () => {
  it.each(receipt.ownedSlugs.flatMap(slug => ["GET", "HEAD"].flatMap(method =>
    ["catalog", "route", "both", "cold"].map(outage => ({ slug, method, outage })))))(
    "keeps the static copy with $outage unavailable authority and no durable tombstone ($slug/$method)",
    async ({ slug, method, outage }) => {
      let now = Date.parse("2026-10-12T12:00:00Z");
      let unavailable = false;
      const entries = new Map<string, Response>();
      const pending: Promise<unknown>[] = [];
      const assetRequests: Request[] = [];
      const authorityRequests: string[] = [];
      const worker = createTransitionalPostReadWorker({
        rendererSha,
        now: () => now,
        cache: {
          async match(key) { return entries.get((key as Request).url)?.clone(); },
          async put(key, value) { entries.set((key as Request).url, value.clone()); },
        },
        waitUntil(task) { pending.push(task); },
        async getDecision(path): Promise<NoBuildPostReply> {
          authorityRequests.push(path);
          if (unavailable) throw new Error("Fixture authority unavailable");
          return path === "/_publication.json"
            ? { kind: "receipts", catalog: { schemaVersion: 1, rendererSha, generation: 1,
              contextDigest: receipt.contextDigest, admissionRevision: 1, posts: [receipt] } }
            : { kind: "gone", status: 410, receipt };
        },
        async fetchAsset(request) {
          assetRequests.push(request);
          return new Response(request.method === "HEAD" ? null : "Old withdrawn story in Assets", {
            headers: { "content-type": "text/html" },
          });
        },
        async render() { throw new Error("A withdrawn Post must not render"); },
      });
      const request = () => worker.fetch(new Request(`https://njpbs.org/posts/${slug}/`, { method }));
      const drain = async () => {
        while (pending.length) await Promise.all(pending.splice(0));
      };
      const expire = async (kind: "catalog" | "route") => {
        let expired = 0;
        for (const [url, response] of entries) {
          const key = new URL(url);
          if (key.searchParams.get("kind") !== kind || key.searchParams.has("purge-fence")) continue;
          const entry = await response.clone().json();
          entry.expiresAt = now - 1;
          entry.staleUntil = now - 1;
          const headers = new Headers(response.headers);
          headers.set("x-njpbs-authority-expires-at", String(entry.expiresAt));
          entries.set(url, new Response(JSON.stringify(entry), { headers }));
          expired++;
        }
        expect(expired).toBe(1);
      };

      // Supports both the current cold-refresh behavior and #3208's bounded
      // awaited-read replacement, without making its cache timing a contract.
      if (outage !== "cold") {
        let confirmed: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          confirmed = await request();
          await drain();
          if (confirmed?.status === 410) break;
        }
        expect(confirmed?.status).toBe(410);
        expect(confirmed?.headers.get("x-njpbs-publication-operation")).toBe(receipt.operationId);
        if (outage === "catalog" || outage === "both") await expire("catalog");
        if (outage === "route" || outage === "both") await expire("route");
      } else {
        // This worker has never made a request; authority is already down.
        expect(entries.size).toBe(0);
      }
      assetRequests.length = 0;
      authorityRequests.length = 0;

      unavailable = true;
      const stale = await request();
      await drain();
      expect(stale?.status).toBe(200);
      expect(assetRequests).toHaveLength(1);
      const body = await stale!.text();
      expect(body).toBe(method === "HEAD" ? "" : "Old withdrawn story in Assets");
      expect(stale?.headers.get("cache-control")).toBe("no-store");
      expect(stale?.headers.has("x-njpbs-publication-operation")).toBe(false);
      expect(authorityRequests).toEqual(outage === "route" ? [`/posts/${slug}/`] : ["/_publication.json"]);
    },
  );

  const paths = ["/posts/removed-story/", "/posts/prior-story/", "/", "/_home-sources.json", "/posts/",
    "/authors/fixture/", "/feeds/news.xml", "/api/v1/content.json", "/sitemap-index.xml",
    "/pagefind/pagefind.js", "/search/meaning-index.json"];
  it.each(["cold", "missing", "release", "route", "expired-output"])(
    "keeps static detail/card/feed/search Assets with %s unavailable authority", async mode => {
      const assets: string[] = [];
      const catalog: NoBuildPostReply = { kind: "receipts", catalog: { schemaVersion: 1, rendererSha,
        generation: 1, contextDigest: receipt.contextDigest, admissionRevision: 1, posts: [receipt] } };
      const worker = createTransitionalPostReadWorker({ rendererSha, rendererReady: mode !== "release",
        cache: { async match() {}, async put() {} }, waitUntil() {},
        async getDecision(path) {
          if (mode === "cold") throw new Error("Private authority unavailable");
          if (mode === "missing") return { kind: "receipts" };
          if (path === "/_publication.json") return catalog;
          if (mode === "expired-output") return { kind: "background", status: 200, bytes: btoa("Old withdrawn card"), headers: {
            "x-njpbs-admission-revision": "1", "x-njpbs-background-renderer-sha": rendererSha,
            "x-njpbs-background-expires-at": String(Date.now() - 1),
          } };
          throw new Error("Route authority unavailable");
        },
        async fetchAsset(request) { assets.push(request.url); return new Response("Old withdrawn content"); },
        async render() { throw new Error("Unexpected render"); },
      });
      for (const path of paths) for (const method of ["GET", "HEAD"]) {
        const response = await worker.fetch(new Request(`https://njpbs.org${path}`, { method }));
        expect(response?.status, `${path}/${method}`).toBe(200);
        expect(response?.headers.get("cache-control")).toBe("no-store");
        expect(await response!.text()).toBe(method === "HEAD" ? "" : "Old withdrawn content");
      }
      expect(assets).toHaveLength(paths.length * 2);
    },
  );

  it("rechecks stale unowned authority before allowing Assets", async () => {
    let clock = Date.now();
    let outage = false;
    let assetReads = 0;
    const entries = new Map<string, Response>();
    const worker = createTransitionalPostReadWorker({ rendererSha, now: () => clock,
      cache: { async match(key) { return entries.get((key as Request).url)?.clone(); },
        async put(key, value) { entries.set((key as Request).url, value.clone()); } }, waitUntil() {},
      async getDecision() { if (outage) throw new Error("Unknown ownership"); return { kind: "pass" }; },
      async fetchAsset() { assetReads++; return new Response("Verified unowned code surface"); },
      async render() { throw new Error("Unexpected render"); },
    });
    const request = () => worker.fetch(new Request("https://njpbs.org/posts/prior-story/"));
    expect((await request())?.status).toBe(200);
    expect(assetReads).toBe(1);
    clock += 10_000;
    outage = true;
    const stale = await request();
    expect(stale?.status).toBe(200);
    expect(assetReads).toBe(2);
  });

  it("does not treat a failed refresh as fresh proof that a slug is unowned", async () => {
    let clock = Date.now();
    let outage = false;
    let assets = 0;
    const pending: Promise<unknown>[] = [];
    const entries = new Map<string, Response>();
    const worker = createTransitionalPostReadWorker({ rendererSha, now: () => clock,
      cache: { async match(key) { return entries.get((key as Request).url)?.clone(); },
        async put(key, value) { entries.set((key as Request).url, value.clone()); } },
      waitUntil(task) { pending.push(task); },
      async getDecision() {
        if (outage) throw new Error("Unknown current ownership");
        return { kind: "receipts", catalog: { schemaVersion: 1, rendererSha, generation: 1,
          contextDigest: receipt.contextDigest, admissionRevision: 1, posts: [receipt] } };
      },
      async fetchAsset() { assets++; return new Response("Old unlisted Post"); },
      async render() { throw new Error("Unexpected render"); },
    });
    const request = () => worker.fetch(new Request("https://njpbs.org/posts/new-withdrawal/"));
    expect((await request())?.status).toBe(200);
    await Promise.all(pending.splice(0));
    clock += 10_000;
    outage = true;
    expect((await request())?.status).toBe(200);
    await Promise.all(pending.splice(0));
    expect((await request())?.status).toBe(200);
    expect(assets).toBe(3);
  });
});
