import { describe, expect, it } from "vitest";
import { LIVE_BLOG_SIDEBAR, splitLiveBlogBlocks } from "../../packages/content-core/src/live-blog-layout";
import { generatedHeadingLevelAt } from "../../packages/content-core/src/content-render";
import { renderContentGroups } from "../../packages/content-core/src/content-row-render";
import { projectPublishedPostRead } from "../src/lib/published-post-shadow";
import { LIVE_BLOG_POST_AS_OF, liveBlogPostFixture } from "./fixtures/live-blog-post";
import { parseBlocks, type RichTextDoc, type PageBlock } from "../../packages/content-core/src/content-model";

const proseContent = (text: string): RichTextDoc => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const project = (options = {}) => projectPublishedPostRead(liveBlogPostFixture(options), "live-blog-local", "a".repeat(40), new Date(LIVE_BLOG_POST_AS_OF))!;

describe("live blog sidebar publication and rendering boundary", () => {
  it("preserves explicit destinations through the immutable Post projection", () => {
    const post = project({ sidebar: true }).posts[0];
    const split = splitLiveBlogBlocks(post.blocks, Boolean(post.liveBlog));
    expect(split.body.map(block => block.id)).toEqual(["introduction"]);
    expect(split.sidebar.map(block => block.id)).toEqual(["sidebar-copy", "sidebar-actions"]);
    expect(split.sidebar.every(block => block.section === LIVE_BLOG_SIDEBAR)).toBe(true);
    expect(post.blocks.map(block => block.id)).toEqual(["introduction", "sidebar-copy", "sidebar-actions"]);
  });

  it("keeps ordinary Posts and unassigned live blogs in their existing body order", () => {
    for (const options of [{ before: true, sidebar: true }, {}]) {
      const post = project(options).posts[0];
      const split = splitLiveBlogBlocks(post.blocks, Boolean(post.liveBlog));
      expect(split.body).toEqual(post.blocks);
      expect(split.sidebar).toEqual([]);
    }
  });

  it("never infers sidebar content from an existing 8/4 row and keeps its grouping", () => {
    const blocks: PageBlock[] = [
      { id: "row", type: "row", visible: true, order: 0, data: { columns: [8, 4] } },
      { id: "intro", type: "prose", visible: true, order: 1, layout: { rowId: "row", column: 0 }, data: { content: proseContent("Introduction") } },
      { id: "context", type: "prose", visible: true, order: 2, layout: { rowId: "row", column: 1 }, data: { content: proseContent("Existing sidebar above updates") } },
      { id: "aside", type: "prose", visible: true, order: 3, section: LIVE_BLOG_SIDEBAR, data: { content: proseContent("Explicit sidebar") } },
    ];
    expect(parseBlocks(blocks).ok).toBe(true);
    const split = splitLiveBlogBlocks(blocks, true);
    expect(split.body).toEqual(blocks.slice(0, 3));
    const groups = renderContentGroups(split.body, block => ({ html: block.id }));
    expect(groups).toHaveLength(1);
    expect(groups[0].html).toContain("intro</div></div><div class=\"cms-row__column\"");
    expect(groups[0].html).toContain("context");
  });

  it("computes generated headings within each destination's reading order", () => {
    const blocks: PageBlock[] = [
      { id: "body-h2", type: "headline", order: 0, visible: true, data: { text: "Introduction", level: 2 } },
      { id: "side-h3", type: "headline", order: 1, visible: true, section: LIVE_BLOG_SIDEBAR, data: { text: "Context", level: 3 } },
      { id: "body-cards", type: "card_grid", order: 2, visible: true, data: { cards: [] } },
    ];
    const { body, sidebar } = splitLiveBlogBlocks(blocks, true);
    expect(generatedHeadingLevelAt(body, 1)).toBe(3);
    expect(generatedHeadingLevelAt(sidebar, 0)).toBe(2);
  });
});
