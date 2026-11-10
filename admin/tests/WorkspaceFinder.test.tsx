import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFinder } from "../src/components/WorkspaceFinder";
import type { NavDestinationDef } from "../src/lib/nav-destinations";

const destinations: NavDestinationDef[] = [
  { id: "posts", label: "Posts", icon: "file", to: "/content/post", visible: () => true,
    subitems: [{ id: "new-post", label: "New post", to: "/content/post/+" }] },
  { id: "media", label: "Media library", icon: "media", to: "/media", visible: () => true },
];

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
});

function setup() {
  render(<MemoryRouter><WorkspaceFinder destinations={destinations} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Find a workspace" }));
  return screen.getByRole("dialog", { name: "Find a workspace" });
}

describe("WorkspaceFinder", () => {
  it("closes with Escape even when the search input contains text", () => {
    const dialog = setup();
    const search = within(dialog).getByRole("searchbox");
    fireEvent.change(search, { target: { value: "media" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(dialog).not.toHaveAttribute("open");
  });

  it("opens an external destination in a new tab", () => {
    render(<MemoryRouter><WorkspaceFinder destinations={[
      ...destinations,
      { id: "around-nj", label: "Around NJ", icon: "external-link", to: "https://centercoopmedia.github.io/around-nj/", external: true, visible: () => true },
    ]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Find a workspace" }));
    const link = screen.getByRole("link", { name: "Open Around NJ in a new tab" });
    expect(link).toHaveAttribute("href", "https://centercoopmedia.github.io/around-nj/");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("searches only the admitted destinations and their shortcuts", () => {
    const dialog = setup();
    expect(within(dialog).queryByRole("link", { name: "Admin settings" })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "  new POST " } });
    expect(within(dialog).getAllByRole("link")).toHaveLength(1);
    expect(within(dialog).getByRole("link", { name: /New post/ })).toHaveAttribute("href", "/content/post/+");
  });

  it("shows a recoverable empty search and resets the query when reopened", () => {
    const dialog = setup();
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "unknown" } });
    expect(within(dialog).getByText("No workspaces match. Try another name.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close workspace search" }));
    fireEvent.click(screen.getByRole("button", { name: "Find a workspace" }));
    expect(within(dialog).getByRole("searchbox")).toHaveValue("");
  });

  it("does not steal editor shortcuts or open over another modal", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Close workspace search" }));
    const show = vi.mocked(HTMLDialogElement.prototype.showModal);
    show.mockClear();
    const input = document.createElement("textarea");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(show).not.toHaveBeenCalled();
    input.remove();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(show).not.toHaveBeenCalled();
    modal.remove();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(show).toHaveBeenCalledOnce();
  });
});

// A section has no main link: all of its child links must remain searchable.
it("finds every custom section child including its first external link", () => {
  render(<MemoryRouter><WorkspaceFinder destinations={[{ id: "custom:desk", label: "My desk", icon: "folder", to: "https://example.test/one", visible: () => true, sectionOnly: true,
    subitems: [{ id: "custom:one", label: "First link", to: "https://example.test/one", external: true }, { id: "custom:two", label: "Second link", to: "/content" }] }]} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Find a workspace" }));
  expect(screen.getByRole("link", { name: "Open First link in a new tab" })).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByRole("link", { name: /Second link/ })).toHaveAttribute("href", "/content");
});
