import { describe, expect, it } from "vitest";
import { editContentRows, restoreContentStructure } from "../src/lib/content-row-editing";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import { contentLayoutError } from "../../packages/content-core/src/content-layout";
import { homeCompositionDefaults, homeStructuralBlocks } from "../../packages/content-core/src/home-composition";

function fixture(): AdminBlock[] {
  return [
    { ...createBlock("row", "row"), data: { columns: [4, 4, 4] } },
    { ...createBlock("prose", "left"), layout: { rowId: "row", column: 0 } },
    { ...createBlock("image", "middle"), layout: { rowId: "row", column: 1 } },
    { ...createBlock("prose", "right"), layout: { rowId: "row", column: 2 } },
    createBlock("prose", "after"),
  ].map((block, order) => ({ ...block, order }));
}

describe("row editing structure", () => {
  it("adds the two needed two-column rows to a Post with thirteen rows (#4880)", () => {
    let blocks: AdminBlock[] = Array.from({ length: 13 }, (_, index) => {
      const id = `row-${index}`;
      return [
        createBlock("row", id),
        { ...createBlock("prose", `${id}-left`), layout: { rowId: id, column: 0 } },
        { ...createBlock("prose", `${id}-right`), layout: { rowId: id, column: 1 } },
      ];
    }).flat().map((block, order) => ({ ...block, order }));
    expect(blocks).toHaveLength(39);
    for (const id of ["needed-one", "needed-two"]) {
      blocks = editContentRows("post", blocks, {
        kind: "insert", block: createBlock("row", id), destination: {},
      }).blocks;
      for (const column of [0, 1]) {
        blocks = editContentRows("post", blocks, {
          kind: "insert", block: createBlock("prose", `${id}-${column}`),
          destination: { layout: { rowId: id, column } },
        }).blocks;
      }
    }
    expect(blocks).toHaveLength(45);
    expect(contentLayoutError(blocks)).toBeNull();
  });

  it("duplicates a row with independent content and restores it through undo and redo", () => {
    const blocks = fixture();
    const result = editContentRows("post", blocks, { kind: "duplicate", id: "row", newIds: { row: "copy-row", left: "copy-left", middle: "copy-middle", right: "copy-right" } });
    expect(result.blocks.map(block => block.id)).toEqual(["row", "left", "middle", "right", "copy-row", "copy-left", "copy-middle", "copy-right", "after"]);
    expect(result.blocks[5].layout).toEqual({ rowId: "copy-row", column: 0 });
    expect(result.blocks[5].data).not.toBe(blocks[1].data);
    const edited = result.blocks.map(block => block.id === "left" ? { ...block, data: { content: "original edited later" } } : block);
    const undo = restoreContentStructure("post", edited, result.inverse);
    expect(undo.blocks[1].data).toEqual({ content: "original edited later" });
    expect(restoreContentStructure("post", undo.blocks, undo.inverse).blocks).toEqual(edited);
  });

  it("duplicates blocks beside their source and columns with their full content", () => {
    const blocks = fixture();
    const block = editContentRows("post", blocks, { kind: "duplicate", id: "middle", newIds: { middle: "copy" } });
    expect(block.blocks[3]).toMatchObject({ id: "copy", layout: { rowId: "row", column: 1 } });
    const column = editContentRows("post", blocks, { kind: "duplicate", id: "row", column: 1, newIds: { middle: "copy" } });
    expect(column.blocks[0].data.columns).toEqual([3, 3, 3, 3]);
    expect(column.blocks[3]).toMatchObject({ id: "copy", layout: { rowId: "row", column: 2 } });
    expect(column.blocks[4]).toMatchObject({ id: "right", layout: { rowId: "row", column: 3 } });
    expect(restoreContentStructure("post", column.blocks, column.inverse).blocks).toEqual(blocks);
    expect(() => editContentRows("post", column.blocks, { kind: "duplicate", id: "row", column: 0, newIds: { left: "second-copy" } })).toThrow(/four columns/);
    expect(() => editContentRows("post", blocks, { kind: "duplicate", id: "row", newIds: { row: "copy" } })).toThrow(/Try again/);
    expect(() => editContentRows("post", blocks, { kind: "duplicate", id: "middle", newIds: { middle: "left" } })).toThrow(/Try again/);
  });

  it("allows stepwise removal and movement of multiple off-catalog blocks", () => {
    const blocks = [createBlock("row", "row"), createBlock("headline", "bad-one"), createBlock("headline", "bad-two")]
      .map((block, order) => ({ ...block, order }));
    const moved = editContentRows("post", blocks, { kind: "move", id: "bad-one", destination: {} }).blocks;
    expect(moved.map(block => block.id)).toEqual(["row", "bad-two", "bad-one"]);
    const first = editContentRows("post", moved, { kind: "remove", id: "bad-one" }).blocks;
    expect(first.map(block => block.id)).toEqual(["row", "bad-two"]);
    expect(() => editContentRows("post", first, { kind: "insert", block: createBlock("prose", "new"), destination: {} })).toThrow();
    expect(editContentRows("post", first, { kind: "remove", id: "bad-two" }).blocks.map(block => block.id)).toEqual(["row"]);
  });

  it("adds incomplete content to an empty column in reading order", () => {
    const blocks = [fixture()[0]];
    const result = editContentRows("post", blocks, { kind: "insert", block: createBlock("image", "new"), destination: { layout: { rowId: "row", column: 2 } } });
    expect(result.blocks.map(block => block.id)).toEqual(["row", "new"]);
    expect(contentLayoutError(result.blocks)).toBeNull();
    expect(restoreContentStructure("post", result.blocks, result.inverse).blocks).toEqual(blocks);
  });

  it("reduces columns without deleting content and restores only layout", () => {
    const blocks = fixture();
    const result = editContentRows("post", blocks, { kind: "split", id: "row", columns: [6, 6] });
    expect(result.blocks.map(block => block.id)).toEqual(blocks.map(block => block.id));
    expect(result.blocks[3].layout?.column).toBe(1);
    const edited = result.blocks.map(block => block.id === "right" ? { ...block, visible: false, data: { content: "latest local text" } } : block);
    const undo = restoreContentStructure("post", edited, result.inverse);
    expect(undo.blocks[3]).toMatchObject({ visible: false, layout: { column: 2 }, data: { content: "latest local text" } });
    expect(restoreContentStructure("post", undo.blocks, undo.inverse).blocks).toEqual(edited);
  });

  it("moves a row and all its children as one action", () => {
    const blocks = fixture();
    const result = editContentRows("post", blocks, { kind: "move", id: "row", destination: {} });
    expect(result.blocks.map(block => block.id)).toEqual(["after", "row", "left", "middle", "right"]);
    expect(restoreContentStructure("post", result.blocks, result.inverse).blocks).toEqual(blocks);
  });

  it("moves content into, across and out of columns", () => {
    const blocks = fixture();
    const inside = editContentRows("post", blocks, { kind: "move", id: "after", destination: { layout: { rowId: "row", column: 0 }, beforeId: "left" } });
    expect(inside.blocks.map(block => block.id)).toEqual(["row", "after", "left", "middle", "right"]);
    const across = editContentRows("post", inside.blocks, { kind: "move", id: "after", destination: { layout: { rowId: "row", column: 2 } } });
    expect(across.blocks.map(block => block.id)).toEqual(["row", "left", "middle", "right", "after"]);
    const outside = editContentRows("post", across.blocks, { kind: "move", id: "after", destination: {} });
    expect(outside.blocks.at(-1)?.layout).toBeUndefined();
    expect(outside.blocks).toEqual(blocks);
  });

  it("removes a populated row and restores all children without reverting surviving edits", () => {
    const blocks = fixture();
    const result = editContentRows("post", blocks, { kind: "remove", id: "row" });
    expect(result.blocks.map(block => block.id)).toEqual(["after"]);
    const edited = [{ ...result.blocks[0], data: { content: "new text" } }];
    const undo = restoreContentStructure("post", edited, result.inverse);
    expect(undo.blocks.slice(0, 4)).toEqual(blocks.slice(0, 4));
    expect(undo.blocks.at(-1)?.data).toEqual({ content: "new text" });
    expect(result.inverse.find(entry => entry.id === "after")?.removed).toBeUndefined();
  });

  it("rejects missing columns, nesting, cross-column anchors and fixed-region moves", () => {
    const blocks = fixture();
    expect(() => editContentRows("post", blocks, { kind: "move", id: "after", destination: { layout: { rowId: "row", column: 3 } } })).toThrow(/existing row/);
    expect(() => editContentRows("post", blocks, { kind: "move", id: "row", destination: { layout: { rowId: "row", column: 0 } } })).toThrow(/inside/);
    expect(() => editContentRows("post", blocks, { kind: "move", id: "after", destination: { layout: { rowId: "row", column: 0 }, beforeId: "right" } })).toThrow(/destination column/);
    const fixed = [{ ...createBlock("prose", "fixed"), section: "body-copy" }];
    expect(() => editContentRows("genericPage", fixed, { kind: "move", id: "fixed", destination: {} })).toThrow(/fixed page section/);
    expect(contentLayoutError(blocks)).toBeNull();
  });
});

describe("Home structural shelf placement", () => {
  it("keeps a default Home manual shelf before Featured and updates placement on move", () => {
    const shelf = createBlock("promotion_playlist", "shelf");
    const blocks = [...homeCompositionDefaults() as AdminBlock[], shelf].map((block, order) => ({ ...block, order }));
    expect(shelf.data.placement).toBe("before_featured");
    expect(homeStructuralBlocks(blocks).map(block => block.id).indexOf("shelf"))
      .toBeLessThan(homeStructuralBlocks(blocks).map(block => block.id).indexOf("new-home-featured"));

    const moved = editContentRows("home", blocks, {
      kind: "homeMove",
      id: "shelf",
      destination: { beforeId: "new-home-passport-copy" },
    });
    const next = moved.blocks.find(block => block.id === "shelf");
    expect(next?.data.placement).toBe("before_passport");
    const ids = moved.blocks.map(block => block.id);
    expect(ids.indexOf("shelf")).toBeGreaterThan(ids.indexOf("new-home-featured"));
    expect(ids.indexOf("shelf")).toBeLessThan(ids.indexOf("new-home-passport-copy"));

    const unchanged = editContentRows("home", moved.blocks, {
      kind: "homeMove",
      id: "shelf",
      destination: {},
    });
    expect(unchanged.blocks).toBe(moved.blocks);
    expect(unchanged.blocks.find(block => block.id === "shelf")?.data.placement).toBe("before_passport");
  });
});
