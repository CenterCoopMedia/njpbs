import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const firestoreIndexes = JSON.parse(readFileSync(
  new URL("../../firestore.indexes.json", import.meta.url),
  "utf8",
));

describe("voiceover media migration indexes", () => {
  it("preserves production collection indexes and the rollback collection-group index", () => {
    // Production field preservation receipt, 2026-10-05; issue 2575.
    expect(firestoreIndexes.fieldOverrides).toContainEqual({
      collectionGroup: "items",
      fieldPath: "voiceoverMigration.id",
      indexes: [
        { order: "ASCENDING", queryScope: "COLLECTION" },
        { order: "DESCENDING", queryScope: "COLLECTION" },
        { arrayConfig: "CONTAINS", queryScope: "COLLECTION" },
        { order: "ASCENDING", queryScope: "COLLECTION_GROUP" },
      ],
    });
  });
});
