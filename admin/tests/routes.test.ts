import { describe, expect, it } from "vitest";
import { createRecordPath, editPagePath, editRecordPath, keepsEditorMounted, parseContentPath, recordListPath } from "../src/lib/routes";
import { RECORD_KINDS } from "../src/lib/content-vocab";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";

describe("routes path builders", () => {
  it("addresses a record by its immutable id, never a slug", () => {
    expect(editRecordPath("program", "prog-123")).toBe("/content/program/prog-123/edit");
  });

  it("encodes a record id so a reserved character cannot break the path", () => {
    expect(editRecordPath("program", "a/b?c")).toBe("/content/program/a%2Fb%3Fc/edit");
  });

});

describe("parseContentPath", () => {
  it("routes nowhere for a retired type (#1039, #1227)", () => {
    // Retired create, list, and edit paths must all fall through to
    // not-found, so a bookmark or a stale link cannot reopen the removed flow.
    for (const kind of ["article", "staff"]) {
      expect(parseContentPath(`/content/${kind}/+`)).toEqual({ kind: "not-found" });
      expect(parseContentPath(`/content/${kind}`)).toEqual({ kind: "not-found" });
      expect(parseContentPath(`/content/${kind}/rec-1/edit`)).toEqual({
        kind: "not-found",
      });
    }
    expect(keepsEditorMounted("/content/article/+")).toBe(false);
    expect(keepsEditorMounted("/content/staff/+")).toBe(false);
  });

  it("rejects a create path for an unknown type", () => {
    expect(parseContentPath("/content/widget/+")).toEqual({ kind: "not-found" });
  });

  it("rejects unknown and legacy template-singleton page addresses", () => {
    expect(parseContentPath("/content/pages/mystery/edit")).toEqual({ kind: "not-found" });
    expect(parseContentPath("/content/pages/genericPage/edit")).toEqual({
      kind: "not-found",
    });
    expect(parseContentPath("/content/pages/programLanding/edit")).toEqual({
      kind: "not-found",
    });
  });

  it("treats an empty or plus-only record id as not found", () => {
    expect(parseContentPath("/content/post//edit")).toEqual({ kind: "not-found" });
    expect(parseContentPath("/content/post/+/edit")).toEqual({ kind: "not-found" });
  });

  it("returns not-found for anything outside a known content shape", () => {
    expect(parseContentPath("/content/widget")).toEqual({ kind: "not-found" });
    expect(parseContentPath("/content/a/b/c/d")).toEqual({ kind: "not-found" });
    expect(parseContentPath("/dashboard")).toEqual({ kind: "not-found" });
  });

  it("degrades a malformed escape sequence to not-found rather than throwing", () => {
    expect(() => parseContentPath("/content/%E0%A4%A/+")).not.toThrow();
  });
});

describe("route vocabularies round-trip through the parser", () => {
  it("parses every record kind's create path back to that kind", () => {
    for (const kind of RECORD_KINDS) {
      expect(parseContentPath(createRecordPath(kind))).toEqual({
        kind: "create-record",
        type: kind,
      });
    }
  });

  it("parses every record kind's list path back to that kind", () => {
    for (const kind of RECORD_KINDS) {
      expect(parseContentPath(recordListPath(kind))).toEqual({
        kind: "record-list",
        type: kind,
      });
    }
  });

  it("parses every canonical page's edit path back to its public id", () => {
    for (const page of PUBLIC_PAGES) {
      expect(parseContentPath(editPagePath(page.id))).toEqual({
        kind: "edit-page",
        pageId: page.id,
      });
    }
  });

});

