import { createRef } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlockEditor, type BlockEditorHandle } from "../src/components/BlockEditor";
import type { AdminBlock } from "../src/lib/block-factory";
import { blockEditorReducer, initialBlockEditorState } from "../src/lib/block-editor-state";
import { parseBlocks } from "../../packages/content-core/src/content-model";

const addedAt = "2026-10-07T14:30:00.000Z";
const notice = { itemId: "entry", title: "Board meeting notice", assetId: "pdf-one", publisher: "njpba" };
const initial: AdminBlock = { id: "temporary-list", type: "document_list", order: 0, visible: true, data: { documents: [notice] } };
const stored: AdminBlock = { ...initial, id: "saved-list", data: { documents: [{ ...notice, addedAt }] } };

describe("notice dates after a save", () => {
  it("can submit a newly saved notice without reloading the editor", async () => {
    const ref = createRef<BlockEditorHandle>();
    const onSave = vi.fn(async () => ({ blocks: [stored], mintedIds: { "temporary-list": "saved-list" } }));
    render(<BlockEditor ref={ref} section="genericPage" initialBlocks={[initial]} allowIncomplete onSave={onSave} />);
    await act(async () => { expect((await ref.current!.save()).clean).toBe(true); });
    expect(onSave).toHaveBeenCalledOnce();
    act(() => { expect(ref.current!.validateForPublication()).toBe(true); });
  });

  it("adopts only saved dates and identities while keeping in-flight edits, new entries, and undo", () => {
    let state = initialBlockEditorState([initial]);
    state = blockEditorReducer("genericPage", state, { kind: "setData", id: initial.id, discrete: true,
      data: { documents: [{ ...notice, title: "Edited while saving" }, { ...notice, itemId: "new-entry", title: "Added while saving" }] } });
    state = blockEditorReducer("genericPage", state, { kind: "reconcileIds", idMap: { [initial.id]: stored.id }, savedBlocks: [stored] });
    expect(state.blocks[0]).toMatchObject({ id: stored.id, data: { documents: [
      { ...notice, title: "Edited while saving", addedAt }, { ...notice, itemId: "new-entry", title: "Added while saving" },
    ] } });
    state = blockEditorReducer("genericPage", state, { kind: "undo" });
    expect(state.blocks[0].data.documents).toEqual([{ ...notice, addedAt }]);
    expect(parseBlocks(state.blocks).ok).toBe(true);
    state = blockEditorReducer("genericPage", state, { kind: "redo" });
    expect(state.blocks[0].data.documents).toEqual([
      { ...notice, title: "Edited while saving", addedAt }, { ...notice, itemId: "new-entry", title: "Added while saving" },
    ]);
  });
});
