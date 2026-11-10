import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import contract from "../../functions/lib/bug-report-contract.js";

const DECLARED = JSON.parse(
  readFileSync(new URL("../../firestore.indexes.json", import.meta.url), "utf8"),
);

// Every bug report outbox runs the same two consumer queries: a claim that
// reads pending jobs by nextAttemptAt, and a lease recovery that reads sending
// jobs by leaseUntil. Each pairs an equality filter with a range filter on a
// second field, so Firestore rejects both without a composite index.
const CONSUMER_INDEX_FIELDS = [
  ["state", "nextAttemptAt"],
  ["state", "leaseUntil"],
];

const OUTBOX_COLLECTIONS = Object.entries(contract.BUG_REPORT_COLLECTIONS)
  .filter(([key]) => key.endsWith("Outbox"))
  .map(([, collection]) => collection);

function declaresIndex(collection, fieldPaths) {
  return DECLARED.indexes.some(
    (index) =>
      index.collectionGroup === collection &&
      index.queryScope === "COLLECTION" &&
      index.fields.length === fieldPaths.length &&
      index.fields.every(
        (field, position) =>
          field.fieldPath === fieldPaths[position] &&
          field.order === "ASCENDING",
      ),
  );
}

describe("bug report outbox indexes", () => {
  it("declares both consumer indexes for every outbox in the bug report contract", () => {
    expect(OUTBOX_COLLECTIONS.length).toBeGreaterThan(0);
    for (const collection of OUTBOX_COLLECTIONS) {
      const missing = CONSUMER_INDEX_FIELDS.filter(
        fieldPaths => !declaresIndex(collection, fieldPaths),
      ).map(fieldPaths => fieldPaths.join(" then "));
      expect(missing, `${collection}: missing consumer indexes`).toEqual([]);
    }
  });
});
