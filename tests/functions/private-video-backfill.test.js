import { describe, expect, it } from "vitest";
import { fakeFirestore } from "../helpers/master-cleanup-firestore.js";
import { argumentsFor, backfillPage } from "../../scripts/backfill-private-video-copies.mjs";

const source = { id: "video-library", bucket: "originals" };
describe("bounded private delivery inventory", () => {
  it("defaults to dry run and refuses unbounded work", () => {
    expect(argumentsFor([])).toEqual({ apply: false, pages: 1 });
    expect(argumentsFor(["--apply", "--pages", "99"])).toEqual({ apply: true, pages: 99 });
    expect(() => argumentsFor(["--pages", "100"])).toThrow("Invalid arguments");
  });
  it("counts missing viewing copies and inactive records without writing in dry run", async () => {
    const { firestore, rows, queries } = fakeFirestore();
    for (let index = 0; index < 51; index++) rows.set(`mediaSourceAssets/asset-${String(index).padStart(3, "0")}`,
      { sourceId: "video-library", lifecycle: index === 0 ? "deleted" : "active" });
    const before = structuredClone([...rows]);
    expect(await backfillPage({ firestore, source, documentId: "__name__" })).toMatchObject({ scanned: 50, missingViewingCopy: 49,
      inactiveOrOtherSource: 1, complete: false, apply: false });
    expect([...rows]).toEqual(before);
    expect(queries.every(query => query.cap === 50)).toBe(true);
  });
  it("saves and resumes a bounded inventory cursor including assets without a ready copy", async () => {
    const { firestore, rows } = fakeFirestore();
    for (let index = 0; index < 51; index++) rows.set(`mediaSourceAssets/asset-${String(index).padStart(3, "0")}`,
      { sourceId: "video-library", lifecycle: "active" });
    const args = { firestore, source, documentId: "__name__", apply: true };
    expect(await backfillPage(args)).toMatchObject({ scanned: 50, complete: false });
    expect(await backfillPage(args)).toMatchObject({ scanned: 1, complete: true });
    expect(rows.get("mediaSourceImportCheckpoints/private-video-v1").counts.scanned).toBe(51);
  });
});
