import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { BlockEditor } from "../src/components/BlockEditor";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";

afterEach(() => { cleanup(); localStorage.clear(); });

function text(id: string): AdminBlock {
  return { ...createBlock("prose", id), data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: id }] }] } } };
}
function ordered(blocks: AdminBlock[]) { return blocks.map((block, order) => ({ ...block, order })); }
function canvas(container: HTMLElement) { return container.querySelector<HTMLElement>(".content-row-canvas")!; }
function plankOrder(container: HTMLElement) {
  return [...canvas(container).querySelectorAll(".block-card")].map(element => element.id.replace("block-card-", ""));
}
function transfer() { return { setData: vi.fn(), effectAllowed: "", dropEffect: "" }; }

describe("content reorder grips", () => {
  it.each(["post", "genericPage"] as const)("moves a %s plank by keyboard, retains focus, and keeps draft undo and failed saves", async section => {
    const save = vi.fn(async () => { throw new Error("Save unavailable"); });
    const { container } = render(<BlockEditor section={section} initialBlocks={ordered([text("first"), text("second")])} commandsInline onSave={save} />);
    const grip = within(canvas(container)).getByRole("button", { name: "Move: text plank 1" });
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(plankOrder(container)).toEqual(["second", "first"]);
    expect(grip).toHaveFocus();
    expect(within(canvas(container)).getByRole("status")).toHaveTextContent("moved to position 2 of 2");
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await screen.findByText("Save unavailable");
    expect(plankOrder(container)).toEqual(["second", "first"]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(plankOrder(container)).toEqual(["first", "second"]);
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(plankOrder(container)).toEqual(["second", "first"]);
  });

  it("cancels a pointer move without changing content and rejects a drop in another column", () => {
    const initial = ordered([
      { ...createBlock("row", "span"), data: { columns: [6, 6] } },
      { ...text("left"), layout: { rowId: "span", column: 0 } },
      { ...text("right"), layout: { rowId: "span", column: 1 } },
    ]);
    const { container } = render(<BlockEditor section="post" initialBlocks={initial} commandsInline />);
    const surface = canvas(container);
    const grip = within(surface).getByRole("button", { name: "Move: text plank 2" });
    const target = surface.querySelector<HTMLElement>('[data-reorder-item="right"]')!;
    fireEvent.dragStart(grip, { dataTransfer: transfer() });
    fireEvent.dragOver(target, { dataTransfer: transfer(), clientY: 10 });
    expect(target).not.toHaveAttribute("data-reorder-drop");
    fireEvent.drop(target, { dataTransfer: transfer(), clientY: 10 });
    expect(within(surface).getByRole("status")).toHaveTextContent("No valid drop position");
    expect(plankOrder(container)).toEqual(["left", "right"]);
    fireEvent.dragStart(grip, { dataTransfer: transfer() });
    fireEvent.keyDown(grip, { key: "Escape" });
    expect(within(surface).getByRole("status")).toHaveTextContent("Move canceled. Order unchanged.");
    expect(grip).toHaveFocus();
    expect(plankOrder(container)).toEqual(["left", "right"]);
    // Releasing a native drag outside any drop target must also end its announcement.
    fireEvent.dragStart(grip, { dataTransfer: transfer() });
    fireEvent.dragEnd(grip);
    expect(within(surface).getByRole("status")).toHaveTextContent("Move canceled. Order unchanged.");
    expect(grip).toHaveFocus();
    expect(plankOrder(container)).toEqual(["left", "right"]);
  });

  it("moves a whole span to a distant outline position and undoes the move with children intact", async () => {
    // Force a scheduler yield before passive effects, as on a busy runner.
    let now = performance.now();
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now += 6);
    try {
      const initial = ordered([
        { ...createBlock("row", "span"), data: { columns: [12] } },
        { ...text("child"), layout: { rowId: "span", column: 0 } },
        text("middle"), text("last"),
      ]);
      const draft = vi.fn();
      const { container } = render(<BlockEditor section="post" initialBlocks={initial} commandsInline onDraftChange={draft} />);
      fireEvent.click(screen.getByRole("button", { name: "Outline" }));
      const outline = (await screen.findByRole("navigation", { name: "Content outline" }));
      const grip = within(outline).getByRole("button", { name: "Move: Span 1 in content outline" });
      const target = within(outline).getByRole("button", { name: /Go to text 4:/ }).closest("li")!;
      fireEvent.dragStart(grip, { dataTransfer: transfer() });
      expect(grip).toHaveAttribute("aria-pressed", "true");
      // Native HTML drag takes over the mouse pointer without canceling the move.
      fireEvent.pointerCancel(grip, { pointerType: "mouse" });
      // jsdom has no DragEvent coordinates; supply the pointer position at the browser boundary.
      const hover = createEvent.dragOver(target, { dataTransfer: transfer() });
      Object.defineProperty(hover, "clientY", { value: 10 });
      fireEvent(target, hover);
      expect(target).toHaveAttribute("data-reorder-drop", "after");
      const drop = createEvent.drop(target, { dataTransfer: transfer() });
      Object.defineProperty(drop, "clientY", { value: 10 });
      fireEvent(target, drop);
      expect(plankOrder(container)).toEqual(["middle", "last", "child"]);
      expect((draft.mock.calls.at(-1)?.[0] as AdminBlock[]).map(block => block.id)).toEqual(["middle", "last", "span", "child"]);
      expect((draft.mock.calls.at(-1)?.[0] as AdminBlock[]).at(-1)?.layout).toEqual({ rowId: "span", column: 0 });
      expect(grip).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(plankOrder(container)).toEqual(["child", "middle", "last"]);
    } finally {
      clock.mockRestore();
    }
  });

  it("drops a whole span onto another span's nested plank and undoes with both sets of children intact", () => {
    const initial = ordered([
      { ...createBlock("row", "first-span"), data: { columns: [12] } },
      { ...text("first-child"), layout: { rowId: "first-span", column: 0 } },
      { ...createBlock("row", "second-span"), data: { columns: [12] } },
      { ...text("second-child"), layout: { rowId: "second-span", column: 0 } },
    ]);
    const draft = vi.fn();
    const { container } = render(<BlockEditor section="post" initialBlocks={initial} commandsInline onDraftChange={draft} />);
    const surface = canvas(container);
    const grip = within(surface).getByRole("button", { name: "Move: Span 1" });
    expect(within(surface).getByRole("button", { name: "Add plank here: position 2" })).toBeEnabled();
    expect(within(surface).getByRole("button", { name: "Add plank here: position 4" })).toBeEnabled();
    const nestedPlank = within(surface).getByText("second-child", { selector: ".block-preview-content p" });
    const span = nestedPlank.closest(".content-row-editor")!;
    const dataTransfer = transfer();
    fireEvent.dragStart(grip, { dataTransfer });
    const hover = createEvent.dragOver(nestedPlank, { dataTransfer });
    Object.defineProperty(hover, "clientY", { value: 10 });
    fireEvent(nestedPlank, hover);
    expect(span).toHaveAttribute("data-reorder-drop", "after");
    const drop = createEvent.drop(nestedPlank, { dataTransfer });
    Object.defineProperty(drop, "clientY", { value: 10 });
    fireEvent(nestedPlank, drop);
    expect(plankOrder(container)).toEqual(["second-child", "first-child"]);
    const moved = draft.mock.calls.at(-1)?.[0] as AdminBlock[];
    expect(moved.map(block => block.id)).toEqual(["second-span", "second-child", "first-span", "first-child"]);
    expect(moved.filter(block => block.layout).map(block => block.layout)).toEqual([
      { rowId: "second-span", column: 0 }, { rowId: "first-span", column: 0 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(plankOrder(container)).toEqual(["first-child", "second-child"]);
    expect(draft.mock.calls.at(-1)?.[0]).toEqual(initial);
  });

  it("keeps placement in the block header and insertion at gaps", () => {
    const { container } = render(<BlockEditor section="post" initialBlocks={ordered([text("first"), text("second")])} commandsInline />);
    const surface = canvas(container);
    const header = surface.querySelector(".block-card-head") as HTMLElement;
    expect(surface.querySelector(".content-block-arrange")).toBeNull();
    expect(within(header).queryByRole("button", { name: /Add/ })).not.toBeInTheDocument();
    expect(within(surface).getAllByRole("button", { name: /^Add content: position/ })).toHaveLength(3);
    fireEvent.click(within(header).getByRole("button", { name: "Move to…: text 1" }));
    const dialog = screen.getByRole("dialog", { name: "Move text" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move content" }));
    expect(plankOrder(container)).toEqual(["second", "first"]);
  });

  it("keeps the fixed Home Passport action grip disabled and named without starting a move", async () => {
    const draft = vi.fn();
    const initial = homeCompositionDefaults() as AdminBlock[];
    const { container } = render(<BlockEditor section="home" pageId="home" homeCompositionVersion={1}
      initialBlocks={initial} commandsInline onDraftChange={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = (await screen.findByRole("navigation", { name: "Content outline" }));
    const actionRow = within(outline).getByRole("button", { name: /^Go to buttons 4:/ }).closest("li")!;
    const grip = within(actionRow).getByRole("button", { name: "Move: buttons 4 in content outline" });
    expect([...outline.querySelectorAll(".block-outline-position")].map(node => node.textContent))
      .toEqual([...canvas(container).querySelectorAll(".block-card-index")].map(node => node.textContent));
    for (const control of within(actionRow).getAllByRole("button", { name: /^Move/ })) {
      expect(control).toBeDisabled();
    }
    expect(within(actionRow).getByRole("button", { name: /^Move up:/ }))
      .toHaveAccessibleDescription(/original layout.*editorial layout/);
    expect(grip).toHaveAttribute("draggable", "false");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    fireEvent.dragStart(grip, { dataTransfer: transfer() });
    expect(grip).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector('[data-reorder-dragging="true"]')).toBeNull();
    for (const status of screen.getAllByRole("status")) expect(status).not.toHaveTextContent(/undefined|grabbed|moved to position/);
    expect(draft).not.toHaveBeenCalled();
  });

  it("uses visible span numbers for mixed outline content before and after a keyboard move", async () => {
    const initial = ordered([
      text("introduction"),
      { ...createBlock("row", "first-span"), data: { columns: [12] } },
      { ...text("first-child"), layout: { rowId: "first-span", column: 0 } },
      { ...createBlock("row", "second-span"), data: { columns: [12] } },
      { ...text("second-child"), layout: { rowId: "second-span", column: 0 } },
    ]);
    const { container } = render(<BlockEditor section="post" initialBlocks={initial} commandsInline />);
    const expectRowMoveName = (number: number) => {
      fireEvent.click(within(canvas(container)).getByRole("button", { name: `Edit row ${number}` }));
      const settings = screen.getByRole("dialog", { name: `Row ${number}` });
      expect(within(settings).getByRole("button", { name: `Move to…: row ${number}` })).toBeEnabled();
      fireEvent.click(within(settings).getByRole("button", { name: "Done" }));
    };
    expectRowMoveName(2);
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = (await screen.findByRole("navigation", { name: "Content outline" }));
    for (const number of [1, 2]) {
      expect(within(outline).getByRole("button", { name: `Move: Span ${number} in content outline` })).toBeEnabled();
      expect(within(canvas(container)).getByRole("button", { name: `Move: Span ${number}` })).toBeEnabled();
    }
    const grip = within(outline).getByRole("button", { name: "Move: Span 1 in content outline" });
    grip.focus();
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(plankOrder(container)).toEqual(["introduction", "second-child", "first-child"]);
    expect(grip).toHaveAccessibleName("Move: Span 2 in content outline");
    expect(grip).toHaveFocus();
    expect(within(screen.getByText("Content outline", { selector: "h2" }).closest("section")!).getByRole("status"))
      .toHaveTextContent("Span 2 in content outline moved to position 3 of 3.");
    expect(within(canvas(container)).getByRole("region", { name: "Row 2" }))
      .toHaveAttribute("id", "block-card-first-span");
    expectRowMoveName(2);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(plankOrder(container)).toEqual(["introduction", "first-child", "second-child"]);
    expect(grip).toHaveAccessibleName("Move: Span 1 in content outline");
    expect(within(canvas(container)).getByRole("region", { name: "Row 1" }))
      .toHaveAttribute("id", "block-card-first-span");
  });

  it("keeps fixed planks and read-only content locked", async () => {
    const fixed = { ...text("fixed"), section: "intro" };
    const { container, rerender } = render(<BlockEditor section="genericPage" initialBlocks={ordered([fixed, text("free")])} commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = (await screen.findByRole("navigation", { name: "Content outline" }));
    expect(within(outline).getByRole("button", { name: "Move: text 1 in content outline" })).toBeDisabled();
    rerender(<BlockEditor section="genericPage" initialBlocks={ordered([fixed, text("free")])} commandsInline readOnly />);
    expect(within(canvas(container)).queryByRole("button", { name: /^Move: text plank/ })).not.toBeInTheDocument();
    expect(within(outline).getByRole("button", { name: "Move: text 2 in content outline" })).toBeDisabled();
  });
});
