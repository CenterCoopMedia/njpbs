import { beforeEach, describe, expect, it, vi } from "vitest";

const firestoreMocks = vi.hoisted(() => ({
  db: { name: "test-db" },
  doc: vi.fn((database: unknown, collection: string, id: string) => ({
    database,
    collection,
    id,
  })),
  getDoc: vi.fn(),
  transactionGet: vi.fn(),
  transactionSet: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  doc: firestoreMocks.doc,
  getDoc: firestoreMocks.getDoc,
  runTransaction: firestoreMocks.runTransaction,
}));

vi.mock("../src/lib/firebase", () => ({ db: firestoreMocks.db }));

import {
  loadMediaLibraryViews,
  mutateMediaLibraryViews,
} from "../src/lib/saved-media-view-store";
import {
  SavedMediaViewValidationError,
  type SavedMediaView,
} from "../src/lib/saved-media-views";

describe("saved media view store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.runTransaction.mockImplementation(
      async (_database: unknown, update: (transaction: unknown) => Promise<unknown>) =>
        update({ get: firestoreMocks.transactionGet, set: firestoreMocks.transactionSet }),
    );
  });

  it("loads and validates media views from the signed-in profile", async () => {
    firestoreMocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        preferences: {
          mediaLibraryViews: [
            { id: "news", name: " News ", surface: "images", query: "category=news&page=3" },
            { id: "broken", name: "", surface: "images", query: "" },
          ],
        },
      }),
    });

    await expect(loadMediaLibraryViews("editor-1")).resolves.toEqual([
      { id: "news", name: "News", surface: "images", query: "category=news" },
    ]);
    expect(firestoreMocks.doc).toHaveBeenCalledWith(firestoreMocks.db, "users", "editor-1");
  });

  it("masks profile read failures", async () => {
    firestoreMocks.getDoc.mockRejectedValueOnce(new Error("backend details"));
    await expect(loadMediaLibraryViews("editor-1")).rejects.toThrow(
      "Your saved views could not be loaded.",
    );
  });

  it("applies an add to the newest snapshot and writes only the media view field", async () => {
    firestoreMocks.transactionGet.mockResolvedValue({
      exists: () => true,
      data: () => ({
        role: "editor",
        preferences: {
          density: "compact",
          mediaLibraryViews: [
            { id: "video", name: "Video", surface: "video:archive", query: "tag=News" },
          ],
        },
      }),
    });

    const next: SavedMediaView[] = [
      { id: "video", name: "Video", surface: "video:archive", query: "tag=News" },
      { id: "images", name: "Images", surface: "images", query: "kind=image" },
    ];
    await expect(
      mutateMediaLibraryViews("editor-1", { type: "add", view: next[1] }),
    ).resolves.toEqual(next);
    expect(firestoreMocks.transactionSet).toHaveBeenCalledWith(
      { database: firestoreMocks.db, collection: "users", id: "editor-1" },
      { preferences: { mediaLibraryViews: next } },
      { mergeFields: ["preferences.mediaLibraryViews"] },
    );
  });

  it("refuses a missing profile without creating it", async () => {
    firestoreMocks.transactionGet.mockResolvedValue({ exists: () => false });
    await expect(
      mutateMediaLibraryViews("new-editor", {
        type: "add",
        view: { id: "images", name: "Images", surface: "images", query: "kind=image" },
      }),
    ).rejects.toThrow("Your saved views could not be stored.");
    expect(firestoreMocks.transactionSet).not.toHaveBeenCalled();
  });

  it("preserves safe validation refusals and masks Firestore failures", async () => {
    firestoreMocks.transactionGet.mockResolvedValue({
      exists: () => true,
      data: () => ({
        preferences: {
          mediaLibraryViews: [
            { id: "images", name: "Images", surface: "images", query: "kind=image" },
          ],
        },
      }),
    });
    const duplicate = mutateMediaLibraryViews("editor-1", {
      type: "add",
      view: { id: "other", name: "images", surface: "images", query: "kind=document" },
    });
    await expect(duplicate).rejects.toBeInstanceOf(SavedMediaViewValidationError);
    await expect(duplicate).rejects.toThrow("already exists");

    firestoreMocks.runTransaction.mockRejectedValueOnce(new Error("backend details"));
    await expect(
      mutateMediaLibraryViews("editor-1", { type: "delete", id: "images" }),
    ).rejects.toThrow("Your saved views could not be stored.");
  });
});
