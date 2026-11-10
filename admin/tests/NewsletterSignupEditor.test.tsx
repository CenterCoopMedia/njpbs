import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewsletterSignupEditor } from "../src/components/NewsletterSignupEditor";
import { ContentShelfSources } from "../src/components/ContentShelfPicker";
import type { LibrarySelection } from "../src/lib/content-library";

afterEach(cleanup);

describe("Newsletter signup editor", () => {
  it("searches Newsletter records and selects at most four IDs", async () => {
    const result = { records: [
      { id: "weekly", kind: "newsletter", title: "Weekly", status: "draft" },
      { id: "archived", kind: "newsletter", title: "Old", status: "archived" },
    ], page: 1, pageCount: 1 } as LibrarySelection;
    const loadLibrarySelection = vi.fn().mockResolvedValue(result);
    const onChange = vi.fn();
    render(<ContentShelfSources.Provider value={{ loadLibrarySelection }}>
      <NewsletterSignupEditor data={{ newsletterIds: [] }} onChange={onChange} />
    </ContentShelfSources.Provider>);
    fireEvent.change(screen.getByRole("textbox", { name: "Find newsletters" }), { target: { value: "Weekly" } });
    fireEvent.click(screen.getByRole("button", { name: "Search newsletters" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Weekly" })).toBeTruthy());
    expect(loadLibrarySelection).toHaveBeenCalledWith(expect.objectContaining({ types: ["newsletter"], q: "Weekly" }));
    expect(screen.getByRole("button", { name: "Add Old" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Add Weekly" }));
    expect(onChange).toHaveBeenCalledWith({ newsletterIds: ["weekly"] }, true);
  });

  it("disables editing controls in read-only mode", () => {
    render(<NewsletterSignupEditor data={{ newsletterIds: ["weekly"] }} onChange={vi.fn()} readOnly />);
    expect(screen.getByRole("textbox", { name: "Heading" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Introduction" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Find newsletters" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search newsletters" })).toBeDisabled();
  });
});
