import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTableGrid } from "../src/components/DataTableGrid";
import { parseDataTable, parseDataTableForEditing } from "../../packages/content-core/src/data-table";
import { serializeDataTable } from "../src/lib/data-table-grid";

function Editor({ initial = "County,Total\nMercer,10", save = vi.fn() }) {
  const [csv, setCsv] = useState(initial);
  return <DataTableGrid csv={csv} onChange={(next) => { setCsv(next); save(next); }} />;
}
afterEach(cleanup);

describe("Data table grid", () => {
  it("keeps incomplete headers and new rows editable while canonical validation rejects them", () => {
    const save = vi.fn();
    render(<Editor save={save} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Column 1 header" }), { target: { value: "" } });
    expect(screen.getByRole("textbox", { name: "Column 1 header" })).toHaveValue("");
    expect(() => parseDataTable(save.mock.lastCall![0])).toThrow("Give each column a header");
    fireEvent.change(screen.getByRole("textbox", { name: "Column 1 header" }), { target: { value: "County" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    expect(screen.getByRole("textbox", { name: "Row 2, column 1" })).toHaveValue("");
    expect(() => parseDataTable(save.mock.lastCall![0])).toThrow("Remove empty data rows");
    fireEvent.change(screen.getByRole("textbox", { name: "Row 2, column 1" }), { target: { value: "Essex" } });
    expect(parseDataTable(save.mock.lastCall![0]).rows).toEqual([["Mercer", "10"], ["Essex", ""]]);
  });

  it("preserves spaces during typing and serializes multiline quoted cell data", () => {
    const save = vi.fn();
    render(<Editor save={save} />);
    const cell = screen.getByRole("textbox", { name: "Row 1, column 1" });
    fireEvent.change(cell, { target: { value: '  Café, "NJ"\nSecond line  ' } });
    expect(cell).toHaveValue('  Café, "NJ"\nSecond line  ');
    expect(save.mock.lastCall![0]).toContain('"  Café, ""NJ""\nSecond line  "');
  });

  it("adds and removes columns and rows without moving their remaining data", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    expect(screen.getByRole("textbox", { name: "Column 3 header" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Row 1, column 3" })).toHaveValue("");
    fireEvent.focus(screen.getByRole("textbox", { name: "Column 1 header" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected column 1" }));
    expect(screen.getByRole("textbox", { name: "Column 1 header" })).toHaveValue("Total");
    expect(screen.getByRole("textbox", { name: "Row 1, column 1" })).toHaveValue("10");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Row 2, column 1" }), { target: { value: "20" } });
    fireEvent.focus(screen.getByRole("textbox", { name: "Row 1, column 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected row 1" }));
    expect(screen.getByRole("textbox", { name: "Row 1, column 1" })).toHaveValue("20");
  });

  it("opens an empty CSV as a two-column blank draft without writing it automatically", () => {
    const onChange = vi.fn();
    render(<DataTableGrid csv="" onChange={onChange} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Delete selected row 1" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("replaces local draft cells when an imported CSV arrives, and preserves invalid external CSV", () => {
    const onChange = vi.fn();
    const view = render(<DataTableGrid csv={"County\nMercer"} onChange={onChange} />);
    view.rerender(<DataTableGrid csv={'Name,Note\nEssex,"New, imported"'} onChange={onChange} />);
    expect(screen.getByRole("textbox", { name: "Row 1, column 2" })).toHaveValue("New, imported");
    view.rerender(<DataTableGrid csv={'County\n"Unclosed'} onChange={onChange} />);
    expect(screen.getByRole("status")).toHaveTextContent("Open Advanced CSV");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("enforces row and column bounds", () => {
    const onChange = vi.fn();
    const csv = serializeDataTable({ headers: Array.from({ length: 12 }, (_, index) => `Column ${index}`), rows: Array.from({ length: 100 }, () => Array(12).fill("Value")) });
    const view = render(<DataTableGrid csv={csv} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Add row" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add column" })).toBeDisabled();
    view.rerender(<DataTableGrid csv={"Header\nValue"} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Delete selected column 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete selected row 1" })).toBeDisabled();
  });

  it("clamps selected coordinates after an external replacement and keeps recovery actions available", () => {
    const onChange = vi.fn();
    const actions = <button>Upload CSV</button>;
    const view = render(<DataTableGrid csv={"A,B\n1,2\n3,4"} onChange={onChange} actions={actions} />);
    fireEvent.focus(screen.getByRole("textbox", { name: "Row 2, column 2" }));
    expect(screen.getByRole("button", { name: "Delete selected row 2" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete selected column 2" })).toBeEnabled();
    view.rerender(<DataTableGrid csv={"A\n1"} onChange={onChange} actions={actions} />);
    expect(screen.getByRole("button", { name: "Delete selected row 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete selected column 1" })).toBeDisabled();
    view.rerender(<DataTableGrid csv="Invalid" onChange={onChange} actions={actions} />);
    expect(screen.getByRole("button", { name: "Upload CSV" })).toBeEnabled();
  });

  it("keeps untouched whitespace and quoted CRLF after another cell is edited and the grid remounts", () => {
    const save = vi.fn();
    const original = ' Name ,Note\r\n"  Mercer  ","First\r\nsecond  "';
    const view = render(<Editor initial={original} save={save} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Column 2 header" }), { target: { value: "Updated note" } });
    const saved = save.mock.lastCall![0];
    const expected = { headers: [" Name ", "Updated note"], rows: [["  Mercer  ", "First\r\nsecond  "]] };
    expect(parseDataTableForEditing(saved)).toEqual(expected);
    view.unmount();
    render(<Editor initial={saved} save={save} />);
    expect(screen.getByRole("textbox", { name: "Row 1, column 1" })).toHaveValue("  Mercer  ");
    fireEvent.change(screen.getByRole("textbox", { name: "Column 2 header" }), { target: { value: "Note again" } });
    expect(parseDataTableForEditing(save.mock.lastCall![0])).toEqual({ ...expected, headers: [" Name ", "Note again"] });
  });

  it("rejects serialized CSV overflow including escaped quotes and keeps the last draft", () => {
    const save = vi.fn();
    const original = "x".repeat(79998);
    render(<Editor initial={`H\n${original}`} save={save} />);
    const cell = screen.getByRole("textbox", { name: "Row 1, column 1" });
    const edited = original.slice(0, -1) + '"';
    expect(edited.length).toBe(79998);
    expect(serializeDataTable({ headers: ["H"], rows: [[edited]] }).length).toBe(80003);
    fireEvent.change(cell, { target: { value: edited } });
    expect(screen.getByRole("alert")).toHaveTextContent("including quotation marks");
    expect(cell).toHaveValue(original);
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(cell, { target: { value: "Shorter value" } });
    expect(cell).toHaveValue("Shorter value");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(parseDataTable(save.mock.lastCall![0]).rows).toEqual([["Shorter value"]]);
  });

  it("can reduce a compact CSV at the character limit and delete a column", () => {
    const save = vi.fn();
    const value = "x".repeat(79994);
    const csv = `H,N\n${value},y`;
    expect(csv.length).toBe(80000);
    render(<Editor initial={csv} save={save} />);
    const cell = screen.getByRole("textbox", { name: "Row 1, column 1" });
    fireEvent.change(cell, { target: { value: value.slice(1) } });
    expect(cell).toHaveValue(value.slice(1));
    expect(save.mock.lastCall![0].length).toBe(79999);
    fireEvent.focus(screen.getByRole("textbox", { name: "Column 2 header" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected column 2" }));
    expect(parseDataTableForEditing(save.mock.lastCall![0])).toEqual({ headers: ["H"], rows: [[value.slice(1)]] });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("moves keyboard focus to the required header when adding a column", async () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Add column" }));
    const header = screen.getByRole("textbox", { name: "Column 3 header" });
    await waitFor(() => expect(header).toHaveFocus());
    fireEvent.change(document.activeElement!, { target: { value: "New header" } });
    expect(header).toHaveValue("New header");
    expect(screen.getByRole("textbox", { name: "Row 1, column 3" })).toHaveValue("");
  });

  it("keeps read-only cells and structure unchanged", () => {
    const onChange = vi.fn();
    render(<DataTableGrid csv={"Header\nValue"} readOnly onChange={onChange} />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    const cell = screen.getByRole("textbox", { name: "Row 1, column 1" });
    expect(cell).toHaveAttribute("readonly");
    fireEvent.change(cell, { target: { value: "Attempted edit" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
