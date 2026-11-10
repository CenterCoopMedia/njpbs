import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createContext, useContext, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { MediaFavoritesLibrary } from "../src/routes/MediaFavoritesLibrary";
import { HttpError, type MediaAssetSummary } from "../src/lib/functions";
import type { MediaFavoriteRef } from "../src/lib/media-favorites";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";
import { mediaDisplayStorageKey } from "../src/lib/media-display";
import { mediaTabCountsRevision } from "../src/lib/media-session-cache";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
  batch: vi.fn(),
  listSources: vi.fn(),
  posterRead: vi.fn(),
  loadViews: vi.fn(),
  mutateViews: vi.fn(),
  refreshAsset: vi.fn(),
}));

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

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

vi.mock("../src/lib/media-favorites", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/media-favorites")>()),
  listMediaFavorites: (...args: unknown[]) => mocks.list(...args),
  setMediaFavorite: (...args: unknown[]) => mocks.set(...args),
  setMediaFavorites: (...args: unknown[]) => mocks.batch(...args),
}));
vi.mock("../src/lib/source-media", () => ({
  listMediaSources: (...args: unknown[]) => mocks.listSources(...args),
  listSourceMedia: (...args: unknown[]) => mocks.refreshAsset(...args),
}));
vi.mock("../src/lib/saved-media-view-store", () => ({
  loadMediaLibraryViews: (...args: unknown[]) => mocks.loadViews(...args),
  mutateMediaLibraryViews: (...args: unknown[]) => mocks.mutateViews(...args),
}));
vi.mock("../src/lib/use-media-categories", () => ({
  useMediaCategories: () => ({ state: { status: "ready", categories: [] }, reload: vi.fn() }),
}));
vi.mock("../src/routes/SourceMediaLibrary", () => ({
  VideoViewerBody: ({ asset, canReplace }: { asset: SourceMediaAssetSummary; canReplace?: boolean }) => <section>
    <output aria-label="Replacement capability">{String(canReplace === true)}</output>
    <aside aria-label="Video details">
      <h3>S3 inspector {asset.sourceId}/{asset.id}</h3>
    </aside>
  </section>,
  sharePosterRead: (...args: unknown[]) => mocks.posterRead(...args),
}));

const r2Asset: MediaAssetSummary = {
  id: "same-id",
  name: "Station image",
  originalName: "station.png",
  category: "news",
  categories: ["news"],
  tags: [],
  description: null,
  altText: null,
  license: "NJ PBS owned",
  credit: null,
  mimeType: "image/png",
  kind: "image",
  sizeBytes: 1_024,
  width: 640,
  height: 360,
  url: "https://media.example.test/station.png",
  source: "upload",
  lifecycle: "active",
  version: 1,
  etag: '"media.same-id.1"',
  createdAt: "2026-09-22T12:00:00.000Z",
  createdBy: "user-a",
  updatedAt: "2026-09-22T12:00:00.000Z",
  updatedBy: "user-a",
};

const s3Asset: SourceMediaAssetSummary = {
  id: "same-id",
  sourceId: "archive",
  name: "Archive video",
  description: null,
  originalName: "archive.mp4",
  mimeType: "video/mp4",
  kind: "video",
  sizeBytes: 2_048,
  preview: "browser",
  license: null,
  credit: null,
  tags: [],
  rightsStatus: "pending",
  version: 1,
  createdAt: null,
  updatedAt: null,
};
const documentAsset: MediaAssetSummary = {
  ...r2Asset,
  id: "document-one",
  name: "Station document",
  originalName: "station.pdf",
  kind: "document",
  mimeType: "application/pdf",
  url: "https://media.example.test/station.pdf",
};

const accountContext = createContext("user-a");

function AccountLibrary() {
  const userId = useContext(accountContext);
  return <MediaFavoritesLibrary
    principal={{ id: userId, grants: [{ role: "super_admin" }] }}
    userId={userId}
    getIdToken={async () => `${userId}-token`}
    categoryRegistry={{ status: "ready", categories: [] }}
    renderR2Inspector={() => null}
  />;
}

function renderLibrary(
  userId = "user-a",
  renderR2Inspector: ComponentProps<typeof MediaFavoritesLibrary>["renderR2Inspector"] = ({ asset, onClose }) => <section>
    <h3>R2 inspector {asset.id}</h3>
    <button onClick={onClose}>Close R2 inspector</button>
  </section>,
  initialEntry = "/media/favorites",
  withNotice = false,
) {
  const library = <MediaFavoritesLibrary
    principal={{ id: userId, grants: [{ role: "super_admin" }] }}
    userId={userId}
    getIdToken={async () => `${userId}-token`}
    categoryRegistry={{ status: "ready", categories: [] }}
    renderR2Inspector={renderR2Inspector}
  />;
  function FavoriteRoute() {
    const location = useLocation();
    return withNotice
      ? <SuccessNoticeProvider routeKey={`${userId}:${location.key}`}>{library}</SuccessNoticeProvider>
      : library;
  }
  const router = createMemoryRouter([{
    path: "/media/favorites",
    element: <FavoriteRoute />,
  }], { initialEntries: [initialEntry] });
  return { ...render(<RouterProvider router={router} />), router };
}

beforeEach(() => {
  vi.resetAllMocks();
  setViewport(1280);
  localStorage.removeItem(mediaDisplayStorageKey("favorites"));
  mocks.list.mockResolvedValue({
    success: true,
    records: [
      { ref: { backend: "r2", id: "same-id" }, createdAt: "2026-09-22T12:00:00.000Z", available: true, asset: r2Asset },
      { ref: { backend: "r2", id: "document-one" }, createdAt: "2026-09-22T11:30:00.000Z", available: true, asset: documentAsset },
      { ref: { backend: "s3", sourceId: "archive", id: "same-id" }, createdAt: "2026-09-22T11:00:00.000Z", available: true, asset: s3Asset },
      { ref: { backend: "s3", sourceId: "archive", id: "gone" }, createdAt: "2026-09-22T10:00:00.000Z", available: false },
    ],
    nextCursor: null,
    hasMore: false,
  });
  mocks.listSources.mockResolvedValue({
    sources: [{ id: "archive", label: "Archive", description: "Archive", mediaKind: "video", canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: false }],
  });
  mocks.set.mockImplementation(async (_token: string, ref: MediaFavoriteRef, favorite: boolean) => ({
    success: true, ref, favorite, changed: true,
  }));
  mocks.posterRead.mockReturnValue({ promise: Promise.resolve({ url: "https://media.example.test/poster.jpg" }), release: vi.fn() });
  mocks.loadViews.mockResolvedValue([]);
  mocks.mutateViews.mockResolvedValue([]);
  mocks.refreshAsset.mockResolvedValue({ success: true, records: [], nextCursor: null, hasMore: false, total: 0 });
});

describe("MediaFavoritesLibrary", () => {
  it("aligns mixed list facts with one header and gives unavailable entries selectable rows", async () => {
    localStorage.setItem(mediaDisplayStorageKey("favorites"), JSON.stringify({ layout: "list" }));
    renderLibrary();
    const grid = await screen.findByRole("grid", { name: "Favorite media" });
    const headings = grid.querySelectorAll('[role="columnheader"][data-column]');
    const videoRow = within(grid).getByRole("row", { name: /Archive video/ });
    expect([...headings].map(cell => cell.getAttribute("data-column")))
      .toEqual([...videoRow.querySelectorAll('[role="gridcell"][data-column]')].map(cell => cell.getAttribute("data-column")));
    expect(videoRow.querySelector('[data-column="size"]')).toHaveTextContent("0.0 MB");
    expect(videoRow.querySelector('[data-column="dimensions"]')).toHaveTextContent("None");
    const unavailable = within(grid).getByRole("row", { name: /Unavailable favorite/ });
    expect(unavailable).toHaveAttribute("aria-selected", "false");
    fireEvent.click(within(unavailable).getByRole("checkbox", { name: "Select unavailable favorite" }));
    expect(unavailable).toHaveAttribute("aria-selected", "true");
  });

  it("steps Quick Look across backends and reads a ready video poster only on demand", async () => {
    mocks.list.mockResolvedValueOnce({ success: true, records: [
      { ref: { backend: "r2", id: "same-id" }, createdAt: r2Asset.createdAt, available: true, asset: r2Asset },
      { ref: { backend: "r2", id: "document-one" }, createdAt: documentAsset.createdAt, available: true, asset: documentAsset },
      { ref: { backend: "s3", sourceId: "archive", id: "same-id" }, createdAt: "2026-09-22T11:00:00.000Z", available: true,
        asset: { ...s3Asset, viewingCopy: { state: "ready" } } },
    ], nextCursor: null, hasMore: false });
    renderLibrary();
    const image = await screen.findByRole("button", { name: /^Station image, image/ });
    fireEvent.keyDown(image, { key: "y", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Quick Look: Station image" })).toBeInTheDocument();
    expect(mocks.posterRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next item" }));
    expect(screen.getByRole("dialog", { name: "Quick Look: Station document" })).toBeInTheDocument();
    expect(mocks.posterRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next item" }));
    expect(screen.getByRole("dialog", { name: "Quick Look: Archive video" })).toBeInTheDocument();
    await waitFor(() => expect(mocks.posterRead).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Close Quick Look" }));
    expect(screen.queryByRole("dialog", { name: /Quick Look:/ })).toBeNull();
  });
  it("restores the full video ref from the URL and filters only this page", async () => {
    const { router } = renderLibrary("user-a", undefined,
      "/media/favorites?kind=video&asset=s3%3Aarchive%3Asame-id");
    expect(await screen.findByRole("dialog", { name: "Archive video" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Archive video, video/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Station image, image/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit filter Type: Videos" })).toBeInTheDocument();
    expect(screen.getByText("on this page")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledOnce();

    await act(async () => router.navigate("/media/favorites?kind=image&asset=r2%3Asame-id"));
    expect(screen.getByRole("dialog", { name: "Station image" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archive video, video/ })).toBeNull();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("clears Type when its selected filter option is unchecked", async () => {
    const { router } = renderLibrary("user-a", undefined, "/media/favorites?kind=video");
    await screen.findByRole("button", { name: /^Archive video, video/ });
    fireEvent.click(screen.getByRole("button", { name: "Filter, 1 applied" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Filter" })).getByRole("button", { name: "Type" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Videos" }));
    await waitFor(() => expect(router.state.location.search).toBe("") );
    expect(screen.getByRole("button", { name: /^Station image, image/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("loads a personal view into the canonical URL and applies its display settings", async () => {
    mocks.loadViews.mockResolvedValue([{
      id: "video-review",
      name: "Video review",
      surface: "favorites",
      query: "kind=video",
      display: {
        layout: "list",
        thumbnail: "s",
        density: "compact",
        fields: { type: true, category: false, size: true, dimensions: true, updated: true, tags: false },
      },
    }]);
    const { router } = renderLibrary("saved-view-user", undefined,
      "/media/favorites?kind=image&asset=r2%3Asame-id", true);
    expect(await screen.findByRole("dialog", { name: "Station image" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filter, 1 applied" }));
    fireEvent.click(await within(screen.getByRole("dialog", { name: "Filter" }))
      .findByRole("button", { name: "Video review" }));

    await waitFor(() => expect(router.state.location.search).toBe("?kind=video&view=video-review"));
    expect(screen.queryByRole("dialog", { name: "Station image" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(mediaDisplayStorageKey("favorites")) ?? "null"))
      .toEqual(expect.objectContaining({ layout: "list", thumbnail: "s", density: "compact" }));
    expect(mocks.loadViews).toHaveBeenCalledWith("saved-view-user");
    expect(mocks.mutateViews).not.toHaveBeenCalled();
  });

  it.each([1280, 390])("keeps saved-view request counts bounded at %ipx", async (width) => {
    setViewport(width);
    const savedView = {
      id: `video-review-${width}`,
      name: "Video review",
      surface: "favorites" as const,
      query: "kind=video",
    };
    mocks.loadViews.mockResolvedValue([savedView]);
    mocks.mutateViews.mockImplementation(async (_userId, mutation) =>
      mutation.type === "add" ? [savedView, mutation.view] : [savedView]);
    const { router } = renderLibrary(`favorites-count-${width}`);
    await screen.findByRole("button", { name: /^Station image, image/ });
    await waitFor(() => expect(mocks.listSources).toHaveBeenCalledOnce());
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.loadViews).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    await within(screen.getByRole("dialog", { name: "Filter" }))
      .findByRole("button", { name: "Video review" });
    expect(mocks.loadViews).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const display = screen.getByRole("dialog", { name: "Display" });
    expect(within(display).getByRole("button", { name: "Save as view" })).toBeEnabled();
    expect(mocks.loadViews).toHaveBeenCalledOnce();
    fireEvent.click(within(display).getByRole("button", { name: "Save as view" }));
    fireEvent.change(within(display).getByLabelText("Name"), { target: { value: `Default ${width}` } });
    fireEvent.click(within(display).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(mocks.mutateViews).toHaveBeenCalledOnce());
    fireEvent.keyDown(display, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(await within(screen.getByRole("dialog", { name: "Filter" }))
      .findByRole("button", { name: "Video review" }));
    await waitFor(() => expect(router.state.location.search)
      .toBe(`?kind=video&view=video-review-${width}`));

    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.listSources).toHaveBeenCalledOnce();
    expect(mocks.loadViews).toHaveBeenCalledOnce();
    expect(mocks.mutateViews).toHaveBeenCalledOnce();
  });

  it("keeps expanded favorite filters and removes a missing view id", async () => {
    const { router } = renderLibrary("missing-view-user", undefined,
      "/media/favorites?kind=video&view=missing-view", true);
    await screen.findByRole("button", { name: /^Archive video, video/ });

    fireEvent.click(screen.getByRole("button", { name: "Filter, 1 applied" }));

    await waitFor(() => expect(router.state.location.search).toBe("?kind=video"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Notifications" }))
      .toHaveTextContent("This saved view is no longer available. Current filters were kept."));
    expect(mocks.mutateViews).not.toHaveBeenCalled();
  });

  it("removes the active view reference quietly when that view is deleted", async () => {
    mocks.loadViews.mockResolvedValueOnce([{
      id: "video-review", name: "Video review", surface: "favorites", query: "kind=video",
    }]);
    mocks.mutateViews.mockResolvedValueOnce([]);
    const { router } = renderLibrary("delete-view-user", undefined,
      "/media/favorites?kind=video&view=video-review", true);
    await screen.findByRole("button", { name: /^Archive video, video/ });

    fireEvent.click(screen.getByRole("button", { name: "Filter, 1 applied" }));
    fireEvent.click(await within(screen.getByRole("dialog", { name: "Filter" }))
      .findByRole("button", { name: "Delete saved view Video review" }));

    await waitFor(() => expect(router.state.location.search).toBe("?kind=video"));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.getByRole("region", { name: "Notifications" }))
      .not.toHaveTextContent("no longer available");
    expect(mocks.mutateViews).toHaveBeenCalledOnce();
  });

  it("resets saved-view filters without changing display preferences", async () => {
    localStorage.setItem(mediaDisplayStorageKey("favorites"), JSON.stringify({ layout: "list", density: "compact" }));
    const { router } = renderLibrary("reset-view-user", undefined, "/media/favorites?kind=video");
    await screen.findByRole("grid", { name: "Favorite media" });

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Display" }))
      .getByRole("button", { name: "Reset filters to default" }));

    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(JSON.parse(localStorage.getItem(mediaDisplayStorageKey("favorites")) ?? "null"))
      .toEqual(expect.objectContaining({ layout: "list", density: "compact" }));
  });

  it("restores the canonical Type URL after Clear all without restoring selection or writing", async () => {
    const { router } = renderLibrary("user-a", undefined,
      "/media/favorites?kind=video&asset=s3%3Aarchive%3Asame-id&cursor=stale&view=video-view", true);
    expect(await screen.findByRole("dialog", { name: "Archive video" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    await within(notice).findByRole("button", { name: "Undo" });
    expect(notice).toHaveTextContent("Filters cleared.");
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(router.state.location.search).toBe("?kind=video"));
    expect(screen.queryByRole("dialog", { name: "Archive video" })).toBeNull();
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it("invalidates Clear all Undo after a later Type change", async () => {
    const { router } = renderLibrary("user-a", undefined, "/media/favorites?kind=video", true);
    await screen.findByRole("button", { name: /^Archive video, video/ });
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    await within(notice).findByRole("button", { name: "Undo" });

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Filter" })).getByRole("button", { name: "Type" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Images" }));

    await waitFor(() => expect(router.state.location.search).toBe("?kind=image"));
    await waitFor(() => expect(within(notice).queryByRole("button", { name: "Undo" })).toBeNull());
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it("refreshes a favorite Quick Look binary after an external replacement", async () => {
    const first = { ...s3Asset, sourceId: "video-library", fileVersion: "favorite-v1", viewingCopy: { state: "ready" as const } };
    const fresh = { ...first, name: "Corrected favorite", fileVersion: "favorite-v2", version: first.version + 1 };
    mocks.list.mockResolvedValue({ success: true, records: [{ ref: { backend: "s3", sourceId: first.sourceId, id: first.id },
      available: true, createdAt: "2026-09-22T11:00:00Z", asset: first }], nextCursor: null, hasMore: false });
    mocks.refreshAsset.mockResolvedValue({ success: true, records: [fresh], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary(); fireEvent.keyDown(await screen.findByRole("button", { name: /^Archive video, video/ }), { key: "y", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Quick Look: Archive video" });
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("dialog", { name: "Quick Look: Corrected favorite" })).toBeVisible();
    expect(mocks.refreshAsset).toHaveBeenCalledWith("user-a-token", { sourceId: first.sourceId, assetId: first.id });
    await waitFor(() => expect(mocks.posterRead).toHaveBeenCalledWith(expect.objectContaining({ fileVersion: fresh.fileVersion }), expect.any(Function)));
  });

  it.each([false, true])("passes the source replacement capability to favorite video viewers (%s)", async canReplace => {
    mocks.list.mockResolvedValue({ success: true, records: [{ ref: { backend: "s3", sourceId: "video-library", id: s3Asset.id },
      available: true, createdAt: "2026-09-22T11:00:00Z", asset: { ...s3Asset, sourceId: "video-library" } }], nextCursor: null, hasMore: false });
    mocks.listSources.mockResolvedValue({ sources: [{ id: "video-library", label: "Videos", description: "Videos", mediaKind: "video",
      canBrowse: true, canUpload: false, canEditMetadata: true, canRequestProduction: false, canReplace }] });
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /^Archive video, video/ }));
    await waitFor(() => expect(screen.getByLabelText("Replacement capability")).toHaveTextContent(String(canReplace)));
  });

  it("keeps one full viewer while stepping through image, document and video", async () => {
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: /^Station image, image/ }));
    const viewer = screen.getByRole("dialog", { name: "Station image" });
    expect(screen.getByRole("region", { name: "Image viewer" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(screen.getByRole("dialog", { name: "Station document" })).toBe(viewer);
    expect(screen.getByRole("region", { name: "Document viewer" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(screen.getByRole("dialog", { name: "Archive video" })).toBe(viewer);
    expect(screen.getByRole("region", { name: "Video viewer" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "S3 inspector archive/same-id" })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("removes every successful full ref in one batch and keeps each failure selected", async () => {
    mocks.batch.mockResolvedValue({ success: true, favorite: false, results: [
      { ref: { backend: "r2", id: "same-id" }, favorite: false, changed: false },
      { ref: { backend: "s3", sourceId: "archive", id: "same-id" }, error: "Access changed", status: 403 },
      { ref: { backend: "s3", sourceId: "archive", id: "gone" }, favorite: false, changed: true },
    ] });
    renderLibrary();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Station image" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Archive video" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select unavailable favorite" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from favorites" }));

    await waitFor(() => expect(mocks.batch).toHaveBeenCalledWith("user-a-token", [
      { backend: "r2", id: "same-id" },
      { backend: "s3", sourceId: "archive", id: "same-id" },
      { backend: "s3", sourceId: "archive", id: "gone" },
    ], false));
    expect(mocks.batch).toHaveBeenCalledOnce();
    expect(await screen.findByText(/S3\/archive\/same-id: Access changed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Station image, image/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Archive video, video/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Favorite selection" })).toHaveTextContent("1 of 100 selected");
    expect(screen.getByText(/1 favorite was removed\./)).toBeInTheDocument();
  });

  it("uses a singular notice when one selected favorite changes", async () => {
    mocks.batch.mockResolvedValue({ success: true, favorite: false, results: [
      { ref: { backend: "r2", id: "same-id" }, favorite: false, changed: true },
    ] });
    renderLibrary();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Station image" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from favorites" }));
    expect(await screen.findByText("1 favorite was removed.")).toBeInTheDocument();
  });

  it("undoes one confirmed removal and leaves an unavailable removal without Undo", async () => {
    renderLibrary("user-a", undefined, "/media/favorites", true);
    fireEvent.click((await screen.findAllByRole("button", { name: "Remove from favorites: Unavailable favorite" }))[0]);
    expect(await screen.findByText(/Unavailable favorite was removed/)).toHaveTextContent("cannot be restored");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove from favorites: Station image" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    expect(notice).toHaveTextContent("Station image was removed from your favorites.");
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith("user-a-token", { backend: "r2", id: "same-id" }, true));
    expect(mocks.set).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole("button", { name: /^Station image, image/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("does not insert an undone favorite from page one into page two", async () => {
    mocks.list.mockImplementation(async (_token: string, query: { cursor?: string }) => query.cursor
      ? { success: true, records: [{ ref: { backend: "s3", sourceId: "archive", id: "same-id" },
        createdAt: "2026-09-22T11:00:00.000Z", available: true, asset: s3Asset }], nextCursor: null, hasMore: false }
      : { success: true, records: [{ ref: { backend: "r2", id: "same-id" },
        createdAt: r2Asset.createdAt, available: true, asset: r2Asset }], nextCursor: "page-two", hasMore: true });
    renderLibrary("user-a", undefined, "/media/favorites", true);
    fireEvent.click(await screen.findByRole("button", { name: "Remove from favorites: Station image" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    await within(notice).findByRole("button", { name: "Undo" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("button", { name: /^Archive video, video/ })).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith("user-a-token", { backend: "r2", id: "same-id" }, true));
    expect(screen.queryByRole("button", { name: /^Station image, image/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Archive video, video/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it.each([1280, 390])("bulk Undo restores only confirmed changed and available references in one request at %ipx", async width => {
    setViewport(width);
    mocks.batch.mockImplementation(async (_token: string, refs: MediaFavoriteRef[], favorite: boolean) => ({
      success: true, favorite, results: refs.map(ref => ({ ref, favorite,
        changed: favorite || ref.backend === "s3" && ref.id === "gone" || ref.backend === "r2" })),
    }));
    renderLibrary("user-a", undefined, "/media/favorites", true);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Station image" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Archive video" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select unavailable favorite" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from favorites" }));

    const notice = await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => expect(notice).toHaveTextContent("2 favorites were removed."));
    expect(notice).toHaveTextContent("S3/archive/gone cannot be restored.");
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledTimes(2));
    expect(mocks.batch).toHaveBeenLastCalledWith("user-a-token", [{ backend: "r2", id: "same-id" }], true);
    expect(await screen.findByRole("button", { name: /^Station image, image/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("reports a 404 when an Undo target becomes unavailable", async () => {
    mocks.set.mockImplementation(async (_token: string, ref: MediaFavoriteRef, favorite: boolean) => {
      if (favorite) throw new HttpError(404, "Media unavailable");
      return { success: true, ref, favorite, changed: true };
    });
    renderLibrary("user-a", undefined, "/media/favorites", true);
    fireEvent.click(await screen.findByRole("button", { name: "Remove from favorites: Station image" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    fireEvent.click(await within(notice).findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(notice).toHaveTextContent("Station image is no longer available and could not be restored."));
    expect(screen.queryByRole("button", { name: /^Station image, image/ })).toBeNull();
    expect(mocks.set).toHaveBeenCalledTimes(2);
  });

  it("names each failed bulk Undo target while restoring the other confirmed refs", async () => {
    mocks.batch.mockImplementation(async (_token: string, refs: MediaFavoriteRef[], favorite: boolean) => ({
      success: true, favorite, results: refs.map(ref => favorite && ref.id === "document-one"
        ? { ref, error: "Media unavailable", status: 404 }
        : { ref, favorite, changed: true }),
    }));
    renderLibrary("user-a", undefined, "/media/favorites", true);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Station image" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Station document" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from favorites" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    fireEvent.click(await within(notice).findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(notice).toHaveTextContent("Station document could not be restored."));
    expect(mocks.batch).toHaveBeenLastCalledWith("user-a-token", [
      { backend: "r2", id: "same-id" }, { backend: "r2", id: "document-one" },
    ], true);
    expect(await screen.findByRole("button", { name: /^Station image, image/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Station document, document/ })).toBeNull();
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("selects a favorite from its More menu", async () => {
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "More actions: Station image" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    expect(screen.getByRole("checkbox", { name: "Select Station image" })).toBeChecked();
  });

  it("uses context and selected-card menus for the matching actions", async () => {
    renderLibrary();
    const image = await screen.findByRole("button", { name: /^Station image, image/ });
    fireEvent.contextMenu(image);
    expect(screen.getByRole("menuitem", { name: "Quick Look" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Station image" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Archive video" }));
    fireEvent.click(screen.getAllByRole("button", { name: "More actions: 2 items" })[0]);
    expect(screen.getByRole("menuitem", { name: "Remove from favorites" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Quick Look" })).toBeNull();
  });

  it("locks selected-card actions while the viewer has unsaved edits", async () => {
    renderLibrary("user-a", ({ asset, onDirtyChange }) => <section>
      <h3>R2 inspector {asset.id}</h3>
      <button onClick={() => onDirtyChange(true)}>Edit metadata</button>
    </section>);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Station image" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Station document" }));
    fireEvent.click(screen.getByRole("button", { name: /^Station image, image/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
    fireEvent.click(screen.getAllByRole("button", { name: "More actions: 2 items" })[0]);
    expect(screen.getByRole("menuitem", { name: "Clear selection" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove from favorites" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Add to collection" })).toBeNull();
  });

  it("announces selection and restores focus when the bar is cleared", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: /^Station image, image/ });
    const checkbox = screen.getByRole("checkbox", { name: "Select Station image" });
    fireEvent.click(checkbox);
    expect(document.querySelector(".media-selection-status")).toHaveTextContent("1 selected");
    fireEvent.click(within(screen.getByRole("group", { name: "Favorite selection" })).getByRole("button", { name: "Clear selection" }));
    await waitFor(() => expect(document.querySelector(".media-selection-status")).toHaveTextContent("No items selected"));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("shows Updated as an always-shown list field", async () => {
    localStorage.setItem(mediaDisplayStorageKey("favorites"), JSON.stringify({ layout: "list" }));
    renderLibrary();
    await screen.findByRole("grid", { name: "Favorite media" });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const updated = screen.getByRole("checkbox", { name: "Updated" });
    expect(updated).toBeChecked();
    expect(updated).toBeDisabled();
    expect(screen.getByText("Always shown in list")).toBeInTheDocument();
  });

  it("marks tab counts stale after an ambiguous batch failure", async () => {
    mocks.batch.mockRejectedValueOnce(new Error("Connection lost"));
    const revision = mediaTabCountsRevision();
    renderLibrary();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Station image" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from favorites" }));
    expect(await screen.findByText("Connection lost")).toBeInTheDocument();
    expect(mediaTabCountsRevision()).toBeGreaterThan(revision);
  });

  it("keeps equal backend ids distinct and opens the matching existing inspector", async () => {
    renderLibrary();

    expect(await screen.findByRole("button", { name: /^Station image, image/ })).toBeEnabled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith("user-a-token", { cursor: undefined, limit: 24 });
    await waitFor(() => expect(mocks.listSources).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: /^Station image, image/ }));
    expect(screen.getByRole("heading", { name: "R2 inspector same-id" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close R2 inspector" }));

    fireEvent.click(screen.getByRole("button", { name: /^Archive video, video/ }));
    expect(screen.getByRole("heading", { name: "S3 inspector archive/same-id" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Video details" })).toBeInTheDocument();
  });

  it("removes an unavailable own reference without opening an asset", async () => {
    renderLibrary();
    expect(await screen.findByRole("checkbox", { name: "Select unavailable favorite" })).toHaveAttribute("tabindex", "-1");
    const removeButtons = await screen.findAllByRole("button", { name: "Remove from favorites: Unavailable favorite" });
    expect(removeButtons[0]).toHaveAttribute("tabindex", "-1");
    fireEvent.click(removeButtons[0]);

    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith(
      "user-a-token",
      { backend: "s3", sourceId: "archive", id: "gone" },
      false,
    ));
    expect(await screen.findByText("Favorite removed")).toBeInTheDocument();
    expect(screen.queryByText("This saved video is no longer available to this account.")).toBeNull();
  });

  it("confirms before removing the favorite for an inspector with unsaved edits", async () => {
    const { router } = renderLibrary("user-a", ({ asset, favoriteControl, onDirtyChange }) => <section>
      <h3>R2 inspector {asset.id}</h3>
      <button onClick={() => onDirtyChange(true)}>Edit metadata</button>
      {favoriteControl}
    </section>);
    fireEvent.click(await screen.findByRole("button", { name: /^Station image, image/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from favorites: Station image" }).at(-1)!);

    expect(screen.getByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    expect(mocks.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("heading", { name: "R2 inspector same-id" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove from favorites: Station image" }).at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith(
      "user-a-token",
      { backend: "r2", id: "same-id" },
      false,
    ));
    expect(screen.queryByRole("heading", { name: "R2 inspector same-id" })).toBeNull();
    expect(router.state.location.search).not.toContain("asset=");
  });

  it("does not reopen a dirty viewer after a failed confirmed removal", async () => {
    mocks.set.mockRejectedValueOnce(new Error("Write failed"));
    const { router } = renderLibrary("user-a", ({ asset, favoriteControl, onDirtyChange }) => <section>
      <h3>R2 inspector {asset.id}</h3>
      <button onClick={() => onDirtyChange(true)}>Edit metadata</button>
      {favoriteControl}
    </section>);
    fireEvent.click(await screen.findByRole("button", { name: /^Station image, image/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from favorites: Station image" }).at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByText("The favorite could not be removed. Try again.")).toBeInTheDocument();
    expect(router.state.location.search).not.toContain("asset=");
    await act(async () => router.navigate("/media/favorites?kind=image"));
    expect(screen.queryByRole("dialog", { name: "Station image" })).toBeNull();
  });

  it("confirms before closing an R2 inspector with unsaved edits", async () => {
    renderLibrary("user-a", ({ asset, onDirtyChange }) => <section>
      <h3>R2 inspector {asset.id}</h3>
      <button onClick={() => onDirtyChange(true)}>Edit metadata</button>
    </section>);
    fireEvent.click(await screen.findByRole("button", { name: /^Station image, image/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    expect(screen.getByText("Unsaved image changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("heading", { name: "R2 inspector same-id" })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("heading", { name: "R2 inspector same-id" })).toBeNull();
  });

  it("confirms before switching away from a favorite with unsaved edits", async () => {
    renderLibrary("user-a", ({ asset, onDirtyChange }) => <section>
      <h3>R2 inspector {asset.id}</h3>
      <button onClick={() => onDirtyChange(true)}>Edit metadata</button>
    </section>);
    fireEvent.click(await screen.findByRole("button", { name: /^Station image, image/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
    fireEvent.click(screen.getByRole("button", { name: /^Archive video, video/ }));

    expect(screen.getByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("heading", { name: "R2 inspector same-id" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Archive video, video/ }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(screen.getByRole("heading", { name: "S3 inspector archive/same-id" })).toBeInTheDocument();
  });

  it("locks inspector editing while favorite removal is pending", async () => {
    const removal = deferred<{ success: true; ref: MediaFavoriteRef; favorite: false; changed: true }>();
    mocks.set.mockReturnValueOnce(removal.promise);
    renderLibrary("user-a", ({ asset, canEdit, favoriteControl }) => <section>
      <h3>R2 inspector {asset.id}</h3>
      <button disabled={!canEdit}>Edit metadata</button>
      {favoriteControl}
    </section>);
    fireEvent.click(await screen.findByRole("button", { name: /^Station image, image/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove from favorites: Station image" }).at(-1)!);

    await waitFor(() => expect(mocks.set).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Edit metadata" })).toBeDisabled();
    await act(async () => removal.resolve({
      success: true,
      ref: { backend: "r2", id: "same-id" },
      favorite: false,
      changed: true,
    }));
    expect(screen.queryByRole("heading", { name: "R2 inspector same-id" })).toBeNull();
  });

  it("releases batch controls when the account changes during a request", async () => {
    const removal = deferred<{ success: true; favorite: false; results: [] }>();
    mocks.batch.mockReturnValueOnce(removal.promise);
    const router = createMemoryRouter([{
      path: "/media/favorites",
      element: <AccountLibrary />,
    }], { initialEntries: ["/media/favorites"] });
    const view = render(<accountContext.Provider value="user-a">
      <RouterProvider router={router} />
    </accountContext.Provider>);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Station image" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from favorites" }));
    await waitFor(() => expect(mocks.batch).toHaveBeenCalledOnce());

    view.rerender(<accountContext.Provider value="user-b">
      <RouterProvider router={router} />
    </accountContext.Provider>);
    expect(await screen.findByRole("checkbox", { name: "Select unavailable favorite" })).toBeEnabled();
    await act(async () => removal.resolve({ success: true, favorite: false, results: [] }));
    expect(screen.getByRole("checkbox", { name: "Select unavailable favorite" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "More actions: Station image" })).toBeEnabled();
  });

  it("does not send the prior account cursor after an account switch", async () => {
    mocks.list.mockResolvedValueOnce({
      success: true,
      records: [],
      nextCursor: "user-a-page-2",
      hasMore: true,
    });
    const router = createMemoryRouter([{
      path: "/media/favorites",
      element: <AccountLibrary />,
    }], { initialEntries: ["/media/favorites"] });
    const view = render(<accountContext.Provider value="user-a">
      <RouterProvider router={router} />
    </accountContext.Provider>);
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(
      "user-a-token",
      { cursor: "user-a-page-2", limit: 24 },
    ));

    view.rerender(<accountContext.Provider value="user-b">
      <RouterProvider router={router} />
    </accountContext.Provider>);

    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(
      "user-b-token",
      { cursor: undefined, limit: 24 },
    ));
    expect(mocks.list).not.toHaveBeenCalledWith(
      "user-b-token",
      { cursor: "user-a-page-2", limit: 24 },
    );
  });
});
