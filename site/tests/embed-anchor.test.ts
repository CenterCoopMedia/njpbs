import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { validateSection } from "../../packages/content-core/src/editor-admin";
import { newsletterSignupUrl } from "../../packages/content-core/src/launch-fallback";
const require = createRequire(import.meta.url);
const server = require("../../functions/lib/content-blocks.js");
const sections = require("../../functions/lib/editor-section-contract.js");
const fields = require("../../functions/lib/block-content-validation.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const block: PageBlock = { id: "signup", type: "embed_anchor", order: 0, visible: true, data: { anchorId: "njpbssignup" } };

describe("approved Page signup embeds", () => {
  it("saves, serializes and renders the empty parent-document anchor", () => {
    expect(parseBlocks([block])).toEqual({ ok: true, blocks: [block] });
    expect(server.parseBlocks([block])).toEqual(parseBlocks([block]));
    expect(validateSection("genericPage", [block])).toBeNull();
    expect(sections.validateSection("genericPage", [block])).toBeNull();
    expect(fields.blockContentError([block])).toBeNull();
    const pageId = `page-${"7".repeat(32)}`;
    const document = { id: pageId, template: "genericPage", slug: "newsletters", title: "Newsletters", description: "Updates",
      status: "published", publiclyVisible: true, publishAt: "2026-11-16T12:00:00Z", version: 6, blocks: [block] };
    const published = createPublishedSnapshot({ collection: "cmsPages", document,
      publishedAt: "2026-11-16T12:00:00Z", publishedBy: "fixture-editor" });
    const projected = projectPublicPageDocument({ pageId, document: { ...document, published }, assets: new Map(), now: new Date("2026-11-16T13:00:00Z") });
    expect(projected.state).toBe("live");
    expect(projected.page.blocks[0]).toEqual(block);
    const html = renderBlock(projected.page.blocks[0]);
    expect(html).toContain('id="njpbssignup"></div>');
    expect(html).toContain(`href="${newsletterSignupUrl}"`);
    for (const section of ["post", "home", "programLanding"] as const) {
      expect(validateSection(section, [block])).not.toBeNull();
      expect(sections.validateSection(section, [block])).not.toBeNull();
    }
  });

  it("uses the same escaped links as the native newsletter signup", () => {
    const signupNewsletterCards = [
      { title: "News & notes", signupUrl: "https://example.org/signup?q=1&f=2" },
      { title: "Unusable address", signupUrl: "javascript:void(0)" },
    ];
    const html = renderBlock(block, { signupNewsletterCards });
    expect(html).toContain('href="https://example.org/signup?q=1&amp;f=2"');
    expect(html).toContain("Sign up for News &amp; notes");
    expect(html).not.toContain("Unusable address");
    expect(html).not.toContain(newsletterSignupUrl);
  });

  it.each([{}, { anchorId: "other" }, { anchorId: 'njpbssignup"><script>' },
    { anchorId: "njpbssignup", html: "<script></script>" }, { anchorId: "njpbssignup", url: "https://example.org/" }])(
    "refuses arbitrary identifiers and HTML even on hidden drafts: %j", data => {
      const blocks = [{ ...block, visible: false, data }];
      expect(parseBlocks(blocks, { complete: false }).ok).toBe(false);
      expect(server.parseBlocks(blocks, { complete: false })).toEqual(parseBlocks(blocks, { complete: false }));
      expect(renderBlock({ ...blocks[0], visible: true } as PageBlock)).toBe("");
    });

  it("refuses duplicate anchor ids across visible and hidden rows", () => {
    for (const visible of [true, false]) {
      const blocks = [block, { id: "row", type: "row", order: 1, visible: true, data: { columns: [6, 6] } },
        { ...block, id: "second", order: 2, visible, layout: { rowId: "row", column: 1 } }];
      expect(parseBlocks(blocks)).toEqual({ ok: false, error: "blocks[2] repeats embed anchor njpbssignup" });
      expect(server.parseBlocks(blocks)).toEqual(parseBlocks(blocks));
    }
  });
});
