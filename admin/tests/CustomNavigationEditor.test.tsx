import { MemoryRouter } from "react-router";
import { SidebarDestination } from "../src/components/SidebarDestination";
import { customNavDestinations } from "../src/lib/custom-nav-destinations";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomNavigationEditor } from "../src/components/CustomNavigationEditor";
import { NavigationPreferences } from "../src/components/NavigationPreferences";
import { eligibleNavDestinations } from "../src/lib/nav-destinations";
import type { CustomNavSection } from "../src/lib/custom-navigation";
import type { Principal } from "../../packages/content-core/src/rbac";
const principal: Principal = { id: "fixture", grants: [{ role: "super_admin" }] };
const section: CustomNavSection = { id: "custom:desk", kind: "section", label: "My desk", links: [
  { id: "custom:one", kind: "link", label: "First link", destination: { kind: "url", url: "https://example.test/one" } },
  { id: "custom:two", kind: "link", label: "Second link", destination: { kind: "url", url: "/content" } },
] };

describe("custom navigation editor", () => {
  it("refuses an unsafe URL and applies a valid external link", () => {
    const apply = vi.fn();
    render(<CustomNavigationEditor remaining={10} hiddenIds={[]} onHiddenChange={() => {}} onCancel={() => {}} onApply={apply} />);
    fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "Station" } });
    fireEvent.change(screen.getByLabelText("Address (required)"), { target: { value: "javascript:alert(1)" } });
    expect(screen.getByRole("button", { name: "Apply plank" })).toBeDisabled();
    expect(screen.getByText("Enter a CMS path or a valid HTTPS address.")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Address (required)"), { target: { value: "https://example.test/station" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply plank" }));
    expect(apply.mock.calls[0][0]).toMatchObject({ id: expect.stringMatching(/^custom:/), kind: "link", label: "Station", destination: { kind: "url", url: "https://example.test/station" } });
  });
  it("searches only on request and stores a selected post by ID", async () => {
    const search = vi.fn(async () => ({ items: [{ id: "post-123", label: "A renamed post" }], pageCount: 1 }));
    const apply = vi.fn();
    render(<CustomNavigationEditor remaining={10} hiddenIds={[]} onHiddenChange={() => {}} onCancel={() => {}} onApply={apply} searchContent={search} />);
    fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "My post" } });
    fireEvent.change(screen.getByLabelText("Links to"), { target: { value: "post" } });
    expect(search).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "A renamed post" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply plank" }));
    expect(apply.mock.calls[0][0].destination).toEqual({ kind: "post", id: "post-123" });
  });
  it("stages child hiding until Apply and preserves child order", () => {
    const hidden = vi.fn(), apply = vi.fn();
    render(<CustomNavigationEditor item={section} remaining={3} hiddenIds={[]} onHiddenChange={hidden} onCancel={() => {}} onApply={apply} />);
    fireEvent.click(screen.getByRole("button", { name: /Hide from navigation.*First link/ }));
    expect(hidden).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move up: Second link" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply span" }));
    expect(hidden).toHaveBeenCalledWith("custom:one", true);
    expect(apply.mock.calls[0][0].links.map((link: { id: string }) => link.id)).toEqual(["custom:two", "custom:one"]);
    expect(screen.getByRole("button", { name: "Add span plank" })).toBeDisabled();
  });
  it("adds a custom link to the mixed list and saves one v4 record", async () => {
    const save = vi.fn(async (_preferences: import("../src/lib/navigation-preferences").NavigationPreferences) => {});
    render(<NavigationPreferences eligible={eligibleNavDestinations(principal)} stored={null} onReset={() => {}} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to your rail" }));
    fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "Station" } });
    fireEvent.change(screen.getByLabelText("Address (required)"), { target: { value: "https://example.test/station" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply plank" }));
    const list = screen.getByRole("list", { name: "Your rail order" });
    expect(within(list).getByText("Station")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Hide: Station" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const preferences = save.mock.calls[0][0] as unknown as { version: number; custom: { id: string }[]; hidden: string[] };
    expect(preferences.version).toBe(4);
    expect(preferences.custom).toHaveLength(1);
    expect(preferences.hidden).toContain(preferences.custom[0].id);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled());
  });
  it("requires reset confirmation before removing custom entries", async () => {
    const reset = vi.fn(async () => {});
    render(<NavigationPreferences eligible={eligibleNavDestinations(principal)} stored={{ version: 4, order: [], hidden: [], custom: [section] }} onReset={reset} onSave={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(reset).not.toHaveBeenCalled();
    expect(screen.getByText(/Reset removes all your planks and spans/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove your planks and spans and reset" }));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("My desk")).not.toBeInTheDocument();
  });
  it("saves an unhidden child and reloads the section without stale hidden IDs", async () => {
    const stored = { version: 4, order: ["custom:desk", "custom:one", "custom:two"], hidden: ["custom:one"], custom: [section] };
    const save = vi.fn(async (_preferences: import("../src/lib/navigation-preferences").NavigationPreferences) => {});
    render(<NavigationPreferences eligible={eligibleNavDestinations(principal)} stored={stored} onReset={() => {}} onSave={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit My desk" }));
    fireEvent.click(screen.getByRole("button", { name: "Show in navigation: First link" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply span" }));
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].hidden).not.toContain("custom:one");
    expect(customNavDestinations(save.mock.calls[0][0], principal)[0].subitems).toHaveLength(2);
  });
  it("renders safe section links with external tab protection and refuses unsafe render data", () => {
    const destination = customNavDestinations({ version: 4, order: [], hidden: [], custom: [section] }, principal)[0];
    destination.subitems = [...destination.subitems!, { id: "custom:unsafe", label: "Unsafe", to: "javascript:alert(1)" }];
    render(<MemoryRouter><SidebarDestination destination={destination} expanded onExpandedChange={() => {}} pathname="/"
      prefetch={{ intent: () => {}, cancel: () => {}, started: () => [] }} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "My desk" })).toHaveAttribute("aria-expanded", "true");
    const external = screen.getByRole("link", { name: "Open First link in a new tab" });
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Second link" })).toHaveAttribute("href", "/content");
    expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
  });

});

it("keeps focus in the panel after custom deletion and reset cancellation", () => {
  render(<NavigationPreferences eligible={eligibleNavDestinations(principal)} stored={{ version: 4, order: [], hidden: [], custom: [section] }} onReset={() => {}} onSave={() => {}} />);
  const reset = screen.getByRole("button", { name: "Reset to default" });
  reset.focus();
  fireEvent.click(reset);
  const cancel = screen.getByRole("button", { name: "Cancel reset" });
  expect(cancel).toHaveFocus();
  fireEvent.click(cancel);
  expect(reset).toHaveFocus();
  const remove = screen.getByRole("button", { name: "Delete My desk" });
  remove.focus();
  fireEvent.click(remove);
  expect(document.activeElement?.tagName).toBe("BUTTON");
  expect(document.activeElement).not.toBe(remove);
});

it("keeps focus on Add after reset completes before the profile update arrives", async () => {
  const eligible = eligibleNavDestinations(principal);
  const stored = { version: 4, order: [], hidden: [], custom: [section] };
  const view = render(<NavigationPreferences eligible={eligible} stored={stored} onReset={async () => {}} onSave={() => {}} />);
  screen.getByRole("button", { name: "Reset to default" }).focus();
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove your planks and spans and reset" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Add to your rail" })).toHaveFocus());
  view.rerender(<NavigationPreferences eligible={eligible} stored={null} onReset={async () => {}} onSave={() => {}} />);
  expect(screen.getByRole("button", { name: "Reset to default" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add to your rail" })).toHaveFocus();
});

it("keeps focus on the new item when the item cap disables Add", () => {
  const custom = Array.from({ length: 9 }, (_, i) => ({ id: `custom:${i}`, kind: "link" as const, label: `Link ${i}`, destination: { kind: "url" as const, url: "https://example.test" } }));
  render(<NavigationPreferences eligible={eligibleNavDestinations(principal)} stored={{ version: 4, order: [], hidden: [], custom }} onReset={() => {}} onSave={() => {}} />);
  const add = screen.getByRole("button", { name: "Add to your rail" });
  add.focus();
  fireEvent.click(add);
  fireEvent.change(screen.getByLabelText("Label (required)"), { target: { value: "Last link" } });
  fireEvent.change(screen.getByLabelText("Address (required)"), { target: { value: "https://example.test/last" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply plank" }));
  expect(add).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move: Last link" })).toHaveFocus();
});


it("keeps the reset confirmation focusable while pending and after a failed reset", async () => {
  let rejectReset!: (error: Error) => void;
  const reset = new Promise<void>((_, reject) => { rejectReset = reject; });
  render(<NavigationPreferences eligible={eligibleNavDestinations(principal)} stored={{ version: 4, order: [], hidden: [], custom: [section] }} onReset={() => reset} onSave={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  const confirm = screen.getByRole("button", { name: "Remove your planks and spans and reset" });
  confirm.focus();
  fireEvent.click(confirm);
  expect(confirm).not.toBeDisabled();
  expect(confirm).toHaveAttribute("aria-disabled", "true");
  expect(screen.getAllByRole("button").filter(button => button.getAttribute("aria-busy") === "true")).toHaveLength(1);
  expect(confirm).toHaveFocus();
  rejectReset(new Error("Reset could not be saved."));
  await waitFor(() => expect(screen.getByText("Reset could not be saved.")).toBeVisible());
  expect(confirm).not.toHaveAttribute("aria-disabled");
  expect(confirm).toHaveFocus();
});
