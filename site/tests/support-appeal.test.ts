import { describe, expect, it } from "vitest";
import { parseBlocks, type SupportAppealData } from "../../packages/content-core/src/content-model";
import { canPlaceAnotherBlock, canPlaceBlock, validateSection } from "../../packages/content-core/src/editor-admin";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { renderContentGroups } from "../../packages/content-core/src/content-row-render";
import { visibleLayoutBlocks } from "../../packages/content-core/src/content-layout";
import { createRequire } from "node:module";
import { postAssetIds } from "../src/lib/cms-posts-projection";
import { cmsResponsiveImageRequests } from "../src/lib/cms-responsive-image";

const require = createRequire(import.meta.url);
const { parseBlocks: parseStoredBlocks } = require("../../functions/lib/content-blocks.js");
const { capturePost } = require("../../functions/lib/post-templates.js");
const { collectWorkingMediaUsage } = require("../../functions/lib/media-usage.js");

// Issue #5079's authored shape, independent of the factory's default data.
const data: SupportAppealData = {
  heading: "Support local stories",
  copy: "Help keep New Jersey informed.",
  buttonLabel: "Donate",
  href: "/support/",
  style: "blue",
};
const appeal = (patch: Record<string, unknown> = {}) => ({
  id: "appeal", type: "support_appeal" as const, order: 1, visible: true, data: { ...data, ...patch },
});

describe("Post support appeal contract", () => {
  it.each(["blue", "light", "dark"])("round-trips %s through stored JSON and renders one real Donate link", style => {
    const parsed = parseBlocks(JSON.parse(JSON.stringify([appeal({ style })])));
    expect(parsed.ok).toBe(true);
    expect(parseStoredBlocks([appeal({ style })])).toEqual(parsed);
    if (!parsed.ok) throw new Error(parsed.error);
    const root = document.createElement("div");
    root.innerHTML = renderBlock(parsed.blocks[0], { generatedHeadingLevel: 3 })!;
    const region = root.querySelector("section")!;
    expect(region.classList.contains(`support-appeal--${style}`)).toBe(true);
    expect(root.querySelector("h3")?.textContent).toBe("Support local stories");
    expect(region.getAttribute("aria-labelledby")).toBe(root.querySelector("h3")?.id);
    expect(root.querySelector("p")?.textContent).toBe("Help keep New Jersey informed.");
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.querySelector("a")?.getAttribute("href")).toBe("/support/");
    expect(root.querySelector("a")?.textContent).toBe("Donate");
    expect(renderContentGroups(visibleLayoutBlocks([{ ...parsed.blocks[0], visible: false }]), block => ({ html: renderBlock(block)! }))).toEqual([]);
  });

  it.each([
    { style: "#ff00aa" }, { style: "green" }, { backgroundImageAssetId: "../private" },
    { heading: " " }, { copy: "" }, { buttonLabel: "" },
    { heading: "x".repeat(121) }, { copy: "x".repeat(2001) }, { buttonLabel: "x".repeat(61) },
    { href: "javascript:alert(1)" }, { href: "//example.org" }, { href: "" },
  ])("refuses invalid published appeal data: %o", patch => {
    expect(parseBlocks([appeal(patch)]).ok).toBe(false);
    expect(parseStoredBlocks([appeal(patch)])).toEqual(parseBlocks([appeal(patch)]));
  });

  it("allows unfinished draft text while retaining link and palette safety", () => {
    expect(parseBlocks([appeal({ heading: "", copy: "", buttonLabel: "", href: "" })], { complete: false }).ok).toBe(true);
    expect(parseBlocks([appeal({ href: "javascript:alert(1)" })], { complete: false }).ok).toBe(false);
    expect(parseBlocks([appeal({ style: "pink" })], { complete: false }).ok).toBe(false);
  });

  it("escapes staff text and follows the Post's external-link behavior", () => {
    const parsed = parseBlocks([appeal({ heading: '<img src=x onerror="alert(1)">', copy: "<b>Help</b>",
      buttonLabel: "Give & support", href: "https://example.org/donate?a=1&b=2" })]);
    if (!parsed.ok) throw new Error(parsed.error);
    const root = document.createElement("div");
    root.innerHTML = renderBlock(parsed.blocks[0], { externalLinksNewTab: true })!;
    expect(root.querySelector("img, b")).toBeNull();
    expect(root.querySelector("h2")?.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.org/donate?a=1&b=2");
    expect(root.querySelector("a")?.getAttribute("target")).toBe("_blank");
    expect(root.querySelector("a")?.getAttribute("rel")).toBe("noopener");
  });

  it("permits staff to place only one appeal, on a Post", () => {
    const blocks = [appeal()];
    expect(canPlaceAnotherBlock("post", [], "support_appeal")).toBe(true);
    expect(canPlaceAnotherBlock("post", blocks, "support_appeal")).toBe(false);
    expect(validateSection("post", [...blocks, { ...appeal(), id: "duplicate", order: 2 }])).not.toBeNull();
    for (const section of ["home", "genericPage", "programLanding"] as const) {
      expect(canPlaceBlock(section, "support_appeal")).toBe(false);
    }
  });

  it("preserves the appeal in a content template and leaves editable slots in a layout template", () => {
    const post = { type: "post", tags: [], blocks: [appeal()] };
    expect(capturePost(post, "content").blocks[0].data).toEqual(data);
    const layout = capturePost(post, "layout");
    expect(layout.blocks[0].data).toEqual({ style: "blue", heading: "", copy: "", buttonLabel: "", href: "" });
    expect(parseBlocks(layout.blocks, { complete: false }).ok).toBe(true);
  });

  it("carries an optional media-library image through asset discovery and decorative rendering", () => {
    const parsed = parseBlocks([appeal({ backgroundImageAssetId: "appeal-photo" })]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parseStoredBlocks(parsed.blocks)).toEqual(parsed);
    expect(postAssetIds({}, parsed.blocks)).toEqual(["appeal-photo"]);
    expect(collectWorkingMediaUsage({ collection: "cmsPosts", document: { type: "post", blocks: parsed.blocks } }).assetIds).toEqual(["appeal-photo"]);
    expect(cmsResponsiveImageRequests(parsed.blocks)).toEqual([{ assetId: "appeal-photo", placement: "grid" }]);
    const root = document.createElement("div");
    root.innerHTML = renderBlock(parsed.blocks[0], { resolveAsset: () => ({ url: "https://media.njpbs.org/cms-media/photo.jpg", width: 1024, height: 576 }) });
    expect(root.querySelector(".support-appeal__image")?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(root.querySelector("img")?.getAttribute("src")).toBe("https://media.njpbs.org/cms-media/photo.jpg");
    expect(capturePost({ type: "post", tags: [], blocks: parsed.blocks }, "content").blocks[0].data.backgroundImageAssetId).toBe("appeal-photo");
    expect(capturePost({ type: "post", tags: [], blocks: parsed.blocks }, "layout").blocks[0].data).not.toHaveProperty("backgroundImageAssetId");
  });
});
