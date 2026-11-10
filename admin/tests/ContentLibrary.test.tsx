import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";
import { ContentLibrary } from "../src/components/ContentLibrary";
import {
  selectLibraryRecords,
  type LibrarySelection,
} from "../src/lib/content-library";
import { DEFAULT_CONTENT_QUERY } from "../src/lib/content-query";
import type { ContentRecordSummary } from "../src/lib/content-records";
import { HttpError, type BulkArchiveResponse } from "../src/lib/functions";
import * as cmsFunctions from "../src/lib/functions";
import { PublicContentStatusProvider } from "../src/context/PublicContentStatusContext";
import {
  ContentQuickActionsBoundary,
  type ContentQuickActionsApi,
} from "../src/context/ContentQuickActionsContext";
import {
  SavedContentViewValidationError,
  type SavedContentView,
  type SavedContentViewMutation,
} from "../src/lib/saved-content-views";

const records: ContentRecordSummary[] = [
  {
    id: "a-1",
    kind: "post",
    title: "Shore report",
    status: "draft",
    version: 2,
    updatedAt: "2026-07-20T15:00:00.000Z",
    updatedBy: "editor-1",
    assignee: "editor-2",
  },
  {
    id: "p-1",
    kind: "program",
    title: "Garden State",
    status: "published",
    version: 5,
    updatedAt: "2026-07-20T14:00:00.000Z",
    updatedBy: "editor-2",
    assignee: "editor-1",
  },
  {
    id: "a-2",
    kind: "post",
    title: "Trenton tonight",
    status: "in_review",
    version: 3,
    updatedAt: "2026-07-20T13:00:00.000Z",
    updatedBy: "editor-1",
    assignee: "editor-1",
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderLibrary(
  initialEntry = "/content/library",
  loadRecords = vi.fn(async () => records),
  savedViews: {
    load?: () => Promise<SavedContentView[]>;
    save?: (mutation: SavedContentViewMutation) => Promise<SavedContentView[]>;
  } = {},
) {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ContentLibrary
        canArchive={false}
        canCreate
        currentUserId="editor-1"
        loadRecords={loadRecords}
        loadSavedViews={savedViews.load}
        mutateSavedViews={savedViews.save}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  return loadRecords;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ContentLibrary", () => {
  it("does not start publication-status requests for compact library rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const spy = vi.spyOn(cmsFunctions, "cmsGetPublicationStatus").mockResolvedValue({
      success: true,
      found: false,
      publication: {
        workingVersion: null,
        contentVersion: null,
        workingStatus: "draft",
        publishedSourceVersion: null,
        publishedContentVersion: null,
        publicSourceVersion: null,
        publiclyVisible: false,
        publicUpdatePending: false,
        publicBuildQueueId: null,
        queueStatus: null,
      },
    });
    render(
      <MemoryRouter>
        <PublicContentStatusProvider getIdToken={async () => "test-token"}>
          <ContentLibrary
            canArchive={false}
            canCreate
            currentUserId="editor-1"
            loadRecords={async () => records.map((record) => record.kind === "program"
              ? { ...record, liveSourceVersion: 5 } : record)}
          />
        </PublicContentStatusProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Shore report")).toBeVisible();
    const programRow = screen.getByRole("link", { name: "Garden State" }).closest("tr");
    if (!programRow) throw new Error("Expected the published Program row.");
    expect(within(programRow).getByText("Published").closest("td"))
      .toHaveAttribute("data-label", "Status");
    expect(within(programRow).getByText("A published copy was last recorded")).toBeVisible();
    expect(await within(programRow).findByText("Public status unavailable")).toBeVisible();
    const postRow = screen.getByRole("link", { name: "Shore report" }).closest("tr")!;
    expect((await within(postRow).findByText("Public status unavailable")))
      .toHaveClass("published-version-label");
    expect(within(programRow).getByText("Public status unavailable"))
      .toHaveClass("published-version-label");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", "The saved copy is queued"],
    ["failed", "The saved copy was not published. Retry publication."],
  ])("keeps a Program's workflow and %s public-build evidence", async (queueStatus, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200, headers: { "content-type": "application/json" },
    })));
    const spy = vi.spyOn(cmsFunctions, "cmsGetPublicationStatus").mockResolvedValue({
      success: true, found: true,
      publication: {
        workingVersion: 5, contentVersion: 5, workingStatus: "published",
        publishedSourceVersion: 5, publishedContentVersion: 5, publicSourceVersion: 4,
        publiclyVisible: true, publicUpdatePending: true, publicBuildQueueId: "program-queue",
        queueStatus,
      },
    });
    render(<MemoryRouter>
      <PublicContentStatusProvider getIdToken={async () => "test-token"}>
        <ContentLibrary canArchive={false} canCreate currentUserId="editor-1"
          loadRecords={async () => [{ ...records[1], liveSourceVersion: 4,
            publicUpdatePending: true, publicBuildQueueId: "program-queue" }]} />
      </PublicContentStatusProvider>
    </MemoryRouter>);
    const row = (await screen.findByRole("link", { name: "Garden State" })).closest("tr");
    if (!row) throw new Error("Expected the published Program row.");
    expect(within(row).getByText("Published")).toBeVisible();
    expect(await within(row).findByText(message)).toBeVisible();
    expect(spy.mock.calls[0][1]).toMatchObject({ collection: "cmsPosts", id: "p-1" });
  });

  it("watches publication status for compact rows with in-flight publishes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const spy = vi.spyOn(cmsFunctions, "cmsGetPublicationStatus").mockResolvedValue({
      success: true,
      found: true,
      publication: {
        workingVersion: 2,
        contentVersion: 2,
        workingStatus: "published",
        publishedSourceVersion: 10,
        publishedContentVersion: 2,
        publicSourceVersion: 8,
        publiclyVisible: true,
        publicUpdatePending: true,
        publicBuildQueueId: "queue-one",
        queueStatus: "pending",
      },
    });
    render(
      <MemoryRouter>
        <PublicContentStatusProvider getIdToken={async () => "test-token"}>
          <ContentLibrary
            canArchive={false}
            canCreate
            currentUserId="editor-1"
            loadRecords={async () => [{
              ...records[0],
              publicUpdatePending: true,
              publicBuildQueueId: "queue-one",
            }]}
          />
        </PublicContentStatusProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Shore report")).toBeVisible();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][1]).toMatchObject({ collection: "cmsPosts", id: "a-1" });
  });

  it("offers restore for active record kinds and explains retired items", async () => {
    const deletedRecords: ContentRecordSummary[] = [
      { id: "program-1", kind: "program", title: "Archived program", status: "archived", version: 2 },
      { id: "event-1", kind: "event", title: "Archived event", status: "archived", version: 3 },
      { id: "article-1", kind: "article", title: "Retired article", status: "archived", version: 4 },
      { id: "staff-1", kind: "staff", title: "Retired staff record", status: "archived", version: 5 },
    ];
    const loadSelection = vi.fn(async (query) =>
      selectLibraryRecords(deletedRecords, query),
    );
    const quickActions: ContentQuickActionsApi = {
      principal: { id: "sa", grants: [{ role: "super_admin" }] },
      loadPage: vi.fn(async () => null),
      savePageMetadata: vi.fn(),
      loadRecord: vi.fn(async () => null),
      saveRecordMetadata: vi.fn(),
      transition: vi.fn(async () => ({})),
    };
    render(
      <MemoryRouter>
        <ContentQuickActionsBoundary value={quickActions}>
          <ContentLibrary
            canArchive={false}
            canCreate
            loadSelection={loadSelection}
          />
        </ContentQuickActionsBoundary>
      </MemoryRouter>,
    );

    const bin = (await screen.findByText("Recycle bin", { selector: "summary" }))
      .closest("details")!;
    bin.setAttribute("open", "");
    fireEvent(bin, new Event("toggle", { bubbles: true }));
    const table = await screen.findByRole("table", { name: "Deleted content" });

    expect(within(table).getAllByRole("button", { name: "Restore" })).toHaveLength(2);
    expect(within(table).getAllByText("This retired content type cannot be restored."))
      .toHaveLength(2);
    for (const title of ["Retired article", "Retired staff record"]) {
      const row = within(table).getByText(title).closest("tr");
      if (!row) throw new Error(`Expected the ${title} row.`);
      expect(within(row).queryByRole("button", { name: "Restore" })).toBeNull();
      expect(within(row).queryByRole("link", { name: "Open editor" })).toBeNull();
    }
  });

  it("pages active posts separately from the collapsed recycle bin", async () => {
    const manyRecords: ContentRecordSummary[] = Array.from({ length: 60 }, (_, index) => ({
      id: `post-${index}`, kind: "post", title: `Post ${index.toString().padStart(2, "0")}`,
      status: index % 2 ? "archived" : "draft", version: 2,
    }));
    const loadSelection = vi.fn(async (query) => selectLibraryRecords(manyRecords, query));
    render(<MemoryRouter><ContentLibrary postOnly canArchive={false} canCreate loadSelection={loadSelection} /></MemoryRouter>);
    const table = await screen.findByRole("table", { name: "Posts results" });
    expect(within(table).getAllByRole("row")).toHaveLength(26);
    expect(within(table).queryByText("Post 01")).toBeNull();
    const bin = screen.getByText("Recycle bin", { selector: "summary" }).closest("details")!;
    expect(bin).not.toHaveAttribute("open");
    expect(bin).toHaveTextContent("(30)");
    bin.setAttribute("open", "");
    fireEvent(bin, new Event("toggle", { bubbles: true }));
    const deleted = await screen.findByRole("table", { name: "Deleted content" });
    expect(within(deleted).getAllByRole("row")).toHaveLength(26);
    expect(within(deleted).getByText("Post 01")).toBeInTheDocument();
    const pagination = screen.getByRole("navigation", { name: "Recycle bin pages" });
    fireEvent.click(within(pagination).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(pagination).toHaveTextContent("Page 2 of 2"));
    expect(within(deleted).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getAllByRole("row")).toHaveLength(26);
  });

  it("shows a decorative thumbnail from the content summary", async () => {
    const { container } = render(
      <MemoryRouter>
        <ContentLibrary
          canArchive={false}
          canCreate
          loadRecords={vi.fn(async () => [{
            ...records[0],
            thumbnailUrl: "https://media.example.org/shore.jpg",
          }])}
        />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "https://media.example.org/shore.jpg");
    expect(image).toHaveAttribute("alt", "");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
  });

  it("keeps Posts queries scoped when a URL or quick view changes filters", async () => {
    const loadSelection = vi.fn(async (query) =>
      selectLibraryRecords(records, query, "editor-1"),
    );
    render(
      <MemoryRouter initialEntries={["/content/post?type=program&v=1"]}>
        <ContentLibrary postOnly canArchive={false} canCreate currentUserId="editor-1" loadSelection={loadSelection} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await screen.findByRole("link", { name: "Shore report" });
    expect(screen.queryByRole("link", { name: "Garden State" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All posts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All 3" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Assigned to me" }));
    await waitFor(() => expect(loadSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ types: ["post"], assignmentMode: "me" }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "All posts" }));
    await waitFor(() => expect(loadSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ types: ["post"], assignmentMode: "any" }),
    ));
    expect(loadSelection.mock.calls.every(([query]) => query.types.join() === "post")).toBe(true);
  });

  it("keeps neutral saved views in Posts and applies the fixed post type", async () => {
    const loadSelection = vi.fn(async (query) =>
      selectLibraryRecords(records, query, "editor-1"),
    );
    render(
      <MemoryRouter initialEntries={["/content/post"]}>
        <ContentLibrary
          postOnly
          canArchive={false}
          canCreate
          currentUserId="editor-1"
          loadSelection={loadSelection}
          loadSavedViews={vi.fn(async () => [
            {
              id: "assigned-drafts",
              name: "Assigned drafts",
              query: "status=draft&assigned=me&v=1",
            },
          ])}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    const savedView = await screen.findByRole("button", {
      name: "Assigned drafts",
    });
    fireEvent.click(savedView);

    await waitFor(() =>
      expect(loadSelection).toHaveBeenLastCalledWith(
        expect.objectContaining({
          types: ["post"],
          statuses: ["draft"],
          assignmentMode: "me",
        }),
      ),
    );
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/post?type=post&status=draft&assigned=me&v=1",
    );
    expect(savedView).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps unconfirmed public evidence with the workflow in one status cell", async () => {
    renderLibrary(
      "/content/library",
      vi.fn(async () => [
        {
          id: "post-appointments",
          kind: "post" as const,
          title: "Station appointments",
          status: "approved",
          version: 12,
          liveSourceVersion: 8,
        },
      ]),
    );

    const title = await screen.findByRole("link", {
      name: "Station appointments",
    });
    const row = title.closest("tr");
    if (!row) throw new Error("Expected the Station appointments row.");
    expect(
      within(row).getByText("Approved").closest("td"),
    ).toHaveAttribute("data-label", "Status");
    expect(
      within(row).getByText("A published copy was last recorded").closest("td"),
    ).toHaveAttribute("data-label", "Status");
    expect(within(row).getByText("Working version 12"))
      .toBeInTheDocument();
  });

  it("loads one server-selected page for the canonical URL query", async () => {
    const loadSelection = vi.fn(async (query) =>
      selectLibraryRecords(records, query, "editor-1", 1),
    );
    render(
      <MemoryRouter initialEntries={["/content/library?owner=me&page=2&v=1"]}>
        <ContentLibrary
          canArchive={false}
          canCreate
          currentUserId="editor-1"
          loadSelection={loadSelection}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "Trenton tonight" })).toBeInTheDocument();
    expect(screen.queryByText("Shore report")).not.toBeInTheDocument();
    expect(loadSelection).toHaveBeenCalledWith(
      expect.objectContaining({ ownerMode: "me", page: 2 }),
    );
    expect(screen.getByRole("button", { name: "All 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assigned to me 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "My recent edits 2" })).toBeInTheDocument();
  });

  it("keeps controls mounted and does not let a stale page rewrite a newer URL", async () => {
    const nextPage = deferred<ReturnType<typeof selectLibraryRecords>>();
    const loadSelection = vi
      .fn()
      .mockResolvedValueOnce(
        selectLibraryRecords(records, {
          ...DEFAULT_CONTENT_QUERY,
          types: [],
          statuses: [],
          ownerMode: "any",
          ownerUid: null,
          q: "",
          sortField: "updatedAt",
          sortDirection: "desc",
          page: 1,
        }, "editor-1", 1),
      )
      .mockReturnValueOnce(nextPage.promise);
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentLibrary
          canArchive={false}
          canCreate
          currentUserId="editor-1"
          loadSelection={loadSelection}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "Shore report" })).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search content" });
    search.focus();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(loadSelection).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/library?page=2&v=1",
    );
    expect(search).toHaveFocus();
    expect(screen.getByRole("link", { name: "Shore report" })).toBeInTheDocument();

    nextPage.resolve(
      selectLibraryRecords(records, {
        ...DEFAULT_CONTENT_QUERY,
        types: [],
        statuses: [],
        ownerMode: "any",
        ownerUid: null,
        q: "",
        sortField: "updatedAt",
        sortDirection: "desc",
        page: 2,
      }, "editor-1", 1),
    );
    expect(await screen.findByRole("link", { name: "Garden State" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/library?page=2&v=1",
    );
  });

  it("debounces search keystrokes without delaying a following status change", async () => {
    vi.useFakeTimers();
    const loadSelection = vi.fn(async (query) =>
      selectLibraryRecords(records, query, "editor-1"),
    );
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentLibrary
          canArchive={false}
          canCreate
          currentUserId="editor-1"
          loadSelection={loadSelection}
        />
      </MemoryRouter>,
    );

    await act(async () => vi.runOnlyPendingTimersAsync());
    expect(loadSelection).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search content" }), {
      target: { value: "Shore" },
    });
    expect(loadSelection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Draft 1" }));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(loadSelection).toHaveBeenCalledTimes(2);
    expect(loadSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "Shore", statuses: ["draft"] }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(loadSelection).toHaveBeenCalledTimes(2);
  });

  it("opens a durable assignment queue without relabeling recent edits", async () => {
    renderLibrary();

    const assigned = await screen.findByRole("button", {
      name: "Assigned to me 2",
    });
    fireEvent.click(assigned);

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/library?assigned=me&v=1",
    );
    expect(screen.getByRole("link", { name: "Garden State" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trenton tonight" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Shore report" })).not.toBeInTheDocument();
    expect(screen.getAllByText("You", { selector: "td" })).toHaveLength(2);
  });

  it("keeps advanced filters closed until the user asks for them", async () => {
    renderLibrary();
    await screen.findByRole("link", { name: "Shore report" });

    const filters = screen.getByRole("button", { name: "Filters" });
    expect(filters).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Content type" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Status" })).toBeNull();

    fireEvent.click(filters);

    expect(filters).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Content type" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Status" })).toBeVisible();
  });

  it("archives only versioned current-page selections and keeps every partial outcome visible", async () => {
    const bulkRecords: ContentRecordSummary[] = [
      records[0]!,
      records[1]!,
      {
        id: "archived-1",
        kind: "post",
        title: "Archived post",
        status: "archived",
        version: 4,
      },
      {
        id: "legacy-1",
        kind: "post",
        title: "Legacy post",
        status: "draft",
      },
      {
        id: "unsafe-1",
        kind: "post",
        title: "Unsafe version post",
        status: "draft",
        version: Number.MAX_SAFE_INTEGER + 1,
      },
    ];
    const loadRecords = vi.fn(async () => bulkRecords);
    const onMutatingChange = vi.fn();
    const archiveRecords = vi.fn(async () => ({
      success: true as const,
      outcomes: [
        { id: "a-1", status: "archived" as const, version: 3 },
        { id: "p-1", status: "conflict" as const },
      ],
      counts: {
        archived: 1,
        already_archived: 0,
        conflict: 1,
        missing: 0,
        failed: 0,
      },
    }));
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentLibrary
          archiveRecords={archiveRecords}
          canArchive
          canCreate
          currentUserId="editor-1"
          loadRecords={loadRecords}
          onMutatingChange={onMutatingChange}
        />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    const selectAll = screen.getByRole("checkbox", {
      name: "Select all eligible records on this page",
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Shore report" }));
    expect(selectAll).toBePartiallyChecked();
    fireEvent.click(selectAll);
    expect(selectAll).toBeChecked();

    expect(screen.getByRole("checkbox", { name: "Select Shore report" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Garden State" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Archived post is already in Recycle bin" })).toBeNull();
    expect(screen.queryByText("Archived post")).toBeNull();
    expect(screen.getByText("Recycle bin", { selector: "summary" }).closest("details"))
      .not.toHaveAttribute("open");
    expect(
      screen.getByRole("checkbox", {
        name: "Legacy post has no current version and cannot be moved to Recycle bin",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("checkbox", {
        name: "Unsafe version post has no current version and cannot be moved to Recycle bin",
      }),
    ).toBeDisabled();
    expect(within(screen.getByRole("group", { name: "Bulk actions" }))
      .getByText("2 records selected")).toBeVisible();
    expect(screen.getByText("· 2 eligible on this page")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Move selected to recycle bin" }));
    expect(archiveRecords).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Move the selected records to Recycle bin?" }))
      .toBeInTheDocument();
    expect(screen.getByText(/does not publish or deploy the site/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Move 2 records to Recycle bin" }));

    await waitFor(() =>
      expect(archiveRecords).toHaveBeenCalledWith([
        { id: "a-1", baseVersion: 2 },
        { id: "p-1", baseVersion: 5 },
      ]),
    );
    const resultTitle = await screen.findByText("Some records were not moved to Recycle bin");
    const result = resultTitle.closest<HTMLElement>(".inline-message")!;
    expect(within(result).getAllByRole("listitem")[0]).toHaveTextContent(
      "Shore report — Moved to Recycle bin.",
    );
    expect(within(result).getAllByRole("listitem")[1]).toHaveTextContent(
      "Changed since this page loaded",
    );
    expect(screen.queryByRole("group", { name: "Bulk actions" })).not.toBeInTheDocument();
    await waitFor(() => expect(loadRecords).toHaveBeenCalledTimes(2));
    expect(onMutatingChange.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    ["CMS publication is paused for a serializer handoff", "CMS publication is paused for a serializer handoff"],
    [undefined, "Could not be moved to Recycle bin. Reload before trying again."],
  ])("shows each failed archive cause and retains successful outcomes (%s)", async (message, expected) => {
    const archiveRecords = vi.fn(async (): Promise<BulkArchiveResponse> => ({
      success: true,
      outcomes: [
        { id: "a-1", status: "archived", version: 3 },
        { id: "p-1", status: "failed", ...(message ? { message } : {}) },
      ],
      counts: { archived: 1, already_archived: 0, conflict: 0, missing: 0, failed: 1 },
    }));
    render(<MemoryRouter initialEntries={["/content/library"]}>
      <ContentLibrary canArchive canCreate currentUserId="editor-1"
        loadRecords={async () => records.slice(0, 2)} archiveRecords={archiveRecords} />
    </MemoryRouter>);
    await screen.findByRole("link", { name: "Shore report" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all eligible records on this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected to recycle bin" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 2 records to Recycle bin" }));

    const title = await screen.findByText("Some records were not moved to Recycle bin");
    const results = within(title.closest<HTMLElement>(".inline-message")!).getAllByRole("listitem");
    expect(results[0]).toHaveTextContent("Shore report — Moved to Recycle bin.");
    expect(results[1]).toHaveTextContent(`Garden State — ${expected}`);
  });

  it("keeps a dirty quick edit mounted and blocks bulk archive", async () => {
    const archiveRecords = vi.fn(async (): Promise<BulkArchiveResponse> => ({
      success: true,
      outcomes: [{ id: "a-1", status: "archived", version: 3 }],
      counts: {
        archived: 1,
        already_archived: 0,
        conflict: 0,
        missing: 0,
        failed: 0,
      },
    }));
    const quickActions: ContentQuickActionsApi = {
      principal: { id: "sa", grants: [{ role: "super_admin" }] },
      loadPage: vi.fn(async () => null),
      savePageMetadata: vi.fn(async () => ({})),
      loadRecord: vi.fn(async () => ({
        id: "a-1",
        type: "post",
        title: "Shore report",
        summary: "Original summary.",
        status: "draft",
        section: "news",
        createdBy: "sa",
        version: 2,
      })),
      saveRecordMetadata: vi.fn(async () => ({})),
      transition: vi.fn(async () => ({})),
    };

    render(
      <MemoryRouter>
        <ContentQuickActionsBoundary value={quickActions}>
          <ContentLibrary
            archiveRecords={archiveRecords}
            canArchive
            canCreate
            currentUserId="editor-1"
            loadRecords={vi.fn(async () => [records[0]!])}
          />
        </ContentQuickActionsBoundary>
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Shore report" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected to recycle bin" }));
    expect(
      screen.getByRole("button", { name: "Move 1 record to Recycle bin" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Show details for Shore report" }),
    );
    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Unsaved draft title" } });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Move selected to recycle bin" }),
      ).toBeDisabled(),
    );
    expect(
      screen.queryByRole("button", { name: "Move 1 record to Recycle bin" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Save or discard the open quick edit before moving records to Recycle bin.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Unsaved draft title")).toBeInTheDocument();
    expect(archiveRecords).not.toHaveBeenCalled();
  });

  it("holds the addressed page and its navigation while a bulk archive is settling", async () => {
    const pendingArchive = deferred<BulkArchiveResponse>();
    const pendingReload = deferred<LibrarySelection>();
    const statusCounts = {
      draft: 1,
      in_review: 0,
      approved: 0,
      scheduled: 0,
      published: 0,
      archived: 0,
    };
    const selection: LibrarySelection = {
      records: [records[0]!],
      total: 2,
      allCount: 2,
      mineCount: 1,
      assignedCount: 0,
      page: 1,
      pageCount: 2,
      statusCounts,
    };
    const loadSelection = vi.fn()
      .mockResolvedValueOnce(selection)
      .mockReturnValueOnce(pendingReload.promise);
    const archiveRecords = vi.fn(() => pendingArchive.promise);
    render(
      <MemoryRouter initialEntries={["/content/library?v=1"]}>
        <ContentLibrary
          archiveRecords={archiveRecords}
          canArchive
          canCreate
          currentUserId="editor-1"
          loadSelection={loadSelection}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Shore report" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected to recycle bin" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 record to Recycle bin" }));

    const archiving = await screen.findByRole("button", { name: /^.+: Moving…$/ });
    expect(archiving).not.toBeDisabled();
    expect(archiving).toHaveAttribute("aria-disabled", "true");
    expect(archiving).toHaveAttribute("aria-busy", "true");
    expect(archiving.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByText("Moving selected records to Recycle bin.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByRole("searchbox", { name: "Search content" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Draft 1" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Sort by" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New content" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Shore report" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/content/library?v=1");

    await act(async () => {
      pendingArchive.resolve({
        success: true,
        outcomes: [{ id: "a-1", status: "archived", version: 3 }],
        counts: {
          archived: 1,
          already_archived: 0,
          conflict: 0,
          missing: 0,
          failed: 0,
        },
      });
    });

    expect(await screen.findByText("Move to Recycle bin complete")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search content" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Shore report" })).not.toBeInTheDocument();

    await act(async () => {
      pendingReload.resolve(selection);
    });

    expect(screen.getByRole("link", { name: "Shore report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("treats a disconnected bulk response as unknown and reloads before another attempt", async () => {
    const loadRecords = vi.fn(async () => [records[0]!]);
    const archiveRecords = vi.fn(async () => {
      throw new Error("connection reset after response");
    });
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentLibrary
          archiveRecords={archiveRecords}
          canArchive
          canCreate
          currentUserId="editor-1"
          loadRecords={loadRecords}
        />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Shore report" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected to recycle bin" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 record to Recycle bin" }));

    expect(
      await screen.findByText("The Move to Recycle bin result could not be confirmed"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Some records may have changed/)).toBeInTheDocument();
    expect(screen.queryByText("connection reset after response")).not.toBeInTheDocument();
    await waitFor(() => expect(loadRecords).toHaveBeenCalledTimes(2));
  });

  it("reports a structured server rejection without implying partial changes", async () => {
    const loadRecords = vi.fn(async () => [records[0]!]);
    const archiveRecords = vi.fn(async () => {
      throw new HttpError(403, "Admin access required");
    });
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentLibrary
          archiveRecords={archiveRecords}
          canArchive
          canCreate
          currentUserId="editor-1"
          loadRecords={loadRecords}
        />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Shore report" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected to recycle bin" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 record to Recycle bin" }));

    expect(await screen.findByText("Move to Recycle bin was rejected")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Request failed (403): Admin access required. No records were changed.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Some records may have changed/)).not.toBeInTheDocument();
    await waitFor(() => expect(loadRecords).toHaveBeenCalledTimes(2));
  });

  it("keeps archive outcomes visible when the reload collapses the last page", async () => {
    const onMutatingChange = vi.fn();
    const statusCounts = {
      draft: 1,
      in_review: 0,
      approved: 0,
      scheduled: 0,
      published: 0,
      archived: 0,
    };
    const pageTwo: LibrarySelection = {
      records: [records[0]!],
      total: 2,
      allCount: 2,
      mineCount: 1,
      assignedCount: 0,
      page: 2,
      pageCount: 2,
      statusCounts,
    };
    const collapsed: LibrarySelection = {
      records: [],
      total: 0,
      allCount: 1,
      mineCount: 0,
      assignedCount: 0,
      page: 1,
      pageCount: 1,
      statusCounts: { ...statusCounts, draft: 0, archived: 1 },
    };
    const loadSelection = vi.fn()
      .mockResolvedValueOnce(pageTwo)
      .mockResolvedValueOnce(collapsed)
      .mockImplementation(async () => {
        // The page-2 response already supplied authoritative page-1 data. The mutation hold must
        // release before the component's canonical URL rewrite starts this redundant page-1 read,
        // or ContentLayout's in-flight route blocker rejects the component's own navigation.
        expect(onMutatingChange).toHaveBeenLastCalledWith(false);
        return collapsed;
      });
    const archiveRecords = vi.fn(async () => ({
      success: true as const,
      outcomes: [{ id: "a-1", status: "archived" as const, version: 3 }],
      counts: {
        archived: 1,
        already_archived: 0,
        conflict: 0,
        missing: 0,
        failed: 0,
      },
    }));
    render(
      <MemoryRouter initialEntries={["/content/library?status=draft&page=2&v=1"]}>
        <ContentLibrary
          archiveRecords={archiveRecords}
          canArchive
          canCreate
          currentUserId="editor-1"
          loadSelection={loadSelection}
          onMutatingChange={onMutatingChange}
        />
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByRole("link", { name: "Shore report" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Shore report" }));
    fireEvent.click(screen.getByRole("button", { name: "Move selected to recycle bin" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 record to Recycle bin" }));

    const resultTitle = await screen.findByText("Move to Recycle bin complete");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/content/library?status=draft&v=1",
      ),
    );
    await waitFor(() => expect(loadSelection).toHaveBeenCalledTimes(3));
    expect(loadSelection).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
    const result = resultTitle.closest<HTMLElement>(".inline-message")!;
    expect(within(result).getByRole("listitem")).toHaveTextContent(
      "Shore report — Moved to Recycle bin.",
    );
    expect(onMutatingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("opens a URL-addressed My recent edits draft view across content types", async () => {
    renderLibrary("/content/library?status=draft&owner=me&v=1");

    const table = await screen.findByRole("table", { name: "All content results" });
    expect(within(table).getByRole("link", { name: "Shore report" })).toHaveAttribute(
      "href",
      "/content/post/a-1/edit",
    );
    const row = within(table).getByRole("link", { name: "Shore report" }).closest("tr");
    if (!row) throw new Error("Expected the Shore report row.");
    expect(within(row).getByRole("link", { name: "Edit Shore report" })).toHaveAttribute(
      "href",
      "/content/post/a-1/edit",
    );
    expect(within(table).queryByText("Garden State")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /My recent edits/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The address already narrows the list, so the panel opens showing its constraints and
    // the button counts the two axes in play.
    const filters = screen.getByRole("button", { name: "Filters, 2 filters active" });
    expect(filters).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Updated by me" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Draft" })).toBeChecked();
  });

  it("writes search and type filters into the shareable URL", async () => {
    renderLibrary();
    await screen.findByText("Shore report");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search content" }), {
      target: { value: "Garden" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Programs" }));

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/library?type=program&q=Garden&v=1",
    );
    expect(screen.getByRole("link", { name: "Garden State" })).toBeInTheDocument();
    expect(screen.queryByText("Shore report")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Published 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Published 1" }));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/library?type=program&status=published&q=Garden&v=1",
    );
  });

  it("offers no way to create a retired kind, and names a stored one as retired", async () => {
    // #1039 retired Article and #1103 removed the last creation path. The disclosure
    // must not list it, and a record stored before the retirement must still appear --
    // named as retired, with no link into an editor that no longer exists.
    const loadRecords = vi.fn(async () => [
      {
        id: "legacy-article",
        kind: "article" as const,
        title: "A story saved before the retirement",
        status: "draft",
        version: 2,
        updatedAt: "2026-07-20T15:00:00.000Z",
        updatedBy: "editor-1",
      },
    ]);
    renderLibrary("/content/library", loadRecords);

    const table = await screen.findByRole("table", {
      name: "All content results",
    });
    expect(
      within(table).getByText("A story saved before the retirement"),
    ).toBeInTheDocument();
    expect(
      within(table).queryByRole("link", {
        name: "A story saved before the retirement",
      }),
    ).not.toBeInTheDocument();
    expect(within(table).getByText("Article (retired)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New content" }));
    const createNavigation = screen.getByRole("navigation", {
      name: "Create a content record",
    });
    expect(
      within(createNavigation).queryByRole("link", { name: /article/i }),
    ).toBeNull();
    expect(
      within(createNavigation).getByRole("link", { name: "New post" }),
    ).toBeInTheDocument();
  });

  it("keeps every record creator discoverable behind one contextual disclosure", async () => {
    renderLibrary();
    await screen.findByText("Shore report");

    const disclosure = screen.getByRole("button", { name: "New content" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("navigation", { name: "Create a content record" })).toBeNull();

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const createNavigation = screen.getByRole("navigation", {
      name: "Create a content record",
    });
    for (const [name, href] of [
      ["New program", "/content/program/+"],
      ["New event", "/content/event/+"],
      ["New sponsor", "/content/sponsor/+"],
      ["New newsletter", "/content/newsletter/+"],
      ["New post", "/content/post/+"],
    ]) {
      expect(within(createNavigation).getByRole("link", { name })).toHaveAttribute("href", href);
    }
    expect(
      within(createNavigation).queryByRole("link", { name: "New staff member" }),
    ).toBeNull();
    expect(within(createNavigation).getByRole("link", { name: "Post from template" }))
      .toHaveAttribute("href", "/post-templates");
    expect(screen.queryByRole("link", { name: "Post templates" })).not.toBeInTheDocument();
  });

  it("keeps sorting, filters and selection available without an empty bulk panel", async () => {
    render(
      <MemoryRouter initialEntries={["/content/library"]}>
        <ContentLibrary
          archiveRecords={vi.fn()}
          canArchive
          canCreate
          currentUserId="editor-1"
          loadRecords={async () => records}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    const table = await screen.findByRole("table", { name: "All content results" });
    const selectAll = within(table).getByRole("checkbox", {
      name: "Select all eligible records on this page",
    });
    expect(selectAll.closest("th")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Bulk actions" })).not.toBeInTheDocument();
    const selectionStatus = screen.getByRole("status", { name: "Selected records" });
    expect(selectionStatus).toHaveTextContent("0 records selected");

    fireEvent.click(screen.getByRole("button", { name: "Direction: descending. Switch to ascending" }));
    expect(screen.getByRole("button", { name: "Direction: ascending. Switch to descending" }))
      .toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("dir=asc");

    const filters = screen.getByRole("button", { name: "Filters" });
    fireEvent.click(filters);
    expect(filters).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Draft" })).toBeVisible();
    fireEvent.click(filters);
    expect(filters).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(selectAll);
    expect(screen.getByRole("group", { name: "Bulk actions" })).toBeInTheDocument();
    expect(selectionStatus).toHaveTextContent("3 records selected");
    fireEvent.click(selectAll);
    expect(screen.queryByRole("group", { name: "Bulk actions" })).not.toBeInTheDocument();
    expect(selectionStatus).toBeInTheDocument();
    expect(selectionStatus).toHaveTextContent("0 records selected");
  });

  it("offers a retry when the combined read fails", async () => {
    const loadRecords = vi
      .fn<() => Promise<ContentRecordSummary[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(records);
    renderLibrary("/content/library", loadRecords);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "All content could not be loaded",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try loading All content again" }));
    await waitFor(() => expect(loadRecords).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Shore report")).toBeInTheDocument();
  });

  it("loads a durable named view and opens its page-independent query", async () => {
    renderLibrary("/content/library", undefined, {
      load: vi.fn(async () => [
        {
          id: "draft-posts",
          name: "Draft posts",
          query: "type=post&status=draft&v=1",
        },
      ]),
      save: vi.fn(async () => []),
    });

    const savedView = await screen.findByRole("button", { name: "Draft posts" });
    fireEvent.click(savedView);

    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/library?type=post&status=draft&v=1",
    );
    expect(savedView).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the filter panel when a saved view narrows the list", async () => {
    renderLibrary("/content/library", undefined, {
      load: vi.fn(async () => [
        {
          id: "draft-posts",
          name: "Draft posts",
          query: "type=post&status=draft&v=1",
        },
      ]),
      save: vi.fn(async () => []),
    });
    await screen.findByRole("link", { name: "Shore report" });
    expect(screen.getByRole("button", { name: "Filters" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    fireEvent.click(await screen.findByRole("button", { name: "Draft posts" }));

    // The view's constraints are shown as it lands, with the count on the button, so the
    // narrowed list is never a mystery behind a closed disclosure.
    const filters = screen.getByRole("button", { name: "Filters, 2 filters active" });
    expect(filters).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("checkbox", { name: "Posts" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Draft" })).toBeChecked();
  });

  it("names and persists the current URL-backed filter as a durable view", async () => {
    const save = vi.fn(async (mutation: SavedContentViewMutation) =>
      mutation.type === "add"
        ? [
            { id: "broken", name: "", query: "v=1" },
            {
              ...mutation.view,
              name: ` ${mutation.view.name} `,
              query: `${mutation.view.query}&page=4`,
            },
          ]
        : [],
    );
    renderLibrary("/content/library?type=program&status=published&page=4&v=1", undefined, {
      load: vi.fn(async () => []),
      save,
    });
    await screen.findByText("Garden State");

    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Published programs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        type: "add",
        view: {
          id: expect.any(String),
          name: "Published programs",
          query: "type=program&status=published&v=1",
        },
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Published programs" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it.each([false, true])("returns saved-view focus after unlocking, unless focus moved away (%s)", async (moveAway) => {
    const pending = deferred<SavedContentView[]>();
    renderLibrary("/content/library?status=draft&v=1", undefined, {
      load: vi.fn(async () => []), save: vi.fn(() => pending.promise),
    });
    await screen.findByText("Shore report");
    const trigger = screen.getByRole("button", { name: "Save current view" });
    fireEvent.click(trigger);
    const name = screen.getByRole("textbox", { name: "View name" });
    fireEvent.change(name, { target: { value: "Drafts focus fixture" } });
    const submit = screen.getByRole("button", { name: "Save view" });
    submit.focus();
    fireEvent.click(submit);
    await waitFor(() => expect(trigger).toBeDisabled());
    const elsewhere = screen.getByRole("searchbox", { name: "Search content" });
    if (moveAway) elsewhere.focus();
    await act(async () => pending.resolve([{ id: "drafts-focus", name: "Drafts focus fixture", query: "status=draft&v=1" }]));
    await waitFor(() => expect(trigger).toBeEnabled());
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "View name" })).toBeNull());
    // Assert after the source's scheduled return frame, so the negative case
    // cannot pass before a later unconditional focus steal.
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    await waitFor(() => expect(moveAway ? elsewhere : trigger).toHaveFocus());
    if (moveAway) expect(trigger).not.toHaveFocus();
  });

  it("blocks a second saved-view form submission while the first is pending", async () => {
    const pendingSave = deferred<SavedContentView[]>();
    const save = vi.fn((_mutation: SavedContentViewMutation) => pendingSave.promise);
    renderLibrary("/content/library?status=draft&v=1", undefined, {
      load: vi.fn(async () => []),
      save,
    });
    await screen.findByText("Shore report");

    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Drafts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    const saving = await screen.findByRole("button", { name: /^.+: Saving view…$/ });
    fireEvent.submit(saving.closest("form")!);
    expect(save).toHaveBeenCalledTimes(1);

    const mutation = save.mock.calls[0]![0];
    await act(async () => {
      pendingSave.resolve(mutation.type === "add" ? [mutation.view] : []);
    });
    expect(await screen.findByRole("button", { name: "Drafts" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("deletes a named view without changing the current filters", async () => {
    const save = vi.fn(async () => []);
    renderLibrary("/content/library?status=draft&v=1", undefined, {
      load: vi.fn(async () => [
        { id: "drafts", name: "Drafts", query: "status=draft&v=1" },
      ]),
      save,
    });

    await screen.findByRole("button", { name: "Drafts" });
    fireEvent.click(screen.getByRole("button", { name: "Delete saved view Drafts" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ type: "delete", id: "drafts" }),
    );
    expect(screen.queryByRole("button", { name: "Drafts" })).toBeNull();
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/content/library?status=draft&v=1",
    );
  });

  it("shows safe validation failures and keeps the unsaved view visible", async () => {
    renderLibrary("/content/library?status=draft&v=1", undefined, {
      load: vi.fn(async () => []),
      save: vi.fn(async () => {
        throw new SavedContentViewValidationError("Sign in again to save this view.");
      }),
    });
    await screen.findByText("Shore report");

    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Drafts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign in again to save this view.",
    );
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("Drafts");
  });

  it("masks unexpected persistence failures", async () => {
    renderLibrary("/content/library?status=draft&v=1", undefined, {
      load: vi.fn(async () => []),
      save: vi.fn(async () => {
        throw new Error("backend auth details");
      }),
    });
    await screen.findByText("Shore report");

    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "View name" }), {
      target: { value: "Drafts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The saved view could not be stored.");
    expect(alert).not.toHaveTextContent("backend auth details");
  });

  // The create menu is a temporary panel over the toolbar, so it owes a person the three
  // dismissals every other panel here honors: Escape, an explicit re-activation of the
  // control that opened it, and pointer activation somewhere else (#1036).
  describe("the create menu's dismissal", () => {
    async function openCreateMenu() {
      renderLibrary();
      await screen.findByText("Shore report");
      const trigger = screen.getByRole("button", { name: "New content" });
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      return trigger;
    }

    it("closes on Escape and returns focus to the control that opened it", async () => {
      const trigger = await openCreateMenu();

      fireEvent.keyDown(document, { key: "Escape" });

      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).toHaveFocus();
    });

    it("closes when a pointer goes down outside it", async () => {
      const trigger = await openCreateMenu();

      fireEvent.pointerDown(screen.getByRole("searchbox", { name: "Search content" }));

      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    it("stays open while the pointer is inside it", async () => {
      const trigger = await openCreateMenu();

      fireEvent.pointerDown(screen.getByRole("link", { name: "New post" }));

      expect(trigger).toHaveAttribute("aria-expanded", "true");
    });

    it("still closes on a second activation of its own control", async () => {
      const trigger = await openCreateMenu();

      fireEvent.click(trigger);

      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });
  });
});


it.each(["program", "event"].flatMap(kind => [true, false].map(visible => ({ kind, visible }))))(
  "retains settled $kind confirmation after reopening the library with visible=$visible", async ({ kind, visible }) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("_content-status")
    ? { commitSha: "old", generation: 1, routes: [] } : { commitSha: "old", generation: 1 })));
  const metadata = vi.spyOn(cmsFunctions, "cmsGetPublicationStatus");
  render(<MemoryRouter><PublicContentStatusProvider getIdToken={async () => "test-token"}>
    <ContentLibrary canArchive={false} canCreate currentUserId="editor-1" loadRecords={async () => [{
      ...records[1], kind: kind as "program" | "event", version: 10, contentVersion: 10,
      publishedSourceVersion: 10, publishedContentVersion: 10, liveSourceVersion: visible ? 10 : undefined,
      publicUpdatePending: false, publicBuildQueueId: null,
      recordPublication: { queueId: "A".repeat(20), sourceVersion: 10, withdrawal: !visible, status: "success", missingConsumers: [] },
    }]} />
  </PublicContentStatusProvider></MemoryRouter>);
  const row = (await screen.findByRole("link", { name: "Garden State" })).closest("tr")!;
  expect(await within(row).findByText(visible ? "Version 10 live" : "Not live")).toBeVisible();
  expect(within(row).queryByText("Public status unavailable")).not.toBeInTheDocument();
  expect(metadata).not.toHaveBeenCalled();
});
