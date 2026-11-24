import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MEDIA_COLLECTION_PINS,
  MEDIA_COLLECTION_PINS_VERSION,
  parseMediaCollectionPins,
  setMediaCollectionPinned,
  type MediaCollectionPins,
} from "../src/lib/media-collection-pins";

const firestoreMocks = vi.hoisted(() => ({
  db: { name: "test-db" },
  doc: vi.fn((database: unknown, collection: string, id: string) => ({ database, collection, id })),
  getDocFromServer: vi.fn(),
  deleteField: Symbol("deleteField"),
  transactionGet: vi.fn(),
  transactionSet: vi.fn(),
  transactionUpdate: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  doc: firestoreMocks.doc,
  getDocFromServer: firestoreMocks.getDocFromServer,
  deleteField: () => firestoreMocks.deleteField,
  runTransaction: firestoreMocks.runTransaction,
}));
vi.mock("../src/lib/firebase", () => ({ db: firestoreMocks.db }));

import { loadMediaCollectionPins, saveMediaCollectionPin } from "../src/lib/media-collection-pins-store";

const id = (digit: string) => digit.repeat(64);
const missing = { exists: () => false, data: () => undefined };
const pinList = (...ids: string[]): MediaCollectionPins => ({ version: MEDIA_COLLECTION_PINS_VERSION, ids });
const privateSnapshot = (ids: string[]) => ({ exists: () => true, data: () => pinList(...ids) });
const profileSnapshot = (ids?: string[]) => ({
  exists: () => true,
  data: () => ids ? { preferences: { mediaCollectionPins: pinList(...ids) } } : {},
  get: () => ids ? pinList(...ids) : undefined,
});

describe("media collection pins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.runTransaction.mockImplementation(async (_database, update) => update({
      get: firestoreMocks.transactionGet,
      set: firestoreMocks.transactionSet,
      update: firestoreMocks.transactionUpdate,
    }));
    firestoreMocks.transactionGet.mockImplementation(async ({ collection }) =>
      collection === "users" ? profileSnapshot() : missing);
  });

  it("accepts only the current bounded record and removes duplicates", () => {
    expect(parseMediaCollectionPins(null)).toEqual({ version: MEDIA_COLLECTION_PINS_VERSION, ids: [] });
    expect(parseMediaCollectionPins({ version: 9, ids: [id("a")] })).toEqual({ version: 1, ids: [] });
    expect(parseMediaCollectionPins({
      version: 1,
      ids: [id("a"), "not-a-collection", id("a"), ...Array.from({ length: 25 }, (_, index) => index.toString(16).padStart(64, "0"))],
    }).ids).toHaveLength(MAX_MEDIA_COLLECTION_PINS);
  });

  it("moves a newly pinned collection to the front and removes unpinned collections", () => {
    const first = id("a");
    const second = id("b");
    const stored = pinList(first);
    expect(setMediaCollectionPinned(stored, second, true).ids).toEqual([second, first]);
    expect(setMediaCollectionPinned(stored, first, false).ids).toEqual([]);
  });

  it("uses the private document first and reads the legacy profile only if it is absent", async () => {
    const privateId = id("a");
    const legacyId = id("b");
    const profile = profileSnapshot([legacyId]).data();
    firestoreMocks.getDocFromServer.mockResolvedValueOnce(privateSnapshot([privateId]));
    await expect(loadMediaCollectionPins("editor-1", profile)).resolves.toEqual(pinList(privateId));
    expect(firestoreMocks.getDocFromServer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ collection: "mediaCollectionPins", id: "editor-1" }),
    );

    firestoreMocks.getDocFromServer.mockResolvedValueOnce(missing);
    await expect(loadMediaCollectionPins("editor-1", profile)).resolves.toEqual(pinList(legacyId));
  });

  it("writes new pins only to the owner's private document", async () => {
    const collectionId = id("a");
    const pins = await saveMediaCollectionPin("editor-1", collectionId, true);
    expect(pins).toEqual({ version: MEDIA_COLLECTION_PINS_VERSION, ids: [collectionId] });
    expect(firestoreMocks.transactionSet).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "mediaCollectionPins", id: "editor-1" }),
      pins,
    );
    expect(firestoreMocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it("migrates the current legacy list and deletes only the legacy field in the same transaction", async () => {
    const existing = id("a");
    const added = id("b");
    firestoreMocks.transactionGet.mockResolvedValueOnce(missing).mockResolvedValueOnce(profileSnapshot([existing]));
    await expect(saveMediaCollectionPin("editor-1", added, true)).resolves.toEqual(pinList(added, existing));
    expect(firestoreMocks.transactionSet).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "mediaCollectionPins", id: "editor-1" }), pinList(added, existing),
    );
    expect(firestoreMocks.transactionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "users", id: "editor-1" }),
      "preferences.mediaCollectionPins", firestoreMocks.deleteField,
    );
  });

  it("applies the change to the latest private list read in the transaction", async () => {
    const existing = id("a");
    const added = id("b");
    firestoreMocks.transactionGet.mockResolvedValueOnce(privateSnapshot([existing]));
    await expect(saveMediaCollectionPin("editor-1", added, true)).resolves.toEqual(pinList(added, existing));
  });

  it("does not recreate a missing profile or expose backend details", async () => {
    firestoreMocks.transactionGet.mockResolvedValueOnce(missing).mockResolvedValueOnce(missing);
    await expect(saveMediaCollectionPin("missing", id("a"), false))
      .rejects.toThrow("Your collection pin could not be saved. Try again.");
    expect(firestoreMocks.transactionSet).not.toHaveBeenCalled();

    firestoreMocks.runTransaction.mockRejectedValueOnce(new Error("PERMISSION_DENIED: users/editor-1"));
    await expect(saveMediaCollectionPin("editor-1", id("a"), false))
      .rejects.toThrow("Your collection pin could not be saved. Try again.");
  });
});
