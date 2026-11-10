import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentRowCanvas } from "../src/components/ContentRowCanvas";
import { createBlock } from "../src/lib/block-factory";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

function fixture() {
  const row = createBlock("row", "temporary-row");
  row.data = { columns: [6, 6] };
  const child = createBlock("prose", "child");
  child.order = 1;
  child.layout = { rowId: row.id, column: 0 };
  return {
    blocks: [row, child], palette: ["prose", "row"] as const,
    renderKey: (id: string) => id === "canonical-row" ? "temporary-row" : id,
    renderBlock: () => <input aria-label="Retained child" defaultValue="Draft" />,
    onInsert: vi.fn((): string | null => null), onMove: vi.fn(), onSplit: vi.fn(),
    onRemove: vi.fn(), onDuplicate: vi.fn(), onToggleVisible: vi.fn(),
  };
}

describe("row modal editing", () => {
  it("opens row settings deliberately and keeps child fields mounted when layout changes", () => {
    const props = fixture();
    const view = render(<ContentRowCanvas {...props} selectedBlockId="temporary-row" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const child = screen.getByRole("textbox", { name: "Retained child" });
    fireEvent.change(child, { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    const dialog = screen.getByRole("dialog", { name: "Row 1" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "One column" }));
    expect(props.onSplit).toHaveBeenCalledWith("temporary-row", [12]);
    props.blocks[0] = { ...props.blocks[0], data: { columns: [12] } };
    view.rerender(<ContentRowCanvas {...props} />);
    expect(screen.getByRole("textbox", { name: "Retained child" })).toBe(child);
    expect(child).toHaveValue("Unsaved");
    expect(within(dialog).getAllByRole("region")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(dialog).not.toHaveAttribute("open");
  });

  it("previews existing row content without another editor and preserves custom widths until a choice", () => {
    const props = fixture();
    props.blocks[0] = { ...props.blocks[0], data: { columns: [5, 7] } };
    props.blocks[1] = { ...props.blocks[1], data: { content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Retained river story" }] },
    ] } } };
    render(<ContentRowCanvas {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    const dialog = screen.getByRole("dialog", { name: "Row 1" });
    expect(within(dialog).getByText("Retained river story", { selector: "p" })).toBeVisible();
    expect(screen.getAllByRole("textbox", { name: "Retained child" })).toHaveLength(1);
    expect(props.onSplit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Wide right" }));
    expect(props.onSplit).toHaveBeenCalledWith("temporary-row", [4, 8]);
  });

  it("adds a plank from the row dialog when canvas insertion controls are hidden", () => {
    const props = fixture();
    props.onInsert.mockReturnValue("new-prose");
    render(<ContentRowCanvas {...props} hideInsertionControls />);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    const rowDialog = screen.getByRole("dialog", { name: "Row 1" });
    const column = within(rowDialog).getByRole("region", { name: "Column 2 settings" });

    fireEvent.click(within(column).getByRole("button", { name: "Add plank to column 2" }));
    const picker = screen.getByRole("dialog", { name: "Add content" });
    expect(within(picker).getByText("Row 1 › Column 2 · At end")).toBeVisible();
    fireEvent.click(within(picker).getByRole("radio", { name: "text" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Insert block" }));

    expect(props.onInsert).toHaveBeenCalledWith("prose", {
      layout: { rowId: "temporary-row", column: 1 },
    });
    expect(rowDialog).toHaveAttribute("open");
  });

  it("follows a row save receipt without remounting or losing the open dialog", () => {
    const props = fixture();
    const view = render(<ContentRowCanvas {...props} editRequest={{ id: "temporary-row", column: 1, sequence: 1 }} />);
    const dialog = screen.getByRole("dialog", { name: "Row 1" });
    expect(within(dialog).getByText("Content › Row 1 › Column 2")).toBeInTheDocument();
    props.blocks = props.blocks.map(block => block.type === "row" ? { ...block, id: "canonical-row" } : { ...block, layout: { rowId: "canonical-row", column: 0 } });
    view.rerender(<ContentRowCanvas {...props} editRequest={{ id: "canonical-row", column: 1, sequence: 1 }} />);
    expect(screen.getByRole("dialog", { name: "Row 1" })).toBe(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Hide row" }));
    expect(props.onToggleVisible).toHaveBeenCalledWith("canonical-row");
    view.rerender(<ContentRowCanvas {...props} readOnly />);
    expect(dialog).not.toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Edit row 1" })).toBeDisabled();
  });

  it("keeps row removal confirmation in the active modal", () => {
    const props = fixture();
    render(<ContentRowCanvas {...props} rowNotice={{ id: "temporary-row", content: <button>Confirm row removal</button> }} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1, column 2" }));
    const dialog = screen.getByRole("dialog", { name: "Row 1" });
    expect(within(dialog).getByRole("button", { name: "Confirm row removal" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate row 1, column 2" }));
    expect(props.onDuplicate).toHaveBeenCalledWith("temporary-row", 1);
  });
  it("moves a row using the filtered Home group list around Passport action", () => {
    const onMove = vi.fn();
    const passportCopy = { ...createBlock("prose", "passport-copy"), section: "home-passport-copy" };
    const passportAction = { ...createBlock("cta_row", "passport-action"), section: "home-passport-action" };
    const row = { ...createBlock("row", "row-1"), data: { columns: [12] } };
    const more = { ...createBlock("content_shelf", "home-more"), section: "home-more" };
    const extra = createBlock("prose", "after-more");
    render(<ContentRowCanvas
      blocks={[passportCopy, passportAction, row, more, extra].map((block, order) => ({ ...block, order }))}
      palette={["prose", "row"]}
      renderKey={(id) => id}
      renderBlock={() => null}
      onInsert={() => null}
      onMove={onMove}
      onSplit={vi.fn()}
      onRemove={vi.fn()}
      onDuplicate={vi.fn()}
      onToggleVisible={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    const dialog = screen.getByRole("dialog", { name: "Row 1" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move row up" }));
    expect(onMove).toHaveBeenCalledWith("row-1", { beforeId: "passport-copy" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move row down" }));
    expect(onMove).toHaveBeenCalledWith("row-1", { beforeId: "after-more" });
  });

  it("does not reopen a removed row when structural undo restores it", () => {
    const props = fixture();
    const view = render(<ContentRowCanvas {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit row 1" }));
    expect(screen.getByRole("dialog", { name: "Row 1" })).toBeInTheDocument();
    view.rerender(<ContentRowCanvas {...props} blocks={[]} />);
    view.rerender(<ContentRowCanvas {...props} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

});
