import { describe, expect, it } from "vitest";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import { editContentRows, restoreContentStructure, contentPlacementReason, type ContentRowEdit } from "../src/lib/content-row-editing";
import { blockEditorReducer, initialBlockEditorState } from "../src/lib/block-editor-state";

function fixture(columns: number[] = [6, 6], inside = false): AdminBlock[] {
  return [{ ...createBlock("row", "row"), data: { columns } },
    { ...createBlock("divider", "divider"), ...(inside ? { layout: { rowId: "row", column: 0 } } : {}) },
  ].map((block, order) => ({ ...block, order }));
}

describe("divider authoring compatibility", () => {
  it.each([[6, 6], [4, 4, 4], [3, 3, 3, 3]])("rejects new dividers for stored multi-column layout %j", (...columns) => {
    const blocks = fixture(columns);
    expect(contentPlacementReason(blocks, "divider", { layout: { rowId: "row", column: 0 } })).toMatch(/one-column row/);
    for (let column = 0; column < columns.length; column++) {
      expect(() => editContentRows("post", blocks, { kind: "insert", block: createBlock("divider", "new"), destination: { layout: { rowId: "row", column } } })).toThrow(/one-column row/);
      expect(() => editContentRows("post", blocks, { kind: "move", id: "divider", destination: { layout: { rowId: "row", column } } })).toThrow(/one-column row/);
    }
    expect(contentPlacementReason(blocks, "image", { layout: { rowId: "row", column: 0 } })).toBeNull();
  });

  it("allows root and one-column insertions, including before a sibling", () => {
    const blocks = fixture([12], true);
    expect(editContentRows("post", blocks, { kind: "insert", block: createBlock("divider", "new"), destination: { layout: { rowId: "row", column: 0 }, beforeId: "divider" } }).blocks[1].id).toBe("new");
    expect(editContentRows("post", blocks, { kind: "insert", block: createBlock("divider", "new"), destination: {} }).blocks.at(-1)?.layout).toBeUndefined();
  });

  it("blocks expanding or duplicating a column when even a hidden divider would become incompatible", () => {
    const blocks = fixture([12], true); blocks[1].visible = false;
    expect(() => editContentRows("post", blocks, { kind: "split", id: "row", columns: [6, 6] })).toThrow(/divider/i);
    expect(() => editContentRows("post", blocks, { kind: "duplicate", id: "row", column: 0, newIds: { divider: "copy" } })).toThrow(/divider/i);
  });

  it("preserves legacy content and history while refusing copied incompatible placement", () => {
    const blocks = fixture([6, 6], true);
    const snapshot = structuredClone(blocks);
    for (const edit of [
      { kind: "duplicate" as const, id: "divider", newIds: { divider: "copy" } },
      { kind: "duplicate" as const, id: "row", newIds: { row: "copy-row", divider: "copy" } },
      { kind: "duplicate" as const, id: "row", column: 1, newIds: {} },
    ] as ContentRowEdit[]) expect(() => editContentRows("post", blocks, edit)).toThrow(/divider/i);
    expect(blocks).toEqual(snapshot);
    for (const edit of [
      { kind: "move" as const, id: "divider", destination: {} },
      { kind: "remove" as const, id: "divider" },
      { kind: "split" as const, id: "row", columns: [12] },
    ]) {
      const result = editContentRows("post", blocks, edit);
      expect(restoreContentStructure("post", result.blocks, result.inverse).blocks).toEqual(blocks);
    }
  });

  it("checks fresh reducer state and rejects both insertion APIs without dirtying or recording Undo", () => {
    let state = initialBlockEditorState( fixture([12]));
    state = blockEditorReducer("post", state, { kind: "editRows", edit: { kind: "split", id: "row", columns: [6, 6] } });
    const before = state;
    const result = blockEditorReducer("post", state, { kind: "editRows", edit: { kind: "insert", block: createBlock("divider", "new"), destination: { layout: { rowId: "row", column: 0 } } } });
    expect(result.blocks).toBe(before.blocks);
    expect(result.undo).toBe(before.undo);
    expect(result.error).toMatch(/one-column row/);
    const legacyApi = blockEditorReducer("post", initialBlockEditorState( fixture([6, 6], true)), { kind: "insertBlock", block: createBlock("divider", "new"), index: 1 });
    expect(legacyApi.undo).toHaveLength(0);
    expect(legacyApi.error).toMatch(/one-column row/);
  });
});
