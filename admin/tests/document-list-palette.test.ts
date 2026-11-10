import { describe, expect, it } from "vitest";
import { insertableBlocksForSection } from "../../packages/content-core/src/editor-admin";
import { createBlock } from "../src/lib/block-factory";

describe("PDF notice palette", () => {
  it("offers an empty PDF notice list on generic pages", () => {
    expect(insertableBlocksForSection("genericPage")).toContain("document_list");
    expect(createBlock("document_list", "notices").data).toEqual({ documents: [] });
  });
});
