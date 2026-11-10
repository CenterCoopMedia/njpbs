import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { blockContentError } from "../../packages/content-core/src/block-content-validation";
import { parseBlocks, type PageBlock } from "../../packages/content-core/src/content-model";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/block-content-validation.js");

describe.each([
  ["shared model", blockContentError],
  ["Functions", server.blockContentError as typeof blockContentError],
] as const)("%s nested media write contract", (_name, validate) => {
  it.each(["image_gallery", "card_grid"] as const)(
    "accepts twelve %s items and refuses thirteen, including hidden drafts",
    (type) => {
      for (const complete of [false, true]) {
        for (const visible of [false, true]) {
          for (const count of [12, 13]) {
            const items = Array.from({ length: count }, (_, index) => type === "image_gallery"
              ? { itemId: `item-${index}`, assetId: `asset-${index}`, alt: `Image ${index}` }
              : { itemId: `item-${index}`, title: `Card ${index}` });
            // Exercise the serialized content contract without the editor's Add control.
            const input = JSON.parse(JSON.stringify([{
              id: "collection", type, order: 0, visible,
              data: type === "image_gallery" ? { images: items } : { cards: items },
            }]));
            const parsed = parseBlocks(input, { complete });
            // Stored collections remain readable, even when they need repair before saving.
            expect(parsed.ok).toBe(true);
            const error = validate(input as PageBlock[], { complete });
            expect(error).toBe(count === 12 ? null
              : `${type === "image_gallery" ? "Images" : "Cards"} can hold at most 12. Remove 1 to save.`);
          }
        }
      }
    },
  );
});
