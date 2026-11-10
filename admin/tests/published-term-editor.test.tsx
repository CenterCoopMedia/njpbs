import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecordForm } from "../src/components/RecordForm";

afterEach(cleanup);

describe("Post published term suggestions", () => {
  it("offers published terms, saves their existing form, retains order and allows new terms", async () => {
    const load = vi.fn(async () => ({ tags: ["education", "elections"], categories: ["Schools"] }));
    const save = vi.fn();
    render(<StrictMode><RecordForm kind="post" canSave allowIncomplete
      initial={{ id: "post-1", title: "School board report", status: "draft", slug: "school-board-report", tags: ["format:interactive"], categories: [], blocks: [] }}
      loadPublishedVocabulary={load} onSave={save} /></StrictMode>);
    const tags = screen.getByRole("combobox", { name: "New tag" });
    expect(load).not.toHaveBeenCalled();
    fireEvent.focus(tags);
    fireEvent.change(tags, { target: { value: " Edu " } });
    const option = await screen.findByRole("option", { name: "education" });
    expect(option).toBeVisible();
    fireEvent.keyDown(tags, { key: "Escape" });
    expect(screen.queryByRole("option", { name: "education" })).not.toBeInTheDocument();
    expect(tags).toHaveValue(" Edu ");
    fireEvent.change(tags, { target: { value: "EDU" } });
    fireEvent.keyDown(tags, { key: "ArrowDown" });
    fireEvent.keyDown(tags, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove tag education" })).toBeVisible();
    expect(screen.getByText("education added.")).toBeVisible();
    fireEvent.change(tags, { target: { value: "Education" } });
    expect(screen.queryByRole("option", { name: "education" })).not.toBeInTheDocument();
    fireEvent.keyDown(tags, { key: "Enter" });
    expect(tags).toHaveValue("Education");
    expect(screen.getByText("education is already added.")).toBeVisible();
    fireEvent.change(tags, { target: { value: "new topic" } });
    fireEvent.keyDown(tags, { key: "Enter" });
    const categories = screen.getByRole("combobox", { name: "New category" });
    fireEvent.change(categories, { target: { value: "sch" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: "Schools" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toMatchObject({ tags: ["education", "new topic", "format:interactive"], categories: ["Schools"] });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps unfinished input on loading failure and allows manual entry", async () => {
    let reject!: (error: Error) => void;
    const load = () => new Promise<{tags: string[]; categories: string[]}>((_resolve, fail) => { reject = fail; });
    render(<RecordForm kind="post" canSave allowIncomplete loadPublishedVocabulary={load} onSave={() => {}} />);
    const tags = screen.getByRole("combobox", { name: "New tag" });
    fireEvent.focus(tags);
    fireEvent.change(tags, { target: { value: "unfinished" } });
    await waitFor(() => expect(reject).toBeDefined());
    expect(screen.queryByText("No matching suggestions.")).not.toBeInTheDocument();
    reject(new Error("network unavailable"));
    const notices = await screen.findAllByText("Published suggestions are unavailable. You can still add terms.");
    expect(notices.every(notice => notice.getAttribute("role") === "status")).toBe(true);
    expect(screen.queryByText("No matching suggestions.")).not.toBeInTheDocument();
    expect(tags).toHaveValue("unfinished");
    fireEvent.keyDown(tags, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove tag unfinished" })).toBeVisible();
  });

  it("prevents Enter on an empty term entry from submitting the Post", () => {
    const save = vi.fn();
    render(<RecordForm kind="post" canSave allowIncomplete onSave={save}
      loadPublishedVocabulary={async () => ({ tags: [], categories: [] })} />);
    const tags = screen.getByRole("combobox", { name: "New tag" });
    expect(fireEvent.keyDown(tags, { key: "Enter" })).toBe(false);
    expect(screen.getByText("Enter a tag first.")).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });

  it("commits every pasted term while keeping presentation markers separate", () => {
    render(<RecordForm kind="post" canSave allowIncomplete onSave={() => {}}
      initial={{ tags: ["format:interactive"], blocks: [] }}
      loadPublishedVocabulary={async () => ({ tags: [], categories: [] })} />);
    const tags = screen.getByRole("combobox", { name: "New tag" });
    fireEvent.paste(tags, { clipboardData: { getData: () => "format:multimedia, Housing" } });
    expect(screen.getByRole("button", { name: "Remove tag Housing" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Remove tag format:/ })).not.toBeInTheDocument();
    expect(tags).toHaveValue("");
    const categories = screen.getByRole("combobox", { name: "New category" });
    fireEvent.paste(categories, { clipboardData: { getData: () => "Schools, schools" } });
    expect(screen.getAllByRole("button", { name: "Remove category Schools" })).toHaveLength(1);
    expect(categories).toHaveValue("");
    expect(screen.queryByText(/already a tag/)).not.toBeInTheDocument();
  });
});
