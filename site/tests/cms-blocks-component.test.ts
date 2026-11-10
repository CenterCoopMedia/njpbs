import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const component = readFileSync(
  join(process.cwd(), "src", "components", "CmsBlocks.astro"),
  "utf8",
);
const componentStyles = readFileSync(
  join(process.cwd(), "..", "packages", "content-core", "src", "component-blocks.css"),
  "utf8",
);
const postPage = readFileSync(
  join(process.cwd(), "src", "components", "PostPage.astro"),
  "utf8",
);
const postBlockList = readFileSync(
  join(process.cwd(), "src", "components", "PostBlockList.astro"),
  "utf8",
);
const publicStyles = readFileSync(
  join(process.cwd(), "src", "styles", "public-site.css"),
  "utf8",
);

describe("CMS block presentation", () => {
  it("does not query baked cards when a compiled Page supplies exact projected cards", () => {
    expect(component).toContain('Astro.locals.cmsRender ? [] : (await getCollection("cmsRecordCards"))');
    expect(component).toContain("renderRecordCards(Astro.locals.cmsRender, collectedCards)");
  });

  it("filters newsletter record cards from the Kids page, including row children", () => {
    expect(component).toContain('entry.data.pageId !== "kids" || card.kind !== "newsletter"');
    expect(component).toContain('<CmsBlockGroup group={item.group} cards={recordCards} />');
  });

  it("renders standard Post record cards, including cards in rows, through CmsBlockGroup", () => {
    expect(postPage).toContain('import CmsBlockGroup from "./CmsBlockGroup.astro"');
    expect(postPage).toContain('<CmsBlockGroup group={item.group} cards={recordCards} />');
    expect(postPage).not.toContain('set:html={item.group.html}');
    const group = readFileSync(join(process.cwd(), "src", "components", "CmsBlockGroup.astro"), "utf8");
    expect(group).toContain('<CmsBlockLeaf group={item} cards={cards} />');
  });

  it("uses Astro's responsive adapter for every CMS block image placement", () => {
    expect(component).toContain('import { getImage } from "astro:assets"');
    expect(component).toContain("resolveCmsResponsiveAssets");
    expect(component).toContain("responsiveImageKey(assetId, placement)");
  });

  it("derives generated heading rank from the assembled page outline", () => {
    expect(component).toContain("generatedHeadingLevelAt");
    expect(component).toMatch(
      /generatedHeadingLevel:\s*generatedHeadingLevelAt\(blocks,\s*index\)/,
    );
  });

  it("sizes YouTube frames on Pages and every Post presentation", () => {
    const frameRule = componentStyles.match(
      /\.cms-block \.embed__frame\s*\{([\s\S]*?)\}/,
    )?.[1];
    const iframeRule = componentStyles.match(
      /\.cms-block \.embed__frame iframe\s*\{([\s\S]*?)\}/,
    )?.[1];

    expect(frameRule).toContain("width: min(100%, var(--embed-max-width, 100%));");
    expect(frameRule).toContain("aspect-ratio: var(--embed-aspect-ratio, 16 / 9);");
    expect(iframeRule).toContain("width: 100%;");
    expect(iframeRule).toContain("height: 100%;");
    expect(componentStyles).toContain(
      ".cms-page__blocks > .cms-block .embed--video,\n  .cms-block .embed--video {",
    );
    expect(componentStyles).toContain(
      ".cms-page__blocks > .cms-block .embed__heading,\n  .cms-block .embed__heading {",
    );
    expect(componentStyles).not.toContain(
      ".cms-page__blocks > .cms-block .embed__frame",
    );
    expect(postPage).toContain('<CmsBlockGroup group={item.group} cards={recordCards} />');
    expect(postBlockList).toContain('<CmsBlockGroup group={item.group} cards={recordCards} />');
  });

  it("scrolls the carousel gallery sideways with no script and reachable by keyboard", () => {
    const carouselRule = publicStyles.match(
      /\.cms-block \.image-gallery--carousel\s*\{([\s\S]*?)\}/,
    )?.[1];
    expect(carouselRule).toBeDefined();
    expect(carouselRule).toContain("display: flex");
    expect(carouselRule).toContain("overflow-x: auto");
    expect(carouselRule).toMatch(/scroll-snap-type:\s*x\s+proximity/);
    // Two rules a later tidy-up would be tempted to drop, and the page scrolls sideways without
    // them: the row must size from the layout rather than from its figures, and it must be the
    // containing block for anything absolutely positioned inside it, or that content escapes the
    // clip and drags the document's scroll width with it. Both were found by measuring a built
    // page at 320 pixels and at 400% zoom (#1034).
    expect(carouselRule).toMatch(/container-type:\s*inline-size/);
    expect(carouselRule).toMatch(/position:\s*relative/);
    // The scroll container takes focus in the markup; it has to show that it has focus.
    expect(publicStyles).toMatch(
      /\.cms-block \.image-gallery--carousel:focus-visible\s*\{[\s\S]*?outline/,
    );
    // Each item is sized against the viewport, so one image still fits at 320 pixels and at
    // 400% zoom instead of a fixed width forcing the page itself to scroll.
    const itemRule = publicStyles.match(
      /\.cms-block \.image-gallery--carousel > figure\s*\{([\s\S]*?)\}/,
    )?.[1];
    expect(itemRule).toMatch(/flex:\s*0\s+0\s+min\(/);
    expect(itemRule).toMatch(/scroll-snap-align:\s*start/);
  });

  it("opens external rich-text links in a new tab in every Post presentation", () => {
    expect(postPage).toContain("externalLinksNewTab: true");
    expect(postBlockList).toContain("externalLinksNewTab: true");
    expect(component).not.toContain("externalLinksNewTab: true");
  });
});
