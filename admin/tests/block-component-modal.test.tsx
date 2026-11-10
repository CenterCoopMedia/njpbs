import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockEditor, type BlockEditorHandle } from "../src/components/BlockEditor";
import type { AdminBlock } from "../src/lib/block-factory";

afterEach(() => localStorage.clear());

const blocks: AdminBlock[] = [
  { id: "heading", type: "headline", order: 0, visible: true, data: { text: "Current headline", level: 2 } },
  { id: "text", type: "prose", order: 1, visible: true, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Original story" }] }] } } },
];
function open(name = "heading 1") {
  const trigger = screen.getByRole("button", { name: `Edit ${name}` });
  trigger.focus();
  fireEvent.click(trigger);
  return screen.getByRole("dialog", { name });
}

describe("ordinary component modal", () => {
  it("starts compact, preserves the same fields on close, and saves the draft through its existing owner", async () => {
    const save = vi.fn();
    render(<BlockEditor section="genericPage" initialBlocks={blocks} onSave={save} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Heading" })).toBeNull();
    const dialog = open();
    const input = within(dialog).getByRole("textbox", { name: "Heading" });
    fireEvent.change(input, { target: { value: "Edited headline" } });
    fireEvent.change(within(dialog).getByLabelText("Heading level"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit heading 1" })).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
    expect(within(open()).getByRole("textbox", { name: "Heading" })).toBe(input);
    expect(input).toHaveValue("Edited headline");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save page" })); });
    expect(save).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: "heading", data: { text: "Edited headline", level: 3 } })]));
  });

  it("opens only on deliberate outline navigation, not default selection or focus", async () => {
    render(<BlockEditor section="genericPage" initialBlocks={blocks} />);
    screen.getByRole("region", { name: "heading" }).focus();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    fireEvent.click(await screen.findByRole("button", { name: "Go to text 2: Original story" }));
    expect(screen.getByRole("dialog", { name: "text 2" })).toBeVisible();
  });

  it("keeps text editor DOM and local history while closed", async () => {
    render(<BlockEditor section="genericPage" initialBlocks={blocks} />);
    const dialog = open("text 2");
    const text = within(dialog).getByRole("textbox", { name: "Body" });
    fireEvent.focus(text);
    await act(async () => {
      text.innerHTML = "<p>Edited story</p>";
      fireEvent.input(text);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    const reopened = open("text 2");
    expect(within(reopened).getByRole("textbox", { name: "Body" })).toBe(text);
    fireEvent.focus(text);
    const undo = within(reopened).getByRole("button", { name: "Undo" });
    expect(undo).toBeEnabled();
    await act(async () => { fireEvent.click(undo); });
    expect(text).toHaveTextContent("Original story");
  });

  it("closes on readonly and retains draft fields for the next permitted edit", () => {
    const view = render(<BlockEditor section="genericPage" initialBlocks={blocks} />);
    const input = within(open()).getByRole("textbox", { name: "Heading" });
    fireEvent.change(input, { target: { value: "Unsaved headline" } });
    view.rerender(<BlockEditor section="genericPage" initialBlocks={blocks} readOnly />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit heading 1" })).toBeDisabled();
    view.rerender(<BlockEditor section="genericPage" initialBlocks={blocks} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(open()).getByRole("textbox", { name: "Heading" })).toHaveValue("Unsaved headline");
  });

  it("keeps removal confirmation inside the modal and does not open the next block after removal", () => {
    render(<BlockEditor section="genericPage" initialBlocks={blocks} />);
    const dialog = open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove heading 1" }));
    expect(within(dialog).getByRole("button", { name: "Cancel removal of heading 1" })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm removal of heading 1" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit heading 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit text 1" })).toBeVisible();
  });
  it("does not replay an outline edit request when removal is undone", async () => {
    render(<BlockEditor section="genericPage" initialBlocks={blocks} />);
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    fireEvent.click(await screen.findByRole("button", { name: "Go to heading 1: Current headline" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal of heading 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo removal" }));
    expect(screen.getByRole("button", { name: "Edit heading 1" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to heading 1: Current headline" }));
    expect(screen.getByRole("dialog", { name: "heading 1" })).toBeVisible();
  });

  it("preserves the open editor and edits while adopting canonical save IDs", () => {
    const ref = createRef<BlockEditorHandle>();
    render(<BlockEditor ref={ref} section="genericPage" initialBlocks={blocks} />);
    const input = within(open()).getByRole("textbox", { name: "Heading" });
    fireEvent.change(input, { target: { value: "Changed during save" } });
    act(() => ref.current!.adoptSavedIds({ heading: "canonical-heading" }, blocks));
    expect(within(screen.getByRole("dialog", { name: "heading 1" })).getByRole("textbox", { name: "Heading" })).toBe(input);
    expect(input).toHaveValue("Changed during save");
    expect(input.closest(".block-card")).toHaveAttribute("id", "block-card-canonical-heading");
  });

  it("opens the first invalid block without opening other invalid blocks", () => {
    const ref = createRef<BlockEditorHandle>();
    render(<BlockEditor ref={ref} section="genericPage" initialBlocks={blocks.map(block => ({ ...block, data: {} }))} />);
    act(() => { expect(ref.current!.validateForPublication()).toBe(false); });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "heading 1" })).toBeVisible();
    expect(within(screen.getByRole("dialog", { name: "heading 1" })).getByRole("alert")).toBeVisible();
  });

});
