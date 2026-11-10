import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCustomShelf } from "../../packages/content-core/src/content-render";
import type { PromotionPlaylistBlock } from "../../packages/content-core/src/content-model";

const home = readFileSync(join(process.cwd(), "src/components/CinematicHomePage.astro"), "utf8");
const shelf: PromotionPlaylistBlock = {
  id: "local-shelf", type: "promotion_playlist", order: 0, visible: true,
  data: { title: "Local reporting", placement: "before_featured", cards: [{
    itemId: "story-one", title: "A local story", summary: "Reporting from New Jersey.",
    imageAssetId: "image-one", alt: "The town square", href: "/posts/local-story/",
  }] },
};
const options = { resolveAsset: () => ({ url: "/brand/story.jpg", width: 640, height: 360 }) };

describe("custom shelves", () => {
  it("renders a complete one-card shelf with its image, title, summary, and destination", () => {
    const html = renderCustomShelf(shelf, options);
    expect(html).toContain('href="/posts/local-story/"');
    expect(html).toContain('alt="The town square"');
    expect(html).toContain("A local story");
    expect(html).toContain("Reporting from New Jersey.");
    expect(html).toContain("custom-shelf--rail");
  });
  it.each(["rail", "grid", "list"] as const)("renders the %s layout without duplicate card content", presentation => {
    const html = renderCustomShelf({ ...shelf, data: { ...shelf.data, presentation, columns: 4 } }, options);
    expect(html).toContain(`custom-shelf--${presentation}`);
    expect(html).toContain("custom-shelf--columns-4");
    expect(html.match(/A local story/g)).toHaveLength(1);
    expect(html.includes("data-shelf-direction")).toBe(presentation === "rail");
  });
  it("keeps separate shelf controls and omits hidden or empty shelves", () => {
    expect(renderCustomShelf({ ...shelf, id: "second" }, options)).not.toContain('id="shelf-heading-local-shelf"');
    expect(renderCustomShelf({ ...shelf, visible: false }, options)).toBe("");
    expect(renderCustomShelf({ ...shelf, data: { ...shelf.data, cards: [] } }, options)).toBe("");
  });
  it("uses safe defaults for malformed layout values in unsaved preview data", () => {
    const data = { ...shelf.data, presentation: 'rail"><script>alert(1)</script>', columns: '3" onclick="alert(1)' };
    const html = renderCustomShelf({ ...shelf, data } as unknown as PromotionPlaylistBlock, options);
    expect(html).toContain("custom-shelf--rail custom-shelf--columns-3");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
  });
  it("keeps the five Home insertion positions and the default before Featured", () => {
    for (const position of ["before_start", "before_featured", "before_passport", "before_more", "before_spotlight"]) {
      expect(home).toContain(`promotions.filter(block => block.data.placement === "${position}")`);
    }
    expect(home.indexOf('block.data.placement === "before_featured"')).toBeLessThan(home.indexOf("<!-- Featured lineup -->"));
  });
});
