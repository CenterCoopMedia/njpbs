// Contract: every block type the editor can place in a Post has a complete
// build-free path. This fails when the Post catalog gains a type that the
// acceptance rule, the public reader projection, the Worker read or the shared
// renderer does not handle, and when a type outside the catalog slips through.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { BLOCK_LABELS, SECTION_BLOCK_CATALOG } from "../../packages/content-core/src/editor-admin";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { catalogReads, figureProjection } from "./fixtures/shadow-posts/block-catalog";
import { prose, video, uploadedImages } from "./fixtures/shadow-posts/fixtures";

const require = createRequire(import.meta.url);
const { instantBlockAllowed } = require("../../functions/lib/joined-records.js");
const { unsupportedSnapshotReason } = require("../../functions/lib/no-build-post-publication.js");
const { selectedBlock } = require("../../functions/lib/public-content-projection.js");
const { parseBlocks } = require("../../functions/lib/content-blocks.js");
const { visibleLayoutBlocks } = require("../../functions/lib/content-layout.js");
const { SECTION_BLOCK_CATALOG: cjsCatalog } = require("../../functions/lib/editor-section-contract.js");

const now = new Date("2026-10-07T13:00:00Z");
const rendererSha = "a".repeat(40);
type ExampleBlock = { type: string; data: Record<string, unknown> };
const blocksOf = (read: { document: { published: { blocks: readonly object[] } } }) =>
  read.document.published.blocks as readonly ExampleBlock[];
const image = blocksOf(uploadedImages[0]).find(block => block.type === "image")!;
const joined = {
  record_card: { id: "card", type: "record_card", visible: true, order: 0, data: { recordKind: "program", recordId: "prog-one" } },
  sponsor_strip: { id: "sponsors", type: "sponsor_strip", visible: true, order: 0, data: { heading: "Sponsors", sponsorIds: ["sponsor-one"], layout: "row" } },
  newsletter_signup: { id: "signup", type: "newsletter_signup", visible: true, order: 0, data: { newsletterIds: ["news-one"], heading: "Sign up", intro: "Weekly." } },
};
// One complete example block per type, taken from the fixture Posts.
const exampleByType: Record<string, ExampleBlock> = { ...joined,
  prose: blocksOf(prose)[0], video: blocksOf(video)[1], image };
for (const [key, read] of Object.entries(catalogReads)) {
  if (key === "mixed") continue;
  exampleByType[key] = blocksOf(read).find(block => block.type === key)!;
}
const renderOptions = { allowBios: true, showImageCredits: true, externalLinksNewTab: true,
  resolveAsset: () => null, resolveNewsletter: () => null, sponsors: [], resolveDataFigure: () => figureProjection };

describe("every editor Post block type publishes build-free", () => {
  it("covers the complete Post catalog with one example per type", () => {
    expect(cjsCatalog.post).toEqual(SECTION_BLOCK_CATALOG.post);
    expect(Object.keys(exampleByType).sort()).toEqual([...SECTION_BLOCK_CATALOG.post].sort());
  });

  it.each([...SECTION_BLOCK_CATALOG.post])("accepts, projects and renders a %s block", type => {
    const block = { ...exampleByType[type], order: 0 };
    const parsed = parseBlocks([block], { complete: true });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(instantBlockAllowed(type)).toBe(true);
    const snapshot = { published: { sourceVersion: 1, metadata: { type: "post", slug: `catalog-${type.replace(/_/g, "-")}` }, blocks: [block] } };
    expect(unsupportedSnapshotReason(snapshot)).toBeNull();
    const selected = selectedBlock(visibleLayoutBlocks(parsed.blocks)[0]);
    expect(selected.type).toBe(type);
    expect(typeof renderBlock(selected as never, renderOptions as never)).toBe("string");
  });

  it.each(Object.entries(catalogReads))("reads the %s fixture through the public Worker projection", (_key, read) => {
    const slug = read.document.published.metadata.slug;
    const content = projectPublishedPostRead(read, slug, rendererSha, now)!;
    const visible = visibleLayoutBlocks(read.document.published.blocks).map((block: { id: string }) => block.id);
    expect(content.posts[0].blocks.map(block => block.id)).toEqual(visible);
  });

  it("drops hidden rows with their children and keeps row order", () => {
    const content = projectPublishedPostRead(catalogReads.row, "catalog-row", rendererSha, now)!;
    expect(content.posts[0].blocks.map(block => block.id)).toEqual([
      "lead", "row-one", "row-one-text", "row-one-image", "row-two", "row-two-a", "row-two-c", "tail"]);
  });

  // Complete data for every known type outside the Post catalog, so the refusal
  // under test is the catalog rule and not a data validation failure.
  const paragraph = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Answer." }] }] };
  const outsideData: Record<string, object> = {
    county_comparison: { datasetVersion: "nj-federal-counties-2020-2024-v1", heading: "", intro: "", source: "" },
    town_lookup: { heading: "Past results", introduction: "", sourceLine: "NJ Spotlight News" },
    data_hub_section: { sectionId: "unemployment", heading: "", introduction: "" },
    headline: { text: "A heading" },
    card_grid: { cards: [{ title: "A card" }] },
    document_list: { documents: [] },
    faq_item: { question: "A question?", answer: paragraph },
    coverage_list: { entries: [] },
    content_shelf: { title: "Shelf", source: "spotlight_news", itemLimit: 4, moreLabel: "More", moreHref: "/news/" },
    video_playlist: { title: "Videos", topic: "budget", library: "njpbs_watch", itemLimit: 4, sort: "newest" },
    home_newscast: { showId: "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5", heading: "Newscast", summary: "", layout: "feature",
      watchLabel: "Watch latest", pastLabel: "Past newscasts", liveLabel: "Watch live" },
  };
  it("lists complete data for every known type outside the Post catalog", () => {
    expect(Object.keys(outsideData).sort()).toEqual(Object.keys(BLOCK_LABELS).filter(type => !SECTION_BLOCK_CATALOG.post.includes(type as never)).sort());
  });
  it.each(Object.keys(outsideData))("refuses a %s block by name at acceptance and in the Worker", type => {
      const block = { id: "outside", type, visible: true, order: 1, data: outsideData[type],
        ...(type === "home_newscast" ? { section: "home-newscast" } : {}) };
      expect(parseBlocks([{ ...block, order: 0 }], { complete: true }).ok).toBe(true);
      expect(instantBlockAllowed(type)).toBe(false);
      expect(unsupportedSnapshotReason({ published: { sourceVersion: 1, metadata: { type: "post", slug: "outside" }, blocks: [block] } }))
        .toContain(`${type.replace(/_/g, " ")} block, which Posts cannot publish`);
      const read = structuredClone(prose) as { document: { published: { blocks: object[] } } };
      read.document.published.blocks.push(block);
      expect(() => projectPublishedPostRead(read, "shadow-fixture", rendererSha, now)).toThrow(`Post block type ${type} is outside the Post template`);
    });
});
