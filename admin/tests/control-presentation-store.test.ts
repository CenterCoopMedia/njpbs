import { beforeEach, describe, expect, it, vi } from "vitest";

const firestoreMocks = vi.hoisted(() => ({
  db: { name: "test-db" },
  doc: vi.fn((database: unknown, collection: string, id: string) => ({
    database,
    collection,
    id,
  })),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
}));

vi.mock("firebase/firestore", () => ({
  doc: firestoreMocks.doc,
  setDoc: firestoreMocks.setDoc,
  updateDoc: firestoreMocks.updateDoc,
}));

vi.mock("../src/lib/firebase", () => ({ db: firestoreMocks.db }));

import { saveControlPresentation } from "../src/lib/control-presentation-store";

describe("control presentation store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates only the approved dotted profile field", async () => {
    firestoreMocks.updateDoc.mockResolvedValue(undefined);

    await expect(saveControlPresentation("editor-1", "icons")).resolves.toBeUndefined();

    expect(firestoreMocks.doc).toHaveBeenCalledWith(
      firestoreMocks.db,
      "users",
      "editor-1",
    );
    expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
      {
        database: firestoreMocks.db,
        collection: "users",
        id: "editor-1",
      },
      { "preferences.display.controlPresentation": "icons" },
    );
    expect(firestoreMocks.setDoc).not.toHaveBeenCalled();
  });

  it("masks backend details with a safe account message", async () => {
    firestoreMocks.updateDoc.mockRejectedValue(new Error("backend details"));

    await expect(saveControlPresentation("editor-1", "text")).rejects.toThrow(
      "Your display preference could not be stored. Try again.",
    );
  });

  it("does not create a missing profile after the approved update fails", async () => {
    firestoreMocks.updateDoc.mockRejectedValue(
      Object.assign(new Error("profile missing"), { code: "not-found" }),
    );

    await expect(saveControlPresentation("editor-1", "icons")).rejects.toThrow(
      "Your display preference could not be stored. Try again.",
    );
    expect(firestoreMocks.setDoc).not.toHaveBeenCalled();
  });
});
