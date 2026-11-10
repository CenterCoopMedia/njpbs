import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { SourceMediaLibrary, VideoPoster } from "../src/routes/SourceMediaLibrary";
import { createSourceMediaRead, deleteSourceMedia, listSourceMedia, updateSourceMediaMetadata, type MediaSourceSummary, type SourceMediaAssetSummary, type SourceMediaPage, type SourceMediaRead } from "../src/lib/source-media";
import { HttpError } from "../src/lib/functions";
import { startVideoUpload, transferVideo } from "../src/lib/source-media-upload";
import { installTestLockManager } from "./helpers/web-locks";
import { cachedPoster, clearMediaSessionCache, invalidateMediaLists } from "../src/lib/media-session-cache";
import { resetUploadRouter, uploadRouterSnapshot } from "../src/lib/upload-router";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import type { MediaFavoriteRef } from "../src/lib/media-favorites";
import type { Principal } from "../../packages/content-core/src/rbac";
import { useSourceMediaAssetRefresh } from "../src/lib/use-source-media-asset-refresh";

const { getIdToken, listFavoriteStates, setFavorite, productionTranscriptReads, productionClipReads, loadSavedViews, mutateSavedViews } = vi.hoisted(() => ({
  getIdToken: vi.fn().mockResolvedValue("staff-token"),
  listFavoriteStates: vi.fn(),
  setFavorite: vi.fn(),
  productionTranscriptReads: vi.fn(),
  productionClipReads: vi.fn(),
  loadSavedViews: vi.fn(),
  mutateSavedViews: vi.fn(),
}));
vi.mock("../src/lib/source-media", () => ({ createSourceMediaRead: vi.fn(), deleteSourceMedia: vi.fn(), listSourceMedia: vi.fn(), updateSourceMediaMetadata: vi.fn() }));
vi.mock("../src/lib/source-media-upload", () => ({
  UploadFileMismatchError: class extends Error {},
  startVideoUpload: vi.fn(),
  transferVideo: vi.fn(),
  cancelVideoUpload: vi.fn(),
}));
vi.mock("../src/lib/media-favorites", () => ({
  listMediaFavoriteStates: (...args: unknown[]) => listFavoriteStates(...args),
  setMediaFavorite: (...args: unknown[]) => setFavorite(...args),
}));
vi.mock("../src/lib/saved-media-view-store", () => ({
  loadMediaLibraryViews: (...args: unknown[]) => loadSavedViews(...args),
  mutateMediaLibraryViews: (...args: unknown[]) => mutateSavedViews(...args),
}));
vi.mock("../src/components/VideoProductionTools", async () => {
  const { useState } = await vi.importActual<typeof import("react")>("react");
  return { useVideoProductionTools: ({ asset, canRequest }: { asset: SourceMediaAssetSummary; canRequest: boolean }) => {
    const [transcriptOpen, setTranscriptOpen] = useState(false);
    const [clipOpen, setClipOpen] = useState(false);
    return {
      content: <div data-viewer-keys="off">
        <p>Production access {canRequest ? "enabled" : "disabled"}</p>
        <button type="button" aria-expanded={transcriptOpen} onClick={() => {
          setTranscriptOpen(value => !value);
          if (!transcriptOpen) productionTranscriptReads(asset.id);
        }}>Test transcript</button>
        <button type="button" aria-expanded={clipOpen} onClick={() => {
          setClipOpen(value => !value);
          if (!clipOpen) productionClipReads(asset.id);
        }}>Test clips</button>
        {transcriptOpen ? <p>Transcript open for {asset.name}</p> : null}
        {clipOpen ? <p>Clips open for {asset.name}</p> : null}
      </div>,
      actions: <button type="button">Production action</button>,
      editorExportsItem: { key: "editor-export-settings", label: "Broadcast & editing exports…", onSelect: vi.fn() }, downloadItems: [],
      onTimeUpdate: vi.fn(),
    };
  } };
});

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

const source: MediaSourceSummary = { id: "video-library", label: "Video library", description: "Shared staff videos", mediaKind: "video", canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: true };
const usersViewer: Principal = { id: "staff", grants: [{ role: "admin" }] };
const asset: SourceMediaAssetSummary = { id: "video-1", sourceId: source.id, name: "News update", description: null, originalName: "news.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 10485760, preview: "browser", license: null, credit: null, tags: [], rightsStatus: "pending", version: 1, createdAt: null, updatedAt: null };
function videoRecords(count: number): SourceMediaAssetSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...asset,
    id: `video-${index + 1}`,
    name: `Video ${index + 1}`,
    originalName: `video-${index + 1}.mp4`,
  }));
}

function mediaRead(action: SourceMediaRead["action"], assetId = asset.id, url = `https://media.example.test/${action}`): SourceMediaRead {
  return {
    assetId,
    action,
    url,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    mimeType: action === "poster" ? "image/jpeg" : "video/mp4",
    disposition: action === "preview" || action === "poster" ? "inline" : "attachment",
    supportsRange: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// A card's open control is named by the item and its status words (MediaTile).
function card(name: string) { return new RegExp(`^${name}, video`); }
function tileOf(name: string) { return screen.getByRole("button", { name: card(name) }).closest(".media-tile") as HTMLElement; }
function selectionBar() { return screen.getByRole("group", { name: "Video selection" }); }
function videoInspector() { return screen.getByRole("complementary", { name: "Video details" }); }
function openDeleteSection() {
  const disclosure = within(videoInspector()).getByRole("button", { name: "Delete from library" });
  if (disclosure.getAttribute("aria-expanded") === "false") fireEvent.click(disclosure);
}
function deleteTrigger() {
  return within(videoInspector()).getAllByRole("button", { name: "Delete from library" })
    .find((button) => !button.hasAttribute("aria-controls")) as HTMLButtonElement;
}
function beginDeletion() {
  openDeleteSection();
  fireEvent.click(deleteTrigger());
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

function renderLibrary(
  mediaSource = source,
  initialEntry = "/media",
  principal: Principal | undefined = usersViewer,
  userId = "staff",
) {
  const router = createMemoryRouter([
    { path: "/media", element: <SourceMediaLibrary principal={principal} userId={userId} source={mediaSource} getIdToken={getIdToken} /> },
    { path: "/away", element: <h1>Away</h1> },
  ], { initialEntries: ["/away", initialEntry] });
  render(<RouterProvider router={router} />);
  return router;
}

function renderLibraryWithNotices(
  mediaSource = source,
  initialEntry = "/media",
  principal: Principal | undefined = usersViewer,
  userId = "staff",
) {
  function NoticedLibrary() {
    const location = useLocation();
    return <SuccessNoticeProvider routeKey={`${userId}:${location.key}`}>
      <SourceMediaLibrary principal={principal} userId={userId} source={mediaSource} getIdToken={getIdToken} />
    </SuccessNoticeProvider>;
  }
  const router = createMemoryRouter([
    { path: "/media", element: <NoticedLibrary /> },
    { path: "/away", element: <h1>Away</h1> },
  ], { initialEntries: ["/away", initialEntry] });
  render(<RouterProvider router={router} />);
  return router;
}

function videoSearch() {
  return screen.getByRole("searchbox", { name: "Search video names by prefix" });
}

function videoDropTarget() {
  const target = document.querySelector<HTMLElement>(".media-drop-target");
  if (!target) throw new Error("The video drop target is missing.");
  return target;
}

async function waitForVideoIntake() {
  await waitFor(() => expect(document.querySelector(".video-upload-panel")).not.toHaveAttribute("data-disabled"));
}

async function trayPause(name: string) {
  const tray = await screen.findByRole("region", { name: "Upload progress" });
  return within(tray).getByRole("button", { name: `Pause ${name}` });
}

function startPreparedVideo(name: string) {
  const sheet = document.querySelector<HTMLElement>(".media-upload-sheet");
  if (!sheet) throw new Error("The video upload sheet is missing.");
  fireEvent.click(within(sheet).getByRole("button", { name: `Start upload ${name}` }));
}

function openVideoFilter(property: "Tag" | "Rights review" | "Uploader") {
  fireEvent.click(screen.getByRole("button", { name: /^Filter(?:, \d+ applied)?$/ }));
  const dialog = screen.getByRole("dialog", { name: "Filter" });
  fireEvent.click(within(dialog).getByRole("button", { name: property }));
  return dialog;
}

function chooseVideoFilter(property: "Rights review" | "Uploader", value: string) {
  const dialog = openVideoFilter(property);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: value }));
  fireEvent.keyDown(dialog, { key: "Escape" });
}

function applyVideoTag(value: string) {
  const dialog = openVideoFilter("Tag");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Tag" }), { target: { value } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply tag" }));
  return dialog;
}

function openVideoDisplay() {
  fireEvent.click(screen.getByRole("button", { name: "Display" }));
  return screen.getByRole("dialog", { name: "Display" });
}

function chooseVideoLayout(label: "Grid" | "List") {
  const dialog = openVideoDisplay();
  fireEvent.click(within(dialog).getByRole("radio", { name: label }));
  fireEvent.keyDown(dialog, { key: "Escape" });
}

beforeEach(() => {
  clearMediaSessionCache();
  // Clear unused one-shot responses as well as call history between tests.
  vi.resetAllMocks();
  installMediaFeedbackFetch();
  getIdToken.mockResolvedValue("staff-token");
  localStorage.clear();
  resetUploadRouter();
  setViewport(1280);
  installTestLockManager();
  vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [asset], nextCursor: null, hasMore: false, total: 1 });
  loadSavedViews.mockResolvedValue([]);
  listFavoriteStates.mockImplementation(async (_token: string, refs: MediaFavoriteRef[]) => ({
    success: true,
    states: refs.map(ref => ({ ref, favorite: false })),
  }));
  setFavorite.mockImplementation(async (_token: string, ref: MediaFavoriteRef, favorite: boolean) => ({
    success: true, ref, favorite, changed: true,
  }));
  vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) => mediaRead(action, assetId));
  vi.mocked(startVideoUpload).mockResolvedValue({ success: true, upload: {
    sessionId: "upload-session", assetId: "upload-asset", partSize: 4, totalParts: 1,
    expiresAt: "2026-09-15T00:00:00Z", version: 1,
  } });
  vi.mocked(transferVideo).mockImplementation(({ signal, onPhase }) => {
    onPhase("uploading");
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Paused", "AbortError")));
    });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("private video library", () => {
  it("uses a list-signed poster in Quick Look without another read", async () => {
    const ready = { ...asset, viewingCopy: { state: "ready" as const } };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1,
      posters: [{ assetId: ready.id, url: "https://media.example.test/listed-poster", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }] });
    renderLibrary();
    fireEvent.keyDown(await screen.findByRole("button", { name: card("News update") }), { key: "y", ctrlKey: true });
    const look = await screen.findByRole("dialog", { name: "Quick Look: News update" });
    expect(look.querySelector("img")).toHaveAttribute("src", "https://media.example.test/listed-poster");
    expect(createSourceMediaRead).not.toHaveBeenCalled();
  });

  it("invalidates a failed signed poster so reopening Quick Look can read a new one", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
    });
    const ready = { ...asset, viewingCopy: { state: "ready" as const } };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1,
      posters: [{ assetId: ready.id, url: "https://media.example.test/broken-poster", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }] });
    renderLibrary();
    const cardControl = await screen.findByRole("button", { name: card("News update") });
    fireEvent.keyDown(cardControl, { key: "y", ctrlKey: true });
    const look = await screen.findByRole("dialog", { name: "Quick Look: News update" });
    fireEvent.error(look.querySelector("img")!);
    expect(look).toHaveTextContent("Preview unavailable");
    fireEvent.keyDown(look, { key: "Escape" });
    fireEvent.keyDown(cardControl, { key: "y", ctrlKey: true });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Quick Look: News update" }).querySelector("img"))
      .toHaveAttribute("src", "https://media.example.test/poster"));
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
  });

  it("shares one queued poster read for Quick Look and reuses it when stepping back", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
    });
    const ready = { ...asset, viewingCopy: { state: "ready" as const } };
    const next = { ...ready, id: "video-2", name: "Evening update" };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [ready, next], nextCursor: null, hasMore: false, total: 2,
      posters: [{ assetId: next.id, url: "https://media.example.test/next-poster", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }] });
    renderLibrary();
    fireEvent.keyDown(await screen.findByRole("button", { name: card("News update") }), { key: "y", ctrlKey: true });
    const look = await screen.findByRole("dialog", { name: "Quick Look: News update" });
    await waitFor(() => expect(look.querySelector("img")).toHaveAttribute("src", "https://media.example.test/poster"));
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
    expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", ready.id, "poster");
    fireEvent.keyDown(look, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "Quick Look: Evening update" }).querySelector("img"))
      .toHaveAttribute("src", "https://media.example.test/next-poster");
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Quick Look: Evening update" }), { key: "ArrowLeft" });
    expect(screen.getByRole("dialog", { name: "Quick Look: News update" }).querySelector("img"))
      .toHaveAttribute("src", "https://media.example.test/poster");
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
  });

  it("keeps queued poster reads with equal asset ids separate across sources", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
    });
    const sourceA = { ...source, id: "source-a", label: "Source A" };
    const sourceB = { ...source, id: "source-b", label: "Source B" };
    const assetA = { ...asset, id: "shared", sourceId: sourceA.id, name: "Source A video", viewingCopy: { state: "ready" as const } };
    const assetB = { ...asset, id: "shared", sourceId: sourceB.id, name: "Source B video", viewingCopy: { state: "ready" as const } };
    const readA = deferred<SourceMediaRead>();
    const readB = deferred<SourceMediaRead>();
    vi.mocked(listSourceMedia).mockImplementation(async (_token, query) => ({
      success: true,
      records: query.sourceId === sourceA.id ? [assetA] : [assetB],
      nextCursor: null,
      hasMore: false,
      total: 1,
    }));
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, sourceId) => (
      sourceId === sourceA.id ? readA.promise : readB.promise
    ));

    renderLibrary(sourceA);
    renderLibrary(sourceB);
    fireEvent.keyDown(await screen.findByRole("button", { name: card(assetA.name) }), { key: "y", ctrlKey: true });
    fireEvent.keyDown(await screen.findByRole("button", { name: card(assetB.name) }), { key: "y", ctrlKey: true });
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(2));
    expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", sourceA.id, assetA.id, "poster");
    expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", sourceB.id, assetB.id, "poster");

    await act(async () => {
      readA.resolve(mediaRead("poster", assetA.id, "https://media.example.test/source-a-poster"));
      readB.resolve(mediaRead("poster", assetB.id, "https://media.example.test/source-b-poster"));
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: `Quick Look: ${assetA.name}` }).querySelector("img"))
        .toHaveAttribute("src", "https://media.example.test/source-a-poster");
      expect(screen.getByRole("dialog", { name: `Quick Look: ${assetB.name}` }).querySelector("img"))
        .toHaveAttribute("src", "https://media.example.test/source-b-poster");
    });
  });

  it("shows a poster when a processing video becomes ready during a poll", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", class {
      observe() {} disconnect() {} unobserve() {} takeRecords() { return []; }
    });
    const processing = { ...asset, viewingCopy: { state: "processing" as const } };
    const ready = { ...processing, viewingCopy: { state: "ready" as const } };
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [processing], nextCursor: null, hasMore: false, total: 1 })
      .mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    fireEvent.keyDown(screen.getByRole("button", { name: card("News update") }), { key: "y", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Quick Look: News update" })).toHaveTextContent("Preview unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listSourceMedia).toHaveBeenCalledTimes(3);
    expect(listSourceMedia).toHaveBeenNthCalledWith(2, "staff-token", { sourceId: source.id, pendingIds: [asset.id] });
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", expect.not.objectContaining({ posters: true }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Quick Look: News update" }).querySelector("img"))
      .toHaveAttribute("src", "https://media.example.test/poster");
  });

  it("keeps production tools available without upload or metadata access", async () => {
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const dialog = screen.getByRole("dialog", { name: "News update" });
    expect(within(dialog.querySelector("header")!).getByRole("heading", { name: "News update" })).toBeInTheDocument();
    expect(within(dialog).queryByText("Video preview")).not.toBeInTheDocument();
    const sections = dialog.querySelector(".video-viewer-production") as HTMLElement;
    expect(within(sections).getByText("Production access enabled")).toBeInTheDocument();
    expect(within(sections).getByRole("button", { name: "Production action" })).toBeInTheDocument();
    expect(within(dialog).getByRole("tab", { name: "Watch & details" })).toHaveAttribute("aria-selected", "true");
    const watch = within(dialog).getByRole("tabpanel", { name: "Watch & details" });
    expect(watch).toContainElement(sections);
    expect(watch.parentElement).toContainElement(within(dialog).getByRole("tabpanel", { name: "Transcript" }));
    const notice = within(videoInspector()).getByText("Read-only media access").closest(".inline-message");
    expect(notice).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    expect(within(videoInspector()).queryByRole("button", { name: "Save details" })).toBeNull();
    expect(within(videoInspector()).queryByRole("button", { name: "Delete from library" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload media" })).not.toBeInTheDocument();
  });

  it("favorites a video without opening it and uses one page lookup", async () => {
    renderLibrary();

    const favorite = await screen.findByRole("button", {
      name: "Add to favorites: News update",
    });
    // The heart sits in the tile's quick-action cluster.
    expect(favorite.closest(".media-tile-actions")).not.toBeNull();
    expect(listFavoriteStates).toHaveBeenCalledTimes(1);
    expect(listFavoriteStates).toHaveBeenCalledWith("staff-token", [
      { backend: "s3", sourceId: "video-library", id: "video-1" },
    ]);

    fireEvent.click(favorite);
    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith(
      "staff-token",
      { backend: "s3", sourceId: "video-library", id: "video-1" },
      true,
    ));
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Preview News update")).not.toBeInTheDocument();
  });

  it.each([1280, 390])("offers Undo for a confirmed video favorite using its full source identity at %ipx", async width => {
    setViewport(width);
    const router = createMemoryRouter([{ path: "/media", element: <SuccessNoticeProvider routeKey="staff:video"><SourceMediaLibrary
      principal={usersViewer} userId="staff" source={source} getIdToken={getIdToken} />
    </SuccessNoticeProvider> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites: News update" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => expect(notice).toHaveTextContent("News update was added to your favorites."));
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(setFavorite).toHaveBeenCalledTimes(2));
    expect(setFavorite).toHaveBeenLastCalledWith("staff-token", { backend: "s3", sourceId: "video-library", id: "video-1" }, false);
    expect(listSourceMedia).toHaveBeenCalledOnce();
  });

  it("requests private playback only after selection and provides native seeking controls", async () => {
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const video = await screen.findByLabelText("Preview News update");
    expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", "video-1", "preview");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(screen.queryByText(/Changes stay in this draft/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByLabelText("Preview News update")).not.toBeInTheDocument();
  });

  it.each([1280, 390])("steps through the fixed page with one preview read and no list or favorite read at %ipx", async (width) => {
    setViewport(width);
    const records = videoRecords(3);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 3 });
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("Video 1") }));
    await screen.findByLabelText("Preview Video 1");
    const dialog = screen.getByRole("dialog", { name: "Video 1" });
    expect(screen.getByText("1 of 3")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Previous file" })).toBeDisabled();
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    await screen.findByLabelText("Preview Video 2");
    expect(screen.getByRole("dialog", { name: "Video 2" })).toBe(dialog);
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next file" })).toHaveFocus());
    expect(vi.mocked(createSourceMediaRead).mock.calls.map(call => [call[2], call[3]])).toEqual([
      ["video-1", "preview"], ["video-2", "preview"],
    ]);
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    expect(listFavoriteStates).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    await screen.findByLabelText("Preview Video 3");
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next file" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous file" })).toHaveFocus());
    expect(createSourceMediaRead).toHaveBeenCalledTimes(3);
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    expect(listFavoriteStates).toHaveBeenCalledTimes(1);
  });

  it("shows the opening page position and does not prefetch another preview", async () => {
    const records = videoRecords(24);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 24 });
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("Video 3") }));
    await screen.findByLabelText("Preview Video 3");
    expect(screen.getByText("3 of 24")).toBeInTheDocument();
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
    expect(createSourceMediaRead).toHaveBeenLastCalledWith("staff-token", "video-library", "video-3", "preview");
  });

  it("does not request a preview when stepping to a download-only video", async () => {
    const [first, second] = videoRecords(2);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [first, { ...second, preview: "download_only" }], nextCursor: null, hasMore: false, total: 2 });
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("Video 1") }));
    await screen.findByLabelText("Preview Video 1");
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    await screen.findByText("This video format needs a compatible player on your computer.");
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
  });

  it("leaves arrows with the player, fields and production regions", async () => {
    const records = videoRecords(2);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 2 });
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("Video 1") }));
    const player = await screen.findByLabelText("Preview Video 1");
    const title = screen.getByRole("textbox", { name: "Title" });
    const transcript = screen.getByRole("button", { name: "Test transcript" });
    for (const target of [player, title, transcript]) fireEvent.keyDown(target, { key: "ArrowRight" });
    expect(screen.getByLabelText("Preview Video 1")).toBeInTheDocument();
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
  });

  it("asks before a dirty step and remounts closed production state after discard", async () => {
    const records = videoRecords(2);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 2 });
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("Video 1") }));
    await screen.findByLabelText("Preview Video 1");
    fireEvent.click(screen.getByRole("button", { name: "Test transcript" }));
    fireEvent.click(screen.getByRole("button", { name: "Test clips" }));
    expect(productionTranscriptReads).toHaveBeenCalledTimes(1);
    expect(productionClipReads).toHaveBeenCalledTimes(1);
    const title = screen.getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Unsaved title" } });

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(await screen.findByText("Open the next video without saving your changes?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(title).toHaveValue("Unsaved title");
    await waitFor(() => expect(screen.getByRole("button", { name: "Next file" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await screen.findByLabelText("Preview Video 2");
    await waitFor(() => expect(screen.getByRole("button", { name: "Previous file" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Test transcript" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Test clips" })).toHaveAttribute("aria-expanded", "false");
    expect(productionTranscriptReads).toHaveBeenCalledTimes(1);
    expect(productionClipReads).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the video on screen after stepping and closing", async () => {
    const records = videoRecords(3);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 3 });
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("Video 1") }));
    await screen.findByLabelText("Preview Video 1");
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    await screen.findByLabelText("Preview Video 2");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: card("Video 2") })).toHaveFocus());
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
  });

  it("reloads the card after a conflict reload when the viewer closes", async () => {
    const current = { ...asset, name: "Updated by a colleague", version: 2 };
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [asset], nextCursor: null, hasMore: false, total: 1 })
      .mockResolvedValueOnce({ success: true, records: [current], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(updateSourceMediaMetadata).mockRejectedValueOnce(new HttpError(409, "Video changed", { current }));
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "My title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload details" }));
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: card("Updated by a colleague") })).toHaveFocus());
    expect(listSourceMedia).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: card("Updated by a colleague") }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(current.name);
  });

  it("drops a pending return-focus request when the close reload fails", async () => {
    const saved = { ...asset, name: "Saved title", version: 2 };
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [asset], nextCursor: null, hasMore: false, total: 1 })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ success: true, records: [], nextCursor: null, hasMore: false, total: 0 });
    vi.mocked(updateSourceMediaMetadata).mockResolvedValueOnce({ success: true, asset: saved });
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: saved.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByText("Video details saved.");
    // The save message can render before the viewer receives the idle state.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Close" })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    const retry = await screen.findByRole("button", { name: "Try again" });
    const search = videoSearch();
    search.focus();
    fireEvent.click(retry);
    await screen.findByText("No videos found");
    expect(search).toHaveFocus();
    expect(screen.queryByText(/no longer matches this view/)).toBeNull();
  });

  it("reloads once after save and focuses the next opening-order card when the saved video leaves the view", async () => {
    const records = videoRecords(3);
    const saved = { ...records[1], name: "Moved video", version: 2 };
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records, nextCursor: null, hasMore: false, total: 3 })
      .mockResolvedValueOnce({ success: true, records: [records[0], records[2]], nextCursor: null, hasMore: false, total: 2 });
    vi.mocked(updateSourceMediaMetadata).mockResolvedValueOnce({ success: true, asset: saved });
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("Video 2") }));
    await screen.findByLabelText("Preview Video 2");
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: saved.name } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save details" })); });
    await screen.findByText("Video details saved.");
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Close" })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: card("Video 3") })).toHaveFocus());
    expect(screen.getByText("Moved video no longer matches this view.")).toBeInTheDocument();
  });

  it("does not restart the processing poll while stepping", async () => {
    vi.useFakeTimers();
    const records = videoRecords(3);
    records[2] = { ...records[2], viewingCopy: { state: "processing" } };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 3 });
    renderLibrary();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: card("Video 1") }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next file" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next file" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(listSourceMedia).toHaveBeenCalledTimes(2);
  });

  it("clears old results when access is denied instead of exposing cached records", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    vi.mocked(listSourceMedia).mockRejectedValueOnce(new Error("forbidden"));
    fireEvent.change(videoSearch(), { target: { value: "other" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    await screen.findByText("Video library unavailable");
    expect(screen.queryByRole("button", { name: card("News update") })).not.toBeInTheDocument();
  });

  it("keeps existing results when normalized search text exceeds the server limit", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    const search = videoSearch();
    const expandsPastLimit = "\uFDFA".repeat(9);
    expect(expandsPastLimit.normalize("NFKC").length).toBeGreaterThan(160);
    expect(search).toHaveAttribute("maxlength", "160");
    fireEvent.change(search, { target: { value: expandsPastLimit } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Search text must be 160 characters or fewer after text normalization.");
    expect(screen.getByRole("button", { name: card("News update") })).toBeInTheDocument();
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
  });

  it("does not request a streaming link for a download-only format", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{ ...asset, preview: "download_only" }], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    await screen.findByText("This video format needs a compatible player on your computer.");
    expect(createSourceMediaRead).not.toHaveBeenCalled();
  });

  it("refreshes an already mounted ready poster and its remount cache when fileVersion changes", async () => {
    const first = { ...asset, fileVersion: "original-file", viewingCopy: { state: "ready" as const } };
    const next = { ...first, fileVersion: "corrected-file" };
    const oldUrl = "https://media.example.test/old-file-poster";
    const newUrl = "https://media.example.test/new-file-poster";
    vi.mocked(createSourceMediaRead)
      .mockResolvedValueOnce(mediaRead("poster", asset.id, oldUrl))
      .mockResolvedValueOnce(mediaRead("poster", asset.id, newUrl));
    const mounted = render(<VideoPoster asset={first} getIdToken={getIdToken} />);
    await waitFor(() => expect(document.querySelector(`img[src="${oldUrl}"]`)).toBeInTheDocument());
    mounted.rerender(<VideoPoster asset={next} getIdToken={getIdToken} />);
    await waitFor(() => expect(document.querySelector(`img[src="${newUrl}"]`)).toBeInTheDocument());
    expect(document.querySelector(`img[src="${oldUrl}"]`)).not.toBeInTheDocument();
    expect(createSourceMediaRead).toHaveBeenCalledTimes(2);
    mounted.unmount();
    render(<VideoPoster asset={next} getIdToken={getIdToken} />);
    await waitFor(() => expect(document.querySelector(`img[src="${newUrl}"]`)).toBeInTheDocument());
    expect(createSourceMediaRead).toHaveBeenCalledTimes(2);
  });

  it.each(["Grid", "List"])("refreshes a stale %s poster from a file-version mismatch without opening a viewer", async layout => {
    const first = { ...asset, fileVersion: "poster-v1", viewingCopy: { state: "ready" as const } };
    const fresh = { ...first, name: "Current file", fileVersion: "poster-v2", version: 2 };
    let reads = 0;
    vi.mocked(listSourceMedia).mockImplementation(async () => ({ success: true,
      records: [++reads === 1 ? first : fresh], nextCursor: null, hasMore: false, total: 1 }));
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, id, action) => ({
      ...mediaRead(action, id, "https://media.example.test/current-poster"), fileVersion: fresh.fileVersion }));
    if (layout === "List") localStorage.setItem("njpbs-admin:media-display:video", JSON.stringify({ layout: "list" }));
    renderLibrary();
    await waitFor(() => expect(document.querySelector('img[src="https://media.example.test/current-poster"]')).toBeInTheDocument());
    expect(screen.getByRole("grid", { name: "Videos" })).toHaveAttribute("data-layout", layout.toLowerCase());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: card("News update") })).not.toBeInTheDocument();
    expect(reads).toBe(2);
    expect(cachedPoster(source.id, asset.id, first.fileVersion)).toBeUndefined();
    expect(cachedPoster(source.id, asset.id, fresh.fileVersion)).toBe("https://media.example.test/current-poster");
  });

  it("recovers a foreground load after a late poster detects a replacement and its reload fails", async () => {
    const first = { ...asset, fileVersion: "loading-v1", viewingCopy: { state: "ready" as const } };
    const fresh = { ...first, name: "Weather report", fileVersion: "loading-v2", version: 2 };
    const poster = deferred<SourceMediaRead>(), foreground = deferred<SourceMediaPage>();
    const page = (record: SourceMediaAssetSummary): SourceMediaPage => ({ success: true, records: [record], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(listSourceMedia).mockResolvedValueOnce(page(first)).mockReturnValueOnce(foreground.promise)
      .mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(page(fresh));
    vi.mocked(createSourceMediaRead).mockReturnValueOnce(poster.promise)
      .mockImplementation(async (_token, _sourceId, id, action) => ({ ...mediaRead(action, id), fileVersion: fresh.fileVersion }));
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", source.id, asset.id, "poster"));
    fireEvent.change(videoSearch(), { target: { value: "Weather" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(2));
    await act(async () => { poster.resolve({ ...mediaRead("poster"), fileVersion: fresh.fileVersion }); });
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByText("Videos could not be loaded. Try again.")).toBeVisible();
    await act(async () => { foreground.resolve(page(first)); });
    expect(screen.queryByRole("button", { name: card("News update") })).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: card("Weather report") })).toBeVisible();
    expect(screen.queryByText("Videos could not be loaded. Try again.")).not.toBeInTheDocument();
  });

  it("does not share a pending poster request across replacement file identities", async () => {
    const first = { ...asset, fileVersion: "original-file", viewingCopy: { state: "ready" as const } };
    const next = { ...first, fileVersion: "corrected-file" };
    const pending = deferred<SourceMediaRead>();
    const oldUrl = "https://media.example.test/late-old-poster";
    const newUrl = "https://media.example.test/current-poster";
    vi.mocked(createSourceMediaRead).mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(mediaRead("poster", asset.id, newUrl));
    const mounted = render(<VideoPoster asset={first} getIdToken={getIdToken} />);
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(1));
    mounted.rerender(<VideoPoster asset={next} getIdToken={getIdToken} />);
    try { await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(2)); }
    finally { await act(async () => { pending.resolve(mediaRead("poster", asset.id, oldUrl)); }); }
    await waitFor(() => expect(document.querySelector(`img[src="${newUrl}"]`)).toBeInTheDocument());
    expect(document.querySelector(`img[src="${oldUrl}"]`)).not.toBeInTheDocument();
  });

  it("loads a ready poster only after its card enters the viewport", async () => {
    let reveal: (() => void) | undefined;
    const observed: Element[] = [];
    let margin = "";
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        margin = options?.rootMargin ?? "";
        reveal = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{ ...asset, viewingCopy: { state: "ready", sizeBytes: 4 * 1024 ** 2 } }], nextCursor: null, hasMore: false, total: 1 });

    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    // The observed element is the poster frame in the tile thumbnail, with the 160px margin.
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(element => element.closest(".media-tile-thumb") === tileOf("News update").querySelector(".media-tile-thumb"))).toBe(true);
    expect(margin).toBe("160px");
    act(() => reveal?.());
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", "video-1", "poster"));
    expect(document.querySelector('img[src="https://media.example.test/poster"]')).toBeInTheDocument();
  });

  it("shows posters signed with the page without a read call per tile", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({
      success: true,
      records: [{ ...asset, viewingCopy: { state: "ready" } }],
      nextCursor: null,
      hasMore: false,
      total: 1,
      posters: [{ assetId: asset.id, url: "https://media.example.test/listed-poster", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }],
    });
    renderLibrary();
    await waitFor(() => expect(document.querySelector('img[src="https://media.example.test/listed-poster"]')).toBeInTheDocument());
    expect(createSourceMediaRead).not.toHaveBeenCalled();
  });

  it("keeps an unexpired poster URL when a list refresh signs the same object again", async () => {
    const ready = { ...asset, viewingCopy: { state: "ready" as const } };
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const firstUrl = "https://media.example.test/poster.jpg?versionId=poster-v1&X-Amz-Date=20261002T120000Z&X-Amz-Signature=first";
    const resignedUrl = "https://media.example.test/poster.jpg?versionId=poster-v1&X-Amz-Date=20261002T120100Z&X-Amz-Signature=second";
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1,
        posters: [{ assetId: ready.id, url: firstUrl, expiresAt }] })
      .mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1,
        posters: [{ assetId: ready.id, url: resignedUrl, expiresAt }] });
    renderLibrary();
    await waitFor(() => expect(cachedPoster(source.id, ready.id)).toBe(firstUrl));

    fireEvent.change(videoSearch(), { target: { value: "News" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(2));
    expect(cachedPoster(source.id, ready.id)).toBe(firstUrl);
  });

  it("replaces an unexpired poster URL when the object version changes", async () => {
    const ready = { ...asset, viewingCopy: { state: "ready" as const } };
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const firstUrl = "https://media.example.test/poster.jpg?versionId=poster-v1&X-Amz-Signature=first";
    const replacementUrl = "https://media.example.test/poster.jpg?versionId=poster-v2&X-Amz-Signature=second";
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1,
        posters: [{ assetId: ready.id, url: firstUrl, expiresAt }] })
      .mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1,
        posters: [{ assetId: ready.id, url: replacementUrl, expiresAt }] });
    renderLibrary();
    await waitFor(() => expect(cachedPoster(source.id, ready.id)).toBe(firstUrl));

    fireEvent.change(videoSearch(), { target: { value: "News" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(2));
    expect(cachedPoster(source.id, ready.id)).toBe(replacementUrl);
  });

  it("reuses a poster before expiry and signs it again after the safety window", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{ ...asset, viewingCopy: { state: "ready" } }], nextCursor: null, hasMore: false, total: 1 });
    const router = renderLibrary();
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('img[src="https://media.example.test/poster"]')).toBeInTheDocument());
    await act(async () => { await router.navigate("/away"); });
    await act(async () => { await router.navigate("/media"); });
    await screen.findByRole("button", { name: card("News update") });
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
    now += 4 * 60_000;
    await act(async () => { await router.navigate("/away"); });
    await act(async () => { await router.navigate("/media"); });
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(2));
  });

  it("bounds concurrent poster-link requests", async () => {
    const resolvers: Array<(access: SourceMediaRead) => void> = [];
    vi.mocked(createSourceMediaRead).mockImplementation((_token, _sourceId, assetId, action) => {
      expect(action).toBe("poster");
      return new Promise(resolve => resolvers.push(resolve));
    });
    const records = Array.from({ length: 5 }, (_, index): SourceMediaAssetSummary => ({
      ...asset,
      id: `video-${index + 1}`,
      name: `Video ${index + 1}`,
      viewingCopy: { state: "ready", sizeBytes: 4 * 1024 ** 2 },
    }));
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: records.length });

    renderLibrary();
    await screen.findByRole("button", { name: card("Video 5") });
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(4));
    resolvers[0](mediaRead("poster", "video-1"));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(5));
    resolvers.slice(1).forEach((resolve, index) => resolve(mediaRead("poster", `video-${index + 2}`)));
    await act(async () => { await Promise.resolve(); });
  });

  it("plays a ready web copy for a download-only original and offers both downloads", async () => {
    const ready: SourceMediaAssetSummary = {
      ...asset,
      preview: "download_only",
      sizeBytes: 3.5 * 1024 ** 3,
      viewingCopy: { state: "ready", sizeBytes: 180 * 1024 ** 2, width: 1920, height: 1080, durationSeconds: 166, sourceFrameRateNumerator: 30000, sourceFrameRateDenominator: 1001 },
    };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1 });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    renderLibrary();
    const open = await screen.findByRole("button", { name: card("News update") });
    expect(open).toHaveAccessibleDescription(/Preview ready.*Original 3\.5 GB.*Web copy 180\.0 MB/);
    // The status and file facts are the tile's, with the web copy in its hidden facts.
    expect(tileOf("News update")).toHaveTextContent("Preview ready");
    expect(tileOf("News update")).toHaveTextContent("Original 3.5 GB");
    expect(tileOf("News update")).toHaveTextContent("Web copy 180.0 MB");
    fireEvent.click(open);

    expect(await screen.findByLabelText("Preview News update")).toHaveAttribute("controls");
    expect(screen.queryByText("Available to all active Boardwalk staff.")).not.toBeInTheDocument();
    expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", "video-1", "preview");
    // The card's duration badge also reads 2:46, so read the viewer's file facts.
    const viewer = screen.getByRole("dialog", { name: "News update" });
    fireEvent.click(within(videoInspector()).getByRole("button", { name: "File information" }));
    expect(within(viewer).getByText("1920 × 1080")).toBeInTheDocument();
    expect(within(viewer).getByText("2:46")).toBeInTheDocument();
    expect(within(videoInspector()).getByText("29.97 fps (30000/1001)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Web copy/ }));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", "video-1", "download_web"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Original/ }));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", "video-1", "download"));
    expect(vi.mocked(createSourceMediaRead).mock.calls.filter(([, , , action]) => action === "download_web")).toHaveLength(1);
    expect(vi.mocked(createSourceMediaRead).mock.calls.filter(([, , , action]) => action === "download")).toHaveLength(1);
    expect(click).toHaveBeenCalledTimes(2);
  });

  it.each(["download", "download_web"] as const)("holds the viewer during %s without marking the page as unsaved", async action => {
    const ready = { ...asset, viewingCopy: { state: "ready" as const, sizeBytes: 4 * 1024 ** 2 } };
    const pending = deferred<SourceMediaRead>();
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(createSourceMediaRead).mockImplementation((_token, _sourceId, assetId, requested) =>
      requested === action ? pending.promise : Promise.resolve(mediaRead(requested, assetId)));
    const leaveWarnings: boolean[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      leaveWarnings.push(unload.defaultPrevented);
    });
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const viewer = await screen.findByRole("dialog", { name: "News update" });
    fireEvent.click(within(viewer).getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: action === "download" ? /^Original/ : /^Web copy/ }));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", asset.id, action));
    await waitFor(() => expect(within(viewer).getByRole("button", { name: "Close" })).toBeDisabled());
    const during = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(false);
    await act(async () => pending.resolve(mediaRead(action)));
    await waitFor(() => expect(within(viewer).getByRole("button", { name: "Close" })).toBeEnabled());
    expect(leaveWarnings).toEqual([false]);
    fireEvent.change(within(videoInspector()).getByRole("textbox", { name: "Title" }), { target: { value: "Unsaved title" } });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("asks for confirmation before downloading a video with a saved credit", async () => {
    const credited = { ...asset, credit: "On-screen credit: NJ PBS archive" };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [credited], nextCursor: null, hasMore: false, total: 1 });
    const confirm = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    await screen.findByLabelText("Preview News update");
    const download = screen.getByRole("button", { name: "Download" });
    expect(within(videoInspector()).queryByRole("button", { name: /^Download/ })).not.toBeInTheDocument();

    fireEvent.click(download);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Original/ }));
    expect(confirm).toHaveBeenCalledWith(
      "This video requires an on-screen credit. Check the Credit field for details.\n\nContinue with the download?",
    );
    expect(vi.mocked(createSourceMediaRead).mock.calls.some(([, , , action]) => action === "download")).toBe(false);

    fireEvent.click(download);
    fireEvent.click(screen.getByRole("menuitem", { name: /^Original/ }));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", "video-1", "download"));
  });

  it("does not offer preview refresh for a download failure", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    const ready = { ...asset, preview: "download_only" as const, viewingCopy: { state: "ready" as const, sizeBytes: 4 * 1024 ** 2 } };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) => {
      if (action === "download_web") throw new Error("download failed");
      return mediaRead(action, assetId);
    });

    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    await screen.findByLabelText("Preview News update");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Web copy/ }));

    expect(await screen.findByText("The web copy could not be downloaded. Try again.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh preview" })).not.toBeInTheDocument();
  });

  it("shows one shared renewal status when the first preview failed and keeps its linked time", async () => {
    const pending = deferred<SourceMediaRead>();
    let previewReads = 0;
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, id, action) => {
      if (action !== "preview") return mediaRead(action, id);
      previewReads += 1;
      if (previewReads === 1) throw new Error("Unavailable");
      return pending.promise;
    });
    renderLibrary(source, "/media?asset=video-1&t=72");
    fireEvent.click(await screen.findByRole("button", { name: "Refresh preview" }));
    await waitFor(() => expect(previewReads).toBe(2));
    try {
      const notices = document.querySelector<HTMLElement>(".media-dialog-notices")!;
      expect(within(notices).getByRole("status", { name: "Renewing private preview" })).toBeInTheDocument();
      expect(screen.getAllByRole("status", { name: "Renewing private preview" })).toHaveLength(1);
      expect(screen.queryByLabelText("Preview News update")).not.toBeInTheDocument();
    } finally {
      await act(async () => { pending.resolve(mediaRead("preview", asset.id, "https://media.example.test/renewed-preview")); });
    }
    const player = await screen.findByLabelText("Preview News update") as HTMLVideoElement;
    expect(screen.queryByRole("status", { name: "Renewing private preview" })).not.toBeInTheDocument();
    Object.defineProperty(player, "duration", { value: 120, configurable: true });
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBe(72);
  });

  it.each(["paused", "playing", "resumed", "error"])("renews five-minute previews without replacing a playing source (%s)", async (state) => {
    const paused = state === "paused";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T22:00:00Z"));
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    const ready = { ...asset, preview: "download_only" as const, viewingCopy: { state: "ready" as const, sizeBytes: 4 * 1024 ** 2 } };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [ready], nextCursor: null, hasMore: false, total: 1 });
    let previewReads = 0;
    const renewal = deferred<SourceMediaRead>();
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) => {
      if (action === "preview") previewReads += 1;
      if (action === "preview" && previewReads === 2 && state === "resumed") return renewal.promise;
      return mediaRead(action, assetId, `https://media.example.test/${action}-${previewReads}`);
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();

    renderLibrary();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: card("News update") }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const video = screen.getByLabelText("Preview News update") as HTMLVideoElement;
    video.currentTime = 42;
    video.playbackRate = 1.5;
    Object.defineProperty(video, "paused", { configurable: true, value: state === "paused" || state === "resumed" });
    Object.defineProperty(video, "duration", { configurable: true, value: 900 });
    fireEvent.timeUpdate(video);

    await act(async () => { await vi.advanceTimersByTimeAsync(269_999); });
    expect(previewReads).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(previewReads).toBe(2);
    if (state === "resumed") {
      Object.defineProperty(video, "paused", { configurable: true, value: false });
      fireEvent.play(video);
      await act(async () => { renewal.resolve(mediaRead("preview", asset.id, "https://media.example.test/preview-2")); });
    }
    expect(createSourceMediaRead).toHaveBeenLastCalledWith("staff-token", source.id, asset.id, "preview");
    expect(video.src).toBe(`https://media.example.test/preview-${paused ? 2 : 1}`);
    expect(video.currentTime).toBe(42);
    expect(video.paused).toBe(paused);
    expect(play).not.toHaveBeenCalled();

    // Keep authorizing fresh links during playback, even after the active URL expires.
    await act(async () => { await vi.advanceTimersByTimeAsync(270_000); });
    expect(previewReads).toBe(3);
    expect(video.src).toBe(`https://media.example.test/preview-${paused ? 3 : 1}`);
    video.currentTime = 420;
    if (state === "error") {
      Object.defineProperty(video, "error", { configurable: true, value: { code: 2 } });
      fireEvent.error(video);
    } else {
      Object.defineProperty(video, "paused", { configurable: true, value: true });
      fireEvent.pause(video);
    }
    expect(screen.getByLabelText("Preview News update")).toBe(video);
    expect(video.src).toBe("https://media.example.test/preview-3");
    // Model the source reload rather than letting jsdom retain media state.
    video.currentTime = 0;
    video.playbackRate = 1;
    Object.defineProperty(video, "error", { configurable: true, value: null });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(paused ? 42 : 420);
    expect(video.playbackRate).toBe(1.5);
    expect(video.paused).toBe(state !== "error");
    if (state === "error") expect(play).toHaveBeenCalledOnce();
    else expect(play).not.toHaveBeenCalled();
    expect(screen.queryByText("Playback stopped. Refresh the preview to renew access, or download the original file.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh preview" })).not.toBeInTheDocument();
  });

  it("ignores a late preview response after stepping to another asset", async () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    const first = { ...asset, preview: "download_only" as const, viewingCopy: { state: "ready" as const, sizeBytes: 4 * 1024 ** 2 } };
    const second = { ...first, id: "video-2", name: "Evening update", originalName: "evening.mxf" };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [first, second], nextCursor: null, hasMore: false, total: 2 });
    let resolveFirst: ((access: SourceMediaRead) => void) | undefined;
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) => {
      if (action !== "preview") return mediaRead(action, assetId);
      if (assetId === first.id) return new Promise(resolve => { resolveFirst = resolve; });
      return mediaRead(action, assetId, "https://media.example.test/evening-preview");
    });

    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", "video-1", "preview"));
    const dialog = screen.getByRole("dialog", { name: "News update" });
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    const currentVideo = await screen.findByLabelText("Preview Evening update");
    expect(screen.getByRole("dialog", { name: "Evening update" })).toBe(dialog);
    expect(currentVideo).toHaveAttribute("src", "https://media.example.test/evening-preview");

    await act(async () => { resolveFirst?.(mediaRead("preview", first.id, "https://media.example.test/late-preview")); });
    expect(screen.getByLabelText("Preview Evening update")).toHaveAttribute("src", "https://media.example.test/evening-preview");
    expect(screen.queryByLabelText("Preview News update")).not.toBeInTheDocument();
  });

  it("keeps current cards and posters visible during a processing poll and stops after cleanup", async () => {
    vi.useFakeTimers();
    const processing = { ...asset, viewingCopy: { state: "processing" as const } };
    const ready = { ...asset, id: "video-2", name: "Evening update", viewingCopy: { state: "ready" as const } };
    let resolvePoll: ((page: SourceMediaPage) => void) | undefined;
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [processing, ready], nextCursor: null, hasMore: false, total: 2 })
      .mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }));

    renderLibrary();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: card("News update") })).toBeInTheDocument();
    expect(document.querySelector('img[src="https://media.example.test/poster"]')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listSourceMedia).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: card("News update") })).toBeInTheDocument();
    expect(document.querySelector('img[src="https://media.example.test/poster"]')).toBeInTheDocument();
    cleanup();
    resolvePoll?.({ success: true, records: [processing, ready], nextCursor: null, hasMore: false, total: 2 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listSourceMedia).toHaveBeenCalledTimes(2);
  });

  it("keeps polling at a lower frequency while a preview remains in progress", async () => {
    vi.useFakeTimers();
    const processing = { ...asset, viewingCopy: { state: "processing" as const } };
    vi.mocked(listSourceMedia).mockResolvedValue({
      success: true,
      records: [processing],
      nextCursor: null,
      hasMore: false,
      total: 1,
    });

    renderLibrary();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    for (let poll = 0; poll < 60; poll += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    }
    expect(listSourceMedia).toHaveBeenCalledTimes(61);
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(listSourceMedia).toHaveBeenCalledTimes(61);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(listSourceMedia).toHaveBeenCalledTimes(62);
  });

  it("keeps saved metadata when an older processing poll finishes later", async () => {
    vi.useFakeTimers();
    const processing = { ...asset, viewingCopy: { state: "processing" as const } };
    const staleReady = { ...asset, viewingCopy: { state: "ready" as const, sizeBytes: 4 * 1024 ** 2 } };
    let resolvePoll: ((page: SourceMediaPage) => void) | undefined;
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [processing], nextCursor: null, hasMore: false, total: 1 })
      .mockImplementationOnce(() => new Promise(resolve => { resolvePoll = resolve; }));
    const saved = { ...processing, name: "Final newsroom title", version: 2 };
    let resolveSave: ((result: { success: true; asset: SourceMediaAssetSummary }) => void) | undefined;
    vi.mocked(updateSourceMediaMetadata).mockImplementationOnce(() =>
      new Promise(resolve => { resolveSave = resolve; }));

    renderLibrary({ ...source, canEditMetadata: true });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: card("News update") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: saved.name },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(1);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{ ...saved, viewingCopy: staleReady.viewingCopy }], nextCursor: null, hasMore: false, total: 1 });
    await act(async () => {
      resolveSave?.({ success: true, asset: saved });
      resolvePoll?.({ success: true, records: [staleReady], nextCursor: null, hasMore: false, total: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);

    const open = await screen.findByRole("button", { name: card("Final newsroom title") });
    expect(open).toHaveAccessibleDescription(/Preview ready/);
    expect(screen.queryByRole("button", { name: card("News update") })).not.toBeInTheDocument();
  });

  it("clears a stale poster while a new viewing copy processes and reloads it when ready", async () => {
    vi.useFakeTimers();
    const ready = { ...asset, viewingCopy: { state: "ready" as const, sizeBytes: 4 * 1024 ** 2 } };
    const processing = { ...asset, viewingCopy: { state: "processing" as const } };
    const otherProcessing = {
      ...asset,
      id: "video-2",
      name: "Evening update",
      viewingCopy: { state: "processing" as const },
    };
    const otherReady = { ...otherProcessing, viewingCopy: { state: "ready" as const } };
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [ready, otherProcessing], nextCursor: null, hasMore: false, total: 2 })
      .mockResolvedValueOnce({ success: true, records: [otherReady], nextCursor: null, hasMore: false, total: null })
      .mockResolvedValueOnce({ success: true, records: [processing, otherReady], nextCursor: null, hasMore: false, total: 2 })
      .mockResolvedValueOnce({ success: true, records: [ready], nextCursor: null, hasMore: false, total: null })
      .mockResolvedValue({ success: true, records: [ready, otherReady], nextCursor: null, hasMore: false, total: 2 });
    let posterRead = 0;
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) => {
      if (action === "poster") posterRead += 1;
      return mediaRead(action, assetId, `https://media.example.test/${action}-${posterRead}`);
    });

    renderLibrary();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('img[src="https://media.example.test/poster-1"]')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.querySelector('[data-media-item="video-1"] img')).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(document.querySelector('[data-media-item="video-1"] img[src="https://media.example.test/poster-3"]')).toBeInTheDocument();
  });

  it("defers an external binary refresh until unsaved work is released", async () => {
    const first = { ...asset, fileVersion: "dirty-v1" }, fresh = { ...asset, fileVersion: "dirty-v2", version: asset.version + 1 };
    const updated = vi.fn();
    function Probe({ blocked }: { blocked: boolean }) {
      useSourceMediaAssetRefresh({ asset: first, getIdToken, onUpdated: updated, blocked }); return null;
    }
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [fresh], nextCursor: null, hasMore: false, total: 1 });
    const view = render(<Probe blocked />);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledWith("staff-token", { sourceId: first.sourceId, assetId: first.id }));
    expect(updated).not.toHaveBeenCalled();
    view.rerender(<Probe blocked={false} />);
    await waitFor(() => expect(updated).toHaveBeenCalledOnce());
    expect(updated).toHaveBeenCalledWith(fresh);
  });

  it("ignores an older revalidation response after the parent has a newer binary", async () => {
    const first = { ...asset, fileVersion: "ordered-v1" }, fresh = { ...asset, fileVersion: "ordered-v2", version: asset.version + 1 };
    const result = deferred<SourceMediaPage>(), updated = vi.fn();
    function Probe({ shown }: { shown: SourceMediaAssetSummary }) {
      useSourceMediaAssetRefresh({ asset: shown, getIdToken, onUpdated: updated }); return null;
    }
    vi.mocked(listSourceMedia).mockReturnValue(result.promise);
    const view = render(<Probe shown={first} />);
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalled());
    view.rerender(<Probe shown={fresh} />);
    await act(async () => { result.resolve({ success: true, records: [first], nextCursor: null, hasMore: false, total: 1 }); });
    expect(updated).not.toHaveBeenCalled();
  });

  it("does not revalidate hidden viewers, then refreshes when the document becomes visible", async () => {
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const updated = vi.fn(), fresh = { ...asset, version: asset.version + 1, fileVersion: "visible-v2" };
    function Probe() { useSourceMediaAssetRefresh({ asset, getIdToken, onUpdated: updated }); return null; }
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [fresh], nextCursor: null, hasMore: false, total: 1 });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    vi.useFakeTimers(); const view = render(<Probe />);
    try {
      await act(async () => { fireEvent(window, new Event("focus")); await vi.advanceTimersByTimeAsync(30_000); });
      expect(listSourceMedia).not.toHaveBeenCalled();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await act(async () => { fireEvent(document, new Event("visibilitychange")); });
      expect(updated).toHaveBeenCalledWith(fresh);
    } finally {
      view.unmount(); vi.useRealTimers();
      if (original) Object.defineProperty(document, "visibilityState", original); else Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it.each(["viewer", "quicklook"])("refreshes the whole %s descriptor when a new page contains a replacement", async surface => {
    const first = { ...asset, preview: "browser" as const, fileVersion: "external-v1", viewingCopy: { state: "ready" as const, durationSeconds: 60 } };
    const replaced = { ...first, name: "Corrected update", originalName: "corrected.mxf", mimeType: "application/mxf", fileVersion: "external-v2", version: first.version + 1 };
    let current: SourceMediaAssetSummary = first;
    vi.mocked(listSourceMedia).mockImplementation(async () => ({ success: true, records: [current], nextCursor: null, hasMore: false, total: 1 }));
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, id, action) => ({
      ...mediaRead(action, id, `https://media.example.test/${current.fileVersion}-${action}`), fileVersion: current.fileVersion }));
    const router = renderLibrary();
    const tile = await screen.findByRole("button", { name: card("News update") });
    if (surface === "viewer") fireEvent.click(tile); else fireEvent.keyDown(tile, { key: "y", ctrlKey: true });
    await screen.findByRole("dialog", { name: surface === "viewer" ? "News update" : "Quick Look: News update" });
    current = replaced;
    await act(async () => { await router.navigate(`/media?${surface === "viewer" ? `asset=${asset.id}&` : ""}sort=name_asc`); });
    expect(await screen.findByRole("dialog", { name: surface === "viewer" ? "Corrected update" : "Quick Look: Corrected update" })).toBeVisible();
    if (surface === "viewer") await waitFor(() => expect((screen.getByLabelText("Preview Corrected update") as HTMLVideoElement).src).toContain("external-v2-preview"));
  });

  it.each(["viewer", "quicklook"])("revalidates an already-ready %s after another session replaces its file", async surface => {
    const first = { ...asset, preview: "browser" as const, fileVersion: "focus-v1", viewingCopy: { state: "ready" as const, durationSeconds: 60 } };
    const replaced = { ...first, name: "Externally replaced", fileVersion: "focus-v2", version: first.version + 1 };
    let current: SourceMediaAssetSummary = first;
    vi.mocked(listSourceMedia).mockImplementation(async (_token, query) => ({ success: true,
      records: ["assetId" in query ? current : first], nextCursor: null, hasMore: false, total: 1 }));
    renderLibrary();
    const tile = await screen.findByRole("button", { name: card("News update") });
    if (surface === "viewer") fireEvent.click(tile); else fireEvent.keyDown(tile, { key: "y", ctrlKey: true });
    await screen.findByRole("dialog", { name: surface === "viewer" ? "News update" : "Quick Look: News update" });
    current = replaced;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByRole("dialog", { name: surface === "viewer" ? "Externally replaced" : "Quick Look: Externally replaced" })).toBeVisible();
    expect(listSourceMedia).toHaveBeenCalledWith("staff-token", { sourceId: first.sourceId, assetId: first.id });
  });

  it("withholds a newly signed binary until the viewer's old descriptor is refreshed", async () => {
    const first = { ...asset, preview: "browser" as const, fileVersion: "bound-v1", viewingCopy: { state: "ready" as const } };
    const replaced = { ...first, name: "New binary", fileVersion: "bound-v2", version: first.version + 1 };
    const pending = deferred<{ success: true; records: SourceMediaAssetSummary[]; nextCursor: null; hasMore: false; total: number }>();
    vi.mocked(listSourceMedia).mockImplementation(async (_token, query) => "assetId" in query ? pending.promise
      : { success: true, records: [first], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, id, action) => ({
      ...mediaRead(action, id, "https://media.example.test/new-binary"), fileVersion: replaced.fileVersion }));
    renderLibrary(); fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    try {
      await waitFor(() => expect(vi.mocked(createSourceMediaRead).mock.calls.some(call => call[3] === "preview")).toBe(true));
      await act(async () => {});
      expect((screen.queryByLabelText("Preview News update") as HTMLVideoElement | null)?.src).not.toBe("https://media.example.test/new-binary");
      pending.resolve({ success: true, records: [replaced], nextCursor: null, hasMore: false, total: 1 });
      await waitFor(() => expect((screen.getByLabelText("Preview New binary") as HTMLVideoElement).src).toBe("https://media.example.test/new-binary"));
    } finally { pending.resolve({ success: true, records: [replaced], nextCursor: null, hasMore: false, total: 1 }); }
  });

  it.each(["preview", "download"] as const)("explains a changed-file %s refusal while preserving unsaved details", async action => {
    const first = { ...asset, fileVersion: "unsaved-v1", viewingCopy: { state: "ready" as const } };
    const fresh = { ...first, name: "New binary", fileVersion: "unsaved-v2", version: 2 };
    const pending = deferred<SourceMediaRead>();
    let requestPending = true, firstList = true;
    let listed = first;
    vi.mocked(listSourceMedia).mockImplementation(async () => {
      listed = firstList ? first : fresh;
      firstList = false;
      return { success: true, records: [listed], nextCursor: null, hasMore: false, total: 1 };
    });
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, id, readAction) => {
      if (readAction === action && requestPending) { requestPending = false; return pending.promise; }
      return { ...mediaRead(readAction, id), fileVersion: readAction === "poster" ? listed.fileVersion : undefined };
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "My unsaved title" } });
    if (action === "download") {
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /^Original video/ }));
    }
    await act(async () => { pending.resolve({ ...mediaRead(action), fileVersion: fresh.fileVersion }); });
    expect(await screen.findByText(/This video's file changed.*Save or discard any unsaved edits/)).toBeVisible();
    expect(title).toHaveValue("My unsaved title");
    expect(click).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: first.name } });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(fresh.name));
    expect(screen.queryByText(/This video's file changed/)).not.toBeInTheDocument();
  });

  it("drops the old linked seek when replacement arrives before the first preview", async () => {
    const first = { ...asset, preview: "browser" as const, fileVersion: "file-v1", viewingCopy: { state: "ready" as const, durationSeconds: 90 } };
    const current = { ...first, fileVersion: "file-v2", version: 2 };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [first], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(updateSourceMediaMetadata).mockRejectedValueOnce(new HttpError(409, "Video changed", { current }));
    const pending = deferred<SourceMediaRead>(); let reads = 0;
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) =>
      action === "preview" && ++reads === 1 ? pending.promise : mediaRead(action, assetId, "https://media.example.test/new-preview"));
    renderLibrary({ ...source, canEditMetadata: true }, "/media?asset=video-1&t=72");
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: "My title" } });
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload details" }));
    const player = await screen.findByLabelText("Preview News update") as HTMLVideoElement;
    Object.defineProperty(player, "duration", { configurable: true, value: 90 });
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBe(0);
    await act(async () => { pending.resolve(mediaRead("preview", asset.id, "https://media.example.test/old-preview")); });
    expect(player.src).toBe("https://media.example.test/new-preview");
  });

  it.each([
    { label: "Original video", preview: "browser" as const },
    { label: "Web copy", preview: "browser" as const },
    { label: "Original video", preview: "download_only" as const },
  ])("ignores a delayed $label download after a $preview binary refresh", async ({ label, preview }) => {
    const first = { ...asset, preview, fileVersion: "file-v1",
      viewingCopy: preview === "browser" ? { state: "ready" as const, sizeBytes: 1024 } : undefined };
    const current = { ...first, fileVersion: "file-v2", version: 2 };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [first], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(updateSourceMediaMetadata).mockRejectedValueOnce(new HttpError(409, "Video changed", { current }));
    const pending = deferred<SourceMediaRead>();
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) =>
      action === "download" || action === "download_web" ? pending.promise : mediaRead(action, assetId));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "My title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    const reload = await screen.findByRole("button", { name: "Reload details" });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^${label}`) }));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", source.id, asset.id, label === "Original video" ? "download" : "download_web"));
    fireEvent.click(reload);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Close" })[0]).toBeEnabled());
    await act(async () => { pending.resolve(mediaRead(label === "Original video" ? "download" : "download_web", asset.id)); });
    expect(click).not.toHaveBeenCalled(); click.mockRestore();
  });

  it("refreshes preview access when the same video gets a replacement file", async () => {
    const first = { ...asset, preview: "browser" as const, fileVersion: "file-v1", viewingCopy: { state: "ready" as const, durationSeconds: 60 } };
    const current = { ...first, fileVersion: "file-v2", version: 2, viewingCopy: { ...first.viewingCopy, durationSeconds: 20 } };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [first], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(updateSourceMediaMetadata).mockRejectedValueOnce(new HttpError(409, "Video changed", { current }));
    let reads = 0;
    vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) =>
      mediaRead(action, assetId, `https://media.example.test/${action}-${action === "preview" ? ++reads : 0}`));
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const video = await screen.findByLabelText("Preview News update") as HTMLVideoElement;
    await waitFor(() => expect(video.src).toBe("https://media.example.test/preview-1"));
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    video.currentTime = 42;
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "My title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload details" }));
    await waitFor(() => expect(screen.getByLabelText("Preview News update")).toHaveAttribute("src", "https://media.example.test/preview-2"));
    expect(reads).toBe(2);
  });

  it("protects dirty details, reloads an exact conflict, and saves rights review", async () => {
    const editableSource = { ...source, canEditMetadata: true };
    const current = { ...asset, name: "Current newsroom title", rightsStatus: "complete" as const, version: 2 };
    vi.mocked(updateSourceMediaMetadata).mockRejectedValueOnce(new HttpError(409, "Media asset changed; reload it and try again", { current }));
    const router = renderLibrary(editableSource);
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: "My newsroom title" } });

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await act(async () => { void router.navigate("/away"); });
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("My newsroom title");

    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("This video changed. Reload its current details before saving.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload details" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Current newsroom title");
    expect(screen.getByRole("combobox", { name: "Rights review" })).toHaveValue("complete");
    expect(listSourceMedia).toHaveBeenCalledTimes(1);

    const saved = { ...current, name: "Final newsroom title", version: 3 };
    vi.mocked(updateSourceMediaMetadata).mockResolvedValueOnce({ success: true, asset: saved });
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: saved.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByText("Video details saved.");
    expect(updateSourceMediaMetadata).toHaveBeenLastCalledWith("staff-token", "video-library", "video-1", 2,
      expect.objectContaining({ name: saved.name, rightsStatus: "complete" }),
      { preserveVideoSearchCache: true });
  });

  it("undoes one confirmed video details save with its post-save version", async () => {
    const saved = { ...asset, name: "Saved newsroom title", rightsStatus: "complete" as const, version: 2 };
    const restored = { ...asset, version: 3 };
    vi.mocked(updateSourceMediaMetadata)
      .mockResolvedValueOnce({ success: true, asset: saved })
      .mockResolvedValueOnce({ success: true, asset: restored });
    renderLibraryWithNotices({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: saved.name } });
    fireEvent.change(screen.getByRole("combobox", { name: "Rights review" }), { target: { value: "complete" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    const notice = screen.getByRole("region", { name: "Notifications" });
    const undo = await within(notice).findByRole("button", { name: "Undo" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save details" })).toBeDisabled());
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });

    fireEvent.click(undo);
    fireEvent.click(undo);
    await waitFor(() => expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(2));
    expect(updateSourceMediaMetadata).toHaveBeenNthCalledWith(2,
      "staff-token", "video-library", "video-1", 2, {
        name: "News update",
        description: "",
        credit: "",
        license: "",
        tags: [],
        rightsStatus: "pending",
      }, { preserveVideoSearchCache: true });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("News update"));
    expect(screen.getByRole("combobox", { name: "Rights review" })).toHaveValue("pending");
    expect(within(notice).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(listSourceMedia).toHaveBeenCalledOnce();
  });

  it("consumes a conflicting video details Undo and reloads through the existing close path", async () => {
    const saved = { ...asset, name: "Saved newsroom title", version: 2 };
    vi.mocked(updateSourceMediaMetadata)
      .mockResolvedValueOnce({ success: true, asset: saved })
      .mockRejectedValueOnce(new HttpError(409, "Conflict"));
    renderLibraryWithNotices({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: saved.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    const notice = screen.getByRole("region", { name: "Notifications" });
    const undo = await within(notice).findByRole("button", { name: "Undo" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save details" })).toBeDisabled());
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });
    fireEvent.click(undo);

    await waitFor(() => expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(2));
    expect(notice).toHaveTextContent("Close and reload its details before editing.");
    expect(within(notice).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(saved.name);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(2));
    expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(2);
  });

  it("does not offer video save Undo when the response has no post-save version", async () => {
    const saved = { ...asset, name: "Saved newsroom title", version: undefined } as unknown as SourceMediaAssetSummary;
    vi.mocked(updateSourceMediaMetadata).mockResolvedValueOnce({ success: true, asset: saved });
    renderLibraryWithNotices({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: saved.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await screen.findByText("Video details saved.");
    const notice = screen.getByRole("region", { name: "Notifications" });
    expect(within(notice).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(notice).toHaveTextContent("Saved newsroom title details saved.");
    expect(updateSourceMediaMetadata).toHaveBeenCalledOnce();
  });

  it("replaces an earlier video save Undo when the next save confirms no version change", async () => {
    const saved = { ...asset, name: "Saved newsroom title", version: 2 };
    const noChange = { ...saved, name: "Second newsroom title" };
    vi.mocked(updateSourceMediaMetadata)
      .mockResolvedValueOnce({ success: true, asset: saved })
      .mockResolvedValueOnce({ success: true, asset: noChange });
    renderLibraryWithNotices({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: saved.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    const notice = screen.getByRole("region", { name: "Notifications" });
    expect(await within(notice).findByRole("button", { name: "Undo" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(saved.name));

    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: noChange.name } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(notice).toHaveTextContent("Second newsroom title details saved."));
    expect(within(notice).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(2);
  });

  it("leaves viewer arrows with the nested route guard", async () => {
    const records = videoRecords(2);
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 2 });
    const router = renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("Video 1") }));
    await screen.findByLabelText("Preview Video 1");
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Unsaved title" } });

    await act(async () => { void router.navigate("/away"); });
    const guard = await screen.findByRole("dialog", { name: "Leave with unsaved changes?" });
    const keepEditing = within(guard).getByRole("button", { name: "Keep editing" });
    fireEvent.keyDown(keepEditing, { key: "ArrowRight" });
    expect(screen.getByLabelText("Preview Video 1")).toBeInTheDocument();
    expect(screen.queryByText("Open the next video without saving your changes?")).not.toBeInTheDocument();
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
    fireEvent.click(keepEditing);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Unsaved title");
  });

  it("guards an unfinished video tag and does not send a save request", async () => {
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const tags = await screen.findByRole("combobox", { name: "Tags" });

    fireEvent.change(tags, { target: { value: "unfinished" } });
    expect(screen.getByRole("button", { name: "Save details" })).toBeEnabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(await screen.findByText("Unsaved video changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Press Enter or comma to add the tag before saving.")).toBeInTheDocument();
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
    expect(tags).toHaveValue("unfinished");
  });

  it("opens Details and focuses an invalid title before saving", async () => {
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "" } });
    fireEvent.click(within(videoInspector()).getByRole("button", { name: "Details" }));
    expect(within(videoInspector()).getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.invalid(title);
    await waitFor(() => expect(within(videoInspector()).getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(title).toHaveFocus());
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
  });

  it("saves exact video tag tokens and records only committed tags still present", async () => {
    const tagged = { ...asset, tags: ["studio"] };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [tagged], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(updateSourceMediaMetadata).mockResolvedValue({
      success: true,
      asset: { ...tagged, tags: ["studio", "Producer"], version: 2 },
    });
    localStorage.setItem("njpbs-admin:media-recent-tags:video:staff", JSON.stringify(["archive"]));
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const tags = await screen.findByRole("combobox", { name: "Tags" });

    fireEvent.change(tags, { target: { value: "throwaway," } });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag throwaway" }));
    fireEvent.change(tags, { target: { value: "Producer," } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));

    await waitFor(() => expect(updateSourceMediaMetadata).toHaveBeenCalledWith(
      "staff-token", "video-library", "video-1", 1,
      expect.objectContaining({ tags: ["studio", "Producer"] }),
      { preserveVideoSearchCache: true },
    ));
    await waitFor(() => expect(localStorage.getItem("njpbs-admin:media-recent-tags:video:staff"))
      .toBe(JSON.stringify(["Producer", "archive"])));
  });

  it("enforces the video tag length and count limits", async () => {
    const full = { ...asset, tags: Array.from({ length: 30 }, (_, index) => `tag-${index + 1}`) };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [full], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const tags = await screen.findByRole("combobox", { name: "Tags" });

    fireEvent.change(tags, { target: { value: `${"x".repeat(81)},` } });
    expect(within(videoInspector()).getByText("Keep each tag to 80 characters or fewer.")).toBeInTheDocument();
    fireEvent.change(tags, { target: { value: "one-more," } });
    expect(within(videoInspector()).getByText("Use 30 tags or fewer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove tag one-more" })).not.toBeInTheDocument();
  });

  it.each([1280, 390])("keeps inspector interactions request-free at %ipx", async (width) => {
    setViewport(width);
    const editable = { ...source, canEditMetadata: true, canDelete: true };
    const tagged = { ...asset, tags: ["studio"] };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [tagged], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(updateSourceMediaMetadata).mockResolvedValue({ success: true, asset: { ...tagged, name: "Saved title", version: 2 } });
    localStorage.setItem("njpbs-admin:media-recent-tags:video:staff", JSON.stringify(["student"]));
    renderLibrary(editable);
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(1));
    const inspector = videoInspector();
    const initial = {
      list: vi.mocked(listSourceMedia).mock.calls.length,
      read: vi.mocked(createSourceMediaRead).mock.calls.length,
      update: vi.mocked(updateSourceMediaMetadata).mock.calls.length,
      remove: vi.mocked(deleteSourceMedia).mock.calls.length,
    };

    expect(within(inspector).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Details", "RightsNeeds review", "Tags1", "File information", "Delete from library",
    ]);
    fireEvent.click(within(inspector).getByRole("tab", { name: "Comments" }));
    expect(within(inspector).getByRole("heading", { name: "Staff comments" })).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("tab", { name: "Your review" }));
    expect(within(inspector).getByRole("heading", { name: "Your review" })).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("tab", { name: "Details" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "File information" }));
    fireEvent.click(within(inspector).getByRole("button", { name: "Rights, Needs review" }));
    fireEvent.change(within(inspector).getByRole("combobox", { name: "Tags" }), { target: { value: "stu" } });
    expect(await screen.findByText("From this page and your recent tags.")).toBeInTheDocument();
    expect({
      list: vi.mocked(listSourceMedia).mock.calls.length,
      read: vi.mocked(createSourceMediaRead).mock.calls.length,
      update: vi.mocked(updateSourceMediaMetadata).mock.calls.length,
      remove: vi.mocked(deleteSourceMedia).mock.calls.length,
    }).toEqual(initial);

    fireEvent.change(within(inspector).getByRole("combobox", { name: "Tags" }), { target: { value: "" } });
    fireEvent.change(within(inspector).getByRole("textbox", { name: "Title" }), { target: { value: "Saved title" } });
    // #3552 moves the same native submit control into the shared media header.
    const save = screen.getByRole("button", { name: "Save details" });
    expect(save.closest(".component-editor-dialog-header")).not.toBeNull();
    expect(save.closest(".component-editor-dialog-footer")).toBeNull();
    const titleInput = within(inspector).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    expect(save).toHaveAttribute("form", titleInput.form!.id);
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(1));
    expect(listSourceMedia).toHaveBeenCalledTimes(initial.list);
    expect(vi.mocked(createSourceMediaRead)).toHaveBeenCalledTimes(initial.read);
    expect(deleteSourceMedia).not.toHaveBeenCalled();
    await screen.findByText("Video details saved.");
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Close" })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(initial.list + 1));
  });

  it("reloads meaning search and the first page after a saved video edit", async () => {
    const second = { ...asset, id: "video-2", name: "Second video", originalName: "second.mp4" };
    const cache = await import("../src/lib/video-search-session-cache");
    const invalidate = vi.spyOn(cache, "invalidateVideoSearchCorpus");
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [asset], nextCursor: "page-2", hasMore: true, total: 2 })
      .mockResolvedValueOnce({ success: true, records: [second], nextCursor: null, hasMore: false, total: 2 })
      .mockResolvedValue({ success: true, records: [asset, second], nextCursor: null, hasMore: false, total: 2 });
    vi.mocked(updateSourceMediaMetadata).mockResolvedValue({
      success: true,
      asset: { ...second, name: "Saved title", version: 2 },
    });
    renderLibrary({ ...source, canEditMetadata: true });
    await screen.findByRole("button", { name: card("News update") });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledWith(
      "staff-token",
      expect.objectContaining({ cursor: "page-2" }),
    ));
    fireEvent.click(await screen.findByRole("button", { name: card("Second video") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: "Saved title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith("video-library"));
    await screen.findByText("Video details saved.");
    const callsBeforeClose = vi.mocked(listSourceMedia).mock.calls.length;
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(callsBeforeClose + 1));
    const reload = vi.mocked(listSourceMedia).mock.calls.at(-1)?.[1] as { cursor?: string };
    expect(reload.cursor).toBeUndefined();
    await waitFor(() => expect(screen.getByRole("button", { name: card("Second video") })).toHaveFocus());
    invalidate.mockRestore();
  });

  it("keeps paging mounted and moves focus to the loaded page summary", async () => {
    const second = { ...asset, id: "video-2", name: "Second video", originalName: "second.mp4" };
    let finishPage!: (page: Awaited<ReturnType<typeof listSourceMedia>>) => void;
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [asset], nextCursor: "page-two", hasMore: true, total: 2 })
      .mockImplementationOnce(() => new Promise(resolve => { finishPage = resolve; }));
    renderLibrary();
    const next = await screen.findByRole("button", { name: "Next page" });
    const paging = screen.getByRole("navigation", { name: "Video pages" });
    act(() => next.focus());
    fireEvent.click(next);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled());
    expect(screen.getByRole("navigation", { name: "Video pages" })).toBe(paging);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    expect(paging).toContainElement(screen.getByRole("button", { name: "Next page" }));
    await act(async () => finishPage({ success: true, records: [second], nextCursor: null, hasMore: false, total: 2 }));
    await screen.findByRole("button", { name: card("Second video") });
    await waitFor(() => expect(screen.getByText("2 videos", { exact: true })).toHaveFocus());
  });

  it.each(["First page", "Previous page"])("keeps paging and summary focus when %s returns from the final page", async (action) => {
    const second = { ...asset, id: "video-2", name: "Second video", originalName: "second.mp4" };
    const firstPage: SourceMediaPage = { success: true, records: [asset], nextCursor: "page-two", hasMore: true, total: 2 };
    const returningPage = deferred<SourceMediaPage>();
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({ success: true, records: [second], nextCursor: null, hasMore: false, total: 2 })
      .mockReturnValueOnce(returningPage.promise);
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: card("Second video") });
    await waitFor(() => expect(screen.getByText("2 videos", { exact: true })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();

    const paging = screen.getByRole("navigation", { name: "Video pages" });
    const back = within(paging).getByRole("button", { name: action });
    act(() => back.focus());
    fireEvent.click(back);
    expect(screen.getByRole("navigation", { name: "Video pages" })).toBe(paging);
    expect(within(paging).getByRole("button", { name: action })).toBeDisabled();
    expect(screen.queryByText("2 videos", { exact: true })).not.toBeInTheDocument();

    await act(async () => returningPage.resolve(firstPage));
    await screen.findByRole("button", { name: card("News update") });
    expect(screen.getByRole("navigation", { name: "Video pages" })).toBe(paging);
    expect(screen.getByRole("button", { name: "First page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
    await waitFor(() => expect(screen.getByText("2 videos", { exact: true })).toHaveFocus());
  });

  it("keeps paging hidden while filtering a single-page result", async () => {
    const singlePage: SourceMediaPage = { success: true, records: [asset], nextCursor: null, hasMore: false, total: 1 };
    const filteredPage = deferred<SourceMediaPage>();
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce(singlePage)
      .mockReturnValueOnce(filteredPage.promise);
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    expect(screen.queryByRole("navigation", { name: "Video pages" })).not.toBeInTheDocument();

    applyVideoTag("news");
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", expect.objectContaining({ tag: "news" })));
    expect(screen.queryByRole("navigation", { name: "Video pages" })).not.toBeInTheDocument();
    await act(async () => filteredPage.resolve(singlePage));
    await screen.findByRole("button", { name: card("News update") });
    expect(screen.queryByRole("navigation", { name: "Video pages" })).not.toBeInTheDocument();
  });

  it.each([
    ["Batch title default", "Assignment"],
    ["Batch description default", "Coverage"],
    ["Request metadata update for the batch", true],
  ] as const)("guards unload and navigation when only %s is set", async (label, value) => {
    const router = createMemoryRouter([
      { path: "/media/videos", element: <SourceMediaLibrary userId="staff" source={{ ...source, canUpload: true }} getIdToken={getIdToken} /> },
      { path: "/media/images", element: <h1>Images</h1> },
    ], { initialEntries: ["/media/videos"] });
    render(<RouterProvider router={router} />);
    await waitForVideoIntake();
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    const field = screen.getByLabelText(label);
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);

    if (typeof value === "string") fireEvent.change(field, { target: { value } });
    else fireEvent.click(field);
    expect(startVideoUpload).not.toHaveBeenCalled();
    const dirtyUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    await act(async () => { void router.navigate("/media/images"); });
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/media/videos");

    if (typeof value === "string") {
      expect(field).toHaveValue(value);
      fireEvent.change(field, { target: { value: "" } });
    } else {
      expect(field).toBeChecked();
      fireEvent.click(field);
    }
    const clearedUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clearedUnload);
    expect(clearedUnload.defaultPrevented).toBe(false);
    await act(async () => { await router.navigate("/media/images"); });
    expect(await screen.findByRole("heading", { name: "Images" })).toBeInTheDocument();
  });

  it("guards route navigation while a video transfer is active", async () => {
    const router = renderLibrary({ ...source, canUpload: true });
    await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["data"], "news.mp4", { type: "video/mp4", lastModified: 42 })], types: ["Files"] },
    });
    startPreparedVideo("news.mp4");
    expect(await trayPause("news.mp4")).toBeEnabled();

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await act(async () => { void router.navigate("/away"); });
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument());
    expect(await trayPause("news.mp4")).toBeEnabled();

    await act(async () => { void router.navigate("/away"); });
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByRole("heading", { name: "Away" })).toBeInTheDocument();
  });

  it("opens one video upload sheet from the toolbar, shortcut, and shared drop target", async () => {
    renderLibrary({ ...source, canUpload: true });
    const cardControl = await screen.findByRole("button", { name: card("News update") });
    const sheet = document.querySelector<HTMLElement>(".media-upload-sheet");
    if (!sheet) throw new Error("The video upload sheet is missing.");
    expect(sheet).toHaveAttribute("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    expect(sheet).not.toHaveAttribute("hidden");
    expect(within(sheet).getByRole("heading", { name: "Upload to Video library" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close upload" }));
    expect(sheet).toHaveAttribute("hidden");

    fireEvent.keyDown(videoSearch(), { key: "u", metaKey: true });
    expect(sheet).toHaveAttribute("hidden");
    fireEvent.keyDown(cardControl, { key: "u", metaKey: true });
    expect(sheet).not.toHaveAttribute("hidden");
    fireEvent.click(within(sheet).getByRole("button", { name: "Close upload" }));

    await waitForVideoIntake();
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["video"], "studio.mp4", { type: "video/mp4", lastModified: 42 })], types: ["Files"] },
    });
    expect(sheet).not.toHaveAttribute("hidden");
    expect(within(sheet).getByText("studio.mp4")).toBeInTheDocument();
    expect(startVideoUpload).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Upload progress" }))
      .getByRole("button", { name: "Review details for studio.mp4" })).toBeEnabled();
  });

  it("routes a video dropped on the library toolbar instead of letting the browser open it", async () => {
    renderLibrary({ ...source, canUpload: true });
    await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    const toolbar = screen.getByRole("toolbar", { name: "Library controls" });
    const file = new File(["video"], "toolbar.mp4", { type: "video/mp4", lastModified: 42 });
    const dragOverTransfer = { types: ["Files"], dropEffect: "none" };
    const dragOver = createEvent.dragOver(toolbar, {
      dataTransfer: dragOverTransfer,
    });
    const drop = createEvent.drop(toolbar, {
      dataTransfer: { files: [file], types: ["Files"], dropEffect: "none" },
    });

    fireEvent(toolbar, dragOver);
    fireEvent(toolbar, drop);

    expect(dragOver.defaultPrevented).toBe(true);
    expect(dragOverTransfer.dropEffect).toBe("copy");
    expect(drop.defaultPrevented).toBe(true);
    const sheet = screen.getByRole("complementary", { name: "Upload media" });
    expect(sheet).toBeVisible();
    expect(within(sheet).getByText("toolbar.mp4")).toBeInTheDocument();
    expect(startVideoUpload).not.toHaveBeenCalled();
  });

  it("reviews video details before upload and returns control to the library while it runs", async () => {
    renderLibrary({ ...source, canUpload: true });
    const cardControl = await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    const sheet = screen.getByRole("complementary", { name: "Upload media" });
    const panel = within(sheet).getByRole("region", { name: "Video transfers" });
    const dataTransfer = { files: [new File(["video"], "sheet.mp4", { type: "video/mp4" })], types: ["Files"], dropEffect: "none" };

    expect(fireEvent.dragOver(panel, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(fireEvent.drop(panel, { dataTransfer })).toBe(false);
    expect(startVideoUpload).not.toHaveBeenCalled();
    fireEvent.change(within(sheet).getByRole("textbox", { name: "Title" }), {
      target: { value: "Field interview" },
    });
    startPreparedVideo("sheet.mp4");

    await waitFor(() => expect(transferVideo).toHaveBeenCalledOnce());
    expect(startVideoUpload).toHaveBeenCalledWith(
      expect.any(Function),
      "video-library",
      expect.objectContaining({ name: "sheet.mp4" }),
      expect.objectContaining({ name: "Field interview", rightsStatus: "pending" }),
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(sheet).toHaveAttribute("hidden");
    expect(cardControl).toBeEnabled();
    fireEvent.click(cardControl);
    expect(await screen.findByRole("dialog", { name: "News update" })).toBeInTheDocument();
  });

  it("explains why upload is locked while video details or Quick Look is open", async () => {
    renderLibrary({ ...source, canUpload: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    const details = screen.getByRole("dialog", { name: "News update" });
    let upload = screen.getByRole("button", { name: "Upload media" });
    expect(upload).toHaveAttribute("aria-disabled", "true");
    expect(upload).toHaveAccessibleDescription("Close video details first.");
    fireEvent.keyDown(window, { key: "u", metaKey: true });
    expect(document.querySelector(".media-upload-sheet")).toHaveAttribute("hidden");
    const closePreview = within(details).getAllByRole("button", { name: "Close" })
      .find(button => button.getAttribute("aria-label") === "Close");
    if (!closePreview) throw new Error("The video preview has no Close control.");
    fireEvent.click(closePreview);

    const cardControl = await screen.findByRole("button", { name: card("News update") });
    fireEvent.keyDown(cardControl, { key: "y", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Quick Look: News update" });
    upload = screen.getByRole("button", { name: "Upload media" });
    expect(upload).toHaveAttribute("aria-disabled", "true");
    expect(upload).toHaveAccessibleDescription("Close Quick Look first.");
  });

  it("keeps blocked Ctrl+U in the media page and focuses the reason", async () => {
    const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary
      principal={usersViewer} userId="staff" source={{ ...source, canUpload: true }} getIdToken={getIdToken} routedLibraryActive /> }],
    { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    const upload = await screen.findByRole("button", { name: "Upload media" });
    expect(upload).toHaveAccessibleDescription("Finish the current Images upload first.");
    const blockedShortcut = new KeyboardEvent("keydown", { key: "u", ctrlKey: true, bubbles: true, cancelable: true });

    window.dispatchEvent(blockedShortcut);

    expect(blockedShortcut.defaultPrevented).toBe(true);
    await waitFor(() => expect(upload).toHaveFocus());
    expect(document.querySelector(".media-upload-sheet")).toHaveAttribute("hidden");
  });

  it("routes an image-only drop without opening the video sheet", async () => {
    renderLibrary({ ...source, canUpload: true });
    await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    const sheet = document.querySelector<HTMLElement>(".media-upload-sheet");
    if (!sheet) throw new Error("The video upload sheet is missing.");

    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["image"], "still.png", { type: "image/png" })], types: ["Files"] },
    });

    expect(sheet).toHaveAttribute("hidden");
    expect(uploadRouterSnapshot().librarySession).toBe(true);
    expect(uploadRouterSnapshot().library.map(file => file.name)).toEqual(["still.png"]);
    expect(transferVideo).not.toHaveBeenCalled();
  });

  it("removes the shared drop overlay and stops intake when upload permission is lost", async () => {
    function PermissionHarness() {
      const [canUpload, setCanUpload] = useState(true);
      return <>
        <button type="button" onClick={() => setCanUpload(false)}>Revoke upload</button>
        <SourceMediaLibrary principal={usersViewer} userId="staff" source={{ ...source, canUpload }} getIdToken={getIdToken} />
      </>;
    }
    const router = createMemoryRouter([{ path: "/media", element: <PermissionHarness /> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    fireEvent.dragEnter(videoDropTarget(), { dataTransfer: { files: [], types: ["Files"] } });
    expect(screen.getByText("Drop to upload to Video library")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke upload" }));

    await waitFor(() => expect(screen.queryByText("Drop to upload to Video library")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Upload media" })).not.toBeInTheDocument();
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["video"], "blocked.mp4", { type: "video/mp4" })], types: ["Files"] },
    });
    const toolbar = screen.getByRole("toolbar", { name: "Library controls" });
    const blockedDragOverTransfer = { types: ["Files"], dropEffect: "copy" };
    const blockedDragOver = createEvent.dragOver(toolbar, {
      dataTransfer: blockedDragOverTransfer,
    });
    const blockedDrop = createEvent.drop(toolbar, {
      dataTransfer: { files: [new File(["video"], "blocked-toolbar.mp4", { type: "video/mp4" })], types: ["Files"] },
    });
    fireEvent(toolbar, blockedDragOver);
    fireEvent(toolbar, blockedDrop);
    expect(blockedDragOver.defaultPrevented).toBe(true);
    expect(blockedDragOverTransfer.dropEffect).toBe("none");
    expect(blockedDrop.defaultPrevented).toBe(true);
    expect(uploadRouterSnapshot().video).toEqual([]);
    expect(transferVideo).not.toHaveBeenCalled();
  });

  it("opens a full saved video queue even though it cannot accept another file", async () => {
    localStorage.setItem("boardwalk-video-transfers:staff:video-library", JSON.stringify(
      Array.from({ length: 20 }, (_, index) => ({ id: `saved-${index}`, name: `saved-${index}.mp4`, size: 4, lastModified: 42 })),
    ));
    renderLibrary({ ...source, canUpload: true });
    await screen.findByRole("button", { name: card("News update") });
    const upload = screen.getByRole("button", { name: "Upload media" });
    expect(upload).not.toHaveAttribute("aria-disabled");

    fireEvent.click(upload);

    const sheet = screen.getByRole("complementary", { name: "Upload media" });
    expect(within(sheet).getByText("saved-0.mp4")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Upload media" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Upload progress" })).toHaveTextContent("20 video transfers");
  });

  it("keeps the transfer owner mounted when its sheet closes and projects its actions into the tray", async () => {
    renderLibrary({ ...source, canUpload: true });
    await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["video"], "active.mp4", { type: "video/mp4", lastModified: 42 })], types: ["Files"] },
    });
    const sheet = await screen.findByRole("complementary", { name: "Upload media" });
    const panel = sheet.querySelector(".video-upload-panel");
    startPreparedVideo("active.mp4");
    await waitFor(() => expect(transferVideo).toHaveBeenCalledOnce());
    const firstSignal = vi.mocked(transferVideo).mock.calls[0][0].signal;

    expect(sheet).toHaveAttribute("hidden");
    expect(sheet.querySelector(".video-upload-panel")).toBe(panel);
    expect(firstSignal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    expect(sheet).not.toHaveAttribute("hidden");
    expect(screen.getByRole("grid", { name: "Videos" })).not.toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: card("News update") }));
    const details = await screen.findByRole("complementary", { name: "Video details" });
    expect(within(details).getByRole("heading", { name: "News update" })).toBeInTheDocument();
    expect(sheet).toHaveAttribute("hidden");
    expect(firstSignal.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const tray = screen.getByRole("region", { name: "Upload progress" });
    expect(fireEvent.drop(tray, { dataTransfer: { files: [new File(["video"], "tray-drop.mp4", { type: "video/mp4" })], types: ["Files"] } })).toBe(false);
    expect(within(tray).queryByText("tray-drop.mp4")).not.toBeInTheDocument();
    expect(transferVideo).toHaveBeenCalledTimes(1);
    fireEvent.click(within(tray).getByRole("button", { name: "Pause active.mp4" }));
    await waitFor(() => expect(within(tray).getByRole("button", { name: "Resume active.mp4" })).toBeEnabled());
    expect(firstSignal.aborted).toBe(true);

    fireEvent.click(within(tray).getByRole("button", { name: "Resume active.mp4" }));
    await waitFor(() => expect(transferVideo).toHaveBeenCalledTimes(2));
    fireEvent.click(within(tray).getByRole("button", { name: "Cancel active.mp4" }));
    await waitFor(() => expect(within(tray).queryByText("active.mp4")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload media" })).toHaveFocus());
  });

  it("announces the final completed transfer after its tray disappears", async () => {
    let completeTransfer: (asset: SourceMediaAssetSummary) => void = () => undefined;
    vi.mocked(transferVideo).mockImplementation(({ onPhase }) => {
      onPhase("uploading");
      return new Promise(resolve => { completeTransfer = resolve; });
    });
    const router = createMemoryRouter([{ path: "/media", element: <SuccessNoticeProvider routeKey="media"><SourceMediaLibrary
      principal={usersViewer} userId="staff" source={{ ...source, canUpload: true }} getIdToken={getIdToken} />
    </SuccessNoticeProvider> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["video"], "final.mp4", { type: "video/mp4" })], types: ["Files"] },
    });
    startPreparedVideo("final.mp4");
    await waitFor(() => expect(transferVideo).toHaveBeenCalledOnce());

    await act(async () => completeTransfer({ id: "final", sourceId: source.id, name: "final.mp4" } as SourceMediaAssetSummary));

    await waitFor(() => expect(screen.queryByRole("region", { name: "Upload progress" })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent("final.mp4 is ready in the video library.");
  });

  it.each([1280, 390])("adds no local mocked library request for video sheet open or intake at %ipx", async (width) => {
    setViewport(width);
    renderLibrary({ ...source, canUpload: true });
    await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    const requestCount = vi.mocked(listSourceMedia).mock.calls.length;
    expect(requestCount).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Upload media" }));
    fireEvent.click(screen.getByRole("button", { name: "Close upload" }));
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["video"], `request-${width}.mp4`, { type: "video/mp4" })], types: ["Files"] },
    });
    startPreparedVideo(`request-${width}.mp4`);

    await waitFor(() => expect(transferVideo).toHaveBeenCalledOnce());
    expect(listSourceMedia).toHaveBeenCalledTimes(requestCount);
    expect(createSourceMediaRead).not.toHaveBeenCalled();
  });

  it("keeps a routed image queue when leaving a video transfer for another media tab", async () => {
    const onDiscardExtra = vi.fn();
    const router = createMemoryRouter([
      { path: "/media/videos", element: <SourceMediaLibrary userId="staff" source={{ ...source, canUpload: true }} getIdToken={getIdToken}
        extraExitRisk hasExtraExitRisk={() => true} onDiscardExtra={onDiscardExtra} /> },
      { path: "/media/images", element: <h1>Images</h1> },
    ], { initialEntries: ["/media/videos"] });
    render(<RouterProvider router={router} />);
    await waitForVideoIntake();
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["data"], "news.mp4", { type: "video/mp4", lastModified: 42 })], types: ["Files"] },
    });
    startPreparedVideo("news.mp4");
    expect(await trayPause("news.mp4")).toBeEnabled();

    await act(async () => { await router.navigate("/media/images"); });
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByRole("heading", { name: "Images" })).toBeInTheDocument();
    expect(onDiscardExtra).not.toHaveBeenCalled();
  });

  it("opens the image recycle bin without stopping a routed video", async () => {
    const onDiscardVideo = vi.fn();
    const router = createMemoryRouter([
      { path: "/media/videos", element: <SourceMediaLibrary userId="staff" source={source} getIdToken={getIdToken}
        routedVideoActive onDiscardVideo={onDiscardVideo} /> },
      { path: "/media/images", element: <h1>Recycle bin</h1> },
    ], { initialEntries: ["/media/videos"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: card("News update") });

    await act(async () => { await router.navigate("/media/images?bin=1"); });

    expect(await screen.findByRole("heading", { name: "Recycle bin" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).not.toBeInTheDocument();
    expect(onDiscardVideo).not.toHaveBeenCalled();
  });

  it("continues a media tab change after its video transfer finishes", async () => {
    let finishTransfer!: (value: SourceMediaAssetSummary) => void;
    vi.mocked(transferVideo).mockReturnValue(new Promise(resolve => { finishTransfer = resolve; }));
    const onDiscardExtra = vi.fn();
    const router = createMemoryRouter([
      { path: "/media/videos", element: <SourceMediaLibrary userId="staff" source={{ ...source, canUpload: true }} getIdToken={getIdToken}
        extraExitRisk hasExtraExitRisk={() => true} onDiscardExtra={onDiscardExtra} /> },
      { path: "/media/images", element: <h1>Images</h1> },
    ], { initialEntries: ["/media/videos"] });
    render(<RouterProvider router={router} />);
    await waitForVideoIntake();
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["data"], "news.mp4", { type: "video/mp4", lastModified: 42 })], types: ["Files"] },
    });
    startPreparedVideo("news.mp4");
    expect(await trayPause("news.mp4")).toBeEnabled();

    await act(async () => { await router.navigate("/media/images"); });
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    await act(async () => { finishTransfer(asset); });
    expect(await screen.findByRole("heading", { name: "Images" })).toBeInTheDocument();
    expect(onDiscardExtra).not.toHaveBeenCalled();
  });
});


describe("video library organization", () => {
  it("sorts the full video library by file size in either direction", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });

    fireEvent.click(screen.getByRole("button", { name: "Sort: Recently updated, newest first" }));
    const sort = screen.getByRole("dialog", { name: "Sort" });
    fireEvent.click(within(sort).getByRole("radio", { name: "File size" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "", limit: 24, sort: "size_desc", posters: true,
    }));
    expect(screen.getByRole("button", { name: "Sort: File size, largest first" })).toBeInTheDocument();

    fireEvent.click(within(sort).getByRole("radio", { name: "Smallest first" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "", limit: 24, sort: "size_asc", posters: true,
    }));
    expect(screen.getByRole("button", { name: "Sort: File size, smallest first" })).toBeInTheDocument();
  });

  it("filters the full library by a card tag or uploader and resets the previous page", async () => {
    const tagged = { ...asset, tags: ["Interview"], uploadedBy: { uid: "alex", name: "Alex Rivera" } };
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [tagged], nextCursor: "page-two", hasMore: true, total: 50 });
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", expect.objectContaining({ cursor: "page-two" })));
    fireEvent.click(await screen.findByRole("button", { name: "Filter by tag Interview" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", { sourceId: "video-library", q: "", limit: 24, tag: "Interview" , posters: true }));
    // The uploader filter stays in the card's menu even when the optional uploader field is hidden.
    expect(screen.queryByRole("button", { name: "Show videos uploaded by Alex Rivera" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: card("News update") }), { key: "F10", shiftKey: true });
    fireEvent.click(within(screen.getByRole("menu", { name: "News update" })).getByRole("menuitem", { name: "Show videos uploaded by Alex Rivera" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", { sourceId: "video-library", q: "", limit: 24, createdBy: "alex" , posters: true }));
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  it("combines prefix search with one filter and clears both controls", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    chooseVideoFilter("Uploader", "Me");
    fireEvent.change(videoSearch(), { target: { value: "News" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", { sourceId: "video-library", q: "News", limit: 24, createdBy: "staff", sort: "name_asc", posters: true }));
    expect(screen.getByRole("button", { name: "Sort: Name A–Z while searching" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Uploader: Me" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", { sourceId: "video-library", q: "", limit: 24 , posters: true }));
    expect(screen.getByRole("button", { name: "Sort: Recently updated, newest first" })).not.toHaveAttribute("aria-disabled");
  });

  it("applies a typed prefix after 300ms and sends one bounded list request", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    const calls = vi.mocked(listSourceMedia).mock.calls.length;
    vi.useFakeTimers();

    fireEvent.change(videoSearch(), { target: { value: "News" } });
    expect(screen.queryByRole("region", { name: "Video text search" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(listSourceMedia).toHaveBeenCalledTimes(calls);
    expect(screen.queryByRole("region", { name: "Video text search" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(listSourceMedia).toHaveBeenCalledTimes(calls + 1);
    expect(screen.getByRole("region", { name: "Video text search" })).toBeInTheDocument();
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "News", limit: 24, sort: "name_asc", posters: true,
    });
  });

  it("applies a pending search draft with a filter without waiting for its timer", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    vi.useFakeTimers();
    fireEvent.change(videoSearch(), { target: { value: "News" } });

    chooseVideoFilter("Rights review", "Needs review");
    await act(async () => { await Promise.resolve(); });
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "News", limit: 24, rightsStatus: "pending", sort: "name_asc", posters: true,
    });
  });

  it("keeps a trailing search space after its own URL commit", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    vi.useFakeTimers();
    fireEvent.change(videoSearch(), { target: { value: "News " } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "News", limit: 24, sort: "name_asc", posters: true,
    });
    expect(videoSearch()).toHaveValue("News ");
    fireEvent.change(videoSearch(), { target: { value: "News report" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "News report", limit: 24, sort: "name_asc", posters: true,
    });
  });

  it("lets staff change video filters and search while a transfer is active", async () => {
    const router = renderLibrary({ ...source, canUpload: true });
    await screen.findByRole("button", { name: card("News update") });
    await waitForVideoIntake();
    fireEvent.drop(videoDropTarget(), {
      dataTransfer: { files: [new File(["data"], "news.mp4", { type: "video/mp4", lastModified: 42 })], types: ["Files"] },
    });
    startPreparedVideo("news.mp4");
    expect(await trayPause("news.mp4")).toBeEnabled();
    chooseVideoFilter("Rights review", "Needs review");
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "", limit: 24, rightsStatus: "pending", posters: true,
    }));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();

    expect(videoSearch()).toBeEnabled();
    fireEvent.change(videoSearch(), { target: { value: "News" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "News", limit: 24, rightsStatus: "pending", sort: "name_asc", posters: true,
    }));
    expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull();

    await act(async () => { void router.navigate(-1); });
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
    expect(router.state.location.search).toContain("q=News");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave with unsaved changes?" })).toBeNull());

    await act(async () => { void router.navigate(-1); });
    fireEvent.click(await screen.findByRole("button", { name: "Discard and leave" }));
    await waitFor(() => expect(router.state.location.search).not.toContain("q=News"));
    expect(await trayPause("news.mp4")).toBeEnabled();
    await act(async () => { void router.navigate(1); });
    expect(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).toBeInTheDocument();
  });

  it("restores a direct URL and follows Back and Forward across structured filters", async () => {
    const router = renderLibrary(source, "/media?q=News&rights=pending&sort=updated_asc&limit=48");
    await screen.findByRole("button", { name: card("News update") });
    expect(videoSearch()).toHaveValue("News");
    expect(screen.getByRole("button", { name: "Edit filter Rights: Needs review" })).toBeInTheDocument();
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "News", limit: 48, rightsStatus: "pending", sort: "name_asc", posters: true,
    });

    chooseVideoFilter("Uploader", "Me");
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "News", limit: 48, createdBy: "staff", sort: "name_asc", posters: true,
    }));
    expect(screen.getByRole("button", { name: "Edit filter Uploader: Me" })).toBeInTheDocument();

    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit filter Rights: Needs review" })).toBeInTheDocument());
    expect(videoSearch()).toHaveValue("News");
    await act(async () => { await router.navigate(1); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit filter Uploader: Me" })).toBeInTheDocument());
  });

  it.each([1280, 390])("restores canonical video filters with one read and no write after Undo at %ipx", async width => {
    setViewport(width);
    const router = renderLibraryWithNotices(source, "/media?q=News&rights=pending&sort=updated_asc&limit=48");
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledOnce());
    expect(videoSearch()).toHaveValue("News");
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));

    await waitFor(() => expect(router.state.location.search).toBe("?sort=updated_asc&limit=48"));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(2));
    const notice = screen.getByRole("region", { name: "Notifications" });
    fireEvent.click(await within(notice).findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(router.state.location.search)
      .toBe("?q=News&rights=pending&sort=updated_asc&limit=48"));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(3));
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library",
      q: "News",
      limit: 48,
      rightsStatus: "pending",
      sort: "name_asc",
      posters: true,
    });
    expect(videoSearch()).toHaveValue("News");
    expect(screen.getByRole("button", { name: "Edit filter Rights: Needs review" })).toBeInTheDocument();
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
    expect(setFavorite).not.toHaveBeenCalled();
    expect(deleteSourceMedia).not.toHaveBeenCalled();
  });

  it("changes Display locally and requests only the new page limit", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    const calls = vi.mocked(listSourceMedia).mock.calls.length;
    const display = openVideoDisplay();

    fireEvent.click(within(display).getByRole("radio", { name: "List" }));
    fireEvent.click(within(display).getByRole("radio", { name: "Small" }));
    fireEvent.change(within(display).getByRole("combobox", { name: "Density" }), { target: { value: "compact" } });
    fireEvent.click(within(display).getByRole("checkbox", { name: "Updated" }));
    expect(listSourceMedia).toHaveBeenCalledTimes(calls);
    expect(screen.getByRole("grid", { name: "Videos" })).toHaveAttribute("data-layout", "list");
    expect(screen.getByRole("heading", { name: "Video library" }).closest("section")).toHaveAttribute("data-thumbnail", "s");
    expect(screen.getByRole("heading", { name: "Video library" }).closest("section")).toHaveAttribute("data-density", "compact");

    fireEvent.change(within(display).getByRole("combobox", { name: "Per page" }), { target: { value: "48" } });
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(calls + 1));
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "", limit: 48, posters: true,
    });
  });

  it("shows uploader names to editors in cards, rows and details while retaining the Me filter", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [
      { ...asset, uploadedBy: { name: "Alex Rivera" } },
    ], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary(source, "/media", { id: "staff", grants: [{ role: "editor" }] });
    await screen.findByRole("button", { name: card("News update") });
    const display = openVideoDisplay();
    const uploaderField = within(display).getByRole("checkbox", { name: "Uploader" });
    expect(uploaderField).toBeEnabled();
    fireEvent.click(uploaderField);
    expect(tileOf("News update")).toHaveTextContent("Uploaded by Alex Rivera");
    fireEvent.click(within(display).getByRole("radio", { name: "List" }));
    expect(screen.getByRole("columnheader", { name: "Uploaded by" })).toBeInTheDocument();
    expect(screen.getByText("Alex Rivera")).toBeInTheDocument();
    fireEvent.keyDown(display, { key: "Escape" });

    chooseVideoFilter("Uploader", "Me");
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "", limit: 24, createdBy: "staff", posters: true,
    }));
    expect(screen.getByRole("button", { name: "Edit filter Uploader: Me" })).toBeInTheDocument();
    expect(screen.getByText(/1 videos · Uploaded by Me/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: card("News update") }));
    await waitFor(() => expect(within(videoInspector()).getByText("Uploaded by").nextElementSibling).toHaveTextContent("Alex Rivera"));
  });

  it("drops an unauthorized uploader filter before requesting or displaying the page", async () => {
    const router = renderLibrary(source, "/media?by=private-account-id", { id: "staff", grants: [] });
    await screen.findByRole("button", { name: card("News update") });
    await waitFor(() => expect(router.state.location.search).toBe("") );
    expect(screen.queryByRole("button", { name: /Edit filter Uploader/ })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("private-account-id");
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", {
      sourceId: "video-library", q: "", limit: 24, posters: true,
    });
    expect(vi.mocked(listSourceMedia).mock.calls.every(([, query]) => query.createdBy !== "private-account-id")).toBe(true);

    const dialog = openVideoFilter("Uploader");
    expect(within(dialog).getAllByRole("checkbox").map((option) => option.closest("label")?.textContent)).toEqual(["Me"]);
  });

  it("keeps a submitted search draft pending while video details are dirty", async () => {
    renderLibrary({ ...source, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: "Changed" } });
    fireEvent.change(videoSearch(), { target: { value: "News" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    expect(videoSearch()).toHaveValue("News");
  });

  it("applies the visible name search when changing filters", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    fireEvent.change(videoSearch(), { target: { value: "News" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    fireEvent.change(videoSearch(), { target: { value: "Weather" } });
    chooseVideoFilter("Rights review", "Needs review");
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", { sourceId: "video-library", q: "Weather", limit: 24, rightsStatus: "pending", sort: "name_asc", posters: true }));
  });

  it("rejects an empty tag instead of silently submitting an unfiltered search", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    const dialog = applyVideoTag("   ");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter a tag or choose another filter.");
    expect(within(dialog).getByRole("textbox", { name: "Tag" })).toHaveAttribute("aria-invalid", "true");
    expect(videoSearch()).not.toHaveAttribute("aria-invalid");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Tag" }), { target: { value: "Interview" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets an uncertain deletion retry the same version to recover its result", async () => {
    vi.mocked(deleteSourceMedia).mockRejectedValueOnce(new Error("Network failed"))
      .mockResolvedValueOnce({ success: true, deleted: true });
    renderLibrary({ ...source, canDelete: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    beginDeletion();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));
    await screen.findByText("Could not confirm deletion. Try again to check its status.");
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));
    await screen.findByText("Video deleted from library");
    expect(vi.mocked(deleteSourceMedia).mock.calls.slice(-2)).toEqual([
      ["staff-token", "video-library", "video-1", 1], ["staff-token", "video-library", "video-1", 1],
    ]);
  });

  it("requires confirmation, preserves edits, and shows deletion errors without losing the video", async () => {
    vi.mocked(deleteSourceMedia).mockRejectedValueOnce(new HttpError(403, "Access denied"));
    renderLibrary({ ...source, canEditMetadata: true, canDelete: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Changed title" } });
    openDeleteSection();
    expect(deleteTrigger()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "News update" } });
    fireEvent.click(deleteTrigger());
    expect(deleteSourceMedia).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm video deletion" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));
    await screen.findByText("Access denied");
    expect(deleteSourceMedia).toHaveBeenCalledWith("staff-token", "video-library", "video-1", 1);
    expect(screen.getByRole("dialog", { name: "News update" })).toBeInTheDocument();
  });

  it("closes the deleted video and reloads the first page while retaining the filter", async () => {
    let finishDelete!: () => void;
    vi.mocked(deleteSourceMedia).mockImplementation(() => new Promise(resolve => { finishDelete = () => resolve({ success: true, deleted: true }); }));
    renderLibrary({ ...source, canDelete: true });
    await screen.findByRole("button", { name: card("News update") });
    chooseVideoFilter("Uploader", "Me");
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    beginDeletion();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));
    await waitFor(() => expect(deleteSourceMedia).toHaveBeenCalled());
    expect(screen.getAllByRole("button", { name: "Close" })[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep video" })).toBeDisabled();
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [], nextCursor: null, hasMore: false, total: null });
    await act(async () => finishDelete());
    await screen.findByText("Video deleted from library");
    expect(screen.queryByRole("dialog", { name: "News update" })).not.toBeInTheDocument();
    expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", { sourceId: "video-library", q: "", limit: 24, createdBy: "staff" , posters: true });
    await screen.findByText("No videos found");
  });

  it("hides deletion without server permission and labels legacy attribution honestly", async () => {
    renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    expect(screen.queryByRole("button", { name: "Delete from library" })).not.toBeInTheDocument();
    expect(screen.getByText("Uploaded by").nextElementSibling).toHaveTextContent("Not recorded");
  });
});


it("holds route navigation during deletion and releases it after settlement", async () => {
  let finish!: () => void;
  vi.mocked(deleteSourceMedia).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ success: true, deleted: true }); }));
  const router = renderLibrary({ ...source, canDelete: true });
  fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
  beginDeletion();
  fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));
  await waitFor(() => expect(deleteSourceMedia).toHaveBeenCalled());
  await act(async () => { void router.navigate("/away"); });
  expect(screen.queryByRole("heading", { name: "Away" })).not.toBeInTheDocument();
  await act(async () => finish());
  await screen.findByRole("heading", { name: "Away" });
});

it("requires reloading a changed video before confirming deletion again", async () => {
  const current = { ...asset, name: "Updated by a colleague", version: 2 };
  vi.mocked(deleteSourceMedia).mockRejectedValueOnce(new HttpError(409, "Media asset changed", { current }));
  renderLibrary({ ...source, canDelete: true });
  fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
  beginDeletion();
  fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));
  await screen.findByText("Media asset changed");
  expect(screen.getByRole("button", { name: "Yes, delete from library" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload details" }));
  fireEvent.click(deleteTrigger());
  fireEvent.click(screen.getByRole("button", { name: "Yes, delete from library" }));
  await waitFor(() => expect(deleteSourceMedia).toHaveBeenLastCalledWith("staff-token", "video-library", "video-1", 2));
});

describe("video library grid", () => {
  function requestCounts() {
    return {
      list: vi.mocked(listSourceMedia).mock.calls.length,
      read: vi.mocked(createSourceMediaRead).mock.calls.length,
      favorites: listFavoriteStates.mock.calls.length,
      favorite: setFavorite.mock.calls.length,
    };
  }
  function videos(count: number, prefix = "Video") {
    return Array.from({ length: count }, (_, index): SourceMediaAssetSummary => ({ ...asset, id: `${prefix.toLowerCase()}-${index + 1}`, name: `${prefix} ${index + 1}` }));
  }

  it("selects from the tile mark without opening the player", async () => {
    renderLibrary();
    await screen.findByRole("grid", { name: "Videos" });
    await waitFor(() => expect(listFavoriteStates).toHaveBeenCalled());
    const calls = requestCounts();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select News update" }));
    expect(selectionBar()).toHaveTextContent("1 of 100 selected");
    expect(screen.queryByRole("dialog", { name: "News update" })).not.toBeInTheDocument();
    expect(requestCounts()).toEqual(calls);
  });

  it("Cmd+A selects the page up to the cap", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: videos(3), nextCursor: null, hasMore: false, total: 3 });
    renderLibrary();
    const first = await screen.findByRole("button", { name: card("Video 1") });
    fireEvent.keyDown(first, { key: "a", metaKey: true });
    expect(selectionBar()).toHaveTextContent("3 of 100 selected");
  });

  // 101 tiles render slowly in jsdom when the whole suite runs in parallel.
  it("Cmd+A refuses a page that would pass the 100-video cap, whole", { timeout: 20_000 }, async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: videos(101), nextCursor: null, hasMore: false, total: 101 });
    renderLibrary();
    fireEvent.keyDown(await screen.findByRole("button", { name: card("Video 1") }), { key: "a", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Select no more than 100 videos in one batch. No additional videos were selected.");
    expect(screen.queryByRole("group", { name: "Video selection" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Video 1" })).not.toBeChecked();
  });

  it("the bar reads 7 of 100 selected · 3 not on this page", async () => {
    const pageOne = videos(7);
    const pageTwo = [...pageOne.slice(3), ...videos(2, "Other")];
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: pageOne, nextCursor: "page-two", hasMore: true, total: 9 })
      .mockResolvedValueOnce({ success: true, records: pageTwo, nextCursor: null, hasMore: false, total: 9 });
    renderLibrary();
    fireEvent.keyDown(await screen.findByRole("button", { name: card("Video 1") }), { key: "a", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: card("Other 1") });
    expect(selectionBar()).toHaveTextContent("7 of 100 selected · 3 not on this page");
    expect(within(selectionBar()).getByRole("checkbox", { name: "Select this page" })).toBePartiallyChecked();
    expect(within(selectionBar()).getByRole("button", { name: "Add to collection" })).toBeEnabled();
    // The always-mounted status announces the count; the bar has no live region of its own.
    expect(within(selectionBar()).queryByRole("status")).toBeNull();
    expect(screen.getAllByRole("status").some(status => status.textContent === "7 of 100 selected · 3 not on this page")).toBe(true);
  });

  it("the context menu offers Show videos uploaded by NAME only when the uploader has a uid, and opening it makes no request", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [
      { ...asset, uploadedBy: { uid: "alex", name: "Alex Rivera" } },
      { ...asset, id: "video-2", name: "Evening update", uploadedBy: { name: "Jordan Kim" } },
    ], nextCursor: null, hasMore: false, total: 2 });
    renderLibrary();
    const withUid = await screen.findByRole("button", { name: card("News update") });
    await waitFor(() => expect(listFavoriteStates).toHaveBeenCalled());
    const calls = requestCounts();
    // The uploader field is optional; the menu action still uses a server-presented name.
    expect(screen.queryByText("Uploaded by Alex Rivera")).toBeNull();
    expect(screen.queryByText("Uploaded by Jordan Kim")).toBeNull();

    fireEvent.keyDown(screen.getByRole("button", { name: card("Evening update") }), { key: "F10", shiftKey: true });
    const nameOnly = screen.getByRole("menu", { name: "Evening update" });
    expect(within(nameOnly).queryByRole("menuitem", { name: /Show videos uploaded by/ })).toBeNull();
    fireEvent.keyDown(nameOnly, { key: "Escape" });

    fireEvent.keyDown(withUid, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "News update" });
    expect(within(menu).getAllByRole("menuitem").map(item => item.textContent)).toEqual([
      "Open and play", "Quick Look", "Add to favorites", "Add to collection", "Select", "Show videos uploaded by Alex Rivera",
    ]);
    expect(requestCounts()).toEqual(calls);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Show videos uploaded by Alex Rivera" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", { sourceId: "video-library", q: "", limit: 24, createdBy: "alex" , posters: true }));
    expect(vi.mocked(listSourceMedia).mock.calls.length).toBe(calls.list + 1);
  });

  it("a hover card shows duration, rights, preview state, uploader and tags from the page", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{
      ...asset, tags: ["Interview", "Newark", "Budget", "Statehouse"], uploadedBy: { uid: "alex", name: "Alex Rivera" },
      viewingCopy: { state: "ready", durationSeconds: 166, width: 1280, height: 720, sizeBytes: 90 * 1024 ** 2 },
    }], nextCursor: null, hasMore: false, total: 1 });
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    renderLibrary();
    const open = await screen.findByRole("button", { name: card("News update") });
    await waitFor(() => expect(listFavoriteStates).toHaveBeenCalled());
    const calls = requestCounts();
    act(() => open.focus());
    expect(screen.queryByRole("group", { name: "Details for News update" })).toBeNull();
    const facts = await screen.findByRole("group", { name: "Details for News update" }, { timeout: 1500 });
    for (const text of ["2:46", "Needs review", "Preview ready", "Alex Rivera", "Interview", "Statehouse"]) expect(facts).toHaveTextContent(text);
    fireEvent.keyDown(open, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Details for News update" })).toBeNull();
    expect(requestCounts()).toEqual(calls);
  });

  it("posters still load only after their tile enters the viewport, four at a time", async () => {
    const reveals: Array<() => void> = [];
    const observed: Element[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      private callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
      observe(element: Element) {
        observed.push(element);
        reveals.push(() => this.callback([{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver));
      }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    const resolvers: Array<(access: SourceMediaRead) => void> = [];
    vi.mocked(createSourceMediaRead).mockImplementation((_token, _sourceId, _assetId, action) => {
      expect(action).toBe("poster");
      return new Promise(resolve => resolvers.push(resolve));
    });
    const records = videos(6).map(record => ({ ...record, viewingCopy: { state: "ready" as const } }));
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 6 });
    renderLibrary();
    await screen.findByRole("button", { name: card("Video 6") });
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    // Every observer target is in a tile thumbnail from the first render.
    expect(observed.length).toBeGreaterThanOrEqual(6);
    expect(observed.every(element => element.isConnected && element.closest(".media-tile-thumb"))).toBe(true);
    act(() => reveals.forEach(reveal => reveal()));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(4));
    resolvers[0](mediaRead("poster", "video-1"));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(5));
    resolvers.slice(1).forEach((resolve, index) => resolve(mediaRead("poster", `video-${index + 2}`)));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(6));
    await act(async () => { await Promise.resolve(); });
    expect(new Set(vi.mocked(createSourceMediaRead).mock.calls.map(call => call[2])).size).toBe(6);
  });

  it("Delete from library in the card menu opens the viewer at its delete confirmation", async () => {
    localStorage.setItem("cms.inspector.video.section.delete", "closed");
    renderLibrary({ ...source, canDelete: true });
    const open = await screen.findByRole("button", { name: card("News update") });
    fireEvent.keyDown(open, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "News update" });
    const items = within(menu).getAllByRole("menuitem").map(item => item.textContent);
    expect(items.at(-1)).toBe("Delete from library");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete from library" }));
    expect(await screen.findByRole("dialog", { name: "News update" })).toBeInTheDocument();
    const confirmation = screen.getByRole("group", { name: "Confirm video deletion" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete from library" })).toHaveAttribute("aria-expanded", "true"));
    expect(confirmation.closest("[hidden]")).toBeNull();
    await waitFor(() => expect(confirmation).toHaveFocus());
    expect(localStorage.getItem("cms.inspector.video.section.delete")).toBe("closed");
    expect(deleteSourceMedia).not.toHaveBeenCalled();
  });

  it("Escape clears the selection and returns focus to the card that last had focus", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: videos(2), nextCursor: null, hasMore: false, total: 2 });
    renderLibrary();
    const second = await screen.findByRole("button", { name: card("Video 2") });
    act(() => second.focus());
    fireEvent.keyDown(second, { key: " " });
    expect(selectionBar()).toHaveTextContent("1 of 100 selected");
    fireEvent.click(within(selectionBar()).getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("group", { name: "Video selection" })).not.toBeInTheDocument();
    await waitFor(() => expect(second).toHaveFocus());
    fireEvent.keyDown(second, { key: " " });
    fireEvent.keyDown(second, { key: "Escape" });
    // A focus-opened hover card may take the first Escape.
    if (screen.queryByRole("group", { name: "Video selection" })) fireEvent.keyDown(second, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Video selection" })).not.toBeInTheDocument();
    expect(second).toHaveFocus();
  });

  it("locks selection and tile actions while the viewer holds unsaved details", async () => {
    renderLibrary({ ...source, canUpload: true, canEditMetadata: true });
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: "Changed" } });
    expect(screen.getByRole("checkbox", { name: "Select News update", hidden: true })).toBeDisabled();
  });
});

// Display's List layout is the shared list (MediaGrid layout="list" with MediaRow), so both
// layouts share selection, keyboard, menus and hover cards.
describe("video library list", () => {
  function requestCounts() {
    return {
      list: vi.mocked(listSourceMedia).mock.calls.length,
      read: vi.mocked(createSourceMediaRead).mock.calls.length,
      favorites: listFavoriteStates.mock.calls.length,
      favorite: setFavorite.mock.calls.length,
    };
  }
  function videos(count: number, prefix = "Video") {
    return Array.from({ length: count }, (_, index): SourceMediaAssetSummary => ({ ...asset, id: `${prefix.toLowerCase()}-${index + 1}`, name: `${prefix} ${index + 1}` }));
  }
  function chooseView(label: "Cards" | "Compact list") {
    chooseVideoLayout(label === "Cards" ? "Grid" : "List");
  }
  function rowOf(name: string) { return screen.getByRole("button", { name: card(name) }).closest(".media-row") as HTMLElement; }

  it("renders Compact list as the shared list layout with one row per video and the same selection, menu and favorite actions as cards", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [
      { ...asset, uploadedBy: { uid: "alex", name: "Alex Rivera" }, tags: ["Interview"],
        viewingCopy: { state: "ready", durationSeconds: 166, sizeBytes: 90 * 1024 ** 2 }, updatedAt: "2026-09-23T16:05:00.000Z" },
      { ...asset, id: "video-2", name: "Evening update", viewingCopy: { state: "processing" } },
    ], nextCursor: null, hasMore: false, total: 2 });
    renderLibrary();
    await screen.findByRole("grid", { name: "Videos" });
    await waitFor(() => expect(listFavoriteStates).toHaveBeenCalled());
    chooseView("Compact list");

    const grid = screen.getByRole("grid", { name: "Videos" });
    expect(grid).toHaveAttribute("data-layout", "list");
    expect(document.querySelector(".media-tile")).toBeNull();
    expect(document.querySelector(".source-video-list, .source-video-card")).toBeNull();
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual([
      "Select this page", "Poster", "Name", "Type", "Size", "Duration", "Rights", "Tags", "Actions",
    ]);

    const first = rowOf("News update");
    const cells = [...first.querySelectorAll<HTMLElement>("[data-column]")];
    expect(cells.map(cell => cell.dataset.column)).toEqual(["type", "size", "duration", "rights", "tags"]);
    expect(cells.map(cell => cell.textContent)).toEqual(["Video", "10.0 MB", "2:46", "Needs review", "Interview"]);
    // The optional uploader column is hidden; its filter remains in the row menu.
    expect(screen.queryByRole("button", { name: "Show videos uploaded by Alex Rivera" })).toBeNull();
    expect(within(rowOf("Evening update")).queryByText("Uploader not recorded")).toBeNull();

    const calls = requestCounts();
    fireEvent.click(within(first).getByRole("checkbox", { name: "Select News update" }));
    expect(selectionBar()).toHaveTextContent("1 of 100 selected");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog", { name: "News update" })).not.toBeInTheDocument();

    fireEvent.keyDown(within(first).getByRole("button", { name: card("News update") }), { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "News update" });
    expect(within(menu).getAllByRole("menuitem").map(item => item.textContent)).toEqual([
      "Open and play", "Quick Look", "Add to favorites", "Add to collection", "Deselect", "Show videos uploaded by Alex Rivera",
    ]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(requestCounts()).toEqual(calls);

    fireEvent.click(within(first).getByRole("button", { name: "Add to favorites: News update" }));
    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith("staff-token", { backend: "s3", sourceId: "video-library", id: "video-1" }, true));
    expect(requestCounts()).toEqual({ ...calls, favorite: calls.favorite + 1 });
  });

  it("keeps the chosen View across paging and search, and sends no extra request when it changes", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: videos(3), nextCursor: "page-two", hasMore: true, total: 6 });
    renderLibrary();
    const second = await screen.findByRole("button", { name: card("Video 2") });
    await waitFor(() => expect(listFavoriteStates).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Video 2" }));
    act(() => second.focus());
    const calls = requestCounts();

    chooseView("Compact list");
    expect(requestCounts()).toEqual(calls);
    expect(screen.getByRole("grid", { name: "Videos" })).toHaveAttribute("data-layout", "list");
    // The selection carries across the switch, and the grid's tab stop stays on the same video.
    expect(screen.getByRole("checkbox", { name: "Select Video 2" })).toBeChecked();
    expect(selectionBar()).toHaveTextContent("1 of 100 selected");
    expect(screen.getByRole("button", { name: card("Video 2") })).not.toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: card("Video 1") })).toHaveAttribute("tabindex", "-1");

    chooseView("Cards");
    chooseView("Compact list");
    expect(requestCounts()).toEqual(calls);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", expect.objectContaining({ cursor: "page-two" })));
    await screen.findByRole("button", { name: card("Video 1") });
    expect(screen.getByRole("grid", { name: "Videos" })).toHaveAttribute("data-layout", "list");
    fireEvent.change(videoSearch(), { target: { value: "video" } });
    fireEvent.submit(screen.getByRole("search", { name: "Video search" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenLastCalledWith("staff-token", expect.objectContaining({ q: "video" })));
    await screen.findByRole("button", { name: card("Video 1") });
    expect(screen.getByRole("grid", { name: "Videos" })).toHaveAttribute("data-layout", "list");
  });

  it("loads a list-row poster only after its row enters the viewport", async () => {
    let reveal: (() => void) | undefined;
    const observed: Element[] = [];
    let margin = "";
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        margin = options?.rootMargin ?? "";
        reveal = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{ ...asset, viewingCopy: { state: "ready", sizeBytes: 4 * 1024 ** 2 } }], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    observed.length = 0;
    chooseView("Compact list");
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    // The observed element is the poster frame in the row's thumbnail, with the 160px margin.
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(element => element.isConnected && element.closest(".media-row-thumb") === rowOf("News update").querySelector(".media-row-thumb"))).toBe(true);
    expect(margin).toBe("160px");
    act(() => reveal?.());
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledWith("staff-token", "video-library", "video-1", "poster"));
    await waitFor(() => expect(rowOf("News update").querySelector('img[src="https://media.example.test/poster"]')).toBeInTheDocument());
    // Back to Cards and to the list again: the cached poster is reused, with no new read.
    chooseView("Cards");
    act(() => reveal?.());
    chooseView("Compact list");
    act(() => reveal?.());
    await waitFor(() => expect(rowOf("News update").querySelector('img[src="https://media.example.test/poster"]')).toBeInTheDocument());
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a poster read that is still in flight when View switches", async () => {
    const reveals: Array<() => void> = [];
    vi.stubGlobal("IntersectionObserver", class {
      private callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
      observe(element: Element) { reveals.push(() => this.callback([{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    const resolvers: Array<(access: SourceMediaRead) => void> = [];
    vi.mocked(createSourceMediaRead).mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{ ...asset, viewingCopy: { state: "ready" } }], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    act(() => reveals.splice(0).forEach(reveal => reveal()));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(1));
    // The read is still out when the View changes; the list row waits for the same read.
    chooseView("Compact list");
    act(() => reveals.splice(0).forEach(reveal => reveal()));
    await act(async () => { await Promise.resolve(); });
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
    await act(async () => { resolvers[0](mediaRead("poster")); await Promise.resolve(); });
    await waitFor(() => expect(rowOf("News update").querySelector('img[src="https://media.example.test/poster"]')).toBeInTheDocument());
    chooseView("Cards");
    act(() => reveals.splice(0).forEach(reveal => reveal()));
    await waitFor(() => expect(tileOf("News update").querySelector('img[src="https://media.example.test/poster"]')).toBeInTheDocument());
    expect(createSourceMediaRead).toHaveBeenCalledTimes(1);
  });

  it("starts a current poster read after the media list changes while the old read is in flight", async () => {
    const reveals: Array<() => void> = [];
    vi.stubGlobal("IntersectionObserver", class {
      private callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
      observe(element: Element) { reveals.push(() => this.callback([{ isIntersecting: true, target: element } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
    const resolvers: Array<(access: SourceMediaRead) => void> = [];
    vi.mocked(createSourceMediaRead).mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{ ...asset, viewingCopy: { state: "ready" } }], nextCursor: null, hasMore: false, total: 1 });
    renderLibrary();
    await screen.findByRole("button", { name: card("News update") });
    act(() => reveals.splice(0).forEach(reveal => reveal()));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(1));

    act(() => invalidateMediaLists());
    chooseView("Compact list");
    act(() => reveals.splice(0).forEach(reveal => reveal()));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(2));

    await act(async () => { resolvers[0](mediaRead("poster", asset.id, "https://media.example.test/stale-poster")); await Promise.resolve(); });
    expect(rowOf("News update").querySelector("img")).not.toBeInTheDocument();
    await act(async () => { resolvers[1](mediaRead("poster", asset.id, "https://media.example.test/current-poster")); await Promise.resolve(); });
    await waitFor(() => expect(rowOf("News update").querySelector('img[src="https://media.example.test/current-poster"]')).toBeInTheDocument());
  });

  it("moves with Up and Down, toggles with Space and opens the player with Enter", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: videos(3), nextCursor: null, hasMore: false, total: 3 });
    renderLibrary();
    await screen.findByRole("button", { name: card("Video 1") });
    chooseView("Compact list");
    const first = screen.getByRole("button", { name: card("Video 1") });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("button", { name: card("Video 2") });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "ArrowRight" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: " " });
    expect(selectionBar()).toHaveTextContent("1 of 100 selected");
    fireEvent.keyDown(second, { key: "ArrowDown", shiftKey: true });
    expect(selectionBar()).toHaveTextContent("2 of 100 selected");
    fireEvent.keyDown(screen.getByRole("button", { name: card("Video 3") }), { key: "ArrowUp" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "Video 2" })).toBeInTheDocument();
  });

  it("keeps focus on the same row while a processing poll refreshes the page", async () => {
    vi.useFakeTimers();
    const records = videos(2).map(record => ({ ...record, viewingCopy: { state: "processing" as const } }));
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records, nextCursor: null, hasMore: false, total: 2 });
    renderLibrary();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    chooseView("Compact list");
    const second = screen.getByRole("button", { name: card("Video 2") });
    act(() => second.focus());
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listSourceMedia).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: card("Video 2") })).toBe(second);
    expect(second).toHaveFocus();
  });

  it("deletes the old Compact list rows and their CSS", () => {
    const routeCss = readFileSync(resolve(process.cwd(), "src/routes/SourceMediaLibrary.css"), "utf8");
    const bulkCss = readFileSync(resolve(process.cwd(), "src/components/SourceMediaBulkEditor.css"), "utf8");
    for (const css of [routeCss, bulkCss]) {
      expect(css).not.toMatch(/source-video-list|source-video-grid|source-video-card[ ,{:.]|source-video-card-(copy|status|labels)|source-video-row-facts|source-video-tag|source-bulk-select|source-bulk-card-select|data-bulk-select/);
    }
  });
});


describe("video permalinks", () => {
  it("removes its pushed entry on close so Back leaves the library", async () => {
    const router = renderLibrary();
    fireEvent.click(await screen.findByRole("button", { name: card("News update") }));
    await screen.findByLabelText("Preview News update");
    expect(router.state.location.search).toBe("?asset=video-1");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(router.state.location.search).toBe(""));
    await act(async () => { await router.navigate(-1); });
    expect(await screen.findByRole("heading", { name: "Away" })).toBeInTheDocument();
  });

  it("opens a cold link and returns to the library on close", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [{ ...asset, viewingCopy: { state: "ready", durationSeconds: 120 } }], nextCursor: null, hasMore: false, total: 1 });
    const router = renderLibrary(source, "/media?asset=video-1&t=72");
    const player = await screen.findByLabelText("Preview News update");
    expect(player.closest(".video-viewer-workspace")).toHaveAttribute("data-view", "watch");
    Object.defineProperty(player, "duration", { value: 120, configurable: true });
    fireEvent.loadedMetadata(player);
    expect((player as HTMLVideoElement).currentTime).toBe(72);
    const reads = vi.mocked(listSourceMedia).mock.calls.length;
    await act(async () => { await router.navigate("/media?asset=video-1&t=72", { replace: true }); });
    expect(listSourceMedia).toHaveBeenCalledTimes(reads);
    expect(screen.getByLabelText("Preview News update")).toBe(player);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(router.state.location.search).toBe(""));
    await act(async () => { await router.navigate(-1); });
    expect(await screen.findByRole("heading", { name: "Away" })).toBeInTheDocument();
  });
  it("keeps a linked time when the first preview fails before metadata and is refreshed", async () => {
    renderLibrary(source, "/media?asset=video-1&t=72");
    const player = await screen.findByLabelText("Preview News update") as HTMLVideoElement;
    expect(player.currentTime).toBe(0);
    fireEvent.error(player);
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    await waitFor(() => expect(createSourceMediaRead).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByLabelText("Preview News update")).toBe(player);
    Object.defineProperty(player, "duration", { value: 120, configurable: true });
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBe(72);
  });
  it("renders no player or download for denied linked assets", async () => {
    vi.mocked(listSourceMedia).mockImplementation(async (_token, query) => {
      if (query.assetId) throw new HttpError(403, "private backend detail");
      return { success: true, records: [], nextCursor: null, hasMore: false, total: 0 };
    });
    renderLibrary(source, "/media?asset=denied");
    expect(await screen.findByText("This file is unavailable or you do not have access to it.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    expect(screen.queryByText("private backend detail")).not.toBeInTheDocument();
  });
  it("keeps an out-of-range time at the start with a message", async () => {
    renderLibrary(source, "/media?asset=video-1&t=99999");
    const player = await screen.findByLabelText("Preview News update");
    Object.defineProperty(player, "duration", { value: 120, configurable: true });
    fireEvent.loadedMetadata(player);
    expect((player as HTMLVideoElement).currentTime).toBe(0);
    expect(screen.getByText(/That time is past the end/)).toBeInTheDocument();
  });
});

  it("runs the saved-edit close cleanup when browser Back removes the permalink", async () => {
    const second = { ...asset, id: "video-2", name: "Second video", originalName: "second.mp4" };
    const cache = await import("../src/lib/video-search-session-cache");
    const invalidate = vi.spyOn(cache, "invalidateVideoSearchCorpus");
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [asset], nextCursor: "page-2", hasMore: true, total: 2 })
      .mockResolvedValueOnce({ success: true, records: [second], nextCursor: null, hasMore: false, total: 2 })
      .mockResolvedValue({ success: true, records: [asset, second], nextCursor: null, hasMore: false, total: 2 });
    vi.mocked(updateSourceMediaMetadata).mockResolvedValue({
      success: true,
      asset: { ...second, name: "Saved title", version: 2 },
    });
    const router = renderLibrary({ ...source, canEditMetadata: true });
    await screen.findByRole("button", { name: card("News update") });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledWith(
      "staff-token",
      expect.objectContaining({ cursor: "page-2" }),
    ));
    fireEvent.click(await screen.findByRole("button", { name: card("Second video") }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), { target: { value: "Saved title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith("video-library"));
    await screen.findByText("Video details saved.");
    const callsBeforeClose = vi.mocked(listSourceMedia).mock.calls.length;
    await act(async () => { await router.navigate(-1); });
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(callsBeforeClose + 1));
    const reload = vi.mocked(listSourceMedia).mock.calls.at(-1)?.[1] as { cursor?: string };
    expect(reload.cursor).toBeUndefined();
    await waitFor(() => expect(screen.getByRole("button", { name: card("Second video") })).toHaveFocus());
    invalidate.mockRestore();
  });

describe("video personal saved views", () => {
  it.each([1280, 390])("keeps saved-view requests bounded through load, open, save, and apply at %ipx", async (width) => {
    setViewport(width);
    const view = { id: `news-video-${width}`, name: "News video", surface: "video:video-library" as const, query: "q=News&rights=pending&sort=updated_asc&limit=48" };
    const savedUser = `saved-video-count-${width}`;
    const principal = { ...usersViewer, id: savedUser };
    loadSavedViews.mockResolvedValueOnce([view]);
    mutateSavedViews.mockImplementationOnce(async (_userId, mutation: { view: unknown }) => [view, mutation.view]);
    const counts = () => ({
      list: vi.mocked(listSourceMedia).mock.calls.length,
      favoriteStates: listFavoriteStates.mock.calls.length,
      posterReads: vi.mocked(createSourceMediaRead).mock.calls.filter((call) => call[3] === "poster").length,
      savedReads: loadSavedViews.mock.calls.length,
      savedTransactions: mutateSavedViews.mock.calls.length,
    });

    const router = renderLibrary(source, "/media?q=Current", principal, savedUser);
    await screen.findByRole("button", { name: card("News update") });
    await waitFor(() => expect(counts()).toEqual({
      list: 1, favoriteStates: 1, posterReads: 0, savedReads: 0, savedTransactions: 0,
    }));

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    const filter = screen.getByRole("dialog", { name: "Filter" });
    expect(await within(filter).findByRole("button", { name: view.name })).toBeInTheDocument();
    expect(counts()).toEqual({
      list: 1, favoriteStates: 1, posterReads: 0, savedReads: 1, savedTransactions: 0,
    });
    fireEvent.keyDown(filter, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const display = screen.getByRole("dialog", { name: "Display" });
    expect(within(display).getByRole("button", { name: "Save as view" })).toBeEnabled();
    expect(counts()).toEqual({
      list: 1, favoriteStates: 1, posterReads: 0, savedReads: 1, savedTransactions: 0,
    });
    fireEvent.click(within(display).getByRole("button", { name: "Save as view" }));
    fireEvent.change(within(display).getByRole("textbox", { name: "Name" }), { target: { value: "Current videos" } });
    fireEvent.click(within(display).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(counts()).toEqual({
      list: 1, favoriteStates: 1, posterReads: 0, savedReads: 1, savedTransactions: 1,
    }));
    fireEvent.keyDown(display, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    fireEvent.click(await screen.findByRole("button", { name: view.name }));
    await waitFor(() => expect(router.state.location.search).toBe(`?q=News&rights=pending&sort=updated_asc&limit=48&view=${view.id}`));
    await waitFor(() => expect(counts()).toEqual({
      list: 2, favoriteStates: 1, posterReads: 0, savedReads: 1, savedTransactions: 1,
    }));
  });

  it("loads no profile on page load, isolates the source, and expands an applied view", async () => {
    const matching = { id: "news-video", name: "News video", surface: "video:video-library" as const, query: "q=News&rights=pending&sort=updated_asc&limit=48" };
    const other = { id: "archive-video", name: "Archive video", surface: "video:archive" as const, query: "q=Archive" };
    loadSavedViews.mockResolvedValueOnce([matching, other]);
    const savedUser = "saved-video-user";
    const principal = { ...usersViewer, id: savedUser };
    const router = renderLibrary(source, "/media?t=12", principal, savedUser);
    await screen.findByRole("button", { name: card("News update") });
    expect(loadSavedViews).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));
    expect(await screen.findByRole("button", { name: matching.name })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: other.name })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: matching.name }));

    await waitFor(() => expect(router.state.location.search).toBe("?q=News&rights=pending&sort=updated_asc&limit=48&view=news-video"));
    expect(loadSavedViews).toHaveBeenCalledOnce();
  });

  it("removes only a missing video view reference after the first popover load", async () => {
    const savedUser = "missing-video-view-user";
    const principal = { ...usersViewer, id: savedUser };
    const router = renderLibraryWithNotices(
      source,
      "/media?q=News&rights=pending&sort=updated_asc&limit=48&view=missing",
      principal,
      savedUser,
    );
    await screen.findByRole("button", { name: card("News update") });
    fireEvent.click(screen.getByRole("button", { name: /^Filter/ }));

    await waitFor(() => expect(router.state.location.search).toBe("?q=News&rights=pending&sort=updated_asc&limit=48"));
    expect(screen.getByRole("region", { name: "Notifications" })).toHaveTextContent("Current filters were kept.");
  });
});

describe("processing completion refresh", () => {
  it("refreshes once in the background, keeps focus and cards, and tolerates refresh failure", async () => {
    vi.useFakeTimers();
    const processing = { ...asset, viewingCopy: { state: "processing" as const } };
    const ready = { ...asset, viewingCopy: { state: "ready" as const } };
    let failRefresh!: (error: Error) => void;
    vi.mocked(listSourceMedia)
      .mockResolvedValueOnce({ success: true, records: [processing], nextCursor: null, hasMore: false, total: 1 })
      .mockResolvedValueOnce({ success: true, records: [ready], nextCursor: null, hasMore: false, total: null })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failRefresh = reject; }));
    renderLibrary();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const focused = screen.getByRole("button", { name: card("News update") });
    focused.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listSourceMedia).toHaveBeenCalledTimes(3);
    expect(focused).toBeInTheDocument();
    expect(focused).toHaveFocus();
    expect(screen.queryByText("Loading videos")).not.toBeInTheDocument();
    await act(async () => { failRefresh(new Error("Temporary network failure")); });
    expect(focused).toBeInTheDocument();
    expect(focused).toHaveFocus();
    expect(screen.queryByText("Videos could not be loaded. Try again.")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(listSourceMedia).toHaveBeenCalledTimes(3);
  });
});
