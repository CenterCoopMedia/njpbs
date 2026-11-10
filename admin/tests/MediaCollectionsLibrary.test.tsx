import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { HttpError } from "../src/lib/functions";
import { MediaCollectionsLibrary } from "../src/routes/MediaCollectionsLibrary";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import { resolveCollectionAssetOverrides } from "../src/routes/MediaCollectionItems";
import type { MediaAssetSummary } from "../src/lib/functions";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";
import { listMediaSources } from "../src/lib/source-media";
import type { MediaCollectionItemPage, MediaCollectionScope, MediaCollectionSummary } from "../src/lib/media-collections";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  listItems: vi.fn(),
  mutate: vi.fn(),
  setItems: vi.fn(),
  savePins: vi.fn(),
  loadViews: vi.fn(),
  mutateViews: vi.fn(),
  refreshAsset: vi.fn(),
}));

function setViewport(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: /max-width:\s*61\.99rem/.test(query) ? width < 992 : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}
vi.mock("../src/lib/media-collections", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/media-collections")>()),
  listMediaCollections: (...args: unknown[]) => mocks.list(...args),
  listMediaCollectionItems: (...args: unknown[]) => mocks.listItems(...args),
  mutateMediaCollection: (...args: unknown[]) => mocks.mutate(...args),
  setMediaCollectionItems: (...args: unknown[]) => mocks.setItems(...args),
}));
vi.mock("../src/lib/media-collection-pins-store", () => ({
  saveMediaCollectionPin: (...args: unknown[]) => mocks.savePins(...args),
}));
vi.mock("../src/lib/saved-media-view-store", () => ({
  loadMediaLibraryViews: (...args: unknown[]) => mocks.loadViews(...args),
  mutateMediaLibraryViews: (...args: unknown[]) => mocks.mutateViews(...args),
}));
vi.mock("../src/lib/source-media", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/source-media")>()),
  listMediaSources: vi.fn().mockResolvedValue({ sources: [] }),
  listSourceMedia: (...args: unknown[]) => mocks.refreshAsset(...args),
}));
vi.mock("../src/routes/SourceMediaLibrary", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    VideoViewerBody: ({ onDirtyChange, canReplace }: { onDirtyChange: (dirty: boolean) => void; canReplace?: boolean }) => {
      useEffect(() => { onDirtyChange(true); return () => onDirtyChange(false); }, [onDirtyChange]);
      return <section>Video body<output aria-label="Replacement capability">{String(canReplace === true)}</output></section>;
    },
    sharePosterRead: vi.fn(),
  };
});
vi.mock("../src/components/media/ImageViewer", () => ({
  ImageViewerBody: ({ onReload }: { onReload: () => void }) => <button type="button" onClick={onReload}>Reload asset</button>,
  ImageViewerHeaderActions: () => null,
  imageViewerFacts: () => "",
}));

const privateCollectionId = "a".repeat(64);
const collectionId = "b".repeat(64);
const getIdToken = async () => "token-a";
function summary(scope: MediaCollectionScope = "private", version = 1): MediaCollectionSummary {
  return {
    id: scope === "private" ? privateCollectionId : collectionId,
    scope,
    name: "Election package",
    description: "Current campaign files",
    lifecycle: "active",
    version,
    membershipVersion: 3,
    cover: null,
    canEdit: true,
    createdAt: null,
    updatedAt: null,
    itemCount: 1,
  };
}
function detail(version = 1): MediaCollectionItemPage {
  return {
    success: true,
    collection: { ...summary("all_staff", version), name: version === 1 ? "Election package" : "Election package from another editor" },
    items: [{ ref: { backend: "s3", sourceId: "video-library", id: "private-video" }, addedAt: "2026-09-22T12:00:00Z", available: false }],
    nextCursor: null,
    hasMore: false,
  };
}

function imageAsset(id: string, name: string): MediaAssetSummary {
  return { id, name, originalName: `${id}.png`, category: "news", categories: [], tags: [],
    description: null, altText: null, license: null, credit: null, mimeType: "image/png",
    kind: "image", sizeBytes: 1024, width: 100, height: 100, url: `https://example.test/${id}.png`,
    lifecycle: "active", version: 1, etag: `${id}-v1`, createdAt: null, createdBy: null,
    updatedAt: null, updatedBy: null };
}

function renderLibrary(path = "/media/collections", canBrowseImages = true, userId = "staff-a", presentation: "icons" | "text" = "icons") {
  function CollectionRoute() {
    const location = useLocation();
    const pathname = location.pathname;
    const id = pathname.split("/").at(-1) === "collections" ? null : pathname.split("/").at(-1)!;
    return <SuccessNoticeProvider routeKey={`${userId}:${location.key}`}>
      <MediaCollectionsLibrary collectionId={id} userId={userId} userDoc={null}
        principal={{ id: userId, grants: [{ role: "super_admin" }] }} categories={[]}
        canBrowseImages={canBrowseImages} getIdToken={getIdToken} />
    </SuccessNoticeProvider>;
  }
  const router = createMemoryRouter([{
    path: "/media/collections/*",
    element: <CollectionRoute />,
  }], { initialEntries: [path] });
  return { router, ...render(<ControlPresentationProvider value={presentation}><RouterProvider router={router} /></ControlPresentationProvider>) };
}

beforeEach(() => {
  vi.resetAllMocks();
  setViewport(1280);
  mocks.list.mockImplementation(async (_token: string, query: { scope: MediaCollectionScope }) => ({
    success: true,
    collections: [summary(query.scope)],
    nextCursor: null,
    hasMore: false,
  }));
  mocks.listItems.mockResolvedValue(detail());
  mocks.refreshAsset.mockResolvedValue({ success: true, records: [], nextCursor: null, hasMore: false, total: 0 });
  mocks.mutate.mockResolvedValue({ success: true, changed: true, replayed: false, collection: summary("all_staff") });
  mocks.setItems.mockResolvedValue({ success: true, collectionId, changed: true, replayed: false, version: 1, membershipVersion: 4 });
  mocks.savePins.mockImplementation(async (_userId: string, targetId: string, pinned: boolean) => ({
    version: 1,
    ids: pinned ? [targetId] : [],
  }));
  mocks.loadViews.mockResolvedValue([]);
  mocks.mutateViews.mockResolvedValue([]);
});

describe("MediaCollectionsLibrary", () => {
  it("creates the selected private or all-staff scope with a stable request", async () => {
    mocks.list.mockResolvedValue({ success: true, collections: [], nextCursor: null, hasMore: false });
    const { router } = renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "New collection" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Weekly package" } });
    fireEvent.change(screen.getByLabelText("Who can see and organize it?"), { target: { value: "all_staff" } });
    fireEvent.click(screen.getByRole("button", { name: "Create collection" }));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("token-a", expect.objectContaining({
      action: "create",
      scope: "all_staff",
      name: "Weekly package",
    })));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/media/collections/${collectionId}`));
    expect(screen.queryByRole("heading", { name: "New collection" })).toBeNull();
  });

  it("keeps a draft until the person confirms a route change", async () => {
    const { router } = renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "New collection" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Morning package" } });
    await act(async () => { await router.navigate(`/media/collections/${collectionId}`); });

    expect(router.state.location.pathname).toBe("/media/collections");
    expect(screen.getByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Morning package");

    await act(async () => { await router.navigate(`/media/collections/${collectionId}`); });
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/media/collections/${collectionId}`));
  });

  it("holds navigation until a create request finishes", async () => {
    let finishCreate!: (value: unknown) => void;
    mocks.mutate.mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve; }));
    const { router } = renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "New collection" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Morning package" } });
    fireEvent.click(screen.getByRole("button", { name: "Create collection" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));

    await act(async () => { await router.navigate(`/media/collections/${privateCollectionId}`); });
    expect(router.state.location.pathname).toBe("/media/collections");
    expect(screen.getByText("Wait for this change to finish before leaving the collection.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard and leave" })).toBeNull();

    await act(async () => { finishCreate({ success: true, changed: true, replayed: false, collection: summary("all_staff") }); });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/media/collections/${privateCollectionId}`));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it("keeps the create request identity after a failed response and blocked exit", async () => {
    let failCreate!: (reason: Error) => void;
    mocks.mutate.mockImplementationOnce(() => new Promise((_resolve, reject) => { failCreate = reject; }));
    const { router } = renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "New collection" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Morning package" } });
    fireEvent.click(screen.getByRole("button", { name: "Create collection" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    await act(async () => { await router.navigate(`/media/collections/${privateCollectionId}`); });
    await act(async () => { failCreate(new Error("Connection lost")); });

    expect(router.state.location.pathname).toBe("/media/collections");
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create collection" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
    expect(mocks.mutate.mock.calls[1][1].requestId).toBe(mocks.mutate.mock.calls[0][1].requestId);
  });

  it("guards unsaved collection details before opening another route", async () => {
    const { router } = renderLibrary(`/media/collections/${collectionId}`);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Revised election package" } });
    await act(async () => { await router.navigate("/media/collections"); });
    expect(router.state.location.pathname).toBe(`/media/collections/${collectionId}`);
    expect(screen.getByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Revised election package");
  });

  it("reloads a metadata conflict and keeps the warning visible", async () => {
    mocks.listItems.mockResolvedValueOnce(detail(1)).mockResolvedValueOnce(detail(2));
    mocks.mutate.mockRejectedValueOnce(new HttpError(409, "Conflict"));
    renderLibrary(`/media/collections/${collectionId}`);
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "My revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save collection details" }));

    expect(await screen.findByText(/Current details were reloaded/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Election package from another editor"));
    expect(screen.getByText(/Current details were reloaded/)).toBeInTheDocument();
  });

  it("stays on a collection when an in-flight edit conflicts after navigation", async () => {
    let failEdit!: (reason: Error) => void;
    mocks.mutate.mockImplementationOnce(() => new Promise((_resolve, reject) => { failEdit = reject; }));
    mocks.listItems.mockResolvedValueOnce(detail(1)).mockResolvedValueOnce(detail(2));
    const { router } = renderLibrary(`/media/collections/${collectionId}`);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "My revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save collection details" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    await act(async () => { await router.navigate("/media/collections"); });
    await act(async () => { failEdit(new HttpError(409, "Conflict")); });

    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Election package from another editor"));
    expect(router.state.location.pathname).toBe(`/media/collections/${collectionId}`);
    expect(screen.getByText(/Current details were reloaded/)).toBeInTheDocument();
  });

  it("keeps unsaved details when loading another item page", async () => {
    mocks.listItems.mockResolvedValueOnce({ ...detail(), nextCursor: "page-two", hasMore: true })
      .mockResolvedValueOnce({ ...detail(), items: [], nextCursor: null, hasMore: false });
    renderLibrary(`/media/collections/${collectionId}`);
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "My unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Load more items" }));

    await waitFor(() => expect(mocks.listItems).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more items" })).toBeNull());
    expect(screen.getByLabelText("Name")).toHaveValue("My unsaved name");
  });

  it("keeps unsaved details when a remove conflict reloads the same version", async () => {
    mocks.setItems.mockRejectedValueOnce(new HttpError(409, "Conflict"));
    renderLibrary(`/media/collections/${collectionId}`);
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "My unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove unavailable item from collection" }));

    await waitFor(() => expect(mocks.listItems).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Name")).toHaveValue("My unsaved name");
    expect(screen.getByText(/Collection items changed/)).toBeInTheDocument();
  });

  it("waits for an edit before leaving a collection", async () => {
    let finishEdit!: (value: unknown) => void;
    mocks.mutate.mockImplementationOnce(() => new Promise(resolve => { finishEdit = resolve; }));
    mocks.listItems.mockImplementation(async (_token: string, query: { collectionId: string }) => ({
      ...detail(),
      collection: { ...detail().collection, id: query.collectionId, name: query.collectionId === privateCollectionId ? "First collection" : "Second collection" },
    }));
    const { router } = renderLibrary(`/media/collections/${privateCollectionId}`);
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Unsaved first edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save collection details" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    await act(async () => { await router.navigate(`/media/collections/${collectionId}`); });
    expect(router.state.location.pathname).toBe(`/media/collections/${privateCollectionId}`);
    expect(screen.queryByRole("button", { name: "Discard and leave" })).toBeNull();

    await act(async () => { finishEdit({ success: true, changed: true, replayed: false, collection: { ...summary(), name: "Saved first collection" } }); });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/media/collections/${collectionId}`));
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Second collection"));
  });

  it("clears an archive confirmation when another collection opens", async () => {
    mocks.listItems.mockImplementation(async (_token: string, query: { collectionId: string }) => ({
      ...detail(),
      collection: { ...detail().collection, id: query.collectionId },
    }));
    const { router } = renderLibrary(`/media/collections/${privateCollectionId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Archive collection" }));
    expect(screen.getByText("Archive collection?")).toBeInTheDocument();
    await act(async () => { await router.navigate(`/media/collections/${collectionId}`); });

    await waitFor(() => expect(mocks.listItems).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Archive collection?")).toBeNull();
    expect(screen.getByRole("button", { name: "Archive collection" })).toBeEnabled();
  });

  it("removes an unavailable reference without an asset delete or upload", async () => {
    renderLibrary(`/media/collections/${collectionId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Remove unavailable item from collection" }));
    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledWith("token-a", expect.objectContaining({
      collectionId,
      baseMembershipVersion: 3,
      present: false,
      refs: [{ backend: "s3", sourceId: "video-library", id: "private-video" }],
    })));
    expect(screen.getByText(/does not delete or change the file/)).toBeInTheDocument();
    expect(screen.queryByText("Unavailable item")).toBeNull();
    expect(mocks.listItems).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Items" })).toHaveFocus());
  });

  it("removes selected full references in one bounded membership request", async () => {
    const r2 = { backend: "r2" as const, id: "private-video" };
    const s3 = { backend: "s3" as const, sourceId: "video-library", id: "private-video" };
    mocks.listItems.mockResolvedValue({ ...detail(), collection: { ...detail().collection, itemCount: 2 }, items: [
      { ref: r2, addedAt: "2026-09-22T12:00:00Z", available: false },
      { ref: s3, addedAt: "2026-09-22T12:00:00Z", available: false },
    ] });
    renderLibrary(`/media/collections/${collectionId}`);
    const marks = await screen.findAllByRole("checkbox", { name: "Select unavailable collection item" });
    expect(marks[1]).toHaveAttribute("tabindex", "-1");
    const menus = screen.getAllByRole("button", { name: "More actions: Unavailable item" });
    expect(menus[1]).toHaveAttribute("tabindex", "-1");
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Display" }), { key: "Escape" });
    const listMenus = screen.getAllByRole("button", { name: "More actions: Unavailable item" });
    expect(listMenus[1]).toHaveAttribute("tabindex", "-1");
    screen.getAllByRole("checkbox", { name: "Select unavailable collection item" }).forEach(mark => fireEvent.click(mark));
    fireEvent.click(screen.getByRole("button", { name: "Remove from collection" }));
    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledWith("token-a", expect.objectContaining({
      collectionId, present: false, baseMembershipVersion: 3, refs: [r2, s3],
    })));
    expect(mocks.setItems).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryAllByText("Unavailable item")).toHaveLength(0));
  });

  it("restores only confirmed removed references with one version-bound Undo", async () => {
    const r2 = { backend: "r2" as const, id: "private-video" };
    const s3 = { backend: "s3" as const, sourceId: "video-library", id: "private-video" };
    mocks.listItems.mockResolvedValue({ ...detail(), collection: { ...summary("private"), itemCount: 2 }, items: [
      { ref: r2, addedAt: "2026-09-22T12:00:00Z", available: true, asset: imageAsset(r2.id, "Package image") },
      { ref: s3, addedAt: "2026-09-22T12:00:00Z", available: false },
    ] });
    mocks.setItems
      .mockResolvedValueOnce({
        success: true, collectionId: privateCollectionId, changed: true, replayed: false,
        version: 1, membershipVersion: 4, changedRefs: [r2], hiddenChangedCount: 1,
      })
      .mockResolvedValueOnce({
        success: true, collectionId: privateCollectionId, changed: true, replayed: false,
        version: 1, membershipVersion: 5, changedRefs: [r2],
      });
    renderLibrary(`/media/collections/${privateCollectionId}`);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Package image" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select unavailable collection item" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from collection" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent("1 item could not be restored with Undo.");
    fireEvent.click(undo);
    fireEvent.click(undo);

    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledTimes(2));
    const first = mocks.setItems.mock.calls[0][1] as { requestId: string };
    expect(mocks.setItems.mock.calls[1][1]).toEqual(expect.objectContaining({
      collectionId: privateCollectionId,
      baseMembershipVersion: 4,
      present: true,
      refs: [r2],
    }));
    expect(mocks.setItems.mock.calls[1][1].requestId).not.toBe(first.requestId);
    expect(await screen.findAllByText("1 item restored to Election package.")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "Select Package image" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select unavailable collection item" })).toBeNull();
    expect(mocks.listItems).toHaveBeenCalledOnce();
  });

  it("reloads once and consumes a conflicting remove Undo", async () => {
    const ref = { backend: "r2" as const, id: "private-video" };
    mocks.listItems.mockResolvedValue({ ...detail(), collection: summary("private"), items: [
      { ref, addedAt: "2026-09-22T12:00:00Z", available: true, asset: imageAsset(ref.id, "Package image") },
    ] });
    mocks.setItems
      .mockResolvedValueOnce({
        success: true, collectionId: privateCollectionId, changed: true, replayed: false,
        version: 1, membershipVersion: 4, changedRefs: [ref],
      })
      .mockRejectedValueOnce(new HttpError(409, "Conflict"));
    renderLibrary(`/media/collections/${privateCollectionId}`);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Package image" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from collection" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText(/changed before Undo/)).toBeInTheDocument();
    await waitFor(() => expect(mocks.listItems).toHaveBeenCalledTimes(2));
    expect(mocks.setItems).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("announces and clears collection selection with focus on the last card", async () => {
    renderLibrary(`/media/collections/${collectionId}`);
    const mark = await screen.findByRole("checkbox", { name: "Select unavailable collection item" });
    fireEvent.click(mark);
    expect(screen.getByRole("status")).toHaveTextContent("1 selected");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByRole("status")).toHaveTextContent("No items selected");
    await waitFor(() => expect(screen.getByRole("button", { name: "Unavailable item" })).toHaveFocus());
  });

  it("keeps a failed item removal visible after a blocked exit", async () => {
    let failRemoval!: (reason: Error) => void;
    mocks.setItems.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRemoval = reject; }));
    const { router } = renderLibrary(`/media/collections/${collectionId}`);
    await screen.findByRole("button", { name: "Unavailable item" });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Display" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Unavailable item" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from collection" }));
    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledTimes(1));
    await act(async () => { await router.navigate("/media/collections"); });
    await act(async () => { failRemoval(new Error("Connection lost")); });

    expect(router.state.location.pathname).toBe(`/media/collections/${collectionId}`);
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions: Unavailable item" }));
    const retry = await screen.findByRole("menuitem", { name: "Remove from collection" });
    expect(retry).toBeEnabled();
    expect(retry).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.setItems).toHaveBeenCalledTimes(2));
  });

  it("keeps a failed archive visible after a blocked exit", async () => {
    let failArchive!: (reason: Error) => void;
    mocks.mutate.mockImplementationOnce(() => new Promise((_resolve, reject) => { failArchive = reject; }));
    const { router } = renderLibrary(`/media/collections/${collectionId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Archive collection" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive collection" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    await act(async () => { await router.navigate("/media/collections"); });
    await act(async () => { failArchive(new Error("Connection lost")); });

    expect(router.state.location.pathname).toBe(`/media/collections/${collectionId}`);
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive collection" })).toBeEnabled();
  });

  it("saves personal pins only for the active account", async () => {
    const { router } = renderLibrary();
    const pins = await screen.findAllByRole("button", { name: /Pin Election package/ });
    expect(pins[0]).toHaveAttribute("aria-pressed", "false");
    expect(pins[0]).toHaveTextContent("");
    fireEvent.click(pins[0]);
    await waitFor(() => expect(mocks.savePins).toHaveBeenCalledWith("staff-a", privateCollectionId, true));
    expect(router.state.location.pathname).toBe("/media/collections");
    expect(await screen.findByRole("button", { name: `Unpin Election package` })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /Election packagePrivateCurrent campaign files/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/media/collections/${privateCollectionId}`));
  });

  it("names pins on keyboard focus and shows text when requested", async () => {
    const first = renderLibrary();
    const pin = (await screen.findAllByRole("button", { name: /Pin Election package/ }))[0];
    fireEvent.focus(pin);
    expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent("Pin Election package");
    first.unmount();
    renderLibrary("/media/collections", true, "staff-a", "text");
    expect((await screen.findAllByRole("button", { name: /Pin Election package/ }))[0]).toHaveTextContent("Pin");
  });

  it("does not offer the image library to a staff role that cannot open it", async () => {
    mocks.listItems.mockResolvedValue({ ...detail(), collection: summary("private"), items: [] });
    renderLibrary(`/media/collections/${privateCollectionId}`, false);
    expect(await screen.findByText("This collection is empty")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Browse images" })).toBeNull();
    expect(screen.getByRole("button", { name: "Browse videos" })).toBeEnabled();
  });

  it("does not call a shared collection empty when no items are accessible", async () => {
    mocks.listItems.mockResolvedValue({ ...detail(), collection: { ...summary("all_staff"), itemCount: undefined }, items: [] });
    renderLibrary(`/media/collections/${collectionId}`);
    expect(await screen.findByText("No accessible items to show")).toBeInTheDocument();
    expect(screen.queryByText("This collection is empty")).toBeNull();
  });

  it("can load another shared page when the first has no accessible items", async () => {
    mocks.listItems.mockResolvedValueOnce({ ...detail(), collection: { ...summary("all_staff"), itemCount: undefined },
      items: [], nextCursor: "next-visible-page", hasMore: true })
      .mockResolvedValueOnce({ ...detail(), items: [], nextCursor: null, hasMore: false });
    renderLibrary(`/media/collections/${collectionId}`);
    expect(await screen.findByText("No accessible items to show")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more items" }));
    await waitFor(() => expect(mocks.listItems).toHaveBeenCalledWith("token-a", {
      collectionId, cursor: "next-visible-page", limit: 30,
    }));
  });

  it("releases a stale load-more state when the list filter changes", async () => {
    let releaseStalePage!: (value: unknown) => void;
    const stalePage = new Promise(resolve => { releaseStalePage = resolve; });
    mocks.list.mockImplementation(async (_token: string, query: { scope: MediaCollectionScope; lifecycle: string; cursor?: string }) => {
      if (query.cursor === "active-private-page-2") return stalePage;
      return {
        success: true,
        collections: [summary(query.scope)],
        nextCursor: query.scope === "private" ? `${query.lifecycle}-private-page-2` : null,
        hasMore: query.scope === "private",
      };
    });
    renderLibrary();
    const loadMore = await screen.findByRole("button", { name: "Load more private collections" });
    fireEvent.click(loadMore);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Filter" })).getByRole("button", { name: "Status" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Archived" }));

    expect(await screen.findByRole("button", { name: "Load more private collections" })).toBeEnabled();
    releaseStalePage({ success: true, collections: [], nextCursor: null, hasMore: false });
  });

  it("shows an access-change state instead of an empty library", async () => {
    mocks.list.mockRejectedValue(new HttpError(403, "Forbidden"));
    renderLibrary();
    expect(await screen.findByText(/Your collection access changed/)).toBeInTheDocument();
    expect(screen.queryByText("No active collections")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("filters the loaded scopes without a new list request", async () => {
    renderLibrary();
    expect(await screen.findAllByRole("button", { name: /Pin Election package/ })).toHaveLength(2);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Filter" })).getByRole("button", { name: "Scope" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Private" }));
    expect(screen.getAllByRole("button", { name: /Pin Election package/ })).toHaveLength(1);
    expect(screen.getByText("on this page")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("loads a personal collection view into the canonical URL", async () => {
    mocks.loadViews.mockResolvedValue([{
      id: "archived-shared",
      name: "Archived shared",
      surface: "collections",
      query: "show=archived&scope=all_staff",
    }]);
    const { router } = renderLibrary("/media/collections?scope=private", true, "saved-view-user");
    await screen.findByRole("button", { name: "Filter, 1 applied" });

    fireEvent.click(screen.getByRole("button", { name: "Filter, 1 applied" }));
    fireEvent.click(await within(screen.getByRole("dialog", { name: "Filter" }))
      .findByRole("button", { name: "Archived shared" }));

    await waitFor(() => expect(router.state.location.search)
      .toBe("?show=archived&scope=all_staff&view=archived-shared"));
    expect(mocks.loadViews).toHaveBeenCalledWith("saved-view-user");
    expect(mocks.mutateViews).not.toHaveBeenCalled();
  });

  it.each([1280, 390])("keeps saved-view request counts bounded at %ipx", async (width) => {
    setViewport(width);
    const savedView = {
      id: `archived-shared-${width}`,
      name: "Archived shared",
      surface: "collections" as const,
      query: "show=archived&scope=all_staff",
    };
    mocks.loadViews.mockResolvedValue([savedView]);
    mocks.mutateViews.mockImplementation(async (_userId, mutation) =>
      mutation.type === "add" ? [savedView, mutation.view] : [savedView]);
    const { router } = renderLibrary("/media/collections", true, `collections-count-${width}`);
    await screen.findAllByRole("button", { name: /Pin Election package/ });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.loadViews).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await within(screen.getByRole("dialog", { name: "Filter" }))
      .findByRole("button", { name: "Archived shared" });
    expect(mocks.loadViews).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const display = screen.getByRole("dialog", { name: "Display" });
    expect(within(display).getByRole("button", { name: "Save as view" })).toBeEnabled();
    expect(mocks.loadViews).toHaveBeenCalledOnce();
    fireEvent.click(within(display).getByRole("button", { name: "Save as view" }));
    fireEvent.change(within(display).getByLabelText("Name"), { target: { value: `Active ${width}` } });
    fireEvent.click(within(display).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(mocks.mutateViews).toHaveBeenCalledOnce());
    fireEvent.keyDown(display, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(await within(screen.getByRole("dialog", { name: "Filter" }))
      .findByRole("button", { name: "Archived shared" }));
    await waitFor(() => expect(router.state.location.search)
      .toBe(`?show=archived&scope=all_staff&view=archived-shared-${width}`));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(4));

    expect(mocks.loadViews).toHaveBeenCalledOnce();
    expect(mocks.mutateViews).toHaveBeenCalledOnce();
  });

  it("keeps expanded collection filters and removes a missing view id", async () => {
    const { router } = renderLibrary(
      "/media/collections?show=archived&scope=all_staff&view=missing-view",
      true,
      "missing-view-user",
    );
    await screen.findByRole("button", { name: "Filter, 2 applied" });

    fireEvent.click(screen.getByRole("button", { name: "Filter, 2 applied" }));

    await waitFor(() => expect(router.state.location.search).toBe("?show=archived&scope=all_staff"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Notifications" }))
      .toHaveTextContent("This saved view is no longer available. Current filters were kept."));
    expect(mocks.mutateViews).not.toHaveBeenCalled();
  });

  it("restores the canonical collection filters after Clear all without selection or a write", async () => {
    const { router } = renderLibrary("/media/collections?show=archived&scope=all_staff&asset=r2%3Aimage-a&cursor=stale&view=archived-shared");
    await screen.findByRole("button", { name: "Clear all" });

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    await within(notice).findByRole("button", { name: "Undo" });
    expect(notice).toHaveTextContent("Filters cleared.");
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(router.state.location.search).toBe("?show=archived&scope=all_staff"));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.setItems).not.toHaveBeenCalled();
    expect(mocks.savePins).not.toHaveBeenCalled();
  });

  it("invalidates Clear all Undo after a later collection filter change", async () => {
    const { router } = renderLibrary("/media/collections?show=archived&scope=all_staff");
    fireEvent.click(await screen.findByRole("button", { name: "Clear all" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    await within(notice).findByRole("button", { name: "Undo" });

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Filter" })).getByRole("button", { name: "Status" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Archived" }));

    await waitFor(() => expect(router.state.location.search).toBe("?show=archived"));
    await waitFor(() => expect(within(notice).queryByRole("button", { name: "Undo" })).toBeNull());
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.setItems).not.toHaveBeenCalled();
    expect(mocks.savePins).not.toHaveBeenCalled();
  });

  it("clears a scope filter when only that scope is empty", async () => {
    mocks.list.mockImplementation(async (_token: string, query: { scope: MediaCollectionScope }) => ({
      success: true, collections: query.scope === "private" ? [] : [summary("all_staff")],
      nextCursor: null, hasMore: false,
    }));
    renderLibrary("/media/collections?scope=private");
    expect(await screen.findByText("No collections in this scope")).toBeInTheDocument();
    expect(screen.queryByText("No active collections")).toBeNull();
    expect(screen.queryByText("Create a private collection or one shared with all active staff.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear scope" }));
    expect(await screen.findByRole("button", { name: /Election packageAll staff/ })).toBeVisible();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("returns from detail to the same list filters", async () => {
    const { router } = renderLibrary(`/media/collections/${collectionId}?show=archived&scope=all_staff`);
    fireEvent.click(await screen.findByRole("button", { name: "All collections" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/collections"));
    expect(router.state.location.search).toBe("?show=archived&scope=all_staff");
  });

  it("refreshes a collection Quick Look binary after an external replacement", async () => {
    const ref = { backend: "s3" as const, sourceId: "video-library", id: "private-video" };
    const asset = { id: ref.id, sourceId: ref.sourceId, name: "News update", originalName: "news.mp4", mimeType: "video/mp4",
      kind: "video", sizeBytes: 1024, preview: "download_only", version: 1, fileVersion: "collection-v1",
      description: null, license: null, credit: null, tags: [], rightsStatus: "pending", createdAt: null, updatedAt: null } as SourceMediaAssetSummary;
    const fresh = { ...asset, name: "Corrected collection video", fileVersion: "collection-v2", version: 2 };
    mocks.listItems.mockResolvedValue({ ...detail(), items: [{ ref, asset, available: true, addedAt: "2026-09-29T00:00:00Z" }] });
    mocks.refreshAsset.mockResolvedValue({ success: true, records: [fresh], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary(`/media/collections/${collectionId}`);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^News update, video/ }), { key: "y", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Quick Look: News update" });
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("dialog", { name: "Quick Look: Corrected collection video" })).toBeVisible();
    expect(mocks.refreshAsset).toHaveBeenCalledWith("token-a", { sourceId: ref.sourceId, assetId: ref.id });
  });

  it.each([false, true])("passes the source replacement capability to collection video viewers (%s)", async canReplace => {
    const ref = { backend: "s3" as const, sourceId: "video-library", id: "private-video" };
    const asset = { id: ref.id, sourceId: ref.sourceId, name: "News update", description: null,
      originalName: "news.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 1024,
      preview: "download_only", license: null, credit: null, tags: [], rightsStatus: "pending",
      version: 1, createdAt: null, updatedAt: null } as SourceMediaAssetSummary;
    mocks.listItems.mockResolvedValue({ ...detail(), items: [{ ref, asset, available: true, addedAt: "2026-09-29T00:00:00Z" }] });
    vi.mocked(listMediaSources).mockResolvedValue({ success: true, sources: [{ id: "video-library", label: "Videos", description: "Videos", mediaKind: "video",
      canBrowse: true, canUpload: false, canEditMetadata: true, canRequestProduction: false, canReplace }] });
    renderLibrary(`/media/collections/${collectionId}?asset=s3:video-library:private-video`);
    await waitFor(() => expect(screen.getByLabelText("Replacement capability")).toHaveTextContent(String(canReplace)));
  });

  it("lets a blocked collection viewer keep editing or discard once", async () => {
    const ref = { backend: "s3" as const, sourceId: "video-library", id: "private-video" };
    const asset = { id: ref.id, sourceId: ref.sourceId, name: "News update", description: null,
      originalName: "news.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 1024,
      preview: "download_only", license: null, credit: null, tags: [], rightsStatus: "pending",
      version: 1, createdAt: null, updatedAt: null } as SourceMediaAssetSummary;
    mocks.listItems.mockResolvedValue({ ...detail(), items: [{ ref, asset, available: true,
      addedAt: "2026-09-29T00:00:00Z" }] });
    const { router } = renderLibrary(`/media/collections/${collectionId}?asset=s3:video-library:private-video`);
    await screen.findByText("Video body");
    await waitFor(() => {
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
    });
    await act(async () => { await router.navigate("/media/collections"); });
    expect(screen.getAllByRole("dialog", { name: "Leave with unsaved changes?" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(router.state.location.pathname).toBe(`/media/collections/${collectionId}`);
    await act(async () => { await router.navigate("/media/collections"); });
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/collections"));
  });

  it("closes a later-page viewer and clears its URL on membership reload", async () => {
    const first = { ref: { backend: "r2" as const, id: "first-image" }, available: true as const,
      asset: imageAsset("first-image", "First image"), addedAt: "2026-09-29T00:00:00Z" };
    const second = { ref: { backend: "r2" as const, id: "second-image" }, available: true as const,
      asset: imageAsset("second-image", "Second image"), addedAt: "2026-09-29T00:00:00Z" };
    mocks.listItems.mockImplementation(async (_token: string, query: { cursor?: string }) => ({
      ...detail(), collection: { ...detail().collection, itemCount: 2 },
      items: query.cursor ? [second] : [first],
      nextCursor: query.cursor ? null : "page-2", hasMore: !query.cursor,
    }));
    const { router } = renderLibrary(`/media/collections/${collectionId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Load more items" }));
    const secondButton = await screen.findByRole("button", { name: /^Second image, image/ });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Second image" }));
    fireEvent.click(secondButton);
    expect(await screen.findByRole("dialog", { name: "Second image" })).toBeVisible();
    expect(router.state.location.search).toContain("asset=r2%3Asecond-image");
    fireEvent.click(screen.getByRole("button", { name: "Reload asset" }));
    await waitFor(() => expect(mocks.listItems).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByRole("dialog", { name: "Second image" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Items" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Load more items" }));
    await screen.findByRole("button", { name: /^Second image, image/ });
    expect(screen.queryByRole("dialog", { name: "Second image" })).toBeNull();
  });

  it("clears an off-page asset URL after the first membership page loads", async () => {
    const first = { ref: { backend: "r2" as const, id: "first-image" }, available: true as const,
      asset: imageAsset("first-image", "First image"), addedAt: "2026-09-29T00:00:00Z" };
    mocks.listItems.mockResolvedValue({ ...detail(), items: [first], nextCursor: "page-2", hasMore: true });
    const { router } = renderLibrary(`/media/collections/${collectionId}?asset=r2%3Asecond-image`);
    expect(await screen.findByRole("heading", { name: "Items" })).toBeVisible();
    await waitFor(() => expect(router.state.location.search).toBe(""));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Items" })).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.listItems).toHaveBeenCalledOnce();
  });
});

it("uses a newer server asset after a collection reload", () => {
  const ref = { backend: "r2" as const, id: "image-a" };
  const asset = (version: number) => ({ id: ref.id, version, name: `Version ${version}` }) as MediaAssetSummary;
  const items = [{ ref, available: true as const, asset: asset(3), addedAt: "2026-09-29T00:00:00Z" }];
  const overrides = new Map([["r2:image-a", asset(2)]]);
  expect(resolveCollectionAssetOverrides(items, overrides)[0]).toMatchObject({ asset: { name: "Version 3" } });
  expect(resolveCollectionAssetOverrides([{ ...items[0], asset: asset(1) }], overrides)[0])
    .toMatchObject({ asset: { name: "Version 2" } });
});


describe("collection permalinks", () => {
  it("rejects malformed collection IDs before requesting details", async () => {
    renderLibrary("/media/collections/not-a-collection-id");
    await screen.findByText("Collection unavailable");
    expect(mocks.listItems).not.toHaveBeenCalled();
  });

  it("copies an internal link without changing visibility", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
    try {
      renderLibrary(`/media/collections/${collectionId}`);
      fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
      fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/media/collections/${collectionId}`));
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(mocks.setItems).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});


it.each([403, 404])("hides collection details when its link is unavailable (%s)", async status => {
  mocks.listItems.mockRejectedValue(new HttpError(status, "Private collection name"));
  renderLibrary(`/media/collections/${collectionId}`);
  expect(await screen.findByText("This file is unavailable or you do not have access to it.")).toBeInTheDocument();
  expect(screen.queryByText("Private collection name")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
});
