import { describe, expect, it } from "vitest";
import { deriveContentOutline, editorSectionCount, outlineSummary } from "../src/lib/content-outline";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";

export function outlineFixture(): AdminBlock[] {
  return [
    { ...createBlock("row", "empty"), data: { columns: [6, 6] } },
    { ...createBlock("row", "filled"), data: { columns: [4, 4, 4] } },
    ...[0, 1, 2].map(column => ({ ...createBlock("prose", `text-${column}`), layout: { rowId: "filled", column } })),
  ].map((block, order) => ({ ...block, order }));
}

describe("derived content outline", () => {
  it("counts a Home row and its members as one section, including empty columns and hidden children", () => {
    const blocks: AdminBlock[] = [
      { ...createBlock("row", "row"), data: { columns: [4, 4, 4] } },
      { ...createBlock("prose", "visible"), layout: { rowId: "row", column: 0 } },
      { ...createBlock("prose", "hidden"), visible: false, layout: { rowId: "row", column: 2 } },
      { ...createBlock("row", "empty"), visible: false, data: { columns: [6, 6] } },
      { ...createBlock("prose", "standalone"), visible: false },
    ].map((block, order) => ({ ...block, order }));
    const snapshot = structuredClone(blocks);
    // Fixed hero + one filled row + one hidden empty row + hidden standalone section.
    expect(editorSectionCount(blocks, "home")).toBe(4);
    expect(editorSectionCount(blocks, "watch")).toBe(5);
    expect(blocks).toEqual(snapshot);
  });

  it("counts Home sections from the composition, including fixed and paired regions", () => {
    const blocks: AdminBlock[] = [
      ...homeCompositionDefaults() as AdminBlock[],
      { ...createBlock("home_newscast", "newscast"), section: "home-newscast" },
      { ...createBlock("newsletter_signup", "newsletter"), section: "home-newsletter" },
      { ...createBlock("embed", "youtube"), data: { caption: "Latest newscast" } },
      { ...createBlock("prose", "unfinished"), visible: false },
    ].map((block, order) => ({ ...block, order }));
    const snapshot = structuredClone(blocks);
    // Fixed hero + three shelves + newscast + newsletter + paired Passport
    // + independent YouTube embed + a hidden, unfinished authored section.
    expect(editorSectionCount(blocks, "home")).toBe(9);
    const authoring = blocks.filter(block => !["home-start", "home-start-action"].includes(block.section ?? ""));
    expect(editorSectionCount(authoring, "home")).toBe(9);
    // A legacy draft uses the retained start region as its newsletter boundary.
    expect(editorSectionCount(blocks.filter(block => block.section !== "home-newsletter"), "home")).toBe(9);
    expect(editorSectionCount(blocks, "watch")).toBe(blocks.length);
    expect(blocks).toEqual(snapshot);
  });

  it("counts the handoff fixture as two rows and three blocks in five columns", () => {
    const blocks = outlineFixture();
    const outline = deriveContentOutline(blocks);
    expect(outline.rowCount).toBe(2);
    expect(outline.blockCount).toBe(3);
    expect(outline.nodes.map(node => node.kind)).toEqual(["row", "row"]);
    const rows = outline.nodes.filter(node => node.kind === "row");
    expect(rows.map(row => row.blockCount)).toEqual([0, 3]);
    expect(rows.map(row => row.columns.map(column => column.blocks.map(block => block.id)))).toEqual([
      [[], []], [["text-0"], ["text-1"], ["text-2"]],
    ]);
    expect(rows[1].columns[0].blocks[0]).toBe(blocks[2]);
  });

  it("keeps named regions and standalone blocks at the root in reading order", () => {
    const fixed = { ...createBlock("prose", "fixed"), section: "body-copy" };
    const blocks = [fixed, ...outlineFixture(), createBlock("image", "root")].map((block, order) => ({ ...block, order }));
    const outline = deriveContentOutline(blocks);
    expect(outline.nodes.map(node => node.block.id)).toEqual(["fixed", "empty", "filled", "root"]);
    expect(outline.blockCount).toBe(5);
    expect(outline.nodes[0]).toMatchObject({ kind: "block", block: { section: "body-copy" } });
  });

  it("counts hidden and unfinished children without rewriting their data or visibility", () => {
    const blocks = outlineFixture();
    blocks[1].visible = false;
    blocks[3].visible = false;
    const snapshot = structuredClone(blocks);
    const outline = deriveContentOutline(blocks);
    expect(outline.blockCount).toBe(3);
    expect(outline.nodes[1]).toMatchObject({ blockCount: 3 });
    expect(blocks).toEqual(snapshot);
  });

  it("keeps the complete accessible summary for long content and omits opaque identifiers", () => {
    const block = createBlock("prose", "text");
    block.data = { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A long headline ".repeat(20) }] }] } };
    expect(outlineSummary(block)).toBe("A long headline ".repeat(20).trim());
    expect(outlineSummary({ ...createBlock("image", "image"), data: { assetId: "opaque-id", alt: "Statehouse exterior" } })).toBe("Statehouse exterior");
    expect(outlineSummary(createBlock("divider", "line"))).toBe("Visual separator");
  });
});
