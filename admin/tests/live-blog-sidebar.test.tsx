import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BlockEditor } from "../src/components/BlockEditor";
import { EditorWorkspaceViewProvider } from "../src/context/EditorWorkspaceView";
import { createBlock } from "../src/lib/block-factory";
import { blockEditorReducer, initialBlockEditorState } from "../src/lib/block-editor-state";
import { editContentRows } from "../src/lib/content-row-editing";
import { LIVE_BLOG_SIDEBAR } from "../../packages/content-core/src/live-blog-layout";
import { parseBlocks } from "../../packages/content-core/src/content-model";

afterEach(cleanup);
const plank = () => ({ ...createBlock("prose", "context"), data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Coverage resources" }] }] } } });

describe("live blog sidebar destination", () => {
  it("round-trips the existing block envelope and supports undo/redo without changing content", () => {
    const start = initialBlockEditorState([plank()]);
    const assigned = blockEditorReducer("post", start, { kind: "setLiveBlogSidebar", id: "context", sidebar: true });
    expect(assigned.blocks[0]).toEqual({ ...start.blocks[0], section: LIVE_BLOG_SIDEBAR });
    expect(parseBlocks(assigned.blocks).ok).toBe(true);
    const undone = blockEditorReducer("post", assigned, { kind: "undo" });
    expect(undone.blocks).toEqual(start.blocks);
    const redone = blockEditorReducer("post", undone, { kind: "redo" });
    expect(redone.blocks).toEqual(assigned.blocks);
    expect(blockEditorReducer("post", redone, { kind: "setLiveBlogSidebar", id: "context", sidebar: false }).blocks).toEqual(start.blocks);
  });

  it("preserves rich text typed after a destination change through page undo and redo", () => {
    const start = initialBlockEditorState([plank()]);
    const assigned = blockEditorReducer("post", start, { kind: "setLiveBlogSidebar", id: "context", sidebar: true });
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A newly written paragraph" }] }] };
    const typed = blockEditorReducer("post", assigned, { kind: "setData", id: "context", data: { content } });
    expect(typed.undo).toHaveLength(1);
    const undone = blockEditorReducer("post", typed, { kind: "undo" });
    expect(undone.blocks[0].section).toBeUndefined();
    expect(undone.blocks[0].data.content).toEqual(content);
    const redone = blockEditorReducer("post", undone, { kind: "redo" });
    expect(redone.blocks[0].section).toBe(LIVE_BLOG_SIDEBAR);
    expect(redone.blocks[0].data.content).toEqual(content);
  });

  it("refuses rows, row children, other page regions and non-Post destinations", () => {
    for (const block of [createBlock("row", "context"), { ...plank(), layout: { rowId: "row", column: 0 } }, { ...plank(), section: "home-start" }]) {
      const start = initialBlockEditorState([block]);
      expect(blockEditorReducer("post", start, { kind: "setLiveBlogSidebar", id: "context", sidebar: true })).toBe(start);
    }
    const start = initialBlockEditorState([plank()]);
    expect(blockEditorReducer("home", start, { kind: "setLiveBlogSidebar", id: "context", sidebar: true })).toBe(start);
  });

  it("reorders sidebar planks around an existing row and rejects nesting until reassigned", () => {
    const blocks = [createBlock("row", "row"), { ...plank(), section: LIVE_BLOG_SIDEBAR }, { ...plank(), id: "links", section: LIVE_BLOG_SIDEBAR }].map((block, order) => ({ ...block, order }));
    const moved = editContentRows("post", blocks, { kind: "move", id: "links", destination: { beforeId: "context" } });
    expect(moved.blocks.map(block => block.id)).toEqual(["row", "links", "context"]);
    expect(() => editContentRows("post", blocks, { kind: "move", id: "links", destination: { layout: { rowId: "row", column: 0 } } })).toThrow("Post body");
  });

  it("keeps sidebar controls target-specific and describes the destination separately", async () => {
    const blocks = [plank(), { ...plank(), id: "second", order: 1 }].map(block => ({ ...block, section: LIVE_BLOG_SIDEBAR }));
    const { unmount } = render(<BlockEditor section="post" liveBlogSidebar pageTitle="Election coverage" initialBlocks={blocks} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit text 2" }));
    const dialog = await screen.findByRole("dialog", { name: "text 2" });
    expect(within(dialog).getByText("Election coverage › Live updates sidebar › Text")).toBeVisible();
    unmount();
    render(<EditorWorkspaceViewProvider kind="post"><BlockEditor section="post" liveBlogSidebar initialBlocks={blocks} /></EditorWorkspaceViewProvider>);
    expect(screen.getByRole("button", { name: "Edit text 1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit text 2" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Coverage resources 1 actions" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Coverage resources 2 actions" })).toBeEnabled();
  });

  it("offers the destination only for a live blog's standalone plank and respects read-only", async () => {
    const { rerender } = render(<BlockEditor section="post" liveBlogSidebar initialBlocks={[plank()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit text 1" }));
    const select = await screen.findByRole("combobox", { name: /Destination/ });
    fireEvent.change(select, { target: { value: "sidebar" } });
    expect(select).toHaveValue("sidebar");
    rerender(<BlockEditor section="post" initialBlocks={[plank()]} />);
    expect(select).toHaveValue("sidebar");
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: "body" } });
    expect(select).toHaveValue("body");
    rerender(<BlockEditor section="post" liveBlogSidebar initialBlocks={[plank()]} readOnly />);
    expect(screen.getByRole("button", { name: "Edit text 1" })).toBeDisabled();
  });
});
