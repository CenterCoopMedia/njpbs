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
  loadContentLibraryViews,
  mutateContentLibraryViews,
} from "../src/lib/saved-content-view-store";
import { SavedContentViewValidationError } from "../src/lib/saved-content-views";

describe("saved content view store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.runTransaction.mockImplementation(
      async (_database: unknown, update: (transaction: unknown) => Promise<unknown>) =>
        update({
          get: firestoreMocks.transactionGet,
          set: firestoreMocks.transactionSet,
        }),
    );
  });

  it("loads and validates views from the signed-in user's preferences", async () => {
    firestoreMocks.getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        preferences: {
          contentLibraryViews: [
            { id: "drafts", name: " Drafts ", query: "status=draft&page=3&v=1" },
            { id: "broken", name: "", query: "v=1" },
          ],
        },
      }),
    });

    await expect(loadContentLibraryViews("editor-1")).resolves.toEqual([
      { id: "drafts", name: "Drafts", query: "status=draft&v=1" },
    ]);
    expect(firestoreMocks.doc).toHaveBeenCalledWith(
      firestoreMocks.db,
      "users",
      "editor-1",
    );
  });

  it("uses destination-neutral copy when saved views cannot be loaded", async () => {
    firestoreMocks.getDoc.mockRejectedValueOnce(new Error("backend details"));

    await expect(loadContentLibraryViews("editor-1")).rejects.toThrow(
      "Your saved views could not be loaded.",
    );
  });

  it("adds against the latest transaction snapshot and preserves concurrent views", async () => {
    firestoreMocks.transactionGet.mockResolvedValue({
      exists: () => true,
      data: () => ({
        preferences: {
          contentLibraryViews: [
            { id: "review", name: "Review", query: "status=in_review&v=1" },
          ],
        },
      }),
    });

    await expect(
      mutateContentLibraryViews("editor-1", {
        type: "add",
        view: { id: "drafts", name: "Drafts", query: "status=draft&page=8&v=1" },
      }),
    ).resolves.toEqual([
      { id: "review", name: "Review", query: "status=in_review&v=1" },
      { id: "drafts", name: "Drafts", query: "status=draft&v=1" },
    ]);

    expect(firestoreMocks.transactionSet).toHaveBeenCalledWith(
      {
        database: firestoreMocks.db,
        collection: "users",
        id: "editor-1",
      },
      {
        preferences: {
          contentLibraryViews: [
            { id: "review", name: "Review", query: "status=in_review&v=1" },
            { id: "drafts", name: "Drafts", query: "status=draft&v=1" },
          ],
        },
      },
      { mergeFields: ["preferences.contentLibraryViews"] },
    );
  });

  it("refuses to recreate a missing server-owned profile", async () => {
    firestoreMocks.transactionGet.mockResolvedValue({ exists: () => false });

    await expect(
      mutateContentLibraryViews("new-editor", {
        type: "add",
        view: { id: "mine", name: "Mine", query: "owner=me&v=1" },
      }),
    ).rejects.toThrow("Your saved views could not be stored.");
    expect(firestoreMocks.transactionSet).not.toHaveBeenCalled();
  });

  it("preserves safe mutation refusals but masks transaction failures", async () => {
    firestoreMocks.transactionGet.mockResolvedValue({
      exists: () => true,
      data: () => ({
        preferences: {
          contentLibraryViews: [
            { id: "drafts", name: "Drafts", query: "status=draft&v=1" },
          ],
        },
      }),
    });

    const duplicate = mutateContentLibraryViews("editor-1", {
      type: "add",
      view: { id: "other", name: "drafts", query: "status=published&v=1" },
    });
    await expect(duplicate).rejects.toBeInstanceOf(SavedContentViewValidationError);
    await expect(duplicate).rejects.toThrow("already exists");

    firestoreMocks.runTransaction.mockRejectedValueOnce(new Error("backend details"));
    await expect(
      mutateContentLibraryViews("editor-1", { type: "delete", id: "drafts" }),
    ).rejects.toThrow("Your saved views could not be stored.");
  });
});
