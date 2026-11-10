import { describe, it, expect } from "vitest";
import {
  blockIsPopulated,
  blockRemovalPrompt,
  galleryImageName,
  listItemName,
  removedBlockNotice,
  removedItemNotice,
} from "../src/lib/destructive-actions";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";

function block(type: Parameters<typeof createBlock>[0], data: Record<string, unknown>): AdminBlock {
  const seed = createBlock(type, `${type}-1`);
  return { ...seed, data: { ...seed.data, ...data } };
}

const filledRichText = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "A body worth keeping." }] },
  ],
};

describe("blockIsPopulated (#1035)", () => {
  it("asks before removing a results section with any placed race", () => {
    expect(blockIsPopulated(block("election_results", { races: [] }))).toBe(false);
    expect(blockIsPopulated(block("election_results", { races: [{ office: "U.S. House" }] }))).toBe(true);
  });
  it("reads a freshly created block of every type as empty", () => {
    for (const type of [
      "headline",
      "prose",
      "image",
      "image_gallery",
      "cta_row",
      "card_grid",
      "faq_item",
      "embed",
      "divider",
    ] as const) {
      expect(blockIsPopulated(createBlock(type, "new")), type).toBe(false);
    }
  });

  it("reads whitespace-only text as empty so a stray space is not treated as work", () => {
    expect(blockIsPopulated(block("headline", { text: "   " }))).toBe(false);
    expect(blockIsPopulated(block("headline", { text: "Tonight on NJ PBS" }))).toBe(true);
  });

  it("reads an empty rich-text document as empty and a written one as populated", () => {
    expect(blockIsPopulated(block("prose", { content: { type: "doc", content: [] } }))).toBe(false);
    expect(blockIsPopulated(block("prose", { content: filledRichText }))).toBe(true);
  });

  it("reads a list field by its item count, not by the items' own emptiness", () => {
    // One added-but-unfilled gallery item is still an item the editor placed: removing the
    // block takes it away, so the removal is not friction-free.
    expect(blockIsPopulated(block("image_gallery", { images: [] }))).toBe(false);
    expect(
      blockIsPopulated(block("image_gallery", { images: [{ assetId: "", alt: "" }] })),
    ).toBe(true);
  });

  it("ignores a toggle and a chosen heading level, which are settings rather than content", () => {
    expect(blockIsPopulated(block("headline", { text: "", level: 4 }))).toBe(false);
    expect(blockIsPopulated(block("image", { altDecorative: true }))).toBe(false);
    expect(blockIsPopulated(block("image", { assetId: "asset-1" }))).toBe(true);
  });

  it("treats a divider, which holds no content at all, as never populated", () => {
    expect(blockIsPopulated(createBlock("divider", "d1"))).toBe(false);
  });
});

describe("blockRemovalPrompt (#1035)", () => {
  it("names the block type, its position, and its title in the question", () => {
    const prompt = blockRemovalPrompt(block("headline", { text: "Tonight on NJ PBS" }), 2);
    expect(prompt.title).toBe('Remove heading 2 “Tonight on NJ PBS”?');
    expect(prompt.confirmLabel).toBe("Confirm removal of heading 2");
  });

  it("states what the block holds, counted, so nothing is removed unseen", () => {
    const prompt = blockRemovalPrompt(
      block("image_gallery", { images: [{ assetId: "a" }, { assetId: "b" }, { assetId: "c" }] }),
      1,
    );
    expect(prompt.title).toBe("Remove image gallery 1?");
    expect(prompt.detail).toContain("3 images");
  });

  it("counts a single item in the singular", () => {
    const prompt = blockRemovalPrompt(block("cta_row", { ctas: [{ label: "Donate" }] }), 4);
    expect(prompt.detail).toContain("1 button");
    expect(prompt.detail).not.toContain("1 buttons");
  });

  it("names a block's own fields as a sentence, not as a list of descriptor labels", () => {
    // The first browser pass read "This block holds heading." — true, and not English. What the
    // person needs is what removing it costs them, said the way they would say it.
    expect(blockRemovalPrompt(block("headline", { text: "Tonight on NJ PBS" }), 1).detail).toContain(
      "Removing it takes away its heading.",
    );
    expect(
      blockRemovalPrompt(
        block("image", { assetId: "asset-1", alt: "Newark skyline", caption: "At dusk" }),
        2,
      ).detail,
    ).toContain("Removing it takes away its image, alt text, and caption.");
  });

  it("says the removal is recoverable rather than leaving the person guessing", () => {
    const prompt = blockRemovalPrompt(block("prose", { content: filledRichText }), 3);
    expect(prompt.detail).toContain("Undo");
    expect(prompt.detail).toContain("revision history");
  });

  it("truncates a long title instead of pouring a paragraph into the question", () => {
    const long = "A heading long enough that repeating it whole would bury the question itself";
    const prompt = blockRemovalPrompt(block("headline", { text: long }), 1);
    expect(prompt.title.length).toBeLessThan(long.length + 20);
    expect(prompt.title).toContain("…");
  });
});

describe("removal notices (#1035)", () => {
  it("names the removed block so the undo affordance says what it takes back", () => {
    expect(removedBlockNotice(block("headline", { text: "Tonight on NJ PBS" }), 2)).toBe(
      'Removed heading 2 “Tonight on NJ PBS”.',
    );
    expect(removedBlockNotice(createBlock("divider", "d"), 1)).toBe("Removed divider 1.");
  });

  it("names a removed gallery image by its alt text, caption, or position", () => {
    expect(galleryImageName({ alt: "Newark skyline", caption: "" }, 1)).toBe(
      'image 1 “Newark skyline”',
    );
    expect(galleryImageName({ alt: "", caption: "At the studio" }, 3)).toBe(
      'image 3 “At the studio”',
    );
    expect(galleryImageName({ alt: "", caption: "" }, 2)).toBe("image 2");
  });

  it("names a removed button or card by its own label", () => {
    expect(listItemName("button", { label: "Donate" }, 1)).toBe('button 1 “Donate”');
    expect(listItemName("card", { title: "Passport" }, 2)).toBe('card 2 “Passport”');
    expect(listItemName("card", {}, 5)).toBe("card 5");
  });

  it("phrases an item notice the same way as a block notice", () => {
    expect(removedItemNotice('image 1 “Newark skyline”')).toBe('Removed image 1 “Newark skyline”.');
  });
});
