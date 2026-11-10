import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordForm } from "../src/components/RecordForm";

afterEach(cleanup);
afterEach(() => localStorage.clear());
const initial = { title: "Transit changes", tags: [], blocks: [] };
const checkbox = () => screen.getByRole("checkbox", { name: "Spotlight News" });

describe("Spotlight News post setting", () => {
  it("defaults new and legacy posts to off in the sidebar", () => {
    const view = render(<RecordForm kind="post" onSave={() => {}} canSave />);
    expect(checkbox()).not.toBeChecked();
    view.unmount();
    render(<RecordForm kind="post" initial={initial} onSave={() => {}} canSave />);
    expect(checkbox()).not.toBeChecked();
    expect(checkbox().closest(".editor-bento-zone")).toHaveAttribute("data-zone", "side");
  });

  it("saves, reopens, and removes the attribution without changing title, topics, or byline", async () => {
    const onSave = vi.fn();
    const record = { ...initial, categories: ["Transit"], tags: ["rail"], credits: [{ kind: "custom", name: "Newsroom staff" }] };
    const view = render(<RecordForm kind="post" initial={record} onSave={onSave} canSave />);
    fireEvent.click(checkbox());
    expect(checkbox()).toBeChecked();
    expect(screen.getByText("NJ Spotlight News")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0][0];
    expect(saved).toMatchObject({ ...record, spotlightNews: true });
    view.unmount();
    onSave.mockClear();
    render(<RecordForm kind="post" initial={saved} onSave={onSave} canSave />);
    expect(checkbox()).toBeChecked();
    fireEvent.click(checkbox());
    expect(screen.queryByText("NJ Spotlight News")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].spotlightNews).toBe(false);
  });

  it("honors a read-only post", () => {
    render(<RecordForm kind="post" initial={{ ...initial, spotlightNews: true }} onSave={() => {}} canSave={false} readOnly />);
    expect(checkbox()).toBeChecked();
    expect(checkbox()).toBeDisabled();
  });
});
