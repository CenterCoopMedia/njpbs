import { chromeSettings, newsPageId } from "../tests/fixtures/shadow-posts/chrome";
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as pagefind from "pagefind";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { prose as fixture, video as videoFixture, videoUrl, spotlight, spotlightArchivePost, unlistedArchivePost, registeredAuthor, withdrawnAuthor, uploadedImages, uploadedAuthors, uploadedImageUrl } from "../tests/fixtures/shadow-posts/fixtures";
import { catalogFixtures, catalogReads } from "../tests/fixtures/shadow-posts/block-catalog";
import { postLeadFixture } from "../tests/fixtures/post-lead-media";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { archiveHtmlMetadata, comparePostHtml, postHtmlSemantics } from "../src/lib/post-html-comparison";
import { createFakePublishedPostReader } from "../src/lib/published-post-shadow";
import { createShadowPostWorker } from "../../workers/src/shadow-post-worker";
import { SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS, spotlightArchiveRedirectShard } from "../../packages/content-core/src/spotlight-archive-paths";

let compiled: { rendererSha: string; renderPublishedPost: (content: NonNullable<ReturnType<typeof projectPublishedPostRead>>) => Promise<string> };
beforeAll(async () => {
  compiled = await import(/* @vite-ignore */ pathToFileURL(resolve(".shadow-renderer/server/entry.mjs")).href);
});
const now = new Date("2026-10-07T13:00:00Z");

// Every editor Post block goes through the same published read the public
// Worker uses. Nothing is filtered or patched in before rendering.
function renderFixture(read: any) {
  return projectPublishedPostRead(read, read.document.published.metadata.slug, compiled.rendererSha, now)!;
}

describe("compiled shadow uses the static Post output", () => {
  it("emits the registered archive redirect endpoint as a static release asset", () => {
    for (const alias of spotlightArchivePost.document.published.metadata.archiveLegacyPaths) {
      const shard = spotlightArchiveRedirectShard(alias);
      const asset = resolve(`.shadow-static-fixtures${SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS}${shard}.json`);
      expect(JSON.parse(readFileSync(asset, "utf8"))).toMatchObject({ [alias]: "/posts/archived-transit/" });
    }
  });

  it("indexes only the public archive story with its original date and topics", async () => {
    const { index } = await pagefind.createIndex();
    if (!index) throw new Error("Pagefind index was not created");
    try {
      for (const read of [spotlightArchivePost, unlistedArchivePost]) {
        const slug = read.document.published.metadata.slug;
        const path = `/posts/${slug}/`;
        const html = readFileSync(resolve(`.shadow-static-fixtures${path}index.html`), "utf8");
        const shadowHtml = await compiled.renderPublishedPost(renderFixture(read));
        expect(comparePostHtml(html, shadowHtml)).toEqual([]);
        const metadata = archiveHtmlMetadata(shadowHtml);
        if (read === spotlightArchivePost) {
          expect(metadata).toMatchObject({
            title: "Archive transit coverage — NJ PBS",
            canonical: ["https://njpbs.org/posts/archived-transit/"],
            description: ["Original reporting on rail service."],
            publishedTime: ["2012-03-01T02:30:00Z"],
            articleTimes: ["2012-02-29"],
          });
          expect(metadata.structuredData).toContainEqual(expect.objectContaining({
            "@type": "NewsArticle", headline: "Historical transit reporting",
            description: "Original reporting on rail service.",
            url: "https://njpbs.org/posts/archived-transit/",
            datePublished: "2012-03-01T02:30:00Z",
          }));
        } else {
          expect(metadata.publishedTime).toEqual([]);
          expect(metadata.structuredData).not.toContainEqual(expect.objectContaining({ "@type": "NewsArticle" }));
        }
        await index.addHTMLFile({ url: path, content: html });
      }
      const output = await index.getFiles();
      expect(output.errors).toEqual([]);
      const fragments = output.files?.filter(file => file.path.includes("fragment/")).map(file => {
        const raw = gunzipSync(file.content).toString("utf8");
        return JSON.parse(raw.slice(raw.indexOf("{")));
      });
      expect(fragments).toHaveLength(1);
      expect(fragments?.[0]).toMatchObject({
        url: "/posts/archived-transit/", content: expect.stringContaining("Published body with a link"),
        meta: { archive: "NJ Spotlight News archive", archiveDate: "2012-02-29" },
        filters: { archive: ["NJ Spotlight News archive"], "archive-year": ["2012"],
          "archive-topic": expect.arrayContaining(["Transportation", "Rail"]) },
      });
    } finally {
      await index.deleteIndex();
      await pagefind.close();
    }
  });

  it("uses the original editorial day for an archive story without a source UTC time", async () => {
    const read = structuredClone(spotlightArchivePost);
    const { archivePublishedAt: _, ...metadata } = read.document.published.metadata;
    const html = await compiled.renderPublishedPost(renderFixture({
      ...read, document: { ...read.document, published: { ...read.document.published, metadata } },
    }));
    const observed = archiveHtmlMetadata(html);
    expect(observed.publishedTime).toEqual([]);
    expect(observed.structuredData).toContainEqual(expect.objectContaining({
      "@type": "NewsArticle", datePublished: "2012-02-29",
    }));
  });

  it("keeps the legacy guide and renders ordered, visible sections from the snapshot", async () => {
    const read = postLeadFixture("interactive", "image");
    const metadata = read.document.published.metadata as Record<string, unknown>;
    metadata.categories = ["Local reporting"];
    const guide = async () => (await compiled.renderPublishedPost(renderFixture(read)))
      .match(/<aside[^>]+aria-label="Interactive page guide"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
    const legacy = await guide();
    expect(legacy).toMatch(/On this page[\s\S]*Reporting sections[\s\S]*Categories/);

    const sections = [
      { id: "topics", visible: true },
      { id: "overview", visible: false },
      { id: "contents", visible: true },
    ];
    metadata.postSidebar = { enabled: true, sections };
    const custom = await guide();
    expect(custom).toMatch(/Categories[\s\S]*Reporting sections/);
    expect(custom).not.toContain("On this page");
    expect(custom).toContain('href="#report-first-chapter"');

    metadata.postSidebar = { enabled: false, sections };
    expect(await guide()).toBeUndefined();
    metadata.postSidebar = { enabled: true, sections: sections.map(section => ({ ...section, visible: false })) };
    expect(await guide()).toBeUndefined();
  });

  it.each([fixture, videoFixture, ...spotlight, registeredAuthor, withdrawnAuthor, ...uploadedImages, ...uploadedAuthors, ...catalogFixtures])("preserves full HTML semantics for $document.published.metadata.slug", async read => {
    const slug = read.document.published.metadata.slug;
    const staticHtml = readFileSync(resolve(`.shadow-static-fixtures/posts/${slug}/index.html`), "utf8");
    const input = renderFixture(read);
    const shadowHtml = await compiled.renderPublishedPost(input);
    expect(comparePostHtml(staticHtml, shadowHtml)).toEqual([]);
    const spotlightNews = "spotlightNews" in read.document.published.metadata && read.document.published.metadata.spotlightNews === true;
    for (const html of [staticHtml, shadowHtml]) {
      expect(html.includes('data-publication="nj-spotlight-news"')).toBe(spotlightNews);
    }
    expect(shadowHtml).toContain("A published fixture");
    expect(shadowHtml).not.toContain("Private working title");
    expect(shadowHtml).toMatch(/<!doctype html>/i);
    expect(shadowHtml).toContain(`href="https://njpbs.org/posts/${slug}/"`);
    expect(shadowHtml).not.toMatch(/firebase(?:app|js)|firestore\.googleapis|gstatic\.com\/firebase/i);
  });

  it.each(catalogFixtures)("keeps the shared block safety rules in both builds for $document.published.metadata.slug", async read => {
    const slug = read.document.published.metadata.slug;
    const htmls = [readFileSync(resolve(`.shadow-static-fixtures/posts/${slug}/index.html`), "utf8"),
      await compiled.renderPublishedPost(renderFixture(read))];
    for (const html of htmls) {
      // No raw author markup or unsafe link reaches the page from any block.
      expect(html).not.toContain("<script>document.body");
      expect(html).not.toContain('onerror="alert');
      expect(html).not.toMatch(/href="javascript:/);
      expect(html).not.toContain("Hidden row text.");
      expect(html).not.toContain("Hidden middle block.");
      if (read === catalogReads.html) {
        expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups"');
        expect(html).toContain('title="Election results widget"');
        expect(html).toContain("&lt;script&gt;document.body");
      }
      if (read === catalogReads.row || read === catalogReads.mixed) expect(html).toContain('class="cms-row"');
      if (read === catalogReads.row) {
        expect(html).toContain("--cms-columns: minmax(0, 8fr) minmax(0, 4fr)");
        expect(html).toContain("First of three.");
      }
      if (read === catalogReads.embed) {
        expect(html).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
        expect(html).toContain("Explore the statewide map");
      }
      if (read === catalogReads.bio_card) {
        expect(html).toContain("Ada Example");
        expect(html).toContain("NJ Transit");
        expect(html).toContain("https://media.njpbs.org/cms-media/news/portrait/hash.webp");
      }
      if (read === catalogReads.cta_row) expect(html).toContain("Watch live");
      if (read === catalogReads.data_table) expect(html).toContain("State aid by year");
      if (read === catalogReads.divider) expect(html).toContain("<hr");
      if (read === catalogReads.topic_shelf) expect(html).toContain("More on the budget");
      if (read === catalogReads.promotion_playlist) expect(html).toContain("custom-shelf--grid");
      if (read === catalogReads.image_gallery) expect(html).toContain("Morning rush");
      if (read === catalogReads.scroll_story) {
        expect(html).toMatch(/<ol class="scroll-story">.*Commuters arrive.*alt="Commuters waiting for a train".*The train departs.*The station quiets down.*alt="A passenger at the station"/s);
      }
      if (read === catalogReads.link_card) expect(html).toContain("Budget hearing schedule");
    }
  });

  it.each(uploadedAuthors)("keeps current author names or strict frozen fallback with uploaded media for $document.published.metadata.slug", async read => {
    const slug = read.document.published.metadata.slug;
    const htmls = [readFileSync(resolve(`.shadow-static-fixtures/posts/${slug}/index.html`), "utf8"),
      await compiled.renderPublishedPost(renderFixture(read))];
    for (const html of htmls) {
      expect(html).toContain(read.authors.length ? "Ada Reporter" : "Ada when published");
      expect(html).toContain("Guest writer");
      expect(html).toContain("Current &lt;photographer&gt; &amp; NJ PBS");
      expect(html).toContain("Frozen lead caption");
      expect(html).toContain("Frozen body caption");
      expect(html).not.toContain("Private draft caption");
    }
  });

  it.each(uploadedImages)("keeps lead/body originals, dimensions, captions and current credit in both builds for $document.published.metadata.slug", async read => {
    const slug = read.document.published.metadata.slug;
    const htmls = [readFileSync(resolve(`.shadow-static-fixtures/posts/${slug}/index.html`), "utf8"),
      await compiled.renderPublishedPost(renderFixture(read))];
    for (const html of htmls) {
      expect(html).toContain(`src="${uploadedImageUrl}"`);
      expect(html).toContain('width="1600"');
      expect(html).toContain('height="900"');
      expect(html).toContain('alt="Residents on the platform"');
      expect(html).toContain('alt="Contextual body alt"');
      expect(html).toContain("Frozen lead caption");
      expect(html).toContain("Frozen body caption");
      expect(html).not.toContain("Private draft caption");
      expect(html).not.toContain('srcset=');
      expect(html).toContain(`content="${uploadedImageUrl}"`);
      const currentCredit = slug.endsWith("-current");
      expect(html.includes("Current &lt;photographer&gt; &amp; NJ PBS")).toBe(currentCredit);
      expect(html.includes('class="cms-image-credit"')).toBe(currentCredit);
      expect(html.includes('class="post-image-credit"')).toBe(currentCredit);
      if (currentCredit) expect(html).not.toMatch(/<figure aria-hidden="true">/);
      if (!slug.includes("-standard-")) expect(html).toContain(`data-post-presentation="${slug.split("uploaded-")[1].replace(/-(legacy|current|cleared)$/, "")}"`);
    }
  });

  it("refreshes published chrome through one compiled renderer without rebuilding or changing the Post", async () => {
    const read = { ...structuredClone(fixture), settings: chromeSettings(),
      navigationPages: [{ pageId: newsPageId, path: "/in-the-news/" }] };
    const reader = createFakePublishedPostReader({ "shadow-fixture": read });
    const entries = new Map<string, Response>();
    const worker = createShadowPostWorker({ reader, render: compiled.renderPublishedPost,
      rendererSha: compiled.rendererSha, now: () => now,
      cache: { async match(key) { return entries.get(key.url)?.clone(); },
        async put(key, response) { entries.set(key.url, response.clone()); } } });
    const get = () => worker.fetch(new Request("https://dev-public.example.org/posts/shadow-fixture/"), {
      SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-fixture",
    });
    const first = await get();
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(postHtmlSemantics(html).links).toEqual(expect.arrayContaining([
      "/staff/|Staff", "/in-the-news/|In the news", "/in-the-news/|News page",
      "https://njpbs.bluelena.io/f/1|Newsletter (opens in new tab)",
    ]));
    expect(html).not.toContain("Subscribe to the newsletter");
    reader.set("shadow-fixture", { ...read, settings: chromeSettings("Station newsletter"), navigationPages: [] });
    const second = await get();
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Njpbs-Source-Version")).toBe(first.headers.get("X-Njpbs-Source-Version"));
    expect(second.headers.get("X-Njpbs-Input-Sha256")).not.toBe(first.headers.get("X-Njpbs-Input-Sha256"));
    const updated = await second.text();
    expect(updated).toContain("Station newsletter");
    expect(updated).not.toContain('href="/in-the-news/"');
    expect(updated).toContain("A published fixture");
  });

  it("keeps the actual video response free of SDKs and trackers", async () => {
    const reader = createFakePublishedPostReader({ "shadow-video": videoFixture });
    const worker = createShadowPostWorker({ reader, render: compiled.renderPublishedPost,
      rendererSha: compiled.rendererSha, now: () => now,
      cache: { async match() { return undefined; }, async put() {} } });
    const response = await worker.fetch(new Request("https://dev-public.example.org/posts/shadow-video/"), {
      SHADOW_POSTS_ENABLED: "true", SHADOW_POST_SLUGS: "shadow-video",
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<video");
    expect(html).toContain(videoUrl);
    // Same exclusions as analytics-consent-dist.test.ts, plus the public SDK ban.
    expect(html).not.toMatch(/data-analytics-consent|googletagmanager\.com|chimpstatic\.com|window\.gtag\("consent"|firebase(?:app|js)|firestore\.googleapis/i);
  });

  it("rejects private-preview input at the compiled entry", async () => {
    const input = projectPublishedPostRead(fixture, "shadow-fixture", compiled.rendererSha, now)!;
    await expect(compiled.renderPublishedPost({ ...input, kind: "private-preview" } as never)).rejects.toThrow();
  });
});
