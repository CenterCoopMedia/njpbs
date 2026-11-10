// The size accounting behind the save boundary's 413 (#531). These pin the
// estimator to Firestore's documented storage-size table rather than to a
// JSON.stringify approximation, because the two disagree in both directions: a
// number is 8 bytes however many digits it prints, and every field name and map
// key costs its own bytes plus a terminator.

import { describe, expect, it } from "vitest";

import documentSizePkg from "../../functions/lib/document-size.js";

const {
  MAX_DOCUMENT_BYTES,
  DOCUMENT_SIZE_BUDGET_BYTES,
  firestoreDocumentBytes,
  documentSizeError,
} = documentSizePkg;

// Every expectation below is relative to an empty document, so these assert the
// per-field rule rather than restating the fixed overhead constants.
const BASE = firestoreDocumentBytes({}, "");

// The one fixed number worth restating here: the storage-size table charges a
// map like a document, so a nested map costs 32 bytes beyond its keys and
// values. Deriving it from the estimator would make these tests agree with
// whatever it already does.
const MAP = 32;

describe("firestoreDocumentBytes", () => {
  it("charges the per-document overhead and the path segments", () => {
    // "cmsPages"+1 + "watch"+1 on top of the fixed overhead
    expect(firestoreDocumentBytes({}, "cmsPages/watch")).toBe(BASE + 9 + 6);
  });

  it("charges a string field as name plus value, each terminated", () => {
    // "title"+1 = 6, "Hello"+1 = 6
    expect(firestoreDocumentBytes({ title: "Hello" })).toBe(BASE + 6 + 6);
  });

  it("charges a number as 8 bytes however long it prints", () => {
    const short = firestoreDocumentBytes({ v: 1 });
    const long = firestoreDocumentBytes({ v: 123456789012 });
    expect(short).toBe(long);
    expect(short).toBe(BASE + 2 + 8);
  });

  it("charges booleans and null as one byte", () => {
    expect(firestoreDocumentBytes({ a: true })).toBe(BASE + 2 + 1);
    expect(firestoreDocumentBytes({ a: null })).toBe(BASE + 2 + 1);
  });

  it("counts multi-byte characters as their UTF-8 length", () => {
    // A single emoji is 4 UTF-8 bytes, not 1 character or 2 UTF-16 units.
    expect(firestoreDocumentBytes({ a: "\u{1F600}" })).toBe(BASE + 2 + 5);
  });

  it("charges an array as the sum of its values, with no per-index key", () => {
    expect(firestoreDocumentBytes({ a: [1, 2, 3] })).toBe(BASE + 2 + 24);
  });

  it("charges a map like a document: its keys and values plus 32", () => {
    // "seo"+1 = 4, the map's own 32, then "title"+1 = 6 and "Hi"+1 = 3
    expect(firestoreDocumentBytes({ seo: { title: "Hi" } })).toBe(
      BASE + 4 + MAP + 6 + 3,
    );
  });

  it("charges the map overhead once per nesting level", () => {
    // The shape the guard exists for: a rich-text block is a tree of small
    // ProseMirror node maps, so the per-map charge is what the estimate lives or
    // dies on, not the text inside it.
    const flat = firestoreDocumentBytes({ a: { b: 1 } });
    const nested = firestoreDocumentBytes({ a: { b: { c: 1 } } });
    // One more level costs its own map overhead plus the "c"+1 key it holds,
    // and drops the "b"-keyed number for the map that replaced it.
    expect(nested - flat).toBe(MAP + 2);
  });

  it("charges a map inside an array, which is every block in a page", () => {
    const empty = firestoreDocumentBytes({ blocks: [] });
    expect(firestoreDocumentBytes({ blocks: [{}, {}] })).toBe(empty + MAP * 2);
  });

  it("charges a timestamp as 8 bytes rather than its internal fields", () => {
    const asDate = firestoreDocumentBytes({ a: new Date(0) });
    const asSentinel = firestoreDocumentBytes({ a: { toDate: () => new Date(0) } });
    expect(asDate).toBe(BASE + 2 + 8);
    expect(asSentinel).toBe(BASE + 2 + 8);
  });

  it("skips an undefined field, which never reaches the write", () => {
    expect(firestoreDocumentBytes({ a: undefined })).toBe(BASE);
    expect(firestoreDocumentBytes({ seo: { a: undefined } })).toBe(BASE + 4 + MAP);
  });

  it("does not throw on a non-object document", () => {
    for (const value of [null, undefined, "text", 7, []]) {
      expect(() => firestoreDocumentBytes(value, "cmsPages/watch")).not.toThrow();
    }
  });
});

describe("documentSizeError", () => {
  const underLimit = { blocks: "x".repeat(1000) };

  it("returns null for a document that fits", () => {
    expect(documentSizeError(underLimit, "cmsPages/watch")).toBeNull();
  });

  it("refuses a document over the budget and says how far over", () => {
    const oversized = { blocks: "x".repeat(MAX_DOCUMENT_BYTES) };
    const error = documentSizeError(oversized, "cmsPages/watch");
    expect(error).not.toBeNull();
    expect(error.detail).toMatch(
      new RegExp(`over the ${DOCUMENT_SIZE_BUDGET_BYTES} budget`),
    );
    expect(error.detail).toMatch(/hard limit is 1048576/);
  });

  it("keeps a reserve under Firestore's hard limit", () => {
    // The reserve is the whole point: the estimate follows the documented table
    // and the real accounting charges more, so a document measuring just under
    // 1 MiB must still be refused rather than sent on to an opaque commit error.
    expect(DOCUMENT_SIZE_BUDGET_BYTES).toBeLessThan(MAX_DOCUMENT_BYTES);
    const justUnderHardLimit = { a: "x".repeat(MAX_DOCUMENT_BYTES - 100) };
    expect(firestoreDocumentBytes(justUnderHardLimit, "")).toBeLessThan(
      MAX_DOCUMENT_BYTES,
    );
    expect(documentSizeError(justUnderHardLimit, "")).not.toBeNull();
  });

  it("tells a publisher that the snapshot is what pushed it over", () => {
    // The editor added nothing on this request, so a message about shortening
    // what they just typed would be wrong. Publishing composed the copy.
    const oversized = { blocks: "x".repeat(MAX_DOCUMENT_BYTES) };
    const saving = documentSizeError(oversized, "cmsPages/watch");
    const publishing = documentSizeError(oversized, "cmsPages/watch", {
      publishing: true,
    });
    expect(saving.reason).toMatch(/could not be saved/);
    expect(publishing.reason).toMatch(/could not be published/);
    expect(publishing.reason).toMatch(/roughly doubles/);
    expect(publishing.detail).toMatch(/with the publish snapshot composed/);
  });

  it("accepts a document exactly at the budget", () => {
    // The boundary is <=, so a document measuring the budget exactly is storable
    // and must not be refused.
    const overheadWithoutValue = firestoreDocumentBytes({ a: "" }, "");
    const document = {
      a: "x".repeat(DOCUMENT_SIZE_BUDGET_BYTES - overheadWithoutValue),
    };
    expect(firestoreDocumentBytes(document, "")).toBe(DOCUMENT_SIZE_BUDGET_BYTES);
    expect(documentSizeError(document, "")).toBeNull();
  });
});
