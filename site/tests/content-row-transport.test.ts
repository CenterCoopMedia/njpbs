// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { contentBlockHtml, renderContentGroups } from "../../packages/content-core/src/content-row-render";
import { visibleLayoutBlocks } from "../../packages/content-core/src/content-layout";
import { projectCmsPage } from "../src/lib/cms-loader";

const require = createRequire(import.meta.url);
const { parseBlocks: parseCjs } = require("../../functions/lib/content-blocks.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { createPreviewSnapshot, referencedPreviewAssetIds } = require("../../functions/lib/preview-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const { collectPublishedMediaUsage, collectWorkingMediaUsage } = require("../../functions/lib/media-usage.js");

function blocks(): PageBlock[] {
  return [
    { id: "row", type: "row", order: 0, visible: true, data: { columns: [4, 8] } },
    { id: "left", type: "prose", order: 1, visible: true, layout: { rowId: "row", column: 0 }, data: {
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Left <text>" }] }] },
    } },
    { id: "right", type: "cta_row", order: 2, visible: true, layout: { rowId: "row", column: 1 }, data: {
      ctas: [{ label: "Watch", href: "/watch/" }],
    } },
  ];
}

function document() {
  return { id: "contact", template: "genericPage", title: "Contact", description: "Contact NJ PBS", status: "draft", version: 4, blocks: blocks() };
}

describe("content row transport", () => {
  it("refuses a newsletter record card in a Kids saved preview", () => {
    const card = { id: "card", type: "record_card", order: 0, visible: true,
      data: { recordKind: "newsletter", recordId: "weekly" } };
    expect(() => createPreviewSnapshot("kids", { ...document(), id: "kids", template: "programLanding", blocks: [card] })).toThrow(/newsletter/i);
  });
  it("projects a published sponsor strip through the public endpoint", () => {
    const strip = { id: "sponsors", type: "sponsor_strip", order: 0, visible: true,
      data: { heading: "Supporters", sponsorIds: ["sponsor_1"], layout: "row" } };
    const doc = { ...document(), blocks: [strip] };
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc,
      publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "editor" });
    const result = projectPublicPageDocument({ pageId: "contact",
      document: { ...doc, publiclyVisible: true, published }, assets: new Map(),
      now: new Date("2026-09-05T13:00:00Z") });
    expect(result.state).toBe("live");
    expect(result.page.blocks[0].data).toEqual(strip.data);
  });
  it("projects a published newsletter signup through the public endpoint", () => {
    const signup = { id: "signup", type: "newsletter_signup", order: 0, visible: true,
      data: { newsletterIds: ["weekly"], heading: "Stay informed", intro: "Choose a list" } };
    const doc = { ...document(), blocks: [signup] };
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc,
      publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "editor" });
    const result = projectPublicPageDocument({ pageId: "contact",
      document: { ...doc, publiclyVisible: true, published }, assets: new Map(),
      now: new Date("2026-09-05T13:00:00Z") });
    expect(result.state).toBe("live");
    expect(result.page.blocks[0].data).toEqual(signup.data);
  });
  it("projects a published Page record card through the public endpoint", () => {
    const card = { id: "card", type: "record_card", order: 0, visible: true,
      data: { recordKind: "program", recordId: "program_1", variant: "compact" } };
    const doc = { ...document(), blocks: [card] };
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc,
      publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "editor" });
    const result = projectPublicPageDocument({ pageId: "contact",
      document: { ...doc, publiclyVisible: true, published }, assets: new Map(),
      now: new Date("2026-09-05T13:00:00Z") });
    expect(result.state).toBe("live");
    expect(result.page.blocks[0].data).toEqual(card.data);
  });

  it("keeps row children available to the Astro record card renderer", () => {
    const input = [
      { id: "row", type: "row", order: 0, visible: true, data: { columns: [12] } },
      { id: "card", type: "record_card", order: 1, visible: true,
        layout: { rowId: "row", column: 0 },
        data: { recordKind: "sponsor", recordId: "sponsor_1" } },
    ];
    const parsed = parseBlocks(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const groups = renderContentGroups(parsed.blocks, block => ({ html: renderBlock(block) }));
    expect(groups[0].columns?.[0]?.[0]?.block.type).toBe("record_card");
    expect(collectWorkingMediaUsage({
      collection: "cmsPages", document: { blocks: parsed.blocks },
    }).assetIds).toEqual([]);
  });
  it("keeps nested collection admission equal in TypeScript and Functions", () => {
    const images = Array.from({ length: 13 }, (_, index) => ({
      itemId: `image-${index}`,
      assetId: `asset-${index}`,
      alt: `Image ${index}`,
    }));
    const value = [{
      id: "gallery",
      type: "image_gallery",
      order: 0,
      visible: true,
      data: { images },
    }];

    expect(parseBlocks(value).ok).toBe(true);
    expect(parseCjs(value)).toEqual(parseBlocks(value));
  });

  it("admits the complete same row grammar in TypeScript and Functions", () => {
    const value = blocks();
    expect(parseBlocks(value)).toEqual({ ok: true, blocks: value });
    expect(parseCjs(value)).toEqual(parseBlocks(value));
    value[2].layout = { rowId: "missing", column: 1 };
    expect(parseBlocks(value).ok).toBe(false);
    expect(parseCjs(value)).toEqual(parseBlocks(value));
  });

  it("retains membership in detached publish and exact preview, without mutating drafts", () => {
    const doc = document();
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "editor" });
    const preview = createPreviewSnapshot("contact", doc);
    expect(preview.blocks).toEqual(doc.blocks);
    expect(published.blocks).toEqual(doc.blocks);
    doc.blocks[1].layout!.column = 1;
    expect(preview.blocks[1].layout.column).toBe(0);
    expect(published.blocks[1].layout.column).toBe(0);
    const saved = { ...doc, publiclyVisible: true, published };
    const now = new Date("2026-09-05T13:00:00Z");
    const built = projectCmsPage(saved, { mode: "published", now })!;
    const runtime = projectPublicPageDocument({ pageId: "contact", document: saved, assets: new Map(), now });
    expect(runtime.state).toBe("live");
    expect(runtime.page.blocks).toEqual(built.blocks);
    expect(built.blocks[1].layout?.column).toBe(0);
    expect(doc.status).toBe("draft");
  });

  it("keeps hidden row media in working usage but out of public and preview usage", () => {
    const value: PageBlock[] = [
      { ...blocks()[0], visible: false },
      { id: "image", type: "image", order: 1, visible: true, layout: { rowId: "row", column: 0 }, data: { assetId: "hidden-asset", alt: "Image" } },
    ];
    expect(referencedPreviewAssetIds({ id: "contact", blocks: value })).toEqual([]);
    expect(collectPublishedMediaUsage({ collection: "cmsPages", snapshot: { blocks: value } }).assetIds).toEqual([]);
    expect(collectWorkingMediaUsage({ collection: "cmsPages", document: { blocks: value } }).assetIds).toEqual(["hidden-asset"]);
    expect(visibleLayoutBlocks(value)).toEqual([]);
  });

  it("keeps grouping after the public projection removes a hidden child", () => {
    const doc = document();
    doc.blocks[1].visible = false;
    const published = createPublishedSnapshot({ collection: "cmsPages", document: doc, publishedAt: "2026-09-05T12:00:00.000Z", publishedBy: "editor" });
    const saved = { ...doc, publiclyVisible: true, published };
    const now = new Date("2026-09-05T13:00:00Z");
    const built = projectCmsPage(saved, { mode: "published", now })!;
    const runtime = projectPublicPageDocument({ pageId: "contact", document: saved, assets: new Map(), now });
    expect(runtime.page.blocks).toEqual(built.blocks);
    expect(built.blocks.map(block => block.order)).toEqual([0, 1]);
    expect(parseBlocks(built.blocks).ok).toBe(true);
    expect(built.blocks[1].layout).toEqual({ rowId: "row", column: 1 });
  });

  it("renders a row and each escaped child once, with an anchor inside a column", () => {
    const groups = renderContentGroups(blocks(), (block) => ({ html: renderBlock(block), id: block.id === "left" ? 'safe"anchor' : undefined }));
    const html = groups.map(contentBlockHtml).join("");
    expect(groups).toHaveLength(1);
    expect(html.match(/data-block-id=/g)).toHaveLength(3);
    expect(html.match(/class="cms-row__column"/g)).toHaveLength(2);
    expect(html).toContain("--cms-columns: minmax(0, 4fr) minmax(0, 8fr)");
    expect(html).toContain("Left &lt;text&gt;");
    expect(html).toContain('id="safe&quot;anchor"');
    expect(html.indexOf('data-block-id="left"')).toBeLessThan(html.indexOf('data-block-id="right"'));
  });

  it("renders an adapter's added-content subset without changing stored order", () => {
    const value = blocks().map(block => ({ ...block, order: block.order + 4 }));
    expect(renderContentGroups(value, block => ({ html: renderBlock(block) }))).toHaveLength(1);
    expect(value[0].order).toBe(4);
  });

  it("adds no wrappers to legacy content and keeps its original render callbacks", () => {
    const value = [{ ...blocks()[1], layout: undefined, order: 8 }];
    const groups = renderContentGroups(value, (block, index) => ({ html: `${index}:${renderBlock(block)}` }));
    expect(groups).toEqual([{ block: value[0], html: "0:<p>Left &lt;text&gt;</p>" }]);
  });
});
