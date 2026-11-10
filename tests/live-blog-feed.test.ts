import { describe, expect, it, vi } from "vitest";
import { createLiveBlogFeedReader } from "../workers/src/live-blog-feed";
import { publicationTarget } from "../functions/lib/publication-target.js";
import { renderLiveBlog } from "../packages/content-core/src/live-blog-render";
import { LIVE_BLOG_SPECIMEN } from "../site/tests/fixtures/live-blog";

function harness() {
  let clock = 1_000;
  const entries = new Map<string, Response>();
  const cache = { async match(key: RequestInfo | URL) { return entries.get((key as Request).url)?.clone(); },
    async put(key: RequestInfo | URL, value: Response) { entries.set((key as Request).url, value); } };
  const page = () => new Response(`<!doctype html>${renderLiveBlog(LIVE_BLOG_SPECIMEN, { id: "coverage", asOf: LIVE_BLOG_SPECIMEN.updatedAt })}`, { headers: { "content-type": "text/html" } });
  const readPage = vi.fn(async (_request: Request): Promise<Response | null> => page());
  const create = () => createLiveBlogFeedReader({ target: publicationTarget("production"), rendererSha: "a".repeat(40), cache, readPage, now: () => clock });
  const read = create();
  return { read, readPage, create, entries, advance(ms: number) { clock += ms; }, request(query = "updates", method = "GET") {
    return new Request(`https://njpbs.org/posts/coverage/?live-blog=${query}`, { method });
  } };
}

describe("cached public live blog revision feed", () => {
  it("projects only revision metadata and shares a twenty-second cache across readers", async () => {
    const h = harness();
    const response = (await h.read(h.request()))!;
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=20, stale-while-revalidate=30");
    const result = await response.json();
    expect(result).toEqual({ schemaVersion: 1, postId: "coverage", coverageState: LIVE_BLOG_SPECIMEN.coverageState,
      updatedAt: LIVE_BLOG_SPECIMEN.updatedAt, totalCount: LIVE_BLOG_SPECIMEN.updates.length, updates: expect.arrayContaining(LIVE_BLOG_SPECIMEN.updates.map(({ id, updatedAt }) => ({ id, updatedAt }))) });
    expect(JSON.stringify(result)).not.toMatch(/headline|body|credits|media|PRIVATE/);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(1024);
    expect(await (await h.create()(h.request()))!.json()).toEqual(result);
    expect(h.readPage).toHaveBeenCalledTimes(1);
    expect(h.readPage.mock.calls[0][0].url).toBe("https://njpbs.org/posts/coverage/");
    h.advance(20_001);
    await h.read(h.request()); expect(h.readPage).toHaveBeenCalledTimes(2);
  });
  it("recognizes only the exact query value and canonical Post route", async () => {
    const h = harness();
    for (const request of [h.request("other"), h.request("updates", "POST"), new Request("https://njpbs.org/posts/coverage/?live-blog=updates&live-blog=other"),
      new Request("https://njpbs.org/posts/coverage/?live-blog=updates&extra=1"),
      new Request("https://other.test/posts/coverage/?live-blog=updates"), new Request("https://njpbs.org/pages/coverage/?live-blog=updates")]) {
      expect(await h.read(request)).toBeNull();
    }
    expect(h.readPage).not.toHaveBeenCalled();
  });
  it("keys static HTML snapshots separately even when their entry revisions are unchanged", async () => {
    const h = harness();
    const page = (title: string) => new Response(`<h1>${title}</h1>${renderLiveBlog(LIVE_BLOG_SPECIMEN, { id: "coverage", asOf: LIVE_BLOG_SPECIMEN.updatedAt })}`,
      { headers: { "content-type": "text/html" } });
    h.readPage.mockResolvedValueOnce(page("Original headline")).mockResolvedValueOnce(page("Updated headline"));
    const initial = await (await h.read(h.request()))!.json();
    h.advance(20_001);
    expect(await (await h.read(h.request()))!.json()).toEqual(initial);
    expect([...h.entries.keys()].filter(key => key.includes("&revision="))).toHaveLength(2);
  });
  it("bounds a 120-entry archive to the newest fifty and changes the cache key with its snapshot", async () => {
    const h = harness();
    const blog = { ...LIVE_BLOG_SPECIMEN, updates: Array.from({ length: 120 }, (_, index) => ({ ...LIVE_BLOG_SPECIMEN.updates[0],
      id: `report-${index}`, publishedAt: new Date(Date.parse(LIVE_BLOG_SPECIMEN.updatedAt) - index * 1000).toISOString(),
      updatedAt: new Date(Date.parse(LIVE_BLOG_SPECIMEN.updatedAt) - index * 1000).toISOString() })) };
    const page = (sha: string) => new Response(renderLiveBlog(blog, { id: "coverage", asOf: blog.updatedAt }),
      { headers: { "content-type": "text/html", "x-njpbs-snapshot-sha256": sha.repeat(64) } });
    h.readPage.mockResolvedValueOnce(page("a")).mockResolvedValueOnce(page("b"));
    const result = await (await h.read(h.request()))!.json();
    expect(result.totalCount).toBe(120); expect(result.updates).toHaveLength(50);
    expect(result.updates.map((entry: { id: string }) => entry.id)).toEqual(Array.from({ length: 50 }, (_, index) => `report-${index}`));
    h.advance(20_001); await h.read(h.request());
    const revisions = [...h.entries.keys()].filter(key => key.includes("&revision="));
    expect(revisions).toHaveLength(2); expect(revisions[0]).toContain("revision=" + "a".repeat(64));
    expect(revisions[1]).toContain("revision=" + "b".repeat(64));
  });
  it("gives separate request readers their own cached response bodies", async () => {
    const h = harness();
    const initial = await (await h.read(h.request()))!.text();
    const responses = await Promise.all([h.create()(h.request()), h.create()(h.request()), h.create()(h.request("updates", "HEAD"))]);
    expect(responses.map(response => response!.status)).toEqual([200, 200, 200]);
    expect(await responses[0]!.text()).toBe(initial); expect(await responses[1]!.text()).toBe(initial);
    expect(await responses[2]!.text()).toBe(""); expect(h.readPage).toHaveBeenCalledTimes(1);
  });
  it.each([404, 410, 503])("preserves public refusal %s without cache storage", async code => {
    const h = harness(); h.readPage.mockResolvedValue(new Response(null, { status: code }));
    expect((await h.read(h.request()))!.status).toBe(code);
    expect((await h.read(h.request()))!.headers.get("cache-control")).toBe("no-store");
    expect(h.readPage).toHaveBeenCalledTimes(2);
  });
  it("rechecks withdrawal when its twenty-second local cache expires", async () => {
    const h = harness(); await h.read(h.request());
    h.readPage.mockResolvedValue(new Response(null, { status: 410 }));
    expect((await h.create()(h.request()))!.status).toBe(200);
    expect(h.readPage).toHaveBeenCalledTimes(1);
    h.advance(20_001);
    expect((await h.create()(h.request()))!.status).toBe(410);
  });
  it("returns 404 for an ordinary Post and refuses malformed manifests", async () => {
    const h = harness();
    h.readPage.mockResolvedValueOnce(new Response("<!doctype html><h1>Ordinary Post</h1>", { headers: { "content-type": "text/html" } }));
    expect((await h.read(h.request()))!.status).toBe(404);
    h.readPage.mockResolvedValueOnce(new Response('<script type="application/json" data-live-blog-manifest>{"schemaVersion":99}</script>', { headers: { "content-type": "text/html" } }));
    expect((await h.read(h.request()))!.status).toBe(503);
  });
});
