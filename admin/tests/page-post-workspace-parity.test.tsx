import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import { EditorWorkspace, type PageContent } from "../src/components/EditorWorkspace";
import { RecordForm } from "../src/components/RecordForm";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { pageCompositionSeed } from "../../packages/content-core/src/page-composition-seeds";
import type { Principal } from "../../packages/content-core/src/rbac";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";
import type { SectionId } from "../../packages/content-core/src/editor-admin";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const admin: Principal = { id: "admin", grants: [{ role: "admin" }] };

async function openOutline() {
  const toggle = screen.getByRole("button", { name: "Outline" });
  if (toggle.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(toggle);
  }
  return screen.findByRole("navigation", { name: "Content outline" });
}

function closeComponentEditor() {
  const dialog = screen.queryAllByRole("dialog").find((element) =>
    element.classList.contains("component-editor-dialog"),
  );
  if (dialog) fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
}

function renderPageWorkspace(
  pageId: PublicPageId,
  section: SectionId,
  content: Partial<PageContent> = {},
) {
  return render(
    <EditorWorkspace
      principal={admin}
      loadPage={async () => ({
        blocks: [],
        metadata: { title: "Loaded title", description: "Loaded summary" },
        version: 1,
        ...content,
      })}
      surface={{ kind: "page", pageId, section }}
    />,
  );
}

describe("Page and Post workspace parity", () => {
  it("keeps Page title and summary in the main writing column", async () => {
    renderPageWorkspace("contact", "genericPage");

    const writing = await screen.findByRole("region", { name: "Main area" });
    const settings = screen.getByRole("region", { name: "Side panel" });
    const titlePanel = within(writing).getByRole("article", { name: "Title and summary" });

    expect(within(titlePanel).getByRole("textbox", { name: /^Page title/ })).toBeVisible();
    expect(within(titlePanel).getByLabelText(/^Page summary/)).toBeVisible();
    expect(within(settings).queryByRole("textbox", { name: /^Page title/ })).toBeNull();
    expect(within(settings).queryByLabelText(/^Page summary/)).toBeNull();
    expect(within(settings).getByRole("article", { name: "Page metadata" })).toBeTruthy();
    expect(within(settings).getByRole("group", { name: "Hero background" })).toBeTruthy();
    expect(within(settings).getByRole("group", { name: "Search" })).toBeTruthy();
    expect(within(settings).getByRole("group", { name: "Social sharing" })).toBeTruthy();
    expect(within(settings).getByRole("article", { name: "Lifecycle" })).toBeTruthy();
  });

  it("keeps Staff hero copy in the main column and the roster locked", async () => {
    renderPageWorkspace("staff", "genericPage", {
      metadata: {
        title: "Meet the team",
        description: "The people who make NJ PBS.",
      },
    });

    const writing = await screen.findByRole("region", { name: "Main area" });
    expect(within(writing).getByLabelText(/^Staff hero title/)).toBeVisible();
    expect(within(writing).getByLabelText(/^Staff hero summary/)).toBeVisible();
    expect(screen.getByRole("region", { name: "Fixed Meet the team page context" })).toHaveTextContent(
      "Published staff roster",
    );
    expect(screen.queryByRole("region", { name: "Staff page preview" })).toBeNull();
    expect(screen.queryByText("People of NJ PBS")).toBeNull();
  });

  it("uses one content outline label for Posts and Pages", async () => {
    const { unmount } = render(
      <BlockEditor section="post" initialBlocks={[createBlock("prose", "post-body")]} commandsInline />,
    );
    await openOutline();
    expect(screen.getByRole("heading", { name: "Content outline" })).toBeVisible();
    unmount();

    render(
      <BlockEditor
        pageId="watch"
        section="programLanding"
        initialBlocks={pageCompositionSeed("watch")!.blocks as AdminBlock[]}
        commandsInline
      />,
    );
    await openOutline();
    expect(screen.getByRole("heading", { name: "Content outline" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Move down: buttons 1 in content outline" })).toBeTruthy();
  });
});

describe("Page structural authoring", () => {
  it("opens Watch named regions in the shared component dialog instead of a branded canvas", () => {
    render(
      <BlockEditor
        pageId="watch"
        section="programLanding"
        initialBlocks={pageCompositionSeed("watch")!.blocks as AdminBlock[]}
        commandsInline
      />,
    );

    expect(screen.queryByRole("navigation", { name: "Page parts" })).toBeNull();
    expect(screen.queryByTitle("Watch NJ PBS page preview")).toBeNull();
    expect(screen.queryByRole("region", { name: "Page preview" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Watch destinations" }));
    const dialog = screen.getByRole("dialog", { name: "Watch destinations" });
    expect(dialog.classList.contains("component-editor-dialog")).toBe(true);
    expect(within(dialog).getByDisplayValue("Programs on demand")).toBeVisible();
    closeComponentEditor();
  });

  it("keeps Live player and schedule locked while still editing named regions", async () => {
    renderPageWorkspace("live", "programLanding", {
      blocks: pageCompositionSeed("live")!.blocks as AdminBlock[],
      metadata: { title: "PBS Livestream", description: "Watch NJ PBS live." },
    });

    expect(await screen.findByRole("button", { name: "Edit Livestream introduction" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Fixed PBS Livestream page context" })).toHaveTextContent(
      "PBS livestream player",
    );
    expect(screen.getByRole("region", { name: "Fixed PBS Livestream page context" })).toHaveTextContent(
      "Live schedule",
    );
    expect(screen.queryByTitle("PBS Livestream page preview")).toBeNull();
  });

  it("edits marked Home sections as compact cards and keeps newsletter locked", async () => {
    render(
      <BlockEditor
        section="home"
        pageId="home"
        homeCompositionVersion={1}
        initialBlocks={homeCompositionDefaults() as AdminBlock[]}
        commandsInline
      />,
    );

    expect(screen.queryByRole("group", { name: /page preview$/i })).toBeNull();
    expect(screen.getByRole("region", { name: "Newsletter signup" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit Start here" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Start here destinations" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Passport" }));
    expect(screen.getByRole("dialog").classList.contains("component-editor-dialog")).toBe(true);
    expect(screen.getByRole("textbox", { name: "Body" })).toBeVisible();
    closeComponentEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit Featured programs" }));
    expect(screen.getByRole("textbox", { name: "Shelf heading" })).toBeVisible();
    closeComponentEditor();
    await openOutline();
    expect((await screen.findByRole("navigation", { name: "Content outline" }))).toBeVisible();
  });

  it("maps Home outline moves to the full stored block order and locks named regions", async () => {
    const onDraftChange = vi.fn();
    const extra = {
      ...createBlock("prose", "home-extra"),
      data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Extra Home copy" }] }] } },
    } as AdminBlock;
    const blocks = homeCompositionDefaults() as AdminBlock[];
    blocks.splice(3, 0, extra);
    const row = { ...createBlock("row", "home-row"), data: { columns: [12] } } as AdminBlock;
    const child = {
      ...createBlock("prose", "home-row-child"),
      layout: { rowId: row.id, column: 0 },
    } as AdminBlock;
    blocks.push(row, child);
    render(
      <BlockEditor
        section="home"
        pageId="home"
        homeCompositionVersion={1}
        initialBlocks={blocks.map((block, order) => ({ ...block, order }))}
        onDraftChange={onDraftChange}
        commandsInline
      />,
    );

    const outline = within(await openOutline());
    // The fixed Newsletter boundary now shares canvas position 1 with the outline.
    expect(outline.getByRole("button", { name: "Move down: content shelf 2 in content outline" })).toBeDisabled();
    fireEvent.click(outline.getByRole("button", { name: "Move up: text 3 in content outline" }));

    const draft = onDraftChange.mock.lastCall?.[0] as AdminBlock[];
    expect(draft.slice(0, 4).map((block) => block.id)).toEqual([
      "new-home-start",
      "new-home-start-action",
      "home-extra",
      "new-home-featured",
    ]);
    expect(draft.slice(-2).map((block) => block.id)).toEqual(["home-row", "home-row-child"]);

    fireEvent.click(within(await openOutline()).getByRole("button", { name: "Move down: text 2 in content outline" }));
    const restored = onDraftChange.mock.lastCall?.[0] as AdminBlock[];
    expect(restored.slice(0, 4).map((block) => block.id)).toEqual([
      "new-home-start",
      "new-home-start-action",
      "new-home-featured",
      "home-extra",
    ]);
    expect(restored.slice(-2).map((block) => block.id)).toEqual(["home-row", "home-row-child"]);
  });

  it("keeps a Home row outside Passport's fixed controls when the outline moves it across the section", async () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    const row = { ...createBlock("row", "home-row"), data: { columns: [12] } } as AdminBlock;
    const child = {
      ...createBlock("prose", "home-row-child"),
      layout: { rowId: row.id, column: 0 },
      data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Row copy" }] }] } },
    } as AdminBlock;
    const blocks = homeCompositionDefaults() as AdminBlock[];
    const passportCopy = blocks.findIndex((block) => block.section === "home-passport-copy");
    blocks.splice(passportCopy, 0, row, child);
    render(
      <BlockEditor
        section="home"
        pageId="home"
        homeCompositionVersion={1}
        initialBlocks={blocks.map((block, order) => ({ ...block, order }))}
        onDraftChange={onDraftChange}
        onSave={onSave}
        commandsInline
      />,
    );

    fireEvent.click(within(await openOutline()).getByRole("button", { name: "Move down: Row 1 in content outline" }));

    const draft = onDraftChange.mock.lastCall?.[0] as AdminBlock[];
    expect(draft.map((block) => block.id)).toEqual([
      "new-home-start",
      "new-home-start-action",
      "new-home-featured",
      "new-home-passport-copy",
      "new-home-passport-action",
      "home-row",
      "home-row-child",
      "new-home-more",
      "new-home-spotlight",
    ]);
    expect(homeCompositionError("home", 1, draft as PageBlock[])).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(homeCompositionError("home", 1, onSave.mock.calls[0][0] as PageBlock[])).toBeNull();
  });

  it("opens coverage_list through the shared component dialog", () => {
    render(
      <BlockEditor
        section="genericPage"
        initialBlocks={[
          {
            ...createBlock("coverage_list", "coverage-1"),
            data: {
              entries: [{
                title: "An outside article",
                url: "https://www.njspotlightnews.org/example/",
                outlet: "NJ Spotlight News",
                date: "2026-09-17",
              }],
            },
          },
        ]}
        commandsInline
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit coverage list 1" }));
    const dialog = screen.getByRole("dialog", { name: "coverage list 1" });
    expect(dialog.classList.contains("component-editor-dialog")).toBe(true);
    expect(within(dialog).getByDisplayValue("An outside article")).toBeVisible();
  });
});

describe("RecordForm page writing portal", () => {
  it("leaves title and summary in the form when no writing target is provided", () => {
    render(
      <RecordForm
        kind="page"
        canSave
        initial={{ title: "Contact NJ PBS", description: "Reach the station." }}
      />,
    );

    expect(screen.getByRole("textbox", { name: /^Page title/ })).toHaveValue("Contact NJ PBS");
    expect(screen.getByLabelText(/^Page summary/)).toHaveValue("Reach the station.");
  });

  it("keeps portaled Page title and summary dirty, focused after validation, and saved through the form persist path", async () => {
    const save = vi.fn();
    const reveal = vi.fn();
    const onDraftChange = vi.fn();
    function Workspace({ readOnly = false }: { readOnly?: boolean }) {
      const [target, setTarget] = useState<HTMLDivElement | null>(null);
      return (
        <>
          <section aria-label="Main area">
            <article aria-label="Title and summary">
              <div ref={setTarget} />
            </article>
          </section>
          <section aria-label="Side panel">
            <RecordForm
              canSave
              kind="page"
              writingTarget={target}
              onRevealField={reveal}
              onDraftChange={onDraftChange}
              readOnly={readOnly}
              initial={{ title: "Contact NJ PBS", description: "Reach the station." }}
              initialIsClean
              onSave={save}
            />
          </section>
        </>
      );
    }

    const view = render(<Workspace />);
    const writing = within(screen.getByRole("region", { name: "Main area" }));
    const settings = within(screen.getByRole("region", { name: "Side panel" }));
    const title = writing.getByRole("textbox", { name: /^Page title/ });
    const summary = writing.getByLabelText(/^Page summary/);

    expect(settings.queryByRole("textbox", { name: /^Page title/ })).toBeNull();
    fireEvent.change(title, { target: { value: "Updated contact" } });
    fireEvent.change(summary, { target: { value: "Updated summary" } });
    expect(onDraftChange.mock.lastCall?.[0]).toMatchObject({
      title: "Updated contact",
      description: "Updated summary",
    });

    fireEvent.change(title, { target: { value: "" } });
    fireEvent.click(settings.getByRole("button", { name: "Save" }));
    expect(save).not.toHaveBeenCalled();
    expect(reveal).toHaveBeenCalledWith("title", expect.stringContaining("record-page-title"));
    expect(writing.getByRole("textbox", { name: /^Page title/ })).toHaveFocus();

    fireEvent.change(writing.getByRole("textbox", { name: /^Page title/ }), {
      target: { value: "Updated contact" },
    });
    fireEvent.click(settings.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      title: "Updated contact",
      description: "Updated summary",
    });

    view.rerender(<Workspace readOnly />);
    expect(writing.getByRole("textbox", { name: /^Page title/ })).toBeDisabled();
    expect(writing.getByLabelText(/^Page summary/)).toBeDisabled();
    expect(writing.getByRole("textbox", { name: /^Page title/ }).closest("fieldset")).toHaveAttribute(
      "inert",
    );
  });
});

describe("Page title save and lifecycle through the workspace", () => {
  it("saves a portaled Page title through the shared page transaction", async () => {
    const actions = document.createElement("div");
    document.body.append(actions);
    const savePage = vi.fn(async (_id: PublicPageId, _section: SectionId, blocks: AdminBlock[]) => ({
      blocks,
      version: 2,
    }));
    const savePageMetadata = vi.fn(async (_id: PublicPageId, _section: SectionId, metadata: Record<string, unknown>) => ({
      blocks: [],
      metadata,
      version: 2,
    }));

    render(
      <WorkspaceActionsProvider target={actions}>
        <EditorWorkspace
          principal={admin}
          loadPage={async () => ({
            blocks: [],
            metadata: { title: "Contact NJ PBS", description: "Reach the station." },
            version: 1,
            status: "draft",
          })}
          savePage={savePage}
          savePageMetadata={savePageMetadata}
          surface={{ kind: "page", pageId: "contact", section: "genericPage" }}
        />
      </WorkspaceActionsProvider>,
    );

    const writing = await screen.findByRole("region", { name: "Main area" });
    const title = within(writing).getByRole("textbox", { name: /^Page title/ });
    const save = await screen.findByRole("button", { name: "Save draft" });
    expect(save).toBeDisabled();
    fireEvent.change(title, { target: { value: "Updated contact" } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(savePageMetadata).toHaveBeenCalledTimes(1));
    expect(savePage).not.toHaveBeenCalled();
    expect(savePageMetadata.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ title: "Updated contact" }),
    );
    actions.remove();
  });

  it("makes portaled Page title and summary inert for a reviewed lifecycle", async () => {
    renderPageWorkspace("contact", "genericPage", {
      metadata: { title: "Contact NJ PBS", description: "Reach the station." },
      version: 1,
      status: "in_review",
    });

    const writing = await screen.findByRole("region", { name: "Main area" });
    const title = within(writing).getByRole("textbox", { name: /^Page title/ });
    expect(title).toBeDisabled();
    expect(within(writing).getByLabelText(/^Page summary/)).toBeDisabled();
    expect(title.closest("fieldset")).toHaveAttribute("inert");
  });
});
