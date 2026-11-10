import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RecordForm } from "../src/components/RecordForm";
import { EditorWorkspaceViewProvider } from "../src/context/EditorWorkspaceView";
import { createLocalBentoStore } from "../src/lib/editor-bento-store";

afterEach(() => { cleanup(); localStorage.clear(); });
const choices = [{ id: "watch", label: "Watch" }, { id: "support", label: "Support" }];

describe("Post Area discovery", () => {
  it.each([false, true])("keeps Area beside the title after an old collapsed access layout (workspace %s)", workspace => {
    createLocalBentoStore().save("post", [
      { id: "post-title", zone: "main", collapsed: false },
      { id: "post-body", zone: "main", collapsed: false },
      { id: "editing-access", zone: "side", collapsed: true },
    ]);
    const form = <RecordForm kind="post" initial={{ title: "A draft", blocks: [] }}
      onSave={() => {}} canSave sections={choices} />;
    render(workspace ? <EditorWorkspaceViewProvider kind="post">{form}</EditorWorkspaceViewProvider> : form);
    const area = screen.getByRole("combobox", { name: /^Area/ });
    expect(area).toBeVisible();
    expect(area.closest('[data-panel-id="post-title"]')).toContainElement(area);
    expect(area).toHaveValue("");
  });

  it("chooses the sole registered Area for a new Post and saves it", async () => {
    const save = vi.fn();
    const draft = vi.fn();
    render(<RecordForm kind="post" initial={{ title: "A draft", blocks: [] }} initialIsClean
      onSave={save} onDraftChange={draft} canSave allowIncomplete sections={[choices[0]]} />);
    expect(screen.getByRole("combobox", { name: /^Area/ })).toHaveValue("watch");
    expect(draft).not.toHaveBeenCalledWith(expect.objectContaining({ section: "watch" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ section: "watch" })));
  });

  it.each([1, 2])("waits for the live permitted list before choosing among %s Areas", count => {
    const draft = vi.fn();
    const form = (permitted: typeof choices | null) => <RecordForm kind="post" initial={{ title: "A draft", blocks: [] }}
      onSave={() => {}} onDraftChange={draft} canSave sections={choices} newPostSections={permitted} />;
    const view = render(form(null));
    expect(screen.getByRole("combobox", { name: /^Area/ })).toHaveValue("");
    view.rerender(form(choices.slice(0, count)));
    expect(screen.getByRole("combobox", { name: /^Area/ })).toHaveValue(count === 1 ? "watch" : "");
    expect(draft).not.toHaveBeenCalledWith(expect.objectContaining({ section: "watch" }));
  });

  it("keeps an explicit choice and stored Area labels separate from permitted defaults", () => {
    const view = render(<RecordForm kind="post" initial={{ title: "Draft", section: "support", blocks: [] }}
      onSave={() => {}} canSave sections={choices} newPostSections={[choices[0]]} />);
    expect(screen.getByRole("combobox", { name: /^Area/ })).toHaveValue("support");
    view.unmount();
    render(<RecordForm kind="post" initial={{ id: "post-1", section: "custom", blocks: [] }}
      onSave={() => {}} canSave sections={[...choices, { id: "custom", label: "Custom live Area" }]} newPostSections={[]} />);
    expect(screen.getByTestId("record-section-display")).toHaveTextContent("Custom live Area");
  });

  it("waits for a choice when several Areas exist and saves the selected one", async () => {
    const save = vi.fn();
    render(<RecordForm kind="post" initial={{ title: "A draft", blocks: [] }}
      onSave={save} canSave allowIncomplete sections={choices} />);
    const area = within(screen.getByRole("region", { name: "Main area" })).getByRole("combobox", { name: /^Area/ });
    expect(area).toHaveValue("");
    fireEvent.change(area, { target: { value: "support" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ section: "support" })));
  });

  it("preserves an explicit new-Post Area and an unassigned stored draft", () => {
    const form = render(<RecordForm kind="post" initial={{ title: "A draft", section: "support", blocks: [] }}
      onSave={() => {}} canSave sections={choices} />);
    expect(screen.getByRole("combobox", { name: /^Area/ })).toHaveValue("support");
    form.unmount();
    render(<RecordForm kind="post" initial={{ id: "post-1", status: "draft", unassignedDraft: true, blocks: [] }}
      onSave={() => {}} canSave sections={[choices[0]]} />);
    expect(screen.getByRole("combobox", { name: /^Area/ })).toHaveValue("");
  });

  it("keeps a saved Area read-only and disables the new picker when the edit lock arrives", () => {
    const saved = render(<RecordForm kind="post" initial={{ id: "post-1", section: "support", blocks: [] }}
      onSave={() => {}} canSave sections={choices} />);
    expect(screen.queryByRole("combobox", { name: /^Area/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("record-section-display")).toHaveTextContent("Support");
    saved.unmount();
    const form = (readOnly: boolean) => <RecordForm kind="post" initial={{ title: "A draft", blocks: [] }}
      onSave={() => {}} canSave sections={choices} readOnly={readOnly} />;
    const view = render(form(false));
    const area = screen.getByRole("combobox", { name: /^Area/ });
    expect(area).toBeEnabled();
    view.rerender(form(true));
    expect(area).toBeDisabled();
  });

  it("reveals and focuses Area validation in its title panel", async () => {
    createLocalBentoStore().save("post", [
      { id: "post-title", zone: "main", collapsed: true },
      { id: "post-body", zone: "main", collapsed: false },
    ]);
    render(<RecordForm kind="post" initial={{ title: "A draft", blocks: [] }}
      onSave={() => {}} canSave sections={choices} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Area" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: /^Area/ })).toHaveFocus());
  });
});
