// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import v1 from "./fixtures/home-composition-v1.json";
import fixture from "./fixtures/home-v2-selections.json";
import provider from "./fixtures/home-sources/newscast-documented-schema.json";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { createHomeNewscastBlock, homeNewscastTitle, renderHomeNewscast } from "../../packages/content-core/src/home-newscast-section";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
import { readHomeEditorialCatalog } from "../../packages/content-core/src/home-source-catalog";
import { resolvePublishedHomeNewscast } from "../../packages/content-core/src/home-newscast-published";
import { canPlaceBlock, SECTION_BLOCK_MAX } from "../../packages/content-core/src/editor-admin";
const require = createRequire(import.meta.url);
const cjsBlocks = require("../../functions/lib/content-blocks.js");
const cjsHome = require("../../functions/lib/home-composition-contract.js");
const cjsCatalog = require("../../functions/lib/home-source-catalog.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPreviewSnapshot } = require("../../functions/lib/preview-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const cutoffAt = "2026-10-11T19:00:00.000Z";
const source = () => adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
  checkedAt: cutoffAt, complete: true, response: provider }, cutoffAt);
const catalog = () => readHomeEditorialCatalog({ ...fixture.editorial.catalog, cutoffAt,
  services: { newsletters: { status: "error" }, newscast: source() } });
const section = () => createHomeNewscastBlock("saved-newscast");
const blocks = (value = section()) => [...structuredClone(v1.blocks), value].map((block, order) => ({ ...block, order })) as PageBlock[];

describe("one staff-arrangeable automatic Newscast section", () => {
  it.each(["feature", "compact"] as const)("shows an undated title without a date line in %s", layout => {
    const response = structuredClone(provider);
    response.data[0].attributes.title = "NJ PBS News with Rob Nelson";
    response.data[0].attributes.parent_tree.attributes.title = "NJ PBS News with Rob Nelson";
    const undated = adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager",
      requestUrl: HOME_NEWSCAST_ASSETS_URL, checkedAt: cutoffAt, complete: true, response }, cutoffAt);
    const block = createHomeNewscastBlock("undated-newscast");
    block.data.layout = layout;
    const context = { ...catalog(), services: { newsletters: { status: "error" as const }, newscast: undated } };
    expect(cjsCatalog.readHomeEditorialCatalog(context)).toEqual(context);
    const html = renderHomeNewscast(block, context);
    expect(html).toContain('<h3 class="home-newscast__title">NJ PBS News with Rob Nelson</h3>');
    expect(html).toContain('data-home-newscast-play');
    expect(html).not.toContain('<time');
  });

  it("preserves saved identity, order, copy and finite layout through actual preview/publish/public projection owners", () => {
    const value = section(); value.data.heading = "Our newscast"; value.data.summary = "Reviewed station copy"; value.data.layout = "compact";
    const doc = { ...v1, homeCompositionVersion: 2, blocks: blocks(value) };
    expect(homeCompositionError("home", 2, doc.blocks)).toBeNull();
    const preview = createPreviewSnapshot("home", doc);
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: cutoffAt, publishedBy: "fixture-editor" });
    const publicPage = projectPublicPageDocument({ pageId: "home", document: { ...doc, publiclyVisible: true, published }, assets: new Map(), now: new Date(cutoffAt) }).page;
    for (const saved of [preview, published, publicPage]) expect(saved.blocks.at(-1)).toEqual({ ...value, order: 7 });
    expect(canPlaceBlock("home", "home_newscast")).toBe(true);
    expect(SECTION_BLOCK_MAX.home.home_newscast).toBe(1);
    for (const page of ["genericPage", "post", "programLanding"] as const) expect(canPlaceBlock(page, "home_newscast")).toBe(false);
    value.visible = false;
    expect(homeCompositionError("home", 2, blocks(value))).toBeNull();
    expect(renderHomeNewscast(value, catalog())).toBe("");
    expect(value.data.showId).toBe("ad1f378e-9779-4ef1-a629-40a8a6f8f8d5");
  });
  it("renders both approved layouts from the same closed episode, with real episode date, escaped copy and approved actions", () => {
    for (const layout of ["feature", "compact"] as const) {
      const value = section(); value.data.layout = layout; value.data.heading = '<script>alert("x")</script>'; value.data.summary = "<b>Summary</b>";
      value.data.watchLabel = 'Watch "now"';
      const html = renderHomeNewscast(value, catalog());
      expect(html).toContain(`home-newscast--${layout}`);
      expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
      expect(html).toContain('href="https://watch.njpbs.org/video/nj-pbs-news-with-rob-nelson-october-9-2026-0oavxo/"');
      expect(html).toContain('href="https://watch.njpbs.org/show/nj-pbs-news-with-rob-nelson/"');
      expect(html).toContain('href="/live/"'); expect(html).toContain("Watch &quot;now&quot;</a>");
      expect(html).toContain('data-player-src="https://player.pbs.org/partnerplayer/3114511752/"');
      expect(html).toContain('<h3 class="home-newscast__title">NJ PBS News with Rob Nelson</h3>');
      expect(html).toContain('<time class="home-newscast__date" datetime="2026-10-09">Oct. 9, 2026</time>');
      expect(html).toContain('alt=""'); expect(html).not.toContain("<iframe");
    }
    const current = catalog();
    current.services!.newscast!.episode!.summary = '<script>alert("x")</script>';
    const html = renderHomeNewscast(section(), current);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain("<script>");
  });
  it("separates only the matching dated suffix and leaves editor titles intact", () => {
    // The dated title is observed PBS copy. The undated form is the same series
    // title; admitting undated episode packets remains separate work in #3519.
    const dated = "NJ PBS News with Rob Nelson | October 13, 2026";
    const undated = "NJ PBS News with Rob Nelson";
    expect(homeNewscastTitle(dated, "2026-10-13")).toBe(undated);
    expect(homeNewscastTitle(undated, "2026-10-13")).toBe(undated);
    expect(homeNewscastTitle(dated, "2026-10-12")).toBe(dated);
    const edited = "An editor's headline | Local reporting";
    expect(homeNewscastTitle(edited, "2026-10-13")).toBe(edited);
  });
  it("keeps heading and Past/Live actions when source is missing, unavailable or the frozen episode expires", () => {
    const available = catalog();
    const expiredAt = "2028-07-24T03:59:59Z";
    const expired = readHomeEditorialCatalog({ ...available, cutoffAt: expiredAt,
      services: { ...available.services, newscast: resolvePublishedHomeNewscast(source(), expiredAt) } });
    const error = readHomeEditorialCatalog({ ...available, services: { newsletters: { status: "error" },
      newscast: adaptLatestHomeNewscast({ status: "error" }, cutoffAt) } });
    for (const current of [undefined, error, expired]) {
      const html = renderHomeNewscast(section(), current);
      expect(html).toContain("Latest newscast</h2>"); expect(html).toContain("Past newscasts</a>"); expect(html).toContain("Watch live</a>");
      expect(html).not.toContain("<img"); expect(html).not.toContain("/video/"); expect(html).not.toContain("<iframe");
    }
    expect(renderHomeNewscast(section(), error)).toContain("temporarily unavailable");
    expect(renderHomeNewscast(section(), expired)).toContain("no longer available");
    const empty = readHomeEditorialCatalog({ ...available, services: { newsletters: { status: "error" },
      newscast: adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
        checkedAt: cutoffAt, complete: true, response: { data: [], links: { next: null } } }, cutoffAt) } });
    expect(renderHomeNewscast(section(), empty)).toContain("No newscast is available yet");
  });
  it("serves lazy, sized PBS posters without accepting arbitrary transform URLs", () => {
    // HEAD/GET of the actual October 13 poster confirmed these public transforms on October 14.
    const current = catalog();
    const url = "https://image.pbs.org/video-assets/YDZkz1z-asset-mezzanine-16x9-vEYn1aR.jpeg";
    current.services!.newscast!.episode!.poster.url = url;
    for (const layout of ["feature", "compact"] as const) {
      const value = section(); value.data.layout = layout;
      const html = renderHomeNewscast(value, current);
      expect(html).toContain(`src="${url}?format=webp&amp;resize=800x450"`);
      expect(html).toContain(`srcset="${url}?format=webp&amp;resize=400x225 400w, ${url}?format=webp&amp;resize=800x450 800w, ${url}?format=webp&amp;resize=1200x675 1200w"`);
      expect(html).toContain('width="1280" height="720" loading="lazy"');
      expect(html).toContain(layout === "compact" ? 'sizes="min(36rem,' : 'sizes="(max-width: 760px)');
    }
    for (const invalid of ["http://image.pbs.org/poster.jpeg", "https://image.pbs.org.evil.test/poster.jpeg",
      `https://fixture-user:fixture-password@${"image.pbs.org"}/poster.jpeg`, `${url}?private=token`, `${url}#fragment`,
      "https://image.pbs.org/unsafe\\poster.jpeg", "https://image.pbs.org/unsafe poster.jpeg"]) {
      current.services!.newscast!.episode!.poster.url = invalid;
      expect(() => renderHomeNewscast(section(), current)).toThrow();
    }
  });
  it("refuses malformed hidden/draft data, duplicate identity, wrong page/version and rows on both deployment grammars", () => {
    const original = section();
    for (const data of [{ ...original.data, showId: "other" }, { ...original.data, layout: "custom" },
      { ...original.data, heading: "x".repeat(121) }, { ...original.data, summary: "two\nparagraphs" },
      { ...original.data, watchLabel: "x".repeat(121) }, { ...original.data, videoHref: "https://private.example.test/" },
      { ...original.data, imageAssetId: "working-art" }]) {
      const candidate = { ...original, visible: false, data };
      expect(parseBlocks([candidate], { complete: false }).ok).toBe(false);
      expect(cjsBlocks.parseBlocks([candidate], { complete: false }).ok).toBe(false);
    }
    for (const version of [undefined, 1]) {
      expect(homeCompositionError("home", version, blocks())).toBeTruthy();
      expect(cjsHome.homeCompositionError("home", version, blocks())).toBeTruthy();
    }
    expect(homeCompositionError("about", undefined, blocks())).toBeTruthy();
    expect(cjsHome.homeCompositionError("about", undefined, blocks())).toBeTruthy();
    expect(homeCompositionError("home", 2, [...blocks(), { ...original, id: "duplicate", order: 8 }])).toBeTruthy();
    expect(cjsHome.homeCompositionError("home", 2, [...blocks(), { ...original, id: "duplicate", order: 8 }])).toBeTruthy();
    const inRow = blocks({ ...original, layout: { rowId: "row", column: 0 } });
    expect(homeCompositionError("home", 2, inRow)).toBeTruthy(); expect(cjsHome.homeCompositionError("home", 2, inRow)).toBeTruthy();
    expect(parseBlocks([{ ...original, section: undefined }], { complete: false }).ok).toBe(false);
    expect(cjsBlocks.parseBlocks([{ ...original, section: undefined }], { complete: false }).ok).toBe(false);
  });
  it("lets incomplete copy remain editable without publishing an invalid visible section or hiding saved recovery data", () => {
    const value = section(); value.data.heading = ""; value.data.watchLabel = "";
    expect(homeCompositionError("home", 2, blocks(value), { complete: false })).toBeNull();
    expect(renderHomeNewscast(value, catalog(), { complete: false })).toBe("");
    expect(() => renderHomeNewscast(value, catalog())).toThrow();
    expect(homeCompositionError("home", 2, blocks(value))).toBeTruthy();
    value.visible = false;
    expect(homeCompositionError("home", 2, blocks(value))).toBeNull();
    expect(renderHomeNewscast(value, catalog())).toBe("");
  });
});
