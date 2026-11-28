import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { indexes } = JSON.parse(readFileSync(new URL("../../firestore.indexes.json", import.meta.url), "utf8"));

describe("Firestore composite indexes", () => {
  // The deploy refuses the whole file when one entry lacks a required key (release run 46084238514).
  it("gives every index a collection group, a query scope and fields", () => {
    const incomplete = indexes
      .map((entry, position) => ({ position, entry }))
      .filter(({ entry }) => typeof entry.collectionGroup !== "string" || !entry.collectionGroup
        || !["COLLECTION", "COLLECTION_GROUP"].includes(entry.queryScope)
        || !Array.isArray(entry.fields) || entry.fields.length === 0);
    expect(incomplete).toEqual([]);
  });
});
