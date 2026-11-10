// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NJ_DECIDES_SOCIAL_IMAGES as images, selectSocialImage, njDecidesSocialVariant,
  resolveNjDecidesSocialImage } from "../src/lib/nj-decides-social-images";

const content = { title: "Election night", assets: { selected: { url: "https://media.njpbs.org/editor.png" } },
  heroImage: { url: "https://media.njpbs.org/hero.png" }, heroImageAlt: "Voters outside a polling place" };

describe("NJ Decides social image precedence", () => {
  it.each(["hub", "results", "post"] as const)("keeps the editor override ahead of the %s artwork", variant => {
    expect(selectSocialImage({ ...content, social: { imageAssetId: "selected", title: "Editor social title" } }, variant))
      .toEqual({ url: content.assets.selected.url, alt: "Editor social title" });
  });
  it("preserves the existing missing selected-asset behavior", () => {
    expect(selectSocialImage({ ...content, social: { imageAssetId: "missing" } }, "post")).toBeUndefined();
  });
  it.each(["hub", "results", "post"] as const)("uses the %s kit artwork ahead of an implicit hero", variant => {
    expect(selectSocialImage(content, variant)).toEqual(images[variant]);
  });
  it("keeps ordinary hero images and their alt text", () => {
    expect(selectSocialImage(content)).toEqual({ url: content.heroImage.url, alt: content.heroImageAlt });
    expect(selectSocialImage({ ...content, heroImage: null })).toBeUndefined();
  });
  it.each(Object.values(images))("ships $label as an actual 1200×630 PNG with descriptive alt text", image => {
    const png = readFileSync(new URL(`../public${image.url}`, import.meta.url));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(image.alt).toContain("NJ Decides 2026");
    expect(image.alt).toContain(image.label);
  });
});

describe("current-election scope", () => {
  const result = { id: "result", type: "election_results", order: 0, visible: true, data: {} };
  it.each(["/nj-decides/", "/nj-decides-2026/", "/nj-decides/voter-guide/"])("recognizes the hub Page path %s", path => {
    expect(njDecidesSocialVariant({ ...content, kind: "page", path })).toBe("hub");
  });
  it.each(["/nj-decides-2024/", "/nj-decides-2026-archive/", "/politics/", "/posts/nj-decides/"])(
    "does not infer current branding from the Page path %s", path => {
      expect(njDecidesSocialVariant({ ...content, kind: "page", path })).toBeUndefined();
    });
  it("keeps hub-root artwork even when the hub includes results", () => {
    expect(njDecidesSocialVariant({ ...content, kind: "page", path: "/nj-decides/", blocks: [result] })).toBe("hub");
  });
  it.each(["page", "post"] as const)("recognizes visible results on a %s and ignores hidden rows", kind => {
    expect(njDecidesSocialVariant({ ...content, kind, blocks: [result] })).toBe("results");
    expect(njDecidesSocialVariant({ ...content, kind, blocks: [{ ...result, visible: false }] })).toBeUndefined();
    expect(njDecidesSocialVariant({ ...content, kind, blocks: [
      { id: "row", type: "row", order: 0, visible: false, data: { columns: [12] } },
      { ...result, order: 1, layout: { rowId: "row", column: 0 } },
    ] })).toBeUndefined();
  });
  it.each(["NJ Decides 2026", "nj-decides-2026", " NJ_DECIDES_2026 "])("recognizes explicit current taxonomy %s", marker => {
    expect(njDecidesSocialVariant({ ...content, kind: "post", tags: [marker] })).toBe("post");
    expect(njDecidesSocialVariant({ ...content, kind: "post", categories: [marker] })).toBe("post");
  });
  it("recognizes the frozen live-blog brand without classifying unbranded live blogs", () => {
    expect(njDecidesSocialVariant({ ...content, kind: "post", liveBlog: { branding: "nj-decides-2026" } })).toBe("post");
    expect(njDecidesSocialVariant({ ...content, kind: "post", liveBlog: {} })).toBeUndefined();
  });
  it("keeps historical/generic election coverage on its existing hero", () => {
    const ordinary = { ...content, kind: "post" as const, categories: ["Elections", "Politics"], tags: ["NJ Decides", "NJ Decides 2024"] };
    expect(njDecidesSocialVariant(ordinary)).toBeUndefined();
    expect(resolveNjDecidesSocialImage(ordinary)?.url).toBe(content.heroImage.url);
  });
});
