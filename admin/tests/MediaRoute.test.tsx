import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { MediaRoute } from "../src/routes/MediaRoute";
import { resetMediaCategoryRegistry } from "../src/lib/use-media-categories";
import { cachedMediaList, clearMediaSessionCache, invalidateMediaLists } from "../src/lib/media-session-cache";
import { resetUploadRouter, routeChosenFiles, uploadRouterSnapshot } from "../src/lib/upload-router";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { ExitGuardProvider, useExitGuard } from "../src/routes/ExitGuard";
import { HttpError, type ListMediaResponse, type MediaAssetSummary, type MediaListQuery } from "../src/lib/functions";
import type { MediaFavoriteRef } from "../src/lib/media-favorites";
import { installTestLockManager } from "./helpers/web-locks";
import { DEFAULT_MEDIA_QUERY } from "../src/lib/media-query";
import { DEFAULT_MEDIA_DISPLAY, MEDIA_DISPLAY_STORAGE_KEY } from "../src/lib/media-display";
import { listSourceMedia, type SourceMediaAssetSummary } from "../src/lib/source-media";
import * as sourceMediaUpload from "../src/lib/source-media-upload";

const mocks = vi.hoisted(() => ({
  getIdToken: vi.fn(),
  list: vi.fn(),
  favoriteWriteEpoch: vi.fn((): number | null => 0),
  listCategories: vi.fn(),
  listSources: vi.fn(),
  upload: vi.fn(),
  replace: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listBin: vi.fn(),
  listFavoriteStates: vi.fn(),
  listFavorites: vi.fn(),
  setFavorite: vi.fn(),
  setFavorites: vi.fn(),
  listCollections: vi.fn(),
  listCollectionItems: vi.fn(),
  mutateCollection: vi.fn(),
  setCollectionItems: vi.fn(),
  loadSavedViews: vi.fn(),
  mutateSavedViews: vi.fn(),
  meaningAsset: null as MediaAssetSummary | null,
  meaningProps: [] as { identity: string; refreshRevision: number; query: unknown }[],
  meaningMounts: 0,
  tileRenders: 0,
  sortControlRenders: 0,
}));

// Search worker behavior has its own focused suite; keep route lifecycle request fixtures isolated.
// The stand-in records its props and mounts, so tests can show the panel keeps its inputs and
// never remounts while the toolbar around it changes.
vi.mock("../src/components/MediaMeaningResults", async () => {
  const { useEffect } = await import("react");
  return {
    MediaMeaningResults: ({ onSelect, disabled, identity, refreshRevision, query }: { onSelect: (asset: MediaAssetSummary) => void; disabled: boolean; identity: string; refreshRevision: number; query: unknown }) => {
      mocks.meaningProps.push({ identity, refreshRevision, query });
      useEffect(() => { mocks.meaningMounts += 1; }, []);
      return mocks.meaningAsset ? <button disabled={disabled} onClick={() => onSelect(mocks.meaningAsset!)}>Open related media fixture</button> : null;
    },
  };
});

// Render counters for the typing-isolation test: every card is one MediaTile, and the toolbar
// renders one Sort control. Both wrap the real components.
vi.mock("../src/components/media/MediaTile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/media/MediaTile")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    MediaTile: (props: Parameters<typeof actual.MediaTile>[0]) => {
      mocks.tileRenders += 1;
      return createElement(actual.MediaTile, props);
    },
  };
});

vi.mock("../src/components/media/MediaSortControl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/media/MediaSortControl")>();
  const { createElement, forwardRef } = await import("react");
  return {
    ...actual,
    MediaSortControl: forwardRef<HTMLButtonElement, import("../src/components/media/MediaSortControl").MediaSortControlProps>(function CountingSortControl(props, ref) {
      mocks.sortControlRenders += 1;
      return createElement(actual.MediaSortControl, { ...props, ref });
    }),
  };
});

vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ getIdToken: mocks.getIdToken }),
}));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsListMedia: mocks.list,
  cmsListMediaCategories: mocks.listCategories,
  cmsUploadMedia: mocks.upload,
  cmsReplaceMediaBinary: mocks.replace,
  cmsUpdateMediaMetadata: mocks.update,
  cmsDeleteMedia: mocks.remove,
  cmsListBinnedMedia: mocks.listBin,
}));

vi.mock("../src/lib/source-media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/source-media")>();
  return {
    ...actual,
    listMediaSources: (...args: unknown[]) => mocks.listSources(...args),
    listSourceMedia: vi.fn(async () => ({ records: [], total: 0, hasMore: false, nextCursor: null })),
  };
});

vi.mock("../src/lib/media-favorites", () => ({
  listMediaFavoriteStates: (...args: unknown[]) => mocks.listFavoriteStates(...args),
  listMediaFavorites: (...args: unknown[]) => mocks.listFavorites(...args),
  setMediaFavorite: (...args: unknown[]) => mocks.setFavorite(...args),
  setMediaFavorites: (...args: unknown[]) => mocks.setFavorites(...args),
  mediaFavoriteWriteEpoch: () => mocks.favoriteWriteEpoch(),
}));

vi.mock("../src/lib/media-collections", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/media-collections")>()),
  listMediaCollections: (...args: unknown[]) => mocks.listCollections(...args),
  listMediaCollectionItems: (...args: unknown[]) => mocks.listCollectionItems(...args),
  mutateMediaCollection: (...args: unknown[]) => mocks.mutateCollection(...args),
  setMediaCollectionItems: (...args: unknown[]) => mocks.setCollectionItems(...args),
}));

vi.mock("../src/lib/saved-media-view-store", () => ({
  loadMediaLibraryViews: (...args: unknown[]) => mocks.loadSavedViews(...args),
  mutateMediaLibraryViews: (...args: unknown[]) => mocks.mutateSavedViews(...args),
}));

const asset: MediaAssetSummary = {
  id: "asset-one",
  name: "Studio control room",
  originalName: "studio.png",
  category: "news",
  categories: ["news"],
  tags: ["studio"],
  description: "Main production room",
  altText: "Monitors and switchers",
  license: "NJ PBS owned",
  credit: "NJ PBS",
  mimeType: "image/png",
  kind: "image",
  sizeBytes: 2_048,
  width: 1_600,
  height: 900,
  url: "https://media.njpbs.org/studio.png",
  source: "upload",
  lifecycle: "active",
  version: 2,
  etag: '"media.YXNzZXQtb25l.2"',
  createdAt: "2026-08-13T12:00:00.000Z",
  createdBy: "editor-1",
  updatedAt: "2026-08-13T12:00:00.000Z",
  updatedBy: "editor-1",
};

const shell: ShellData = {
  principal: {
    id: "editor-1",
    grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }],
  },
  user: {
    uid: "editor-1",
    email: "account-8@example.org",
    displayName: "Editor One",
  } as ShellData["user"],
  userDoc: null,
  signOut: vi.fn(),
};

function selection(records: MediaAssetSummary[] = [asset]) {
  return {
    success: true as const,
    records,
    total: records.length,
    allCount: records.length,
    page: 1,
    pageCount: 1,
    categoryCounts: records.length ? { news: records.length } : {},
    kindCounts: { image: records.length, document: 0 },
  };
}

const cursorTokens = ["2".repeat(32), "3".repeat(32)];

function cursorSelection({
  records = [asset],
  page = 1,
  nextCursor = null,
  total = null,
  allCount = null,
}: {
  records?: MediaAssetSummary[];
  page?: number;
  nextCursor?: string | null;
  total?: number | null;
  allCount?: number | null;
} = {}): ListMediaResponse {
  return {
    success: true,
    records,
    paging: "cursor",
    nextCursor,
    total,
    allCount,
    page,
    pageCount: null,
    categoryCounts: null,
    kindCounts: null,
  };
}

function cursorPagedList(pageCount = 3, records: MediaAssetSummary[] = [asset], total = 90) {
  return async (_token: string, query: MediaListQuery): Promise<ListMediaResponse> => {
    const cursorIndex = query.cursor ? cursorTokens.indexOf(query.cursor) : -1;
    const page = cursorIndex + 2;
    const terminal = page >= pageCount;
    return cursorSelection({
      records,
      page,
      nextCursor: terminal ? null : cursorTokens[page - 1],
      total: terminal ? total : null,
      allCount: terminal && !query.q && query.categories.length === 0 && query.kinds.length === 0
        ? total
        : null,
    });
  };
}

/** The details inspector's asset heading. Each card's name is a heading too. */
async function detailsHeading(name: string) {
  const details = await screen.findByRole("complementary", { name: "Asset details" });
  return within(details).findByRole("heading", { name });
}

async function saveSelectedImageName(name: string) {
  fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), {
    target: { value: name },
  });
  const save = screen.getByRole("button", { name: "Save details" });
  await waitFor(() => expect(save).toBeEnabled());
  const priorSaves = mocks.update.mock.calls.length;
  fireEvent.click(save);
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(priorSaves + 1));
}

async function startMediaDelete() {
  const details = await screen.findByRole("complementary", { name: "Asset details" });
  const section = within(details).getByRole("button", { name: "Delete from library" });
  if (section.getAttribute("aria-expanded") === "false") fireEvent.click(section);
  const buttons = within(details).getAllByRole("button", { name: "Delete from library" });
  fireEvent.click(buttons.at(-1)!);
}

/** A page of distinct images named "Image 00", "Image 01" and so on. */
function pageOf(count: number): MediaAssetSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...asset,
    id: `asset-${index}`,
    name: `Image ${String(index).padStart(2, "0")}`,
    etag: `"media.${index}.2"`,
  }));
}

function renderRoute(path = "/media", shellData = shell) {
  const router = createMemoryRouter(
    [{ path: "/media/*", element: <MediaRoute /> }],
    { initialEntries: [path] },
  );
  return {
    router,
    ...render(
      <ShellProvider value={shellData}>
        <RouterProvider router={router} />
      </ShellProvider>,
    ),
  };
}

function MediaRouteWithNotices() {
  const location = useLocation();
  return (
    <SuccessNoticeProvider routeKey={location.key}>
      <MediaRoute />
    </SuccessNoticeProvider>
  );
}

function renderRouteWithNotices(path = "/media", shellData = shell) {
  const router = createMemoryRouter(
    [{ path: "/media/*", element: <MediaRouteWithNotices /> }],
    { initialEntries: [path] },
  );
  return {
    router,
    ...render(
      <ShellProvider value={shellData}>
        <RouterProvider router={router} />
      </ShellProvider>,
    ),
  };
}

function disableWebLocks() {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  return () => {
    if (descriptor) Object.defineProperty(navigator, "locks", descriptor);
    else Reflect.deleteProperty(navigator, "locks");
  };
}

function installMediaFeedbackFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const name = String(input).split("/").at(-1);
    const body = name === "cmsGetMediaReview"
      ? { success: true, review: null }
      : name === "cmsListMediaComments"
        ? { success: true, comments: [], nextCursor: null }
        : null;
    if (!body) throw new Error(`Unexpected request: ${String(input)}`);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  }));
}

// Transform the real deferred modules during setup, outside each UI test's
// budget. The routes still load through Suspense; failure tests use injected
// loaders instead of depending on Vitest's cold transform speed.
beforeAll(async () => {
  await Promise.all([
    import("../src/routes/MediaSecondaryRoutes"),
    import("../src/components/MediaRecycleBin"),
  ]);
});

beforeEach(() => {
  resetUploadRouter();
  clearMediaSessionCache();
  resetMediaCategoryRegistry();
  vi.resetAllMocks();
  installMediaFeedbackFetch();
  localStorage.clear();
  mocks.meaningAsset = null;
  mocks.meaningProps = [];
  mocks.meaningMounts = 0;
  mocks.tileRenders = 0;
  mocks.sortControlRenders = 0;
  mocks.getIdToken.mockResolvedValue("id-token");
  mocks.listCategories.mockResolvedValue({
    success: true,
    categories: [
      {
        id: "news",
        label: "Newsroom",
        description: "News reporting",
        order: 10,
        active: true,
        reserved: false,
        version: 1,
        etag: '"media-category.bmV3cw.1"',
        canUpload: true,
        canManage: true,
        createdAt: null,
        createdBy: null,
        updatedAt: null,
        updatedBy: null,
      },
      {
        id: "arts",
        label: "Arts",
        description: "Arts and culture",
        order: 20,
        active: true,
        reserved: false,
        version: 1,
        etag: '"media-category.YXJ0cw.1"',
        canUpload: false,
        canManage: false,
        createdAt: null,
        createdBy: null,
        updatedAt: null,
        updatedBy: null,
      },
      {
        id: "archived",
        label: "Archive",
        description: "Retired assignment",
        order: 30,
        active: false,
        reserved: false,
        version: 2,
        etag: '"media-category.YXJjaGl2ZWQ.2"',
        canUpload: false,
        canManage: false,
        createdAt: null,
        createdBy: null,
        updatedAt: null,
        updatedBy: null,
      },
    ],
  });
  mocks.list.mockResolvedValue(selection());
  mocks.listSources.mockResolvedValue({
    sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: false }],
  });
  vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [], total: 0, hasMore: false, nextCursor: null });
  mocks.listFavoriteStates.mockImplementation(async (_token: string, refs: MediaFavoriteRef[]) => ({
    success: true,
    states: refs.map((ref: unknown) => ({ ref, favorite: false })),
  }));
  mocks.listFavorites.mockResolvedValue({ success: true, records: [], nextCursor: null, hasMore: false });
  mocks.setFavorite.mockImplementation(async (_token: string, ref: MediaFavoriteRef, favorite: boolean) => ({ success: true, ref, favorite, changed: true }));
  mocks.listCollections.mockResolvedValue({ success: true, collections: [], nextCursor: null, hasMore: false });
  mocks.loadSavedViews.mockResolvedValue([]);
  mocks.setCollectionItems.mockResolvedValue({
    success: true,
    collectionId: "c".repeat(64),
    changed: true,
    replayed: false,
    version: 1,
    membershipVersion: 2,
  });
  mocks.update.mockResolvedValue({
    success: true,
    changed: true,
    asset: {
      ...asset,
      originalName: "main-control-room.png",
      name: "Main control room",
      tags: ["studio", "switcher"],
      categories: ["news", "arts"],
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
    },
  });
  mocks.upload.mockResolvedValue({ success: true, asset });
  mocks.remove.mockResolvedValue({
    success: true,
    changed: true,
    deleted: true,
    asset: {
      id: asset.id,
      lifecycle: "tombstoned",
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
    },
  });
});

describe("MediaRoute", () => {
  it("opens the image recycle bin on demand without an active list request", async () => {
    mocks.listBin.mockResolvedValue({ success: true, records: [], total: 0, page: 1, pageCount: 1 });
    renderRoute("/media/images?bin=1");
    expect(await screen.findByText("The recycle bin is empty")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recycle bin" })).toBeVisible();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.listBin).toHaveBeenCalledTimes(1);
  });
  it("keeps the bin request deferred until the image view control is used", async () => {
    mocks.listBin.mockResolvedValue({ success: true, records: [], total: 0, page: 1, pageCount: 1 });
    renderRoute("/media/images");
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    const button = screen.getByRole("menuitem", { name: "Recycle bin" });
    expect(mocks.listBin).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(await screen.findByText("The recycle bin is empty")).toBeVisible();
  });
  it("hides the bin destination while details have unsaved changes", async () => {
    renderRoute("/media/images?selected=asset-one");
    await detailsHeading(asset.name);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved image name" } });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: "Recycle bin" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save details" })).toBeEnabled();
  });

  it("keeps saved view and filter parameters when visiting the bin and returning", async () => {
    mocks.listBin.mockResolvedValue({ success: true, records: [], total: 0, page: 1, pageCount: 1 });
    const { router } = renderRoute("/media/images?q=harbor&view=bin");
    fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Recycle bin" }));
    await screen.findByText("The recycle bin is empty");
    fireEvent.click(screen.getByRole("link", { name: "Back to Images" }));
    await waitFor(() => expect(router.state.location.search).toBe("?q=harbor&view=bin"));
    expect(screen.queryByRole("heading", { name: "Recycle bin" })).not.toBeInTheDocument();
  });
  it.each([
    ["/media/favorites?q=harbor", "Favorites", "/media/images?bin=1&binAsset=binned-image"],
    ["/media/images?q=harbor&view=bin", "Images", "/media/images?q=harbor&view=bin&bin=1&binAsset=binned-image"],
  ])("guards a routed duplicate pointer from %s with only image filters", async (path, heading, expectedHref) => {
    mocks.upload.mockRejectedValue(new HttpError(409, "This file is already in the media library", { duplicateAssetId: "binned-image" }));
    mocks.list.mockImplementation(async (_token: string, query: { assetIds?: string[] }) => query.assetIds ? selection([]) : selection());
    mocks.listBin.mockResolvedValue({ success: true, records: [], total: 0, page: 1, pageCount: 1 });
    renderRoute(path);
    await screen.findByRole("heading", { name: heading }, { timeout: 5_000 });
    act(() => routeChosenFiles([new File(["image"], "duplicate.png", { type: "image/png" })]));
    await screen.findByText("duplicate.png");
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), { target: { value: "Owned" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByRole("link", { name: "Find it in the Recycle bin" })).toHaveAttribute("href", expectedHref);
    fireEvent.click(screen.getByRole("link", { name: "Find it in the Recycle bin" }));
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeVisible();
    expect(mocks.listBin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByText("The recycle bin is empty")).toBeVisible();
    expect(screen.queryByText("duplicate.png")).not.toBeInTheDocument();
  });
  it("asks once when unsaved image work follows the media root link", async () => {
    mocks.list.mockImplementation(async (_token: string, query: { assetIds?: string[] }) => query.assetIds ? selection([]) : selection());
    const { router } = renderRoute("/media/images");
    await screen.findByRole("heading", { name: "Images" });
    act(() => routeChosenFiles([new File(["image"], "draft.png", { type: "image/png" })]));
    await screen.findByText("draft.png");
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), { target: { value: "Owned" } });
    act(() => { void router.navigate("/media"); });
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/images"));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
  });
  it("preserves filters in the inline library upload's bin pointer", async () => {
    mocks.upload.mockRejectedValue(new HttpError(409, "Duplicate file", { duplicateAssetId: "binned-image" }));
    mocks.list.mockImplementation(async (_token: string, query: { assetIds?: string[] }) => query.assetIds ? selection([]) : selection());
    renderRoute("/media/images?q=harbor&view=bin");
    fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
    fireEvent.change(screen.getByLabelText(/Files/), { target: { files: [new File(["image"], "duplicate.png", { type: "image/png" })] } });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), { target: { value: "Owned" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByRole("link", { name: "Find it in the Recycle bin" })).toHaveAttribute("href", "/media/images?q=harbor&view=bin&bin=1&binAsset=binned-image");
  });
  it("keeps a routed image upload open when switching media tabs", async () => {
    const { router } = renderRoute("/media/videos");
    act(() => routeChosenFiles([new File(["image"], "routed.png", { type: "image/png" })]));
    expect(await screen.findByText("routed.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /^Images/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/images"));
    expect(screen.getByText("routed.png")).toBeInTheDocument();

    await act(async () => { await router.navigate("/media"); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/images"));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
    expect(screen.getByText("routed.png")).toBeInTheDocument();
  });

  it("does not open a routed library upload without the upload capability", async () => {
    const noImageCategory: ShellData = {
      ...shell,
      principal: { id: "video-editor", grants: [{ role: "staff", sections: ["watch"], registeredMediaSections: ["watch"] }] },
    };
    renderRoute("/media/images", noImageCategory);
    act(() => routeChosenFiles([new File(["image"], "routed.png", { type: "image/png" })]));
    expect(await screen.findByText("Your account cannot upload media files.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Upload media" })).toBeNull();
  });

  it("asks before signing out with a routed image queue open", async () => {
    const signedOut = vi.fn();
    function SignOutButton() {
      const requestExit = useExitGuard();
      return <button onClick={() => requestExit(signedOut)}>Sign out</button>;
    }
    const router = createMemoryRouter([{ path: "/media/*", element: <MediaRoute /> }], {
      initialEntries: ["/media/favorites"],
    });
    render(<ExitGuardProvider><ShellProvider value={shell}>
      <SignOutButton />
      <RouterProvider router={router} />
    </ShellProvider></ExitGuardProvider>);
    act(() => routeChosenFiles([new File(["image"], "routed.png", { type: "image/png" })]));
    expect(await screen.findByText("routed.png")).toBeInTheDocument();
    await waitFor(() => {
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    expect(signedOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("routed.png")).toBeInTheDocument();
  });

  it("keeps the video transfer panel mounted while routing an image", async () => {
    mocks.listSources.mockResolvedValue({
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
    });
    const { router } = renderRoute("/media/videos");
    await screen.findByRole("button", { name: "Upload media" });
    const transfers = document.querySelector(".video-upload-panel");
    expect(transfers).not.toBeNull();

    act(() => routeChosenFiles([new File(["image"], "routed.png", { type: "image/png" })]));
    expect(await screen.findByText("routed.png")).toBeInTheDocument();
    expect(document.querySelector(".video-upload-panel")).toBe(transfers);

    await act(async () => { await router.navigate("/media"); });
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/images"));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
    expect(screen.getByText("routed.png")).toBeInTheDocument();
  });

  it("keeps an active video transfer mounted and blocks a deferred workspace reload", async () => {
    installTestLockManager();
    mocks.listSources.mockResolvedValue({
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
    });
    const startUpload = vi.spyOn(sourceMediaUpload, "startVideoUpload").mockResolvedValue({
      success: true,
      upload: { sessionId: "session", assetId: "video-new", partSize: 4, totalParts: 1, expiresAt: "2026-10-03T00:00:00Z", version: 1 },
    });
    let transferSignal: AbortSignal | undefined;
    const transferUpload = vi.spyOn(sourceMediaUpload, "transferVideo").mockImplementation(({ signal, onPhase }) => {
      transferSignal = signal;
      onPhase("uploading");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Paused", "AbortError")), { once: true });
      });
    });
    const loadSecondaryModule = vi.fn().mockRejectedValue(new Error("Chunk request failed"));
    const reloadDocument = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const router = createMemoryRouter(
        [
          { path: "/media/*", element: <MediaRoute loadSecondaryModule={loadSecondaryModule} reloadDocument={reloadDocument} /> },
          { path: "/away", element: <h1>Away</h1> },
        ],
        { initialEntries: ["/media/images"] },
      );
      render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
      await screen.findByRole("heading", { name: "Images" });
      act(() => routeChosenFiles([new File(["video"], "clip.mp4", { type: "video/mp4" })]));
      expect(startUpload).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Start upload clip.mp4" }));
      await waitFor(() => expect(startUpload).toHaveBeenCalledOnce());
      await waitFor(() => expect(transferSignal).toBeDefined());
      const transfers = await screen.findByRole("region", { name: "Video transfers" });

      await act(async () => { await router.navigate("/media/favorites"); });
      const failure = await screen.findByRole("alert");
      expect(failure).toHaveTextContent("Media workspace unavailable");
      expect(screen.getByRole("region", { name: "Video transfers" })).toBe(transfers);
      expect(transferSignal?.aborted).toBe(false);

      act(() => { void router.navigate("/away"); });
      expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeVisible();
      expect(router.state.location.pathname).toBe("/media/favorites");
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

      expect(failure).toHaveTextContent("Finish or cancel the current upload before reloading this page.");
      const reload = within(failure).getByRole("button", { name: "Reload page" });
      expect(reload).toBeDisabled();
      fireEvent.click(reload);
      expect(reloadDocument).not.toHaveBeenCalled();
      expect(loadSecondaryModule).toHaveBeenCalledOnce();
      expect(screen.getByRole("region", { name: "Video transfers" })).toBe(transfers);
      expect(transferSignal?.aborted).toBe(false);
    } finally {
      consoleError.mockRestore();
      startUpload.mockRestore();
      transferUpload.mockRestore();
    }
  });

  it("reloads the document after a deferred workspace chunk fails", async () => {
    const loadSecondaryModule = vi.fn().mockRejectedValue(new Error("Chunk request failed"));
    const reloadDocument = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const router = createMemoryRouter(
        [{ path: "/media/*", element: <MediaRoute loadSecondaryModule={loadSecondaryModule} reloadDocument={reloadDocument} /> }],
        { initialEntries: ["/media/favorites"] },
      );
      render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);

      const failure = await screen.findByRole("alert");
      const reload = within(failure).getByRole("button", { name: "Reload page" });
      expect(reload).toBeEnabled();
      fireEvent.click(reload);

      expect(reloadDocument).toHaveBeenCalledOnce();
      expect(loadSecondaryModule).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("shows cached rows on return and replaces them after refresh", async () => {
    const refreshed = { ...asset, id: "asset-two", name: "New studio image" };
    let finishRefresh!: (result: ReturnType<typeof selection>) => void;
    mocks.list.mockResolvedValueOnce(selection()).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    const router = createMemoryRouter([
      { path: "/media/*", element: <MediaRoute /> },
      { path: "/away", element: <h1>Away</h1> },
    ], { initialEntries: ["/media/images"] });
    render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
    await screen.findByRole("button", { name: /^Studio control room/ });
    await act(async () => { await router.navigate("/away"); });
    await act(async () => { await router.navigate("/media/images"); });
    expect(screen.getByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    await act(async () => finishRefresh(selection([refreshed])));
    expect(await screen.findByRole("button", { name: /^New studio image/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Studio control room/ })).toBeNull();
  });

  it("does not show another user's cached media", async () => {
    const first = renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    first.unmount();
    let finishLoad!: (result: ReturnType<typeof selection>) => void;
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve; }));
    const otherUser: ShellData = {
      ...shell,
      user: { ...shell.user, uid: "editor-2" },
      principal: { ...shell.principal, id: "editor-2" },
    };
    renderRoute("/media/images", otherUser);
    expect(screen.queryByRole("button", { name: /^Studio control room/ })).toBeNull();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await act(async () => finishLoad(selection([])));
    expect(screen.queryByRole("button", { name: /^Studio control room/ })).toBeNull();
  });

  it("drops cached rows when refresh denies access", async () => {
    let denyRefresh!: (error: Error) => void;
    mocks.list.mockResolvedValueOnce(selection()).mockImplementationOnce(() => new Promise((_resolve, reject) => { denyRefresh = reject; }));
    const router = createMemoryRouter([
      { path: "/media/*", element: <MediaRoute /> },
      { path: "/away", element: <h1>Away</h1> },
    ], { initialEntries: ["/media/images"] });
    render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
    await screen.findByRole("button", { name: /^Studio control room/ });
    await act(async () => { await router.navigate("/away"); });
    await act(async () => { await router.navigate("/media/images"); });
    expect(screen.getByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await act(async () => denyRefresh(new HttpError(403, "Access changed")));
    await screen.findByText("Access changed");
    expect(screen.queryByRole("button", { name: /^Studio control room/ })).toBeNull();
  });

  it("ends the updating state when an invalidated refresh returns", async () => {
    let finishRefresh!: (result: ReturnType<typeof selection>) => void;
    mocks.list.mockResolvedValueOnce(selection()).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    const router = createMemoryRouter([
      { path: "/media/*", element: <MediaRoute /> },
      { path: "/away", element: <h1>Away</h1> },
    ], { initialEntries: ["/media/images"] });
    render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
    await screen.findByRole("button", { name: /^Studio control room/ });
    await act(async () => { await router.navigate("/away"); });
    await act(async () => { await router.navigate("/media/images"); });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(document.querySelector(".media-library-layout")).toHaveAttribute("aria-busy", "true");
    invalidateMediaLists();
    await act(async () => finishRefresh(selection([])));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(document.querySelector(".media-library-layout")).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
  });

  it("loads the images library without listing video sources", async () => {
    const { router } = renderRoute();
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/media/images");
    expect(mocks.list).toHaveBeenCalled();
    expect(mocks.listSources).not.toHaveBeenCalled();
  });

  it("keeps each fixed source in the URL and restores it through history", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });

    fireEvent.click(screen.getByRole("link", { name: /^Videos/ }));
    await screen.findByRole("heading", { name: "Videos" });
    expect(router.state.location.pathname).toBe("/media/videos");
    expect(screen.getByRole("link", { name: /^Videos/ })).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("link", { name: "Favorites" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/favorites"));
    await waitFor(() => expect(screen.getByRole("link", { name: "Favorites" })).toHaveAttribute("aria-current", "page"));
    expect(screen.getByRole("link", { name: /^Videos/ })).not.toHaveAttribute("aria-current");

    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname).toBe("/media/videos");
    await waitFor(() => expect(screen.getByRole("link", { name: /^Videos/ })).toHaveAttribute("aria-current", "page"));
    expect(screen.getByRole("link", { name: "Favorites" })).not.toHaveAttribute("aria-current");

    await act(async () => { await router.navigate(1); });
    expect(router.state.location.pathname).toBe("/media/favorites");
    await waitFor(() => expect(screen.getByRole("link", { name: "Favorites" })).toHaveAttribute("aria-current", "page"));
  });

  it("opens the Favorites destination from its own URL", async () => {
    const { router } = renderRoute("/media/favorites");
    expect(await screen.findByRole("link", { name: "Favorites" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(mocks.listFavorites).toHaveBeenCalledTimes(1));
    expect(router.state.location.pathname).toBe("/media/favorites");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.listSources).not.toHaveBeenCalled();
  });

  it("opens Collections from its own URL and restores it through history", async () => {
    const { router } = renderRoute("/media/collections");
    expect(await screen.findByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { name: "Collections" })).toBeInTheDocument();
    expect(await screen.findByText("No active collections")).toBeInTheDocument();
    expect(mocks.listCollections).toHaveBeenCalledTimes(2);
    expect(mocks.listSources).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Favorites" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/favorites"));
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname).toBe("/media/collections");
    expect(screen.getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("No active collections")).toBeInTheDocument();

    const collectionId = "c".repeat(64);
    await act(async () => { await router.navigate(`/media/collections/${collectionId}`); });
    expect(screen.getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps a custom video source identity across a direct load", async () => {
    mocks.listSources.mockResolvedValue({
      sources: [
        { id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: false },
        { id: "archive", label: "Archive", description: "Older tapes", mediaKind: "video", canBrowse: true, canUpload: false },
      ],
    });
    const { router } = renderRoute("/media/videos/archive");
    expect(await screen.findByRole("link", { name: "Archive" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /^Videos/ })).not.toHaveAttribute("aria-current");
    expect(await screen.findByRole("heading", { name: "Archive" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/media/videos/archive");
  });

  it("falls back from an unavailable source and from an unauthorized image route", async () => {
    const unavailable = renderRoute("/media/videos/missing");
    await waitFor(() => expect(unavailable.router.state.location.pathname).toBe("/media/videos"));
    unavailable.unmount();

    const staffShell: ShellData = {
      ...shell,
      principal: { id: "staff-1", grants: [{ role: "staff" }] },
      user: { uid: "staff-1", email: "staff@example.test" } as ShellData["user"],
    };
    const unauthorized = renderRoute("/media/images", staffShell);
    await waitFor(() => expect(unauthorized.router.state.location.pathname).toBe("/media/videos"));
    expect(await screen.findByRole("heading", { name: "Videos" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Images/ })).toBeNull();
  });

  it("does not request image categories for video-only collection staff", async () => {
    const id = "c".repeat(64);
    const staffShell: ShellData = {
      ...shell,
      principal: { id: "staff-1", grants: [{ role: "staff" }] },
      user: { uid: "staff-1", email: "staff@example.test" } as ShellData["user"],
    };
    mocks.listCollectionItems.mockResolvedValue({
      success: true,
      collection: { id, scope: "all_staff", name: "Video package", description: "", color: "blue",
        lifecycle: "active", version: 1, membershipVersion: 1, cover: null, canEdit: true,
        createdAt: null, updatedAt: null },
      items: [], nextCursor: null, hasMore: false,
    });
    renderRoute(`/media/collections/${id}`, staffShell);
    expect(await screen.findByRole("heading", { name: "Items" })).toBeVisible();
    expect(mocks.listCategories).not.toHaveBeenCalled();
  });

  it("lists media tabs as links in the new order and marks only the current one", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const strip = screen.getByRole("navigation", { name: "Media sources" });
    const links = within(strip).getAllByRole("link");
    expect(links.map(link => link.querySelector(".media-tab-label")?.textContent)).toEqual([
      "Images", "Videos", "Audio", "Favorites", "Collections",
    ]);
    expect(within(strip).queryAllByRole("button")).toHaveLength(0);
    expect(links.filter(link => link.getAttribute("aria-current") === "page")).toEqual([links[0]]);
    expect(links.map(link => link.getAttribute("href"))).toEqual([
      "/media/images", "/media/videos", "/media/voiceovers", "/media/favorites", "/media/collections",
    ]);
  });

  it("keeps the image query when the current tab is activated", async () => {
    const { router } = renderRoute("/media/images?q=studio&selected=asset-one");
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Studio control room");
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });

    const currentTab = screen.getByRole("link", { name: /^Images/ });
    fireEvent.click(currentTab);
    expect(fireEvent.click(currentTab, { button: 0, ctrlKey: true })).toBe(true);

    expect(router.state.location.pathname).toBe("/media/images");
    expect(new URLSearchParams(router.state.location.search).get("q")).toBe("studio");
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved name");
    await act(async () => { await Promise.resolve(); });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("returns to the collection list from the Collections tab on a collection detail", async () => {
    const collectionId = "c".repeat(64);
    const { router } = renderRoute(`/media/collections/${collectionId}`);
    const tab = await screen.findByRole("link", { name: "Collections" });
    expect(tab).toHaveAttribute("aria-current", "page");
    fireEvent.click(tab);
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/collections"));
    expect(screen.getByRole("link", { name: "Collections" })).toHaveAttribute("aria-current", "page");
  });

  it("shows the images count in the Images tab name from the loaded list without another request", async () => {
    renderRoute("/media/images");
    expect(await screen.findByRole("link", { name: "Images 1 item" })).toHaveAttribute("aria-current", "page");
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.listSources).not.toHaveBeenCalled();
    // Only the Images tab carries a count in this release.
    for (const name of ["Videos", "Audio", "Favorites", "Collections"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
  });

  it("keeps the images count while visiting Favorites and drops it for another account", async () => {
    const { router, rerender } = renderRoute("/media/images");
    await screen.findByRole("link", { name: "Images 1 item" });

    fireEvent.click(screen.getByRole("link", { name: "Favorites" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/favorites"));
    expect(screen.getByRole("link", { name: "Images 1 item" })).not.toHaveAttribute("aria-current");
    expect(mocks.list).toHaveBeenCalledTimes(1);

    const otherUser: ShellData = {
      ...shell,
      user: { ...shell.user, uid: "editor-2" },
      principal: { ...shell.principal, id: "editor-2" },
    };
    rerender(<ShellProvider value={otherUser}><RouterProvider router={router} /></ShellProvider>);
    expect(await screen.findByRole("link", { name: "Images" })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("drops the images count after a media write from Favorites", async () => {
    mocks.listFavorites.mockResolvedValue({
      success: true,
      records: [{ ref: { backend: "r2", id: asset.id }, createdAt: "2026-09-22T12:00:00.000Z", available: true, asset }],
      nextCursor: null,
      hasMore: false,
    });
    // The real cmsDeleteMedia invalidates the media lists after a write; the mock keeps that contract.
    mocks.remove.mockImplementation(async () => {
      invalidateMediaLists();
      return { success: true, changed: true, deleted: true, asset: { id: asset.id, lifecycle: "tombstoned", version: 3, etag: '"media.YXNzZXQtb25l.3"' } };
    });
    const { router } = renderRoute("/media/images");
    await screen.findByRole("link", { name: "Images 1 item" });

    fireEvent.click(screen.getByRole("link", { name: "Favorites" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/favorites"));
    fireEvent.click(await screen.findByRole("button", { name: /^Studio control room, image/ }));
    await startMediaDelete();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("link", { name: "Images" })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("drops the images count after a denied refresh", async () => {
    let denyRefresh!: (error: Error) => void;
    mocks.list.mockResolvedValueOnce(selection()).mockImplementationOnce(() => new Promise((_resolve, reject) => { denyRefresh = reject; }));
    const { router } = renderRoute("/media/images");
    await screen.findByRole("link", { name: "Images 1 item" });
    await act(async () => { await router.navigate("/media/favorites"); });
    await act(async () => { await router.navigate("/media/images"); });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await act(async () => denyRefresh(new HttpError(403, "Access changed")));
    await screen.findByText("Access changed");
    expect(screen.getByRole("link", { name: "Images" })).toHaveAttribute("aria-current", "page");
  });

  it("shows every tab count from the first Images list without another request", async () => {
    mocks.list.mockResolvedValueOnce({
      ...selection(),
      counts: { images: 1, favorites: 3, audio: 196, sources: { "video-library": 1204 } },
    });
    renderRoute("/media/images");
    expect(await screen.findByRole("link", { name: "Images 1 item" })).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("link", { name: "Videos 1,204 items" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audio 196 items" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Favorites 3 items" })).toBeInTheDocument();
    // Collections never shows a count.
    expect(screen.getByRole("link", { name: "Collections" })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith("id-token", expect.any(Object), undefined, { counts: true, favorites: true });
    expect(mocks.listSources).not.toHaveBeenCalled();
    // The counts stay out of the cached list, whose key is unchanged.
    const cached = cachedMediaList(shell.user.uid, {
      q: "", categories: [], kinds: [], sort: "updatedAt", direction: "desc", page: 1,
      paging: "cursor",
    });
    expect(cached).toBeDefined();
    expect(cached).not.toHaveProperty("counts");
  });

  it("shows no counts on a direct Favorites landing and makes no count request", async () => {
    renderRoute("/media/favorites");
    expect(await screen.findByRole("link", { name: "Favorites" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(mocks.listFavorites).toHaveBeenCalledTimes(1));
    for (const name of ["Images", "Videos", "Audio", "Collections"]) {
      expect(screen.getByRole("link", { name })).toBeInTheDocument();
    }
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.listSources).not.toHaveBeenCalled();
  });

  it("asks the video sources call for counts once per page session", async () => {
    mocks.listSources.mockResolvedValueOnce({
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: false }],
      counts: { images: 9, favorites: 2, audio: 5 },
    });
    const { router } = renderRoute("/media/videos");
    expect(await screen.findByRole("link", { name: "Favorites 2 items" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Audio 5 items" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Images 9 items" })).toBeInTheDocument();
    expect(mocks.listSources).toHaveBeenCalledWith("id-token", { counts: true });
    // The unfiltered video page's own total fills that source's count at no extra cost.
    expect(await screen.findByRole("link", { name: "Videos 0 items" })).toBeInTheDocument();

    await act(async () => { await router.navigate("/media/favorites"); });
    await act(async () => { await router.navigate("/media/videos"); });
    await waitFor(() => expect(mocks.listSources).toHaveBeenCalledTimes(2));
    expect(mocks.listSources.mock.calls[1]).toEqual(["id-token"]);

    // The Images list reuses the counts in hand and replaces the Images count with its own total.
    await act(async () => { await router.navigate("/media/images"); });
    expect(await screen.findByRole("link", { name: "Images 1 item" })).toBeInTheDocument();
    expect(mocks.list.mock.calls[0][3]).toEqual({ counts: false, favorites: true });
    expect(screen.getByRole("link", { name: "Favorites 2 items" })).toBeInTheDocument();
  });

  it("waits for renewed video source access before showing the library on tab return", async () => {
    const available = { sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: false }] };
    let finish!: (value: typeof available) => void;
    mocks.listSources.mockResolvedValueOnce(available).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { router } = renderRoute("/media/videos");
    expect(await screen.findByRole("heading", { name: "Videos" })).toBeInTheDocument();
    await act(async () => { await router.navigate("/media/favorites"); });
    await act(async () => { await router.navigate("/media/videos"); });
    await waitFor(() => expect(mocks.listSources).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: "Videos" })).not.toBeInTheDocument();
    await act(async () => { finish(available); });
    expect(await screen.findByRole("heading", { name: "Videos" })).toBeInTheDocument();
  });

  it("keeps listing images when an older Functions version rejects the flag", async () => {
    mocks.list
      .mockRejectedValueOnce(new HttpError(400, "Unknown media list field counts"))
      .mockResolvedValue(selection());
    renderRoute("/media/images");
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list.mock.calls[1][3]).toEqual({ counts: false, favorites: true });
    expect(screen.getByRole("link", { name: "Images 1 item" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Favorites" })).toBeInTheDocument();
  });

  it("uses the favorite states from the list instead of a second favorites request", async () => {
    mocks.list.mockImplementation(async (_token: string, query: { assetIds?: string[] }, _signal: unknown, options?: { favorites?: boolean }) => {
      const result = selection();
      return options?.favorites && !query.assetIds
        ? { ...result, favoriteStates: result.records.map((record: { id: string }) => ({ ref: { backend: "r2", id: record.id }, favorite: true })) }
        : result;
    });
    renderRoute("/media/images");
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect((await screen.findAllByRole("button", { name: /Remove from favorites/ })).length).toBeGreaterThan(0);
    expect(mocks.listFavoriteStates).not.toHaveBeenCalled();
  });

  it("drops list favorite states read before a favorite write and asks again", async () => {
    let finish!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    renderRoute("/media/images");
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    mocks.favoriteWriteEpoch.mockReturnValue(1);
    const result = selection();
    await act(async () => { finish({ ...result, favoriteStates: result.records.map((record: { id: string }) => ({ ref: { backend: "r2", id: record.id }, favorite: true })) }); });
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    await waitFor(() => expect(mocks.listFavoriteStates).toHaveBeenCalledTimes(1));
    mocks.favoriteWriteEpoch.mockReturnValue(0);
  });

  it("drops list favorite states read while a favorite write is in flight", async () => {
    let finish!: (value: unknown) => void;
    mocks.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mocks.favoriteWriteEpoch.mockReturnValue(null);
    renderRoute("/media/images");
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    const result = selection();
    await act(async () => { finish({ ...result, favoriteStates: result.records.map((record: { id: string }) => ({ ref: { backend: "r2", id: record.id }, favorite: true })) }); });
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    await waitFor(() => expect(mocks.listFavoriteStates).toHaveBeenCalledTimes(1));
    mocks.favoriteWriteEpoch.mockReturnValue(0);
  });

  it("waits for the seeded refresh of cached rows instead of a separate favorites lookup", async () => {
    mocks.list.mockImplementation(async (_token: string, query: { assetIds?: string[] }, _signal: unknown, options?: { favorites?: boolean }) => {
      const result = selection();
      return options?.favorites && !query.assetIds
        ? { ...result, favoriteStates: result.records.map((record: { id: string }) => ({ ref: { backend: "r2", id: record.id }, favorite: false })) }
        : result;
    });
    const { router } = renderRoute("/media/images");
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    await act(async () => { await router.navigate("/media/favorites"); });
    await act(async () => { await router.navigate("/media/images"); });
    await waitFor(() => expect(mocks.list.mock.calls.filter(call => !call[1]?.assetIds).length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect(mocks.listFavoriteStates).not.toHaveBeenCalled();
  });

  it("lists images without favorite states when an older Function rejects that flag", async () => {
    mocks.list
      .mockRejectedValueOnce(new HttpError(400, "Unknown media list field favorites"))
      .mockResolvedValue(selection());
    renderRoute("/media/images");
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect(mocks.list.mock.calls[1][3]).toEqual({ counts: true, favorites: false });
    await waitFor(() => expect(mocks.listFavoriteStates).toHaveBeenCalledTimes(1));
  });

  it("makes no list, sources, favorites or collections request when switching tabs beyond each tab's own load", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("link", { name: "Images 1 item" });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.listFavorites).not.toHaveBeenCalled();
    expect(mocks.listCollections).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: "Favorites" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/favorites"));
    await waitFor(() => expect(mocks.listFavorites).toHaveBeenCalledTimes(1));

    // Activating the tab already shown makes no request at all.
    fireEvent.click(screen.getByRole("link", { name: "Favorites" }));
    await act(async () => { await Promise.resolve(); });

    expect(router.state.location.pathname).toBe("/media/favorites");
    expect(mocks.listFavorites).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.listSources).not.toHaveBeenCalled();
    expect(mocks.listCollections).not.toHaveBeenCalled();
  });

  it("favorites an image without opening it and uses one page lookup", async () => {
    let finishLookup!: (value: unknown) => void;
    mocks.listFavoriteStates.mockImplementationOnce(() => new Promise(resolve => { finishLookup = resolve; }));
    let finishFavorite!: (value: unknown) => void;
    mocks.setFavorite.mockImplementationOnce(() => new Promise(resolve => { finishFavorite = resolve; }));
    const { router } = renderRoute();

    const loading = await screen.findByRole("button", { name: "Loading favorite: Studio control room" });
    expect(loading).toBeDisabled();
    fireEvent.click(loading);
    expect(mocks.setFavorite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    expect(screen.queryByRole("menuitem", { name: /(?:Add to|Remove from) favorites/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await act(async () => finishLookup({ success: true, states: [{ ref: { backend: "r2", id: "asset-one" }, favorite: false }] }));
    const favorite = await screen.findByRole("button", {
      name: "Add to favorites: Studio control room",
    });
    expect(mocks.listFavoriteStates).toHaveBeenCalledTimes(1);
    expect(mocks.listFavoriteStates).toHaveBeenCalledWith("id-token", [
      { backend: "r2", id: "asset-one" },
    ]);

    fireEvent.click(favorite);
    await waitFor(() => expect(mocks.setFavorite).toHaveBeenCalledWith(
      "id-token",
      { backend: "r2", id: "asset-one" },
      true,
    ));
    const pending = screen.getByRole("button", { name: "Saving favorite: Studio control room" });
    expect(pending).toHaveAttribute("aria-busy", "true");
    fireEvent.click(pending);
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    expect(screen.queryByRole("menuitem", { name: /(?:Add to|Remove from) favorites/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(mocks.setFavorite).toHaveBeenCalledTimes(1);
    await act(async () => finishFavorite({ success: true, ref: { backend: "r2", id: "asset-one" }, favorite: true, changed: true }));
    expect(await screen.findByRole("button", { name: "Remove from favorites: Studio control room" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Close details" })).not.toBeInTheDocument();
  });

  it("offers Undo for a confirmed image favorite with one reverse request", async () => {
    const router = createMemoryRouter([{ path: "/media/*", element: <SuccessNoticeProvider routeKey="editor-1:images"><MediaRoute /></SuccessNoticeProvider> }],
      { initialEntries: ["/media/images"] });
    render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites: Studio control room" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => expect(notice).toHaveTextContent("Studio control room was added to your favorites."));
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(mocks.setFavorite).toHaveBeenCalledTimes(2));
    expect(mocks.setFavorite).toHaveBeenLastCalledWith("id-token", { backend: "r2", id: "asset-one" }, false);
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("adds a selected image reference to a collection and returns focus to the card that last had focus", async () => {
    mocks.listCollections.mockImplementation(async (_token: string, query: { scope: string }) => ({
      success: true,
      collections: query.scope === "private" ? [{
        id: "c".repeat(64),
        scope: "private",
        name: "Homepage package",
        description: "",
        lifecycle: "active",
        version: 1,
        membershipVersion: 1,
        cover: null,
        canEdit: true,
        createdAt: null,
        updatedAt: null,
        itemCount: 0,
      }] : [],
      nextCursor: null,
      hasMore: false,
    }));
    renderRoute();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Add to collection" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Homepage package/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add selected to collection" })).getByRole("button", { name: "Add to collection" }));

    await waitFor(() => expect(mocks.setCollectionItems).toHaveBeenCalledWith("id-token", expect.objectContaining({
      collectionId: "c".repeat(64),
      present: true,
      refs: [{ backend: "r2", id: "asset-one" }],
    })));
    // Decision 3: a bulk action returns focus to the card that last had focus.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Studio control room, image/ })).toHaveFocus());
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("keeps collection actions available when a filter has no visible images", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Studio control room" }));
    mocks.list.mockResolvedValue(selection([]));
    const search = screen.getByRole("searchbox", { name: "Search media" });
    fireEvent.change(search, { target: { value: "no matches" } });
    fireEvent.submit(search.closest("form")!);
    await screen.findByText("No keyword matches");

    await waitFor(() => expect(screen.getByRole("group", { name: "Collection selection" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Select this page" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Add to collection" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    // The card that last had focus is gone, so focus falls back to search.
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search media" })).toHaveFocus());
  });

  it("marks only the selected video source current", async () => {
    mocks.listSources.mockResolvedValue({
      sources: [
        { id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: false },
        { id: "archive", label: "Archive", description: "Older tapes", mediaKind: "video", canBrowse: true, canUpload: false },
      ],
    });
    const { router } = renderRoute();
    fireEvent.click(await screen.findByRole("link", { name: /^Videos/ }));
    expect(await screen.findByRole("link", { name: /^Archive/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /^Videos/ })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("link", { name: /^Archive/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/videos/archive"));
    // /media/videos is a prefix of /media/videos/archive, so a path-prefix rule would mark both.
    expect(screen.getByRole("link", { name: /^Videos/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /^Archive/ })).toHaveAttribute("aria-current", "page");
  });

  it("still lists images when the category registry fails", async () => {
    mocks.listCategories.mockRejectedValueOnce(new Error("offline"));
    renderRoute();
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalled();
  });

  it("moves focus into asset details and returns it to the opening card", async () => {
    renderRoute();
    const card = await screen.findByRole("button", { name: /^Studio control room/ });
    card.focus();
    fireEvent.click(card);
    expect(await detailsHeading("Studio control room")).toHaveFocus();
    const close = screen.getByRole("button", { name: "Close details" });
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(card).toHaveFocus());
  });

  it("loads and filters the shareable media library", async () => {
    const { router } = renderRoute();

    expect(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("1 result")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sort: Last updated, newest first" }),
    ).toBeInTheDocument();
    // The first list load of the page session carries the tab-count flag outside the query.
    expect(mocks.list).toHaveBeenCalledWith("id-token", {
      q: "",
      categories: [],
      kinds: [],
      sort: "updatedAt",
      direction: "desc",
      page: 1,
      paging: "cursor",
    }, undefined, { counts: true, favorites: true });

    // Filtering reuses the counts in hand, so the call has no flag.
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Filter" })).getByRole("button", { name: "Type" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Images" }));
    // The draft commits after the 300ms pause.
    await waitFor(() =>
      expect(router.state.location.search).toContain("kind=image"),
    );
    expect(await screen.findByRole("button", { name: "Edit filter Type: Images" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter Type: Images" })).toBeInTheDocument();
    await waitFor(() => {
      expect(mocks.list).toHaveBeenLastCalledWith(
        "id-token",
        expect.objectContaining({ kinds: ["image"], page: 1 }),
        undefined, expect.objectContaining({ favorites: true }),
      );
    });
  });

  it("updates the URL after a typing pause and keeps results when refresh fails", async () => {
    let rejectSearch: (reason?: unknown) => void = () => {};
    const { router } = renderRoute();
    expect(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    ).toBeInTheDocument();
    const firstCallCount = mocks.list.mock.calls.length;
    mocks.list
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectSearch = reject;
          }),
      )
      .mockResolvedValue(selection());

    const search = screen.getByRole("searchbox", { name: "Search media" });
    vi.useFakeTimers();
    try {
      fireEvent.change(search, { target: { value: "studio" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(router.state.location.search).not.toContain("q=");
      expect(mocks.list).toHaveBeenCalledTimes(firstCallCount);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(router.state.location.search).toContain("q=studio");
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(mocks.list).toHaveBeenLastCalledWith(
        "id-token",
        expect.objectContaining({ q: "studio", page: 1 }),
        undefined, expect.objectContaining({ favorites: true }),
      );

      await act(async () => {
        rejectSearch(new Error("Search refresh failed"));
      });
      expect(screen.getByText("Search refresh failed")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /^Studio control room/ }),
      ).toBeInTheDocument();

      fireEvent.change(search, { target: { value: "" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(router.state.location.search).not.toContain("q=");
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(mocks.list).toHaveBeenLastCalledWith(
        "id-token",
        expect.objectContaining({ q: "", page: 1 }),
        undefined, expect.objectContaining({ favorites: true }),
      );
      expect(screen.queryByText("Search refresh failed")).toBeNull();

      const callsBeforeSubmit = mocks.list.mock.calls.length;
      fireEvent.change(search, { target: { value: "camera" } });
      fireEvent.submit(search.closest("form")!);
      expect(router.state.location.search).toContain("q=camera");
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(mocks.list).toHaveBeenLastCalledWith(
        "id-token",
        expect.objectContaining({ q: "camera", page: 1 }),
        undefined, expect.objectContaining({ favorites: true }),
      );
      expect(mocks.list).toHaveBeenCalledTimes(callsBeforeSubmit + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(mocks.list).toHaveBeenCalledTimes(callsBeforeSubmit + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-search while media details have unsaved work", async () => {
    const { router } = renderRoute("/media?selected=asset-one");
    expect(
      await detailsHeading("Studio control room"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved control room" },
    });
    const callsBeforeSearch = mocks.list.mock.calls.length;
    const search = screen.getByRole("searchbox", { name: "Search media" });

    vi.useFakeTimers();
    try {
      fireEvent.change(search, { target: { value: "camera" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(router.state.location.search).not.toContain("q=");
      expect(mocks.list).toHaveBeenCalledTimes(callsBeforeSearch);
      expect(
        screen.queryByRole("dialog", { name: "Leave with unsaved changes?" }),
      ).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(router.state.location.search).toContain("q=camera");
      expect(mocks.list).toHaveBeenLastCalledWith(
        "id-token",
        expect.objectContaining({ q: "camera", page: 1 }),
        undefined, expect.objectContaining({ favorites: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not present a failed refresh as a valid empty result", async () => {
    mocks.list
      .mockResolvedValueOnce(selection([]))
      .mockRejectedValueOnce(new Error("Search refresh failed"));
    renderRoute();
    expect(await screen.findByText("No media found")).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search media" });

    vi.useFakeTimers();
    try {
      fireEvent.change(search, { target: { value: "missing" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      expect(screen.getByText("Search refresh failed")).toBeInTheDocument();
      expect(screen.queryByText("No media found")).toBeNull();
      expect(screen.queryByText("0 results")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes an unused asset from the library after confirmation", async () => {
    mocks.list
      .mockResolvedValueOnce(selection())
      .mockResolvedValue(selection([]));
    renderRoute("/media?selected=asset-one");

    expect(
      await detailsHeading("Studio control room"),
    ).toBeInTheDocument();
    await startMediaDelete();
    expect(
      screen.getByRole("group", { name: "Confirm media deletion" }),
    ).toHaveFocus();
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, delete from library" }),
    );

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith("id-token", asset),
    );
    expect(
      await screen.findByText("Media deleted from library"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Open original")).not.toBeInTheDocument(),
    );
  });

  it("keeps station seed filenames read-only", async () => {
    mocks.list.mockResolvedValue(selection([{ ...asset, source: "site_seed" }]));
    renderRoute("/media?selected=asset-one");

    expect(
      await detailsHeading("Studio control room"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Filename" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("studio.png")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete from library" }),
    ).not.toBeInTheDocument();
  });

  it("offers a fresh asset reload after a stale delete conflict", async () => {
    const freshAsset = {
      ...asset,
      name: "Fresh control room name",
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
    };
    mocks.remove.mockRejectedValueOnce(
      new HttpError(412, "Reload before deleting."),
    );
    renderRoute("/media?selected=asset-one");

    await detailsHeading("Studio control room");
    await startMediaDelete();
    fireEvent.click(
      screen.getByRole("button", { name: "Yes, delete from library" }),
    );

    expect(
      await screen.findByText("This asset changed. Reload it before deleting."),
    ).toBeInTheDocument();
    const callsBeforeReload = mocks.list.mock.calls.length;
    mocks.list.mockResolvedValue(selection([freshAsset]));
    fireEvent.click(screen.getByRole("button", { name: "Reload asset" }));

    await waitFor(() =>
      expect(mocks.list.mock.calls.length).toBeGreaterThan(callsBeforeReload),
    );
    expect(
      await detailsHeading("Fresh control room name"),
    ).toBeInTheDocument();
  });

  it("opens library details while an upload runs and preserves the hidden queue", async () => {
    mocks.upload.mockReturnValue(new Promise(() => {}));
    renderRoute();
    const card = await screen.findByRole("button", { name: /^Studio control room/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [new File(["image"], "news-desk.png", { type: "image/png" })] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    const signal = mocks.upload.mock.calls[0][3] as AbortSignal;
    fireEvent.click(card);
    expect(await detailsHeading("Studio control room")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Upload media" })).toBeNull();
    expect(signal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    const sheet = screen.getByRole("complementary", { name: "Upload media" });
    expect(within(sheet).getByRole("textbox", { name: "License" })).toHaveValue("NJ PBS owned");
    expect(within(sheet).getByRole("button", { name: /^.+: Uploading…$/ })).toBeInTheDocument();
  });

  it("uploads one validated file with a batch license and reloads it in the library", async () => {
    const uploaded = {
      ...asset,
      id: "asset-two",
      name: "News desk",
      originalName: "news-desk.png",
      version: 1,
      etag: '"media.YXNzZXQtdHdv.1"',
    };
    let resolveUpload: (value: { success: true; asset: MediaAssetSummary }) => void =
      () => {};
    mocks.upload.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    const { router } = renderRoute("/media?q=old&kind=document&page=3");

    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Batch license default" }), {
      target: { value: "NJ PBS owned" },
    });
    const file = new File(["image bytes"], "news-desk.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText(/File/), {
      target: { files: [file] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "News desk" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), {
      target: { value: "news, studio, News" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Arts" }));
    mocks.list.mockResolvedValue(selection([uploaded, asset]));
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    await waitFor(() => {
      expect(mocks.upload).toHaveBeenCalledWith(
        "id-token",
        file,
        {
          name: "News desk",
          metadataUpdateRequested: false,
          category: "news",
          categories: ["news", "arts"],
          description: undefined,
          altText: undefined,
          license: "NJ PBS owned",
          credit: undefined,
          tags: ["news", "studio"],
          imageProcessing: "webp",
        },
        expect.any(AbortSignal),
      );
    });
    const uploading = screen.getByRole("button", { name: /^.+: Uploading…$/ });
    expect(uploading).toHaveAttribute("aria-busy", "true");
    expect(uploading.querySelector(".activity-indicator")).toBeInTheDocument();
    await act(async () => {
      resolveUpload({ success: true, asset: uploaded });
    });
    expect(await screen.findByText("Media uploaded")).toBeInTheDocument();
    await waitFor(() => {
      expect(router.state.location.search).not.toContain("q=");
      expect(router.state.location.search).not.toContain("kind=");
      expect(router.state.location.search).toContain("selected=asset-two");
    });
    await waitFor(() => {
      expect(mocks.list).toHaveBeenLastCalledWith("id-token", {
        q: "",
        categories: [],
        kinds: [],
        sort: "updatedAt",
        direction: "desc",
        page: 1,
        paging: "cursor",
      }, undefined, expect.objectContaining({ favorites: true }));
    });
    expect(
      await screen.findByRole("button", { name: /^News desk/ }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /^Studio control room/ }),
    );
    await waitFor(() => {
      expect(router.state.location.search).toContain("selected=asset-one");
      expect(router.state.location.search).not.toContain("selected=asset-two");
    });
    fireEvent.click(screen.getByRole("button", { name: /^News desk/ }));
    expect(await detailsHeading("News desk")).toBeInTheDocument();
    const tray = screen.getByRole("region", { name: "Upload progress" });
    fireEvent.click(within(tray).getByRole("button", { name: "View asset news-desk.png" }));
    expect(await detailsHeading("News desk")).toBeInTheDocument();
  });

  it("uploads a sequential batch, reloads once, and keeps its receipt", async () => {
    const firstUploaded = {
      ...asset,
      id: "asset-batch-one",
      name: "Batch one",
      originalName: "batch-one.png",
      etag: '"media.YXNzZXQtYmF0Y2gtb25l.1"',
    };
    const secondUploaded = {
      ...asset,
      id: "asset-batch-two",
      name: "Batch two",
      originalName: "batch-two.png",
      etag: '"media.YXNzZXQtYmF0Y2gtdHdv.1"',
    };
    mocks.upload
      .mockResolvedValueOnce({ success: true, asset: firstUploaded })
      .mockResolvedValueOnce({ success: true, asset: secondUploaded });
    const { router } = renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    const callsBeforeBatch = mocks.list.mock.calls.length;
    mocks.list.mockResolvedValue(
      selection([secondUploaded, firstUploaded, asset]),
    );
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "batch-one.png", { type: "image/png" }),
          new File(["two"], "batch-two.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("File 2 of 2")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText("Media batch uploaded")).toBeInTheDocument();
    expect(screen.getByText("Batch one is ready to use.")).toBeInTheDocument();
    expect(screen.getByText("Batch two is ready to use.")).toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.search).toContain("selected=asset-batch-two"),
    );
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledTimes(callsBeforeBatch + 1),
    );
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    expect(screen.queryByText("batch-one.png")).toBeNull();
    expect(screen.queryByText("batch-two.png")).toBeNull();
  });

  it("uses the existing file with a warning when an upload is a duplicate", async () => {
    const existing = { ...asset, id: "asset-existing", name: "Harbor at dawn" };
    mocks.upload.mockRejectedValueOnce(
      new HttpError(409, "This file is already in the media library", {
        duplicateAssetId: "asset-existing",
      }),
    );
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    // The existing file is older than the reloaded first page.
    mocks.list.mockImplementation(async (_token: string, query: { assetIds?: string[] }) =>
      query.assetIds ? selection([existing]) : selection([asset]),
    );
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [new File(["one"], "harbor.png", { type: "image/png" })] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByText("Existing files were used")).toBeInTheDocument();
    expect(
      screen.getByText(/harbor\.png is already in the media library as "Harbor at dawn"/),
    ).toBeInTheDocument();
    expect(screen.getByText("Harbor at dawn is ready to use.")).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith(
      expect.anything(),
      { assetIds: ["asset-existing"] },
      expect.any(AbortSignal),
    );
    expect(screen.queryByText("Media was not uploaded")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View Harbor at dawn" }));
    expect(
      await detailsHeading("Harbor at dawn"),
    ).toBeInTheDocument();
  });

  it("keeps the duplicate warning when a batch is closed early", async () => {
    const existing = { ...asset, id: "asset-existing", name: "Harbor at dawn" };
    mocks.upload.mockRejectedValueOnce(
      new HttpError(409, "This file is already in the media library", {
        duplicateAssetId: "asset-existing",
      }),
    );
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    mocks.list.mockResolvedValue(selection([existing, asset]));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "harbor.png", { type: "image/png" }),
          new File(["two"], "later.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("File 2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Discard and leave" }),
    );

    expect(await screen.findByText("Existing files were used")).toBeInTheDocument();
    expect(screen.getByText(/harbor\.png is already in the media library/)).toBeInTheDocument();
  });

  it("explains a duplicate the uploader may not open", async () => {
    mocks.upload.mockRejectedValueOnce(
      new HttpError(409, "This file is already in the media library", {
        duplicateAssetId: null,
      }),
    );
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [new File(["one"], "harbor.png", { type: "image/png" })] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(
      await screen.findByText(/in a category you cannot open/),
    ).toBeInTheDocument();
  });

  it("can keep the original JPEG or PNG when optimization is turned off", async () => {
    renderRoute("/media");
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    const file = new File(["image bytes"], "news-desk.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText(/File/), {
      target: { files: [file] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Optimize JPEG and PNG files and convert them to WebP",
      }),
    );
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    await waitFor(() => {
      expect(mocks.upload).toHaveBeenCalledWith(
        "id-token",
        file,
        expect.objectContaining({ imageProcessing: undefined }),
        expect.any(AbortSignal),
      );
    });
  });

  it("uses an authorized section as the default upload category", async () => {
    renderRoute("/media", {
      ...shell,
      principal: {
        id: "editor-1",
        grants: [
          { role: "contributor" },
          { role: "editor", sections: ["news"], registeredMediaSections: ["news"] },
        ],
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );

    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue(
      "news",
    );
    expect(screen.getByRole("option", { name: "Newsroom — News reporting" })).toBeVisible();
  });

  it("does not offer an upload category outside the current grant", async () => {
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    const category = screen.getByRole("combobox", { name: "Category" });
    expect(category.querySelector('option[value="news"]')).toBeVisible();
    expect(category.querySelector('option[value="arts"]')).not.toBeInTheDocument();
  });

  it("refuses unsupported and oversized files before upload", async () => {
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    const fileInput = screen.getByLabelText(/File/);
    fireEvent.change(fileInput, {
      target: {
        files: [new File(["text"], "notes.txt", { type: "text/plain" })],
      },
    });
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("Choose an image, PDF, WAV audio file, or video.")).toBeInTheDocument();

    fireEvent.change(fileInput, {
      target: {
        files: [
          new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.png", {
            type: "image/png",
          }),
        ],
      },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );
    expect(
      await screen.findByText("Choose a file that is 25 MB or smaller."),
    ).toBeInTheDocument();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("keeps the Audio upload sheet limited to WAV files", async () => {
    renderRoute("/media/voiceovers");
    await screen.findByRole("heading", { name: "Audio" });
    act(() => routeChosenFiles([
      new File(["image"], "portrait.jpg", { type: "image/jpeg" }),
    ]));
    const sheet = screen.getByRole("complementary", { name: "Upload media" });
    expect(within(sheet).getByRole("heading", { name: "Upload audio" })).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Choose WAV audio" })).toBeInTheDocument();
    const input = sheet.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("The upload sheet has no file input.");
    expect(input.getAttribute("accept")).toContain("audio/wav");
    expect(input.getAttribute("accept")).not.toContain("image/");
    expect(within(sheet).getByRole("alert")).toHaveTextContent(
      "portrait.jpg: Upload images and PDFs from Images.",
    );
    expect(within(sheet).queryByRole("button", { name: /portrait\.jpg/ })).not.toBeInTheDocument();
    fireEvent.change(input, {
      target: { files: [new File(["video"], "clip.mp4", { type: "video/mp4" })] },
    });
    expect(await screen.findByText("Video uploads are not available.")).toBeInTheDocument();
  });

  it("keeps the Images upload sheet limited to images and documents", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    act(() => routeChosenFiles([
      new File(["document"], "brief.pdf", { type: "application/pdf" }),
      new File(["PCM audio"], "interview.wav", { type: "audio/wav" }),
    ]));
    const sheet = screen.getByRole("complementary", { name: "Upload media" });
    expect(within(sheet).getByRole("heading", { name: "Upload images and documents" })).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Choose images or PDFs" })).toBeInTheDocument();
    const input = sheet.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("The upload sheet has no file input.");
    expect(input.getAttribute("accept")).toContain("application/pdf");
    expect(input.getAttribute("accept")).not.toContain("audio/");
    expect(within(sheet).getByRole("button", { name: /brief\.pdf/ })).toBeVisible();
    expect(within(sheet).getByRole("alert")).toHaveTextContent(
      "interview.wav: Upload WAV files from Audio.",
    );
    expect(within(sheet).queryByRole("button", { name: /interview\.wav/ })).not.toBeInTheDocument();
  });

  it("sends a global WAV upload to Audio without leaving the current tab", async () => {
    mocks.upload.mockResolvedValue({
      success: true,
      asset: {
        ...asset,
        kind: "audio",
        mimeType: "audio/wav",
        originalName: "interview.wav",
        width: null,
        height: null,
      },
    });
    const { router } = renderRouteWithNotices("/media/favorites");
    const upload = await screen.findByRole("button", { name: "Upload media" });
    const input = upload.parentElement?.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("The upload control has no file input.");
    fireEvent.change(input, {
      target: { files: [new File(["PCM audio"], "interview.wav", { type: "audio/x-wav" })] },
    });
    expect(await screen.findByRole("button", { name: /interview\.wav/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    const notice = await screen.findByRole("region", { name: "Notifications" });
    expect(notice).toHaveTextContent("Studio control room is in Audio.");
    expect(router.state.location.pathname).toBe("/media/favorites");
    fireEvent.click(within(notice).getByRole("button", { name: "Open Audio" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/voiceovers"));
  });

  it.each([
    ["/media/favorites", "Upload images, PDFs, WAV audio, or videos"],
    ["/media/collections", "Upload images, PDFs, WAV audio, or videos"],
    ["/media/voiceovers", "Upload WAV audio or videos"],
  ])("offers upload on %s without putting it in the tab strip", async (path, title) => {
    renderRoute(path);
    const upload = await screen.findByRole("button", { name: "Upload media" });
    expect(upload).toHaveAttribute("title", title);
    expect(within(screen.getByRole("navigation", { name: "Media sources" })).queryByRole("button")).toBeNull();
  });

  it("does not offer upload without media upload permission", async () => {
    renderRoute("/media/favorites", {
      ...shell,
      principal: { id: "contributor-1", grants: [{ role: "contributor" }] },
    });
    expect(await screen.findByRole("heading", { name: "Favorites" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload media" })).toBeNull();
  });

  it("keeps one upload control on Images", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    await screen.findByRole("button", { name: "Upload media" });
    expect(screen.getAllByRole("button", { name: "Upload media" })).toHaveLength(1);
  });

  it("keeps Favorites mounted while an image upload is open", async () => {
    renderRoute("/media/favorites");
    expect(await screen.findByRole("heading", { name: "Favorites" })).toBeInTheDocument();
    act(() => routeChosenFiles([new File(["image"], "shore.png", { type: "image/png" })]));
    expect(await screen.findByText("shore.png")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Favorites" })).toBeInTheDocument();
  });

  it("protects a routed image and returns focus to Upload after it is discarded", async () => {
    renderRoute("/media/favorites");
    const upload = await screen.findByRole("button", { name: "Upload media" });
    const input = upload.parentElement?.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("The upload control has no file input.");
    fireEvent.change(input, {
      target: { files: [new File(["image"], "shore.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("shore.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toHaveFocus());
  });

  it("returns focus to the Images upload control after a routed image is discarded", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    act(() => routeChosenFiles([new File(["image"], "shore.png", { type: "image/png" })]));
    expect(await screen.findByText("shore.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toHaveFocus());
  });

  it("returns focus to a video source upload control after a routed image is discarded", async () => {
    installTestLockManager();
    mocks.listSources.mockResolvedValue({
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
    });
    renderRoute("/media/videos");
    const upload = await screen.findByRole("button", { name: "Upload media" });
    act(() => routeChosenFiles([new File(["image"], "shore.png", { type: "image/png" })]));
    expect(await screen.findByText("shore.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(upload).toHaveFocus());
  });

  it("shows rejected files and closes the phone video sheet when an image routes", async () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => {
        const max = /max-width:\s*([\d.]+)rem/.exec(query);
        return {
          matches: max ? 390 <= Number(max[1]) * 16 : false,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
        };
      },
    });
    try {
      installTestLockManager();
      mocks.listSources.mockResolvedValue({
        sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
      });
      renderRoute("/media/videos");
      fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
      const videoSheet = screen.getByRole("dialog", { name: "Upload media" });
      expect(within(videoSheet).getByRole("heading", { name: "Upload to Videos" })).toBeInTheDocument();
      fireEvent.drop(within(videoSheet).getByRole("region", { name: "Video transfers" }), {
        dataTransfer: { files: [new File(["unsupported"], "reject.exe")], types: ["Files"] },
      });
      expect(await within(videoSheet).findByText("reject.exe")).toBeInTheDocument();
      expect(within(videoSheet).getByText(/Choose an image, PDF, WAV audio file, or video\./)).toBeInTheDocument();
      fireEvent.click(within(videoSheet).getByRole("button", { name: "Dismiss" }));
      const input = videoSheet.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error("The video upload sheet has no file input.");

      fireEvent.change(input, {
        target: { files: [new File(["image"], "shore.png", { type: "image/png" })] },
      });

      expect(await screen.findByText("shore.png")).toBeInTheDocument();
      expect(videoSheet).toHaveAttribute("hidden");
      const sourceUpload = screen.getByRole("button", { name: "Upload media" });
      expect(sourceUpload).toHaveAttribute("aria-disabled", "true");
      expect(sourceUpload).toHaveAccessibleDescription("Finish the current Images upload first.");
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
    }
  });

  it("shows a mixed video admission failure after the image form hides the sheet", async () => {
    installTestLockManager();
    localStorage.setItem("boardwalk-video-transfers:editor-1:video-library", JSON.stringify(
      Array.from({ length: 19 }, (_, index) => ({ id: `saved-${index}`, name: `saved-${index}.mp4`, size: 4, lastModified: 42 })),
    ));
    mocks.listSources.mockResolvedValue({
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
    });
    const router = createMemoryRouter([{ path: "/media/*", element: <SuccessNoticeProvider routeKey="media"><MediaRoute /></SuccessNoticeProvider> }],
      { initialEntries: ["/media/videos"] });
    render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
    await screen.findByRole("button", { name: "Upload media" });
    await waitFor(() => expect(document.querySelector(".video-upload-panel")).not.toHaveAttribute("data-disabled"));

    act(() => routeChosenFiles([
      new File(["image"], "shore.png", { type: "image/png" }),
      new File(["video"], "first.mp4", { type: "video/mp4" }),
      new File(["video"], "second.mp4", { type: "video/mp4" }),
    ]));

    expect(await screen.findByText("shore.png")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Notifications" })).toHaveTextContent("Add up to 1 more files to this transfer list.");
    expect(document.querySelector(".media-upload-sheet")).toHaveAttribute("hidden");
  });

  it("keeps one upload control while a routed video is open", async () => {
    installTestLockManager();
    mocks.listSources.mockResolvedValue({
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
    });
    renderRoute("/media/favorites");
    const upload = await screen.findByRole("button", { name: "Upload media" });
    const input = upload.parentElement?.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("The upload control has no file input.");
    fireEvent.change(input, {
      target: { files: [new File(["video"], "clip.mp4", { type: "video/mp4" })] },
    });

    expect(await screen.findByRole("region", { name: "Video transfers" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Upload media" })).toHaveLength(1);
  });

  it("reloads the open destination library after a routed video finishes", async () => {
    installTestLockManager();
    mocks.listSources.mockResolvedValue({
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true, canEditMetadata: true }],
    });
    const existingVideo = {
      id: "video-existing",
      sourceId: "video-library",
      name: "Existing clip",
      description: null,
      originalName: "existing.mp4",
      mimeType: "video/mp4",
      kind: "video",
      sizeBytes: 5,
      preview: "browser",
      license: null,
      credit: null,
      tags: [],
      rightsStatus: "pending",
      version: 1,
      createdAt: null,
      updatedAt: null,
    } as SourceMediaAssetSummary;
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [existingVideo], total: 1, hasMore: false, nextCursor: null });
    let finishTransfer: (asset: SourceMediaAssetSummary) => void = () => {};
    const startUpload = vi.spyOn(sourceMediaUpload, "startVideoUpload").mockResolvedValue({
      success: true,
      upload: { sessionId: "session", assetId: "video-new", partSize: 4, totalParts: 1, expiresAt: "2026-09-27T00:00:00Z", version: 1 },
    });
    const transferUpload = vi.spyOn(sourceMediaUpload, "transferVideo").mockImplementation(({ onPhase }) => {
      onPhase("uploading");
      return new Promise(resolve => { finishTransfer = resolve; });
    });
    try {
      renderRoute("/media/favorites");
      const upload = await screen.findByRole("button", { name: "Upload media" });
      const input = upload.parentElement?.querySelector("input[type=file]");
      if (!(input instanceof HTMLInputElement)) throw new Error("The upload control has no file input.");
      fireEvent.change(input, {
        target: { files: [new File(["video"], "clip.mp4", { type: "video/mp4" })] },
      });
      expect(startUpload).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Start upload clip.mp4" }));
      await waitFor(() => expect(startUpload).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("link", { name: /^Videos/ }));
      expect(await screen.findByRole("heading", { name: "Videos" })).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: /^Existing clip, video/ }));
      const title = await screen.findByRole("textbox", { name: "Title" });
      fireEvent.change(title, { target: { value: "Unsaved title" } });
      const callsBeforeFinish = vi.mocked(listSourceMedia).mock.calls.length;

      await act(async () => {
        finishTransfer({ id: "video-new", sourceId: "video-library", name: "clip.mp4" } as SourceMediaAssetSummary);
      });

      await waitFor(() => expect(vi.mocked(listSourceMedia).mock.calls.length).toBeGreaterThan(callsBeforeFinish));
      expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Unsaved title");
    } finally {
      startUpload.mockRestore();
      transferUpload.mockRestore();
    }
  });

  it("lets staff dismiss a routed video when queue ownership is unavailable", async () => {
    const restoreLocks = disableWebLocks();
    try {
      mocks.listSources.mockResolvedValue({
        sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
      });
      renderRoute("/media/favorites");
      act(() => routeChosenFiles([new File(["video"], "clip.mp4", { type: "video/mp4" })]));

      expect(await screen.findByText("Uploads are unavailable in this browser. The selected video was not added.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      await waitFor(() => expect(screen.queryByText("Uploads are unavailable in this browser. The selected video was not added.")).toBeNull());
      expect(uploadRouterSnapshot().videoSession).toBe(false);
      expect(screen.getByRole("button", { name: "Upload media" })).toBeInTheDocument();
    } finally {
      restoreLocks();
    }
  });

  it("restores the workspace upload control after a routed batch exceeds the saved queue", async () => {
    installTestLockManager();
    localStorage.setItem("boardwalk-video-transfers:editor-1:video-library", JSON.stringify(
      Array.from({ length: 19 }, (_, index) => ({ id: `saved-${index}`, name: `saved-${index}.mp4`, size: 4, lastModified: 42 })),
    ));
    mocks.listSources.mockResolvedValue({
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
    });
    renderRoute("/media/favorites");
    act(() => routeChosenFiles(["one.mp4", "two.mp4"].map(name => new File(["video"], name, { type: "video/mp4" }))));

    await waitFor(() => expect(uploadRouterSnapshot().videoSession).toBe(false));
    expect(screen.getByRole("button", { name: "Upload media" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Video transfers" })).not.toBeInTheDocument();
  });

  it.each(["token", "source list"])("retries %s discovery without losing the routed video", async failure => {
    installTestLockManager();
    const videoSources = {
      sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
    };
    mocks.listSources.mockResolvedValue(videoSources);
    renderRoute("/media/favorites");
    await waitFor(() => expect(mocks.listFavorites).toHaveBeenCalledOnce());
    if (failure === "token") mocks.getIdToken.mockRejectedValueOnce(new Error("Token failed"));
    else mocks.listSources.mockRejectedValueOnce(new Error("Source list failed"));
    act(() => routeChosenFiles([new File(["video"], "clip.mp4", { type: "video/mp4" })]));

    expect(await screen.findByText("Video upload could not find a library.")).toBeInTheDocument();
    expect(uploadRouterSnapshot().videoSession).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("region", { name: "Video transfers" })).toBeInTheDocument();
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    expect(uploadRouterSnapshot().videoSession).toBe(true);
  });

  it("keeps a routed video when the Media link redirects to Images", async () => {
    const { router } = renderRoute("/media/favorites");
    act(() => routeChosenFiles([new File(["video"], "clip.mp4", { type: "video/mp4" })]));
    expect(await screen.findByText("Video uploads are not available.")).toBeInTheDocument();

    await act(async () => { await router.navigate("/media"); });

    await waitFor(() => expect(router.state.location.pathname).toBe("/media/images"));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
    expect(uploadRouterSnapshot().videoSession).toBe(true);
    expect(screen.getByText("Video uploads are not available.")).toBeInTheDocument();
  });

  it("routes a mixed batch from Favorites and stays on that tab", async () => {
    const { router } = renderRoute("/media/favorites");
    const upload = await screen.findByRole("button", { name: "Upload media" });
    const input = upload.parentElement?.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("The upload control has no file input.");
    fireEvent.change(input, {
      target: {
        files: [
          new File(["image"], "shore.png", { type: "image/png" }),
          new File(["text"], "notes.txt", { type: "text/plain" }),
          new File(["video"], "clip.mp4", { type: "video/mp4" }),
        ],
      },
    });

    expect(await screen.findByText("shore.png")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("Choose an image, PDF, WAV audio file, or video.")).toBeInTheDocument();
    expect(await screen.findByText("Video uploads are not available.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/media/favorites");
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("shows a video chosen on a source that cannot upload instead of holding it silently", async () => {
    installTestLockManager();
    mocks.listSources.mockResolvedValue({
      sources: [
        { id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true },
        { id: "archive", label: "Archive", description: "Closed archive", mediaKind: "video", canBrowse: true, canUpload: false },
      ],
    });
    const { router } = renderRoute("/media/videos/archive");
    const upload = await screen.findByRole("button", { name: "Upload media" });
    const input = upload.parentElement?.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("The upload control has no file input.");
    fireEvent.change(input, {
      target: { files: [new File(["video"], "clip.mp4", { type: "video/mp4" })] },
    });

    expect(await screen.findByRole("region", { name: "Video transfers" })).toBeInTheDocument();
    expect(screen.getByText("clip.mp4")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/media/videos/archive");
  });

  it("names the image library after an upload from another tab and does not switch tabs", async () => {
    const router = createMemoryRouter(
      [{
        path: "/media/*",
        element: <SuccessNoticeProvider routeKey="media"><MediaRoute /></SuccessNoticeProvider>,
      }],
      { initialEntries: ["/media/favorites"] },
    );
    render(<ShellProvider value={shell}><RouterProvider router={router} /></ShellProvider>);
    const upload = await screen.findByRole("button", { name: "Upload media" });
    const input = upload.parentElement?.querySelector("input[type=file]");
    if (!(input instanceof HTMLInputElement)) throw new Error("The upload control has no file input.");
    fireEvent.change(input, {
      target: { files: [new File(["image"], "shore.png", { type: "image/png" })] },
    });
    expect(await screen.findByText("shore.png")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));

    const notice = await screen.findByRole("region", { name: "Notifications" });
    expect(notice).toHaveTextContent("Studio control room is in Images.");
    expect(router.state.location.pathname).toBe("/media/favorites");
    fireEvent.click(screen.getByRole("button", { name: "Open Images" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/images"));
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Upload media" })).toBeNull();
  });

  it("protects upload details when the form closes", async () => {
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved upload" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Leave with unsaved changes?",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Unsaved upload",
    );
  });

  it("protects dirty upload details before browser unload", async () => {
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved upload" },
    });

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);

    expect(unload.defaultPrevented).toBe(true);
  });

  it("stops an active upload", async () => {
    mocks.upload.mockImplementation(
      async (
        _token: string,
        _file: File,
        _metadata: unknown,
        signal: AbortSignal,
      ) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("The upload was canceled.")),
            { once: true },
          );
        }),
    );
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [new File(["image bytes"], "studio.png", { type: "image/png" })],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Stop upload" }));

    expect(
      await screen.findByText("The upload was canceled."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("keeps the active uploader mounted when the sheet closes and stops it from the tray", async () => {
    let uploadSignal: AbortSignal | null = null;
    let uploadAborted = false;
    mocks.upload.mockImplementation(
      async (
        _token: string,
        _file: File,
        _metadata: unknown,
        signal: AbortSignal,
      ) => {
        uploadSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            uploadAborted = true;
            reject(new Error("The upload was canceled."));
          }, { once: true });
        });
      },
    );
    const { router } = renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
    const fileInput = screen.getByLabelText(/File/);
    fireEvent.change(fileInput, {
      target: { files: [new File(["image bytes"], "tray-stop.png", { type: "image/png" })] },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Upload" }).closest("form")!);
    await waitFor(() => expect(uploadSignal).not.toBeNull());

    const sheet = screen.getByRole("complementary", { name: "Upload media" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Close upload" }));

    expect(sheet).toHaveAttribute("hidden");
    expect(uploadAborted).toBe(false);
    expect(sheet.querySelector('input[type="file"]')).toBe(fileInput);
    const tray = screen.getByRole("region", { name: "Upload progress" });
    expect(within(tray).getByRole("status")).toHaveTextContent("Uploading 1 of 1");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search media" }), { target: { value: "studio" } });
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("q")).toBe("studio"));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Upload progress" })).toBe(tray);

    const card = await screen.findByRole("button", { name: /^Studio control room, image/ });
    fireEvent.keyDown(card, { key: "y", metaKey: true });
    const quickLook = await screen.findByRole("dialog", { name: "Quick Look: Studio control room" });
    expect(screen.getByRole("region", { name: "Upload progress" })).toBe(tray);
    fireEvent.keyDown(quickLook, { key: "Escape" });
    fireEvent.click(card);
    expect(await detailsHeading("Studio control room")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Upload progress" })).toBe(tray);

    fireEvent.click(within(tray).getByRole("button", { name: "Stop tray-stop.png" }));
    await waitFor(() => expect(uploadAborted).toBe(true));
    expect(await within(tray).findByText("The upload was canceled.")).toBeInTheDocument();
    expect(within(tray).getByRole("status")).toHaveTextContent("1 of 1 failed");
  });

  it("reports the active queue position after an earlier file fails", async () => {
    mocks.upload
      .mockRejectedValueOnce(new Error("The first upload failed."))
      .mockImplementationOnce(async () => new Promise(() => undefined));
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [
        new File(["one"], "first.png", { type: "image/png" }),
        new File(["two"], "second.png", { type: "image/png" }),
      ] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Batch license default" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue with remaining files" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    const tray = screen.getByRole("region", { name: "Upload progress" });
    expect(within(tray).getByRole("status")).toHaveTextContent("Uploading 2 of 2");
  });

  it("discards an in-flight upload before a source route proceeds", async () => {
    let uploadSignal: AbortSignal | null = null;
    mocks.upload.mockImplementation(
      async (
        _token: string,
        _file: File,
        _metadata: unknown,
        signal: AbortSignal,
      ) => {
        uploadSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("The upload was canceled.")),
            { once: true },
          );
        });
      },
    );
    const { router } = renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload media" }),
    );
    fireEvent.change(screen.getByLabelText(/File/), {
      target: {
        files: [new File(["image bytes"], "studio.png", { type: "image/png" })],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Upload" }).closest("form")!,
    );
    await waitFor(() => expect(uploadSignal).not.toBeNull());

    fireEvent.click(screen.getByRole("link", { name: /^Videos/ }));

    expect(router.state.location.pathname).toBe("/media/images");

    fireEvent.click(
      await screen.findByRole("button", { name: "Discard and leave" }),
    );

    await waitFor(() => expect(uploadSignal?.aborted).toBe(true));
    expect(await screen.findByRole("heading", { name: "Videos" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/media/videos");
    expect(
      screen.queryByRole("dialog", { name: "Leave with unsaved changes?" }),
    ).not.toBeInTheDocument();
  });

  it("saves all allowed metadata with the current asset version", async () => {
    const savedAsset = {
      ...asset,
      originalName: "main-control-room.png",
      name: "Main control room",
      tags: ["studio", "switcher"],
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
      updatedAt: "2026-08-13T13:00:00.000Z",
    };
    let resolveSave: (value: {
      success: true;
      changed: true;
      asset: MediaAssetSummary;
    }) => void = () => {};
    mocks.update.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    );
    mocks.list.mockResolvedValue(selection([savedAsset]));

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Main control room" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Filename" }), {
      target: { value: "main-control-room.png" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Tags" }), {
      target: { value: "switcher," },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Arts" }));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    const saving = await screen.findByRole("button", { name: /^.+: Saving details…$/ });
    expect(saving).toHaveAttribute("aria-busy", "true");
    expect(saving.querySelector(".activity-indicator")).toBeInTheDocument();
    expect(screen.getByText("Saving media details.")).toHaveAttribute(
      "role",
      "status",
    );

    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith("id-token", asset, {
        originalName: "main-control-room.png",
        name: "Main control room",
        description: "Main production room",
        altText: "Monitors and switchers",
        license: "NJ PBS owned",
        credit: "NJ PBS",
        tags: ["studio", "switcher"],
        categories: ["news", "arts"],
      });
    });
    await act(async () => {
      resolveSave({ success: true, changed: true, asset: savedAsset });
    });
    expect(await screen.findByText("Media details saved")).toBeInTheDocument();
    expect(screen.getByText("The current version is 3.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filename" })).toHaveValue(
      "main-control-room.png",
    );
  });

  it("undoes one confirmed image save with the returned ETag and prior values", async () => {
    const savedAsset = {
      ...asset,
      name: "Updated studio",
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
    };
    const restoredAsset = {
      ...asset,
      version: 4,
      etag: '"media.YXNzZXQtb25l.4"',
    };
    let currentAsset = asset;
    mocks.list.mockImplementation(async () => selection([currentAsset]));
    mocks.update
      .mockImplementationOnce(async () => {
        currentAsset = savedAsset;
        return { success: true, changed: true, asset: savedAsset };
      })
      .mockImplementationOnce(async () => {
        currentAsset = restoredAsset;
        return { success: true, changed: true, asset: restoredAsset };
      });
    renderRouteWithNotices("/media/images?selected=asset-one");

    await saveSelectedImageName("Updated studio");
    const notice = await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => expect(notice).toHaveTextContent("Updated studio details saved."));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Updated studio"));
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update).toHaveBeenLastCalledWith("id-token", savedAsset, {
      name: "Studio control room",
      description: "Main production room",
      altText: "Monitors and switchers",
      license: "NJ PBS owned",
      credit: "NJ PBS",
      tags: ["studio"],
      categories: ["news"],
    });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Studio control room"));
    expect(notice).toHaveTextContent("Updated studio details restored.");
  });

  it("does not retry image save Undo after an ETag conflict", async () => {
    const savedAsset = {
      ...asset,
      name: "Updated studio",
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
    };
    let currentAsset = asset;
    mocks.list.mockImplementation(async () => selection([currentAsset]));
    mocks.update
      .mockImplementationOnce(async () => {
        currentAsset = savedAsset;
        return { success: true, changed: true, asset: savedAsset };
      })
      .mockRejectedValueOnce(new HttpError(412, "Reload before saving."));
    renderRouteWithNotices("/media/images?selected=asset-one");

    await saveSelectedImageName("Updated studio");
    const notice = await screen.findByRole("region", { name: "Notifications" });
    fireEvent.click(await within(notice).findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(notice).toHaveTextContent(
      "This asset changed. Reload its current details before editing.",
    ));
    expect(within(notice).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(mocks.update).toHaveBeenLastCalledWith(
      "id-token",
      expect.objectContaining({ id: asset.id, etag: savedAsset.etag }),
      expect.objectContaining({ name: asset.name }),
    );
  });

  it("replaces an earlier image save Undo when the next save confirms no change", async () => {
    const savedAsset = { ...asset, name: "Updated studio", version: 3, etag: '"media.YXNzZXQtb25l.3"' };
    const noChangeAsset = { ...savedAsset, name: "Second edit" };
    let currentAsset = asset;
    mocks.list.mockImplementation(async () => selection([currentAsset]));
    mocks.update
      .mockImplementationOnce(async () => {
        currentAsset = savedAsset;
        return { success: true, changed: true, asset: savedAsset };
      })
      .mockImplementationOnce(async () => {
        currentAsset = noChangeAsset;
        return { success: true, changed: false, asset: noChangeAsset };
      });
    renderRouteWithNotices("/media/images?selected=asset-one");

    await saveSelectedImageName("Updated studio");
    const notice = screen.getByRole("region", { name: "Notifications" });
    expect(await within(notice).findByRole("button", { name: "Undo" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(savedAsset.name));
    await saveSelectedImageName(noChangeAsset.name);
    expect(await screen.findByText("Media details saved")).toBeInTheDocument();
    await waitFor(() => expect(notice).toHaveTextContent("Second edit details saved."));
    expect(within(notice).queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it("keeps the generated alt-text notice for unchanged generated text", async () => {
    mocks.list.mockResolvedValue(selection([{ ...asset, altTextGenerated: true }]));
    renderRoute("/media/images?selected=asset-one");

    expect(await screen.findByText("Generated alt text")).toBeInTheDocument();
    expect(screen.getByText("The alt-text sweep wrote this text. Check it and edit it if needed.")).toBeInTheDocument();
  });

  it("keeps the missing-license warning in asset details", async () => {
    mocks.list.mockResolvedValue(selection([{ ...asset, license: null }]));
    renderRoute("/media/images?selected=asset-one");

    expect(await screen.findByText("No license entered")).toBeInTheDocument();
    expect(screen.getByText("This file has no license. Add one so the rights are on record.")).toBeInTheDocument();
  });

  it("lets a Watch Editor edit details while keeping the primary category required", async () => {
    renderRoute("/media/images?selected=asset-one", {
      ...shell,
      principal: { id: "watch-editor", grants: [{ role: "editor", sections: ["watch"], registeredMediaSections: ["watch"] }] },
      user: { ...shell.user, uid: "watch-editor" },
    });
    const inspector = await screen.findByRole("complementary", { name: "Asset details" });
    expect(screen.queryByText("Read-only media access")).not.toBeInTheDocument();
    expect(within(inspector).getByRole("textbox", { name: "Name" })).toBeEnabled();
    expect(within(inspector).getByRole("textbox", { name: "License" })).toBeEnabled();
    expect(within(inspector).getByRole("textbox", { name: "Description" })).toHaveValue("Main production room");
    expect(within(inspector).getByRole("textbox", { name: "Alt-text suggestion" })).toHaveValue("Monitors and switchers");
    expect(within(inspector).getByRole("combobox", { name: "Tags" })).toBeEnabled();
    expect(within(inspector).getByText("studio")).toBeInTheDocument();
    const primaryCategory = within(inspector).getByRole("checkbox", { name: "Newsroom (primary)" });
    expect(primaryCategory).toBeChecked();
    expect(primaryCategory).toBeDisabled();
    expect(await within(inspector).findByRole("textbox", { name: "Notes" })).toBeEnabled();
    expect(within(inspector).getByRole("checkbox", { name: "More like this" })).toBeEnabled();
    fireEvent.click(within(inspector).getByRole("button", { name: "About Category assignments" }));
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("The primary category is required and cannot be removed. Other categories improve search and filtering.");
  });

  it("collapses and remembers details sections without making a request", async () => {
    renderRoute("/media/images?selected=asset-one");
    const inspector = await screen.findByRole("complementary", { name: "Asset details" });
    const details = within(inspector).getByRole("button", { name: "Details" });
    const calls = [mocks.list.mock.calls.length, mocks.update.mock.calls.length, mocks.setFavorite.mock.calls.length];

    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(inspector).getByRole("button", { name: "Close details" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Studio control room, image/ }));

    expect(within(await screen.findByRole("complementary", { name: "Asset details" })).getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "false");
    expect([mocks.list.mock.calls.length, mocks.update.mock.calls.length, mocks.setFavorite.mock.calls.length]).toEqual(calls);
  });

  it("uses tag tokens and loaded or recent suggestions without making a request", async () => {
    const pageAsset = { ...asset, id: "asset-two", name: "Trenton skyline", tags: ["trenton", "news"] };
    mocks.list.mockResolvedValue(selection([asset, pageAsset]));
    mocks.update.mockResolvedValue({
      success: true,
      changed: true,
      asset: { ...asset, tags: ["studio", "producer"], version: 3, etag: '"media.YXNzZXQtb25l.3"' },
    });
    localStorage.setItem("njpbs-admin:media-recent-tags:images:editor-1", JSON.stringify(["transportation"]));
    renderRoute("/media/images?selected=asset-one");
    const tags = await screen.findByRole("combobox", { name: "Tags" });
    const calls = [mocks.list.mock.calls.length, mocks.update.mock.calls.length, mocks.setFavorite.mock.calls.length];

    fireEvent.change(tags, { target: { value: "tr" } });
    expect(await screen.findByRole("option", { name: "trenton" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "transportation" })).toBeInTheDocument();
    expect(screen.getByText("From this page and your recent tags.")).toBeInTheDocument();
    expect([mocks.list.mock.calls.length, mocks.update.mock.calls.length, mocks.setFavorite.mock.calls.length]).toEqual(calls);

    fireEvent.change(tags, { target: { value: "switcher," } });
    expect(screen.getByRole("button", { name: "Remove tag switcher" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove tag switcher" }));
    fireEvent.change(tags, { target: { value: "producer," } });
    expect(screen.getByRole("button", { name: "Save details" })).toBeEnabled();
    expect(localStorage.getItem("njpbs-admin:media-recent-tags:images:editor-1")).toBe(JSON.stringify(["transportation"]));

    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(
      "id-token",
      asset,
      expect.objectContaining({ tags: ["studio", "producer"] }),
    ));
    await waitFor(() => expect(localStorage.getItem("njpbs-admin:media-recent-tags:images:editor-1")).toBe(
      JSON.stringify(["producer", "transportation"]),
    ));
  });

  it("guards and rejects an unfinished tag without making a save request", async () => {
    renderRoute("/media/images?selected=asset-one");
    const tags = await screen.findByRole("combobox", { name: "Tags" });

    fireEvent.change(tags, { target: { value: "unfinished" } });
    expect(screen.getByRole("button", { name: "Save details" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Press Enter or comma to add the tag before saving.")).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(tags).toHaveValue("unfinished");

    fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
    expect(tags).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save details" })).toBeDisabled();
  });

  it("keeps the narrow details sheet and its leave prompt usable on Back", async () => {
    const previousMatchMedia = window.matchMedia;
    const overlayRoot = document.createElement("div");
    overlayRoot.id = "admin-overlay-root";
    document.body.append(overlayRoot);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: /max-width:\s*61\.99rem/.test(query),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    try {
      const { router } = renderRoute("/media/images");
      const opener = await screen.findByRole("button", { name: /^Studio control room, image/ });
      opener.focus();
      fireEvent.click(opener);
      const sheet = await screen.findByRole("dialog", { name: "Asset details" });
      expect(sheet).toHaveClass("ui-inspector-sheet");
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });

      await act(async () => { await router.navigate(-1); });
      const prompt = await screen.findByRole("dialog", { name: "Leave with unsaved changes?" });
      expect(prompt.closest("[inert]")).toBeNull();
      expect(within(prompt).getByRole("button", { name: "Keep editing" })).toBeEnabled();
      fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
      fireEvent.click(screen.getByRole("button", { name: "Close details" }));
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      overlayRoot.remove();
      Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
    }
  });

  it("resizes image details locally without making a request", async () => {
    renderRoute("/media/images?selected=asset-one");
    const handle = await screen.findByRole("separator", { name: "Resize details" });
    const calls = [mocks.list.mock.calls.length, mocks.update.mock.calls.length, mocks.setFavorite.mock.calls.length];

    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(handle).toHaveAttribute("aria-valuenow", "21");
    expect(localStorage.getItem("cms.inspector.images.width")).toBe("21");
    expect([mocks.list.mock.calls.length, mocks.update.mock.calls.length, mocks.setFavorite.mock.calls.length]).toEqual(calls);
  });

  it("shows and removes an archived assignment while keeping the primary", async () => {
    const assignedAsset = {
      ...asset,
      categories: ["news", "archived"],
    };
    mocks.list.mockResolvedValue(selection([assignedAsset]));
    mocks.update.mockResolvedValue({
      success: true,
      changed: true,
      asset: { ...assignedAsset, categories: ["news"], version: 3 },
    });
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    );

    const archived = screen.getByRole("checkbox", {
      name: "Archive (archived)",
    });
    expect(archived).toBeChecked();
    expect(archived).toBeEnabled();
    expect(
      screen.getByRole("checkbox", { name: "Newsroom (primary)" }),
    ).toBeDisabled();
    fireEvent.click(archived);
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        "id-token",
        assignedAsset,
        expect.objectContaining({ categories: ["news"] }),
      ),
    );
  });

  it("validates an uploaded filename against its MIME type before saving", async () => {
    renderRoute("/media?selected=asset-one");

    const filename = await screen.findByRole("textbox", { name: "Filename" });
    fireEvent.change(filename, { target: { value: "studio.jpg" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    expect(
      await screen.findByText("Use .png for this image/png file."),
    ).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects C1 control characters in uploaded filenames", async () => {
    renderRoute("/media?selected=asset-one");

    const filename = await screen.findByRole("textbox", { name: "Filename" });
    fireEvent.change(filename, { target: { value: "studio\u0085.png" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    expect(
      await screen.findByText("Filename contains invalid characters."),
    ).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("prevents upload while media details have unsaved changes", async () => {
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved control room" },
    });
    const upload = screen.getByRole("button", { name: "Upload media" });
    expect(upload).toHaveAttribute("aria-disabled", "true");
    expect(upload).toHaveAccessibleDescription("Save or discard details first.");
    fireEvent.click(upload);
    expect(document.querySelector(".media-upload-sheet")).toHaveAttribute("hidden");

    const dropTarget = document.querySelector<HTMLElement>(".media-drop-target");
    if (!dropTarget) throw new Error("The media drop target is missing.");
    const blockedFile = new File(["image"], "blocked.png", { type: "image/png" });
    fireEvent.dragEnter(dropTarget, { dataTransfer: { files: [blockedFile], types: ["Files"] } });
    expect(document.querySelector(".media-drop-overlay")).toHaveTextContent("Save or discard details first");
    fireEvent.drop(dropTarget, { dataTransfer: { files: [blockedFile], types: ["Files"] } });
    expect(screen.queryByText("blocked.png")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
    expect(screen.getByRole("button", { name: "Upload media" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Upload media" })).toBeEnabled();
  });

  it("opens the upload sheet from Command-U and routes an allowed file drop", async () => {
    renderRoute("/media/images");
    const card = await screen.findByRole("button", { name: /^Studio control room/ });
    const search = screen.getByRole("searchbox", { name: "Search media" });
    const sheet = document.querySelector<HTMLElement>(".media-upload-sheet");
    if (!sheet) throw new Error("The upload sheet is missing.");

    search.focus();
    fireEvent.keyDown(search, { key: "u", metaKey: true });
    expect(sheet).toHaveAttribute("hidden");

    card.focus();
    fireEvent.keyDown(card, { key: "u", metaKey: true });
    expect(screen.getByRole("complementary", { name: "Upload media" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(card).toHaveFocus());

    fireEvent.keyDown(card, { key: "y", metaKey: true });
    const quickLook = await screen.findByRole("dialog", { name: "Quick Look: Studio control room" });
    fireEvent.keyDown(quickLook, { key: "u", metaKey: true });
    expect(sheet).toHaveAttribute("hidden");
    fireEvent.keyDown(quickLook, { key: "Escape" });
    await waitFor(() => expect(quickLook).not.toBeInTheDocument());

    card.blur();
    fireEvent.keyDown(window, { key: "u", metaKey: true });
    expect(screen.getByRole("complementary", { name: "Upload media" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toHaveFocus());

    const dropTarget = document.querySelector<HTMLElement>(".media-drop-target");
    if (!dropTarget) throw new Error("The media drop target is missing.");
    const file = new File(["image"], "dropped.png", { type: "image/png" });
    fireEvent.dragEnter(dropTarget, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(document.querySelector(".media-drop-overlay")).toHaveTextContent("Drop to upload to Images");
    fireEvent.drop(dropTarget, { dataTransfer: { files: [file], types: ["Files"] } });

    expect(screen.getByRole("complementary", { name: "Upload media" })).toBeVisible();
    expect(screen.getByText("dropped.png")).toBeInTheDocument();
  });

  it("reopens a completed queue from the compact upload tray", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width: 61.99rem"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    try {
      const compactAsset = { ...asset, id: "asset-compact", name: "Compact asset", originalName: "compact.png" };
      const nextAsset = { ...asset, id: "asset-next", name: "Next asset", originalName: "next.png" };
      mocks.upload
        .mockResolvedValueOnce({ success: true, asset: compactAsset })
        .mockResolvedValueOnce({ success: true, asset: nextAsset });
      mocks.list.mockResolvedValue(selection([nextAsset, compactAsset, asset]));
      renderRoute("/media/images");
      fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
      fireEvent.change(screen.getByLabelText(/Files/), {
        target: { files: [new File(["image"], "compact.png", { type: "image/png" })] },
      });
      fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
        target: { value: "NJ PBS owned" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
      const pill = await screen.findByRole("button", { name: "Open upload details, Uploaded 1 of 1" });

      fireEvent.click(pill);

      const sheet = screen.getByRole("dialog", { name: "Upload media" });
      expect(within(sheet).getByText("compact.png")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Upload progress" })).toBeInTheDocument();

      fireEvent.change(within(sheet).getByLabelText(/Add files/), {
        target: { files: [new File(["next"], "next.png", { type: "image/png" })] },
      });
      await waitFor(() => expect(screen.queryByText("Media uploaded")).not.toBeInTheDocument());
      expect(within(sheet).queryByText("compact.png")).not.toBeInTheDocument();
      const pendingUnload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(pendingUnload);
      expect(pendingUnload.defaultPrevented).toBe(true);
      fireEvent.click(within(sheet).getByRole("button", { name: "Upload" }));

      expect(await screen.findByText("Next asset is ready to use.")).toBeInTheDocument();
      expect(screen.queryByText("Compact asset is ready to use.")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hides media details while an upload is open", async () => {
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));

    expect(screen.getByLabelText(/File/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save details" }),
    ).not.toBeInTheDocument();
  });

  it("reloads the current filtered page after a metadata save", async () => {
    const savedAsset = {
      ...asset,
      name: "Main control room",
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
      updatedAt: "2026-08-13T13:00:00.000Z",
    };
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    );
    const callsBeforeSave = mocks.list.mock.calls.length;
    mocks.list.mockResolvedValue(selection([savedAsset]));

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Main control room" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(mocks.list.mock.calls.length).toBeGreaterThan(callsBeforeSave),
    );
  });

  it("adopts a refreshed asset version before the next metadata save", async () => {
    const refreshedAsset = {
      ...asset,
      name: "Remote control room name",
      description: "Updated by another editor",
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
      updatedAt: "2026-08-13T13:00:00.000Z",
    };
    renderRoute("/media?selected=asset-one");
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(
      "Studio control room",
    );
    mocks.list.mockResolvedValue(selection([refreshedAsset]));

    fireEvent.click(screen.getByRole("button", { name: /^Sort:/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sort" })).getByRole("radio", { name: "Name" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "Remote control room name",
      );
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Final control room name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith(
        "id-token",
        refreshedAsset,
        expect.objectContaining({
          name: "Final control room name",
          description: "Updated by another editor",
        }),
      );
    });
  });

  it("protects unsaved metadata when the inspector closes", async () => {
    renderRoute();
    fireEvent.click(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved name" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Close details" }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "Leave with unsaved changes?",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Unsaved name",
    );
  });

  it("keeps the image route while media details have unsaved work", async () => {
    const { router } = renderRoute("/media/images?selected=asset-one");
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("Studio control room");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved name" },
    });

    fireEvent.click(screen.getByRole("link", { name: /^Videos/ }));
    expect(router.state.location.pathname).toBe("/media/images");
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));

    expect(router.state.location.pathname).toBe("/media/images");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved name");
  });

  it("shows an honest empty state", async () => {
    mocks.list.mockResolvedValue(selection([]));
    renderRoute();

    expect(await screen.findByText("No media found")).toBeInTheDocument();
    expect(
      screen.getByText("Change or clear the current filters."),
    ).toBeInTheDocument();
  });

  it("reloads a fresh asset after an ETag conflict", async () => {
    const freshAsset = {
      ...asset,
      originalName: "fresh-control-room.png",
      name: "Fresh control room name",
      version: 3,
      etag: '"media.YXNzZXQtb25l.3"',
    };
    mocks.update.mockRejectedValueOnce(
      new HttpError(412, "Reload before saving."),
    );
    renderRoute("/media?selected=asset-one");

    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Stale local name" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Filename" }), {
      target: { value: "stale-control-room.png" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    expect(
      await screen.findByText("This asset changed. Reload it before saving."),
    ).toBeInTheDocument();
    const callsBeforeReload = mocks.list.mock.calls.length;
    mocks.list.mockResolvedValue(selection([freshAsset]));
    fireEvent.click(screen.getByRole("button", { name: "Reload asset" }));

    await waitFor(() =>
      expect(mocks.list.mock.calls.length).toBeGreaterThan(callsBeforeReload),
    );
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(
      "Fresh control room name",
    );
    expect(screen.getByRole("textbox", { name: "Filename" })).toHaveValue(
      "fresh-control-room.png",
    );
  });

  it("removes an asset selection that is absent from the loaded page", async () => {
    const { router } = renderRoute("/media?selected=missing-asset");

    expect(
      await screen.findByRole("button", { name: /^Studio control room/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(router.state.location.search).not.toContain("selected="),
    );
  });
});


it("opens a verified related result outside the keyword page without rewriting the query", async () => {
  mocks.meaningAsset = { ...asset, id: "related-asset", name: "Verified related photo" };
  mocks.list.mockResolvedValue(selection([]));
  const { router } = renderRoute("/media?q=local+taxes");
  await screen.findByText("No keyword matches");
  fireEvent.click(screen.getByRole("button", { name: "Open related media fixture" }));
  expect(await detailsHeading("Verified related photo")).toBeInTheDocument();
  const params = new URLSearchParams(router.state.location.search);
  expect(params.get("q")).toBe("local taxes");
  expect(params.get("selected")).toBe("related-asset");
});

// Characterization tests for the images page rewrite (slice 2e). They pass on the page before the
// toolbar replaced its intro, rail and search form, and they must still pass after it.
describe("MediaRoute images page messages", () => {
  it("shows Media library could not be loaded with Try again, which retries once", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Media service unavailable")).mockResolvedValue(selection());
    renderRoute("/media/images");
    const message = await screen.findByRole("alert");
    expect(message).toHaveTextContent("Media library could not be loaded");
    expect(message).toHaveTextContent("Media service unavailable");
    const callsBeforeRetry = mocks.list.mock.calls.length;
    fireEvent.click(within(message).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    expect(screen.queryByText("Media library could not be loaded")).toBeNull();
  });

  it("shows Favorites need attention with its retry", async () => {
    mocks.listFavoriteStates.mockRejectedValueOnce(new Error("Favorites are offline"));
    renderRoute("/media/images");
    const message = (await screen.findByText("Favorites need attention")).closest(".inline-message") as HTMLElement;
    expect(message).toHaveTextContent("Favorites could not be loaded.");
    const callsBeforeRetry = mocks.listFavoriteStates.mock.calls.length;
    fireEvent.click(within(message).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(mocks.listFavoriteStates).toHaveBeenCalledTimes(callsBeforeRetry + 1));
    await waitFor(() => expect(screen.queryByText("Favorites need attention")).toBeNull());
  });

  it("announces Items added to collection", async () => {
    mocks.listCollections.mockImplementation(async (_token: string, query: { scope: string }) => ({
      success: true,
      collections: query.scope === "private" ? [{
        id: "c".repeat(64), scope: "private", name: "Homepage package", description: "", lifecycle: "active",
        version: 1, membershipVersion: 1, cover: null, canEdit: true, createdAt: null, updatedAt: null, itemCount: 0,
      }] : [],
      nextCursor: null,
      hasMore: false,
    }));
    renderRoute("/media/images");
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Add to collection" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Homepage package/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add selected to collection" })).getByRole("button", { name: "Add to collection" }));
    const notice = (await screen.findByText("Items added to collection")).closest("[role=status]");
    expect(notice).toHaveTextContent("1 item was added to Homepage package.");
  });

  it("says Select no more than 30 items for one collection change. once 31 are selected", async () => {
    mocks.list.mockResolvedValue(selection(pageOf(31)));
    renderRoute("/media/images");
    fireEvent.click(await screen.findByRole("checkbox", { name: /^Select Image 00( for a collection)?$/ }));
    const bar = screen.getByRole("group", { name: "Collection selection" });
    expect(within(bar).queryByRole("alert")).toBeNull();
    fireEvent.click(within(bar).getByRole("checkbox", { name: "Select this page" }));
    expect(within(bar).getByRole("alert")).toHaveTextContent("Select no more than 30 items for one collection change.");
    expect(within(bar).getByRole("button", { name: "Add to collection" })).toBeDisabled();
  });

  it("keeps Selection carries across media pages and filters. as the selection bar's info", async () => {
    renderRoute("/media/images");
    fireEvent.click(await screen.findByRole("checkbox", { name: /^Select Studio control room( for a collection)?$/ }));
    const bar = screen.getByRole("group", { name: "Collection selection" });
    expect(within(bar).getByRole("button", { name: "About selection" }))
      .toHaveAccessibleDescription("Selection carries across media pages and filters.");
  });

  it("warns that media categories could not be loaded and offers no Upload control", async () => {
    mocks.listCategories.mockRejectedValue(new Error("offline"));
    renderRoute("/media/images");
    expect(await screen.findByText("Media categories could not be loaded")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Upload/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Upload/ })).toBeNull();
  });

  it("keeps tile details available with a receipt and opens its uploaded asset", async () => {
    const uploaded = { ...asset, id: "asset-two", name: "News desk", originalName: "news-desk.png", etag: '"media.YXNzZXQtdHdv.1"' };
    mocks.upload.mockResolvedValue({ success: true, asset: uploaded });
    renderRoute("/media/images");
    fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
    mocks.list.mockResolvedValue(selection([uploaded, asset]));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [new File(["bytes"], "news-desk.png", { type: "image/png" })] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), { target: { value: "NJ PBS owned" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const title = await screen.findByText("Media uploaded");
    await waitFor(() => expect(title.closest("[tabindex='-1']")).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: /^Studio control room, image/ }));
    expect(await detailsHeading("Studio control room")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View News desk" }));
    expect(await detailsHeading("News desk")).toBeInTheDocument();
  });

  it("waits to reload a finished upload until dirty asset details are discarded", async () => {
    const uploaded = { ...asset, id: "asset-two", name: "News desk", originalName: "news-desk.png" };
    let resolveUpload: (value: { success: true; asset: MediaAssetSummary }) => void = () => {};
    mocks.upload.mockReturnValue(new Promise(resolve => { resolveUpload = resolve; }));
    const { router } = renderRoute("/media/images");
    fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [new File(["bytes"], "news-desk.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await screen.findByRole("button", { name: /^.+: Uploading…$/ });
    fireEvent.click(screen.getByRole("button", { name: "Close upload" }));

    await act(async () => { await router.navigate("/media/images?selected=asset-one"); });
    await detailsHeading("Studio control room");
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved control room" } });
    name.focus();
    const callsBeforeFinish = mocks.list.mock.calls.length;
    mocks.list.mockResolvedValue(selection([uploaded, asset]));

    await act(async () => { resolveUpload({ success: true, asset: uploaded }); });

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved control room");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    expect(mocks.list).toHaveBeenCalledTimes(callsBeforeFinish);

    fireEvent.click(screen.getByRole("button", { name: "Cancel changes" }));
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(callsBeforeFinish));
    await waitFor(() => expect(router.state.location.search).toContain("selected=asset-two"));
  });
});

describe("MediaRoute images toolbar", () => {
  const categoryPage = () => ({
    ...selection([asset, { ...asset, id: "asset-arts", name: "Gallery opening", category: "arts", categories: ["arts"] }]),
    categoryCounts: { news: 1, arts: 1 },
  });
  const openFilterAt = (property: string) => {
    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    const dialog = screen.getByRole("dialog", { name: "Filter" });
    fireEvent.click(within(dialog).getByRole("button", { name: property }));
    return dialog;
  };
  const params = (router: { state: { location: { search: string } } }) => new URLSearchParams(router.state.location.search);
  const dirtyDetails = async () => {
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Unsaved control room" } });
  };

  it("removes the intro, filter rail and always-visible collection toolbar", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    expect(screen.queryByRole("region", { name: "Media filters" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: "Media library" })).toBeNull();
    expect(screen.queryByText(/Selection carries across/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    const heading = screen.getByRole("heading", { level: 2, name: "Images" });
    expect(heading).toHaveClass("sr-only");
    expect(heading).toHaveAttribute("id", "media-library-heading");
    expect(screen.getByRole("region", { name: "Images" })).toHaveClass("media-library");
    // The route heading the emulator profile waits for stays.
    expect(screen.getByRole("toolbar", { name: "Library controls" })).toBeInTheDocument();
  });

  it("filters by Type through the Filter popover and shows a removable chip after the 300ms commit", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const calls = mocks.list.mock.calls.length;
    vi.useFakeTimers();
    try {
      const dialog = openFilterAt("Type");
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "Images" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(299); });
      expect(params(router).getAll("kind")).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(params(router).getAll("kind")).toEqual(["image"]);
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    } finally {
      vi.useRealTimers();
    }
    expect(mocks.list).toHaveBeenCalledTimes(calls + 1);
    expect(mocks.list).toHaveBeenLastCalledWith("id-token", expect.objectContaining({ kinds: ["image"], page: 1 }), undefined, expect.objectContaining({ favorites: true }));
    expect(screen.getByRole("button", { name: "Edit filter Type: Images" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter Type: Images" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter, 1 applied" })).toBeInTheDocument();
  });

  it.each([1280, 390])("restores the canonical image filters with no write at %ipx", async (width) => {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("matchMedia", (query: string) => {
      const max = /max-width:\s*([\d.]+)rem/.exec(query);
      return {
        matches: max ? width <= Number(max[1]) * 16 : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      };
    });
    try {
      mocks.list.mockImplementation(async (_token: string, query: { page?: number }) => ({
        ...selection(),
        page: query.page ?? 1,
        pageCount: 3,
      }));
      const undoUser = `filter-undo-${width}`;
      const { router } = renderRouteWithNotices(
        "/media/images?unknown=drop&view=weekly&selected=asset-one&page=2&direction=asc&sort=name&q=%20studio%20&category=news&kind=image",
        {
          ...shell,
          principal: { ...shell.principal, id: undoUser },
          user: { ...shell.user, uid: undoUser },
        },
      );
      const clear = await screen.findByRole("button", { name: "Clear all" });
      const listCalls = mocks.list.mock.calls.length;
      const writes = [
        mocks.update,
        mocks.remove,
        mocks.upload,
        mocks.replace,
        mocks.setFavorite,
        mocks.setFavorites,
        mocks.mutateCollection,
        mocks.setCollectionItems,
      ];
      const writeCounts = writes.map((mock) => mock.mock.calls.length);

      fireEvent.click(clear);
      await waitFor(() => expect(router.state.location.search).toBe(
        "?sort=name&direction=asc&selected=asset-one",
      ));
      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(listCalls + 1));
      const notice = await screen.findByRole("region", { name: "Notifications" });
      await waitFor(() => expect(notice).toHaveTextContent("Filters cleared."));
      fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));

      await waitFor(() => expect(router.state.location.search).toBe(
        "?q=studio&category=news&kind=image&sort=name&direction=asc&selected=asset-one&view=weekly",
      ));
      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(listCalls + 2));
      expect(writes.map((mock) => mock.mock.calls.length)).toEqual(writeCounts);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("commits two quick Category toggles as one list request", async () => {
    mocks.list.mockResolvedValue(categoryPage());
    const { router } = renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Gallery opening/ });
    const dialog = openFilterAt("Category");
    await within(dialog).findByRole("checkbox", { name: "Newsroom" });
    const calls = mocks.list.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Newsroom" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Arts" }));
    await waitFor(() => expect(params(router).getAll("category")).toEqual(["news", "arts"]));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 1));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(mocks.list).toHaveBeenCalledTimes(calls + 1);
    expect(mocks.list).toHaveBeenLastCalledWith("id-token", expect.objectContaining({ categories: ["news", "arts"], page: 1 }), undefined, expect.objectContaining({ favorites: true }));
  });

  it("while details are unsaved, a Type toggle asks to leave at once; Keep editing restores the option and returns focus to Filter", async () => {
    const { router } = renderRoute("/media/images?selected=asset-one");
    await dirtyDetails();
    const dialog = openFilterAt("Type");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Images" }));
    // No pause: the prompt follows the click that caused it.
    const prompt = screen.getByRole("dialog", { name: "Leave with unsaved changes?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Filter/ })).toHaveFocus());
    expect(params(router).getAll("kind")).toEqual([]);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved control room");
    const reopened = openFilterAt("Type");
    expect(within(reopened).getByRole("checkbox", { name: "Images" })).not.toBeChecked();
  });

  it("a blocked Sort change returns focus to Sort after Keep editing", async () => {
    const { router } = renderRoute("/media/images?selected=asset-one");
    await dirtyDetails();
    fireEvent.click(screen.getByRole("button", { name: /^Sort:/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sort" })).getByRole("radio", { name: "Name" }));
    const prompt = screen.getByRole("dialog", { name: "Leave with unsaved changes?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Sort:/ })).toHaveFocus());
    expect(params(router).get("sort")).toBeNull();
    expect(screen.getByRole("button", { name: "Sort: Last updated, newest first" })).toBeInTheDocument();
  });

  it("removes one chip, clears all chips and the search, and keeps sort", async () => {
    const { router } = renderRoute("/media/images?q=studio&kind=image&kind=document&category=news&sort=name&page=2");
    await screen.findByRole("button", { name: /^Studio control room/ });
    await screen.findByRole("button", { name: "Remove filter Category: Newsroom" });
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Category: Newsroom" }));
    await waitFor(() => expect(params(router).getAll("category")).toEqual([]));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(params(router).getAll("kind")).toEqual(["image", "document"]);
    expect(params(router).get("q")).toBe("studio");
    expect(params(router).get("sort")).toBe("name");
    expect(params(router).get("page")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove filter Type: Documents" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(params(router).getAll("kind")).toEqual([]));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(params(router).get("q")).toBeNull();
    expect(params(router).get("sort")).toBe("name");
    expect(screen.getByRole("searchbox", { name: "Search media" })).toHaveValue("");
    expect(screen.queryByRole("group", { name: "Applied filters" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Filter/ })).toHaveFocus();
  });

  it("with the list failing, a chip can still be removed and search still works", async () => {
    mocks.list.mockRejectedValue(new Error("Media service unavailable"));
    const { router } = renderRoute("/media/images?category=news");
    await screen.findByText("Media service unavailable");
    fireEvent.click(await screen.findByRole("button", { name: "Remove filter Category: Newsroom" }));
    await waitFor(() => expect(params(router).getAll("category")).toEqual([]));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search media" }), { target: { value: "tower" } });
    await waitFor(() => expect(params(router).get("q")).toBe("tower"));
    // With no counts in hand after the failures, the call may still carry the count flag.
    await waitFor(() => expect(mocks.list.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ q: "tower", categories: [] })));
  });

  it("reopens a filter picker from its chip and returns focus to that chip on Escape", async () => {
    renderRoute("/media/images?kind=image");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const chip = screen.getByRole("button", { name: "Edit filter Type: Images" });
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Filter" });
    await waitFor(() => expect(within(dialog).getByRole("checkbox", { name: "Images" })).toHaveFocus());
    expect(chip).toHaveAttribute("aria-haspopup", "dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "All filters" }));
    expect(within(dialog).getByRole("button", { name: "Type" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Type" }));
    expect(within(dialog).getByRole("checkbox", { name: "Images" })).toHaveFocus();
    fireEvent.keyDown(within(dialog).getByRole("checkbox", { name: "Images" }), { key: "Escape" });
    expect(chip).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Filter" })).toBeNull();
  });

  it("writes a chosen page tag into search without a chip", async () => {
    const { router } = renderRoute("/media/images?q=control");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const dialog = openFilterAt("Tag");
    fireEvent.click(within(dialog).getByRole("button", { name: "studio" }));
    await waitFor(() => expect(params(router).get("q")).toBe("studio"));
    expect(screen.getByRole("searchbox", { name: "Search media" })).toHaveValue("studio");
    expect(screen.getByRole("searchbox", { name: "Search media" })).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Applied filters" })).toBeNull();
  });

  it("focuses search with /; Escape with text writes an empty q at once; an empty field blurs", async () => {
    const { router } = renderRoute("/media/images?q=studio");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const search = screen.getByRole("searchbox", { name: "Search media" });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(params(router).get("q")).toBeNull();
    expect(router.state.historyAction).toBe("REPLACE");
    expect(search).toHaveValue("");
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).not.toHaveFocus();
  });

  it("Escape in search while details are unsaved clears the field with no leave prompt", async () => {
    const { router } = renderRoute("/media/images?q=studio&selected=asset-one");
    await dirtyDetails();
    const search = screen.getByRole("searchbox", { name: "Search media" });
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search).toHaveValue("");
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();
    expect(params(router).get("q")).toBe("studio");
  });

  it("shows the lock on search while details are unsaved and still suppresses the typing-pause search", async () => {
    const { router } = renderRoute("/media/images?selected=asset-one");
    await dirtyDetails();
    const search = screen.getByRole("searchbox", { name: "Search media" });
    expect(search).toHaveAccessibleDescription("Save or discard details first.");
    const calls = mocks.list.mock.calls.length;
    fireEvent.change(search, { target: { value: "camera" } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(params(router).get("q")).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(calls);
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();
  });

  it("changing sort from the Sort dialog resets to page 1 with one list request", async () => {
    const { router } = renderRoute("/media/images?page=2");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const calls = mocks.list.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Sort:/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sort" })).getByRole("radio", { name: "Name" }));
    await waitFor(() => expect(params(router).get("sort")).toBe("name"));
    expect(params(router).get("page")).toBeNull();
    expect(router.state.historyAction).toBe("REPLACE");
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 1));
    expect(mocks.list).toHaveBeenLastCalledWith("id-token", expect.objectContaining({ sort: "name", page: 1 }), undefined, expect.objectContaining({ favorites: true }));
    expect(screen.getByRole("button", { name: "Sort: Name, Z–A" })).toBeInTheDocument();
  });

  it("uses one cursor page action, one list request and one result status", async () => {
    mocks.list.mockImplementation(cursorPagedList(2));
    const { router } = renderRoute("/media/images");
    await screen.findByRole("navigation", { name: "Media pages" });
    const calls = mocks.list.mock.calls.length;
    const pager = screen.getByRole("navigation", { name: "Media pages" });
    expect(within(pager).getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getAllByRole("status").filter((node) => node.classList.contains("media-result-status"))).toHaveLength(1);

    fireEvent.click(within(pager).getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 1));
    expect(mocks.list).toHaveBeenLastCalledWith("id-token", expect.objectContaining({
      cursor: cursorTokens[0], paging: "cursor", page: 2,
    }), undefined, expect.objectContaining({ favorites: true }));
    expect(params(router).get("page")).toBeNull();
    expect(document.querySelector(".media-result-status")).toHaveTextContent("90 results");
    expect(screen.getByText("Page 2 · reload returns to page 1")).toBeVisible();
    expect(within(pager).getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("applies Display thumbnail size, density and card fields without a list request", async () => {
    mocks.list.mockResolvedValue(selection([{ ...asset, tags: ["studio", "control", "switcher", "news"] }]));
    renderRoute("/media/images");
    const card = (await screen.findByRole("button", { name: /^Studio control room/ })).closest(".media-tile") as HTMLElement;
    const section = document.querySelector("section.media-library") as HTMLElement;
    expect(section).toHaveAttribute("data-thumbnail", "m");
    expect(section).not.toHaveAttribute("data-density");
    // The tile meta line: file facts in Display order, then the tag count on its own line.
    const meta = () => Array.from(card.querySelectorAll(".media-tile-meta [data-field]")).map((fact) => [fact.getAttribute("data-field"), fact.textContent]);
    expect(meta()).toEqual([["type", "Image"], ["size", " · 2.0 KB"], ["dimensions", " · 1600 × 900"], ["tags", " · 4 tags"]]);
    expect(card.querySelector(".media-tile-meta")).toHaveTextContent("Image · 2.0 KB · 1600 × 900 · 4 tags");

    const calls = mocks.list.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const panel = screen.getByRole("dialog", { name: "Display" });
    const layout = within(panel).getByRole("radiogroup", { name: "Layout" });
    expect(within(layout).getByRole("radio", { name: "Grid" })).toBeChecked();
    expect(within(layout).getByRole("radio", { name: "Grid" })).toHaveFocus();
    const name = within(panel).getByRole("checkbox", { name: "Name" });
    expect(name).toBeChecked();
    expect(name).toBeDisabled();
    expect(name).toHaveAccessibleDescription("Always shown");
    const perPage = within(panel).getByRole("combobox", { name: "Per page" });
    expect(perPage).toBeDisabled();
    expect(perPage).toHaveValue("30");
    expect(perPage).toHaveAccessibleDescription("Set by the server");
    fireEvent.click(within(panel).getByRole("radio", { name: "Large" }));
    fireEvent.change(within(panel).getByLabelText("Density"), { target: { value: "compact" } });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Category" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Dimensions" }));
    expect(section).toHaveAttribute("data-thumbnail", "l");
    expect(section).toHaveAttribute("data-density", "compact");
    expect(meta()).toEqual([["type", "Image"], ["category", " · Newsroom"], ["size", " · 2.0 KB"], ["tags", " · 4 tags"]]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.list).toHaveBeenCalledTimes(calls);
  });

  it("opens Display with Shift+V", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search media" }), { key: "V", shiftKey: true });
    expect(screen.queryByRole("dialog", { name: "Display" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "V", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Display" })).toBeInTheDocument();
  });

  it("clears a valid view id on a filter change and preserves an explicit view until upload", async () => {
    const weekly = { id: "weekly", name: "Weekly", surface: "images" as const, query: "" };
    mocks.loadSavedViews.mockResolvedValueOnce([weekly]);
    mocks.list.mockImplementation(cursorPagedList(2));
    const viewUser = "image-view-change-user";
    const { router } = renderRoute("/media/images?view=weekly", {
      ...shell,
      principal: { ...shell.principal, id: viewUser },
      user: { ...shell.user, uid: viewUser },
    });
    await screen.findByRole("button", { name: /^Studio control room/ });

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    const filter = screen.getByRole("dialog", { name: "Filter" });
    await within(filter).findByRole("button", { name: weekly.name });
    fireEvent.click(within(filter).getByRole("button", { name: "Type" }));
    fireEvent.click(within(filter).getByRole("checkbox", { name: "Images" }));
    await waitFor(() => expect(params(router).getAll("kind")).toEqual(["image"]));
    expect(params(router).get("view")).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Filter" }), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: /^Sort:/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Sort" })).getByRole("radio", { name: "Name" }));
    await waitFor(() => expect(params(router).get("sort")).toBe("name"));
    expect(params(router).get("view")).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sort" }), { key: "Escape" });

    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.list.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      cursor: cursorTokens[0], page: 2,
    })));
    expect(params(router).get("page")).toBeNull();
    expect(params(router).get("view")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Studio control room/ }));
    await waitFor(() => expect(params(router).get("selected")).toBe("asset-one"));
    expect(params(router).get("view")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(params(router).get("selected")).toBeNull());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search media" }), { target: { value: "studio" } });
    await waitFor(() => expect(params(router).get("q")).toBe("studio"));
    expect(params(router).get("view")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: /^Studio control room/ }));
    await startMediaDelete();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));
    expect(await screen.findByText("Media deleted from library")).toBeInTheDocument();
    await waitFor(() => expect(params(router).get("selected")).toBeNull());
    expect(params(router).get("view")).toBeNull();

    await act(async () => { await router.navigate("/media/images?view=weekly&selected=missing-asset"); });
    await waitFor(() => expect(params(router).get("selected")).toBeNull());
    expect(params(router).get("view")).toBe("weekly");

    const uploaded = { ...asset, id: "asset-two", name: "News desk", originalName: "news-desk.png", etag: '"media.YXNzZXQtdHdv.1"' };
    mocks.upload.mockResolvedValue({ success: true, asset: uploaded });
    mocks.list.mockResolvedValue(selection([uploaded, asset]));
    fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [new File(["bytes"], "news-desk.png", { type: "image/png" })] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), { target: { value: "NJ PBS owned" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await screen.findByText("Media uploaded");
    await waitFor(() => expect(params(router).get("selected")).toBe("asset-two"));
    expect(params(router).get("view")).toBeNull();
  });

  it("keeps cursor history in memory, clears the selection and leaves cursors out of the URL", async () => {
    mocks.list.mockImplementation(cursorPagedList(3));
    const { router } = renderRoute("/media/images?selected=asset-one");
    await detailsHeading("Studio control room");
    const paging = screen.getByRole("navigation", { name: "Media pages" });
    expect(within(paging).getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(within(paging).getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.list.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      cursor: cursorTokens[0], page: 2,
    })));
    expect(router.state.historyAction).toBe("PUSH");
    expect(params(router).get("selected")).toBeNull();
    expect(params(router).get("page")).toBeNull();
    expect(router.state.location.search).not.toContain("cursor");
    await screen.findByText("Page 2 · reload returns to page 1");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Media pages" })).getByRole("button", { name: "Previous page" }));
    await screen.findByText("Page 1 · reload returns to page 1");
    expect(mocks.list.mock.calls.at(-1)?.[1]).not.toHaveProperty("cursor");
    expect(router.state.historyAction).toBe("PUSH");
    await act(async () => { await router.navigate(-1); });
    expect(params(router).get("selected")).toBe("asset-one");
  });

  it("does not advance a cursor until a blocked details edit is discarded", async () => {
    mocks.list.mockImplementation(cursorPagedList(2));
    const { router } = renderRoute("/media/images?selected=asset-one");
    await dirtyDetails();
    const calls = mocks.list.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    const prompt = await screen.findByRole("dialog", { name: "Leave with unsaved changes?" });
    expect(mocks.list).toHaveBeenCalledTimes(calls);
    expect(params(router).get("selected")).toBe("asset-one");

    fireEvent.click(within(prompt).getByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 1));
    expect(mocks.list.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      cursor: cursorTokens[0], page: 2,
    }));
    expect(params(router).get("selected")).toBeNull();
    expect(params(router).get("page")).toBeNull();
  });

  it("keeps Next available when one bounded cursor slice has no verified matches", async () => {
    mocks.list.mockImplementation(async (_token: string, query: MediaListQuery) => query.cursor
      ? cursorSelection({ records: [asset], page: 2, total: 1 })
      : cursorSelection({ records: [], nextCursor: cursorTokens[0] }));
    renderRoute("/media/images?q=studio");

    expect(await screen.findByText("Search continues")).toBeVisible();
    expect(screen.getByText("No matches on this page. Continue to search more items.")).toBeVisible();
    expect(screen.queryByText("No keyword matches")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByRole("button", { name: /^Studio control room/ })).toBeVisible();
  });

  it("describes an empty terminal cursor slice as page-local when earlier pages matched", async () => {
    mocks.list.mockImplementation(async (_token: string, query: MediaListQuery) => query.cursor
      ? cursorSelection({ records: [], page: 2, total: 1 })
      : cursorSelection({ records: [asset], nextCursor: cursorTokens[0] }));
    renderRoute("/media/images?q=studio");

    await screen.findByRole("button", { name: /^Studio control room/ });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("No matches on this page")).toBeVisible();
    expect(screen.getByText("Return to a previous page.")).toBeVisible();
    expect(screen.queryByText("No keyword matches")).toBeNull();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("returns the same query to page 1 when the account and principal change", async () => {
    mocks.list.mockImplementation(cursorPagedList(2));
    const router = createMemoryRouter(
      [{ path: "/media/*", element: <MediaRoute /> }],
      { initialEntries: ["/media/images?q=studio"] },
    );
    const view = render(
      <ShellProvider value={shell}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );
    await screen.findByRole("button", { name: /^Studio control room/ });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.list.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      cursor: cursorTokens[0], page: 2,
    })));

    const nextShell = {
      ...shell,
      principal: { ...shell.principal, id: "editor-2" },
      user: { ...shell.user, uid: "editor-2", email: "account-7@example.org" },
    };
    view.rerender(
      <ShellProvider value={nextShell}>
        <RouterProvider router={router} />
      </ShellProvider>,
    );

    await waitFor(() => expect(mocks.list.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      q: "studio", page: 1, paging: "cursor",
    })));
    expect(mocks.list.mock.calls.at(-1)?.[1]).not.toHaveProperty("cursor");
    expect(await screen.findByText("Page 1 · reload returns to page 1")).toBeVisible();
  });

  it("shows the selection bar with Select this page only while items are selected, announces the count from an always-mounted status, and returns focus to the last card after Clear selection", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const status = document.querySelector(".media-selection-status") as HTMLElement;
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveClass("sr-only");
    expect(status).toHaveTextContent("");
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select this page" })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    const bar = screen.getByRole("group", { name: "Collection selection" });
    expect(within(bar).getByRole("checkbox", { name: "Select this page" })).toBeChecked();
    expect(within(bar).getByText(/^1 selected/)).not.toHaveAttribute("role");
    // The note the old selection toolbar showed stays reachable from the bar.
    expect(within(bar).getByRole("button", { name: "About selection" }))
      .toHaveAccessibleDescription("Selection carries across media pages and filters.");
    expect(within(bar).queryByRole("status")).toBeNull();
    expect(status).toHaveTextContent("1 selected");
    expect(document.querySelector(".media-selection-status")).toBe(status);

    fireEvent.click(within(bar).getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    expect(status).toHaveTextContent("No items selected");
    // Decision 3: back to the card that last had focus.
    await waitFor(() => expect(screen.getByRole("button", { name: /^Studio control room, image/ })).toHaveFocus());
  });

  it("Select this page from More selects the page and shows the bar", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    const more = within(screen.getByRole("toolbar", { name: "Library controls" })).getByRole("button", { name: "More actions" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Select this page" }));
    const bar = screen.getByRole("group", { name: "Collection selection" });
    expect(within(bar).getByRole("checkbox", { name: "Select this page" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Studio control room" })).toBeChecked();
    expect(document.querySelector(".media-selection-status")).toHaveTextContent("1 selected");
    expect(more).toHaveFocus();
  });

  it("keeps selection blocked for unsaved upload details after More hides the panel", async () => {
    renderRoute("/media/images");
    fireEvent.click(await screen.findByRole("button", { name: "Upload media" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Queued details" } });
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Library controls" })).getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("complementary", { name: "Upload media" })).toBeNull();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Keyboard shortcuts"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    const resume = screen.getByRole("button", { name: "Continue upload (0)" });
    expect(resume).toHaveTextContent("Continue upload (0)");
    fireEvent.click(resume);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Queued details");
  });

  it("puts Related results at the top of the results, before the grid", async () => {
    mocks.meaningAsset = { ...asset, id: "related-asset", name: "Verified related photo" };
    renderRoute("/media/images?q=studio");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const related = screen.getByRole("button", { name: "Open related media fixture" });
    const results = document.querySelector(".media-results") as HTMLElement;
    expect(results).toContainElement(related);
    const grid = screen.getByRole("grid", { name: "Images" });
    expect(related.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps every chosen card fact on phones and lets one fact too long for the card wrap instead of clipping", async () => {
    const routeCss = readFileSync(resolve(process.cwd(), "src/routes/MediaRoute.css"), "utf8");
    const tileCss = readFileSync(resolve(process.cwd(), "src/components/media/MediaTile.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // The route no longer styles card facts; the shared tile owns them. Display is the one
    // control for card facts, so no width rule hides a chosen fact or clips it with an ellipsis
    // (touch screens have no hover card to show what was cut).
    expect(routeCss).not.toMatch(/media-card-meta|data-field/);
    expect(tileCss).not.toMatch(/\[data-field="[a-z]+"\] \{\s*display: none;/);
    expect(tileCss).not.toMatch(/\.media-tile(\[data-surface="images"\])? \.media-tile-meta \{[^}]*white-space: nowrap;/);
    expect(tileCss).toMatch(/\.media-tile-meta-line \{[^}]*overflow-wrap: anywhere;/);
    expect(tileCss).not.toMatch(/\.media-tile-meta-line \{[^}]*white-space: nowrap;/);
    renderRoute("/media/images");
    const open = await screen.findByRole("button", { name: /^Studio control room, image/ });
    const description = document.getElementById(open.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    expect(description).toContain("1600 × 900");
    expect(description).toContain("1 tag");
  });

  it("keeps the result status inside .media-result-bar after the grid, including at 0 results, and shows the visual updating indicator above the results while refreshing", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    const resultStatus = () => document.querySelector(".media-result-bar [role=status]") as HTMLElement;
    const grid = screen.getByRole("grid", { name: "Images" });
    expect(resultStatus()).toHaveTextContent("1 result");
    expect(grid.compareDocumentPosition(resultStatus()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".media-results-updating")).toBeNull();

    let finish!: (value: ReturnType<typeof selection>) => void;
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(within(openFilterAt("Type")).getByRole("checkbox", { name: "Documents" }));
    await waitFor(() => expect(params(router).getAll("kind")).toEqual(["document"]));
    const updating = await waitFor(() => {
      const element = document.querySelector(".media-results-updating");
      if (!element) throw new Error("No updating indicator");
      return element as HTMLElement;
    });
    expect(updating).toHaveAttribute("aria-hidden", "true");
    expect(updating).toHaveTextContent("Updating results");
    expect(updating.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The polite status also says the list is updating, so a refresh that keeps the same total,
    // such as a sort change, is still announced. The pill above the results is visual only.
    expect(resultStatus()).toHaveTextContent("1 result, updating");

    await act(async () => finish(selection([])));
    await screen.findByText("No media found");
    expect(document.querySelector(".media-results-updating")).toBeNull();
    expect(resultStatus()).toHaveTextContent("Filtered by Type: Documents. 0 results");
    const empty = screen.getByText("No media found");
    expect(empty.compareDocumentPosition(resultStatus()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("hides Upload while the upload form is open and returns focus to Upload after it closes", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    expect(screen.getByLabelText(/Files/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload media" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toHaveFocus());
    expect(document.querySelector(".media-upload-sheet")).toHaveAttribute("hidden");
  });

  it.each([1280, 390])("adds no local mocked CMS request for sheet open or file intake at %ipx", async (width) => {
    vi.stubGlobal("matchMedia", (query: string) => {
      const max = /max-width:\s*([\d.]+)rem/.exec(query);
      return {
        matches: max ? width <= Number(max[1]) * 16 : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      };
    });
    try {
      renderRoute("/media/images");
      await screen.findByRole("button", { name: /^Studio control room/ });
      await waitFor(() => expect(mocks.listFavoriteStates).toHaveBeenCalled());
      const requests = [mocks.list, mocks.listFavoriteStates, mocks.listCollections, mocks.upload]
        .map((mock) => mock.mock.calls.length);

      fireEvent.keyDown(window, { key: "u", metaKey: true });
      fireEvent.change(screen.getByLabelText(/Files/), {
        target: { files: [new File(["image"], `intake-${width}.png`, { type: "image/png" })] },
      });

      expect([mocks.list, mocks.listFavoriteStates, mocks.listCollections, mocks.upload]
        .map((mock) => mock.mock.calls.length)).toEqual(requests);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("makes one list request per query change and none from Display, popovers, chip focus, the current tab, crossing 48rem, the context menu, hover cards, selection, Cmd+A, More or Escape", async () => {
    let phone = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return /max-width:\s*47\.99rem/.test(query) ? phone : false; },
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
    }));
    try {
      const { router } = renderRoute("/media/images?kind=image");
      await screen.findByRole("button", { name: /^Studio control room/ });
      await waitFor(() => expect(mocks.meaningMounts).toBe(1));
      const calls = mocks.list.mock.calls.length;
      const firstProps = mocks.meaningProps.at(-1)!;

      fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Filter" }), { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: /^Sort:/ }));
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Sort" }), { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Display" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Display" })).getByRole("radio", { name: "Small" }));
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Display" }), { key: "Escape" });
      screen.getByRole("button", { name: "Edit filter Type: Images" }).focus();
      fireEvent.click(screen.getByRole("link", { name: /^Images/ }));
      phone = true;
      act(() => { for (const listener of [...listeners]) listener(); });
      expect(screen.getByRole("group", { name: "Filter and sort" })).toBeInTheDocument();
      phone = false;
      act(() => { for (const listener of [...listeners]) listener(); });

      // The grid, the selection bar, the context menu and hover cards are client state.
      const card = screen.getByRole("button", { name: /^Studio control room, image/ });
      fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
      fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
      act(() => card.focus());
      fireEvent.keyDown(card, { key: "a", ctrlKey: true });
      fireEvent.keyDown(card, { key: "Escape" });
      fireEvent.contextMenu(card.closest(".media-tile")!.querySelector(".media-tile-thumb") as HTMLElement);
      fireEvent.keyDown(screen.getByRole("menu", { name: "Studio control room" }), { key: "Escape" });
      // More, its Select this page and Keyboard shortcuts are client state too.
      const more = within(screen.getByRole("toolbar", { name: "Library controls" })).getByRole("button", { name: "More actions" });
      fireEvent.click(more);
      fireEvent.click(screen.getByRole("menuitem", { name: "Select this page" }));
      fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
      fireEvent.click(more);
      fireEvent.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));
      fireEvent.keyDown(screen.getByRole("dialog", { name: "Keyboard shortcuts" }), { key: "Escape" });
      act(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        card.focus();
      });
      await screen.findByRole("group", { name: "Details for Studio control room" }, { timeout: 1500 });
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(mocks.list).toHaveBeenCalledTimes(calls);
      expect(mocks.meaningMounts).toBe(1);
      for (const props of mocks.meaningProps.slice(mocks.meaningProps.indexOf(firstProps))) {
        expect(props.identity).toBe(firstProps.identity);
        expect(props.refreshRevision).toBe(firstProps.refreshRevision);
        expect(props.query).toBe(firstProps.query);
      }

      fireEvent.click(screen.getByRole("button", { name: "Remove filter Type: Images" }));
      await waitFor(() => expect(params(router).getAll("kind")).toEqual([]));
      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 1));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mocks.list).toHaveBeenCalledTimes(calls + 1);
      expect(mocks.meaningMounts).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("typing in search re-renders neither the cards nor the toolbar", async () => {
    renderRoute("/media/images");
    await screen.findByRole("button", { name: /^Studio control room/ });
    await waitFor(() => expect(mocks.listFavoriteStates).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const search = screen.getByRole("searchbox", { name: "Search media" });
    expect(mocks.tileRenders).toBeGreaterThan(0);
    mocks.tileRenders = 0;
    mocks.sortControlRenders = 0;
    fireEvent.change(search, { target: { value: "s" } });
    fireEvent.change(search, { target: { value: "st" } });
    fireEvent.change(search, { target: { value: "stu" } });
    expect(search).toHaveValue("stu");
    expect(mocks.tileRenders).toBe(0);
    expect(mocks.sortControlRenders).toBe(0);
  });
});

describe("MediaRoute images grid", () => {
  const params = (router: { state: { location: { search: string } } }) => new URLSearchParams(router.state.location.search);
  const openControl = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}, image`) });
  const tile = (name: string) => openControl(name).closest(".media-tile") as HTMLElement;
  const status = () => document.querySelector(".media-selection-status") as HTMLElement;
  const requestCounts = () => [
    mocks.list.mock.calls.length,
    mocks.listFavoriteStates.mock.calls.length,
    mocks.setFavorite.mock.calls.length,
    mocks.listCollections.mock.calls.length,
    mocks.setCollectionItems.mock.calls.length,
    mocks.update.mock.calls.length,
    mocks.remove.mock.calls.length,
  ];
  const favoritesSettled = async (name = "Studio control room") => {
    await waitFor(() => expect(screen.getByRole("button", { name: `Add to favorites: ${name}` })).toBeEnabled());
  };
  const privateCollection = () => mocks.listCollections.mockImplementation(async (_token: string, query: { scope: string }) => ({
    success: true,
    collections: query.scope === "private" ? [{
      id: "c".repeat(64), scope: "private", name: "Homepage package", description: "", lifecycle: "active",
      version: 1, membershipVersion: 1, cover: null, canEdit: true, createdAt: null, updatedAt: null, itemCount: 0,
    }] : [],
    nextCursor: null,
    hasMore: false,
  }));

  it("selects from the tile mark without opening details", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    expect(screen.getByRole("group", { name: "Collection selection" })).toHaveTextContent(/^1 selected/);
    expect(tile("Studio control room")).toHaveAttribute("data-selected", "true");
    expect(status()).toHaveTextContent("1 selected");
    expect(screen.queryByRole("button", { name: "Close details" })).toBeNull();
    expect(params(router).get("selected")).toBeNull();
    // Opening keeps the selection; selecting never opens.
    fireEvent.click(openControl("Studio control room"));
    expect(await screen.findByRole("button", { name: "Close details" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Studio control room" })).toBeChecked();
  });

  it("opens the 960 thumbnail in Quick Look, steps without requests, and restores card focus", async () => {
    const first = { ...asset, thumbnails: [{ url: "/studio-480.webp", width: 480, height: 270 }, { url: "/studio-960.webp", width: 960, height: 540 }] };
    const second = { ...asset, id: "asset-two", name: "News desk", url: "/news-desk.jpg" };
    mocks.list.mockResolvedValue(selection([first, second]));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    const thumbnail = tile("Studio control room").querySelector("img");
    expect(thumbnail).toHaveAttribute("src", "/studio-480.webp");
    expect(thumbnail).toHaveAttribute("sizes", "480px");
    expect(thumbnail?.getAttribute("srcset")).not.toContain(first.url);
    const before = requestCounts();
    fireEvent.keyDown(openControl("Studio control room"), { key: "y", metaKey: true });
    const look = await screen.findByRole("dialog", { name: "Quick Look: Studio control room" });
    expect(look.querySelector("img")).toHaveAttribute("src", "/studio-960.webp");
    expect(look.querySelector("img")).toHaveAttribute("alt", first.altText);
    fireEvent.keyDown(look, { key: "ArrowRight" });
    const next = screen.getByRole("dialog", { name: "Quick Look: News desk" });
    expect(within(next).getByRole("status")).toHaveTextContent("2 of 2");
    expect(requestCounts()).toEqual(before);
    fireEvent.keyDown(next, { key: "Escape" });
    await waitFor(() => expect(openControl("News desk")).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: /Quick Look:/ })).toBeNull();
  });

  it("opens the original in the full-size image viewer and steps without a CMS request", async () => {
    const second = { ...asset, id: "asset-two", name: "News desk", url: "/news-desk.jpg" };
    mocks.list.mockResolvedValue(selection([asset, second]));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    const before = requestCounts();
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    expect(viewer.querySelector("img[src='https://media.njpbs.org/studio.png']")).toBeInTheDocument();
    expect(within(viewer.querySelector("header")!).getByRole("button", { name: "Favorite: Studio control room" })).toHaveAttribute("aria-pressed", "false");
    expect(within(viewer.querySelector("header")!).getByRole("status")).toHaveTextContent("1 of 2");
    fireEvent.click(within(viewer).getByRole("button", { name: "Next file" }));
    expect(within(viewer.querySelector("header")!).getByRole("status")).toHaveTextContent("2 of 2");
    expect(viewer.querySelector("img[src='/news-desk.jpg']")).toBeInTheDocument();
    expect(requestCounts()).toEqual(before);
    fireEvent.keyDown(viewer, { key: "Escape" });
    await waitFor(() => expect(openControl("News desk")).toHaveFocus());
  });

  it("confirms a full-size private review once without leaving an empty inspector footer", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("cmsSaveMediaReview")) {
        return new Response(JSON.stringify({ success: true, review: {
          moreLikeThis: false, notes: "Private viewer note", version: 1, updatedAt: "2026-10-05T12:00:00.000Z",
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    const inspector = within(viewer).getByRole("complementary", { name: "Asset details" });
    const notes = await within(inspector).findByRole("textbox", { name: "Notes" });
    await waitFor(() => expect(notes).toBeEnabled());
    fireEvent.change(notes, { target: { value: "Private viewer note" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    await within(inspector).findByText("Your private review is version 1.");
    expect(within(viewer).getByRole("button", { name: "Save details" })).toBeDisabled();
    expect(within(viewer).getAllByText("Your review saved")).toHaveLength(1);
    expect(inspector.querySelector(".ui-inspector-footer")).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("asks before stepping away from unsaved full-size image details", async () => {
    const second = { ...asset, id: "asset-two", name: "News desk" };
    mocks.list.mockResolvedValue(selection([asset, second]));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    const name = within(viewer).getByRole("textbox", { name: "Name" });
    name.focus();
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Next file" }));
    expect(within(viewer).getByText("Unsaved image changes")).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole("button", { name: "Keep editing" }));
    expect(within(viewer).getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved name");
    fireEvent.click(within(viewer).getByRole("button", { name: "Next file" }));
    fireEvent.click(within(viewer).getByRole("button", { name: "Discard changes" }));
    expect(within(viewer.querySelector("header")!).getByRole("status")).toHaveTextContent("2 of 2");
  });

  it("keeps the navigation prompt inside a dirty viewer and closes it after navigation", async () => {
    mocks.list.mockResolvedValue(selection([asset, { ...asset, id: "asset-two", name: "News desk" }]));
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    const name = within(viewer).getByRole("textbox", { name: "Name" });
    name.focus();
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Next file" }));
    expect(within(viewer).getByText("Unsaved image changes")).toBeInTheDocument();
    await act(async () => { await router.navigate("/media/images?q=desk"); });
    expect(within(viewer).getByText("Unsaved media changes")).toBeInTheDocument();
    expect(within(viewer).queryByText("Unsaved image changes")).toBeNull();
    expect(within(viewer).getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.keyDown(viewer, { key: "Escape" });
    expect(within(viewer).getByText("Unsaved media changes")).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole("button", { name: "Keep editing" }));
    expect(router.state.location.search).toBe("");
    await waitFor(() => expect(within(viewer).getByRole("textbox", { name: "Name" })).toHaveFocus());
    await act(async () => { await router.navigate("/media/images?q=desk"); });
    fireEvent.click(within(viewer).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Studio control room" })).toBeNull());
    expect(router.state.location.search).toBe("?q=desk");
  });

  it("ends a routed video when the image viewer confirms leaving the workspace", async () => {
    const restoreLocks = disableWebLocks();
    try {
      mocks.listSources.mockResolvedValue({
        sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
      });
      const { router } = renderRoute("/media/images");
      await screen.findByRole("grid", { name: "Images" });
      act(() => routeChosenFiles([new File(["video"], "clip.mp4", { type: "video/mp4" })]));
      await screen.findByText("Uploads are unavailable in this browser. The selected video was not added.");
      fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
      const viewer = await screen.findByRole("dialog", { name: "Studio control room" });

      await act(async () => { await router.navigate("/media/unknown"); });
      fireEvent.click(within(viewer).getByRole("button", { name: "Discard changes" }));

      await waitFor(() => expect(uploadRouterSnapshot().videoSession).toBe(false));
      await waitFor(() => expect(router.state.location.pathname).toBe("/media/images"));
    } finally {
      restoreLocks();
    }
  });

  it("closes a clean viewer when the URL selects another asset", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    await screen.findByRole("dialog", { name: "Studio control room" });
    await act(async () => { await router.navigate("/media/images?selected=asset-one"); });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Studio control room" })).toBeNull());
    expect(await detailsHeading("Studio control room")).toBeInTheDocument();
  });

  it.each([true, false])("returns focus inside the viewer when navigation had no focused control and Details is %s", async (detailsVisible) => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    const name = within(viewer).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    if (!detailsVisible) fireEvent.click(within(viewer).getByRole("button", { name: "Close image details" }));
    document.body.tabIndex = -1;
    document.body.focus();
    await act(async () => { await router.navigate("/media/images?q=desk"); });
    fireEvent.click(within(viewer).getByRole("button", { name: "Keep editing" }));
    const target = detailsVisible ? name : within(viewer).getByRole("group", { name: "Image workspace controls" }).querySelector(".image-viewer-details-toggle");
    await waitFor(() => expect(target).toHaveFocus());
  });

  it("keeps unsaved viewer details guarded when a conflict reload fails", async () => {
    mocks.update.mockRejectedValueOnce(new HttpError(412, "Reload before saving."));
    const { router } = renderRoute("/media/images?category=news");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    expect(await within(viewer).findByText("This asset changed. Reload it before saving.")).toBeInTheDocument();
    mocks.list.mockRejectedValueOnce(new Error("Network failed"));
    fireEvent.click(within(viewer).getByRole("button", { name: "Reload asset" }));
    expect(await within(viewer).findByText("The media asset could not be reloaded. Try again.")).toBeInTheDocument();
    expect(mocks.list.mock.calls.at(-1)?.[1]).toMatchObject({ categories: [], kinds: [], q: "", assetIds: [asset.id] });
    expect(within(viewer).getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved name");
    await act(async () => { await router.navigate("/media/images?q=desk"); });
    expect(within(viewer).getByText("Unsaved media changes")).toBeInTheDocument();
  });

  it("holds a full-size image save until close and focuses the next card after a filtered reload", async () => {
    const second = { ...asset, id: "asset-two", name: "News desk" };
    mocks.list.mockResolvedValueOnce(selection([asset, second])).mockResolvedValueOnce(selection([second]));
    renderRoute("/media/images?q=studio");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: "Moved out of view" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    await within(viewer).findByText("Media details saved");
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(within(viewer.querySelector("header")!).getByRole("status")).toHaveTextContent("1 of 2");
    fireEvent.click(within(viewer).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(openControl("News desk")).toHaveFocus());
    expect(screen.getByText("Main control room no longer matches this view.")).toBeInTheDocument();
  });

  it("focuses the shown card when the deferred viewer reload fails", async () => {
    mocks.list.mockResolvedValueOnce(selection([asset])).mockRejectedValueOnce(new Error("Network failed"));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: "Moved out of view" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    await within(viewer).findByText("Media details saved");
    const calls = mocks.list.mock.calls.length;
    fireEvent.click(within(viewer).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(mocks.list.mock.calls.length).toBe(calls + 1));
    await waitFor(() => expect(openControl("Main control room")).toHaveFocus());
    expect(screen.getByText("Network failed")).toBeInTheDocument();
  });

  it("reloads the list when discard stays on the same query after a viewer save", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: "Saved name" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    await within(viewer).findByText("Media details saved");
    const calls = mocks.list.mock.calls.length;
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved again" } });
    await act(async () => { await router.navigate("/media/images?selected=asset-one"); });
    fireEvent.click(within(viewer).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(mocks.list.mock.calls.length).toBe(calls + 1));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Saved name" })).toBeNull());
    expect(router.state.location.search).toBe("?selected=asset-one");
  });

  it("locks viewer details while a conflict reload is in flight", async () => {
    mocks.update.mockRejectedValueOnce(new HttpError(412, "Reload before saving."));
    let finishReload: (value: ReturnType<typeof selection>) => void = () => {};
    mocks.list
      .mockResolvedValueOnce(selection([asset]))
      .mockImplementationOnce(() => new Promise(resolve => { finishReload = resolve; }));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    expect(await within(viewer).findByText("This asset changed. Reload it before saving.")).toBeInTheDocument();
    fireEvent.click(within(viewer).getByRole("button", { name: "Reload asset" }));
    await waitFor(() => expect(within(viewer).getByRole("textbox", { name: "Name" })).toBeDisabled());
    expect(within(viewer).getByRole("button", { name: "Save details" })).toBeDisabled();
    await act(async () => { finishReload(selection([{ ...asset, name: "Fresh name", etag: '"fresh"' }])); });
    await waitFor(() => expect(within(viewer).getByRole("textbox", { name: "Name" })).toBeEnabled());
    expect(within(viewer).getByRole("textbox", { name: "Name" })).toHaveValue("Fresh name");
  });

  it("keeps discard unavailable while a viewer save is still running", async () => {
    let finishSave: (value: unknown) => void = () => {};
    mocks.update.mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    expect(await within(viewer).findByRole("button", { name: /^.+: Saving details…$/ })).toHaveAttribute("aria-disabled", "true");
    await act(async () => { await router.navigate("/media/images?q=desk"); });
    expect(within(viewer).getByRole("button", { name: "Discard changes" })).toBeDisabled();
    expect(within(viewer).getByRole("button", { name: "Keep editing" })).toBeEnabled();
    await act(async () => {
      finishSave({
        success: true,
        changed: true,
        asset: { ...asset, name: "Saved name", version: 3, etag: '"saved"' },
      });
    });
    await waitFor(() => expect(within(viewer).getByRole("button", { name: "Discard changes" })).toBeEnabled());
  });

  it("shows the PDF mark and original link in the full-size viewer", async () => {
    const pdf = { ...asset, kind: "document" as const, mimeType: "application/pdf", name: "Board report" };
    mocks.list.mockResolvedValue(selection([pdf]));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Board report" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Board report" });
    expect(within(viewer).getByText("PDF")).toBeInTheDocument();
    expect(within(viewer).getByRole("link", { name: "Open original" })).toHaveAttribute("href", pdf.url);
  });

  it("guards a dirty inspector before opening full size from its preview", async () => {
    const { router } = renderRoute("/media/images?selected=asset-one");
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("link", { name: "Open full size" }));
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(name).toHaveValue("Unsaved name");
    expect(screen.queryByRole("dialog", { name: "Studio control room" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Open full size" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByRole("dialog", { name: "Studio control room" })).toBeInTheDocument();
    expect(params(router).get("selected")).toBeNull();
  });

  it("closes Quick Look at either Tab boundary or with Ctrl+Y and restores card focus", async () => {
    const second = { ...asset, id: "asset-two", name: "News desk" };
    mocks.list.mockResolvedValue(selection([asset, second]));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    const card = openControl("Studio control room");
    fireEvent.keyDown(card, { key: "y", ctrlKey: true });
    const close = screen.getByRole("button", { name: "Close Quick Look" });
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    await waitFor(() => expect(card).toHaveFocus());

    fireEvent.keyDown(card, { key: "y", ctrlKey: true });
    const next = screen.getByRole("button", { name: "Next item" });
    next.focus();
    fireEvent.keyDown(next, { key: "Tab" });
    await waitFor(() => expect(card).toHaveFocus());

    fireEvent.keyDown(card, { key: "y", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Close Quick Look" }), { key: "y", ctrlKey: true });
    await waitFor(() => expect(card).toHaveFocus());
  });

  it("leaves the browser shortcut alone while image cards are locked", async () => {
    renderRoute("/media/images?selected=asset-one");
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    const card = openControl("Studio control room");
    expect(fireEvent.keyDown(card, { key: "y", ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("dialog", { name: /Quick Look:/ })).toBeNull();
  });

  it("shows a PDF link in Quick Look and closes on an outside pointer", async () => {
    const pdf = { ...asset, kind: "document" as const, mimeType: "application/pdf", name: "Board report" };
    mocks.list.mockResolvedValue(selection([pdf]));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Board report" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Quick Look" }));
    const look = await screen.findByRole("dialog", { name: "Quick Look: Board report" });
    expect(within(look).getByRole("link", { name: "Open original" })).toHaveAttribute("href", pdf.url);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Quick Look: Board report" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: /^Board report, PDF/ })).toHaveFocus());
  });

  it("lets an outside search click keep focus after Quick Look closes", async () => {
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.keyDown(openControl("Studio control room"), { key: "y", ctrlKey: true });
    const search = screen.getByRole("searchbox");
    fireEvent.pointerDown(search);
    search.focus();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Quick Look:/ })).toBeNull());
    await waitFor(() => expect(search).toHaveFocus());
  });

  it("opens bulk image details from Edit tags without another list request", async () => {
    const second = { ...asset, id: "asset-two", name: "News desk", tags: ["desk", "studio"], description: "Desk view" };
    mocks.list.mockResolvedValue(selection([asset, second]));
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select News desk" }));
    const before = mocks.list.mock.calls.length;

    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Edit tags" }));
    const inspector = await screen.findByRole("complementary", { name: "Edit selected" });
    const grid = screen.getByRole("grid", { name: "Images", hidden: true });
    expect(grid).toHaveAttribute("inert");
    fireEvent.click(within(grid).getByRole("button", { name: /^Studio control room/, hidden: true }));
    expect(params(router).get("selected")).toBeNull();
    expect(within(inspector).getByRole("heading", { name: "2 items" })).toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "Remove tag desk, on some items" })).toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "Review 2 changes" })).toBeDisabled();
    fireEvent.contextMenu(tile("Studio control room"));
    expect(screen.queryByRole("menuitem", { name: "Clear selection" })).toBeNull();
    expect(screen.getByRole("group", { name: "Collection selection" })).toHaveTextContent("2 selected");
    expect(mocks.list).toHaveBeenCalledTimes(before);
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(within(inspector).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(openControl("News desk")).toHaveFocus());
    expect(screen.getByRole("grid", { name: "Images" })).not.toHaveAttribute("inert");
  });

  it("shows Edit tags in a selected card's More menu in grid and list layouts", async () => {
    const second = { ...asset, id: "asset-two", name: "News desk" };
    mocks.list.mockResolvedValue(selection([asset, second]));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select News desk" }));
    fireEvent.click(screen.getAllByRole("button", { name: "More actions: 2 items" })[0]);
    expect(screen.getByRole("menuitem", { name: "Edit tags" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Display" })).getByRole("radio", { name: "List" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Display" }), { key: "Escape" });
    fireEvent.click(screen.getAllByRole("button", { name: "More actions: 2 items" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit tags" }));
    expect(await screen.findByRole("complementary", { name: "Edit selected" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "More actions: 2 items" })[0]).toHaveAttribute("aria-disabled", "true");
  });

  it("asks before bulk mode replaces unsaved image details", async () => {
    const second = { ...asset, id: "asset-two", name: "News desk" };
    mocks.list.mockResolvedValue(selection([asset, second]));
    renderRoute("/media/images?selected=asset-one");
    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select News desk" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
    const edit = within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Edit tags" });
    expect(edit).toBeEnabled();
    const before = mocks.list.mock.calls.length;

    fireEvent.click(edit);
    const prompt = await screen.findByRole("dialog", { name: "Leave with unsaved changes?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved name");
    expect(screen.queryByRole("complementary", { name: "Edit selected" })).toBeNull();

    fireEvent.click(edit);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).getByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByRole("complementary", { name: "Edit selected" })).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(before);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("saves an image batch through its selected ETag and reloads the list once after results close", async () => {
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    const before = mocks.list.mock.calls.length;
    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Edit tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace all tags or clear all tags" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Review 1 changes" }));
    expect(mocks.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 image" }));
    expect(await screen.findByRole("heading", { name: "Batch results" })).toBeInTheDocument();
    expect(mocks.update).toHaveBeenCalledWith("id-token", asset, { tags: [] });
    expect(mocks.list).toHaveBeenCalledTimes(before);

    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(before + 1));
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
  });

  it("does not report unsaved image changes after the batch finishes", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Edit tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace all tags or clear all tags" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Review 1 changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 image" }));
    await screen.findByRole("heading", { name: "Batch results" });

    await act(async () => { await router.navigate("/media/favorites"); });
    expect(router.state.location.pathname).toBe("/media/favorites");
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();
  });

  it("shows one navigation prompt while the image batch review is dirty", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Edit tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace all tags or clear all tags" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Review 1 changes" }));

    await act(async () => { await router.navigate("/media/favorites"); });
    expect(screen.getByText("Leave with unsaved batch changes?")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "Edit selected images" })).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("ends a routed video when bulk review confirms leaving the workspace", async () => {
    const restoreLocks = disableWebLocks();
    try {
      mocks.listSources.mockResolvedValue({
        sources: [{ id: "video-library", label: "Videos", description: "Staff videos", mediaKind: "video", canBrowse: true, canUpload: true }],
      });
      const { router } = renderRoute("/media/images");
      await screen.findByRole("grid", { name: "Images" });
      fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
      fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Edit tags" }));
      fireEvent.click(screen.getByRole("button", { name: "Replace all tags or clear all tags" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Clear all tags" }));
      fireEvent.click(screen.getByRole("button", { name: "Review 1 changes" }));
      act(() => routeChosenFiles([new File(["video"], "clip.mp4", { type: "video/mp4" })]));
      await screen.findByText("Uploads are unavailable in this browser. The selected video was not added.");

      await act(async () => { await router.navigate("/media/unknown"); });
      fireEvent.click(await screen.findByRole("button", { name: "Leave without saving" }));

      await waitFor(() => expect(uploadRouterSnapshot().videoSession).toBe(false));
      await waitFor(() => expect(router.state.location.pathname).toBe("/media/images"));
    } finally {
      restoreLocks();
    }
  });

  it("does not offer leave without saving while an image batch save is in flight", async () => {
    let finishSave: (value: unknown) => void = () => {};
    mocks.update.mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Edit tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace all tags or clear all tags" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all tags" }));
    fireEvent.click(screen.getByRole("button", { name: "Review 1 changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 image" }));
    await act(async () => { await router.navigate("/media/favorites"); });
    expect(screen.queryByRole("button", { name: "Leave without saving" })).toBeNull();
    await act(async () => {
      finishSave({
        success: true,
        changed: true,
        asset: { ...asset, tags: [], version: 3, etag: '"saved"' },
      });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/media/favorites"));
    expect(screen.queryByRole("button", { name: "Leave without saving" })).toBeNull();
  });

  it("does not open a related result behind a clean bulk inspector", async () => {
    mocks.meaningAsset = { ...asset, id: "related-asset", name: "Verified related photo" };
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Edit tags" }));
    const related = await screen.findByRole("button", { name: "Open related media fixture" });
    expect(related).toBeDisabled();
    fireEvent.click(related);
    expect(params(router).get("selected")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Edit selected" })).toBeInTheDocument();
  });

  it("keeps Edit tags unavailable above the image batch limit", async () => {
    mocks.list.mockResolvedValue(selection(pageOf(101)));
    renderRoute("/media/images");
    const grid = await screen.findByRole("grid", { name: "Images" });
    // Query the label directly instead of computing all 101 checkbox names.
    fireEvent.click(within(grid).getByLabelText("Select Image 00"));
    const bar = within(screen.getByRole("group", { name: "Collection selection" }));
    fireEvent.click(bar.getByRole("checkbox", { name: "Select this page" }));
    const edit = bar.getByRole("button", { name: "Edit tags" });
    expect(edit).toBeDisabled();
    expect(bar.getByRole("alert")).toHaveTextContent("Select no more than 100 items in one batch.");
    fireEvent.click(edit);
    expect(screen.queryByRole("complementary", { name: "Edit selected" })).toBeNull();
  });

  it("Cmd-click toggles and Shift-click selects a range on the page", async () => {
    mocks.list.mockResolvedValue(selection(pageOf(5)));
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    const checked = () => pageOf(5).filter((item) => screen.getByRole("checkbox", { name: `Select ${item.name}` }).matches(":checked")).map((item) => item.name);

    fireEvent.click(openControl("Image 01"), { metaKey: true });
    expect(checked()).toEqual(["Image 01"]);
    fireEvent.click(openControl("Image 03"), { shiftKey: true });
    expect(checked()).toEqual(["Image 01", "Image 02", "Image 03"]);
    fireEvent.click(openControl("Image 02"), { ctrlKey: true });
    expect(checked()).toEqual(["Image 01", "Image 03"]);
    expect(params(router).get("selected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close details" })).toBeNull();
  });

  it("Cmd+A selects the page and the bar reads 30 selected", async () => {
    mocks.list.mockResolvedValue(selection(pageOf(30)));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    const calls = requestCounts();
    const first = openControl("Image 00");
    first.focus();
    fireEvent.keyDown(first, { key: "a", ctrlKey: true });
    const bar = screen.getByRole("group", { name: "Collection selection" });
    expect(bar).toHaveTextContent(/^30 selected/);
    expect(within(bar).getByRole("checkbox", { name: "Select this page" })).toBeChecked();
    expect(within(bar).getByRole("button", { name: "Add to collection" })).toBeEnabled();
    expect(status()).toHaveTextContent("30 selected");
    expect(requestCounts()).toEqual(calls);
  });

  it("Escape clears the selection, then closes details, then clears search", async () => {
    const { router } = renderRoute("/media/images?q=studio&selected=asset-one");
    await detailsHeading("Studio control room");
    const card = openControl("Studio control room");
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    expect(screen.getByRole("group", { name: "Collection selection" })).toBeInTheDocument();

    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    expect(status()).toHaveTextContent("No items selected");
    expect(card).toHaveFocus();
    expect(params(router).get("selected")).toBe("asset-one");

    fireEvent.keyDown(card, { key: "Escape" });
    await waitFor(() => expect(params(router).get("selected")).toBeNull());
    expect(params(router).get("q")).toBe("studio");

    fireEvent.keyDown(openControl("Studio control room"), { key: "Escape" });
    await waitFor(() => expect(params(router).get("q")).toBeNull());
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search media" })).toHaveFocus());
  });

  it("adds two selected images to favorites and keeps a failed image selected", async () => {
    mocks.list.mockResolvedValue(selection([asset, { ...asset, id: "asset-two", name: "News desk" }]));
    let finish!: (value: unknown) => void;
    mocks.setFavorites.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Studio control room" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select News desk" }));
    fireEvent.click(screen.getAllByRole("button", { name: "More actions: 2 items" })[0]);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Add to favorites" }));

    await waitFor(() => expect(mocks.setFavorites).toHaveBeenCalledWith("id-token", [
      { backend: "r2", id: "asset-one" },
      { backend: "r2", id: "asset-two" },
    ], true));
    const bar = screen.getByRole("group", { name: "Collection selection" });
    expect(within(bar).getByRole("button", { name: "Add to favorites" })).toBeDisabled();
    expect(within(bar).getByRole("button", { name: "Clear selection" })).toBeDisabled();
    await act(async () => finish({
      success: true,
      favorite: true,
      results: [
        { ref: { backend: "r2", id: "asset-one" }, favorite: true, changed: false },
        { ref: { backend: "r2", id: "asset-two" }, error: "Could not save", status: 500 },
      ],
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent("1 already a favorite. 1 could not be changed.");
    expect(screen.getByRole("checkbox", { name: "Select Studio control room" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select News desk" })).toBeChecked();
    expect(status()).toHaveTextContent("1 selected");
    expect(within(bar).getByRole("button", { name: "Add to favorites" })).toBeEnabled();
  });

  it("the context menu mirrors the tile actions and opening it makes no request", async () => {
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    await favoritesSettled();
    const calls = requestCounts();

    fireEvent.click(within(tile("Studio control room")).getByRole("button", { name: "More actions: Studio control room" }));
    const more = screen.getByRole("menu").querySelectorAll("[role=menuitem]");
    const moreItems = [...more].map((item) => item.textContent);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.contextMenu(tile("Studio control room").querySelector(".media-tile-thumb") as HTMLElement, { clientX: 40, clientY: 40 });
    const menu = screen.getByRole("menu", { name: "Studio control room" });
    const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(["Open details", "Quick Look", "Open full size", "Add to favorites", "Add to collection", "Select", "Copy link", "Copy file address", "Delete from library"]);
    expect(items).toEqual(moreItems);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(requestCounts()).toEqual(calls);
  });

  it("Delete from library in the menu opens details at the delete confirmation", async () => {
    const { router } = renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.contextMenu(tile("Studio control room").querySelector(".media-tile-thumb") as HTMLElement);
    fireEvent.click(within(screen.getByRole("menu", { name: "Studio control room" })).getByRole("menuitem", { name: "Delete from library" }));
    await waitFor(() => expect(params(router).get("selected")).toBe("asset-one"));
    const confirm = await screen.findByRole("group", { name: "Confirm media deletion" });
    await waitFor(() => expect(confirm).toHaveFocus());
    expect(mocks.remove).not.toHaveBeenCalled();

    const section = screen.getByRole("button", { name: "Delete from library" });
    fireEvent.click(section);
    expect(section).toHaveAttribute("aria-expanded", "false");
    openControl("Studio control room").focus();
    fireEvent.contextMenu(tile("Studio control room").querySelector(".media-tile-thumb") as HTMLElement);
    fireEvent.click(within(screen.getByRole("menu", { name: "Studio control room" })).getByRole("menuitem", { name: "Delete from library" }));

    await waitFor(() => expect(section).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(confirm).toHaveFocus());
  });

  it("Copy link copies the internal image URL without changing access", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
    try {
      renderRoute("/media/images");
      await screen.findByRole("grid", { name: "Images" });
      const calls = requestCounts();
      fireEvent.contextMenu(tile("Studio control room").querySelector(".media-tile-thumb") as HTMLElement);
      fireEvent.click(within(screen.getByRole("menu", { name: "Studio control room" })).getByRole("menuitem", { name: "Copy link" }));
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/media/images?asset=asset-one`);
      await waitFor(() => expect(document.querySelector(".media-action-status")).toHaveTextContent("Link to Studio control room copied."));
      expect(requestCounts()).toEqual(calls);

      fireEvent.contextMenu(tile("Studio control room").querySelector(".media-tile-thumb") as HTMLElement);
      fireEvent.click(within(screen.getByRole("menu", { name: "Studio control room" })).getByRole("menuitem", { name: "Copy file address" }));
      expect(writeText).toHaveBeenLastCalledWith(asset.url);
      expect(requestCounts()).toEqual(calls);

      writeText.mockRejectedValueOnce(new Error("Not allowed"));
      fireEvent.contextMenu(tile("Studio control room").querySelector(".media-tile-thumb") as HTMLElement);
      fireEvent.click(within(screen.getByRole("menu", { name: "Studio control room" })).getByRole("menuitem", { name: "Copy link" }));
      const failure = (await screen.findByText("Link was not copied")).closest(".inline-message") as HTMLElement;
      expect(failure).toHaveTextContent(`${window.location.origin}/media/images?asset=asset-one`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a hover card shows the loaded facts after the pause and makes no request", async () => {
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    await favoritesSettled();
    const calls = requestCounts();
    const card = openControl("Studio control room");
    act(() => card.focus());
    expect(screen.queryByRole("group", { name: "Details for Studio control room" })).toBeNull();
    const facts = await screen.findByRole("group", { name: "Details for Studio control room" }, { timeout: 1500 });
    expect(facts).toHaveTextContent("1600 × 900");
    expect(facts).toHaveTextContent("Newsroom");
    expect(facts).toHaveTextContent("studio");
    fireEvent.keyDown(card, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Details for Studio control room" })).toBeNull();
    expect(card).toHaveFocus();
    expect(requestCounts()).toEqual(calls);
  });

  it("tile actions are disabled while details are unsaved", async () => {
    mocks.list.mockResolvedValue(selection([asset, { ...asset, id: "asset-two", name: "News desk", etag: '"media.YXNzZXQtdHdv.2"' }]));
    renderRoute("/media/images?selected=asset-one");
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Unsaved control room" } });
    const other = tile("News desk");
    expect(within(other).getByRole("checkbox", { name: "Select News desk" })).toBeDisabled();
    expect(within(other).getByRole("button", { name: /^(Add to favorites|Loading favorite|Saving favorite): News desk$/ })).toBeDisabled();
    expect(within(other).getByRole("button", { name: "Add to collection: News desk" })).toBeDisabled();

    const card = openControl("News desk");
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "a", ctrlKey: true });
    fireEvent.click(card, { metaKey: true });
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();

    fireEvent.contextMenu(other.querySelector(".media-tile-thumb") as HTMLElement);
    expect(within(screen.getByRole("menu", { name: "News desk" })).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open details"]);
    expect(mocks.setFavorite).not.toHaveBeenCalled();
  });

  it("adds one image to a collection from its tile", async () => {
    privateCollection();
    mocks.list.mockResolvedValue(selection([asset, { ...asset, id: "asset-two", name: "News desk", etag: '"media.YXNzZXQtdHdv.2"' }]));
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(within(tile("News desk")).getByRole("button", { name: "Add to collection: News desk" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Homepage package/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add selected to collection" })).getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(mocks.setCollectionItems).toHaveBeenCalledWith("id-token", expect.objectContaining({
      refs: [{ backend: "r2", id: "asset-two" }],
    })));
    expect((await screen.findByText("Items added to collection")).closest("[role=status]")).toHaveTextContent("1 item was added to Homepage package.");
  });
});

describe("MediaRoute images list", () => {
  const params = (router: { state: { location: { search: string } } }) => new URLSearchParams(router.state.location.search);
  const two = () => selection([asset, { ...asset, id: "asset-two", name: "News desk", etag: '"media.YXNzZXQtdHdv.2"', sizeBytes: 4_096 }]);
  const openControl = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}, image`) });
  const row = (name: string) => openControl(name).closest("[role=row]") as HTMLElement;
  const header = () => document.querySelector(".media-row-header") as HTMLElement;
  const columns = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>("[data-column]")].map((cell) => cell.dataset.column);
  const requestCounts = () => [
    mocks.list.mock.calls.length,
    mocks.listFavoriteStates.mock.calls.length,
    mocks.setFavorite.mock.calls.length,
    mocks.listCollections.mock.calls.length,
    mocks.setCollectionItems.mock.calls.length,
    mocks.update.mock.calls.length,
    mocks.remove.mock.calls.length,
  ];
  const useList = () => localStorage.setItem(MEDIA_DISPLAY_STORAGE_KEY, JSON.stringify({ layout: "list" }));
  const favoritesSettled = async (name = "Studio control room") => {
    await waitFor(() => expect(screen.getByRole("button", { name: `Add to favorites: ${name}` })).toBeEnabled());
  };

  it("list columns follow the card fields plus Updated", async () => {
    useList();
    mocks.list.mockResolvedValue(two());
    renderRoute("/media/images");
    const grid = await screen.findByRole("grid", { name: "Images" });
    expect(grid).toHaveAttribute("data-layout", "list");
    expect(grid.querySelector(".media-tile")).toBeNull();
    expect(columns(header())).toEqual(["type", "size", "dimensions", "tags", "updated"]);
    expect(columns(row("Studio control room"))).toEqual(["type", "size", "dimensions", "tags", "updated"]);
    expect(row("Studio control room").querySelector("[data-column=updated]")).toHaveTextContent(/^Aug 13, 2026/);

    const calls = mocks.list.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const panel = screen.getByRole("dialog", { name: "Display" });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Dimensions" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Category" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Updated" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Updated" }));
    expect(columns(header())).toEqual(["type", "category", "size", "tags", "updated"]);
    expect(columns(row("News desk"))).toEqual(["type", "category", "size", "tags", "updated"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.list).toHaveBeenCalledTimes(calls);
  });

  it("clicking Name sorts by name and a second click reverses, one list request each", async () => {
    useList();
    mocks.list.mockImplementation(cursorPagedList(3, two().records));
    const { router } = renderRoute("/media/images?page=2");
    await screen.findByRole("grid", { name: "Images" });
    const calls = mocks.list.mock.calls.length;

    fireEvent.click(within(header()).getByRole("button", { name: "Name" }));
    await waitFor(() => expect(params(router).get("sort")).toBe("name"));
    expect(params(router).get("page")).toBeNull();
    expect(router.state.historyAction).toBe("REPLACE");
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 1));
    expect(mocks.list).toHaveBeenLastCalledWith("id-token", expect.objectContaining({ sort: "name", direction: "asc", page: 1 }), undefined, expect.objectContaining({ favorites: true }));
    // The toolbar's Sort control reads the same state.
    expect(screen.getByRole("button", { name: "Sort: Name, A–Z" })).toBeInTheDocument();

    fireEvent.click(within(header()).getByRole("button", { name: "Name" }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(calls + 2));
    expect(mocks.list).toHaveBeenLastCalledWith("id-token", expect.objectContaining({ sort: "name", direction: "desc", page: 1 }), undefined, expect.objectContaining({ favorites: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.list).toHaveBeenCalledTimes(calls + 2);
  });

  it("only the sorted column shows an arrow and aria-sort", async () => {
    useList();
    mocks.list.mockResolvedValue(two());
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    const sorted = () => [...header().querySelectorAll("[aria-sort]")].map((cell) => [cell.getAttribute("data-column") ?? "name", cell.getAttribute("aria-sort")]);
    expect(sorted()).toEqual([["updated", "descending"]]);
    expect(header().querySelectorAll(".media-row-sort .icon")).toHaveLength(1);
    expect(header().querySelector("[data-column=updated] .media-row-sort .icon")).not.toBeNull();
    // Type, Dimensions and Tags have no sort, so they are plain headings.
    for (const column of ["type", "dimensions", "tags"]) {
      expect(header().querySelector(`[data-column=${column}] button`)).toBeNull();
    }

    fireEvent.click(within(header()).getByRole("button", { name: "Size" }));
    await waitFor(() => expect(sorted()).toEqual([["size", "descending"]]));
    expect(header().querySelectorAll(".media-row-sort .icon")).toHaveLength(1);
  });

  it("the header checkbox is mixed for part of the page and selects the page", async () => {
    useList();
    mocks.list.mockResolvedValue(two());
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    const pageBox = () => within(header()).getByRole("checkbox", { name: "Select this page" });
    expect(pageBox()).not.toBeChecked();
    expect(pageBox()).toHaveProperty("indeterminate", false);
    const calls = requestCounts();

    fireEvent.click(within(row("News desk")).getByRole("checkbox", { name: "Select News desk" }));
    expect(pageBox()).toHaveProperty("indeterminate", true);
    expect(row("News desk")).toHaveAttribute("aria-selected", "true");

    fireEvent.click(pageBox());
    expect(pageBox()).toBeChecked();
    expect(pageBox()).toHaveProperty("indeterminate", false);
    expect(within(screen.getByRole("group", { name: "Collection selection" })).getByText(/^2 selected/)).toBeInTheDocument();

    fireEvent.click(pageBox());
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    expect(requestCounts()).toEqual(calls);
  });

  it("layout never enters the URL or the list cache key", async () => {
    mocks.list.mockResolvedValue(two());
    const { router } = renderRoute("/media/images?sort=name&direction=asc");
    await screen.findByRole("grid", { name: "Images" });
    await favoritesSettled();
    const search = router.state.location.search;
    const calls = requestCounts();
    const history = router.state.historyAction;

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Display" })).getByRole("radio", { name: "List" }));
    expect(screen.getByRole("grid", { name: "Images" })).toHaveAttribute("data-layout", "list");
    expect(JSON.parse(localStorage.getItem(MEDIA_DISPLAY_STORAGE_KEY) ?? "{}")).toMatchObject({ layout: "list" });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Display" })).getByRole("radio", { name: "Grid" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Display" })).getByRole("radio", { name: "List" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(router.state.location.search).toBe(search);
    expect(router.state.historyAction).toBe(history);
    expect(requestCounts()).toEqual(calls);
    for (const [, query] of mocks.list.mock.calls) expect(Object.keys(query as object)).not.toContain("layout");
    // The cached page is the same entry under the same query, with no layout in it.
    const query = { ...DEFAULT_MEDIA_QUERY, sort: "name" as const, direction: "asc" as const, paging: "cursor" as const };
    expect(cachedMediaList("editor-1", query)?.records.map((record) => record.id)).toEqual(["asset-one", "asset-two"]);
  });

  it("under 43rem a row is mark, thumbnail, name with meta and More", async () => {
    useList();
    mocks.list.mockResolvedValue(two());
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    const studio = row("Studio control room");
    expect(within(studio).getByRole("checkbox", { name: "Select Studio control room" })).toBeInTheDocument();
    expect(studio.querySelector(".media-row-thumb img")).toHaveAttribute("loading", "lazy");
    expect(within(studio).getByRole("button", { name: "More actions: Studio control room" })).toBeInTheDocument();
    // The phone meta line keeps every column's fact, Updated too, since every column hides there.
    expect(studio.querySelector(".media-row-sub-small")?.textContent).toMatch(/^Image · 2\.0 KB · 1600 × 900 · 1 tag · Aug 13, 2026/);
    // Between 43 and 70rem the meta line keeps the facts whose columns hide there.
    expect(studio.querySelector(".media-row-sub-medium")?.textContent).toBe("Image · 1600 × 900 · 1 tag");
    const rowCss = readFileSync(resolve(process.cwd(), "src/components/media/MediaRow.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const narrow = rowCss.slice(rowCss.indexOf("@container (max-width: 43rem)"));
    // The approved asset-row constituent uses a60px thumbnail and compact32/44px targets.
    expect(narrow).toMatch(/grid-template-columns: var\(--cms-control-compact-target\) 60px minmax\(0, 1fr\) var\(--cms-control-compact-target\);/);
  });

  it("right-click and Shift+F10 on a row open the same menu as More, with no request", async () => {
    useList();
    mocks.list.mockResolvedValue(two());
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    await favoritesSettled();
    const calls = requestCounts();

    fireEvent.click(within(row("Studio control room")).getByRole("button", { name: "More actions: Studio control room" }));
    const moreItems = within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.contextMenu(row("Studio control room").querySelector(".media-row-thumb") as HTMLElement, { clientX: 40, clientY: 40 });
    let menu = screen.getByRole("menu", { name: "Studio control room" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent))
      .toEqual(["Open details", "Quick Look", "Open full size", "Add to favorites", "Add to collection", "Select", "Copy link", "Copy file address", "Delete from library"]);
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(moreItems);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(openControl("Studio control room")).toHaveFocus());

    const name = openControl("News desk");
    act(() => name.focus());
    fireEvent.keyDown(name, { key: "F10", shiftKey: true });
    menu = screen.getByRole("menu", { name: "News desk" });
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(openControl("News desk")).toHaveFocus());
    // The menu lives outside the grid, and each row keeps only gridcells inside it.
    const grid = screen.getByRole("grid", { name: "Images" });
    for (const element of grid.querySelectorAll("[role=row]:not(.media-row-header)")) {
      for (const child of element.querySelectorAll("[role]")) {
        if (child.getAttribute("role") === "gridcell") expect(child.parentElement?.closest("[role]")).toBe(element);
      }
    }
    expect(requestCounts()).toEqual(calls);
  });

  it("row actions are disabled while details are unsaved", async () => {
    useList();
    mocks.list.mockResolvedValue(two());
    renderRoute("/media/images?selected=asset-one");
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Unsaved control room" } });
    const other = row("News desk");
    expect(within(other).getByRole("checkbox", { name: "Select News desk" })).toBeDisabled();
    expect(within(other).getByRole("button", { name: /^(Add to favorites|Loading favorite|Saving favorite): News desk$/ })).toBeDisabled();
    expect(within(header()).getByRole("checkbox", { name: "Select this page" })).toBeDisabled();
    fireEvent.contextMenu(other.querySelector(".media-row-thumb") as HTMLElement);
    expect(within(screen.getByRole("menu", { name: "News desk" })).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open details"]);
    fireEvent.keyDown(screen.getByRole("menu", { name: "News desk" }), { key: "Escape" });
    const card = openControl("News desk");
    card.focus();
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "a", ctrlKey: true });
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    expect(mocks.setFavorite).not.toHaveBeenCalled();
  });

  it("a heading click while details are unsaved asks to leave and keeps the sort", async () => {
    useList();
    mocks.list.mockResolvedValue(two());
    const { router } = renderRoute("/media/images?selected=asset-one");
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Unsaved control room" } });
    const calls = mocks.list.mock.calls.length;
    fireEvent.click(within(header()).getByRole("button", { name: "Name" }));
    const prompt = screen.getByRole("dialog", { name: "Leave with unsaved changes?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(params(router).get("sort")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved control room");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.list).toHaveBeenCalledTimes(calls);
  });

  it("switching layout keeps the selection and the row that last had focus", async () => {
    mocks.list.mockResolvedValue(two());
    renderRoute("/media/images");
    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select News desk" }));
    const desk = openControl("News desk");
    act(() => desk.focus());

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Display" })).getByRole("radio", { name: "List" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Display" }), { key: "Escape" });
    expect(screen.getByRole("grid", { name: "Images" })).toHaveAttribute("data-layout", "list");
    expect(row("News desk")).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("group", { name: "Collection selection" })).getByText(/^1 selected/)).toBeInTheDocument();
    // The grid's one tab stop stays on the row that last had focus.
    expect(openControl("News desk")).not.toHaveAttribute("tabindex", "-1");
    expect(openControl("Studio control room")).toHaveAttribute("tabindex", "-1");
    // Clear selection returns focus to that row.
    fireEvent.click(within(screen.getByRole("group", { name: "Collection selection" })).getByRole("button", { name: "Clear selection" }));
    await waitFor(() => expect(openControl("News desk")).toHaveFocus());
  });
});

describe("replace file wiring", () => {
  it("opens the bin from a replacement refusal with filters and no dialog left open", async () => {
    mocks.replace.mockRejectedValue(new HttpError(409, "Duplicate file", { duplicateAssetId: "binned-image" }));
    mocks.list.mockImplementation(async (_token: string, query: { assetIds?: string[] }) =>
      query.assetIds?.includes("binned-image") ? selection([]) : selection());
    mocks.listBin.mockResolvedValue({ success: true, records: [], total: 0, page: 1, pageCount: 1 });
    const replacementUser = "replacement-view-user";
    const { router } = renderRoute("/media/images?selected=asset-one&q=studio&view=bin", {
      ...shell,
      principal: { ...shell.principal, id: replacementUser },
      user: { ...shell.user, uid: replacementUser },
    });
    const chooser = await screen.findByLabelText(`Choose a replacement image for ${asset.name}`);
    expect(mocks.listBin).not.toHaveBeenCalled();
    fireEvent.change(chooser, { target: { files: [new File(["image"], "duplicate.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    const link = await screen.findByRole("link", { name: "Find it in the Recycle bin" });
    expect(link).toHaveAttribute("href", "/media/images?selected=asset-one&q=studio&view=bin&bin=1&binAsset=binned-image");
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: "Recycle bin" })).toBeVisible();
    expect(router.state.location.search).toBe("?selected=asset-one&q=studio&view=bin&bin=1&binAsset=binned-image");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });

  it.each([
    ["success", "Back"], ["refusal", "Back"], ["network error", "Back"],
    ["success", "route change"], ["refusal", "route change"], ["network error", "route change"],
  ])("guards %s during %s, tab close and sign-out until replacement ends", async (outcome, navigation) => {
    let finish!: () => void;
    mocks.replace.mockImplementation(() => new Promise((resolve, reject) => {
      finish = () => outcome === "success"
        ? resolve({ success: true, changed: false, asset })
        : reject(outcome === "refusal" ? new HttpError(409, "Replacement refused.") : new Error("Network error"));
    }));
    const signedOut = vi.fn();
    function SignOutButton() {
      const requestExit = useExitGuard();
      return <button onClick={() => requestExit(signedOut)}>Sign out</button>;
    }
    const router = createMemoryRouter([
      { path: "/media/*", element: <MediaRoute /> },
      { path: "/elsewhere", element: <p>Other route</p> },
    ], { initialEntries: ["/elsewhere", "/media/images?selected=asset-one"], initialIndex: 1 });
    render(<ExitGuardProvider><ShellProvider value={shell}>
      <SignOutButton /><RouterProvider router={router} />
    </ShellProvider></ExitGuardProvider>);
    const chooser = await screen.findByLabelText(`Choose a replacement image for ${asset.name}`);
    fireEvent.change(chooser, { target: { files: [new File(["image"], "new.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledOnce());
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => {
      if (navigation === "Back") await router.navigate(-1);
      else await router.navigate("/elsewhere");
    });
    expect(router.state.location.pathname).toBe("/media/images");
    expect([...router.state.blockers.values()].some(blocker => blocker.state === "blocked")).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: `Confirm replacement of ${asset.name}` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signedOut).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(signedOut).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    const settledUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(settledUnload);
    expect(settledUnload.defaultPrevented).toBe(false);
    await act(async () => { await router.navigate("/elsewhere"); });
    expect(screen.getByText("Other route")).toBeInTheDocument();
  });

  it("replaces an authorized uploaded image and refreshes its thumbnail and version", async () => {
    const fresh = { ...asset, version: 3, etag: '\"media.YXNzZXQtb25l.3\"', url: "https://media.njpbs.org/replaced.webp", thumbnails: [] };
    mocks.replace.mockImplementation(async () => {
      mocks.list.mockResolvedValue(selection([fresh]));
      return { success: true, changed: true, asset: fresh };
    });
    renderRoute("/media/images?selected=asset-one");
    const trigger = await screen.findByRole("button", { name: "Replace file" });
    expect(trigger).toBeEnabled();
    const requests = mocks.list.mock.calls.length;
    const file = new File(["image"], "new.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(`Choose a replacement image for ${asset.name}`), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm replacement" }));
    await screen.findByText("File replaced. Check the alt text for the new image.");
    expect(mocks.replace).toHaveBeenCalledWith("id-token", asset, file, true);
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(requests));
    const inspector = screen.getByRole("complementary", { name: "Asset details" });
    expect(inspector.querySelector('img[src="https://media.njpbs.org/replaced.webp"]')).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("button", { name: "File information" }));
    expect(within(inspector).getByText("Version").nextElementSibling).toHaveTextContent("3");
  });

  it.each([
    ["site seed", { source: "site_seed" }],
    ["unknown source", { source: null }],
    ["PDF", { kind: "document", mimeType: "application/pdf" }],
    ["video", { kind: "video", mimeType: "video/mp4" }],
    ["binned", { lifecycle: "tombstoned" }],
  ])("hides replacement for %s", async (_name, overrides) => {
    // Exercise defensive visibility even if a non-active or unsupported asset reaches the list.
    mocks.list.mockResolvedValue(selection([{ ...asset, ...overrides } as MediaAssetSummary]));
    renderRoute("/media/images?selected=asset-one");
    await detailsHeading(asset.name);
    expect(screen.queryByRole("button", { name: "Replace file" })).not.toBeInTheDocument();
  });

  it("allows replacement across categories for a Watch Editor", async () => {
    renderRoute("/media/images?selected=asset-one", {
      ...shell, principal: { id: "other-editor", grants: [{ role: "editor", sections: ["watch"], registeredMediaSections: ["watch"] }] },
    });
    await detailsHeading(asset.name);
    expect(screen.queryByRole("button", { name: "Replace file" })).toBeEnabled();
  });
});

describe("image permalinks", () => {
  it("resolves an off-page image and preserves library context on close", async () => {
    mocks.list.mockImplementation(async (_token, query) => query.assetIds ? selection([asset]) : selection([]));
    const permalinkUser = "permalink-view-user";
    const { router } = renderRoute("/media/images?q=missing&view=weekly&asset=asset-one&t=12", {
      ...shell,
      principal: { ...shell.principal, id: permalinkUser },
      user: { ...shell.user, uid: permalinkUser },
    });
    const dialog = await screen.findByRole("dialog", { name: "Studio control room" });
    expect(mocks.list).toHaveBeenCalledWith("id-token", expect.objectContaining({ assetIds: [asset.id], q: "" }), undefined);
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(router.state.location.search).toBe("?q=missing&view=weekly");
  });

  it.each([403, 404])("does not expose denied or missing images (%s)", async status => {
    mocks.list.mockImplementation(async (_token, query) => {
      if (query.assetIds) throw new HttpError(status, "Private record name");
      return selection([]);
    });
    renderRoute("/media/images?asset=private-image");
    await screen.findByText("Media unavailable");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Private record name")).not.toBeInTheDocument();
  });
});


it("does not reopen an image permalink after navigation", async () => {
  let resolveLookup!: (result: ReturnType<typeof selection>) => void;
  const pending = new Promise<ReturnType<typeof selection>>(resolve => { resolveLookup = resolve; });
  mocks.list.mockImplementation(async (_token, query) => query.assetIds ? pending : selection([]));
  const { router } = renderRoute("/media/images?asset=asset-one");
  await waitFor(() => expect(mocks.list).toHaveBeenCalledWith("id-token", expect.objectContaining({ assetIds: [asset.id] }), undefined));
  await act(async () => { await router.navigate("/media/images"); });
  await act(async () => { resolveLookup(selection()); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("closes a dirty image permalink after one discard confirmation", async () => {
  const { router } = renderRoute("/media/images?asset=asset-one");
  const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
  fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
  fireEvent.click(within(viewer).getAllByRole("button", { name: "Close" })[0]);
  fireEvent.click(within(viewer).getByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(router.state.location.search).toBe("");
});

describe("image viewer save Undo guards", () => {
  it("refuses the prior asset Undo after the viewer steps to another image", async () => {
    const second = { ...asset, id: "asset-two", name: "News desk", etag: '"media.YXNzZXQtdHdv.2"' };
    const saved = { ...asset, name: "Updated studio", version: 3, etag: '"media.YXNzZXQtb25l.3"' };
    mocks.list.mockResolvedValue(selection([asset, second]));
    mocks.update.mockResolvedValueOnce({ success: true, changed: true, asset: saved });
    renderRouteWithNotices("/media/images");

    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: saved.name } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    const notice = screen.getByRole("region", { name: "Notifications" });
    const undo = await within(notice).findByRole("button", { name: "Undo" });
    await waitFor(() => expect(within(viewer).getByRole("button", { name: "Save details" })).toBeDisabled());
    fireEvent.click(within(viewer).getByRole("button", { name: "Next file" }));
    await screen.findByRole("dialog", { name: "News desk" });

    fireEvent.click(undo);

    expect(mocks.update).toHaveBeenCalledOnce();
    expect(notice).toHaveTextContent("Save Undo is no longer available.");
  });

  it("reloads the current viewer asset after an Undo ETag conflict", async () => {
    const saved = { ...asset, name: "Updated studio", version: 3, etag: '"media.YXNzZXQtb25l.3"' };
    const current = { ...saved, name: "Current server title", version: 4, etag: '"media.YXNzZXQtb25l.4"' };
    mocks.list.mockImplementation(async (_token, query) => query.assetIds ? selection([current]) : selection([asset]));
    mocks.update
      .mockResolvedValueOnce({ success: true, changed: true, asset: saved })
      .mockRejectedValueOnce(new HttpError(412, "Reload before saving."));
    renderRouteWithNotices("/media/images");

    await screen.findByRole("grid", { name: "Images" });
    fireEvent.click(screen.getByRole("button", { name: "More actions: Studio control room" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open full size" }));
    const viewer = await screen.findByRole("dialog", { name: "Studio control room" });
    fireEvent.change(within(viewer).getByRole("textbox", { name: "Name" }), { target: { value: saved.name } });
    fireEvent.click(within(viewer).getByRole("button", { name: "Save details" }));
    const notice = screen.getByRole("region", { name: "Notifications" });
    fireEvent.click(await within(notice).findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith("id-token", expect.objectContaining({ assetIds: [asset.id] }), undefined));
    await waitFor(() => expect(within(viewer).getByRole("textbox", { name: "Name" })).toHaveValue(current.name));
    expect(notice).toHaveTextContent("This asset changed. Reloading its current details.");
  });
});
describe("image personal saved views", () => {
  it.each([1280, 390])("keeps saved-view requests bounded through load, open, save, and apply at %ipx", async (width) => {
    vi.stubGlobal("matchMedia", (query: string) => {
      const max = /max-width:\s*([\d.]+)rem/.exec(query);
      return {
        matches: max ? width <= Number(max[1]) * 16 : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      };
    });
    const view = { id: `news-images-${width}`, name: "News images", surface: "images" as const, query: "q=News&kind=image&sort=name&direction=asc" };
    const savedViewShell = {
      ...shell,
      principal: { ...shell.principal, id: `saved-image-count-${width}` },
      user: { ...shell.user, uid: `saved-image-count-${width}` },
    };
    mocks.loadSavedViews.mockResolvedValueOnce([view]);
    mocks.mutateSavedViews.mockImplementationOnce(async (_userId, mutation: { view: unknown }) => [view, mutation.view]);
    const counts = () => ({
      list: mocks.list.mock.calls.length,
      categories: mocks.listCategories.mock.calls.length,
      favoriteStates: mocks.listFavoriteStates.mock.calls.length,
      savedReads: mocks.loadSavedViews.mock.calls.length,
      savedTransactions: mocks.mutateSavedViews.mock.calls.length,
    });

    try {
      const { router } = renderRoute("/media/images?q=Current", savedViewShell);
      await screen.findByRole("button", { name: /^Studio control room/ });
      await waitFor(() => expect(counts()).toEqual({
        list: 1, categories: 1, favoriteStates: 1, savedReads: 0, savedTransactions: 0,
      }));

      fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
      const filter = screen.getByRole("dialog", { name: "Filter" });
      expect(await within(filter).findByRole("button", { name: view.name })).toBeInTheDocument();
      expect(counts()).toEqual({
        list: 1, categories: 1, favoriteStates: 1, savedReads: 1, savedTransactions: 0,
      });
      fireEvent.keyDown(filter, { key: "Escape" });

      fireEvent.click(screen.getByRole("button", { name: "Display" }));
      const display = screen.getByRole("dialog", { name: "Display" });
      expect(within(display).getByRole("button", { name: "Save as view" })).toBeEnabled();
      expect(counts()).toEqual({
        list: 1, categories: 1, favoriteStates: 1, savedReads: 1, savedTransactions: 0,
      });
      fireEvent.click(within(display).getByRole("button", { name: "Save as view" }));
      fireEvent.change(within(display).getByRole("textbox", { name: "Name" }), { target: { value: "Current images" } });
      fireEvent.click(within(display).getByRole("button", { name: "Save view" }));
      await waitFor(() => expect(counts()).toEqual({
        list: 1, categories: 1, favoriteStates: 1, savedReads: 1, savedTransactions: 1,
      }));
      fireEvent.keyDown(display, { key: "Escape" });

      fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
      fireEvent.click(await screen.findByRole("button", { name: view.name }));
      await waitFor(() => expect(router.state.location.search).toBe(`?q=News&kind=image&sort=name&direction=asc&view=${view.id}`));
      await waitFor(() => expect(counts()).toEqual({
        list: 2, categories: 1, favoriteStates: 2, savedReads: 1, savedTransactions: 1,
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads no profile on page load and expands an applied view into the URL", async () => {
    const view = { id: "news-images", name: "News images", surface: "images" as const, query: "q=News&kind=image&sort=name&direction=asc" };
    mocks.loadSavedViews.mockResolvedValueOnce([view]);
    const savedViewShell = {
      ...shell,
      principal: { ...shell.principal, id: "saved-image-user" },
      user: { ...shell.user, uid: "saved-image-user" },
    };
    const { router } = renderRoute("/media/images?page=3&selected=asset-one", savedViewShell);
    await screen.findByRole("button", { name: /^Studio control room/ });
    expect(mocks.loadSavedViews).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    fireEvent.click(await screen.findByRole("button", { name: view.name }));

    await waitFor(() => expect(router.state.location.search).toBe("?q=News&kind=image&sort=name&direction=asc&view=news-images"));
    expect(mocks.loadSavedViews).toHaveBeenCalledOnce();
  });

  it("applies a saved view after flushing a pending Type draft", async () => {
    const view = { id: "news-after-draft", name: "News after draft", surface: "images" as const, query: "q=News&kind=image" };
    mocks.loadSavedViews.mockResolvedValueOnce([view]);
    const draftUser = "saved-image-draft-user";
    const { router } = renderRoute("/media/images", {
      ...shell,
      principal: { ...shell.principal, id: draftUser },
      user: { ...shell.user, uid: draftUser },
    });
    await screen.findByRole("button", { name: /^Studio control room/ });

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    const filter = screen.getByRole("dialog", { name: "Filter" });
    await within(filter).findByRole("button", { name: view.name });
    fireEvent.click(within(filter).getByRole("button", { name: "Type" }));
    fireEvent.click(within(filter).getByRole("checkbox", { name: "Documents" }));
    fireEvent.click(within(filter).getByRole("button", { name: "All filters" }));
    fireEvent.click(within(filter).getByRole("button", { name: view.name }));

    await waitFor(() => expect(router.state.location.search).toBe("?q=News&kind=image&view=news-after-draft"));
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(router.state.location.search).toBe("?q=News&kind=image&view=news-after-draft");
  });

  it("refuses a saved view with display settings while asset details are unsaved", async () => {
    const view = { id: "news-display", name: "News display", surface: "images" as const,
      query: "q=News&kind=image", display: { ...DEFAULT_MEDIA_DISPLAY, layout: "list" as const } };
    mocks.loadSavedViews.mockResolvedValueOnce([view]);
    const dirtyUser = "saved-image-dirty-user";
    const { router } = renderRouteWithNotices("/media/images?selected=asset-one", {
      ...shell,
      principal: { ...shell.principal, id: dirtyUser },
      user: { ...shell.user, uid: dirtyUser },
    });
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved image name" } });
    const initialDisplay = localStorage.getItem(MEDIA_DISPLAY_STORAGE_KEY);

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    fireEvent.click(await screen.findByRole("button", { name: view.name }));

    expect(router.state.location.search).toBe("?selected=asset-one");
    expect(name).toHaveValue("Unsaved image name");
    expect(localStorage.getItem(MEDIA_DISPLAY_STORAGE_KEY)).toBe(initialDisplay);
    expect(screen.getByRole("region", { name: "Notifications" }))
      .toHaveTextContent("Finish editing asset details before opening a saved view.");
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();
  });

  it("removes only a missing image view reference after the first popover load", async () => {
    const savedViewShell = {
      ...shell,
      principal: { ...shell.principal, id: "missing-image-view-user" },
      user: { ...shell.user, uid: "missing-image-view-user" },
    };
    const { router } = renderRouteWithNotices("/media/images?q=News&kind=image&sort=name&view=missing", savedViewShell);
    await screen.findByRole("button", { name: /^Studio control room/ });
    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));

    await waitFor(() => expect(router.state.location.search).toBe("?q=News&kind=image&sort=name"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent("Current filters were kept."));
  });

  it("removes a missing view marker without blocking unsaved asset details", async () => {
    const dirtyUser = "missing-image-dirty-user";
    const { router } = renderRouteWithNotices("/media/images?selected=asset-one&view=missing", {
      ...shell,
      principal: { ...shell.principal, id: dirtyUser },
      user: { ...shell.user, uid: dirtyUser },
    });
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved image name" } });

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?selected=asset-one"));
    expect(name).toHaveValue("Unsaved image name");
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();
  });
});
