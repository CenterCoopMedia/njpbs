import { beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { LEAD_LAYOUTS, LEAD_KINDS, postLeadFixture, leadFixtureVideo, leadFixturePoster } from "../tests/fixtures/post-lead-media";

let compiled: { rendererSha: string; renderPublishedPost: (content: NonNullable<ReturnType<typeof projectPublishedPostRead>>) => Promise<string> };
beforeAll(async () => { compiled = await import(/* @vite-ignore */ pathToFileURL(resolve(".shadow-renderer/server/entry.mjs")).href); });
async function render(layout: typeof LEAD_LAYOUTS[number], kind: typeof LEAD_KINDS[number] | "legacy" | "invalid") {
  const fixture = postLeadFixture(layout, kind);
  const content = projectPublishedPostRead(fixture, String(fixture.document.published.metadata.slug), compiled.rendererSha, new Date("2026-10-07T13:00:00Z"))!;
  return compiled.renderPublishedPost(content);
}

describe("lead media in the actual four Post renderers", () => {
  it.each(LEAD_LAYOUTS.flatMap(layout => LEAD_KINDS.map(kind => [layout, kind] as const)))("renders %s / %s with its accessible name and representative image", async (layout, kind) => {
    const html = await render(layout, kind);
    expect(html).toContain("Coastal voices: a New Jersey story");
    expect(html.match(/\bdata-post-share(?:\s|>)/g)).toHaveLength(2);
    expect(html).toMatch(/<section[^>]*post-share--top[^>]*aria-label="Share this post"/);
    expect(html).toMatch(/<section[^>]*post-share--bottom[^>]*aria-label="Share this post with others"/);
    if (layout === "standard") expect(html).toContain('data-layout="visual"');
    if (layout !== "standard") expect(html).toContain(`data-post-presentation="${layout}"`);
    if (kind === "image") {
      expect(html).toContain('alt="Residents on the platform"');
      expect(html).not.toContain("data-post-lead-player");
    } else {
      expect(html).toContain('data-post-lead-player');
      expect(html).toContain('aria-label="Coastal voices"');
      expect(html).not.toContain('data-analytics-consent');
      expect(html).not.toMatch(/<video[^>]*\sautoplay(?:\s|=|>)/);
      if (kind === "library-video") {
        expect(html).toContain(`src="${leadFixtureVideo}"`);
        expect(html).toMatch(/<video[^>]*controls[^>]*preload="none"/);
      }
      if (kind === "embed") {
        expect(html).toContain('aria-label="Play Coastal voices"');
        expect(html).toMatch(/<template[^>]*data-lead-template[^>]*>[\s\S]*?<iframe[^>]*youtube-nocookie/);
      }
      if (kind === "linked-video") expect(html).toContain('href="https://watch.njpbs.org/video/coastal-voices/"');
      if (kind !== "library-video") {
        const poster = html.match(/<img\b[^>]*src="https:\/\/media\.njpbs\.org[^>]*alt=""[^>]*>/)?.[0];
        expect(poster).toBeTruthy();
        expect(poster).not.toContain('loading="lazy"');
      }
    }
    expect(html).toContain(kind === "library-video" ? 'poster="https://media.njpbs.org/cms-media/video/' : `src="${leadFixturePoster}"`);
  });

  it("removes an existing PBS autoplay flag and rebuilds pasted iframe fallback links", async () => {
    for (const url of ['https://player.pbs.org/partnerplayer/123456789/?autoplay=true',
      '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1"></iframe>']) {
      const fixture = postLeadFixture("standard", "embed");
      (fixture.document.published.metadata as any).leadMedia.data.url = url;
      const content = projectPublishedPostRead(fixture, String(fixture.document.published.metadata.slug), compiled.rendererSha, new Date("2026-10-07T13:00:00Z"))!;
      const html = await compiled.renderPublishedPost(content);
      expect(html).not.toContain("autoplay=true");
      expect(html).not.toContain("autoplay=1");
      expect(html).toMatch(/<noscript><a href="https:\/\/(?:player.pbs.org|www.youtube-nocookie.com)\//);
      expect(html).not.toContain('href="&lt;iframe');
    }
  });

  it("retains the shared pasted iframe aspect ratio while stripping autoplay", async () => {
    const fixture = postLeadFixture("standard", "embed");
    (fixture.document.published.metadata as any).leadMedia.data.url = '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1" width="640" height="480"></iframe>';
    const content = projectPublishedPostRead(fixture, String(fixture.document.published.metadata.slug), compiled.rendererSha, new Date("2026-10-07T13:00:00Z"))!;
    const html = await compiled.renderPublishedPost(content);
    expect(html).toContain('--embed-aspect-ratio:640 / 480');
    expect(html).not.toContain('autoplay=1');
  });

  it.each(LEAD_LAYOUTS)("keeps %s headers when a stored lead kind is unknown", async layout => {
    const html = await render(layout, "invalid");
    expect(html).toContain("Coastal voices: a New Jersey story");
    expect(html).not.toContain("data-post-lead-player");
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain('class="post-hero"');
  });

  it.each(["missing-image", "invalid", "none"])("keeps the Multimedia header and prose when its only media is %s", async state => {
    const fixture = postLeadFixture("multimedia", state === "invalid" ? "invalid" : "image");
    const metadata = fixture.document.published.metadata as Record<string, any>;
    if (state === "missing-image") metadata.leadMedia.data.assetId = "unavailable-image";
    if (state === "none") metadata.leadMedia = null;
    const prose: import("../../packages/content-core/src/content-model").PageBlock = { id: "prose", type: "prose", order: 0, visible: true,
      data: { content: { type: "doc", content: [{ type: "paragraph", content: [
        { type: "text", text: "The community story remains readable." },
      ] }] } } };
    Object.assign(fixture.document.published, { blocks: [prose] });
    const content = projectPublishedPostRead(fixture, metadata.slug, compiled.rendererSha, new Date("2026-10-07T13:00:00Z"))!;
    expect(content).toBeTruthy();
    const html = await compiled.renderPublishedPost(content);
    expect(html).toContain("Coastal voices: a New Jersey story");
    expect(html).toContain("The community story remains readable.");
    expect(html).toContain('data-post-presentation="multimedia"');
    expect(html).not.toContain("Media in this feature:");
    expect(html).not.toContain('class="multimedia-feature__lead-media"');
    expect(html).not.toContain("data-post-lead-player");
  });

  it.each(LEAD_LAYOUTS)("keeps the %s legacy image branch identical to the explicit image branch", async layout => {
    // Route slugs differ, so compare just the owned lead figure's semantic markup.
    const image = await render(layout, "image");
    const legacy = await render(layout, "legacy");
    const figure = (html: string) => html.match(/<figure class="(?:post-hero|[^\"]+__lead-media)"[^>]*>[\s\S]*?<\/figure>/)?.[0];
    expect(figure(image)).toBeTruthy();
    expect(figure(image)).toEqual(figure(legacy));
  });

  it("renders visual, mixed and text standard Posts without letting hidden media change the layout", async () => {
    for (const { layout, mediaVisible, categories, tags, eyebrow } of [
      { layout: "visual", mediaVisible: true, categories: ["Station news"], tags: ["Announcement"], eyebrow: "Station news Announcement" },
      { layout: "mixed", mediaVisible: true, categories: [], tags: ["Station news", "Announcement"], eyebrow: "Station news Announcement" },
      { layout: "text", mediaVisible: false, categories: [], tags: [], eyebrow: "NJ PBS" },
    ] as const) {
      const fixture = postLeadFixture("standard", "image");
      const published = fixture.document.published;
      const metadata = published.metadata as Record<string, unknown>;
      if (layout !== "visual") {
        delete metadata.leadMedia;
        delete metadata.heroImage;
      }
      metadata.categories = categories;
      metadata.tags = tags;
      published.blocks = [
        { id: "prose", type: "prose", order: 0, visible: true,
          data: { content: { type: "doc", content: [{ type: "paragraph", content: [
            { type: "text", text: "Public layout body." },
          ] }] } } },
        { id: "image", type: "image", order: 1, visible: mediaVisible,
          data: { assetId: "upload", alt: "Layout media" } },
      ] as typeof published.blocks;
      const content = projectPublishedPostRead(fixture, String(metadata.slug), compiled.rendererSha,
        new Date("2026-10-07T13:00:00Z"))!;
      const html = await compiled.renderPublishedPost(content);
      expect(html).toContain(`data-layout="${layout}"`);
      expect(html).toContain("Public layout body.");
      const eyebrowHtml = html.match(/<p\b[^>]*class="post-head__eyebrow"[^>]*>[\s\S]*?<\/p>/)?.[0];
      expect(eyebrowHtml?.replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ")).toBe(eyebrow);
      if (!mediaVisible) expect(html).not.toContain('alt="Layout media"');
    }
  });
});
