import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineBlockSurface } from "../src/components/InlineBlockSurface";
import { InlineDataTable } from "../src/components/InlineDataTable";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";

const initial: AdminBlock = { ...createBlock("data_table", "table-one"), data: {
  title: "County totals", csv: "County,Total\nMercer,10", source: "Original source", sourceHref: "",
} };

function csvFile(csv: string, read?: Promise<ArrayBuffer>) {
  const bytes = new TextEncoder().encode(csv);
  const file = new File([], "table.csv", { type: "text/csv" });
  Object.defineProperties(file, {
    size: { value: bytes.byteLength },
    arrayBuffer: { value: () => read ?? Promise.resolve(bytes.buffer) },
  });
  return file;
}
function choose(file: File) {
  fireEvent.change(screen.getByLabelText("Choose CSV file"), { target: { files: [file] } });
}
function deferred() {
  let resolve!: (bytes: ArrayBuffer) => void;
  const promise = new Promise<ArrayBuffer>((done) => { resolve = done; });
  return { promise, finish: (csv: string) => resolve(new TextEncoder().encode(csv).buffer) };
}
function Editor() {
  const [block, setBlock] = useState(initial);
  return <InlineDataTable block={block} onChange={(data) => setBlock({ ...block, data })} />;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Data table CSV actions", () => {
  it("imports quoted CSV into the current draft, counts, and preview", async () => {
    render(<Editor />);
    choose(csvFile('County,Total\n"Mercer, NJ",10\nEssex,20'));
    await screen.findByText("CSV imported. Review the table before saving.");
    expect(screen.getByRole("textbox", { name: "CSV data" })).toHaveValue('County,Total\n"Mercer, NJ",10\nEssex,20');
    expect(screen.getByText("2 rows · 2 columns")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Row 1, column 1" })).toHaveValue("Mercer, NJ");
    expect(screen.getByRole("textbox", { name: "Data source" })).toHaveValue("Original source");
  });

  it("keeps the current CSV when import fails", async () => {
    render(<Editor />);
    choose(csvFile('County\n"Unclosed'));
    expect(await screen.findByRole("alert")).toHaveTextContent("Close the quotation marks");
    expect(screen.getByRole("textbox", { name: "CSV data" })).toHaveValue(String(initial.data.csv));
  });

  it("does not replace a manual CSV edit with a delayed file", async () => {
    const pending = deferred();
    render(<Editor />);
    choose(csvFile("", pending.promise));
    fireEvent.change(screen.getByRole("textbox", { name: "CSV data" }), { target: { value: "Manual\nEdit" } });
    await act(async () => pending.finish("Old\nImport"));
    expect(screen.getByRole("textbox", { name: "CSV data" })).toHaveValue("Manual\nEdit");
    expect(screen.queryByText("CSV imported. Review the table before saving.")).not.toBeInTheDocument();
  });

  it("keeps the newest import when an earlier file completes later", async () => {
    const pending = deferred();
    render(<Editor />);
    choose(csvFile("", pending.promise));
    choose(csvFile("New\nImport"));
    await screen.findByText("CSV imported. Review the table before saving.");
    await act(async () => pending.finish("Old\nImport"));
    expect(screen.getByRole("textbox", { name: "CSV data" })).toHaveValue("New\nImport");
  });

  it("uses the latest callback and metadata when a file completes", async () => {
    const pending = deferred();
    const oldChange = vi.fn();
    const newChange = vi.fn();
    const view = render(<InlineDataTable block={initial} onChange={oldChange} />);
    choose(csvFile("", pending.promise));
    const changed = { ...initial, data: { ...initial.data, title: "Updated title", source: "Updated source" } };
    view.rerender(<InlineDataTable block={changed} onChange={newChange} />);
    await act(async () => pending.finish("New\nImport"));
    expect(oldChange).not.toHaveBeenCalled();
    expect(newChange).toHaveBeenCalledWith({ ...changed.data, csv: "New\nImport" }, true);
  });

  it.each(["disabled", "identity", "unmount"])("discards a pending file after %s", async (change) => {
    const pending = deferred();
    const onChange = vi.fn();
    const view = render(<fieldset><InlineDataTable block={initial} onChange={onChange} /></fieldset>);
    choose(csvFile("", pending.promise));
    if (change === "unmount") view.unmount();
    else view.rerender(<fieldset disabled={change === "disabled"}><InlineDataTable block={change === "identity" ? { ...initial, id: "other" } : initial} onChange={onChange} /></fieldset>);
    await act(async () => pending.finish("New\nImport"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancels a file through the real surface when permission is lost and restored", async () => {
    const pending = deferred();
    const onChange = vi.fn();
    const view = render(<InlineBlockSurface hasError={false} block={initial} onChange={onChange} readOnly={false} />);
    choose(csvFile("", pending.promise));
    expect(screen.getByText("Reading CSV file…")).toBeInTheDocument();
    view.rerender(<InlineBlockSurface hasError={false} block={initial} onChange={onChange} readOnly />);
    expect(screen.queryByText("Reading CSV file…")).not.toBeInTheDocument();
    view.rerender(<InlineBlockSurface hasError={false} block={initial} onChange={onChange} readOnly={false} />);
    await act(async () => pending.finish("Old\nImport"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("CSV imported. Review the table before saving.")).not.toBeInTheDocument();
    expect(screen.queryByText("Reading CSV file…")).not.toBeInTheDocument();
  });

  it("clears pending status when a replaced CSV causes the file to be ignored", async () => {
    const pending = deferred();
    const onChange = vi.fn();
    const view = render(<InlineDataTable block={initial} onChange={onChange} />);
    choose(csvFile("", pending.promise));
    view.rerender(<InlineDataTable block={{ ...initial, data: { ...initial.data, csv: "Other\nEdit" } }} onChange={onChange} />);
    await act(async () => pending.finish("Old\nImport"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Reading CSV file…")).not.toBeInTheDocument();
  });

  it("downloads the current valid CSV without requiring a title or changing data", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:table");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("data-table.csv");
      expect(this.href).toBe("blob:table");
    });
    const onChange = vi.fn();
    render(<InlineDataTable block={{ ...initial, data: { ...initial.data, title: "" } }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:table"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([false, true])("requires formula export confirmation (confirmed: %s)", async (confirmed) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(confirmed);
    const createObjectURL = vi.fn().mockReturnValue("blob:formula-table");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const csv = 'Value\n"  =1+1"';
    const onChange = vi.fn();
    render(<InlineDataTable block={{ ...initial, data: { ...initial.data, csv } }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Export the original CSV anyway?"));
    expect(click).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(createObjectURL).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    if (confirmed) {
      const blob = createObjectURL.mock.calls[0][0] as Blob;
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blob);
      });
      expect(text).toBe(csv);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables export when CSV is invalid", () => {
    render(<InlineDataTable block={{ ...initial, data: { ...initial.data, csv: "Header" } }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });
});
