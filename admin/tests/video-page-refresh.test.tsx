import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SourceMediaLibrary } from "../src/routes/SourceMediaLibrary";
import { clearMediaSessionCache } from "../src/lib/media-session-cache";
import type { MediaSourceSummary, SourceMediaAssetSummary } from "../src/lib/source-media";

const source: MediaSourceSummary = {
  id: "video-library", label: "Videos", description: "Synthetic videos", mediaKind: "video",
  canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: false,
};
const original: SourceMediaAssetSummary = {
  id: "video-1", sourceId: source.id, name: "County meeting", originalName: "county.mp4", description: null,
  mimeType: "video/mp4", kind: "video", sizeBytes: 1024, preview: "browser", license: null, credit: null,
  tags: [], rightsStatus: "pending", version: 1, createdAt: null, updatedAt: null, fileVersion: "old-file",
};
const replaced: SourceMediaAssetSummary = { ...original, version: 2, fileVersion: "new-file" };

let current: SourceMediaAssetSummary;
let previewReads: number;
let downloadStarted: boolean;
let finishPage: () => void;
let finishDownload: () => void;

const pageOf = (records: SourceMediaAssetSummary[]) =>
  Response.json({ success: true, records, nextCursor: null, hasMore: false, total: records.length });
const readOf = (action: string, fileVersion: string | null | undefined) => Response.json({ success: true, access: {
  assetId: original.id, action, url: `https://media.example.test/${fileVersion}/${action}`, fileVersion,
  expiresAt: new Date(Date.now() + 300_000).toISOString(), mimeType: "video/mp4",
  disposition: action === "preview" ? "inline" : "attachment", supportsRange: true, credit: null,
} });

beforeEach(() => {
  clearMediaSessionCache();
  current = original;
  previewReads = 0;
  downloadStarted = false;
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).split("/").at(-1);
    const body = JSON.parse(String(init?.body));
    if (endpoint === "cmsListSourceMedia") {
      if (body.assetId) return pageOf([current]);
      return new Promise<Response>(resolve => { finishPage = () => resolve(pageOf([current])); });
    }
    if (endpoint === "cmsCreateSourceMediaRead") {
      if (body.action === "preview") previewReads += 1;
      if (body.action !== "download") return readOf(body.action, current.fileVersion);
      downloadStarted = true;
      return new Promise<Response>(resolve => { finishDownload = () => resolve(readOf("download", original.fileVersion)); });
    }
    if (endpoint === "cmsListMediaFavorites") return Response.json({ success: true, favorites: [], states: [], records: [], nextCursor: null });
    if (endpoint === "cmsGetMediaReview") return Response.json({ success: true, review: null });
    if (endpoint === "cmsListMediaComments") return Response.json({ success: true, comments: [], nextCursor: null });
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

const playerSrc = () => screen.getByLabelText<HTMLVideoElement>("Preview County meeting").src;

it("keeps the open file while a download runs when a page load reports a replacement", async () => {
  const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary userId="staff" source={source}
    getIdToken={async () => "fixture-token"} /> }], { initialEntries: ["/media?asset=video-1"] });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(playerSrc()).toBe("https://media.example.test/old-file/preview"));

  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Original video/ }));
  await waitFor(() => expect(downloadStarted).toBe(true));

  // The slow library page lands after the file was replaced elsewhere.
  current = replaced;
  await act(async () => { finishPage(); });
  await screen.findByRole("button", { name: /^County meeting, video/, hidden: true });
  expect(playerSrc()).toBe("https://media.example.test/old-file/preview");
  expect(previewReads).toBe(1);

  // Once the download ends, the next refresh adopts the new file.
  await act(async () => { finishDownload(); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
  expect(playerSrc()).toBe("https://media.example.test/old-file/preview");
  act(() => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(playerSrc()).toBe("https://media.example.test/new-file/preview"));
});
