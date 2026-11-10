import { EditorWorkspaceViewProvider } from "../src/context/EditorWorkspaceView";
import { StrictMode } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RecordForm, type RecordSaveReceipt } from "../src/components/RecordForm";
import { LifecycleActionsPanel } from "../src/components/LifecycleActionsPanel";
import { WorkspaceActionsProvider } from "../src/components/WorkspaceActions";
import { HttpError } from "../src/lib/functions";
import type { RichTextDoc } from "../../packages/content-core/src/content-model";
import type {
  ListMediaResponse,
  MediaCategoryDefinition,
} from "../src/lib/functions";

afterEach(cleanup);
afterEach(() => localStorage.clear());

const filledBio: RichTextDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Reporter and producer." }] }],
};

const pickerResult: ListMediaResponse = {
  success: true,
  records: [
    {
      id: "asset-garden",
      name: "Garden State newsroom",
      originalName: "garden-state.jpg",
      category: "newsroom",
      categories: ["newsroom"],
      tags: ["newsroom"],
      description: null,
      altText: "A reporter at the NJ PBS newsroom desk.",
      license: "owned",
      credit: "NJ PBS",
      mimeType: "image/jpeg",
      kind: "image",
      sizeBytes: 1200,
      width: 1600,
      height: 900,
      url: "https://media.njpbs.org/cms-media/newsroom/asset-garden/hash.jpg",
      lifecycle: "active",
      version: 1,
      etag: '"asset-garden:1"',
      createdAt: "2026-08-13T00:00:00.000Z",
      createdBy: "editor-1",
      updatedAt: "2026-08-13T00:00:00.000Z",
      updatedBy: "editor-1",
    },
  ],
  total: 1,
  allCount: 1,
  page: 1,
  pageCount: 1,
  categoryCounts: { newsroom: 1 },
  kindCounts: { image: 1, document: 0 },
};

const pickerCategories: MediaCategoryDefinition[] = [
  {
    id: "newsroom",
    label: "Newsroom",
    description: "Newsroom media",
    order: 10,
    active: true,
    reserved: false,
    version: 1,
    etag: '"media-category.bmV3c3Jvb20.1"',
    canUpload: true,
    canManage: false,
    createdAt: null,
    createdBy: null,
    updatedAt: null,
    updatedBy: null,
  },
];

describe("RecordForm", () => {
  it.each([
    ["in_review", "In review"], ["archived", "Deleted"], ["draft", "working draft"],
  ])("uses staff workflow wording in the Article subtitle (%s)", (status, expected) => {
    const initial = { title: "Status wording", status, blocks: [] };
    const snapshot = structuredClone(initial);
    const onSave = vi.fn();
    render(<EditorWorkspaceViewProvider kind="post"><RecordForm kind="post"
      initial={initial} onSave={onSave} canSave /></EditorWorkspaceViewProvider>);
    expect(screen.getByText(`0 rows · 0 blocks · ${expected}`)).toBeVisible();
    expect(initial).toEqual(snapshot);
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("names the story date link and inspector when the date is unset (%s)", async date => {
    render(<EditorWorkspaceViewProvider kind="post"><RecordForm kind="post"
      initial={{ title: "Draft with no date", date, blocks: [] }} onSave={() => {}} canSave /></EditorWorkspaceViewProvider>);
    const link = within(screen.getByLabelText("Story metadata")).getByRole("link", { name: "Date not set" });
    expect(link).toHaveAttribute("href", "#record-post-date");
    fireEvent.click(link);
    await waitFor(() => expect(document.querySelector(".editor-inspector-date")).toHaveTextContent("Date not set"));
  });

  it.each([
    { current: 'Current reporter', frozen: 'Earlier reporter', expected: 'Current reporter' },
    { current: null, frozen: 'Earlier reporter', expected: 'Earlier reporter' },
    { current: null, frozen: null, expected: 'Author no longer listed' },
  ])('projects registered credits consistently in the story strip and Byline summary: $expected', ({ current, frozen, expected }) => {
    const authorId = `au_${'b'.repeat(32)}`;
    render(<EditorWorkspaceViewProvider kind="post"><RecordForm kind="post"
      initial={{ title: 'Registered byline', blocks: [], credits: [{ kind: 'registered', authorId, ...(frozen ? { displayName: frozen } : {}) }] }}
      bylineAuthors={current ? [{ authorId, displayName: current, jobTitle: 'Reporter' }] : []}
      onSave={() => {}} canSave /></EditorWorkspaceViewProvider>);
    expect(within(screen.getByLabelText('Story metadata')).getByRole('link', { name: expected })).toBeVisible();
    expect(document.querySelector('.editor-byline-details summary')).toHaveTextContent(expected);
    expect(document.querySelector('.editor-byline-details summary')).not.toHaveTextContent('Credit needs review');
  });

  it("disables the canonical workspace Presentation selector when an edit lock arrives", () => {
    const draft = vi.fn();
    const form = (readOnly: boolean) => <EditorWorkspaceViewProvider kind="post"><RecordForm kind="post" initial={{ title: "Station update", blocks: [] }} onSave={() => {}} canSave readOnly={readOnly} onDraftChange={draft} /></EditorWorkspaceViewProvider>;
    const view = render(form(false));
    const presentation = screen.getByRole("combobox", { name: "Presentation" });
    expect(presentation).toBeEnabled();
    const calls = draft.mock.calls.length;
    view.rerender(form(true));
    expect(screen.getByRole("combobox", { name: "Presentation" })).toBe(presentation);
    expect(presentation).toBeDisabled();
    expect(draft).toHaveBeenCalledTimes(calls);
  });

  it("keeps the Post title draft mounted when its bento panel moves", () => {
    const onDraftChange = vi.fn();
    render(
      <RecordForm
        kind="post"
        initial={{ title: "Station update", blocks: [] }}
        onDraftChange={onDraftChange}
        onSave={() => {}}
        canSave
      />,
    );
    const title = screen.getByRole("textbox", { name: "Post title" });
    fireEvent.change(title, { target: { value: "Edited station update" } });
    const draftChangeCount = onDraftChange.mock.calls.length;

    fireEvent.keyDown(screen.getByRole("button", { name: "Move section: Post title" }), { key: "ArrowDown" });

    expect(screen.getByRole("textbox", { name: "Post title" })).toBe(title);
    expect(title).toHaveValue("Edited station update");
    expect(onDraftChange).toHaveBeenCalledTimes(draftChangeCount);
    expect(
      within(screen.getByRole("region", { name: "Main area" }))
        .getAllByRole("article")
        .map((panel) => panel.getAttribute("data-panel-id")),
    ).toEqual(["post-body", "post-title", "post-live-blog"]);
    expect(localStorage.getItem("njpbs.admin.editor-bento.v2.post")).toContain(
      '"id":"post-title"',
    );
  });

  it("uses the requested default disclosure state for Post bento panels", () => {
    const post = (
      <RecordForm
        kind="post"
        initial={{ title: "Station update", blocks: [] }}
        onSave={() => {}}
        canSave
        sections={[{ id: "news", label: "News" }]}
        postInspector={<p>Publication controls</p>}
      />
    );
    const view = render(post);
    expect(screen.getByRole("button", { name: "Metadata" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Hero image" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: "Lifecycle" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      within(screen.getByRole("region", { name: "Main area" })).getByLabelText(/^Area/),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "Side panel" })).getByRole(
        "article",
        { name: "Lifecycle" },
      ),
    ).toContainElement(screen.getByText("Publication controls"));
    for (const title of ["Listing fallback", "Dates", "Search", "Social sharing"]) {
      expect(screen.getByRole("button", { name: title })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Metadata" }));
    view.rerender(post);
    expect(screen.getByRole("button", { name: "Metadata" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("reveals the Publication panel when a workspace workflow action starts", async () => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    const view = render(
      <WorkspaceActionsProvider target={actionsTarget}>
        <RecordForm
          kind="post"
          initial={{ id: "post-1", title: "Station update", version: 1, blocks: [] }}
          onSave={() => {}}
          canSave
          postInspector={
            <LifecycleActionsPanel
              baseVersion={1}
              canArchive={false}
              canEdit
              canRestore={false}
              canUnpublish={false}
              collection="cmsPosts"
              documentId="post-1"
              headless
              onTransition={vi.fn()}
              publicationSupported
              status="draft"
              workspaceActions
            />
          }
        />
      </WorkspaceActionsProvider>,
    );

    try {
      const publication = screen.getByRole("article", { name: "Lifecycle" });
      const toggle = within(publication).getByRole("button", {
        name: "Lifecycle",
      });
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(
        within(actionsTarget).getByRole("button", { name: "Submit for review" }),
      );

      await waitFor(() =>
        expect(toggle).toHaveAttribute("aria-expanded", "true"),
      );
    } finally {
      view.unmount();
      actionsTarget.remove();
    }
  });

  it("keeps read-only Post metadata disclosures usable while fields stay locked", () => {
    render(
      <RecordForm
        kind="post"
        initial={{ title: "Approved update", blocks: [] }}
        onSave={() => {}}
        canSave
        readOnly
      />,
    );
    const searchPanel = screen.getByRole("article", { name: "Search" });
    const toggle = within(searchPanel).getByRole("button", { name: "Search" });
    expect(toggle.closest("fieldset")).toBeNull();
    expect(toggle).toBeEnabled();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const searchTitle = screen.getByLabelText("Search title");
    const fieldBoundary = searchTitle.closest("fieldset");
    expect(fieldBoundary).toBeDisabled();
    expect(fieldBoundary).toHaveAttribute("inert");
  });

  it("keeps locked Post image summaries and their saved metadata inspectable", async () => {
    const onSave = vi.fn();
    const loadMedia = vi.fn(async () => pickerResult);
    render(<EditorWorkspaceViewProvider kind="post"><RecordForm kind="post" readOnly canSave
      initial={{ title: "Approved update", blocks: [], heroImage: "asset-garden",
        heroImageAlt: "A reporter at the desk", heroImageCaption: "Evening report",
        heroBackgroundImage: "asset-garden", heroBackgroundPosition: "top" }}
      loadMedia={loadMedia} onSave={onSave} /></EditorWorkspaceViewProvider>);
    for (const key of ["heroBackgroundImage"]) {
      const details = document.querySelector<HTMLDetailsElement>(`[data-image-role="${key}"]`)!;
      const summary = details.querySelector("summary")!;
      expect(summary.closest("[inert]")).toBeNull();
      expect(summary).not.toHaveAttribute("aria-disabled", "true");
      expect(summary).not.toHaveAttribute("tabindex", "-1");
      fireEvent.click(summary);
      expect(details.open).toBe(true);
      for (const control of details.querySelectorAll("input, textarea, select, button")) expect(control).toBeDisabled();
    }
    expect(screen.getByRole("textbox", { name: "Lead image alt text" })).toHaveValue("A reporter at the desk");
    expect(screen.getByRole("textbox", { name: "Lead image caption" })).toHaveValue("Evening report");
    const crop = screen.getByRole("group", { name: "Background crop position" });
    expect(within(crop).getByRole("button", { name: "Top" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); });
  });

  it("opens a locked empty image for inspection without launching the picker", () => {
    const onSave = vi.fn();
    render(<EditorWorkspaceViewProvider kind="post"><RecordForm kind="post" readOnly canSave
      initial={{ title: "Approved update", blocks: [] }} loadMedia={async () => pickerResult}
      onSave={onSave} /></EditorWorkspaceViewProvider>);
    expect(screen.getByLabelText("Lead media type")).toBeDisabled();
    expect(screen.getByLabelText("Lead media type")).toHaveValue("image");
    expect(screen.getByRole("button", { name: "Choose lead image" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("reveals and focuses a collapsed metadata group that contains a save error", async () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "Station update",
          heroImage: "asset-garden",
          heroImageAlt: "A reporter at a desk",
          heroImageDecorative: true,
          blocks: [],
        }}
        onDraftChange={onDraftChange}
        onSave={onSave}
        canSave
      />,
    );

    const heroImage = screen.getByRole("article", { name: "Hero image" });
    const heroImageToggle = within(heroImage).getByRole("button", {
      name: "Hero image",
    });
    fireEvent.click(heroImageToggle);
    expect(heroImageToggle).toHaveAttribute("aria-expanded", "false");

    const draftChangeCount = onDraftChange.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alt = screen.getByLabelText("Lead image alt text") as HTMLInputElement;
    await waitFor(() =>
      expect(heroImageToggle).toHaveAttribute("aria-expanded", "true"),
    );
    await waitFor(() => expect(alt).toHaveFocus());
    expect(alt).toHaveAttribute("aria-invalid", "true");
    const errorId = "record-post-heroImage-error";
    expect(alt.getAttribute("aria-describedby")?.split(" ")).toContain(errorId);
    expect(document.getElementById(errorId)).toHaveTextContent(
      "Lead image alt text must be empty while Mark lead image as decorative is on.",
    );
    expect(onDraftChange).toHaveBeenCalledTimes(draftChangeCount);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("renders every editor field for the record kind", () => {
    render(<RecordForm kind="staff" onSave={() => {}} canSave />);
    expect(screen.getByLabelText(/^Name/)).toBeTruthy();
    expect(screen.getByLabelText(/^Role/)).toBeTruthy();
    // Bio is rich text, labelled by a heading rather than a wrapping <label>.
    expect(screen.getByText("Bio")).toBeTruthy();
  });

  it("refuses to save while a required field is empty and marks each one", () => {
    const onSave = vi.fn();
    render(<RecordForm kind="staff" onSave={onSave} canSave />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Name is required.")).toBeTruthy();
    expect(screen.getByText("Role is required.")).toBeTruthy();
    expect(screen.getByText("Bio is required.")).toBeTruthy();
  });

  it("saves an incomplete Post draft and keeps its first section choice available", async () => {
    let releaseCreate!: () => void;
    let releaseAssignment!: () => void;
    let saveCount = 0;
    const onSave = vi.fn((record: Record<string, unknown>) => {
      saveCount += 1;
      if (saveCount === 1) {
        return new Promise<RecordSaveReceipt>((resolve) => {
          releaseCreate = () => resolve({
            kind: "record-save-receipt" as const,
            document: {
              ...record,
              id: "post-1",
              version: 1,
              status: "draft",
              unassignedDraft: true,
            },
            mintedIds: {},
          });
        });
      }
      const document: Record<string, unknown> = { ...record, id: "post-1", version: 2, status: "draft" };
      delete document.unassignedDraft;
      return new Promise<RecordSaveReceipt>((resolve) => {
        releaseAssignment = () => resolve({
          kind: "record-save-receipt" as const,
          document,
          mintedIds: {},
        });
      });
    });
    const sections = [
      { id: "watch", label: "Watch" },
      { id: "support", label: "Support" },
    ];
    render(
      <RecordForm
        kind="post"
        allowIncomplete
        canSave
        initial={{
          blocks: [
            {
              id: "draft-body",
              type: "prose",
              order: 0,
              visible: true,
              data: { content: { type: "doc", content: [] } },
            },
          ],
        }}
        onSave={onSave}
        sections={sections}
      />,
    );

    const saveButton = within(document.querySelector<HTMLElement>(".record-form-actions")!).getByRole("button", { name: "Save" });
    expect(saveButton).toBeVisible();
    const title = screen.getByLabelText(/^Post title/, { selector: "input" });
    fireEvent.click(saveButton);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    fireEvent.change(title, {
      target: { value: "Work typed during create" },
    });
    await act(async () => releaseCreate());
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      title: "",
      blocks: [
        expect.objectContaining({
          data: { content: { type: "doc", content: [] } },
        }),
      ],
    });
    expect(title).toBeInTheDocument();
    expect(title).toHaveValue("Work typed during create");

    const section = await screen.findByLabelText(/^Area/);
    fireEvent.change(section, { target: { value: "watch" } });
    expect(section).toBeInTheDocument();
    expect(section).toHaveValue("watch");
    fireEvent.change(section, { target: { value: "support" } });
    expect(section).toBeInTheDocument();
    expect(section).toHaveValue("support");
    fireEvent.click(saveButton);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0]).toMatchObject({
      id: "post-1",
      section: "support",
      status: "draft",
      title: "Work typed during create",
      unassignedDraft: true,
    });
    fireEvent.change(section, { target: { value: "watch" } });
    fireEvent.change(title, {
      target: { value: "Work typed during assignment" },
    });
    await act(async () => releaseAssignment());
    await waitFor(() => {
      expect(screen.getByTestId("record-section-display")).toHaveTextContent("Support");
    });
    expect(screen.queryByLabelText(/^Area/)).toBeNull();
    expect(title).toBeInTheDocument();
    expect(title).toHaveValue("Work typed during assignment");
  }, 10_000);

  it("still refuses an unsafe URL when incomplete fields are allowed", () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="sponsor"
        allowIncomplete
        canSave
        initial={{ href: "javascript:alert(1)" }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Website must use an absolute HTTP or HTTPS URL/)).toBeTruthy();
  });

  it("refuses a sponsor website without a scheme", () => {
    const onSave = vi.fn();
    render(<RecordForm kind="sponsor" allowIncomplete canSave
      initial={{ href: "www.acme.org" }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Website must use an absolute HTTP or HTTPS URL.")).toBeTruthy();
  });

  it("clears a field's error as soon as the editor fixes it", () => {
    render(<RecordForm kind="staff" onSave={() => {}} canSave />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Name is required.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Jo Ramirez" } });
    expect(screen.queryByText("Name is required.")).toBeNull();
    // The still-empty fields keep their markers.
    expect(screen.getByText("Role is required.")).toBeTruthy();
  });

  it("refuses an unsafe record url and identifies the field before saving", () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="sponsor"
        initial={{ name: "Acme Foundation", href: "javascript:alert(1)" }}
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    const website = screen.getByLabelText(/^Website/) as HTMLInputElement;
    expect(website.getAttribute("aria-invalid")).toBe("true");
    const errorId = `${website.id}-error`;
    expect(website.getAttribute("aria-describedby")?.split(" ")).toContain(errorId);
    expect(document.getElementById(errorId)).toHaveTextContent(
      "Website must use an absolute HTTP or HTTPS URL.",
    );

    fireEvent.change(website, { target: { value: "https://acme.org/" } });
    expect(screen.queryByText(/Website must use/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme Foundation", href: "https://acme.org/" }),
    );
  });

  it("refuses a save while a date and time is still half typed, and names that field", () => {
    // A browser reports a datetime-local value only once every segment is filled, so a year
    // being typed reaches the control as 0202 and converts to nothing. The record keeps its
    // old instant, and before #850 the save went through and said Saved while the editor was
    // looking at a different date.
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="event"
        initial={{
          title: "Newsroom open house",
          startsAt: "2026-08-01T21:00:00.000Z",
          description: filledBio,
        }}
        onSave={onSave}
        canSave
      />,
    );

    const starts = screen.getByLabelText(/^Starts/) as HTMLInputElement;
    fireEvent.change(starts, { target: { value: "0202-09-01T13:00" } });
    // The control keeps the half-typed text on purpose; the year is typed a digit at a time.
    expect(starts.value).toBe("0202-09-01T13:00");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Starts is not a complete date and time yet. Finish it or clear it before saving.",
      ),
    ).toBeTruthy();
    expect(starts.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(starts, { target: { value: "2029-09-01T13:00" } });
    expect(screen.queryByText(/not a complete date and time/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ startsAt: "2029-09-01T17:00:00.000Z" }),
    );
  });

  it("shows an unreadable stored end time and saves it cleared", () => {
    // The trap this closes: endsAt is optional, the control renders blank for a legacy bare
    // day, and the save was refused with no reachable way out. Clearing had to travel through
    // a change event the blank control could never fire (#850).
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="event"
        initial={{
          title: "Newsroom open house",
          startsAt: "2026-08-01T21:00:00.000Z",
          endsAt: "2026-08-01",
          description: filledBio,
        }}
        onSave={onSave}
        canSave
      />,
    );

    // Stated on open, before any save is attempted, with the stored text quoted.
    expect(
      screen.getByText(
        'Ends holds "2026-08-01", which is not a date and time this control can show. Clear it or set a new one.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Clear this value/ }));
    expect(screen.queryByText(/which is not a date and time/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ endsAt: "" }));
  });

  it("refuses an unsafe link inside existing record rich text", () => {
    const onSave = vi.fn();
    const body: RichTextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Read more",
              marks: [{ type: "link", attrs: { href: "//evil.example" } }],
            },
          ],
        },
      ],
    };
    render(
      <RecordForm
        kind="newsletter"
        initial={{ title: "Weekend brief", body }}
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    const editor = screen.getByRole("textbox", { name: "Description" });
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(editor.getAttribute("aria-describedby")!.split(" ").at(-1)!))
      .toHaveTextContent(
        "Description contains a link that must use http, https, mailto, tel, or a relative link.",
      );
  });

  it("saves the record once every required field is filled and confirms it", () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="staff"
        initial={{ name: "Jo Ramirez", role: "Reporter", bio: filledBio }}
        onSave={onSave}
        canSave
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Jo Ramirez", role: "Reporter", bio: filledBio }),
    );
    expect(screen.getByText("Saved.")).toBeTruthy();
  });

  it("preserves hidden model fields when saving an existing record", () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="staff"
        initial={{
          id: "staff-1",
          status: "published",
          name: "Jo Ramirez",
          role: "Reporter",
          bio: filledBio,
        }}
        onSave={onSave}
        canSave
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The id and status are not editor descriptors, so the form never shows them; the save
    // must still carry them, or an update would drop the record's identity and state.
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "staff-1", status: "published", name: "Jo Ramirez" }),
    );
  });

  it("renders grouped post metadata and saves nested search and social values", async () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          summary: "The reader-facing deck.",
          excerpt: "The fallback card description.",
          date: "2026-07-21",
          tags: ["community"],
          seo: { title: "Old search title", description: "Keep this description", noindex: false },
          social: { title: "Share this update", description: "Social summary", imageAssetId: "asset-1" },
        }}
        onSave={onSave}
        canSave
      />,
    );

    const writing = screen.getByRole("region", { name: "Main area" });
    const settings = screen.getByRole("region", { name: "Side panel" });
    for (const panel of ["Listing fallback", "Search"]) {
      fireEvent.click(screen.getByRole("button", { name: panel }));
    }
    const titlePanel = within(writing).getByRole("article", { name: "Post title" });
    const title = within(titlePanel).getByRole("textbox", { name: "Post title" });
    const summary = within(titlePanel).getByLabelText(/^Summary/);
    expect(
      title.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(settings).queryByLabelText(/^Summary/)).toBeNull();
    expect(within(settings).getAllByRole("textbox", { name: /Excerpt/ })).toHaveLength(1);
    expect(
      within(writing).getByText(
        "Optional text below the title. Also used in listings, search, and social sharing.",
      ),
    ).toBeVisible();
    expect(
      within(settings).getByRole("button", { name: "About Excerpt" }),
    ).toHaveAccessibleDescription(
      /^Optional fallback for listing cards and default Search and Social descriptions when summary is empty\. It does not appear beneath the post title\./,
    );
    expect(screen.queryByRole("group", { name: "Basics" })).toBeNull();
    for (const panel of [
      "Listing fallback",
      "Dates",
      "Metadata",
      "Hero image",
      "Search",
      "Social sharing",
    ]) {
      expect(within(settings).getByRole("article", { name: panel })).toBeTruthy();
    }
    expect(screen.queryByText("Edit the post title and summary.")).toBeNull();
    expect(
      screen.getByText("Set the byline, categories, and tags."),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "Categories" })).toBeTruthy();
    expect(
      screen.getByText(
        "Search results use the post title and summary, then Excerpt, by default.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Post body editing is coming next")).toBeNull();
    expect(screen.getByRole("button", { name: "Add content: position 1" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add content: position 1" }));
    const picker = screen.getByRole("dialog", { name: "Add content" });
    expect(within(picker).getByRole("button", { name: "Add row" })).toBeVisible();
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("This page is empty.")).toBeNull();

    fireEvent.change(screen.getByLabelText("Search title"), {
      target: { value: "New search title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        title: "A Garden State update",
        summary: "The reader-facing deck.",
        excerpt: "The fallback card description.",
        blocks: [],
        seo: {
          title: "New search title",
          description: "Keep this description",
          noindex: false,
        },
        social: {
          title: "Share this update",
          description: "Social summary",
          imageAssetId: "asset-1",
        },
      })),
    );
  });

  it("keeps Post Search and Social titles inherited until each is customized", async () => {
    const onSave = vi.fn();
    const first = render(
      <RecordForm
        kind="post"
        initial={{
          title: "Raw Header",
          seo: { description: "Keep the search description", noindex: false },
          social: { description: "Keep the social description", imageAssetId: "asset-1" },
        }}
        initialIsClean
        onSave={onSave}
        canSave
      />,
    );
    for (const panel of ["Search", "Social sharing"]) {
      fireEvent.click(screen.getByRole("button", { name: panel }));
    }

    const header = screen.getByRole("textbox", { name: "Post title" });
    const searchTitle = screen.getByLabelText("Search title");
    const socialTitle = screen.getByLabelText("Social title");
    const searchField = searchTitle.closest(".editor-field");
    const socialField = socialTitle.closest(".editor-field");
    if (!searchField || !socialField) throw new Error("Missing title override fields.");

    expect(searchTitle).toHaveValue("Raw Header");
    expect(socialTitle).toHaveValue("Raw Header");
    const searchSource = within(searchField as HTMLElement).getByText("Using post title");
    const socialSource = within(socialField as HTMLElement).getByText("Using post title");
    expect(searchTitle.getAttribute("aria-describedby")?.split(" ")).toContain(
      searchSource.id,
    );
    expect(socialTitle.getAttribute("aria-describedby")?.split(" ")).toContain(
      socialSource.id,
    );
    expect(
      within(searchField as HTMLElement).queryByRole("button", { name: /Use post title/ }),
    ).toBeNull();
    expect(
      within(socialField as HTMLElement).queryByRole("button", { name: /Use post title/ }),
    ).toBeNull();

    fireEvent.change(header, { target: { value: "Header after edit" } });
    expect(searchTitle).toHaveValue("Header after edit");
    expect(socialTitle).toHaveValue("Header after edit");

    fireEvent.change(socialTitle, { target: { value: "Custom social title" } });
    expect(searchTitle).toHaveValue("Header after edit");
    expect(socialTitle).toHaveValue("Custom social title");
    expect(within(searchField as HTMLElement).getByText("Using post title")).toBeVisible();
    expect(within(socialField as HTMLElement).getByText("Custom title")).toBeVisible();

    fireEvent.change(header, { target: { value: "Final raw Header" } });
    expect(searchTitle).toHaveValue("Final raw Header");
    expect(socialTitle).toHaveValue("Custom social title");

    fireEvent.change(searchTitle, { target: { value: "Custom search title" } });
    expect(searchTitle).toHaveValue("Custom search title");
    fireEvent.click(
      within(socialField as HTMLElement).getByRole("button", {
        name: "Use post title for Social title",
      }),
    );
    expect(socialTitle).toHaveValue("Final raw Header");
    expect(searchTitle).toHaveValue("Custom search title");
    expect(socialTitle).toHaveFocus();

    fireEvent.change(searchTitle, { target: { value: "" } });
    expect(searchTitle).toHaveValue("Final raw Header");
    expect(within(searchField as HTMLElement).getByText("Using post title")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(saved).toMatchObject({
      title: "Final raw Header",
      seo: { description: "Keep the search description", noindex: false },
      social: { description: "Keep the social description", imageAssetId: "asset-1" },
    });
    expect(saved).not.toHaveProperty("seo.title");
    expect(saved).not.toHaveProperty("social.title");

    first.unmount();
    render(
      <RecordForm
        kind="post"
        initial={saved}
        initialIsClean
        onSave={() => {}}
        canSave
      />,
    );
    expect(screen.getByLabelText("Search title")).toHaveValue("Final raw Header");
    expect(screen.getByLabelText("Social title")).toHaveValue("Final raw Header");
    expect(screen.getAllByText("Using post title")).toHaveLength(2);
  });

  it("normalizes a stored blank Post title on an unrelated save and preserves the other explicit title", async () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="post"
        initial={{
          id: "post-existing",
          title: "Current Header",
          seo: { title: "   ", description: "Search description" },
          social: { title: "Existing social title", description: "Social description" },
        }}
        initialIsClean
        onSave={onSave}
        canSave
      />,
    );
    for (const panel of ["Search", "Social sharing"]) {
      fireEvent.click(screen.getByRole("button", { name: panel }));
    }

    const searchTitle = screen.getByLabelText("Search title");
    const socialTitle = screen.getByLabelText("Social title");
    expect(searchTitle).toHaveValue("Current Header");
    expect(socialTitle).toHaveValue("Existing social title");
    expect(
      within(searchTitle.closest(".editor-field") as HTMLElement).getByText(
        "Using post title",
      ),
    ).toBeVisible();
    expect(
      within(socialTitle.closest(".editor-field") as HTMLElement).getByText(
        "Custom title",
      ),
    ).toBeVisible();

    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), {
      target: { value: "Current Header updated" },
    });
    expect(searchTitle).toHaveValue("Current Header updated");
    expect(socialTitle).toHaveValue("Existing social title");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const saved = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(saved).toHaveProperty("title", "Current Header updated");
    expect(saved).not.toHaveProperty("seo.title");
    expect(saved).toHaveProperty("seo.description", "Search description");
    expect(saved).toHaveProperty("social.title", "Existing social title");
  });

  it("keeps post body commands in the writing column instead of the document header", () => {
    const actionsTarget = document.createElement("div");
    document.body.append(actionsTarget);
    render(
      <WorkspaceActionsProvider target={actionsTarget}>
        <RecordForm
          kind="post"
          initial={{
            title: "A Garden State update",
            date: "2026-08-14",
            tags: [],
            blocks: [],
          }}
          onSave={() => {}}
          canSave
        />
      </WorkspaceActionsProvider>,
    );

    expect(
      within(actionsTarget).queryByRole("toolbar", {
        name: "Page editing commands",
      }),
    ).toBeNull();
    expect(
      within(actionsTarget).queryByRole("button", { name: "Undo" }),
    ).toBeNull();
    expect(
      within(screen.getByRole("article", { name: "Post body" })).getByRole(
        "toolbar",
        { name: "Post editing commands" },
      ),
    ).toBeVisible();

    actionsTarget.remove();
  });

  it("chooses a post lead image without exposing its raw id and offers the asset alt as a suggestion", async () => {
    const onSave = vi.fn();
    const loadMedia = vi.fn(async () => pickerResult);
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          date: "2026-08-13",
          tags: [],
        }}
        loadMedia={loadMedia}
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "image" } });
    const heroImage = screen.getByRole("group", { name: "Hero image" });
    expect(within(heroImage).queryByPlaceholderText("Asset id")).toBeNull();
    fireEvent.click(
      within(heroImage).getByRole("button", { name: "Choose lead image" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Garden State newsroom/ }),
    );

    expect(screen.getByText(/Suggestion: A reporter at the NJ PBS newsroom desk/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          leadMedia: { kind: "image", data: { assetId: "asset-garden", alt: "A reporter at the NJ PBS newsroom desk." } },
        }),
      ),
    );

    fireEvent.click(
      within(heroImage).getByRole("button", { name: "Remove lead image" }),
    );
    expect(screen.queryByLabelText("Lead image alt text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith(
        expect.objectContaining({
          leadMedia: null,
        }),
      ),
    );
  });

  it("edits and clears an optional lead image caption independently of alt text", async () => {
    const onSave = vi.fn();
    render(<RecordForm kind="post" initial={{ title: "Station update", date: "2026-08-13", tags: [],
      heroImage: "asset-garden", heroImageAlt: "The newsroom desk", heroImageCaption: "Photo: NJ PBS" }}
      onSave={onSave} canSave />);
    const caption = screen.getByRole("textbox", { name: "Lead image caption" });
    expect(caption).toHaveValue("Photo: NJ PBS");
    expect(caption).not.toBeRequired();
    fireEvent.change(caption, { target: { value: "Inside the newsroom.\nPhoto: NJ PBS" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      leadMedia: { kind: "image", data: { assetId: "asset-garden", caption: "Inside the newsroom.\nPhoto: NJ PBS", alt: "The newsroom desk" } },
    })));
    fireEvent.change(caption, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      leadMedia: { kind: "image", data: { assetId: "asset-garden", caption: "", alt: "The newsroom desk" } },
    })));
  });

  it.each(["asset-garden", "old-photo"])("keeps the caption only when reselecting the same lead image (%s)", async initialAsset => {
    const onSave = vi.fn();
    render(<RecordForm kind="post" initial={{ title: "Station update", date: "2026-08-13", tags: [],
      heroImage: initialAsset, heroImageAlt: "The newsroom desk", heroImageCaption: "Photo: NJ PBS" }}
      loadMedia={vi.fn(async () => pickerResult)} onSave={onSave} canSave allowIncomplete />);
    fireEvent.click(screen.getByRole("button", { name: "Change lead image" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Garden State newsroom/ }));
    const expected = initialAsset === "asset-garden" ? "Photo: NJ PBS" : "";
    expect(screen.getByRole("textbox", { name: "Lead image caption" })).toHaveValue(expected);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining(initialAsset === "asset-garden"
      ? { heroImage: "asset-garden", heroImageAlt: "The newsroom desk", heroImageCaption: expected }
      : { leadMedia: { kind: "image", data: { assetId: "asset-garden", alt: "" } } })));
    fireEvent.click(screen.getByRole("button", { name: "Remove lead image" }));
    expect(screen.queryByRole("textbox", { name: "Lead image caption" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ leadMedia: null })));
  });

  it("offers the existing upload flow in a Post metadata picker and reports its dirty state", async () => {
    const onMediaPickerDirtyChange = vi.fn();
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          date: "2026-08-13",
          tags: [],
        }}
        loadMedia={vi.fn(async () => pickerResult)}
        uploadMedia={vi.fn(async () => ({
          success: true as const,
          asset: pickerResult.records[0]!,
        }))}
        mediaCategories={pickerCategories}
        defaultUploadCategory="newsroom"
        canUploadCategory={(category) => category === "newsroom"}
        onMediaPickerDirtyChange={onMediaPickerDirtyChange}
        onSave={() => {}}
        canSave
      />,
    );

    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "image" } });
    const heroImage = screen.getByRole("group", { name: "Hero image" });
    fireEvent.click(
      within(heroImage).getByRole("button", { name: "Choose lead image" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload image" }),
    );
    fireEvent.change(screen.getByLabelText(/^File/), {
      target: {
        files: [
          new File(["image bytes"], "field-report.png", {
            type: "image/png",
          }),
        ],
      },
    });

    await waitFor(() =>
      expect(onMediaPickerDirtyChange).toHaveBeenLastCalledWith(true),
    );
  });

  it("uploads from the Post picker portal without making a Post save request", async () => {
    const onSave = vi.fn(async (record) => ({ ...record, version: 2 }));
    const uploadMedia = vi.fn(async () => ({ success: true as const, asset: pickerResult.records[0]! }));
    render(<RecordForm kind="post" initial={{ title: "A Garden State update", date: "2026-08-13", tags: [] }}
      loadMedia={async () => pickerResult} uploadMedia={uploadMedia} mediaCategories={pickerCategories}
      defaultUploadCategory="newsroom" canUploadCategory={category => category === "newsroom"}
      onSave={onSave} canSave allowIncomplete />);
    fireEvent.change(screen.getByLabelText("Lead media type"), { target: { value: "image" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Hero image" })).getByRole("button", { name: "Choose lead image" }));
    fireEvent.click(await screen.findByRole("button", { name: "Upload image" }));
    const picker = screen.getByRole("dialog", { name: "Choose an image" });
    fireEvent.change(within(picker).getByLabelText(/^Files/), {
      target: { files: [new File(["image bytes"], "field-report.png", { type: "image/png" })] },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose an image" })).toBeNull());
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      leadMedia: expect.objectContaining({ kind: "image", data: expect.objectContaining({ assetId: "asset-garden" }) }),
    }));
  });

  it("keeps a metadata picker choose-only when category permission denies upload", async () => {
    render(
      <RecordForm
        kind="page"
        initial={{ title: "About NJ PBS" }}
        loadMedia={vi.fn(async () => pickerResult)}
        uploadMedia={vi.fn(async () => ({
          success: true as const,
          asset: pickerResult.records[0]!,
        }))}
        mediaCategories={pickerCategories}
        defaultUploadCategory="newsroom"
        canUploadCategory={() => false}
        onSave={() => {}}
        canSave
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Choose social image" }),
    );
    await screen.findByRole("dialog", { name: "Choose an image" });

    expect(
      screen.queryByRole("button", { name: "Upload image" }),
    ).not.toBeInTheDocument();
  });

  it("hydrates a saved post lead image from its exact media record", async () => {
    const loadMedia = vi.fn(async () => pickerResult);
    const { container } = render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          date: "2026-08-13",
          tags: [],
          heroImage: "asset-garden",
          heroImageAlt: "A reporter at the NJ PBS newsroom desk.",
          heroImageDecorative: false,
        }}
        loadMedia={loadMedia}
        onSave={() => {}}
        canSave
      />,
    );

    expect(await screen.findByDisplayValue("Garden State newsroom")).toBeTruthy();
    expect(loadMedia).toHaveBeenCalledWith({
      q: "",
      assetIds: ["asset-garden"],
      categories: [],
      kinds: ["image"],
      sort: "updatedAt",
      direction: "desc",
      page: 1,
    }, { signal: expect.any(AbortSignal) });
    expect(
      container.querySelector(
        'img[src="https://media.njpbs.org/cms-media/newsroom/asset-garden/hash.jpg"]',
      ),
    ).toBeTruthy();
  });

  it("keeps record images read-only when the role cannot use the media library", () => {
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          date: "2026-08-13",
          tags: [],
          heroImage: "asset-garden",
          heroImageAlt: "A reporter at the NJ PBS newsroom desk.",
          heroImageDecorative: false,
        }}
        mediaPickerUnavailable
        onSave={() => {}}
        canSave
      />,
    );

    const heroImage = screen.getByRole("group", { name: "Hero image" });
    expect(within(heroImage).queryByPlaceholderText("Asset id")).toBeNull();
    expect(
      within(heroImage).queryByRole("button", {
        name: /^(?:Choose|Change|Remove) lead image$/,
      }),
    ).toBeNull();
    expect(within(heroImage).getByDisplayValue("Saved image selected")).toBeTruthy();
    expect(
      within(heroImage).getAllByText("Media access is required to change this image."),
    ).toHaveLength(2);
  });

  it("warns about empty lead-image alt text and still saves", async () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          date: "2026-08-13",
          tags: [],
          heroImage: "asset-garden",
          heroImageAlt: "",
          heroImageDecorative: false,
        }}
        onSave={onSave}
        canSave
      />,
    );

    const alt = screen.getByRole("textbox", { name: "Lead image alt text" });
    expect(alt.getAttribute("aria-required")).not.toBe("true");
    expect(
      document.getElementById(`${alt.id}-warning`),
    ).toHaveTextContent("Lead image alt text is empty.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          heroImage: "asset-garden",
          heroImageAlt: "",
          heroImageDecorative: false,
        }),
      ),
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mark lead image as decorative" }),
    );
    expect(document.getElementById(`${alt.id}-warning`)).toBeNull();
  });

  it("clears lead-image alt text when the editor marks the image decorative", async () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          date: "2026-08-13",
          tags: [],
          heroImage: "asset-garden",
          heroImageAlt: "A reporter at the NJ PBS newsroom desk.",
          heroImageDecorative: false,
        }}
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Mark lead image as decorative" }),
    );

    expect(screen.getByRole("textbox", { name: "Lead image alt text" })).toHaveValue("");
    expect(
      screen
        .getByRole("textbox", { name: "Lead image alt text" })
        .getAttribute("aria-required"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          leadMedia: { kind: "image", data: { assetId: "asset-garden", alt: "", altDecorative: true, caption: "" } },
        }),
      ),
    );
  });

  it("keeps untouched optional page overrides absent when saving another field", () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="page"
        initial={{ title: "About NJ PBS" }}
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.change(screen.getByLabelText("Page summary"), {
      target: { value: "Public media for New Jersey." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      title: "About NJ PBS",
      description: "Public media for New Jersey.",
    }));
    const saved = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(saved).not.toHaveProperty("seo");
    expect(saved).not.toHaveProperty("social");
  });

  it("returns a newly touched optional override to absence when it is cleared", () => {
    const onSave = vi.fn();
    const onDraftChange = vi.fn();
    render(
      <RecordForm
        kind="page"
        initial={{ title: "About NJ PBS" }}
        initialIsClean
        onSave={onSave}
        onDraftChange={onDraftChange}
        canSave
      />,
    );

    fireEvent.change(screen.getByLabelText("Search title"), {
      target: { value: "Temporary search title" },
    });
    expect(onDraftChange.mock.lastCall?.[0]).toMatchObject({
      seo: { title: "Temporary search title" },
    });
    fireEvent.change(screen.getByLabelText("Search title"), { target: { value: "" } });
    expect(onDraftChange.mock.lastCall?.[0]).toBeNull();

    fireEvent.click(screen.getByLabelText("Hide from search engines"));
    fireEvent.click(screen.getByLabelText("Hide from search engines"));
    expect(onDraftChange.mock.lastCall?.[0]).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const saved = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(saved).not.toHaveProperty("seo");
  });

  it("sends the metadata group without a cleared stored override", () => {
    const onSave = vi.fn();
    render(
      <RecordForm
        kind="page"
        initial={{ title: "About NJ PBS", seo: { title: "Old search title" } }}
        initialIsClean
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.change(screen.getByLabelText("Search title"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ seo: {} }));
  });

  it("disables the save and explains why when the role cannot save", () => {
    render(<RecordForm kind="staff" onSave={() => {}} canSave={false} />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Your role cannot save this record.")).toBeTruthy();
  });

  it("does not save through a form submit event when the role cannot save", () => {
    const onSave = vi.fn();
    const { container } = render(
      <RecordForm
        kind="staff"
        initial={{ name: "Jo Ramirez", role: "Reporter", bio: filledBio }}
        onSave={onSave}
        canSave={false}
      />,
    );
    // The submit button is disabled, but the submit handler must also refuse: a stray
    // submit (Enter-key implicit submission, form.requestSubmit, a future second submit
    // button) must not slip a save past the read-only gate.
    const form = container.querySelector("form.record-form") as HTMLFormElement;
    fireEvent.submit(form);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("freezes every field while an external revision restore is in flight", () => {
    const onDraftChange = vi.fn();
    render(
      <RecordForm
        kind="sponsor"
        initial={{ name: "Acme Foundation", href: "https://acme.example" }}
        initialIsClean
        onDraftChange={onDraftChange}
        canSave
        readOnly
      />,
    );

    expect(screen.getByLabelText(/^Name/)).toBeDisabled();
    expect(screen.getByLabelText(/^Website/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/restoring this version/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Discarded edit" } });
    expect(onDraftChange).not.toHaveBeenCalled();
  });
});

// A record persists through cmsSaveContent (an async onSave). Sponsor is the one kind with no
// rich-text field, so these fill through plain inputs. seedRecord gives a sponsor no id, so the
// first save is a create.
describe("RecordForm async persist", () => {
  function fillSponsor() {
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Acme Foundation" } });
    fireEvent.change(screen.getByLabelText(/^Website/), { target: { value: "https://acme.org" } });
  }

  it("adopts a server-minted Post route before the next save", async () => {
    const onDraftChange = vi.fn();
    const onSave = vi.fn(async (record: Record<string, unknown>) => ({
      kind: "record-save-receipt" as const,
      document: {
        ...record,
        id: "post-1",
        version: onSave.mock.calls.length,
        slug: "a-garden-state-update",
        previousSlugs: [],
      },
      mintedIds: {},
    }));
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          slug: "",
          tags: [],
          blocks: [],
        }}
        onSave={onSave}
        onDraftChange={onDraftChange}
        canSave
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].slug).toBe("");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "URL slug" })).toHaveValue(
        "a-garden-state-update",
      ),
    );
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(null));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0]).toMatchObject({
      id: "post-1",
      version: 1,
      slug: "a-garden-state-update",
      previousSlugs: [],
    });
  });

  it("keeps a newer Post slug dirty when an earlier save settles", async () => {
    const onDraftChange = vi.fn();
    let release!: (receipt: RecordSaveReceipt) => void;
    const onSave = vi.fn(
      (record: Record<string, unknown>) =>
        new Promise<RecordSaveReceipt>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <RecordForm
        kind="post"
        initial={{
          id: "post-1",
          version: 3,
          title: "A Garden State update",
          slug: "a-garden-state-update",
          previousSlugs: [],
          tags: [],
          blocks: [],
        }}
        initialIsClean
        onSave={onSave}
        onDraftChange={onDraftChange}
        canSave
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "URL slug" }), {
      target: { value: "a-garden-state-update-latest" },
    });
    await act(async () => {
      release({
        kind: "record-save-receipt",
        document: {
          ...onSave.mock.calls[0]![0],
          version: 4,
          slug: "a-garden-state-update",
          previousSlugs: ["garden-state-update"],
        },
        mintedIds: {},
      });
    });

    expect(screen.getByRole("textbox", { name: "URL slug" })).toHaveValue(
      "a-garden-state-update-latest",
    );
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: "post-1",
          version: 4,
          slug: "a-garden-state-update-latest",
          previousSlugs: ["garden-state-update"],
        }),
      ),
    );
    expect(onDraftChange.mock.lastCall?.[0]).not.toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "URL slug" }), {
      target: { value: "a-garden-state-update" },
    });
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(null));
  });

  it("adopts the server-minted id so the next save updates rather than creates", async () => {
    // The record analogue of the page id adoption (#515): a record has no id on create, so the
    // server mints one and the form adopts it, making the next save an update of the same record
    // instead of a duplicate create.
    const onSave = vi.fn(async (record: Record<string, unknown>) => ({ ...record, id: "spo-1" }));
    render(<RecordForm kind="sponsor" onSave={onSave} canSave />);
    fillSponsor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The create carries no id.
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].id).toBeUndefined();
    expect(await screen.findByText("Saved.")).toBeTruthy();

    // The second save reuses the adopted id.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0].id).toBe("spo-1");
  });

  it("adopts canonical post block ids before the next record save", async () => {
    const onSave = vi.fn(async (record: Record<string, unknown>) => {
      const blocks = record.blocks as Array<Record<string, unknown>>;
      return {
        kind: "record-save-receipt" as const,
        document: {
          ...record,
          id: "post-1",
          version: 1,
          blocks: blocks.map((block) =>
            block.id === "tmp-post-block"
              ? { ...block, id: "srv-post-block" }
              : block,
          ),
        },
        mintedIds:
          onSave.mock.calls.length === 1
            ? { "tmp-post-block": "srv-post-block" }
            : {},
      };
    });
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          date: "2026-08-14",
          tags: [],
          blocks: [
            {
              id: "tmp-post-block",
              type: "prose",
              order: 0,
              visible: true,
              data: { content: filledBio },
            },
          ],
        }}
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit text 1" }));
    const body = screen.getByRole("textbox", { name: "Body" });
    await act(async () => {
      body.innerHTML = "<p>Reporter and producer, updated.</p>";
      fireEvent.input(body);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    expect(onSave.mock.calls[1]![0]).toMatchObject({
      id: "post-1",
      blocks: [expect.objectContaining({ id: "srv-post-block" })],
    });
  });

  // The meaningful-update request is one-shot: the server consumes it and stores it
  // back false (#1041). If the form keeps its own copy on, the next typo fix re-stamps
  // the story as updated today, which is the behaviour the contract exists to prevent.
  it("adopts the consumed meaningful-update request from the save response", async () => {
    const onSave = vi.fn(async (record: Record<string, unknown>) => ({
      kind: "record-save-receipt" as const,
      document: { ...record, id: "post-1", version: 1, recordMeaningfulUpdate: false },
      mintedIds: {},
    }));
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "A Garden State update",
          tags: [],
          blocks: [],
        }}
        onSave={onSave}
        canSave
      />,
    );

    fireEvent.click(screen.getByLabelText(/^Record a meaningful update/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].recordMeaningfulUpdate).toBe(true);
    expect(await screen.findByText("Saved.")).toBeTruthy();

    // The live control is back off, and the ordinary save that follows asks for nothing.
    expect(screen.getByLabelText(/^Record a meaningful update/)).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0].recordMeaningfulUpdate).toBe(false);
  });

  it("shows Saving… while the save is in flight and confirms when it resolves", async () => {
    let resolveSave: (record: Record<string, unknown>) => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<RecordForm kind="sponsor" onSave={onSave} canSave />);
    fillSponsor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The button relabels and blocks a second click without moving keyboard focus.
    const savingButton = (await screen.findByRole("button", {
      name: /^.+: Saving…$/,
    })) as HTMLButtonElement;
    expect(savingButton.disabled).toBe(false);
    expect(savingButton).toHaveAttribute("aria-disabled", "true");
    expect(savingButton).toHaveAttribute("aria-busy", "true");
    expect(savingButton.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Saving record.");
    fireEvent.click(savingButton);
    expect(onSave).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave({ id: "spo-1" });
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("surfaces a rejected save and does not confirm it", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("Unknown record id (omit id to create).");
    });
    render(<RecordForm kind="sponsor" onSave={onSave} canSave />);
    fillSponsor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Unknown record id (omit id to create).")).toBeTruthy();
    expect(screen.queryByText("Saved.")).toBeNull();
    // The record is untouched, so the editor can retry from the same content.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("raises onSavingChange true while saving and false when it settles", async () => {
    let resolveSave: (record: Record<string, unknown>) => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onSavingChange = vi.fn();
    render(
      <RecordForm kind="sponsor" onSave={onSave} canSave onSavingChange={onSavingChange} />,
    );
    fillSponsor();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSavingChange).toHaveBeenCalledWith(true));
    await act(async () => {
      resolveSave({ id: "spo-1" });
    });
    await waitFor(() => expect(onSavingChange).toHaveBeenLastCalledWith(false));
  });
});

describe("RecordForm draft reporting (#579)", () => {
  it("treats an explicitly stored initial record as a clean point", () => {
    const onDraftChange = vi.fn();
    render(
      <RecordForm
        kind="staff"
        initial={{ id: "staff-1", version: 3, name: "Jo Ramirez", role: "Reporter", bio: filledBio }}
        initialIsClean
        canSave
        onDraftChange={onDraftChange}
      />,
    );

    expect(onDraftChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Jo R." } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Jo Ramirez" } });
    expect(onDraftChange.mock.lastCall?.[0]).toBeNull();
  });

  it("reports the live record once a field changes", () => {
    const onDraftChange = vi.fn();
    render(<RecordForm kind="staff" canSave onDraftChange={(record) => onDraftChange(record)} />);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana Vannozzi" } });
    expect(onDraftChange.mock.lastCall?.[0]).toMatchObject({ name: "Briana Vannozzi" });
  });

  it("does not report a draft for a form nobody typed in", () => {
    const onDraftChange = vi.fn();
    render(<RecordForm kind="staff" canSave onDraftChange={(record) => onDraftChange(record)} />);
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  // The host passes an inline arrow, so the callback's identity changes on every parent render --
  // a save toggling `saving` is enough to cause one. Depending on it would re-fire the report and
  // stash a draft for an untouched form, and the host reads a stashed draft as "there is unsaved
  // work here, restore it instead of re-reading." The dirty signal must mean a real edit, nothing
  // else, so a re-render alone must stay silent.
  // `main.tsx` mounts the admin inside StrictMode, which replays mount effects without resetting
  // refs. A has-run guard is consumed by the first pass, so the replay would report an untouched
  // form as unsaved work. Every other test here mounts bare and cannot see that.
  it("stays silent under the production StrictMode root", () => {
    const onDraftChange = vi.fn();
    render(
      <StrictMode>
        <RecordForm kind="staff" canSave onDraftChange={(record) => onDraftChange(record)} />
      </StrictMode>,
    );
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("still reports a real edit under StrictMode", () => {
    const onDraftChange = vi.fn();
    render(
      <StrictMode>
        <RecordForm kind="staff" canSave onDraftChange={(record) => onDraftChange(record)} />
      </StrictMode>,
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana Vannozzi" } });
    expect(onDraftChange.mock.lastCall?.[0]).toMatchObject({ name: "Briana Vannozzi" });
  });

  it("stays silent when the host re-renders with a new callback identity", () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(
      <RecordForm kind="staff" canSave onDraftChange={(record) => onDraftChange(record)} />,
    );
    rerender(<RecordForm kind="staff" canSave onDraftChange={(record) => onDraftChange(record)} />);
    rerender(<RecordForm kind="staff" canSave onDraftChange={(record) => onDraftChange(record)} />);
    expect(onDraftChange).not.toHaveBeenCalled();
  });
});

describe("RecordForm version and conflict handling (#566)", () => {
  const storedSponsor = {
    id: "spo-1",
    version: 3,
    name: "Acme Foundation",
    href: "https://acme.org",
  };

  it("adopts the returned version for the next save", async () => {
    const onSave = vi.fn(async (record: Record<string, unknown>) => ({
      ...record,
      id: "spo-1",
      version: 4,
    }));
    render(
      <RecordForm kind="sponsor" initial={storedSponsor} initialIsClean onSave={onSave} canSave />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    expect(onSave.mock.calls[0]![0].version).toBe(3);
    expect(onSave.mock.calls[1]![0].version).toBe(4);
  });

  it("turns a 409 into an explicit reload-or-overwrite choice", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(409, "This record changed since you opened it."))
      .mockResolvedValueOnce({ ...storedSponsor, version: 5 });
    const onReload = vi.fn();
    render(
      <RecordForm
        kind="sponsor"
        initial={storedSponsor}
        initialIsClean
        onSave={onSave}
        onReload={onReload}
        canSave
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(/Someone else saved this record while you were editing it/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Save anyway, overwriting their changes" }),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![1]).toEqual({ force: true });
    expect(screen.queryByText(/Someone else saved this record/)).toBeNull();
  });

  it("reloads the stored record only when the person chooses to discard local work", async () => {
    const onSave = vi.fn(async () => {
      throw new HttpError(409, "This record changed since you opened it.");
    });
    const onReload = vi.fn();
    render(
      <RecordForm
        kind="sponsor"
        initial={storedSponsor}
        initialIsClean
        onSave={onSave}
        onReload={onReload}
        canSave
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Reload record, discarding your changes" }),
    );
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

// The record side of the same contract the page editor settles (#579). A saved record is a
// clean point, so its draft must clear -- otherwise the host restores the saved record, id and
// all, and the next save updates that document instead of creating a new one.
describe("RecordForm draft settling across save shapes (#579)", () => {
  it("settles the draft when a save adopts a server id", async () => {
    const onDraftChange = vi.fn();
    render(
      <RecordForm
        kind="staff"
        canSave
        initial={{ role: "Reporter", bio: filledBio }}
        onSave={async () => ({ id: "staff-minted" })}
        onDraftChange={(record) => onDraftChange(record)}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana Vannozzi" } });
    expect(onDraftChange.mock.lastCall?.[0]).toMatchObject({ name: "Briana Vannozzi" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0]).toBeNull());
  });

  it("settles the draft when the host's save returns void", async () => {
    const onDraftChange = vi.fn();
    render(
      <RecordForm
        kind="staff"
        canSave
        initial={{ role: "Reporter", bio: filledBio }}
        onSave={() => {}}
        onDraftChange={(record) => onDraftChange(record)}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana Vannozzi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0]).toBeNull());
  });

  it("settles the draft when the host's save resolves to nothing", async () => {
    const onDraftChange = vi.fn();
    render(
      <RecordForm
        kind="staff"
        canSave
        initial={{ role: "Reporter", bio: filledBio }}
        onSave={async () => {}}
        onDraftChange={(record) => onDraftChange(record)}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana Vannozzi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDraftChange.mock.lastCall?.[0]).toBeNull());
  });

  it("keeps the draft when the record is edited while a save is in flight", async () => {
    const onDraftChange = vi.fn();
    let release!: (value: { id: string }) => void;
    render(
      <RecordForm
        kind="staff"
        canSave
        initial={{ role: "Reporter", bio: filledBio }}
        onSave={() => new Promise<{ id: string }>((resolve) => (release = resolve))}
        onDraftChange={(record) => onDraftChange(record)}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana Vannozzi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The edit lands after the save was sent, so it is still unsaved when the save returns.
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana V." } });
    await act(async () => {
      release({ id: "staff-minted" });
    });
    expect(onDraftChange.mock.lastCall?.[0]).toMatchObject({ name: "Briana V." });
    expect(onDraftChange.mock.lastCall?.[0]).not.toBeNull();
  });

  it("does not confirm a save that the editor typed over", async () => {
    let release!: (value: { id: string }) => void;
    render(
      <RecordForm
        kind="staff"
        canSave
        initial={{ role: "Reporter", bio: filledBio }}
        onSave={() => new Promise<{ id: string }>((resolve) => (release = resolve))}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana Vannozzi" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Briana V." } });
    await act(async () => {
      release({ id: "staff-minted" });
    });
    expect(screen.queryByText("Saved.")).toBeNull();
  });
});

describe("RecordForm byline reconciliation (#1040)", () => {
  // What the server does on the first save of a pre-#1040 post: it converts the
  // free-text `author` into one custom credit and deletes the old field, then
  // returns the document it actually stored.
  function convertedByServer(sent: Record<string, unknown>, version: number) {
    const stored: Record<string, unknown> = { ...sent, id: "post-1", version };
    delete stored.author;
    stored.credits = [{ kind: "custom", name: String(sent.author ?? "").trim() }];
    return stored;
  }

  const legacyPost = {
    id: "post-1",
    title: "A Garden State update",
    date: "2026-08-13",
    tags: [],
    version: 4,
    author: "Dana Freelancer",
  };

  it("adopts the server's deletion of a legacy author so a second save is accepted", async () => {
    let version = 4;
    const onSave = vi.fn(async (sent: Record<string, unknown>) => {
      // The real save boundary refuses any field the post contract does not have,
      // and after the conversion `author` is no longer one of them.
      if (version > 4 && Object.prototype.hasOwnProperty.call(sent, "author")) {
        throw new HttpError(400, "Unknown content field author");
      }
      version += 1;
      return convertedByServer(sent, version);
    });

    render(<RecordForm kind="post" canSave initial={legacyPost} onSave={onSave} />);

    // The conversion save. The legacy field is still on the record here, exactly
    // as it was loaded, and the server is the one that drops it.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toHaveProperty("author", "Dana Freelancer");

    // A second ordinary save in the same session, with no reload in between.
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), {
      target: { value: "A Garden State update, corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    expect(onSave.mock.calls[1][0]).not.toHaveProperty("author");
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(screen.queryByText(/Unknown content field author/)).toBeNull();
  });

  it("leaves the record alone when the server drops nothing", async () => {
    const onSave = vi.fn(async (sent: Record<string, unknown>) => ({
      ...sent,
      id: "post-1",
      version: 5,
    }));

    render(<RecordForm kind="post" canSave initial={legacyPost} onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), {
      target: { value: "Second pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    // A server that kept the field is not making a statement about removing it.
    expect(onSave.mock.calls[1][0]).toHaveProperty("author", "Dana Freelancer");
  });
});

describe("RecordForm self byline default (#1040)", () => {
  const AUTHOR_ID = `au_${"b".repeat(32)}`;
  const authors = [
    { authorId: AUTHOR_ID, displayName: "Briana Vannozzi", jobTitle: "Anchor" },
  ];

  function newPost(selfAuthorId: string | null) {
    return (
      <RecordForm
        kind="post"
        canSave
        onSave={() => {}}
        bylineAuthors={authors}
        selfAuthorId={selfAuthorId}
      />
    );
  }

  it("credits the signed-in author when the feed is already loaded", () => {
    render(newPost(AUTHOR_ID));
    expect(screen.getByText("Briana Vannozzi")).toBeTruthy();
  });

  it("credits the signed-in author when the feed lands after the form opens", () => {
    // The real order: the form seeds before the network answers, so the seed sees
    // a null selfAuthorId and the default has to arrive with the feed.
    const view = render(newPost(null));
    expect(screen.getByText("No byline yet.")).toBeTruthy();

    view.rerender(newPost(AUTHOR_ID));
    expect(screen.getByText("Briana Vannozzi")).toBeTruthy();
  });

  it("does not overwrite a byline the editor already worked on", () => {
    const view = render(newPost(null));
    fireEvent.change(screen.getByLabelText("Add a custom credit"), {
      target: { value: "NJ PBS staff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add custom credit" }));
    // And then taken back out again: an empty byline the editor chose is still a
    // choice, and the late default must not undo it.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove NJ PBS staff from the byline" }),
    );
    expect(screen.getByText("No byline yet.")).toBeTruthy();

    view.rerender(newPost(AUTHOR_ID));
    expect(screen.getByText("No byline yet.")).toBeTruthy();
  });

  it("does not add a self credit to a stored post that has no byline", () => {
    const stored = {
      id: "post-1",
      title: "A Garden State update",
      date: "2026-08-13",
      tags: [],
      credits: [],
      version: 3,
    };
    const openStored = (selfAuthorId: string | null) => (
      <RecordForm
        kind="post"
        canSave
        initial={stored}
        onSave={() => {}}
        bylineAuthors={authors}
        selfAuthorId={selfAuthorId}
      />
    );
    const view = render(openStored(null));
    view.rerender(openStored(AUTHOR_ID));
    // Opening someone else's story must not quietly put this editor's name on it.
    expect(screen.getByText("No byline yet.")).toBeTruthy();
  });
});

describe("RecordForm create-time section picker (#845)", () => {
  // A record's area is fixed by the write that creates it, so the create form asks
  // for it once and a stored record only reads it back. The host supplies the desks from the live registry; a form with no
  // registry wired shows no control at all rather than inventing choices.
  const sections = [
    { id: "watch", label: "Watch" },
    { id: "support", label: "Support" },
    { id: "station", label: "Station" },
    { id: "compliance", label: "Compliance" },
  ];

  function fillSponsor() {
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "WNET" } });
    fireEvent.change(screen.getByLabelText(/^Website/), {
      target: { value: "https://www.wnet.org" },
    });
  }

  it("offers exactly the registered desks on a create", () => {
    render(<RecordForm kind="sponsor" onSave={() => {}} canSave sections={sections} />);
    const select = screen.getByLabelText(/^Area/) as HTMLSelectElement;
    const values = Array.from(select.options)
      .map((option) => option.value)
      .filter((value) => value !== "");
    expect(values).toEqual(["watch", "support", "station", "compliance"]);
  });

  it("starts unchosen, so the first real option is never submitted by accident", () => {
    render(<RecordForm kind="sponsor" onSave={() => {}} canSave sections={sections} />);
    const select = screen.getByLabelText(/^Area/) as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("refuses a create that names no desk and says so inline", async () => {
    const onSave = vi.fn();
    render(<RecordForm kind="sponsor" onSave={onSave} canSave sections={sections} />);
    fillSponsor();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Area is required/i)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("sends the chosen desk with the created record", async () => {
    const onSave = vi.fn();
    render(<RecordForm kind="sponsor" onSave={onSave} canSave sections={sections} />);
    fillSponsor();
    fireEvent.change(screen.getByLabelText(/^Area/), { target: { value: "support" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      name: "WNET",
      section: "support",
    });
  });

  it("pins a stored record's desk to a plain reading, with no control to change it", () => {
    // The save boundary refuses a section that disagrees with the stored one, so an
    // editable control here would only offer an argument the server always wins.
    render(
      <RecordForm
        kind="sponsor"
        canSave
        onSave={() => {}}
        sections={sections}
        initial={{ id: "spo-1", name: "WNET", href: "https://www.wnet.org", section: "watch" }}
      />,
    );
    expect(screen.queryByLabelText(/^Area/)).toBeNull();
    expect(screen.getByTestId("record-section-display").textContent).toBe("Watch");
  });

  it("says so plainly when a stored record carries no desk", () => {
    // A record written before the registry existed. Demanding a desk here would block
    // every edit to it behind a field the save cannot accept anyway.
    render(
      <RecordForm
        kind="sponsor"
        canSave
        onSave={() => {}}
        sections={sections}
        initial={{ id: "spo-2", name: "WNET", href: "https://www.wnet.org" }}
      />,
    );
    expect(screen.getByTestId("record-section-display").textContent).toBe("No area");
  });

  it("shows no section control when the host wired no registry", () => {
    render(<RecordForm kind="sponsor" onSave={() => {}} canSave />);
    expect(screen.queryByLabelText(/^Area/)).toBeNull();
    expect(screen.queryByTestId("record-section-display")).toBeNull();
  });

  it("never offers a desk choice on page metadata, whose desk is its public area", () => {
    render(<RecordForm kind="page" onSave={() => {}} canSave sections={sections} />);
    expect(screen.queryByLabelText(/^Area/)).toBeNull();
    expect(screen.queryByTestId("record-section-display")).toBeNull();
  });
});

describe("RecordForm byline reconciliation (#1040)", () => {
  // What the server does on the first save of a pre-#1040 post: it converts the
  // free-text `author` into one custom credit and deletes the old field, then
  // returns the document it actually stored.
  function convertedByServer(sent: Record<string, unknown>, version: number) {
    const stored: Record<string, unknown> = { ...sent, id: "post-1", version };
    delete stored.author;
    stored.credits = [{ kind: "custom", name: String(sent.author ?? "").trim() }];
    return stored;
  }

  const legacyPost = {
    id: "post-1",
    title: "A Garden State update",
    date: "2026-08-13",
    tags: [],
    version: 4,
    author: "Dana Freelancer",
  };

  it("adopts the server's deletion of a legacy author so a second save is accepted", async () => {
    let version = 4;
    const onSave = vi.fn(async (sent: Record<string, unknown>) => {
      // The real save boundary refuses any field the post contract does not have,
      // and after the conversion `author` is no longer one of them.
      if (version > 4 && Object.prototype.hasOwnProperty.call(sent, "author")) {
        throw new HttpError(400, "Unknown content field author");
      }
      version += 1;
      return convertedByServer(sent, version);
    });

    render(<RecordForm kind="post" canSave initial={legacyPost} onSave={onSave} />);

    // The conversion save. The legacy field is still on the record here, exactly
    // as it was loaded, and the server is the one that drops it.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toHaveProperty("author", "Dana Freelancer");

    // A second ordinary save in the same session, with no reload in between.
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), {
      target: { value: "A Garden State update, corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    expect(onSave.mock.calls[1][0]).not.toHaveProperty("author");
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(screen.queryByText(/Unknown content field author/)).toBeNull();
  });

  it("leaves the record alone when the server drops nothing", async () => {
    const onSave = vi.fn(async (sent: Record<string, unknown>) => ({
      ...sent,
      id: "post-1",
      version: 5,
    }));

    render(<RecordForm kind="post" canSave initial={legacyPost} onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Post title" }), {
      target: { value: "Second pass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    // A server that kept the field is not making a statement about removing it.
    expect(onSave.mock.calls[1][0]).toHaveProperty("author", "Dana Freelancer");
  });
});

describe("RecordForm self byline default (#1040)", () => {
  const AUTHOR_ID = `au_${"b".repeat(32)}`;
  const authors = [
    { authorId: AUTHOR_ID, displayName: "Briana Vannozzi", jobTitle: "Anchor" },
  ];

  function newPost(selfAuthorId: string | null) {
    return (
      <RecordForm
        kind="post"
        canSave
        onSave={() => {}}
        bylineAuthors={authors}
        selfAuthorId={selfAuthorId}
      />
    );
  }

  it("credits the signed-in author when the feed is already loaded", () => {
    render(newPost(AUTHOR_ID));
    expect(screen.getByText("Briana Vannozzi")).toBeTruthy();
  });

  it("credits the signed-in author when the feed lands after the form opens", () => {
    // The real order: the form seeds before the network answers, so the seed sees
    // a null selfAuthorId and the default has to arrive with the feed.
    const view = render(newPost(null));
    expect(screen.getByText("No byline yet.")).toBeTruthy();

    view.rerender(newPost(AUTHOR_ID));
    expect(screen.getByText("Briana Vannozzi")).toBeTruthy();
  });

  it("does not overwrite a byline the editor already worked on", () => {
    const view = render(newPost(null));
    fireEvent.change(screen.getByLabelText("Add a custom credit"), {
      target: { value: "NJ PBS staff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add custom credit" }));
    // And then taken back out again: an empty byline the editor chose is still a
    // choice, and the late default must not undo it.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove NJ PBS staff from the byline" }),
    );
    expect(screen.getByText("No byline yet.")).toBeTruthy();

    view.rerender(newPost(AUTHOR_ID));
    expect(screen.getByText("No byline yet.")).toBeTruthy();
  });

  it("does not add a self credit to a stored post that has no byline", () => {
    const stored = {
      id: "post-1",
      title: "A Garden State update",
      date: "2026-08-13",
      tags: [],
      credits: [],
      version: 3,
    };
    const openStored = (selfAuthorId: string | null) => (
      <RecordForm
        kind="post"
        canSave
        initial={stored}
        onSave={() => {}}
        bylineAuthors={authors}
        selfAuthorId={selfAuthorId}
      />
    );
    const view = render(openStored(null));
    view.rerender(openStored(AUTHOR_ID));
    // Opening someone else's story must not quietly put this editor's name on it.
    expect(screen.getByText("No byline yet.")).toBeTruthy();
  });
});

describe("RecordForm error recovery", () => {
  it("keeps conflict feedback visible outside the Post bento panels", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(409, "This record changed since you opened it."));
    render(
      <RecordForm
        kind="post"
        initial={{ id: "post-1", version: 2, title: "Station update", blocks: [] }}
        initialIsClean
        onSave={onSave}
        onReload={() => {}}
        canSave
      />,
    );
    const bento = screen.getByRole("group", { name: "Post editor sections" });
    fireEvent.click(screen.getByRole("button", { name: "Metadata" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const feedback = await screen.findByText(/Someone else saved this record/);
    expect(feedback).toBeVisible();
    expect(bento).not.toContainElement(feedback);
  });

  it("keeps save failure feedback visible outside the Post bento panels", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("The network dropped."));
    render(
      <RecordForm
        kind="post"
        initial={{ id: "post-1", version: 2, title: "Station update", blocks: [] }}
        initialIsClean
        onSave={onSave}
        canSave
      />,
    );
    const bento = screen.getByRole("group", { name: "Post editor sections" });
    fireEvent.click(screen.getByRole("button", { name: "Metadata" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const feedback = await screen.findByText("The network dropped.");
    expect(feedback).toBeVisible();
    expect(bento).not.toContainElement(feedback);
  });

  it("names each invalid field in the summary and jumps to it", async () => {
    render(<RecordForm kind="sponsor" onSave={() => {}} canSave />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(/Fix the highlighted fields before saving/);
    const jump = screen.getByRole("button", { name: "Name" });
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    expect(jump).toHaveAttribute("aria-controls", name.id);
    expect(jump).toHaveAccessibleDescription("Name is required.");

    screen.getByRole("button", { name: "Save" }).focus();
    fireEvent.click(jump);
    expect(name).toHaveFocus();
  });

  it("shows an Event URL and keeps View live on its published slug while editing", () => {
    render(<RecordForm kind="event" initial={{
      id: "event-1", title: "Open house", slug: "open-house", status: "published",
      startsAt: "2026-10-01T18:00:00.000Z", description: filledBio,
      published: { metadata: { slug: "open-house" } },
    }} onSave={() => {}} canSave />);
    expect(screen.getByText("https://njpbs.org/events/open-house/")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "URL slug" }), { target: { value: "open-house-nj" } });
    expect(screen.getByText("https://njpbs.org/events/open-house-nj/")).toBeVisible();
    expect(screen.getByRole("link", { name: "View live" })).toHaveAttribute("href", "https://njpbs.org/events/open-house/");
  });

  it("shows the old Program art notice and keeps the published URL live while editing the slug", () => {
    render(<RecordForm kind="program" initial={{
      id: "program-1", title: "State of the Arts", slug: "state-of-the-arts",
      status: "published", keyArt: "legacy-media-manager-id",
      published: { metadata: { slug: "state-of-the-arts" } },
    }} onSave={() => {}} canSave />);
    expect(screen.getByText(/old Media Manager ID is no longer used/)).toBeVisible();
    expect(screen.getByText(/Public URL: https:\/\/njpbs.org\/programs\/state-of-the-arts\//)).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "URL slug" }), { target: { value: "state-of-the-arts-nj" } });
    expect(screen.getByText(/Public URL: https:\/\/njpbs.org\/programs\/state-of-the-arts-nj\//)).toBeVisible();
    expect(screen.getByRole("link", { name: "View live" })).toHaveAttribute("href", "https://njpbs.org/programs/state-of-the-arts/");
  });

  it("lands a summary link on a rich-text field", async () => {
    render(<RecordForm kind="program" onSave={() => {}} canSave />);
    fireEvent.change(screen.getByLabelText(/^Title/), { target: { value: "Garden State Stories" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const jump = await screen.findByRole("button", { name: "Synopsis" });
    const synopsis = screen.getByRole("textbox", { name: "Synopsis" });
    expect(jump).toHaveAttribute("aria-controls", synopsis.id);

    screen.getByRole("button", { name: "Save" }).focus();
    fireEvent.click(jump);
    expect(synopsis).toHaveFocus();
  });

  it("opens the bento panel that holds the field a summary link points at", async () => {
    render(
      <RecordForm
        kind="post"
        initial={{
          title: "Station update",
          heroImage: "asset-garden",
          heroImageAlt: "A reporter at a desk",
          heroImageDecorative: true,
          blocks: [],
        }}
        onSave={() => {}}
        canSave
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const jump = await screen.findByRole("button", { name: "Lead image" });
    expect(jump).toHaveAccessibleDescription(
      "Lead image alt text must be empty while Mark lead image as decorative is on.",
    );

    const heroImage = screen.getByRole("article", { name: "Hero image" });
    const heroImageToggle = within(heroImage).getByRole("button", {
      name: "Hero image",
    });
    fireEvent.click(heroImageToggle);
    await waitFor(() =>
      expect(heroImageToggle).toHaveAttribute("aria-expanded", "false"),
    );

    fireEvent.click(jump);

    await waitFor(() =>
      expect(heroImageToggle).toHaveAttribute("aria-expanded", "true"),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Lead image alt text")).toHaveFocus(),
    );
  });
});
