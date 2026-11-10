import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { HomeShortcuts } from "../src/components/HomeShortcuts";
import type { Principal } from "../../packages/content-core/src/rbac";
import type { HomeShortcutId } from "../src/lib/home-shortcuts";

const editor: Principal = { id: "editor", grants: [{ role: "editor", sections: ["news"] }] };
const staff: Principal = { id: "staff", grants: [{ role: "staff" }] };
const save = async () => {};
const shortcuts = () => within(screen.getByRole("region", { name: "Home shortcuts" }));

function Harness() {
  const [stored, setStored] = useState<readonly HomeShortcutId[] | null>(null);
  return <HomeShortcuts principal={editor} stored={stored} onSave={async ids => { setStored(ids); }} />;
}

describe("Home shortcuts", () => {
  it("uses existing editorial filters and staff destinations as role-aware defaults", () => {
    const view = render(<MemoryRouter><HomeShortcuts principal={editor} stored={null} onSave={save} /></MemoryRouter>);
    expect(shortcuts().getByRole("link", { name: "My recent edits" })).toHaveAttribute("href", "/content/library?owner=me&v=1");
    expect(shortcuts().getByRole("link", { name: "Assigned to me" })).toHaveAttribute("href", "/content/library?assigned=me&v=1");
    view.rerender(<MemoryRouter><HomeShortcuts principal={staff} stored={null} onSave={save} /></MemoryRouter>);
    expect(shortcuts().getByRole("link", { name: "Browse media" })).toHaveAttribute("href", "/media");
    expect(shortcuts().getByRole("link", { name: "Open guide" })).toHaveAttribute("href", "/guide");
  });

  it("previews choices, prevents duplicate slots, saves and resets the account choice", async () => {
    render(<MemoryRouter><Harness /></MemoryRouter>);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Customize Home shortcuts" }));
    expect(screen.getByLabelText("Shortcut 1")).toHaveFocus();
    expect(within(screen.getByLabelText("Shortcut 1")).getByRole("option", { name: "Assigned to me" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Shortcut 1"), { target: { value: "guide" } });
    expect(within(screen.getByRole("region", { name: "Shortcut preview" })).getByText("Open guide")).toBeVisible();
    expect(shortcuts().getByRole("link", { name: "My recent edits" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save shortcuts" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(shortcuts().getByRole("link", { name: "Open guide" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Home shortcuts saved");
    fireEvent.click(screen.getByRole("button", { name: "Customize Home shortcuts" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(shortcuts().getByRole("link", { name: "My recent edits" })).toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("reset to defaults");
  });

  it("discards unknown, duplicate and forbidden IDs and revalidates an open dialog after a role change", async () => {
    const view = render(<MemoryRouter><HomeShortcuts principal={editor} stored={["guide", "guide", "javascript:alert(1)"]} onSave={save} /></MemoryRouter>);
    expect(shortcuts().getAllByRole("link")).toHaveLength(2);
    expect(shortcuts().getByRole("link", { name: "Open guide" })).toBeInTheDocument();
    expect(shortcuts().getByRole("link", { name: "My recent edits" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Customize Home shortcuts" }));
    view.rerender(<MemoryRouter><HomeShortcuts principal={{ ...staff, id: editor.id }} stored={["recent-edits", "assigned"]} onSave={save} /></MemoryRouter>);
    expect(screen.queryByRole("option", { name: "My recent edits" })).not.toBeInTheDocument();
    expect(shortcuts().queryByRole("link", { name: "My recent edits" })).not.toBeInTheDocument();
    expect(shortcuts().getByRole("link", { name: "Browse media" })).toHaveAttribute("href", "/media");
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<MemoryRouter><HomeShortcuts principal={{ id: "none", grants: [] }} stored={["media", "guide"]} onSave={save} /></MemoryRouter>);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it.each([null, {}, ["unknown", "media"], ["https://example.test", "media"]])("uses safe defaults for malformed preferences %j", stored => {
    render(<MemoryRouter><HomeShortcuts principal={editor} stored={stored} onSave={save} /></MemoryRouter>);
    expect(shortcuts().getByRole("link", { name: "My recent edits" })).toHaveAttribute("href", "/content/library?owner=me&v=1");
    expect(shortcuts().getAllByRole("link")).toHaveLength(2);
    expect(shortcuts().getAllByRole("link").every(link => link.getAttribute("href")?.startsWith("/"))).toBe(true);
  });

  it("keeps choices on failure and blocks edits while saving, then allows retry", async () => {
    let reject!: (cause: Error) => void;
    let succeed = false;
    const persist = () => succeed ? Promise.resolve() : new Promise<void>((_, fail) => { reject = fail; });
    render(<MemoryRouter><HomeShortcuts principal={editor} stored={null} onSave={persist} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Customize Home shortcuts" }));
    fireEvent.change(screen.getByLabelText("Shortcut 1"), { target: { value: "media" } });
    fireEvent.click(screen.getByRole("button", { name: "Save shortcuts" }));
    expect(screen.getByLabelText("Shortcut 1")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => reject(new Error("Your Home shortcuts could not be saved. Try again.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Try again");
    expect(screen.getByLabelText("Shortcut 1")).toHaveValue("media");
    succeed = true;
    fireEvent.click(screen.getByRole("button", { name: "Save shortcuts" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
