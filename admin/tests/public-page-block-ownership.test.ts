import { describe, expect, it } from "vitest";
import type { AdminBlock } from "../src/lib/block-factory";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import {
  blocksForPublicPageSave,
  editableBlocksForPublicPage,
} from "../src/lib/public-page-block-ownership";

const legacyHeading: AdminBlock = {
  id: "legacy-heading",
  type: "headline",
  order: 0,
  visible: true,
  data: { text: "Stored but not public" },
};
const storedShelf: AdminBlock = {
  id: "stored-shelf",
  type: "promotion_playlist",
  order: 1,
  visible: false,
  data: { title: "", placement: "before_featured", cards: [] },
};
const legacyDivider: AdminBlock = {
  id: "legacy-divider",
  type: "divider",
  order: 2,
  visible: true,
  data: {},
};

describe("public page block ownership", () => {
  it("shows only the Home manual shelf and gives that projection a clean local order", () => {
    expect(
      editableBlocksForPublicPage("home", [
        legacyHeading,
        storedShelf,
        legacyDivider,
      ]),
    ).toEqual([{ ...storedShelf, order: 0 }]);
  });

  it("restores ignored Home blocks exactly when the shelf changes", () => {
    const editedShelf: AdminBlock = {
      ...storedShelf,
      order: 0,
      data: { title: "Dolly Parton", placement: "before_start", cards: [] },
    };

    const saved = blocksForPublicPageSave(
      "home",
      [legacyHeading, storedShelf, legacyDivider],
      [editedShelf],
    );

    expect(saved).toEqual([
      legacyHeading,
      { ...editedShelf, order: storedShelf.order },
      legacyDivider,
    ]);
    expect(saved[0]).toBe(legacyHeading);
    expect(saved[2]).toBe(legacyDivider);
  });

  it("removes only the shelf and rejects ignored Home blocks from the editor", () => {
    expect(
      blocksForPublicPageSave(
        "home",
        [legacyHeading, storedShelf, legacyDivider],
        [],
      ),
    ).toEqual([legacyHeading, legacyDivider]);

    expect(() =>
      blocksForPublicPageSave("home", [legacyHeading], [legacyDivider]),
    ).toThrow("Only the manual content shelf");
  });

  it("leaves non-Home page blocks under their ordinary editor ownership", () => {
    expect(editableBlocksForPublicPage("about", [legacyHeading])).toEqual([
      legacyHeading,
    ]);
    expect(blocksForPublicPageSave("about", [], [legacyHeading])).toEqual([
      legacyHeading,
    ]);
  });

  it("round-trips the complete marked Home composition", () => {
    const stored = homeCompositionDefaults() as AdminBlock[];
    const edited = structuredClone(stored);
    const cards = edited[0].data.cards as Array<Record<string, unknown>>;
    cards[0] = { ...cards[0], itemId: "temporary-start-card" };

    expect(editableBlocksForPublicPage("home", edited, 1)).toEqual(edited);
    expect(blocksForPublicPageSave("home", stored, edited, 1)).toEqual(
      edited,
    );
  });

  it("rejects an unknown Home composition marker", () => {
    const blocks = homeCompositionDefaults() as AdminBlock[];
    expect(() => editableBlocksForPublicPage("home", blocks, 3)).toThrow(
      "Home composition version is invalid",
    );
  });

  it("retains v2 Start recovery payload after internal grid-item normalization and reordering", () => {
    const stored = homeCompositionDefaults() as AdminBlock[];
    const edited = [...structuredClone(stored).slice(3, 5), ...structuredClone(stored).slice(0, 3), ...structuredClone(stored).slice(5)]
      .map((block, order) => ({ ...block, order }));
    const start = edited.find(block => block.section === "home-start")!;
    const cards = start.data.cards as Array<Record<string, unknown>>;
    cards[0] = { ...cards[0], itemId: "internal-local-item" };
    const saved = blocksForPublicPageSave("home", stored, edited, 2);
    expect(saved.map(block => block.id)).toEqual(edited.map(block => block.id));
    expect(saved.find(block => block.section === "home-start")).toEqual({ ...stored[0], order: 2 });
    expect(saved.find(block => block.section === "home-start-action")).toEqual({ ...stored[1], order: 3 });
  });

  it("rejects a Home composition marker on another page", () => {
    const blocks = homeCompositionDefaults() as AdminBlock[];
    expect(() => editableBlocksForPublicPage("about", blocks, 1)).toThrow(
      "Home composition version is invalid",
    );
  });

  it("rejects a marked save that is missing a fixed region", () => {
    const blocks = homeCompositionDefaults() as AdminBlock[];
    expect(() =>
      blocksForPublicPageSave("home", blocks, blocks.slice(0, -1), 1),
    ).toThrow("Home requires its seven named regions");
  });
});
