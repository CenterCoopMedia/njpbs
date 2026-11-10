// @vitest-environment node
// A topic shelf is placeable in a post (#1046), and PostPage renders blocks through the
// same renderBlock as the CMS pages -- but its own <style> block styles only prose, images
// and figures. So the shelf's card list has to be styled where BOTH renderers reach it, not
// in one component's scoped styles, or a published post shows the card row as a bulleted
// list with a bullet indent.
//
// This pins the sharing: the shelf rules live in the shared public stylesheet, keyed on the
// `.cms-block` wrapper both renderers emit, and neither component keeps a private copy.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const sharedStyles = read("../src/styles/public-site.css");
const postPage = read("../src/components/PostPage.astro");
const cmsBlocks = read("../src/components/CmsBlocks.astro");
const cmsBlockLeaf = read("../src/components/CmsBlockLeaf.astro");

const SHELF_RULES = [
  ".shelf-track",
  ".shelf-card",
  ".shelf-card__link",
  ".shelf-card__title",
  ".shelf-card__kicker",
  ".shelf-card__meta",
  ".shelf-empty",
];

describe("the dynamic shelves are styled wherever a block renderer puts them", () => {
  it("keeps every shelf rule in the shared public stylesheet", () => {
    for (const selector of SHELF_RULES) {
      expect(sharedStyles, `${selector} is missing from public-site.css`).toContain(
        selector,
      );
    }
  });

  it("keeps no private copy in either block renderer", () => {
    for (const [name, source] of [
      ["PostPage.astro", postPage],
      ["CmsBlocks.astro", cmsBlocks],
    ] as const) {
      const styles = source.slice(source.indexOf("<style>"));
      expect(styles, `${name} re-declares a shelf rule`).not.toContain(".shelf-card");
      expect(styles, `${name} re-declares a shelf rule`).not.toContain(".shelf-track");
    }
  });

  it("strips the list marker and the bullet indent the post body would otherwise apply", () => {
    const track = sharedStyles.slice(sharedStyles.indexOf(".shelf-track {"));
    const rule = track.slice(0, track.indexOf("}"));
    expect(rule).toContain("list-style: none");
    expect(rule).toContain("padding: 0");
  });

  it("gives the reset enough specificity to beat the post body's scoped list rule", () => {
    // Astro scopes component styles with an attribute selector, so PostPage's
    // `.post-body :global(ul)` ships as `.post-body[data-astro-cid-...] ul`: (0,2,1). A
    // two-class rule here would lose that contest and the card row would keep the post
    // body's bullet and indent -- the exact defect these shared rules exist to prevent.
    const selector = sharedStyles
      .split("\n")
      .find((line) => line.includes(".shelf-track {"));
    expect(selector).toBeDefined();
    const classCount = (selector?.match(/\.[a-z][a-z0-9_-]*/gi) ?? []).length;
    expect(classCount).toBeGreaterThanOrEqual(3);

    const imageSelector = sharedStyles
      .split("\n")
      .find((line) => line.includes(".shelf-card__media img"));
    expect((imageSelector?.match(/\.[a-z][a-z0-9_-]*/gi) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("renders the same shelf markup from the post path as from the page path", () => {
    const parsed = parseBlocks([
      {
        id: "b1",
        type: "topic_shelf",
        order: 0,
        visible: true,
        data: {
          title: "More on Delaney Hall",
          topic: "delaney-hall",
          source: "njpbs_related_index",
          itemLimit: 4,
          sort: "newest",
        },
      },
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    const html = renderBlock(parsed.blocks[0]);
    expect(html).toContain('class="shelf-track"');
    expect(html).toContain("shelf-card__title");
    // Both renderers wrap a block in the same hook the shared rules key on.
    expect(postPage).toContain("<CmsBlockGroup group={item.group} cards={recordCards} />");
    expect(cmsBlocks).toContain("CmsBlockGroup");
    expect(cmsBlockLeaf).toContain("cms-block cms-block--");
  });
});
