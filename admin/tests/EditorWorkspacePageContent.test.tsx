import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorWorkspace, type PageContent } from "../src/components/EditorWorkspace";
import type { SectionId } from "../../packages/content-core/src/editor-admin";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";
import type { Principal } from "../../packages/content-core/src/rbac";

// Exercise the workspace-to-canvas data boundary without iframe document loading.
// The real sandbox, keyboard selection and layout have headed browser coverage.
vi.mock("../src/components/HomePreviewFrame", () => ({
  HomePreviewFrame: ({ html, title }: { html: string; title: string }) =>
    <iframe title={title} srcDoc={html} />,
}));
vi.mock("../src/lib/schedule-source-snapshot", () => ({
  loadScheduleSourceSnapshot: async () => { throw new Error("Unavailable in this workspace test"); },
}));

afterEach(cleanup);

const admin: Principal = { id: "admin", grants: [{ role: "admin" }] };

describe("EditorWorkspace page content integration", () => {
  it.each([true, false])("keeps saved page title and summary after clearing the draft (server metadata: %s)", async (returnsMetadata) => {
    const loadPage = vi.fn(async (): Promise<PageContent> => ({
      blocks: [], version: 1, metadata: { title: "Watch NJ PBS", description: "Old description" },
    }));
    const savePageMetadata = vi.fn(async (_id, _section, metadata): Promise<PageContent> => ({
      blocks: [], version: 2,
      ...(returnsMetadata ? { metadata: { ...metadata, title: "Saved Watch title" } } : {}),
    }));
    render(<EditorWorkspace principal={admin} loadPage={loadPage} savePageMetadata={savePageMetadata}
      surface={{ kind: "page", pageId: "watch", section: "programLanding" }} />);
    const title = await screen.findByRole("textbox", { name: /^Page title/ });
    fireEvent.change(title, { target: { value: "New Watch title" } });
    fireEvent.change(screen.getByLabelText(/^Page summary/), { target: { value: "New description" } });
    expect(screen.queryByTitle("Watch NJ PBS page preview")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await screen.findByText("Saved.");
    await waitFor(() => expect(savePageMetadata).toHaveBeenCalledTimes(1));
    expect(savePageMetadata.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      title: "New Watch title",
      description: "New description",
    }));
    if (returnsMetadata) {
      expect(screen.getByRole("heading", { name: "Saved Watch title" })).toBeTruthy();
    } else {
      expect(screen.getByRole("textbox", { name: /^Page title/ })).toHaveValue("New Watch title");
    }
    expect(screen.getByLabelText(/^Page summary/)).toHaveValue("New description");
  });

  it("shows real service compositions and fixed integration context", async () => {
    const loadPage = vi.fn(
      async (_pageId: PublicPageId, _section: SectionId): Promise<PageContent> => ({
        blocks: [],
      }),
    );
    const { rerender } = render(
      <EditorWorkspace
        principal={admin}
        loadPage={loadPage}
        surface={{ kind: "page", pageId: "watch", section: "programLanding" }}
      />,
    );

    expect(await screen.findByRole("article", { name: "Title and summary" })).toBeInTheDocument();
    expect(screen.queryByText("Editing the current Watch NJ PBS composition")).toBeNull();
    expect(screen.queryByText("Public path")).toBeNull();
    expect(screen.getByText("Path")).toBeInTheDocument();
    expect(screen.getByText("/watch/")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Page parts" })).toBeNull();
    expect(screen.queryByTitle("Watch NJ PBS page preview")).toBeNull();

    rerender(
      <EditorWorkspace
        principal={admin}
        loadPage={loadPage}
        surface={{ kind: "page", pageId: "live", section: "programLanding" }}
      />,
    );

    expect(screen.queryByText("Editing the current PBS Livestream composition")).toBeNull();
    expect(await screen.findByRole("region", { name: "Fixed PBS Livestream page context" })).toHaveTextContent(
      "PBS livestream player",
    );
    expect(screen.queryByTitle("PBS Livestream page preview")).toBeNull();

    rerender(
      <EditorWorkspace
        principal={admin}
        loadPage={loadPage}
        surface={{ kind: "page", pageId: "contact", section: "genericPage" }}
      />,
    );

    expect(screen.queryByText("Editing the current Contact NJ PBS composition")).toBeNull();
    expect(await screen.findByRole("button", { name: "Add content: position 1" })).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledWith("watch", "programLanding");
    expect(loadPage).toHaveBeenCalledWith("live", "programLanding");
    expect(loadPage).toHaveBeenCalledWith("contact", "genericPage");
  });

  it("opens a custom Page directly on its title and editable content", async () => {
    const pageId = `page-${"e".repeat(32)}` as PublicPageId;
    const loadPage = vi.fn(async (): Promise<PageContent> => ({
      blocks: [],
      version: 1,
      metadata: {
        title: "NJ PBS in the news",
        description: "Third-party coverage of NJ PBS.",
        slug: "in-the-news",
      },
    }));

    render(
      <EditorWorkspace
        principal={admin}
        loadPage={loadPage}
        surface={{ kind: "page", pageId, section: "genericPage" }}
      />,
    );

    expect(await screen.findByRole("textbox", { name: /^Page title/ })).toHaveValue(
      "NJ PBS in the news",
    );
    expect(screen.getByRole("button", { name: "Add content: position 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outline" })).toBeInTheDocument();
    expect(screen.queryByText("Live page map")).toBeNull();
    expect(loadPage).toHaveBeenCalledWith(pageId, "genericPage");
  });

  it("treats Staff as an editable Page with a generated read-only roster", async () => {
    const loadPage = vi.fn(async (): Promise<PageContent> => ({
      blocks: [],
      version: 1,
      metadata: {
        title: "Meet the team",
        description: "The people who make NJ PBS.",
      },
    }));
    render(
      <EditorWorkspace
        principal={admin}
        loadPage={loadPage}
        surface={{ kind: "page", pageId: "staff", section: "genericPage" }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Add content: position 1" })).toBeInTheDocument();
    const outlineToggle = screen.getByRole("button", { name: "Outline" });
    if (outlineToggle.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(outlineToggle);
    }
    expect(outlineToggle).toHaveAttribute("aria-expanded", "true");
    expect((await screen.findByRole("navigation", { name: "Content outline" }))).toBeInTheDocument();
    fireEvent.click(outlineToggle);
    expect(outlineToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("region", { name: "Fixed Meet the team page context" })).toHaveTextContent(
      "Published staff roster",
    );
    expect(
      screen.getByText("Edit authored blocks. The published roster stays generated and locked."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Edit the Staff hero background, crop, search, and social settings."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Edit the Staff hero and authored blocks.")).toBeNull();
    expect(screen.getByLabelText(/^Staff hero title/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Staff hero summary/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Staff page preview" })).toBeNull();
    expect(screen.queryByText("People of NJ PBS")).toBeNull();
    expect(screen.queryByText("This page is empty.")).toBeNull();
    expect(screen.queryByText(/cmsStaffRecords|staff account|private staff/i)).toBeNull();
    expect(loadPage).toHaveBeenCalledWith("staff", "genericPage");
  });
});
