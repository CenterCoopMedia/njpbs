import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContentShelfSources } from "../src/components/ContentShelfPicker";
import { RecordPickerDialog } from "../src/components/RecordPickerDialog";

afterEach(cleanup);

describe("record picker", () => {
  it("searches, filters by kind and shows thumbnail and status", async () => {
    const loadLibrarySelection = vi.fn(async () => ({
      records: [{ id: "sponsor_1", kind: "sponsor", title: "Station supporter",
        status: "draft", thumbnailUrl: "https://example.org/logo.png" }],
      page: 1, pageCount: 1, total: 1,
    })) as any;
    const choose = vi.fn();
    render(<ContentShelfSources.Provider value={{ loadLibrarySelection }}>
      <RecordPickerDialog open onClose={() => {}} onChoose={choose} />
    </ContentShelfSources.Provider>);
    const dialog = screen.getByRole("dialog", { name: "Choose a record" });
    await waitFor(() => expect(within(dialog).getByText("Station supporter")).toBeVisible());
    expect(within(dialog).getByText("sponsor · draft")).toBeVisible();
    expect(dialog.querySelector("img")).toHaveAttribute("alt", "");
    fireEvent.change(within(dialog).getByLabelText("Record type"), { target: { value: "sponsor" } });
    fireEvent.change(within(dialog).getByLabelText("Search by title or name"), { target: { value: "Station" } });
    await waitFor(() => expect(loadLibrarySelection).toHaveBeenCalledWith(expect.objectContaining({
      types: ["sponsor"], q: "Station",
    })));
    fireEvent.click(within(dialog).getByRole("button", { name: /Station supporter/ }));
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ id: "sponsor_1" }));
  });
});
