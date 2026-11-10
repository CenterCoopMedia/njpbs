import { describe, expect, it } from "vitest";
import refusal from "../../functions/lib/build-free-refusal.js";
import { SECTION_BLOCK_CATALOG } from "../../functions/lib/editor-section-contract.js";

const block = (type, extra = {}) => ({ id: `${type}-${extra.order ?? 0}`, type, order: extra.order ?? 0, visible: true, data: {}, ...extra });

describe("build-free refusal wording", () => {
  it("names the first visible block outside the Post catalog with the publication owner's wording", () => {
    // embed and divider now publish (#3416); Page-only blocks still cannot.
    const document = { blocks: [block("prose"), block("headline", { order: 1 }), block("card_grid", { order: 2 }),
      block("headline", { order: 3 }), block("image", { order: 4 })] };
    expect(refusal.unsupportedBlockTypes(document)).toEqual(["headline", "card_grid"]);
    expect(refusal.buildFreeRefusalMessage({ collection: "cmsPosts", document })).toBe(
      "This Post has a headline block, which Posts cannot publish. Remove or hide it, then publish again.");
    expect(refusal.buildFreeRefusalMessage({ collection: "cmsPosts", document: { blocks: [block("card_grid")] } })).toBe(
      "This Post has a card grid block, which Posts cannot publish. Remove or hide it, then publish again.");
  });
  it("finds no unsupported type in the full Post catalog", () => {
    expect(refusal.unsupportedBlockTypes({ blocks: SECTION_BLOCK_CATALOG.post.map((type, order) => block(type, { order })) })).toEqual([]);
  });
  it("ignores hidden blocks and the content of a hidden row", () => {
    const document = { blocks: [block("card_grid", { visible: false }),
      block("row", { order: 1, visible: false, data: { columns: [{}] } }),
      block("headline", { order: 2, layout: { rowId: "row-1", column: 0 } }), block("prose", { order: 3 })] };
    expect(refusal.unsupportedBlockTypes(document)).toEqual([]);
    expect(refusal.buildFreeRefusalMessage({ collection: "cmsPosts", document })).toBe(
      "This Post has no build-free publication path. The full-site build was retired on October 13, 2026. Ask an administrator.");
  });
  it("skips malformed block entries instead of throwing before validation runs", () => {
    const document = { blocks: [null, "prose", 7, { visible: true }, block("card_grid")] };
    expect(refusal.unsupportedBlockTypes(document)).toEqual(["card_grid"]);
    expect(refusal.unsupportedBlockTypes({ blocks: [null] })).toEqual([]);
  });
  it("reads the draft blocks before an older published snapshot", () => {
    const document = { blocks: [block("prose")], published: { blocks: [block("card_grid")] } };
    expect(refusal.unsupportedBlockTypes(document)).toEqual([]);
    expect(refusal.unsupportedBlockTypes({ published: { blocks: [block("card_grid")] } })).toEqual(["card_grid"]);
  });
  it("prefers the reason the publication owner recorded", () => {
    expect(refusal.buildFreeRefusalMessage({ collection: "cmsPosts", document: { blocks: [block("card_grid")] },
      fallbackReason: "This Post is copied into a legacy Home card. Change that Home card to a Home source selection, then publish this Post again." })).toBe(
      "This Post is copied into a legacy Home card. Change that Home card to a Home source selection, then publish this Post again.");
  });
  it("tells staff how to withdraw a Page the new publisher never owned", () => {
    expect(refusal.buildFreeRefusalMessage({ collection: "cmsPages", document: {}, withdrawal: true })).toBe(
      "This Page was last published by the retired full-site build, so the new publisher does not own its address yet. Publish it once, then unpublish it.");
    expect(refusal.buildFreeRefusalMessage({ collection: "cmsPages", document: {} })).toBe(
      "This Page has no build-free publication path. The full-site build was retired on October 13, 2026. Ask an administrator.");
  });
  it("names a Post removal that has no build-free path", () => {
    expect(refusal.buildFreeRefusalMessage({ collection: "cmsPosts", document: { blocks: [block("embed")] }, withdrawal: true })).toBe(
      "This Post's public removal has no build-free path. The full-site build was retired on October 13, 2026. Ask an administrator.");
  });
});
