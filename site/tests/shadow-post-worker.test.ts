import { describe, expect, expectTypeOf, it } from "vitest";
import fixture from "./fixtures/shadow-posts/post.json";
import { createShadowPostWorker, purgePublishedPostRoutes } from "../../workers/src/shadow-post-worker";
import { createFakePublishedPostReader, projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { resolvePublicCreditLinks } from "../src/lib/public-author-links";
import { renderAuthors } from "../src/lib/cms-render-context";
import { LIVE_BLOG_POST_AS_OF, liveBlogPostFixture } from "./fixtures/live-blog-post";

const now = new Date("2026-10-07T13:00:00Z");
const rendererSha = "a".repeat(40);
const url = "https://dev-public.example.org/posts/shadow-fixture/";
const config = { SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-fixture" };
const authorId = `au_${"1".repeat(32)}`;
const otherAuthorId = `au_${"2".repeat(32)}`;
// The public Ada input from posts-authors.e2e.test.ts, with its path identity.
function authorSnapshot(overrides: Record<string, unknown> = {}) {
  return { id: authorId, authorId, slug: "ada-reporter", previousSlugs: ["a-reporter"], displayName: "Ada Reporter",
    jobTitle: "Statehouse reporter", bio: "Covers the Legislature for NJ PBS.", photo: null,
    links: { x: { handle: "adareporter", url: "https://x.com/adareporter" } }, pinnedPostId: null,
    hiddenPostIds: [], publishedAt: "2026-08-20T14:00:00.000Z", snapshotVersion: 2, ...overrides };
}
function registeredRead(): any {
  const read = structuredClone(fixture);
  Object.assign(read.document.published.metadata, { credits: [
    { kind: "registered", authorId, displayName: "Ada at publication", slug: "old-ada" },
    { kind: "custom", name: "Ada Reporter" },
  ] });
  return { ...read, authors: [authorSnapshot()] };
}
function harness() {
  const reader = createFakePublishedPostReader({ "shadow-fixture": fixture });
  const entries = new Map<string, Response>();
  const cache = {
    async match(key: Request) { return entries.get(key.url)?.clone(); },
    async put(key: Request, response: Response) { entries.set(key.url, response.clone()); },
  };
  let renders = 0;
  const worker = createShadowPostWorker({ reader, cache, rendererSha, now: () => now,
    async render(content) { renders++; return `<!doctype html><html><title>${content.posts[0].title}</title><main>Published body</main></html>`; } });
  return { worker, reader, entries, renders: () => renders };
}

describe("Post shadow edge boundary", () => {
  it("hydrates update-only public reporters and keeps missing reporters as frozen credits", () => {
    const read: any = liveBlogPostFixture();
    const credit = { kind: "registered", authorId, displayName: "Ada at publication" };
    read.document.published.metadata.liveBlog.updates[0].credits = [credit];
    read.document.published.metadata.liveBlog.updates[1].credits = [credit,
      { kind: "registered", authorId: otherAuthorId, displayName: "Missing reporter" }];
    read.authors = [authorSnapshot({ uid: "PRIVATE account", email: "private@example.test" })];
    const content = projectPublishedPostRead(read, "live-blog-local", rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
    expect(content.authors.map(author => author.authorId)).toEqual([authorId]);
    expect(content.authors[0].bio).toBe("Covers the Legislature for NJ PBS.");
    expect(content.posts[0].authorIds).toEqual([]);
    expect(content.posts[0].liveBlog?.updates[1].credits[1]).toEqual({ kind: "registered", authorId: otherAuthorId, displayName: "Missing reporter" });
    expect(JSON.stringify(content)).not.toContain("PRIVATE");
    expect(JSON.stringify(content)).not.toContain("private@example.test");
  });

  it("hydrates follow-up reporters once and excludes a withdrawn parent's private audit thread", () => {
    const read: any = liveBlogPostFixture();
    const updates = read.document.published.metadata.liveBlog.updates;
    const credits = [{ kind: "registered", authorId, displayName: "Ada at publication" },
      { kind: "registered", authorId: otherAuthorId, displayName: "Missing reporter" }];
    const reply = { body: updates[0].body, credits, publishedAt: LIVE_BLOG_POST_AS_OF, updatedAt: LIVE_BLOG_POST_AS_OF };
    updates[0].followUps = [{ ...reply, id: "reply-one" }, { ...reply, id: "reply-two" }];
    updates[2].followUps = [{ ...reply, id: "audit-reply", credits: [
      { kind: "registered", authorId: `au_${"3".repeat(32)}`, displayName: "PRIVATE audit reporter" },
    ] }];
    read.authors = [authorSnapshot()];
    const content = projectPublishedPostRead(read, "live-blog-local", rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
    expect(content.authors.map(author => author.authorId)).toEqual([authorId]);
    expect(content.posts[0].liveBlog?.updates[0].followUps?.[1].credits).toEqual(credits);
    expect(content.posts[0].liveBlog?.updates[2]).not.toHaveProperty("followUps");
    expect(JSON.stringify(content)).not.toContain("PRIVATE audit reporter");
    expect(updates[2].followUps).toHaveLength(1);
  });

  it("keeps reporting beyond the 100-profile budget without rejecting the Post", () => {
    const read: any = liveBlogPostFixture();
    const seed = read.document.published.metadata.liveBlog.updates[0];
    const ids = Array.from({ length: 101 }, (_, index) => `au_${index.toString(16).padStart(32, "0")}`);
    read.document.published.metadata.liveBlog.updates = ids.map((id, index) => ({ ...seed,
      id: `budget-${index}`, credits: [{ kind: "registered", authorId: id, displayName: `Reporter ${index}` }] }));
    read.authors = ids.map((id, index) => authorSnapshot({ id, authorId: id, slug: `reporter-${index}`, previousSlugs: [] }));
    const content = projectPublishedPostRead(read, "live-blog-local", rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
    expect(content.authors).toHaveLength(100);
    expect(content.authors.some(author => author.authorId === ids[100])).toBe(false);
    expect(content.posts[0].liveBlog?.updates).toHaveLength(101);
    expect(content.posts[0].liveBlog?.updates[100].credits[0]).toEqual({ kind: "registered", authorId: ids[100], displayName: "Reporter 100" });
  });
  it.each([undefined, false, true])("projects published Spotlight attribution %s with a false legacy default", spotlightNews => {
    const read = structuredClone(fixture);
    Object.assign(read.document, { spotlightNews: spotlightNews !== true });
    if (spotlightNews !== undefined) Object.assign(read.document.published.metadata, { spotlightNews });
    const content = projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)!;
    expectTypeOf(content.posts[0].spotlightNews).toEqualTypeOf<boolean>();
    expect(content.posts[0].spotlightNews).toBe(spotlightNews === true);
  });

  it("admits only the published snapshot and exact canonical slug", () => {
    const content = projectPublishedPostRead(fixture, "shadow-fixture", rendererSha, now)!;
    expect(content.kind).toBe("public-post-shadow");
    expect(content.posts[0].title).toBe("A published fixture");
    expect(content.target.sourceVersion).toBe(7);
    expect(JSON.stringify(content)).not.toContain("Private working title");
    expect(Object.isFrozen(content.posts[0].blocks)).toBe(true);
    expect(() => projectPublishedPostRead(fixture, "another-slug", rendererSha, now)).toThrow();
    expect(() => projectPublishedPostRead({ ...fixture, kind: "private-preview" }, "shadow-fixture", rendererSha, now)).toThrow();
  });

  it("projects current public profiles while retaining ordered frozen names and guest credits", () => {
    const read = registeredRead();
    const content = projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)!;
    expect(content.posts[0].credits).toEqual([
      { authorId, name: "Ada at publication", slug: "old-ada" }, { name: "Ada Reporter" },
    ]);
    expect(content.posts[0].authorIds).toEqual([authorId]);
    expect(content.authors).toEqual([{ authorId, slug: "ada-reporter", previousSlugs: ["a-reporter"], path: "/authors/ada-reporter/",
      displayName: "Ada Reporter", jobTitle: "Statehouse reporter", bio: "Covers the Legislature for NJ PBS.", photo: null,
      links: [{ platform: "x", url: "https://x.com/adareporter" }], pinnedPostId: null, hiddenPostIds: [], sourceVersion: 2 }]);
    expect(resolvePublicCreditLinks(content.posts[0].credits, content.authors)).toEqual([
      { authorId, name: "Ada Reporter", slug: "ada-reporter" }, { name: "Ada Reporter" },
    ]);
    expect(renderAuthors({ content, homeSources: {} as never })[0]).toEqual({
      id: authorId, collection: "cmsAuthorsPublic", data: content.authors[0],
    });
    expect(Object.isFrozen(content.authors)).toBe(true);
    expect(Object.isFrozen(content.authors[0].links[0])).toBe(true);
    read.authors[0].displayName = "Changed input";
    expect(content.authors[0].displayName).toBe("Ada Reporter");
  });

  it("orders current context by stable credit identity and keeps public fields detached", () => {
    const read = registeredRead();
    read.document.published.metadata.credits.push({ kind: "registered", authorId: otherAuthorId, displayName: "Bea at publication" });
    read.authors = [authorSnapshot({ id: otherAuthorId, authorId: otherAuthorId, slug: "bea-reporter", previousSlugs: [], displayName: "Bea Current" }),
      authorSnapshot({ displayName: "Ada Current", slug: "ada-current", previousSlugs: ["ada-reporter"], uid: "Private UID", email: "private@example.test",
        photo: { url: "https://media.njpbs.org/cms-media/ada.jpg", mimeType: "image/jpeg", width: 800, height: 800,
          privateKey: "Private photo key", thumbnails: [{ url: "https://media.njpbs.org/cms-media/ada-w960.webp", width: 960, height: 960, storageKey: "Private storage key" }] },
        links: { x: { handle: "adareporter", url: "https://x.com/adareporter", staffToken: "Private link token" } } })];
    const content = projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)!;
    expect(content.authors.map(author => author.authorId)).toEqual([authorId, otherAuthorId]);
    expect(resolvePublicCreditLinks(content.posts[0].credits, content.authors)).toEqual([
      { authorId, name: "Ada Current", slug: "ada-current" }, { name: "Ada Reporter" },
      { authorId: otherAuthorId, name: "Bea Current", slug: "bea-reporter" },
    ]);
    expect(content.authors[0].photo?.displayUrl).toBe("https://media.njpbs.org/cms-media/ada-w960.webp");
    expect(Object.isFrozen(content.authors[0].photo)).toBe(true);
    expect(JSON.stringify(content)).not.toMatch(/Private|private@example|uid|email|storageKey|staffToken/);
  });

  it.each([undefined, [], [authorSnapshot({ slug: "Ada Reporter" })], [authorSnapshot({ displayName: " " })],
    [authorSnapshot({ snapshotVersion: 0 })]].map(authors => ({ authors })))("retains the frozen unlinked name for missing or unusable public context %j", ({ authors }) => {
    const read = registeredRead();
    read.authors = authors;
    const content = projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)!;
    expect(content.authors).toEqual([]);
    expect(resolvePublicCreditLinks(content.posts[0].credits, content.authors)).toEqual([
      { authorId, name: "Ada at publication" }, { name: "Ada Reporter" },
    ]);
  });

  it.each([
    null, {}, [authorSnapshot({ id: "private-uid" })], [authorSnapshot({ authorId: otherAuthorId })],
    [authorSnapshot(), authorSnapshot()], [authorSnapshot({ id: otherAuthorId, authorId: otherAuthorId })],
    Array.from({ length: 13 }, () => authorSnapshot()),
  ].map(authors => ({ authors })))("refuses malformed, conflicting, duplicate or unreferenced author context %j", ({ authors }) => {
    const read = registeredRead();
    read.authors = authors;
    expect(() => projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)).toThrow("public author");
  });

  it("refuses current and retired author route collisions", () => {
    const read = registeredRead();
    read.document.published.metadata.credits.push({ kind: "registered", authorId: otherAuthorId, displayName: "Bea at publication" });
    read.authors.push(authorSnapshot({ id: otherAuthorId, authorId: otherAuthorId, slug: "bea-reporter", previousSlugs: ["ada-reporter"] }));
    expect(() => projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)).toThrow("/authors/ routes collide");
  });

  it.each([
    { credits: [{ kind: "registered", authorId, displayName: "" }] },
    { credits: [{ kind: "registered", authorId: "private-uid", displayName: "Ada Reporter" }] },
    { credits: [{ kind: "registered", authorId: `${authorId}\n`, displayName: "Ada Reporter" }] },
    { credits: [{ kind: "registered", authorId, displayName: "Ada Reporter", slug: "bad/route" }] },
    { credits: [{ kind: "registered", authorId, displayName: "Ada Reporter" }, { kind: "registered", authorId, displayName: "Duplicate" }] },
    { credits: Array.from({ length: 13 }, () => ({ kind: "custom", name: "Guest writer" })) },
  ])("refuses malformed frozen credit input %j", ({ credits }) => {
    const read = registeredRead();
    read.document.published.metadata.credits = credits;
    expect(() => projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)).toThrow("published");
  });

  it("keeps the two-megabyte reader bound before public author projection", () => {
    const read = registeredRead();
    read.authors[0].bio = "a".repeat(2 * 1024 * 1024);
    expect(() => projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)).toThrow("Published read too large");
  });

  it("caches by exact input and checks visibility before every cache hit", async () => {
    const h = harness();
    const first = await h.worker.fetch(new Request(url), config);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Tag")).toBe("njpbs-dev-post-shadow-fixture");
    expect(first.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(first.headers.get("X-Njpbs-Source-Version")).toBe("7");
    await h.worker.fetch(new Request(url), config);
    expect(h.renders()).toBe(1);
    h.reader.set("shadow-fixture", null);
    const withdrawn = await h.worker.fetch(new Request(url), config);
    expect(withdrawn.status).toBe(404);
    expect(await withdrawn.text()).not.toContain("Published body");
  });

  it("fails closed on a read failure even when HTML is cached", async () => {
    const h = harness();
    await h.worker.fetch(new Request(url), config);
    h.reader.fail(new Error("Private backend details"));
    const failed = await h.worker.fetch(new Request(url), config);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(await failed.text()).not.toMatch(/Published body|Private backend details/);
  });

  it("does not reuse HTML for a newer published version", async () => {
    const h = harness();
    await h.worker.fetch(new Request(url), config);
    const next = structuredClone(fixture);
    next.document.published.sourceVersion = 8;
    next.document.published.metadata.title = "A newer publication";
    h.reader.set("shadow-fixture", next);
    const response = await h.worker.fetch(new Request(url), config);
    expect(await response.text()).toContain("A newer publication");
    expect(h.renders()).toBe(2);
  });

  it("refuses production hosts, disabled flags, other routes and query variants", async () => {
    const h = harness();
    for (const target of [url.replace("dev-public.example.org", "njpbs.org"), url + "?draft=1", "https://dev-public.example.org/posts/", "https://dev-public.example.org/"]) {
      expect((await h.worker.fetch(new Request(target), config)).status).toBe(404);
    }
    expect((await h.worker.fetch(new Request(url), { ...config, SHADOW_POSTS_ENABLED: "false" })).status).toBe(404);
    expect((await h.worker.fetch(new Request(url), { ...config, SHADOW_POST_SLUGS: "" })).status).toBe(404);
    expect((await h.worker.fetch(new Request(url, { method: "POST" }), config)).status).toBe(405);
    expect(h.renders()).toBe(0);
  });

  it("calls the purge boundary with old and new route tags after a publish commit", async () => {
    const calls: string[][] = [];
    const reader = createFakePublishedPostReader({});
    await reader.publish("shadow-fixture", fixture, slugs => purgePublishedPostRoutes(slugs, {
      async purge(tags) {
        expect(await reader.read("shadow-fixture")).toEqual(fixture);
        calls.push(tags);
      },
    }), ["old-fixture", "shadow-fixture"]);
    expect(calls).toEqual([["njpbs-dev-post-old-fixture", "njpbs-dev-post-shadow-fixture"]]);
    await expect(purgePublishedPostRoutes(["shadow-fixture"], { async purge() { throw new Error("Unavailable"); } })).rejects.toThrow("Unavailable");
  });
});
