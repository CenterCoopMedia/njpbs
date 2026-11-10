import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import v1 from "./fixtures/home-composition-v1.json";
import { parseBlocks, type PageBlock, PROMOTION_PLAYLIST_PLACEMENTS } from "../../packages/content-core/src/content-model";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { planHomeCompositionV2 } from "../../packages/content-core/src/home-composition-v2";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/home-composition-v2.js");
function fixture(): PageBlock[] {
  const parsed = parseBlocks(structuredClone(v1.blocks));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.blocks;
}
const plain = (id: string): PageBlock => ({ id, type: "prose", visible: true, order: 0, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: id }] }] } } });
const manual = (placement: typeof PROMOTION_PLAYLIST_PLACEMENTS[number]): PageBlock => ({ id: `manual-${placement}`, section: "home-local-promotions", type: "promotion_playlist", visible: true, order: 0, data: { title: "Reviewed station story", placement, cards: [{ itemId: "frozen-post-v4", title: "Reviewed title", summary: "Reviewed summary", imageAssetId: "story-art", alt: "Local scene", href: "/about/" }] } });

describe("explicit Home v1 to v2 conversion proposal", () => {
  it("preserves the captured seven-region fixture without reseeding or reminting IDs", () => {
    const before = fixture();
    const saved = JSON.stringify(before);
    expect(planHomeCompositionV2(before)).toEqual(before);
    expect(server.planHomeCompositionV2(before)).toEqual(before);
    expect(JSON.stringify(before)).toBe(saved);
    expect(homeCompositionError("home", 2, before)).toBeNull();
  });

  it("folds every v1 placement into one golden array while retaining rows, hidden content and frozen cards", () => {
    const original = fixture();
    const added = [plain("before-start"), original[0], original[1],
      { id: "row-local", type: "row", order: 0, visible: true, data: { columns: [12] } } as PageBlock,
      { ...plain("row-copy"), layout: { rowId: "row-local", column: 0 } }, original[2],
      plain("before-passport"), original[3], original[4], plain("before-more"), original[5],
      plain("before-spotlight"), original[6], { ...plain("hidden-recovery"), visible: false },
      ...[...PROMOTION_PLAYLIST_PLACEMENTS].reverse().map(manual)]
      .map((block, order) => ({ ...block, order }));
    expect(parseBlocks(added).ok).toBe(true);
    expect(homeCompositionError("home", 1, added)).toBeNull();
    const expected = ["before-start", "manual-before_start", "new-home-start", "new-home-start-action",
      "row-local", "row-copy", "manual-before_featured", "new-home-featured",
      "before-passport", "manual-before_passport", "new-home-passport-copy", "new-home-passport-action",
      "before-more", "manual-before_more", "new-home-more", "before-spotlight", "manual-before_spotlight", "new-home-spotlight", "hidden-recovery"];
    const converted = planHomeCompositionV2(added);
    expect(converted.map(block => block.id)).toEqual(expected);
    expect(server.planHomeCompositionV2(added)).toEqual(converted);
    expect(parseBlocks(converted).ok).toBe(true);
    expect(homeCompositionError("home", 2, converted)).toBeNull();
    for (const block of converted) {
      const old = added.find(candidate => candidate.id === block.id)!;
      expect({ ...block, order: old.order }).toEqual(old);
    }
    // Retrying the same stored proposal does not insert, remove or relocate content.
    expect(planHomeCompositionV2(added)).toEqual(converted);
    expect(planHomeCompositionV2(converted)).toEqual(converted);
  });

  it("keeps all IDs and data across placement permutations, including multiple shelves in one area", () => {
    for (let offset = 0; offset < 5; offset += 1) {
      const shelves = Array.from({ length: 8 }, (_, index) => ({ ...manual(PROMOTION_PLAYLIST_PLACEMENTS[(index + offset) % 5]), id: `saved-${index}` }));
      const before = [...fixture(), ...shelves].map((block, order) => ({ ...block, order }));
      const converted = planHomeCompositionV2(before);
      expect(converted).toHaveLength(before.length);
      expect(new Set(converted.map(block => block.id))).toEqual(new Set(before.map(block => block.id)));
      expect(server.planHomeCompositionV2(before)).toEqual(converted);
      for (const placement of PROMOTION_PLAYLIST_PLACEMENTS) {
        expect(converted.filter(block => block.type === "promotion_playlist" && block.data.placement === placement).map(block => block.id))
          .toEqual(shelves.filter(block => block.type === "promotion_playlist" && block.data.placement === placement).map(block => block.id));
      }
      expect(homeCompositionError("home", 2, converted)).toBeNull();
    }
  });

  it.each(["source", "link", "identity", "split-pair"])("refuses malformed v1 %s without mutating recovery input", kind => {
    const before = fixture();
    if (kind === "source" && before[2].type === "content_shelf") before[2].data.source = "spotlight_news";
    if (kind === "link" && before[4].type === "cta_row") before[4].data.ctas[0].href = "/support/";
    if (kind === "identity") before[2].section = "home-unapproved";
    if (kind === "split-pair") before.splice(4, 0, plain("inside-passport"));
    const saved = JSON.stringify(before);
    expect(() => planHomeCompositionV2(before)).toThrow();
    expect(() => server.planHomeCompositionV2(before)).toThrow();
    expect(JSON.stringify(before)).toBe(saved);
  });
});
