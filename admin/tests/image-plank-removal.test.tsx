import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BlockEditor, type BlockEditorHandle } from "../src/components/BlockEditor";
import { EditorWorkspaceViewProvider, useEditorWorkspaceView } from "../src/context/EditorWorkspaceView";
import type { AdminBlock } from "../src/lib/block-factory";
import { imageAsset } from "./media-tile-fixtures";

afterEach(() => { cleanup(); localStorage.clear(); });

it.each([
  ["page", true], ["page", false], ["post", true], ["post", false],
] as const)("removes a %s image plank through its inspector, with cancel and undo (visible: %s)", async (kind, visible) => {
  const image: AdminBlock = { id: "logo", type: "image", order: 0, visible,
    data: { assetId: "station-logo", alt: "NJ PBS", altDecorative: false, caption: "" } };
  const heading: AdminBlock = { id: "keep", type: "headline", order: 1, visible: true,
    data: { text: "Keep this heading", level: 2 } };
  const editor = createRef<BlockEditorHandle>();
  let saved: AdminBlock[] = [];
  function Fixture() {
    const view = useEditorWorkspaceView()!;
    return <><div ref={view.setSelectionTarget} />
      <BlockEditor ref={editor} section="genericPage" initialBlocks={[image, heading]}
        loadMedia={async () => ({ success: true, records: [imageAsset({ id: "station-logo", name: "Station logo" })],
          total: 1, allCount: 1, page: 1, pageCount: 1, categoryCounts: {}, kindCounts: { image: 1, document: 0 } })}
        onSave={blocks => { saved = blocks; }} /></>;
  }
  render(<EditorWorkspaceViewProvider kind={kind}><Fixture /></EditorWorkspaceViewProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Edit image 1" }));
  const removeImage = await screen.findByRole("button", { name: "Remove image" });
  act(() => removeImage.focus());
  fireEvent.click(removeImage);
  const cancelRemoval = screen.getByRole("button", { name: "Cancel removal of image 1" });
  act(() => cancelRemoval.focus());
  fireEvent.click(cancelRemoval);
  expect(removeImage).toHaveFocus();
  await act(async () => { await editor.current!.save(); });
  expect(saved[0]).toEqual(expect.objectContaining({ id: image.id, data: expect.objectContaining(image.data) }));

  fireEvent.click(screen.getByRole("button", { name: "Remove image" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal of image 1" }));
  expect(screen.queryByRole("button", { name: "Edit image 1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo removal" }));
  await act(async () => { await editor.current!.save(); });
  expect(saved[0]).toEqual(expect.objectContaining({ id: image.id, visible, data: expect.objectContaining(image.data) }));

  fireEvent.click(screen.getByRole("button", { name: "Edit image 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove image" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal of image 1" }));
  await act(async () => { await editor.current!.save(); });
  expect(saved).toEqual([expect.objectContaining({ id: heading.id, type: heading.type, data: heading.data })]);
});
