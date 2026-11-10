import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SourceMediaLibrary } from "../src/routes/SourceMediaLibrary";
import { createSourceMediaRead, listSourceMedia, updateSourceMediaMetadata, type MediaSourceSummary, type SourceMediaAssetSummary, type SourceMediaRead } from "../src/lib/source-media";
import { clearMediaSessionCache } from "../src/lib/media-session-cache";
import type { MediaFavoriteRef } from "../src/lib/media-favorites";

// Choosing Delete from library in a card menu opens the viewer at its delete confirmation.
// That intent must not outlive the viewer: a later open from a meaning-search result must
// start at the video, not at a deletion prompt for an unrelated video.

const { getIdToken, listFavoriteStates } = vi.hoisted(() => ({
  getIdToken: vi.fn().mockResolvedValue("staff-token"),
  listFavoriteStates: vi.fn(),
}));

vi.mock("../src/lib/source-media", () => ({ createSourceMediaRead: vi.fn(), deleteSourceMedia: vi.fn(), listSourceMedia: vi.fn(), updateSourceMediaMetadata: vi.fn() }));
vi.mock("../src/lib/media-favorites", () => ({
  listMediaFavoriteStates: (...args: unknown[]) => listFavoriteStates(...args),
  setMediaFavorite: vi.fn(),
}));
const other: { current: SourceMediaAssetSummary | null } = { current: null };
vi.mock("../src/components/VideoMeaningSearch", () => ({
  VideoMeaningSearch: ({ onOpen }: { onOpen: (asset: SourceMediaAssetSummary, seconds: number) => void }) => (
    <button onClick={() => other.current && onOpen(other.current, 12)} type="button">Open related result</button>
  ),
}));

const source: MediaSourceSummary = { id: "video-library", label: "Video library", description: "Shared staff videos", mediaKind: "video", canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: false, canDelete: true };
const asset: SourceMediaAssetSummary = { id: "video-1", sourceId: source.id, name: "News update", description: null, originalName: "news.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 10485760, preview: "browser", license: null, credit: null, tags: [], rightsStatus: "pending", version: 1, createdAt: null, updatedAt: null };
const second: SourceMediaAssetSummary = { ...asset, id: "video-2", name: "Weather brief", originalName: "weather.mp4" };

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

function mediaRead(action: SourceMediaRead["action"], assetId: string): SourceMediaRead {
  return {
    assetId, action, url: `https://media.example.test/${assetId}/${action}`,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    mimeType: action === "poster" ? "image/jpeg" : "video/mp4",
    disposition: action === "preview" || action === "poster" ? "inline" : "attachment",
    supportsRange: true,
  };
}

beforeEach(() => {
  clearMediaSessionCache();
  vi.clearAllMocks();
  installMediaFeedbackFetch();
  other.current = second;
  vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [asset, second], nextCursor: null, hasMore: false, total: 2 });
  listFavoriteStates.mockImplementation(async (_token: string, refs: MediaFavoriteRef[]) => ({ success: true, states: refs.map(ref => ({ ref, favorite: false })) }));
  vi.mocked(createSourceMediaRead).mockImplementation(async (_token, _sourceId, assetId, action) => mediaRead(action, assetId));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("video delete intent", () => {
  it("does not reopen the delete confirmation when stepping back to the opening video", async () => {
    const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary userId="staff" source={source} getIdToken={getIdToken} /> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    const open = await screen.findByRole("button", { name: /^News update, video/ });
    fireEvent.keyDown(open, { key: "F10", shiftKey: true });
    fireEvent.click(within(screen.getByRole("menu", { name: "News update" })).getByRole("menuitem", { name: "Delete from library" }));
    await screen.findByRole("group", { name: "Confirm video deletion" });
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    await screen.findByLabelText("Preview Weather brief");
    fireEvent.click(screen.getByRole("button", { name: "Previous file" }));
    await screen.findByLabelText("Preview News update");
    expect(screen.queryByRole("group", { name: "Confirm video deletion" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next file" })).toHaveFocus());
  });

  it("returns focus to the meaning-search result when the viewer closes without stepping", async () => {
    const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary userId="staff" source={source} getIdToken={getIdToken} /> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: /^Weather brief, video/ });
    const related = screen.getByRole("button", { name: "Open related result" });
    related.focus();
    fireEvent.click(related);
    await screen.findByLabelText("Preview Weather brief");
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(related).toHaveFocus());
  });

  it("returns focus to search after saving an off-page video from meaning search", async () => {
    vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [asset], nextCursor: null, hasMore: false, total: 1 });
    vi.mocked(updateSourceMediaMetadata).mockResolvedValue({ success: true, asset: { ...second, name: "Revised weather brief", version: 2 } });
    const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary userId="staff" source={{ ...source, canEditMetadata: true }} getIdToken={getIdToken} /> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("button", { name: /^News update, video/ });
    const related = screen.getByRole("button", { name: "Open related result" });
    related.focus();
    fireEvent.click(related);
    await screen.findByLabelText("Preview Weather brief");
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Revised weather brief" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await screen.findByText("Video details saved.");
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Close" })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(listSourceMedia).toHaveBeenCalledTimes(2));
    // The saved edit reloads meaning search on close, which replaces the result that opened the viewer.
    await waitFor(() => expect(screen.getByRole("searchbox", { name: /Search video names/ })).toHaveFocus());
    expect(related.isConnected).toBe(false);
    expect(screen.queryByText(/no longer matches this view/)).toBeNull();
  });

  it("does not carry a card menu's delete intent into a later meaning-search open", async () => {
    const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary userId="staff" source={source} getIdToken={getIdToken} /> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    const open = await screen.findByRole("button", { name: /^News update, video/ });
    fireEvent.keyDown(open, { key: "F10", shiftKey: true });
    fireEvent.click(within(screen.getByRole("menu", { name: "News update" })).getByRole("menuitem", { name: "Delete from library" }));
    const first = await screen.findByRole("dialog", { name: "News update" });
    await waitFor(() => expect(screen.getByRole("group", { name: "Confirm video deletion" })).toHaveFocus());
    const closeButtons = within(first).getAllByRole("button", { name: /^Close/ });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "News update" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open related result" }));
    expect(await screen.findByRole("dialog", { name: "Weather brief" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Confirm video deletion" })).toBeNull();
  });
});
