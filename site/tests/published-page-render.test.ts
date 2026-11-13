import { createHash } from "node:crypto";
import { createHomeNewsletterBlock, renderHomeNewsletter } from "../../packages/content-core/src/home-newsletter-section";
import { createHomeNewsletterSnapshot } from "../../packages/content-core/src/home-service-sources";
import { homeCatalogJson } from "../../packages/content-core/src/home-source-catalog";
import newsletterCopy from "./fixtures/home-sources/newsletter-public-copy.json";
import { describe, expect, it } from "vitest";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { publishedPageRead, retainedHomeSources, staticFixtureContent, pageIds, now } from "./fixtures/published-pages/fixtures";
import { resolveHomeHeroItems } from "../src/lib/home-hero-items";
import { homeSourcePreviewSnapshot } from "../src/lib/home-hero-items";
import { rebuildHomeSourcesForPosts } from "../src/lib/home-editorial-catalog";
import { DEFAULT_NJ_DECIDES_SETTINGS } from "../../packages/content-core/src/cms-settings";

describe("published Page render boundary", () => {
  it("admits all five chrome settings while keeping story CTAs off Home content", async () => {
    const input = publishedPageRead("home");
    input.settings.push(
      { id: "nj-decides-brand", version: 4, published: { schemaVersion: 1, sourceVersion: 3,
        publishedAt: "2026-10-12T10:00:00.000Z", values: structuredClone(DEFAULT_NJ_DECIDES_SETTINGS) } } as never,
      { id: "story-ctas", version: 4, published: { schemaVersion: 1, sourceVersion: 3,
        publishedAt: "2026-10-12T10:00:00.000Z", values: { rules: [] } } } as never,
    );
    expect(input.settings.map(setting => setting.id)).toEqual([
      "site-navigation", "public-site-chrome", "public-homepage-banner", "nj-decides-brand", "story-ctas",
    ]);
    const content = await projectPublishedPageRead(input, "home", "a".repeat(40), now, retainedHomeSources());
    expect(content.settings.map(setting => setting.settingId)).toEqual(input.settings.map(setting => setting.id));
    expect(content.pages[0].blocks).toEqual(staticFixtureContent().pages.find(page => page.pageId === "home")!.blocks);
    input.settings.push({ ...input.settings[0] } as never);
    await expect(projectPublishedPageRead(input, "home", "a".repeat(40), now, retainedHomeSources())).rejects.toThrow("Invalid Page settings");
  });
  it("never retains stale Page cards in public Home source snapshots or either build-free refresh", async () => {
    const sources = retainedHomeSources();
    sources.heroCatalog = [...(sources.heroCatalog ?? []), { id: "contact", source: "cms_pages", title: "Withdrawn Page", summary: "Old summary", href: "/contact/", categories: [], tags: [] }];
    expect(homeSourcePreviewSnapshot(sources, []).heroCatalog?.some(card => card.source === "cms_pages")).toBe(false);
    const refreshed = await projectPublishedPageRead(publishedPageRead("home"), "home", "a".repeat(40), now, sources);
    expect(JSON.stringify(refreshed.homeSources)).not.toContain("Withdrawn Page");
    expect(JSON.stringify(rebuildHomeSourcesForPosts(sources, [], sources.publication!, now.toISOString()))).not.toContain("Withdrawn Page");
  });
  it("uses fresh published Page pins and changes the cached render input at expiry without a publication", async () => {
    const input = publishedPageRead("home") as ReturnType<typeof publishedPageRead> & { homeHeroPages: unknown[] };
    const end = new Date(now.getTime() + 60_000).toISOString();
    input.page.homeHero = { mode: "tag", source: "cms_posts", value: "no-auto-match", pins: [{ source: "cms_pages", sourceId: "contact", endsAt: end }] };
    input.homeHeroPages = [publishedPageRead("contact").page];
    const before = await projectPublishedPageRead(input, "home", "a".repeat(40), now, retainedHomeSources());
    expect(before.pages).toHaveLength(1);
    expect(resolveHomeHeroItems(before.pages[0].homeHero, before.homeSources, before.posts, {}, before.authors, before.homeHeroPages, now.getTime()).map(item => item.href)).toEqual(["/contact/"]);
    input.homeHeroPages = [{ ...publishedPageRead("contact").page, contentLinkMode: "custom", contentLinkUrl: "https://example.org/published-page", contentLinkNewTab: false }];
    const linked = await projectPublishedPageRead(input, "home", "a".repeat(40), now, retainedHomeSources());
    expect(resolveHomeHeroItems(linked.pages[0].homeHero, linked.homeSources, linked.posts, {}, linked.authors, linked.homeHeroPages, now.getTime())[0]).toMatchObject({ href: "https://example.org/published-page", contentLinkNewTab: false });
    const expired = await projectPublishedPageRead(input, "home", "a".repeat(40), new Date(end), retainedHomeSources());
    expect(expired.target).toEqual(before.target);
    expect(expired.pages[0].homeHero?.pins).toEqual([]);
    expect(JSON.stringify(expired)).not.toEqual(JSON.stringify(before));
    expect(resolveHomeHeroItems(expired.pages[0].homeHero, expired.homeSources, expired.posts, {}, expired.authors, expired.pages)).toEqual([]);
    input.homeHeroPages = [];
    const withdrawn = await projectPublishedPageRead(input, "home", "a".repeat(40), now, retainedHomeSources());
    const stale = { ...withdrawn.homeSources!, heroCatalog: [{ id: "contact", source: "cms_pages" as const, title: "Stale", summary: "", href: "/contact/", categories: [], tags: [] }] };
    expect(resolveHomeHeroItems(withdrawn.pages[0].homeHero, stale, withdrawn.posts, {}, withdrawn.authors, withdrawn.pages)).toEqual([]);
  });
  it.each([true, false])("retains childDirected=%s from the public read through render projection", async childDirected => {
    const input = publishedPageRead("contact");
    input.page.childDirected = childDirected;
    const content = await projectPublishedPageRead(input, "contact", "a".repeat(40), now);
    expect(content.pages[0].childDirected).toBe(childDirected);
    expect(Object.isFrozen(content.pages[0])).toBe(true);
  });
  it.each(pageIds)("matches the full-build published projection for %s and deeply freezes one operation", async pageId => {
    const input = publishedPageRead(pageId);
    const content = await projectPublishedPageRead(input, pageId, "a".repeat(40), now, pageId === "home" ? retainedHomeSources() : undefined);
    expect(content.pages[0]).toEqual(staticFixtureContent().pages.find(page => page.pageId === pageId));
    expect(Object.isFrozen(content.pages[0].blocks)).toBe(true);
    expect(JSON.stringify(content)).not.toContain("PRIVATE");
    input.page.title = "Newer input mutation";
    expect(content.pages[0].title).not.toBe(input.page.title);
  });
  it("uses retained provider pools and current native Posts and public bylines for Home", async () => {
    const content = await projectPublishedPageRead(publishedPageRead("home"), "home", "a".repeat(40), now, retainedHomeSources());
    const baseline = staticFixtureContent();
    expect(content.homeSources).toEqual(baseline.homeSources);
    expect(content.posts).toEqual(baseline.posts.map(post => ({ ...post, blocks: [] })));
    expect(content.authors).toEqual(baseline.authors);
  });
  it("uses current approved Newsletter joins on actual Home reads without working fields, stale selected art or provider refresh", async () => {
    const input = publishedPageRead("home");
    const sources = retainedHomeSources();
    const cutoffAt = sources.editorial!.catalog.cutoffAt;
    const retainedRecord = { id: "newsletter-one", kind: "newsletter", href: null, sourceVersion: 1,
      newsletter: { card: { title: newsletterCopy.title, signupUrl: newsletterCopy.signupUrl, summary: newsletterCopy.summary } } };
    sources.editorial!.catalog.services = { newsletters: createHomeNewsletterSnapshot([retainedRecord,
      { ...retainedRecord, id: "newsletter-two" }], cutoffAt, cutoffAt) };
    sources.editorial!.receipt.digest = createHash("sha256").update(homeCatalogJson(sources.editorial!.catalog)).digest("hex");
    input.page.homeCompositionVersion = 2;
    input.page.blocks.push({ ...createHomeNewsletterBlock("newsletter-bar"), order: 7, data: {
      newsletterIds: ["newsletter-one"], actionLabel: "Sign up by email", selectionReceipt: sources.editorial!.receipt } } as never);
    input.joinedRecords = [{ id: "newsletter-one", type: "newsletter", status: "draft", version: 3,
      title: "PRIVATE working title", signupUrl: "https://private.example.test/", approvedLibraryVersion: {
        type: "newsletter", status: "approved", version: 2, title: "Approved Newsletter correction",
        summary: newsletterCopy.summary, signupUrl: newsletterCopy.signupUrl, body: { type: "doc", content: [] },
      } }] as never;
    const updated = await projectPublishedPageRead(input, "home", "a".repeat(40), now, sources);
    const bar = updated.pages[0].blocks.at(-1)!;
    if (bar.type !== "newsletter_signup") throw new Error("Expected saved Newsletter");
    expect(renderHomeNewsletter(bar, updated.homeSources!.editorial!.catalog)).toContain("Approved Newsletter correction");
    expect(JSON.stringify(updated)).not.toContain("PRIVATE working");
    expect(updated.homeSources!.pbs).toEqual(sources.pbs);
    expect(updated.homeSources!.spotlight).toEqual(sources.spotlight);
    expect(JSON.stringify(updated.homeSources!.editorial!.catalog.services)).toContain("newsletter-two");
    input.joinedRecords = [];
    const withdrawn = await projectPublishedPageRead(input, "home", "a".repeat(40), now, sources);
    expect(renderHomeNewsletter(bar, withdrawn.homeSources!.editorial!.catalog)).toBe("");
    expect(withdrawn.pages[0].blocks.at(-1)!.data).toEqual(bar.data);
  });
  it("seeds first and changed selections from the complete current approved cloud roster without a retained service seal", async () => {
    const input = publishedPageRead("home") as ReturnType<typeof publishedPageRead> & { homeNewsletters: unknown };
    const sources = retainedHomeSources();
    const approved = (id: string) => ({ id, type: "newsletter", status: "draft", version: 3,
      title: "PRIVATE working title", approvedLibraryVersion: { type: "newsletter", status: "approved", version: 2,
        title: `Approved ${id}`, signupUrl: newsletterCopy.signupUrl, body: { type: "doc", content: [] } } });
    input.homeNewsletters = { assets: [], joinedRecords: [approved("newsletter-one"), approved("newsletter-two")] };
    const first = await projectPublishedPageRead(input, "home", "a".repeat(40), now, sources);
    const pool = first.homeSources!.editorial!.catalog.services!.newsletters;
    expect(pool.status).toBe("ready");
    if (pool.status !== "ready") throw new Error("Expected current approved roster");
    expect(pool.records.map(record => (record as { id: string }).id)).toEqual(["newsletter-one", "newsletter-two"]);
    expect(JSON.stringify(first)).not.toContain("PRIVATE");
    const receipt = first.homeSources!.editorial!.receipt;
    expect(receipt.digest).toBe(createHash("sha256").update(homeCatalogJson(first.homeSources!.editorial!.catalog)).digest("hex"));
    input.page.homeCompositionVersion = 2;
    input.page.blocks.push({ ...createHomeNewsletterBlock("newsletter-bar"), order: 7,
      data: { newsletterIds: ["newsletter-two"], actionLabel: "Sign up by email", selectionReceipt: receipt } } as never);
    const selected = await projectPublishedPageRead(input, "home", "a".repeat(40), now, sources);
    const bar = selected.pages[0].blocks.at(-1)!;
    if (bar.type !== "newsletter_signup") throw new Error("Expected saved Newsletter");
    expect(renderHomeNewsletter(bar, selected.homeSources!.editorial!.catalog)).toContain("Approved newsletter-two");
    input.homeNewsletters = { assets: [], joinedRecords: [approved("newsletter-one")] };
    const withdrawn = await projectPublishedPageRead(input, "home", "a".repeat(40), now, selected.homeSources);
    expect(renderHomeNewsletter(bar, withdrawn.homeSources!.editorial!.catalog)).toBe("");
    expect(JSON.stringify(withdrawn.homeSources!.editorial!.catalog.services)).not.toContain("newsletter-two");
    input.homeNewsletters = { status: "error" };
    const unavailable = await projectPublishedPageRead(input, "home", "a".repeat(40), now, selected.homeSources);
    expect(unavailable.pages[0].pageId).toBe("home");
    expect(unavailable.homeSources!.pbs).toEqual(sources.pbs);
    expect(unavailable.homeSources!.editorial!.catalog.services!.newsletters).toEqual({ status: "error" });
    expect(renderHomeNewsletter(bar, unavailable.homeSources!.editorial!.catalog)).toBe("");
  });
  it("fits long approved choices in the shared catalog budget and retains a saved hidden selection without changing provider pools", async () => {
    const input = publishedPageRead("home") as ReturnType<typeof publishedPageRead> & { homeNewsletters: unknown };
    const sources = retainedHomeSources();
    input.homeNewsletters = { assets: [], joinedRecords: Array.from({ length: 200 }, (_, index) => ({
      id: `newsletter-${String(index).padStart(3, "0")}`, type: "newsletter", status: "approved", version: 2,
      approvedLibraryVersion: { type: "newsletter", status: "approved", version: 2, title: "T".repeat(300),
        summary: "S".repeat(300), signupUrl: "https://example.org/" + "a".repeat(1900) },
    })) };
    input.page.homeCompositionVersion = 2;
    input.page.blocks.push({ ...createHomeNewsletterBlock("newsletter-bar"), visible: false, order: 7,
      data: { newsletterIds: ["newsletter-199"], actionLabel: "Sign up by email", selectionReceipt: sources.editorial!.receipt } } as never);
    const current = await projectPublishedPageRead(input, "home", "a".repeat(40), now, sources);
    expect(new TextEncoder().encode(homeCatalogJson(current.homeSources!.editorial!.catalog)).byteLength).toBeLessThanOrEqual(400_000);
    const pool = current.homeSources!.editorial!.catalog.services!.newsletters;
    if (pool.status !== "ready") throw new Error("Expected bounded approved pool");
    expect(pool.records.length).toBeGreaterThan(0);
    expect(pool.records.length).toBeLessThan(200);
    expect(pool.records.some(record => (record as { id: string }).id === "newsletter-199")).toBe(true);
    expect(current.homeSources!.pbs).toEqual(sources.pbs);
    expect(current.homeSources!.spotlight).toEqual(sources.spotlight);
  });
  it("refuses another renderer, private input, invalid target and malformed joined context", async () => {
    for (const mutate of [
      (input: ReturnType<typeof publishedPageRead>) => { input.kind = "private-preview"; },
      (input: ReturnType<typeof publishedPageRead>) => { input.sourceSeal.rendererSha = "c".repeat(40); },
      (input: ReturnType<typeof publishedPageRead>) => { input.sourceSeal.contextRevision = 5; },
      (input: ReturnType<typeof publishedPageRead>) => { input.page.sourceVersion = 0; },
      (input: ReturnType<typeof publishedPageRead>) => { input.page.path = "/posts/private/"; },
      (input: ReturnType<typeof publishedPageRead>) => { input.page.blocks[1].layout.rowId = "missing"; },
      (input: ReturnType<typeof publishedPageRead>) => { input.joinedRecords = [{}] as never; },
    ]) {
      const input = publishedPageRead("contact"); mutate(input);
      await expect(projectPublishedPageRead(input, "contact", "a".repeat(40), now)).rejects.toThrow();
    }
  });
  it("refuses missing Home provider pools and changed source seals", async () => {
    const input = publishedPageRead("home");
    await expect(projectPublishedPageRead(input, "home", "a".repeat(40), now)).rejects.toThrow("exact retained sources");
    const sources = retainedHomeSources(); sources.editorial!.receipt.digest = "c".repeat(64);
    await expect(projectPublishedPageRead(input, "home", "a".repeat(40), now, sources)).rejects.toThrow("source seal");
  });
  it("keeps saved vendor metadata siblings outside public template inputs", async () => {
    const input = publishedPageRead("contact");
    input.page.seo = { title: "Published SEO", vendor: "PRIVATE vendor setting" };
    const content = await projectPublishedPageRead(input, "contact", "a".repeat(40), now);
    expect(content.pages[0].seo).toEqual({ title: "Published SEO" });
    expect(JSON.stringify(content)).not.toContain("PRIVATE");
    input.page.blocks[1].data.text = "Caller can still edit its separate input";
    expect(content.pages[0].blocks[1].data).toEqual({ text: "A published heading", level: 2 });
  });
  it("uses Home card metadata without requiring the detail body's instant capability", async () => {
    const input = publishedPageRead("home");
    input.posts[0].document.published.blocks = [{ id: "embed", type: "embed", order: 0, visible: true,
      data: { url: "https://example.test/embedded-story", caption: "Body is outside the Home card" } }] as never;
    const content = await projectPublishedPageRead(input, "home", "a".repeat(40), now, retainedHomeSources());
    expect(content.posts[0].title).toBe("A published fixture");
    expect(content.posts[0].blocks).toEqual([]);
    expect(content.authors[0].displayName).toBe("Ada Reporter");
  });
});


it.each([{ slug: "Invalid Slug" }, { displayName: "" }, { snapshotVersion: 0 }])("refuses unusable Staff snapshots %j without silently shrinking the directory", async invalid => {
  const input = publishedPageRead("staff"); Object.assign(input.authors[0], invalid);
  await expect(projectPublishedPageRead(input, "staff", "a".repeat(40), now)).rejects.toThrow("Staff public snapshot is unusable");
});
