import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MEDIA_COLLECTION_PINS,
  MEDIA_COLLECTION_PINS_VERSION,
  parseMediaCollectionPins,
  readMediaCollectionPins,
  setMediaCollectionPinned,
} from "../src/lib/media-collection-pins";

const firestoreMocks = vi.hoisted(() => ({
  db: { name: "test-db" },
  doc: vi.fn((database: unknown, collection: string, id: string) => ({ database, collection, id })),
  transactionGet: vi.fn(),
  transactionSet: vi.fn(),
  runTransaction: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  doc: firestoreMocks.doc,
  runTransaction: firestoreMocks.runTransaction,
}));
vi.mock("../src/lib/firebase", () => ({ db: firestoreMocks.db }));

import { saveMediaCollectionPin } from "../src/lib/media-collection-pins-store";

const id = (digit: string) => digit.repeat(64);

describe("media collection pins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    firestoreMocks.runTransaction.mockImplementation(async (_database, update) => update({
      get: firestoreMocks.transactionGet,
      set: firestoreMocks.transactionSet,
    }));
    firestoreMocks.transactionGet.mockResolvedValue({ exists: () => true, data: () => ({}) });
  });

  it("accepts only the current bounded record and removes duplicates", () => {
    expect(parseMediaCollectionPins(null)).toEqual({ version: MEDIA_COLLECTION_PINS_VERSION, ids: [] });
    expect(parseMediaCollectionPins({ version: 9, ids: [id("a")] })).toEqual({ version: 1, ids: [] });
    expect(parseMediaCollectionPins({
      version: 1,
      ids: [id("a"), "not-a-collection", id("a"), ...Array.from({ length: 25 }, (_, index) => index.toString(16).padStart(64, "0"))],
    }).ids).toHaveLength(MAX_MEDIA_COLLECTION_PINS);
  });

  it("reads the account field and moves a newly pinned collection to the front", () => {
    const first = id("a");
    const second = id("b");
    const stored = readMediaCollectionPins({ preferences: { mediaCollectionPins: { version: 1, ids: [first] } } });
    expect(setMediaCollectionPinned(stored, second, true).ids).toEqual([second, first]);
    expect(setMediaCollectionPinned(stored, first, false).ids).toEqual([]);
  });

  it("writes only the collection pin field on the signed-in profile", async () => {
    const collectionId = id("a");
    const pins = await saveMediaCollectionPin("editor-1", collectionId, true);
    expect(pins).toEqual({ version: MEDIA_COLLECTION_PINS_VERSION, ids: [collectionId] });
    expect(firestoreMocks.doc).toHaveBeenCalledWith(firestoreMocks.db, "users", "editor-1");
    expect(firestoreMocks.transactionSet).toHaveBeenCalledWith(
      expect.anything(),
      { preferences: { mediaCollectionPins: pins } },
      { mergeFields: ["preferences.mediaCollectionPins"] },
    );
  });

  it("applies a pin change to the latest profile value inside the transaction", async () => {
    const existing = id("a");
    const added = id("b");
    firestoreMocks.transactionGet.mockResolvedValueOnce({
      exists: () => true,
      data: () => ({ preferences: { mediaCollectionPins: { version: 1, ids: [existing] } } }),
    });

    await expect(saveMediaCollectionPin("editor-1", added, true)).resolves.toEqual({
      version: 1,
      ids: [added, existing],
    });
  });

  it("does not recreate a missing profile or expose backend details", async () => {
    firestoreMocks.transactionGet.mockResolvedValueOnce({ exists: () => false, data: () => ({}) });
    await expect(saveMediaCollectionPin("missing", id("a"), false))
      .rejects.toThrow("Your collection pin could not be saved. Try again.");
    expect(firestoreMocks.transactionSet).not.toHaveBeenCalled();

    firestoreMocks.runTransaction.mockRejectedValueOnce(new Error("PERMISSION_DENIED: users/editor-1"));
    await expect(saveMediaCollectionPin("editor-1", id("a"), false))
      .rejects.toThrow("Your collection pin could not be saved. Try again.");
  });
});
