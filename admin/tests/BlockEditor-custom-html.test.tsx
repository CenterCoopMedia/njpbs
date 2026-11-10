import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import type { AdminBlock } from "../src/lib/block-factory";

afterEach(() => { cleanup(); localStorage.clear(); });

function fixture(visible: boolean, inRow: boolean): AdminBlock[] {
  const html: AdminBlock = { id: "html-one", type: "html", order: 0, visible,
    data: { html: "<p>Results</p>", title: "Results" } };
  if (!inRow) return [html];
  return [
    { id: "row-one", type: "row", order: 0, visible: true, data: { columns: [6, 6] } },
    { ...html, order: 1, layout: { rowId: "row-one", column: 0 } },
    { id: "text-one", type: "prose", order: 2, visible: true,
      layout: { rowId: "row-one", column: 1 }, data: { content: { type: "doc", content: [
        { type: "paragraph", content: [{ type: "text", text: "Other content" }] },
      ] } } },
  ];
}

function mount(blocks: AdminBlock[], canEditCustomHtml: boolean) {
  const save = vi.fn();
  let nextId = 0;
  render(<BlockEditor section="post" initialBlocks={blocks} canEditCustomHtml={canEditCustomHtml}
    newId={() => `copy-${++nextId}`} onSave={save} />);
  return save;
}

function closeAndSave() {
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));
}

describe("custom HTML editor permissions", () => {
  it.each(["block", "row", "column"].flatMap(target => [true, false].map(visible => [target, visible] as const)))(
    "blocks %s duplication containing HTML with visible=%s without the publish grant", (target, visible) => {
      const blocks = fixture(visible, target !== "block");
      const save = mount(blocks, false);
      fireEvent.click(screen.getByRole("button", { name: target === "block" ? "Edit custom HTML 1" : "Edit row 1" }));
      const duplicate = screen.getByRole("button", { name: target === "block" ? "Duplicate custom HTML 1" : target === "row" ? "Duplicate row" : "Duplicate row 1, column 1" });
      expect(duplicate).toBeDisabled();
      fireEvent.click(duplicate);
      closeAndSave();
      expect(save).toHaveBeenCalledWith(blocks);
    },
  );

  it.each(["block", "row", "column"] as const)("allows publishers to duplicate an HTML %s", target => {
    const save = mount(fixture(false, target !== "block"), true);
    fireEvent.click(screen.getByRole("button", { name: target === "block" ? "Edit custom HTML 1" : "Edit row 1" }));
    const duplicate = screen.getByRole("button", { name: target === "block" ? "Duplicate custom HTML 1" : target === "row" ? "Duplicate row" : "Duplicate row 1, column 1" });
    expect(duplicate).toBeEnabled();
    fireEvent.click(duplicate);
    closeAndSave();
    expect(save).toHaveBeenCalledOnce();
    const saved = save.mock.calls[0][0] as AdminBlock[];
    expect(saved.filter(block => block.type === "html")).toHaveLength(2);
    expect(new Set(saved.map(block => block.id)).size).toBe(saved.length);
  });

  it("allows a contributor to duplicate a column without HTML in a mixed row", () => {
    const save = mount(fixture(true, true), false);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    const duplicate = screen.getByRole("button", { name: "Duplicate row 1, column 2" });
    expect(duplicate).toBeEnabled();
    fireEvent.click(duplicate);
    closeAndSave();
    expect(save).toHaveBeenCalledOnce();
    const saved = save.mock.calls[0][0] as AdminBlock[];
    expect(saved.filter(block => block.type === "html")).toEqual([fixture(true, true)[1]]);
    expect(saved.filter(block => block.type === "prose")).toHaveLength(2);
  });

  it("allows a contributor to duplicate a row without HTML", () => {
    const save = mount(fixture(true, true).filter(block => block.type !== "html").map((block, order) => ({ ...block, order })), false);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    const duplicate = screen.getByRole("button", { name: "Duplicate row" });
    expect(duplicate).toBeEnabled();
    fireEvent.click(duplicate);
    closeAndSave();
    expect(save.mock.calls[0][0].filter((block: AdminBlock) => block.type === "row")).toHaveLength(2);
  });

  it.each([false, true])("gates showing hidden HTML with canEditCustomHtml=%s", allowed => {
    const save = mount(fixture(false, false), allowed);
    fireEvent.click(screen.getByRole("button", { name: "Edit custom HTML 1" }));
    const show = screen.getByRole("button", { name: /Show on page/ });
    if (allowed) expect(show).toBeEnabled();
    else expect(show).toBeDisabled();
    fireEvent.click(show);
    closeAndSave();
    expect(save.mock.calls[0][0][0].visible).toBe(allowed);
  });

  it("allows a contributor to hide visible HTML", () => {
    const save = mount(fixture(true, false), false);
    fireEvent.click(screen.getByRole("button", { name: "Edit custom HTML 1" }));
    const hide = screen.getByRole("button", { name: /Hide from page/ });
    expect(hide).toBeEnabled();
    fireEvent.click(hide);
    closeAndSave();
    expect(save.mock.calls[0][0][0].visible).toBe(false);
  });
});


describe("custom HTML hidden-row controls", () => {
  it.each([[false, true], [true, true], [false, false], [true, false]] as const)(
    "gates showing a hidden row with publish=%s and HTML visible=%s", (publisher, htmlVisible) => {
      const blocks = fixture(htmlVisible, true);
      blocks[0].visible = false;
      const save = mount(blocks, publisher);
      fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
      const show = screen.getByRole("button", { name: "Show row" });
      const allowed = publisher || !htmlVisible;
      if (allowed) expect(show).toBeEnabled();
      else expect(show).toBeDisabled();
      fireEvent.click(show);
      closeAndSave();
      expect(save.mock.calls[0][0][0].visible).toBe(allowed);
    },
  );

  it.each([
    [false, "", false],
    [false, JSON.stringify({ rowId: "row-two", column: 0 }), false],
    [false, JSON.stringify({ rowId: "row-three", column: 0 }), true],
    [true, "", true],
  ] as const)("gates moving HTML out of a hidden row with publish=%s to %s", (publisher, destination, allowed) => {
    const blocks = fixture(true, true);
    blocks[0].visible = false;
    blocks.push(
      { id: "row-two", type: "row", order: 3, visible: true, data: { columns: [12] } },
      { id: "row-three", type: "row", order: 4, visible: false, data: { columns: [12] } },
    );
    const save = mount(blocks, publisher);
    const column = screen.getByRole("group", { name: "Row 1, column 1" });
    fireEvent.click(within(column).getByRole("button", { name: /^Move to…: custom HTML/ }));
    const dialog = screen.getByRole("dialog", { name: "Move custom HTML" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Destination" }), { target: { value: destination } });
    const move = within(dialog).getByRole("button", { name: "Move content" });
    if (allowed) expect(move).toBeEnabled();
    else expect(move).toBeDisabled();
    fireEvent.click(move);
    if (!allowed) fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    const savedHtml = (save.mock.calls[0][0] as AdminBlock[]).find(block => block.type === "html");
    const expectedLayout = allowed ? (destination ? JSON.parse(destination) : undefined) : { rowId: "row-one", column: 0 };
    expect(savedHtml?.layout).toEqual(expectedLayout);
  });
});
