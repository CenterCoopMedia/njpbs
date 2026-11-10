import { beforeAll, describe, expect, it } from "vitest";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import CmsPage from "../src/components/CmsPage.astro";
import CmsBlocks from "../src/components/CmsBlocks.astro";
import PostPresentation from "../src/components/PostPresentation.astro";
import ReaderTextSize from "../src/components/ReaderTextSize.astro";
import { projectCmsPreviewContent } from "../src/lib/cms-preview-content";
import { projectCmsPost } from "../src/lib/cms-posts-projection";
import { now, fixture } from "../tests/fixtures/cms-preview-content";
import { LEAD_LAYOUTS } from "../tests/fixtures/post-lead-media";
import { readingPostFixture } from "../tests/fixtures/reader-text-size";

let container: Awaited<ReturnType<typeof AstroContainer.create>>;
beforeAll(async () => { container = await AstroContainer.create(); });
function expectPicker(html: string) {
  expect(html.match(/\bdata-reader-text-size-picker(?:\s|>)/g)).toHaveLength(1);
  expect(html).toContain("<legend>Text size</legend>");
  for (const label of ["Standard text size", "Large text size", "Largest text size"]) {
    expect(html).toContain(`aria-label="${label}"`);
  }
  expect(html).toMatch(/data-reader-text-size-picker[^>]*hidden/);
}

describe("reading controls in real public templates", () => {
  it.each(["/", "/kids/", "/kids", "/kids/activities/", "/Kids/", "/%6bids/activities/"])("omits the picker and direct preference module on %s", async path => {
    const request = new Request(`https://njpbs.org${path}`);
    const picker = await container.renderToString(ReaderTextSize, { request });
    expect(picker).not.toContain("data-reader-text-size-picker");
    expect(picker).not.toMatch(/src=["'][^"']*reader-text-size[.-]/);
  });

  it.each(LEAD_LAYOUTS)("renders one accessible picker in the %s Post", async layout => {
    const read = readingPostFixture(layout);
    const post = projectCmsPost(read.document, { now: new Date("2026-10-07T13:00:00Z"),
      assets: new Map(read.assets.map(asset => [asset.id, asset])) })!;
    const html = await container.renderToString(PostPresentation, {
      request: new Request(`https://njpbs.org${post.path}`),
      props: { entry: { id: post.postId, collection: "cmsPosts", data: post },
        credits: post.credits, canonicalUrl: `https://njpbs.org${post.path}` },
    });
    expectPicker(html);
    expect(html.indexOf("data-reader-text-size-picker")).toBeLessThan(html.indexOf('data-block-type="prose"'));
  });

  it("uses the same picker for a CMS Page and keeps the ordinary block renderer free of duplicates", async () => {
    const f = fixture();
    const page = projectCmsPreviewContent(f.bytes, f.request, now).pages[0];
    const entry = { id: page.pageId, collection: "cmsPages" as const, data: page };
    expectPicker(await container.renderToString(CmsPage, { request: new Request("https://njpbs.org/contact/"), props: { entry } }));
    expect(await container.renderToString(CmsBlocks, { request: new Request("https://njpbs.org/contact/"), props: { entry } })).not.toContain("data-reader-text-size-picker");
    expectPicker(await container.renderToString(CmsBlocks, { request: new Request("https://njpbs.org/contact/"), props: { entry, readerControls: true } }));
    expect(await container.renderToString(CmsBlocks, { request: new Request("https://njpbs.org/contact/"), props: { entry: { ...entry, data: { ...page, blocks: [] } }, readerControls: true } }))
      .not.toContain("data-reader-text-size-picker");
  });

  it("includes prose inside a visible row without record cards, and respects a hidden row", async () => {
    const f = fixture();
    const page = projectCmsPreviewContent(f.bytes, f.request, now).pages[0];
    const prose = page.blocks.find(block => block.type === "prose")!;
    const row = { id: "reader-row", type: "row" as const, order: 0, visible: true, data: { columns: [6, 6] } };
    const entry = { id: page.pageId, collection: "cmsPages" as const, data: { ...page,
      blocks: [row, { ...prose, order: 1, layout: { rowId: row.id, column: 0 } }] } };
    expectPicker(await container.renderToString(CmsBlocks, { request: new Request("https://njpbs.org/contact/"), props: { entry, readerControls: true } }));
    row.visible = false;
    expect(await container.renderToString(CmsBlocks, { request: new Request("https://njpbs.org/contact/"), props: { entry, readerControls: true } }))
      .not.toContain("data-reader-text-size-picker");
  });
});
