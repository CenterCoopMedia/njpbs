import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DocumentListEditor } from "../src/components/DocumentListEditor";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import { editorFieldsForBlock } from "../../packages/content-core/src/editor-admin";
import { missingBlockContent } from "../src/lib/field-validation";

afterEach(cleanup);

function Editor({ initial, canAdd = false }: { initial: AdminBlock; canAdd?: boolean }) {
  const [block, setBlock] = useState(initial);
  // Match the client publication check for this visible block. AdminBlock data
  // intentionally remains a Record until the model parser validates its shape.
  const error = missingBlockContent(editorFieldsForBlock(block.type), block.data, {
    allowIncomplete: false,
  })[0] ?? null;
  return <>
    <DocumentListEditor block={block} loadMedia={canAdd ? async () => { throw new Error("This test does not open the picker"); } : undefined}
      onChange={data => setBlock({ ...block, data })} />
    <button disabled={error !== null}>Publish notices</button>
    {error ? <p role="alert">{error}</p> : null}
  </>;
}

describe("DocumentListEditor empty notices", () => {
  it("keeps a newly inserted empty list publishable", () => {
    render(<Editor initial={createBlock("document_list", "notices")} />);
    expect(screen.getByText("Add the first meeting notice.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish notices" })).toBeEnabled();
  });

  it("keeps the visible list publishable after removing its final PDF", () => {
    const initial = { ...createBlock("document_list", "notices"), data: { documents: [
      { itemId: "notice", assetId: "pdf-one", title: "Board notice", publisher: "njpba" },
    ] } };
    render(<Editor initial={initial} />);
    expect(screen.getByRole("button", { name: "Publish notices" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Board notice from notices" }));
    expect(screen.getByText("Add the first meeting notice.")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: /Notice title/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Publish notices" })).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
    // There is no media loader in this fixture, so Add is disabled. Keep focus
    // in the emptied list rather than dropping it onto the document body.
    expect(screen.getByText("PDF notices")).toHaveFocus();
  });
});


describe("notice removal focus", () => {
  it("follows visible newest-first order and returns to enabled Add after the final removal", () => {
    const initial = { ...createBlock("document_list", "notices"), data: { documents: [
      { itemId: "old", assetId: "pdf-old", title: "Older notice", publisher: "njpba", addedAt: "2026-01-01T12:00:00Z" },
      { itemId: "new", assetId: "pdf-new", title: "Newest notice", publisher: "njpba", addedAt: "2026-03-01T12:00:00Z" },
      { itemId: "middle", assetId: "pdf-middle", title: "Middle notice", publisher: "njpba", addedAt: "2026-02-01T12:00:00Z" },
    ] } };
    render(<Editor initial={initial} canAdd />);
    const middle = screen.getByRole("button", { name: "Remove Middle notice from notices" });
    act(() => middle.focus());
    fireEvent.click(middle);
    expect(screen.getByRole("button", { name: "Remove Older notice from notices" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove Older notice from notices" }));
    expect(screen.getByRole("button", { name: "Remove Newest notice from notices" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove Newest notice from notices" }));
    expect(screen.getByRole("button", { name: "Add PDF notice" })).toHaveFocus();
  });
});
