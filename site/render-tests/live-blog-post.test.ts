import { LIVE_BLOG_SIDEBAR } from "../../packages/content-core/src/live-blog-layout";
import { beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { LIVE_BLOG_POST_AS_OF, liveBlogPostFixture } from "../tests/fixtures/live-blog-post";

let compiled: { rendererSha: string; renderPublishedPost: (content: NonNullable<ReturnType<typeof projectPublishedPostRead>>) => Promise<string> };
beforeAll(async () => { compiled = await import(/* @vite-ignore */ pathToFileURL(resolve(".shadow-renderer/server/entry.mjs")).href); });
async function render(options: Parameters<typeof liveBlogPostFixture>[0] = {}) {
  const content = projectPublishedPostRead(liveBlogPostFixture(options), "live-blog-local", compiled.rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
  return compiled.renderPublishedPost(content);
}
describe("live blog in the actual Post shell", () => {
  it("keeps one title, introduction, byline, sharing controls and the frozen feed", async () => {
    const html = await render();
    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain("Live coverage across New Jersey");
    expect(html).toContain("Follow the latest reporting");
    expect(html).toContain('class="live-blog"');
    expect(html).toContain("Council confirms the meeting time");
    expect(html).toContain("An earlier update named the wrong room.");
    expect(html).toContain("The report could not be verified.");
    expect(html.match(/\bdata-post-share(?:\s|>)/g)).toHaveLength(2);
    expect(html).not.toMatch(/<video[^>]*autoplay|aria-live="assertive"/);
  });
  it.each(["ongoing", "paused", "ended"] as const)("renders %s coverage and its empty archive", async state => {
    expect(await render({ state })).toContain(`Coverage ${state}`);
    expect(await render({ state, empty: true })).toContain(state === "ended" ? "No updates were published." : "No updates have been published yet.");
  });
  it.each(["image", "library-video", "embed", "linked-video"] as const)("renders entry %s with the existing media conventions", async media => {
    const html = await render({ media, branding: true });
    expect(html).toContain("NJ Decides 2026"); expect(html).toContain('class="live-blog__media"');
    if (media === "image") { expect(html).toContain('alt="Residents on the platform"'); expect(html).toContain("Frozen lead caption"); }
    if (media === "library-video") { expect(html).toMatch(/<video[^>]*controls[^>]*preload="none"/); expect(html).not.toContain("data-analytics-consent"); }
    if (media === "embed") { expect(html).toContain('data-lead-template'); expect(html).toContain('aria-label="Play Coastal voices"'); expect(html).toContain('class="post-lead-player__caption">Produced by NJ PBS</p>'); expect(html).toContain('alt="" decoding="async" loading="lazy"'); expect(html).toContain("youtube-nocookie"); expect(html).not.toContain("data-analytics-consent"); }
    if (media === "linked-video") expect(html).toContain("watch.njpbs.org/video/coastal-voices/");
    expect(html).not.toMatch(/<video[^>]*autoplay|autoplay=(?:1|true)/);
  });
  it("includes the whole archive without JavaScript and offers progressively enhanced paging", async () => {
    const html = await render({ archive: true });
    expect(html.match(/<article class="live-blog__entry" id="live-blog-[^"]+-entry-/g)).toHaveLength(53);
    expect(html).toContain("Archive update 53"); expect(html).toContain("data-live-blog-pagination");
  });

  it.each(["missing-record", "empty-sponsors", "missing-newsletter", "mixed"])("omits the sidebar column when all %s planks render nothing", async kind => {
    const content = projectPublishedPostRead(liveBlogPostFixture(), "live-blog-local", compiled.rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
    const hidden = [
      { id: "missing-card", type: "record_card" as const, visible: true, order: 1, section: LIVE_BLOG_SIDEBAR,
        data: { recordKind: "newsletter" as const, recordId: "not-published", variant: "compact" as const } },
      { id: "no-sponsors", type: "sponsor_strip" as const, visible: true, order: 2, section: LIVE_BLOG_SIDEBAR,
        data: { sponsorIds: [], layout: "row" as const } },
      { id: "missing-signup", type: "newsletter_signup" as const, visible: true, order: 3, section: LIVE_BLOG_SIDEBAR,
        data: { newsletterIds: ["not-published"] } },
    ];
    const blocks = [...content.posts[0].blocks, ...(kind === "mixed" ? hidden : [hidden[kind === "missing-record" ? 0 : kind === "empty-sponsors" ? 1 : 2]])];
    const html = await compiled.renderPublishedPost({ ...content, posts: [{ ...content.posts[0], blocks }] });
    expect(html).toContain('class="live-blog"');
    expect(html).not.toContain('aria-label="More from this coverage"');
    expect(html).not.toContain('class="post-live-blog-layout"');
  });
  it("retains the sidebar when a visible plank follows an omitted card", async () => {
    const content = projectPublishedPostRead(liveBlogPostFixture({ sidebar: true }), "live-blog-local", compiled.rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
    const blocks = [...content.posts[0].blocks, { id: "missing-card", type: "record_card" as const, visible: true, order: 3,
      section: LIVE_BLOG_SIDEBAR, data: { recordKind: "newsletter" as const, recordId: "not-published", variant: "compact" as const } }];
    const html = await compiled.renderPublishedPost({ ...content, posts: [{ ...content.posts[0], blocks }] });
    expect(html).toContain('aria-label="More from this coverage"');
    expect(html).toContain('data-block-id="sidebar-copy"');
    expect(html).not.toContain('data-block-id="missing-card"');
  });

  it("keeps a resolved Astro card in the sidebar even though its leaf HTML is empty", async () => {
    const content = projectPublishedPostRead(liveBlogPostFixture(), "live-blog-local", compiled.rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
    const blocks = [...content.posts[0].blocks, { id: "program-card", type: "record_card" as const, visible: true, order: 1,
      section: LIVE_BLOG_SIDEBAR, data: { recordKind: "program" as const, recordId: "program", variant: "compact" as const } }];
    const html = await compiled.renderPublishedPost({ ...content, posts: [{ ...content.posts[0], blocks }], recordCards: [
      { kind: "program", id: "program", title: "Public program", href: "/programs/public-program/" },
    ] });
    expect(html).toContain('aria-label="More from this coverage"');
    expect(html).toContain('data-block-id="program-card"');
    expect(html).toContain("Public program");
  });

  it("keeps ordinary Posts on the same shell without a feed", async () => {
    const html = await render({ before: true });
    expect(html).not.toContain('class="live-blog"');
    expect(html).toContain("Live coverage across New Jersey");
  });
  it("uses the existing election kit only for election-branded coverage", async () => {
    const election = await render({ branding: true, archive: true });
    expect(election).toContain("data-live-blog-branding");
    expect(election).toContain("data-nj-decides-band");
    expect(election).toContain('src="/brand/nj-decides/logo.svg"');
    expect(election).toContain('alt="NJ Decides 2026"');
    expect(await render()).not.toContain("data-live-blog-branding");
  });
  it.each(["visible", "off", "expired"] as const)("keeps the staff announcement and its %s schedule", async state => {
    const content = projectPublishedPostRead(liveBlogPostFixture({ branding: true }), "live-blog-local", compiled.rendererSha, new Date(LIVE_BLOG_POST_AS_OF))!;
    const html = await compiled.renderPublishedPost({ ...content, settings: [...content.settings, {
      settingId: "public-homepage-banner", enabled: state !== "off", njDecides: true,
      message: "Follow our election reporting", link: { label: "Election hub", href: "/election/" },
      ...(state === "expired" ? { endsAt: "2020-11-04T04:00:00.000Z" } : {}),
      sourceVersion: 1, publishedAt: LIVE_BLOG_POST_AS_OF }] });
    const announcement = html.match(/<aside[^>]*data-nj-decides-announcement[^>]*>/)?.[0];
    expect(html).toContain("data-live-blog-branding");
    if (state === "off") expect(announcement).toBeUndefined();
    else {
      expect(announcement).toBeDefined();
      expect(/\bhidden(?:\s|>|=)/.test(announcement!)).toBe(state === "expired");
      expect(html).toContain("Follow our election reporting");
      expect(html).toContain('href="/election/"');
    }
  });
  it("describes the same immutable updates and anchors in LiveBlogPosting JSON-LD", async () => {
    const html = await render();
    const values = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
    const blog = values.find(value => value["@type"] === "LiveBlogPosting");
    expect(blog).toBeDefined(); expect(blog.liveBlogUpdate).toHaveLength(2);
    expect(blog.author).toEqual([{ "@type": "Person", name: "Example newsroom" }]);
    expect(blog.publisher).toMatchObject({ "@type": "Organization", name: "NJ PBS" });
    expect(blog.description).toBe("Synthetic reporting for the local Post shell review.");
    expect(blog).not.toHaveProperty("coverageEndTime");
    for (const entry of blog.liveBlogUpdate) {
      expect(html).toContain(`id="${new URL(entry["@id"]).hash.slice(1)}"`);
      expect(html).toContain(entry.articleBody);
    }
    const ordinary = await render({ before: true });
    expect(ordinary).toContain('"@type":"NewsArticle"'); expect(ordinary).not.toContain('"@type":"LiveBlogPosting"');
    const ended = await render({ state: "ended" });
    expect(ended).not.toContain('"@type":"LiveBlogPosting"'); expect(ended).toContain('"@type":"NewsArticle"');
  });
});
