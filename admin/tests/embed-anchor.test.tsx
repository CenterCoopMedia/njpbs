import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createBlock } from "../src/lib/block-factory";
import { InlineBlockSurface } from "../src/components/InlineBlockSurface";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { canPlaceAnotherBlock, insertableBlocksForSection, validateSection } from "../../packages/content-core/src/editor-admin";

describe("Signup embed plank", () => {
  it("offers an approved signup selector without an HTML editor", () => {
    const block = createBlock("embed_anchor", "signup");
    expect(block.data).toEqual({ anchorId: "njpbssignup" });
    expect(parseBlocks([block]).ok).toBe(true);
    expect(insertableBlocksForSection("genericPage")).toContain("embed_anchor");
    expect(canPlaceAnotherBlock("genericPage", [block], "embed_anchor")).toBe(false);
    const hiddenBlock = { ...block, visible: false };
    expect(canPlaceAnotherBlock("genericPage", [hiddenBlock], "embed_anchor")).toBe(false);
    expect(validateSection("genericPage", [block, createBlock("embed_anchor", "second", 1)])).not.toBeNull();
    const onChange = vi.fn();
    render(<InlineBlockSurface block={block} hasError={false} onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: /Signup/ });
    expect(screen.getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["njpbssignup"]);
    fireEvent.change(select, { target: { value: "njpbssignup" } });
    expect(onChange).toHaveBeenCalledWith({ anchorId: "njpbssignup" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
