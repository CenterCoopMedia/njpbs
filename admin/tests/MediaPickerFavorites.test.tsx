import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPickerDialog } from "../src/components/MediaPickerDialog";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import type { MediaAssetSummary } from "../src/lib/functions";
import type { MediaFavoriteRef } from "../src/lib/media-favorites";

const mocks = vi.hoisted(() => ({
  listStates: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../src/lib/media-favorites", () => ({
  listMediaFavoriteStates: (...args: unknown[]) => mocks.listStates(...args),
  setMediaFavorite: (...args: unknown[]) => mocks.set(...args),
}));

const assets: MediaAssetSummary[] = ["one", "two"].map((id, index) => ({
  id,
  name: `Image ${index + 1}`,
  originalName: `${id}.png`,
  category: "news",
  categories: ["news"],
  tags: [],
  description: null,
  altText: null,
  license: "NJ PBS owned",
  credit: null,
  mimeType: "image/png",
  kind: "image" as const,
  sizeBytes: 1_024,
  width: 640,
  height: 360,
  url: `https://media.example.test/${id}.png`,
  source: "upload" as const,
  lifecycle: "active" as const,
  version: 1,
  etag: `"media.${id}.1"`,
  createdAt: "2026-09-22T12:00:00.000Z",
  createdBy: "user-a",
  updatedAt: "2026-09-22T12:00:00.000Z",
  updatedBy: "user-a",
}));

const shell: ShellData = {
  principal: { id: "user-a", grants: [{ role: "super_admin" }] },
  user: { uid: "user-a", email: "editor@example.org", displayName: "Editor" } as ShellData["user"],
  userDoc: null,
  signOut: vi.fn(),
  getIdToken: async () => "user-a-token",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listStates.mockImplementation(async (_token: string, refs: MediaFavoriteRef[]) => ({
    success: true,
    states: refs.map(ref => ({ ref, favorite: false })),
  }));
  mocks.set.mockImplementation(async (_token: string, ref: MediaFavoriteRef, favorite: boolean) => ({
    success: true, ref, favorite, changed: true,
  }));
});

describe("MediaPickerDialog favorites", () => {
  it("uses one page projection and stars without selecting the image", async () => {
    const onSelect = vi.fn();
    render(<ShellProvider value={shell}>
      <MediaPickerDialog
        currentAssetId=""
        loadMedia={async () => ({
          success: true,
          records: assets,
          total: 2,
          allCount: 2,
          page: 1,
          pageCount: 1,
          categoryCounts: { news: 2 },
          kindCounts: { image: 2, document: 0 },
        })}
        onClose={() => undefined}
        onSelect={onSelect}
      />
    </ShellProvider>);

    const favorite = await screen.findByRole("button", { name: "Add to favorites: Image 1" });
    expect(mocks.listStates).toHaveBeenCalledTimes(1);
    expect(mocks.listStates).toHaveBeenCalledWith("user-a-token", [
      { backend: "r2", id: "one" },
      { backend: "r2", id: "two" },
    ]);

    fireEvent.click(favorite);
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith(
      "user-a-token",
      { backend: "r2", id: "one" },
      true,
    ));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Choose an image" })).toBeInTheDocument();
  });
});
