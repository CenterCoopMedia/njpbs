import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaSearchAll } from "../src/components/media/MediaSearchAll";
import { HttpError, type MediaAssetSummary } from "../src/lib/functions";
import type { Principal } from "../../packages/content-core/src/rbac";

const mocks = vi.hoisted(() => ({ list: vi.fn(), search: vi.fn() }));

vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsListMedia: mocks.list,
}));
vi.mock("../src/lib/source-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/source-media")>()),
  searchMedia: mocks.search,
}));

const editor: Principal = { id: "editor-1", grants: [{ role: "editor", sections: ["news"], registeredMediaSections: ["news"] }] };
const staff: Principal = { id: "staff-1", grants: [{ role: "staff" }] };

function asset(id: string, name: string, kind: MediaAssetSummary["kind"]): MediaAssetSummary {
  return {
    id, name, kind, originalName: `${id}.bin`, category: "general", categories: ["general"], tags: [],
    description: null, altText: null, license: null, credit: null, mimeType: kind === "audio" ? "audio/wav" : "image/png",
    sizeBytes: 10, width: null, height: null, url: `https://media.example.org/${id}.png`,
    thumbnails: kind === "image" ? [{ url: `https://media.example.org/${id}-thumb.webp`, width: 64, height: 64 }] : undefined,
    lifecycle: "active", version: 1, etag: "e", createdAt: null, createdBy: null, updatedAt: null, updatedBy: null,
  };
}

function libraryResponse(records: MediaAssetSummary[]) {
  return { success: true, records, page: 1, paging: "cursor", nextCursor: null };
}

function renderStrip(principal: Principal = editor, query = "harbor") {
  return render(
    <MemoryRouter>
      <MediaSearchAll getIdToken={async () => "token"} principal={principal} query={query} />
    </MemoryRouter>,
  );
}

function group(name: string) {
  return screen.getByRole("group", { name });
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.search.mockReset();
  mocks.list.mockImplementation(async (_token: string, body: { kinds: string[] }) => libraryResponse(body.kinds.includes("audio")
    ? [asset("take-1", "Harbor narration", "audio")]
    : [asset("img-1", "Harbor at dawn", "image"), asset("doc-1", "Harbor map", "document")]));
  mocks.search.mockResolvedValue({
    success: true, nextCursor: null, sources: [],
    records: [
      { id: "vid-1", sourceId: "video-library", kind: "video", name: "Dusk harbor" },
      { id: "vid-2", sourceId: "archive-working", kind: "video", name: "Harbor b-roll" },
    ],
  });
});

describe("MediaSearchAll", () => {
  it("shows bounded hits for each kind with links that open the item on its own tab", async () => {
    renderStrip();
    expect(screen.getByRole("heading", { name: "All media" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Harbor at dawn/ })).toHaveAttribute("href", "/media/images?q=harbor&selected=img-1");
    expect(screen.getByRole("link", { name: /Harbor map/ })).toHaveAttribute("href", "/media/images?q=harbor&selected=doc-1");
    expect(await screen.findByRole("link", { name: /Dusk harbor/ })).toHaveAttribute("href", "/media/videos?q=harbor&asset=vid-1");
    expect(screen.getByRole("link", { name: /Harbor b-roll/ })).toHaveAttribute("href", "/media/videos/archive-working?q=harbor&asset=vid-2");
    expect(await screen.findByRole("link", { name: /Harbor narration/ })).toHaveAttribute("href", "/media/voiceovers?q=harbor&selected=take-1");
    expect(within(group("Images")).getByRole("link", { name: /Harbor at dawn/ }).querySelector("img"))
      .toHaveAttribute("src", "https://media.example.org/img-1-thumb.webp");
    expect(within(group("Videos")).getAllByRole("listitem")).toHaveLength(2);

    expect(mocks.list).toHaveBeenCalledWith("token", expect.objectContaining({ q: "harbor", kinds: ["image", "document"], pageSize: 5 }), expect.any(AbortSignal));
    expect(mocks.list).toHaveBeenCalledWith("token", expect.objectContaining({ q: "harbor", kinds: ["audio"], pageSize: 5 }), expect.any(AbortSignal));
    expect(mocks.search).toHaveBeenCalledWith("token", { q: "harbor", limit: 5 }, expect.any(AbortSignal));
  });

  it("filters to one kind", async () => {
    renderStrip();
    await screen.findByRole("link", { name: /Dusk harbor/ });
    fireEvent.click(screen.getByRole("radio", { name: "Videos" }));
    expect(screen.getByRole("radio", { name: "Videos" })).toBeChecked();
    expect(screen.queryByRole("group", { name: "Images" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Audio" })).not.toBeInTheDocument();
    expect(group("Videos")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    expect(group("Images")).toBeInTheDocument();
  });

  it("shows a plain message for a kind that fails and keeps the others", async () => {
    mocks.list.mockImplementation(async (_token: string, body: { kinds: string[] }) => {
      if (body.kinds.includes("audio")) throw new HttpError(500, "Server error");
      return libraryResponse([asset("img-1", "Harbor at dawn", "image")]);
    });
    renderStrip();
    expect(await within(group("Audio")).findByRole("alert")).toHaveTextContent("Audio could not be searched. Try again later.");
    expect(await screen.findByRole("link", { name: /Harbor at dawn/ })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /Dusk harbor/ })).toBeInTheDocument();
  });

  it("hides Videos when no video source is visible and Images without media library access", async () => {
    mocks.search.mockRejectedValue(new HttpError(403, "You do not have permission to search media."));
    renderStrip(staff);
    expect(await screen.findByRole("link", { name: /Harbor narration/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Videos" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Images" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("shows an empty message per kind and renders nothing without a search", async () => {
    mocks.search.mockResolvedValue({ success: true, records: [], sources: [], nextCursor: null });
    renderStrip();
    expect(await within(group("Videos")).findByText("No videos match.")).toBeInTheDocument();
    const { container } = renderStrip(editor, "  ");
    expect(container).toBeEmptyDOMElement();
  });
});
