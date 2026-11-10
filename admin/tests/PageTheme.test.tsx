import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RecordForm } from "../src/components/RecordForm";
import { EditorWorkspace } from "../src/components/EditorWorkspace";
import { pageMetadataSaveDocument } from "../src/lib/page-metadata";
import { ROUTE_PATHS } from "../src/lib/routes";

const pageId = "page-11111111111111111111111111111111";
describe("Page theme in the existing metadata form", () => {
  it.each([
    { theme: "default", role: "admin", linked: false },
    { theme: "nj-decides", role: "admin", linked: true },
    { theme: "nj-decides", role: "editor", linked: false },
  ] as const)("shows heading ownership for $theme as $role", async ({ theme, role, linked }) => {
    render(<MemoryRouter><EditorWorkspace
      principal={{ id: "staff", grants: [{ role }] }}
      surface={{ kind: "page", pageId, section: "genericPage" }}
      loadPage={async () => ({ blocks: [], metadata: { title: "Election coverage", pageTheme: theme }, version: 1 })}
    /></MemoryRouter>);
    const sidebar = within(await screen.findByRole("region", { name: "Side panel" }));
    if (theme === "default") {
      expect(await sidebar.findByRole("group", { name: "Hero background" })).toBeVisible();
      expect(sidebar.queryByRole("group", { name: "Heading and artwork" })).not.toBeInTheDocument();
      return;
    }
    const note = within(await sidebar.findByRole("group", { name: "Heading and artwork" }));
    expect(sidebar.queryByRole("group", { name: "Hero background" })).not.toBeInTheDocument();
    expect(note.getByText("This Page uses the NJ Decides 2026 theme. Its heading, logo, colors and artwork come from the shared NJ Decides brand, not from this Page.")).toBeVisible();
    if (linked) {
      expect(note.getByRole("link", { name: "Edit the NJ Decides brand" }))
        .toHaveAttribute("href", `${ROUTE_PATHS.adminSettings}#nj-decides-settings-heading`);
    } else {
      expect(note.queryByRole("link")).not.toBeInTheDocument();
      expect(note.getByText("An admin can change it in Admin settings, NJ Decides brand.")).toBeVisible();
    }
  });
  it("saves the theme and retains normal hero metadata when switching back", async () => {
    const save = vi.fn();
    render(<RecordForm kind="page" pageId={pageId} initial={{ title: "Election coverage", heroBackgroundImage: "saved-art" }} canSave
      onSave={values => { save(pageMetadataSaveDocument(values)); }} />);
    fireEvent.change(screen.getByLabelText("Page theme"), { target: { value: "nj-decides" } });
    expect(screen.getByLabelText("Page theme")).toHaveValue("nj-decides");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ pageTheme: "nj-decides", heroBackgroundImage: "saved-art" })));
    fireEvent.change(screen.getByLabelText("Page theme"), { target: { value: "default" } });
    expect(screen.getByLabelText("Page theme")).toHaveValue("default");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ pageTheme: "default", heroBackgroundImage: "saved-art" })));
  });
  it.each(["home", "contact", "staff", "schedule", "data-hub"])("keeps the dedicated %s frame out of the theme chooser", pageId => {
    render(<RecordForm kind="page" pageId={pageId} initial={{ title: "Existing Page" }} canSave onSave={() => {}} />);
    expect(screen.queryByLabelText("Page theme")).not.toBeInTheDocument();
  });
});
