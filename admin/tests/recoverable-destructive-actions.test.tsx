import { afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { BlockEditor } from "../src/components/BlockEditor";
import {
  EditorWorkspace,
  type PageContent,
} from "../src/components/EditorWorkspace";
import type { AdminBlock } from "../src/lib/block-factory";
import type {
  GetRevisionResponse,
  ListRevisionsResponse,
  MediaAssetSummary,
  RestoreRevisionResponse,
} from "../src/lib/functions";
import type { Principal } from "../../packages/content-core/src/rbac";
import type { PublicPageId } from "../../packages/content-core/src/public-pages";
import type { SectionId } from "../../packages/content-core/src/editor-admin";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function editComponent(name: string) {
  const dialog = screen.queryByRole("dialog", { name });
  if (!dialog) fireEvent.click(screen.getByRole("button", { name: `Edit ${name}` }));
}
function doneEditing() {
  for (const dialog of screen.queryAllByRole("dialog")) {
    if (dialog.classList.contains("component-editor-dialog")) fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  }
}

function removalNotice() {
  return document.querySelector<HTMLElement>('.block-editor-removal-notice[role="status"]');
}

function counterIds() {
  let n = 0;
  return () => `b${++n}`;
}

const pickerImage: MediaAssetSummary = {
  id: "asset-news-desk",
  name: "News desk",
  originalName: "news-desk.png",
  category: "news",
  categories: ["news"],
  tags: ["studio"],
  description: null,
  altText: "A presenter at the news desk",
  license: "NJ PBS owned",
  credit: "NJ PBS",
  mimeType: "image/png",
  kind: "image",
  sizeBytes: 2_048,
  width: 1_600,
  height: 900,
  url: "https://media.njpbs.org/news-desk.png",
  lifecycle: "active",
  version: 1,
  etag: '"media.YXNzZXQtbmV3cy1kZXNr.1"',
  createdAt: "2026-08-13T12:00:00.000Z",
  createdBy: "editor-1",
  updatedAt: "2026-08-13T12:00:00.000Z",
  updatedBy: "editor-1",
};

function headline(id: string, text: string, order: number): AdminBlock {
  return { id, type: "headline", order, visible: true, data: { text, level: 2 } };
}

function writtenText(id: string, order: number): AdminBlock {
  return {
    id,
    type: "prose",
    order,
    visible: true,
    data: {
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Watch live." }] }],
      },
    },
  };
}

function gallery(id: string, order: number): AdminBlock {
  return {
    id,
    type: "image_gallery",
    order,
    visible: true,
    data: {
      images: [
        { assetId: "asset-one", alt: "Newark skyline", altDecorative: false, caption: "" },
        { assetId: "asset-two", alt: "The news desk", altDecorative: false, caption: "" },
      ],
    },
  };
}

function kindsInOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".block-card-kind")).map(
    (element) => element.textContent ?? "",
  );
}

// Removing a populated block is whole-block destruction: several fields, and in a gallery or card
// set several items, go at once, and the block that replaces it on screen looks nothing like what
// was there. That is the case a confirmation fits, and the question names the block and counts
// what it holds (#1035).
describe("confirming a populated block removal (#1035)", () => {
  it("asks before removing a populated block and names what will be removed", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0)]}
        newId={counterIds()}
      />,
    );

    editComponent("heading 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    // Nothing is gone yet: the block stands until the question is answered.
    expect(kindsInOrder(container)).toEqual(["heading"]);
    expect(
      screen.getByText('Remove heading 1 “Tonight on NJ PBS”?'),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of heading 1" }),
    );
    expect(kindsInOrder(container)).toEqual([]);
  });

  it("counts the items a gallery holds in the question", () => {
    render(
      <BlockEditor
        section="home"
        initialBlocks={[gallery("g1", 0)]}
        newId={counterIds()}
      />,
    );
    editComponent("image gallery 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove image gallery 1" }));
    expect(screen.getByText("Remove image gallery 1?")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByText(/2 images/)).toBeTruthy();
  });

  it("keeps the block when the question is cancelled", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0)]}
        newId={counterIds()}
      />,
    );
    editComponent("heading 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel removal of heading 1" }));
    expect(kindsInOrder(container)).toEqual(["heading"]);
    expect(screen.queryByText(/^Remove heading 1/)).toBeNull();
  });

  it("removes an empty block with no question, keeping routine tidying friction-free", () => {
    const { container } = render(
      <BlockEditor section="home" newId={counterIds()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add content: position 1" }));
    fireEvent.click(within(
      screen.getByRole("radiogroup", { name: "Content types at position 1" }),
    ).getByRole("radio", { name: "heading" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    expect(kindsInOrder(container)).toEqual(["heading"]);

    editComponent("heading 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    expect(kindsInOrder(container)).toEqual([]);
  });
});

// Every removal, confirmed or not, leaves a visible way back that names what went (#1035).
describe("the removal undo affordance (#1035)", () => {
  it("names the removed block and takes it back", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0)]}
        newId={counterIds()}
      />,
    );
    editComponent("heading 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of heading 1" }),
    );

    const notice = removalNotice()!;
    expect(notice).toHaveTextContent('Removed heading 1 “Tonight on NJ PBS”.');
    // The removal destroyed the control that had focus, so recovery is where focus lands.
    const undo = within(notice).getByRole("button", { name: "Undo removal" });
    expect(document.activeElement).toBe(undo);

    fireEvent.click(undo);
    expect(kindsInOrder(container)).toEqual(["heading"]);
    expect(removalNotice()).toBeNull();
  });

  it("drops the notice once a later edit means Undo would reverse something else", () => {
    render(
      <BlockEditor
        section="home"
        initialBlocks={[
          headline("h1", "Tonight on NJ PBS", 0),
          headline("h2", "Watch live", 1),
        ]}
        newId={counterIds()}
      />,
    );
    editComponent("heading 2");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 2" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of heading 2" }),
    );
    expect(removalNotice()!).toBeTruthy();

    editComponent("heading 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS at 7" },
    });
    // The undo stack has moved on, so an "Undo removal" button here would lie about what it does.
    expect(removalNotice()).toBeNull();
  });

  // Closing either surface takes the focused control away with it. Focus has to land somewhere a
  // person can work from -- and, because the history shortcut is scoped to this editor, somewhere
  // inside it, or the next Command-Z reaches nothing.
  it("returns focus to the Remove control when the question is cancelled", () => {
    render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0)]}
        newId={counterIds()}
      />,
    );
    editComponent("heading 1");
    const remove = screen.getByRole("button", { name: "Remove heading 1" });
    remove.focus();
    fireEvent.click(remove);

    const cancel = screen.getByRole("button", { name: "Cancel removal of heading 1" });
    cancel.focus();
    fireEvent.click(cancel);

    expect(screen.queryByText(/^Remove heading 1/)).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove heading 1" }),
    );
  });

  it("keeps focus in the editor when the notice is dismissed", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0), writtenText("p1", 1)]}
        newId={counterIds()}
      />,
    );
    editComponent("text 2");
    fireEvent.click(screen.getByRole("button", { name: "Remove text 2" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of text 2" }),
    );
    const dismiss = screen.getByRole("button", { name: "Dismiss removal notice" });
    dismiss.focus();
    fireEvent.click(dismiss);

    const surface = container.querySelector(".block-editor") as HTMLElement;
    expect(document.activeElement).toBe(surface);
    // And the shortcut still reaches this editor's history, which is the point.
    expect(
      (screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.keyDown(surface, { key: "z", metaKey: true });
    expect(kindsInOrder(container)).toEqual(["heading", "text"]);
  });

  it("dismisses the notice without putting the block back", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0)]}
        newId={counterIds()}
      />,
    );
    editComponent("heading 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of heading 1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss removal notice" }));
    expect(removalNotice()).toBeNull();
    expect(kindsInOrder(container)).toEqual([]);
  });
});

// The reported failure was exactly this: Command-Z restored text but never brought the block back,
// because the page editor had no keyboard history at all (#1035).
describe("keyboard history in the block editor (#1035)", () => {
  it("takes back a removal on the undo shortcut and puts it forward again on redo", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0)]}
        newId={counterIds()}
      />,
    );
    editComponent("heading 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of heading 1" }),
    );
    expect(kindsInOrder(container)).toEqual([]);

    const surface = container.querySelector(".block-editor") as HTMLElement;
    fireEvent.keyDown(surface, { key: "z", metaKey: true });
    expect(kindsInOrder(container)).toEqual(["heading"]);

    fireEvent.keyDown(surface, { key: "z", metaKey: true, shiftKey: true });
    expect(kindsInOrder(container)).toEqual([]);
  });

  it("keeps focus in the editor so a second shortcut still reaches the history", () => {
    // Found in browser review: undoing from the notice takes that button away with it, focus fell
    // to the document body, and the next Command-Shift-Z reached nothing because the shortcut is
    // scoped to this editor's subtree.
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0)]}
        newId={counterIds()}
      />,
    );
    editComponent("heading 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of heading 1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo removal" }));
    expect(kindsInOrder(container)).toEqual(["heading"]);

    const surface = container.querySelector(".block-editor") as HTMLElement;
    expect(document.activeElement).toBe(surface);
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "z",
      metaKey: true,
      shiftKey: true,
    });
    expect(kindsInOrder(container)).toEqual([]);
  });

  it("leaves the shortcut to the field a person is typing in", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[
          headline("h1", "Tonight on NJ PBS", 0),
          headline("h2", "Watch live", 1),
        ]}
        newId={counterIds()}
      />,
    );
    editComponent("heading 2");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 2" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of heading 2" }),
    );

    // A text control owns its own native undo; the page history must not reach past it and
    // resurrect a block while somebody is retyping a heading.
    editComponent("heading 1");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Heading" }), {
      key: "z",
      metaKey: true,
    });
    expect(kindsInOrder(container)).toEqual(["heading"]);
  });

  it("moves a redone step back onto the undo control", () => {
    render(
      <BlockEditor
        section="home"
        initialBlocks={[headline("h1", "Tonight on NJ PBS", 0)]}
        newId={counterIds()}
      />,
    );
    const redo = screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement;
    expect(redo.disabled).toBe(true);

    editComponent("heading 1");
    fireEvent.click(screen.getByRole("button", { name: "Remove heading 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm removal of heading 1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo removal" }));
    expect(
      (screen.getByRole("button", { name: "Redo" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

// A single item inside a block is a smaller loss with an obvious shape, so it removes at once and
// offers the way back rather than stopping the person with a modal question (#1035).
describe("recovering a removed collection item (#1035)", () => {
  it("restores a PDF notice through the focused shared removal action", async () => {
    const notice = { itemId: "notice-1", assetId: "pdf-1", title: "October meeting", publisher: "njpba", addedAt: "2026-10-01T12:00:00.000Z" };
    render(<BlockEditor section="genericPage" initialBlocks={[
      { id: "notices", type: "document_list", order: 0, visible: true, data: { documents: [notice] } },
    ]} newId={counterIds()} />);
    editComponent("PDF notices 1");
    const remove = screen.getByRole("button", { name: "Remove October meeting from notices" });
    remove.focus();
    fireEvent.click(remove);
    expect(screen.queryByRole("textbox", { name: "Notice title 1" })).not.toBeInTheDocument();
    const undo = screen.getByRole("button", { name: "Undo removal" });
    await waitFor(() => expect(undo).toHaveFocus());
    expect(undo.closest('[role="status"]')).toHaveTextContent('Removed notice 1 “October meeting”.');
    fireEvent.click(undo);
    editComponent("PDF notices 1");
    expect(screen.getByRole("textbox", { name: "Notice title 1" })).toHaveValue("October meeting");
    expect(screen.queryByText(/Removed .*October meeting/)).not.toBeInTheDocument();
  });

  it("names a removed gallery image and restores it, with no question in the way", () => {
    const { container } = render(
      <BlockEditor
        section="home"
        initialBlocks={[gallery("g1", 0)]}
        newId={counterIds()}
      />,
    );

    editComponent("image gallery 1");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove image 2 from gallery" }),
    );
    expect(container.querySelectorAll(".inline-gallery-item")).toHaveLength(1);

    doneEditing();
    const notice = removalNotice()!;
    expect(notice).toHaveTextContent('Removed image 2 “The news desk”.');

    fireEvent.click(within(notice).getByRole("button", { name: "Undo removal" }));
    editComponent("image gallery 1");
    expect(container.querySelectorAll(".inline-gallery-item")).toHaveLength(2);
    expect(
      (screen.getByRole("textbox", { name: "Alt text 2" }) as HTMLInputElement).value,
    ).toBe("The news desk");
  });

  it("names a cleared image by the asset it was and restores the choice", async () => {
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [pickerImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    }));
    render(
      <BlockEditor
        section="home"
        initialBlocks={[
          {
            id: "i1",
            type: "image",
            order: 0,
            visible: true,
            data: {
              assetId: pickerImage.id,
              alt: "Newark skyline",
              altDecorative: false,
              caption: "",
            },
          },
        ]}
        newId={counterIds()}
        loadMedia={loadMedia}
      />,
    );

    editComponent("image 1");
    await screen.findByDisplayValue(pickerImage.name);
    fireEvent.click(screen.getByRole("button", { name: "Remove image" }));
    doneEditing();
    expect(removalNotice()!).toHaveTextContent(
      `Removed image “${pickerImage.name}”.`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo removal" }));
    editComponent("image 1");
    expect(await screen.findByDisplayValue(pickerImage.name)).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Alt text" }) as HTMLInputElement).value,
    ).toBe("Newark skyline");
  });

  it("names a cleared card image and restores it, like every other media removal", async () => {
    const loadMedia = vi.fn(async () => ({
      success: true as const,
      records: [pickerImage],
      total: 1,
      allCount: 1,
      page: 1,
      pageCount: 1,
      categoryCounts: { news: 1 },
      kindCounts: { image: 1, document: 0 },
    }));
    render(
      <BlockEditor
        section="home"
        initialBlocks={[
          {
            id: "c1",
            type: "card_grid",
            order: 0,
            visible: true,
            data: {
              cards: [
                { title: "Passport", imageAssetId: pickerImage.id, href: "", body: undefined },
              ],
            },
          },
        ]}
        newId={counterIds()}
        loadMedia={loadMedia}
      />,
    );

    editComponent("card set 1");
    // The card picker resolves the chosen asset's name before the notice can use it.
    await screen.findByText(pickerImage.name);
    fireEvent.click(screen.getByRole("button", { name: "Remove card image 1" }));
    doneEditing();
    expect(removalNotice()!).toHaveTextContent(
      `Removed image “${pickerImage.name}”.`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo removal" }));
    editComponent("card set 1");
    expect(await screen.findByText(pickerImage.name)).toBeTruthy();
  });

  it("names a removed button by its label", () => {
    render(
      <BlockEditor
        section="home"
        initialBlocks={[
          {
            id: "c1",
            type: "cta_row",
            order: 0,
            visible: true,
            data: {
              ctas: [
                { label: "Donate", href: "https://example.org/", variant: "primary" },
                { label: "Watch live", href: "https://example.org/live", variant: "secondary" },
              ],
            },
          },
        ]}
        newId={counterIds()}
      />,
    );
    editComponent("buttons 1");
    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove button 2" }));
    doneEditing();
    expect(removalNotice()!).toHaveTextContent('Removed button 2 “Watch live”.');
  });
});

// The last line of recovery: a removal that was saved is no longer on the undo stack, so it has to
// come back through revision history (#913). This walks the whole path a person actually takes.
describe("recovering a saved removal through revision history (#1035)", () => {
  const admin: Principal = { id: "admin", grants: [{ role: "admin" }] };

  function pageWith(blocks: AdminBlock[], version: number): PageContent {
    return {
      blocks,
      metadata: { title: "Home" },
      createdBy: "admin",
      status: "draft",
      version,
    };
  }

  it("saves the removal, then restores the version that still has the block", async () => {
    const before = [
      headline("h1", "Tonight on NJ PBS", 0),
      headline("h2", "Watch live", 1),
    ];
    let stored = pageWith(before, 4);
    const loadPage = vi.fn(
      async (_pageId: PublicPageId, _section: SectionId): Promise<PageContent> => stored,
    );
    const savePage = vi.fn(async (_pageId, _section, blocks: AdminBlock[]) => {
      stored = pageWith(blocks, 5);
      return { blocks, version: 5 };
    });
    const loadRevisions = vi.fn(async (): Promise<ListRevisionsResponse> => ({
      success: true,
      nextCursor: null,
      entries: [
        {
          id: "revision-4",
          action: "update",
          actorUid: "admin",
          actorEmail: "admin@example.com",
          at: "2026-08-18T20:15:00.000Z",
          beforeVersion: 3,
          version: 4,
          beforeStatus: "draft",
          status: "draft",
          beforeBlockCount: 2,
          blockCount: 2,
          mediaReferenceCount: 0,
          mediaReferencesAdded: 0,
          mediaReferencesRemoved: 0,
          beforeTruncated: false,
          diffAvailable: true,
          changedFields: ["blocks"],
          changedFieldCount: 1,
          changedFieldsTruncated: false,
        },
      ],
    }));
    const loadRevision = vi.fn(async (): Promise<GetRevisionResponse> => ({
      success: true,
      revision: {
        id: "revision-4",
        collection: "cmsPages",
        documentId: "home",
        action: "update",
        actorUid: "admin",
        actorEmail: "admin@example.com",
        at: "2026-08-18T20:15:00.000Z",
        beforeTruncated: false,
        before: { version: 3 },
        after: { version: 4 },
      },
    }));
    const restoreRevision = vi.fn(async (): Promise<RestoreRevisionResponse> => {
      stored = pageWith(before, 6);
      return {
        success: true,
        collection: "cmsPages",
        id: "home",
        revisionId: "revision-5",
        sourceRevisionId: "revision-4",
        sourceVersion: 4,
        version: 6,
        document: { version: 6 },
      };
    });

    render(
      <MemoryRouter>
        <EditorWorkspace
          principal={admin}
          loadPage={loadPage}
          savePage={savePage}
          loadRevision={loadRevision}
          loadRevisions={loadRevisions}
          restoreRevision={restoreRevision}
          surface={{ kind: "page", pageId: "home", section: "home" }}
          newId={counterIds()}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit heading 2" }));
    await screen.findByDisplayValue("Watch live");
    // Keep role queries in their panel: scanning every workspace button is slow in jsdom.
    const heading = within(screen.getAllByRole("region", { name: "heading" })[1]!);
    fireEvent.click(heading.getByRole("button", { name: "Remove heading 2" }));
    fireEvent.click(
      heading.getByRole("button", { name: "Confirm removal of heading 2" }),
    );
    expect(screen.queryByDisplayValue("Watch live")).toBeNull();

    const commands = within(screen.getByRole("toolbar", { name: "Page editing commands" }));
    fireEvent.click(commands.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(savePage).toHaveBeenCalledTimes(1));
    expect(savePage.mock.calls[0]![2].map((block) => block.id)).toEqual(["h1"]);

    fireEvent.click(screen.getByRole("button", { name: "Revision history" }));
    const history = within(screen.getByRole("region", { name: "Revision history" }));
    fireEvent.click(await history.findByRole("button", { name: "Inspect version 4" }));
    fireEvent.click(await history.findByRole("button", { name: "Restore version 4" }));
    fireEvent.click(
      await history.findByRole("button", { name: "Confirm restore of version 4" }),
    );

    await waitFor(() => expect(restoreRevision).toHaveBeenCalledTimes(1));
    // The saved removal is back in the working copy, read from the store rather than from a
    // local snapshot.
    fireEvent.click(await screen.findByRole("button", { name: "Edit heading 2" }));
    expect(await screen.findByDisplayValue("Watch live")).toBeTruthy();
  });
});


