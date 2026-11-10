// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as canonical from "../../packages/content-core/src/content-layout";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import type { LayoutBlock } from "../../packages/content-core/src/content-layout";

const require = createRequire(import.meta.url);
const mirror = require("../../functions/lib/content-layout.js") as typeof canonical;

function composition(): LayoutBlock[] {
  return [
    { id: "intro", type: "prose", order: 0, visible: true, data: { content: "intro" } },
    { id: "row", type: "row", order: 1, visible: true, data: { columns: [4, 8] } },
    { id: "image", type: "image", order: 2, visible: true, layout: { rowId: "row", column: 0 }, data: { assetId: "asset" } },
    { id: "text", type: "prose", order: 3, visible: true, layout: { rowId: "row", column: 1 }, data: { content: "text" } },
    { id: "action", type: "cta_row", order: 4, visible: true, layout: { rowId: "row", column: 1 }, data: { ctas: [] } },
  ];
}

function patched(index: number, patch: Partial<LayoutBlock>): LayoutBlock[] {
  const blocks = composition();
  blocks[index] = { ...blocks[index], ...patch };
  return blocks;
}

describe("the Functions row layout mirror matches the canonical content core", () => {
  it.each([
    { data: { columns: [12] }, valid: true },
    { data: { columns: [4, 8] }, valid: true },
    { data: { columns: [3, 3, 3, 3] }, valid: true },
    { data: { columns: [] }, valid: false },
    { data: { columns: [6, 5] }, valid: false },
    { data: { columns: [1, 1, 1, 1, 8] }, valid: false },
    { data: { columns: [12], style: "position: fixed" }, valid: false },
  ])("agrees on row widths for $data", ({ data, valid }) => {
    expect(mirror.isRowData(data)).toBe(canonical.isRowData(data));
    expect(mirror.isRowData(data)).toBe(valid);
  });

  it.each([
    {
      name: "legacy content",
      blocks: [composition()[0], { ...composition()[0], id: "tail", order: 20 }],
      error: null,
    },
    { name: "valid row", blocks: composition(), error: null },
    {
      name: "invalid widths",
      blocks: patched(1, { data: { columns: [6, 5] } }),
      error: "Row row has invalid column widths",
    },
    {
      name: "orphan membership",
      blocks: patched(2, { layout: { rowId: "missing", column: 0 } }),
      error: "Block image must follow its row and its other content",
    },
    {
      name: "missing column",
      blocks: patched(2, { layout: { rowId: "row", column: 2 } }),
      error: "Block image refers to a missing column",
    },
    {
      name: "reversed columns",
      blocks: patched(4, { layout: { rowId: "row", column: 0 } }),
      error: "Row row content must follow column reading order",
    },
  ])("returns the same membership result and error for $name", ({ blocks, error }) => {
    expect(mirror.contentLayoutError(blocks)).toBe(canonical.contentLayoutError(blocks));
    expect(mirror.contentLayoutError(blocks)).toBe(error);
  });

  it("filters a hidden row and its children the same way", () => {
    const blocks = composition();
    blocks[1].visible = false;
    blocks[3].visible = false;

    const expected = canonical.visibleLayoutBlocks(blocks);
    const actual = mirror.visibleLayoutBlocks(blocks);
    expect(actual).toEqual(expected);
    expect(actual.map((block) => block.id)).toEqual(["intro"]);
    expect(blocks[2].visible).toBe(true);
  });

  it("groups valid rows and legacy content without changing payload identity", () => {
    const blocks = composition();
    const actual = mirror.groupContentRows(blocks);
    expect(actual).toEqual(canonical.groupContentRows(blocks));
    expect(actual[1].row).toBe(blocks[1]);
    expect(actual[1].columns.map((column) => column.map((block) => block.id))).toEqual([
      ["image"],
      ["text", "action"],
    ]);
    expect(actual[1].columns[1][0].data).toBe(blocks[3].data);

    const legacy = [blocks[0], { ...blocks[0], id: "tail", order: 20 }];
    expect(mirror.groupContentRows(legacy)).toEqual(canonical.groupContentRows(legacy));
    expect(mirror.groupContentRows(legacy).map((group) => group.row)).toEqual([null, null]);
  });

  it("remaps only owned row membership receipts", () => {
    const blocks = composition();
    const actual = mirror.remapRowMembership(blocks, { row: "server-row" });
    expect(actual).toEqual(canonical.remapRowMembership(blocks, { row: "server-row" }));
    expect(actual[0]).toBe(blocks[0]);
    expect(actual[2].layout).toEqual({ rowId: "server-row", column: 0 });
    expect(actual[2].data).toBe(blocks[2].data);
    expect(blocks[2].layout?.rowId).toBe("row");

    const inherited = Object.create({ row: "inherited" }) as Record<string, string>;
    expect(mirror.remapRowMembership(blocks, inherited)).toEqual(
      canonical.remapRowMembership(blocks, inherited),
    );
    expect(mirror.remapRowMembership(blocks, inherited)[2]).toBe(blocks[2]);
  });
});


it("saves incomplete tables in hidden rows but validates visible tables in both parsers", () => {
  const serverParse = require("../../functions/lib/content-blocks.js").parseBlocks;
  const row = { id: "r", type: "row", order: 0, visible: false, data: { columns: [12] } };
  const table = { id: "t", type: "data_table", order: 1, visible: true,
    layout: { rowId: "r", column: 0 }, data: { title: "", csv: "", source: "", sourceHref: "" } };
  for (const parse of [parseBlocks, serverParse]) {
    expect(parse([row, table]).ok).toBe(true);
    expect(parse([{ ...row, visible: true }, table])).toEqual({ ok: false, error: "blocks[1] has invalid data for data_table" });
    expect(parse([row, { ...table, data: { ...table.data, csv: 12 } }]).ok).toBe(false);
    expect(parse([row, { ...table, layout: { rowId: "missing", column: 0 } }]).ok).toBe(false);
  }
});
