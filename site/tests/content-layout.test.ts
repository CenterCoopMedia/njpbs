import { describe, expect, it } from "vitest";
import {
  contentLayoutError,
  groupContentRows,
  isRowData,
  remapRowMembership,
  visibleLayoutBlocks,
  type LayoutBlock,
} from "../../packages/content-core/src/content-layout";

function composition(): LayoutBlock[] {
  return [
    { id: "intro", type: "prose", order: 0, visible: true, data: { content: "intro" } },
    { id: "row", type: "row", order: 1, visible: true, data: { columns: [4, 8] } },
    { id: "image", type: "image", order: 2, visible: true, layout: { rowId: "row", column: 0 }, data: { assetId: "asset" } },
    { id: "text", type: "prose", order: 3, visible: true, layout: { rowId: "row", column: 1 }, data: { content: "text" } },
    { id: "button", type: "cta_row", order: 4, visible: true, layout: { rowId: "row", column: 1 }, data: { ctas: [] } },
  ];
}

describe("content row contract", () => {
  it("keeps legacy order and identities untouched, including nonconsecutive order values", () => {
    const blocks = [composition()[0], { ...composition()[0], id: "tail", order: 20 }];
    expect(contentLayoutError(blocks)).toBeNull();
    const groups = groupContentRows(blocks);
    expect(groups.map(group => group.row)).toEqual([null, null]);
    expect(groups[1].columns[0][0]).toBe(blocks[1]);
    expect(visibleLayoutBlocks(blocks)[1]).toBe(blocks[1]);
  });

  it("groups actual content once, preserving within-column order and payload identity", () => {
    const blocks = composition();
    const groups = groupContentRows(blocks);
    expect(groups[1].row).toBe(blocks[1]);
    expect(groups[1].columns.map(column => column.map(block => block.id))).toEqual([["image"], ["text", "button"]]);
    expect(groups[1].columns[1][0].data).toBe(blocks[3].data);
  });

  it("keeps empty rows and columns without inventing content", () => {
    const blocks = [{ ...composition()[1], order: 0 }];
    expect(groupContentRows(blocks)[0].columns).toEqual([[], []]);
  });

  it("rejects sparse widths even when their defined values sum to twelve", () => {
    const columns = [6, 6];
    columns.length = 3;
    expect(isRowData({ columns })).toBe(false);
  });

  it.each([[12], [6, 6], [4, 4, 4], [3, 3, 3, 3], [1, 11], [2, 3, 7]])("admits a bounded split %j", (...columns) => {
    expect(isRowData({ columns })).toBe(true);
  });

  it.each([
    null, [[]], {}, { columns: [] }, { columns: [6, 5] }, { columns: [0, 12] },
    { columns: [2.5, 9.5] }, { columns: ["6", 6] }, { columns: [1, 1, 1, 1, 8] },
    { columns: [12], style: "position:fixed" },
  ])("rejects invalid row data %j", data => {
    expect(isRowData(data)).toBe(false);
  });

  it.each([
    ["orphan", 2, { layout: { rowId: "absent", column: 0 } }],
    ["missing column", 2, { layout: { rowId: "row", column: 2 } }],
    ["fractional column", 2, { layout: { rowId: "row", column: 0.5 } }],
    ["extra layout data", 2, { layout: { rowId: "row", column: 0, style: "x" } }],
    ["null membership", 2, { layout: null }],
    ["named region child", 2, { section: "home-start" }],
    ["named region row", 1, { section: "hero-actions" }],
    ["nested row", 1, { layout: { rowId: "row", column: 0 } }],
    ["ambiguous order", 2, { order: 90 }],
    ["interleaved ungrouped content", 3, { layout: undefined }],
    ["reversed columns", 4, { layout: { rowId: "row", column: 0 } }],
  ] as const)("rejects %s", (_name, index, patch) => {
    const blocks = composition();
    blocks[index] = { ...blocks[index], ...patch } as LayoutBlock;
    expect(contentLayoutError(blocks)).not.toBeNull();
    expect(() => groupContentRows(blocks)).toThrow();
  });

  it("hides a whole row without altering the children's own visibility", () => {
    const blocks = composition();
    blocks[1].visible = false;
    blocks[3].visible = false;
    expect(visibleLayoutBlocks(blocks).map(block => block.id)).toEqual(["intro"]);
    expect(blocks[2].visible).toBe(true);
    blocks[1].visible = true;
    const shown = visibleLayoutBlocks(blocks);
    expect(shown.map(block => block.id)).toEqual(["intro", "row", "image", "button"]);
    expect(contentLayoutError(shown)).toBeNull();
    expect(groupContentRows(shown)[1].columns[1].map(block => block.id)).toEqual(["button"]);
  });

  it("uses the save receipt to remap membership without touching content or unrelated blocks", () => {
    const blocks = composition();
    const mapped = remapRowMembership(blocks, { row: "server-row" });
    expect(mapped[0]).toBe(blocks[0]);
    expect(mapped[2].layout).toEqual({ rowId: "server-row", column: 0 });
    expect(mapped[2].data).toBe(blocks[2].data);
    expect(blocks[2].layout?.rowId).toBe("row");
    expect(remapRowMembership(blocks, Object.create({ row: "inherited" }))[2]).toBe(blocks[2]);
  });
});
