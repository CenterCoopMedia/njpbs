import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AddContent } from "../src/components/ContentPicker";
import { allowedBlocksForSection } from "../../packages/content-core/src/editor-admin";
import { createBlock } from "../src/lib/block-factory";

afterEach(cleanup);

describe("contextual content picker", () => {
  it("requires one explicit choice and inserts it only once", () => {
    const insert = vi.fn(() => "new-image");
    render(<AddContent blocks={[]} palette={allowedBlocksForSection("post")} destination={{}} onInsert={insert} />);
    const trigger = screen.getByRole("button", { name: "Add content" });
    fireEvent.click(trigger);

    const picker = screen.getByRole("dialog", { name: "Add content" });
    expect(within(picker).getByPlaceholderText("Search content types")).toHaveFocus();
    expect(within(picker).getByRole("button", { name: "Insert block" })).toBeDisabled();
    const image = within(picker).getByRole("radio", { name: "image" });
    expect(image).not.toBeChecked();
    fireEvent.click(image);
    expect(insert).not.toHaveBeenCalled();

    const commit = within(picker).getByRole("button", { name: "Insert block" });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    fireEvent.click(commit);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith("image", {});
    expect(screen.queryByRole("dialog", { name: "Add content" })).toBeNull();
  });

  it("shows the actual Post palette and explains unavailable choices", () => {
    const row = { ...createBlock("row", "row"), data: { columns: [6, 6] } };
    render(<AddContent blocks={[row]} palette={allowedBlocksForSection("post")} destination={{ layout: { rowId: "row", column: 1 } }} onInsert={() => "new"} />);
    fireEvent.click(screen.getByRole("button", { name: "Add plank to column 2" }));
    const picker = screen.getByRole("dialog", { name: "Add content" });
    expect(within(picker).getByText("Row 1 › Column 2 · At end")).toBeVisible();
    const types = within(picker).getByRole("radiogroup", { name: "Content types" });
    expect(within(types).getAllByRole("radio")).toHaveLength(19);
    expect(within(types).getByRole("radio", { name: "support appeal" })).toBeEnabled();
    expect(within(types).getByRole("radio", { name: "uploaded video" })).toBeEnabled();
    expect(within(types).getByRole("radio", { name: "bio card" })).toBeEnabled();
    expect(within(types).getByRole("radio", { name: "data figure" })).toBeEnabled();
    expect(within(types).getByRole("radio", { name: "election results" })).toBeEnabled();
    expect(within(types).getByRole("radio", { name: "Program, event, sponsor, or newsletter" })).toBeInTheDocument();
    expect(within(types).getByRole("radio", { name: "sponsor strip" })).toBeInTheDocument();
    expect(within(types).getByRole("radio", { name: "newsletter signup" })).toBeInTheDocument();
    expect(within(types).getByRole("radio", { name: "divider" })).toBeDisabled();
    expect(within(types).getByRole("radio", { name: "manual content shelf" })).toHaveAccessibleDescription(
      "Programs or pages you pick by hand and order yourself.",
    );
    expect(picker).toHaveTextContent("Dividers are only available outside rows or inside a one-column row.");
    expect(within(picker).getByRole("status")).toHaveTextContent("19 types match");
  });

  it("clears a choice when search hides it", () => {
    render(<AddContent blocks={[]} palette={["image", "divider"]} destination={{}} onInsert={() => "new"} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    const picker = screen.getByRole("dialog", { name: "Add content" });
    fireEvent.click(within(picker).getByRole("radio", { name: "image" }));
    fireEvent.change(within(picker).getByPlaceholderText("Search content types"), { target: { value: "divider" } });
    expect(within(picker).getByRole("status")).toHaveTextContent("1 type matches");
    expect(within(picker).getByRole("button", { name: "Insert block" })).toBeDisabled();
    fireEvent.change(within(picker).getByPlaceholderText("Search content types"), { target: { value: "" } });
    expect(within(picker).getByRole("radio", { name: "image" })).not.toBeChecked();
  });

  it("clears a choice removed from the palette", () => {
    const props = { blocks: [], destination: {}, onInsert: () => "new" };
    const view = render(<AddContent {...props} palette={["image", "prose"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    fireEvent.click(screen.getByRole("radio", { name: "image" }));
    view.rerender(<AddContent {...props} palette={["prose"]} />);
    expect(screen.queryByRole("radio", { name: "image" })).toBeNull();
    expect(screen.getByRole("button", { name: "Insert block" })).toBeDisabled();
    view.rerender(<AddContent {...props} palette={["image", "prose"]} />);
    expect(screen.getByRole("radio", { name: "image" })).not.toBeChecked();
  });

  it("revalidates a held anchor and never appends after it disappears", () => {
    const insert = vi.fn(() => "new");
    const text = createBlock("prose", "body");
    const props = { palette: ["image"] as const, destination: { beforeId: text.id }, onInsert: insert };
    const view = render(<AddContent {...props} blocks={[text]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    fireEvent.click(screen.getByRole("radio", { name: "image" }));
    view.rerender(<AddContent {...props} blocks={[]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This destination has changed");
    expect(screen.getByRole("button", { name: "Insert block" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    expect(insert).not.toHaveBeenCalled();
  });

  it("keeps the destination that opened the picker when the trigger moves", () => {
    const insert = vi.fn(() => "new");
    const first = createBlock("prose", "first");
    const second = createBlock("prose", "second");
    const props = { blocks: [first, second], palette: ["image"] as const, onInsert: insert };
    const view = render(<AddContent {...props} destination={{ beforeId: first.id }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    view.rerender(<AddContent {...props} destination={{ beforeId: second.id }} />);
    fireEvent.click(screen.getByRole("radio", { name: "image" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    expect(insert).toHaveBeenCalledWith("image", { beforeId: first.id });
  });

  it("revalidates read-only and placement changes before commit", () => {
    const insert = vi.fn(() => "new");
    const row = { ...createBlock("row", "row"), data: { columns: [12] } };
    const props = { palette: ["divider"] as const, destination: { layout: { rowId: "row", column: 0 } }, onInsert: insert };
    const view = render(<AddContent {...props} blocks={[row]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add plank to column 1" }));
    const divider = screen.getByRole("radio", { name: "divider" });
    fireEvent.click(divider);
    view.rerender(<AddContent {...props} blocks={[row]} readOnly />);
    expect(screen.getByRole("button", { name: "Insert block" })).toBeDisabled();
    view.rerender(<AddContent {...props} blocks={[{ ...row, data: { columns: [6, 6] } }]} />);
    expect(divider).toBeDisabled();
    expect(screen.getByRole("button", { name: "Insert block" })).toBeDisabled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("keeps the failed commit locked until the picker reopens", () => {
    const insert = vi.fn(() => null);
    render(<AddContent blocks={[]} palette={["image", "prose"]} destination={{}} allowRows onInsert={insert} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    fireEvent.click(screen.getByRole("radio", { name: "image" }));
    const commit = screen.getByRole("button", { name: "Insert block" });
    fireEvent.click(commit);
    fireEvent.click(commit);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Add content" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "image" })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("could not be inserted");
    expect(commit).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add row" })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Search content types"), { target: { value: "text" } });
    fireEvent.click(screen.getByRole("radio", { name: "text" }));
    expect(screen.getByRole("alert")).toHaveTextContent("could not be inserted");
    expect(commit).toBeDisabled();
    expect(insert).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled();
  });

  it("keeps Add row as a separate secondary command", () => {
    const insert = vi.fn(() => "new-row");
    render(<AddContent blocks={[]} palette={["image"]} destination={{}} allowRows onInsert={insert} />);
    fireEvent.click(screen.getByRole("button", { name: "Add content" }));
    fireEvent.change(screen.getByPlaceholderText("Search content types"), { target: { value: "columns" } });
    expect(screen.getByRole("status")).toHaveTextContent("0 types match; 1 row command matches.");
    expect(screen.queryByRole("radio", { name: "row" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(insert).toHaveBeenCalledWith("row", {});
    expect(screen.queryByRole("dialog", { name: "Add content" })).toBeNull();
  });

  it("does not widen a route palette or offer a nested row", () => {
    const row = createBlock("row", "row");
    render(<AddContent blocks={[row]} palette={["image"]} destination={{ layout: { rowId: row.id, column: 0 } }} allowRows onInsert={() => "new"} />);
    fireEvent.click(screen.getByRole("button", { name: "Add plank to column 1" }));
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "image" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
  });

  it("returns focus to the trigger after Close, Cancel and Escape", () => {
    const insert = vi.fn(() => "new");
    render(<AddContent blocks={[]} palette={["image"]} destination={{}} onInsert={insert} />);
    const trigger = screen.getByRole("button", { name: "Add content" });
    for (const close of [
      () => fireEvent.click(screen.getByRole("button", { name: "Close content picker" })),
      () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
      () => fireEvent(screen.getByRole("dialog", { name: "Add content" }), new Event("cancel", { bubbles: true, cancelable: true })),
    ]) {
      fireEvent.click(trigger);
      close();
      expect(screen.queryByRole("dialog", { name: "Add content" })).toBeNull();
      expect(trigger).toHaveFocus();
    }
    expect(insert).not.toHaveBeenCalled();
  });
});
