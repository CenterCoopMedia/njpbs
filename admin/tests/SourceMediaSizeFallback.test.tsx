import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SourceMediaLibrary } from "../src/routes/SourceMediaLibrary";

const asset = {
  id: "asset-1", sourceId: "video-library", name: "County interview", originalName: "county.mp4",
  description: null, mimeType: "video/mp4", kind: "video", sizeBytes: 10485760, preview: "browser",
  tags: ["County"], rightsStatus: "pending", version: 1, license: null, credit: null,
  createdAt: "2026-09-15T12:00:00.000Z", updatedAt: "2026-09-15T12:00:00.000Z",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each(["size_desc", "size_asc"])("loads videos and preserves filters when %s is not ready", async sort => {
  const requests: Record<string, unknown>[] = [];
  let sizeReady = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).split("/").at(-1);
    if (endpoint === "cmsListSourceMedia") {
      const query = JSON.parse(String(init?.body));
      requests.push(query);
      const page = { success: true, records: [asset], total: null, nextCursor: "next-update-page", hasMore: true };
      return new Response(JSON.stringify({ ...page, ...(!sizeReady && query.sort?.startsWith("size_") ? { sortFallback: "updated_desc" } : {}) }));
    }
    if (endpoint === "cmsListMediaFavorites") return new Response(JSON.stringify({ success: true, favorites: [], states: [], records: [], nextCursor: null }));
    throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
  }));
  const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary
    userId="staff" source={{ id: "video-library", label: "Videos", description: "Synthetic videos", mediaKind: "video", canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: false }}
    getIdToken={async () => "fixture-token"} /> }], { initialEntries: [`/media?sort=${sort}&tag=County&limit=48`] });
  await act(async () => { render(<RouterProvider router={router} />); });
  expect(screen.getByText("File-size sorting is getting ready")).toBeInTheDocument();
  await waitFor(() => expect(router.state.location.search).toBe("?tag=County&limit=48"));
  expect(await screen.findByRole("button", { name: "Sort: Recently updated, newest first" })).toBeInTheDocument();
  expect(await screen.findByText("County interview")).toBeInTheDocument();
  expect(screen.queryByText("Video library unavailable")).not.toBeInTheDocument();
  expect(requests.at(-1)).toMatchObject({ sourceId: "video-library", tag: "County", limit: 48 });
  expect(requests.at(-1)?.sort).toBeUndefined();
  expect(requests.at(-1)?.cursor).toBeUndefined();
  expect(screen.getByText("File-size sorting is getting ready")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(requests.at(-1)?.cursor).toBe("next-update-page"));
  expect(requests.at(-1)?.sort).toBeUndefined();
  sizeReady = true;
  fireEvent.click(screen.getByRole("button", { name: "Sort: Recently updated, newest first" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Sort" })).getByRole("radio", { name: "File size" }));
  await waitFor(() => expect(requests.at(-1)).toMatchObject({ sort: "size_desc", tag: "County", limit: 48 }));
  expect(requests.at(-1)?.cursor).toBeUndefined();
  expect(screen.getByRole("button", { name: "Sort: File size, largest first" })).toBeInTheDocument();
  expect(screen.queryByText("File-size sorting is getting ready")).not.toBeInTheDocument();
});

it("keeps the current video selection when a delayed fallback changes the sort", async () => {
  let finishSize!: (response: Response) => void;
  const pendingSize = new Promise<Response>(resolve => { finishSize = resolve; });
  let sizeRequested = false;
  const page = { success: true, records: [asset], total: 1, nextCursor: null, hasMore: false };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input).split("/").at(-1);
    if (endpoint === "cmsListSourceMedia") {
      const query = JSON.parse(String(init?.body));
      if (query.assetId) return new Response(JSON.stringify({ ...page, records: [] }));
      if (query.sort === "size_desc") { sizeRequested = true; return pendingSize; }
      return new Response(JSON.stringify(page));
    }
    if (endpoint === "cmsListMediaFavorites") return new Response(JSON.stringify({ success: true, states: [] }));
    throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
  }));
  const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary
    userId="staff" source={{ id: "video-library", label: "Videos", description: "Synthetic videos", mediaKind: "video", canBrowse: true, canUpload: false, canEditMetadata: false, canRequestProduction: false }}
    getIdToken={async () => "fixture-token"} /> }], { initialEntries: ["/media?sort=size_desc&asset=closed-video&t=12"] });
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(sizeRequested).toBe(true));
  await act(async () => { await router.navigate("/media?sort=size_desc"); });
  await act(async () => { finishSize(new Response(JSON.stringify({ ...page, sortFallback: "updated_desc" }))); });
  await screen.findByText("File-size sorting is getting ready");
  await waitFor(() => expect(router.state.location.search).toBe(""));
});
