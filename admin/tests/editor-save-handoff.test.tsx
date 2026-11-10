import { createRef, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BlockEditor, type BlockEditorHandle, type BlockSaveResult, type EditorSaveOutcome } from "../src/components/BlockEditor";
import { RecordForm, type RecordFormHandle, type RecordSaveReceipt } from "../src/components/RecordForm";
import { EditorWorkspace, type PageContent } from "../src/components/EditorWorkspace";
import type { ExitSaveOutcome } from "../src/lib/exit-save";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";

afterEach(() => { cleanup(); localStorage.clear(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const blocks: AdminBlock[] = [{ id: "heading", type: "headline", order: 0, visible: true, data: { text: "Original heading", level: 2 } }];
const pageReceipt = { collection: "cmsPages" as const, documentId: "home", sourceVersion: 8 };
const post = { id: "post-1", title: "Original title", version: 7, status: "draft", type: "post", blocks: [], credits: [] };

// All callers use the actual component handles; no fake save owner hides the race.
describe("existing editor save ownership", () => {
  it.each([false, true])("joins a Page block save before and after the saving render (rendered=%s)", async rendered => {
    const ref = createRef<BlockEditorHandle>();
    const pending = deferred<BlockSaveResult>();
    const onSave = vi.fn(() => pending.promise);
    render(<BlockEditor ref={ref} section="home" initialBlocks={blocks} onSave={onSave} />);
    let first!: Promise<EditorSaveOutcome>;
    let second!: Promise<EditorSaveOutcome>;
    act(() => { first = ref.current!.save(); if (!rendered) second = ref.current!.save(); });
    if (rendered) act(() => { second = ref.current!.save(); });
    expect(second).toBe(first);
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ blocks, mintedIds: {}, savedTarget: pageReceipt }); });
    expect(await first).toEqual({ capture: expect.any(Object), landed: true, clean: true, receipt: pageReceipt });
    expect(await second).toEqual(await first);
  });

  it("preserves block edits made during a shared save and returns the saved target, not a later draft", async () => {
    const ref = createRef<BlockEditorHandle>();
    const pending = deferred<BlockSaveResult>();
    const onDraftChange = vi.fn();
    const onSave = vi.fn(() => pending.promise);
    render(<BlockEditor ref={ref} section="home" initialBlocks={blocks} onSave={onSave} onDraftChange={onDraftChange} />);
    let operation!: Promise<EditorSaveOutcome>;
    act(() => { operation = ref.current!.save(); });
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "New local heading" } });
    expect(ref.current!.save()).toBe(operation);
    await act(async () => { pending.resolve({ blocks, mintedIds: {}, savedTarget: pageReceipt }); });
    expect(await operation).toEqual({ capture: expect.any(Object), landed: true, clean: false, receipt: pageReceipt });
    expect(screen.getByDisplayValue("New local heading")).toBeTruthy();
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ text: "New local heading" }) })]));
  });

  it("recognizes an equivalent captured draft already being saved", async () => {
    const ref = createRef<BlockEditorHandle>();
    const pending = deferred<BlockSaveResult>();
    const onSave = vi.fn(() => pending.promise);
    render(<BlockEditor ref={ref} section="home" initialBlocks={blocks} onSave={onSave} />);
    let first!: Promise<EditorSaveOutcome>;
    act(() => { first = ref.current!.save(); });
    let capture!: ReturnType<BlockEditorHandle["captureSave"]>;
    act(() => { capture = ref.current!.captureSave(); });
    expect(capture.save()).toBe(first);
    await act(async () => { pending.resolve({ blocks, mintedIds: {}, savedTarget: pageReceipt }); });
    expect((await first).capture).toBe(capture.token);
    expect(onSave).toHaveBeenCalledTimes(1);
    capture.dispose();
  });

  it.each([false, true])("rebases captured block IDs with later edits=%s", async laterEdits => {
    const ref = createRef<BlockEditorHandle>();
    const pending = deferred<BlockSaveResult>();
    const onSave = vi.fn().mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async (sent: AdminBlock[]) => ({ blocks: sent, mintedIds: {}, savedTarget: { ...pageReceipt, sourceVersion: 9 } }));
    const onDraftChange = vi.fn();
    render(<BlockEditor ref={ref} section="home" initialBlocks={blocks} onSave={onSave} onDraftChange={onDraftChange} />);
    let first!: Promise<EditorSaveOutcome>;
    act(() => { first = ref.current!.save(); });
    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "At Preview" } });
    let capture!: ReturnType<BlockEditorHandle["captureSave"]>;
    act(() => { capture = ref.current!.captureSave(); });
    expect(capture.save()).toBe(first);
    if (laterEdits) fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "Later edit" } });
    await act(async () => {
      pending.resolve({ blocks: [{ ...blocks[0], id: "saved-heading" }], mintedIds: { heading: "saved-heading" }, savedTarget: pageReceipt });
      await first;
      expect(await capture.save()).toMatchObject({ landed: true, clean: !laterEdits, capture: capture.token });
    });
    expect(onSave.mock.calls[1][0][0]).toMatchObject({ id: "saved-heading", data: { text: "At Preview" } });
    expect(screen.getByRole("textbox", { name: "Heading" })).toHaveValue(laterEdits ? "Later edit" : "At Preview");
    if (laterEdits) expect(onDraftChange).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: "saved-heading", data: expect.objectContaining({ text: "Later edit" }) }),
    ]));
    else expect(onDraftChange).toHaveBeenLastCalledWith(null);
    capture.dispose();
  });

  it("uses acknowledged block IDs when a continuation saves again before React commits", async () => {
    const ref = createRef<BlockEditorHandle>();
    const pending = deferred<BlockSaveResult>();
    const canonical = [{ ...blocks[0], id: "saved-heading" }];
    const onSave = vi.fn().mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ blocks: canonical, mintedIds: {}, savedTarget: { ...pageReceipt, sourceVersion: 9 } });
    render(<BlockEditor ref={ref} section="home" initialBlocks={blocks} onSave={onSave} />);
    await act(async () => {
      const first = ref.current!.save();
      pending.resolve({ blocks: canonical, mintedIds: { heading: "saved-heading" }, savedTarget: pageReceipt });
      await first;
      await ref.current!.save();
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1][0][0].id).toBe("saved-heading");
  });

  it("joins Post saves before asynchronous body validation has completed", async () => {
    const ref = createRef<RecordFormHandle>();
    const pending = deferred<Record<string, unknown>>();
    const onSave = vi.fn(() => pending.promise);
    render(<StrictMode><RecordForm ref={ref} canSave kind="post" initial={post} allowIncomplete onSave={onSave} /></StrictMode>);
    let first!: Promise<EditorSaveOutcome>;
    let second!: Promise<EditorSaveOutcome>;
    act(() => { first = ref.current!.save(); second = ref.current!.save(); });
    expect(second).toBe(first);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await act(async () => { pending.resolve({ ...post, version: 8 }); });
    expect(await first).toEqual({ capture: expect.any(Object), landed: true, clean: true, receipt: { collection: "cmsPosts", documentId: "post-1", sourceVersion: 8 } });
  });

  it("settles a captured Post after adopting an older acknowledgment without later edits", async () => {
    const ref = createRef<RecordFormHandle>();
    const pending = deferred<Record<string, unknown>>();
    const onSave = vi.fn<(record: Record<string, unknown>) => Promise<Record<string, unknown>>>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async sent => ({ ...sent, version: 9 }));
    const onDraftChange = vi.fn();
    render(<RecordForm ref={ref} canSave kind="post" initial={post} allowIncomplete onSave={onSave} onDraftChange={onDraftChange} />);
    let first!: Promise<EditorSaveOutcome>;
    act(() => { first = ref.current!.save(); });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: /^Post title/ }), { target: { value: "At Preview" } });
    let capture!: ReturnType<RecordFormHandle["captureSave"]>;
    act(() => { capture = ref.current!.captureSave(); });
    expect(capture.save()).toBe(first);
    await act(async () => { pending.resolve({ ...post, version: 8 }); await first; });
    await act(async () => {
      expect(await capture.save()).toMatchObject({ landed: true, clean: true, capture: capture.token });
    });
    expect(onSave.mock.calls[1][0]).toMatchObject({ title: "At Preview", version: 8 });
    expect(onDraftChange).toHaveBeenLastCalledWith(null);
    capture.dispose();
  });

  it("retains Post edits and the new base version after an acknowledgment", async () => {
    const ref = createRef<RecordFormHandle>();
    const pending = deferred<Record<string, unknown>>();
    const onSave = vi.fn<(record: Record<string, unknown>) => Promise<Record<string, unknown>>>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async sent => ({ ...sent, version: 9 }));
    render(<RecordForm ref={ref} canSave kind="post" initial={post} allowIncomplete onSave={onSave} />);
    let first!: Promise<EditorSaveOutcome>;
    act(() => { first = ref.current!.save(); });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: /^Post title/ }), { target: { value: "Later edit" } });
    expect(ref.current!.save()).toBe(first);
    await act(async () => { pending.resolve({ ...post, version: 8 }); });
    expect(await first).toEqual({ capture: expect.any(Object), landed: true, clean: false, receipt: { collection: "cmsPosts", documentId: "post-1", sourceVersion: 8 } });
    expect(screen.getByRole("textbox", { name: /^Post title/ })).toHaveValue("Later edit");
    await act(async () => { await ref.current!.save(); });
    expect(onSave.mock.calls[1][0]).toMatchObject({ title: "Later edit", version: 8 });
  });

  it("keeps Post row memberships canonical in an immediate second save", async () => {
    const ref = createRef<RecordFormHandle>();
    const row = { ...createBlock("row", "tmp-row"), data: { columns: [6, 6] } };
    const child = { ...createBlock("prose", "tmp-child"), order: 1, layout: { rowId: row.id, column: 0 } };
    const initial = { ...post, blocks: [row, child] };
    const pending = deferred<RecordSaveReceipt>();
    const onSave = vi.fn().mockImplementationOnce(() => pending.promise)
      .mockImplementationOnce(async sent => ({ ...sent, version: 9 }));
    render(<RecordForm ref={ref} canSave kind="post" initial={initial} allowIncomplete onSave={onSave} />);
    let first!: Promise<EditorSaveOutcome>;
    act(() => { first = ref.current!.save(); });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await act(async () => {
      pending.resolve({ kind: "record-save-receipt", document: { ...initial, version: 8 },
        mintedIds: { "tmp-row": "saved-row", "tmp-child": "saved-child" } });
      await first;
      await ref.current!.save();
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1][0]).toMatchObject({ version: 8, blocks: [
      { id: "saved-row" }, { id: "saved-child", layout: { rowId: "saved-row", column: 0 } },
    ] });
  });

  it("returns a Page metadata receipt without inventing one from editable fields", async () => {
    const ref = createRef<RecordFormHandle>();
    const onSave = vi.fn(async (): Promise<RecordSaveReceipt> => ({ kind: "record-save-receipt", document: { title: "Home" }, mintedIds: {}, savedTarget: pageReceipt }));
    render(<RecordForm ref={ref} canSave kind="page" pageId="home" initial={{ title: "Home" }} allowIncomplete onSave={onSave} />);
    let result!: EditorSaveOutcome;
    await act(async () => { result = await ref.current!.save(); });
    expect(result.receipt).toEqual(pageReceipt);
  });

  it("does not turn a void mock save into an acknowledged version", async () => {
    const ref = createRef<RecordFormHandle>();
    render(<RecordForm ref={ref} canSave kind="post" initial={post} allowIncomplete onSave={async () => {}} />);
    let result!: EditorSaveOutcome;
    await act(async () => { result = await ref.current!.save(); });
    expect(result).toEqual({ capture: expect.any(Object), landed: true, clean: true });
  });

  it("shares a rejected save without replaying it, then permits a deliberate retry", async () => {
    const ref = createRef<RecordFormHandle>();
    const pending = deferred<Record<string, unknown>>();
    const onSave = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce({ ...post, version: 8 });
    render(<RecordForm ref={ref} canSave kind="post" initial={post} allowIncomplete onSave={onSave} />);
    let first!: Promise<EditorSaveOutcome>;
    let second!: Promise<EditorSaveOutcome>;
    act(() => { first = ref.current!.save(); second = ref.current!.save(); });
    expect(second).toBe(first);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await act(async () => { pending.reject(new Error("Connection interrupted")); });
    expect(await first).toEqual({ landed: false, clean: false });
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { expect((await ref.current!.save()).landed).toBe(true); });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it.each(["page", "post"])("retains permission checks for %s saves", async kind => {
    const onSave = vi.fn();
    if (kind === "page") {
      const ref = createRef<BlockEditorHandle>();
      render(<BlockEditor ref={ref} section="home" initialBlocks={blocks} onSave={onSave} canSave={false} />);
      expect(await ref.current!.save()).toEqual({ landed: false, clean: false });
    } else {
      const ref = createRef<RecordFormHandle>();
      render(<RecordForm ref={ref} kind="post" initial={post} allowIncomplete onSave={onSave} canSave={false} />);
      expect(await ref.current!.save()).toEqual({ landed: false, clean: false });
    }
    expect(onSave).not.toHaveBeenCalled();
  });

  it("makes repeated workspace save/exit requests await one page save", async () => {
    const pending = deferred<PageContent>();
    const saveRequestRef = { current: null as null | (() => Promise<ExitSaveOutcome>) };
    const savePage = vi.fn(() => pending.promise);
    render(<EditorWorkspace principal={{ id: "editor-1", grants: [{ role: "editor" }] }}
      surface={{ kind: "page", pageId: "home", section: "home" }}
      loadPage={async () => ({ blocks, version: 7, metadata: { title: "Home" }, status: "draft", createdBy: "editor-1" })}
      savePage={savePage} saveRequestRef={saveRequestRef} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit heading 1" }));
    fireEvent.change(await screen.findByDisplayValue("Original heading"), { target: { value: "Changed heading" } });
    let first!: Promise<ExitSaveOutcome>;
    let second!: Promise<ExitSaveOutcome>;
    act(() => { first = saveRequestRef.current!(); });
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    act(() => { second = saveRequestRef.current!(); });
    await act(async () => { pending.resolve({ blocks: [{ ...blocks[0], data: { text: "Changed heading", level: 2 } }], mintedIds: {}, version: 8, status: "draft" }); });
    expect(await first).toEqual({ status: "saved" });
    expect(await second).toEqual({ status: "saved" });
    expect(savePage).toHaveBeenCalledTimes(1);
  });
});
