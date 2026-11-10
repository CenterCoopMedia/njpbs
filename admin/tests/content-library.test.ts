import { describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_QUERY } from "../src/lib/content-query";
import { selectLibraryRecords } from "../src/lib/content-library";
import type { ContentRecordSummary } from "../src/lib/content-records";

const records: ContentRecordSummary[] = [
  {
    id: "a-1",
    kind: "article",
    title: "Shore report",
    status: "draft",
    updatedAt: "2026-07-20T15:00:00.000Z",
    updatedBy: "editor-1",
    assignee: "editor-2",
  },
  {
    id: "p-1",
    kind: "program",
    title: "Garden State",
    status: "published",
    updatedAt: "2026-07-20T14:00:00.000Z",
    updatedBy: "editor-2",
    assignee: "editor-1",
  },
  {
    id: "a-2",
    kind: "article",
    title: "Trenton tonight",
    status: "in_review",
    updatedAt: "2026-07-20T13:00:00.000Z",
    updatedBy: "editor-1",
    assignee: "editor-1",
  },
];

describe("selectLibraryRecords", () => {
  it("combines search, type, status, and signed-in ownership filters", () => {
    const result = selectLibraryRecords(
      records,
      {
        ...DEFAULT_CONTENT_QUERY,
        types: ["article"],
        statuses: ["in_review"],
        ownerMode: "me",
        q: "Trenton",
      },
      "editor-1",
    );

    expect(result.records.map((record) => record.id)).toEqual(["a-2"]);
    expect(result.total).toBe(1);
    expect(result.allCount).toBe(3);
    expect(result.mineCount).toBe(2);
  });

  it("counts statuses before applying the status filter", () => {
    const result = selectLibraryRecords(
      records,
      { ...DEFAULT_CONTENT_QUERY, statuses: ["draft"] },
      "editor-1",
    );

    expect(result.records.map((record) => record.id)).toEqual(["a-1"]);
    expect(result.statusCounts).toMatchObject({ draft: 1, in_review: 1, published: 1 });
  });

  it("excludes archived records by default and selects them explicitly", () => {
    const recordsWithArchive: ContentRecordSummary[] = [
      ...records,
      {
        id: "a-archived",
        kind: "article",
        title: "Archived report",
        status: "archived",
        updatedAt: "2026-07-20T16:00:00.000Z",
        updatedBy: "editor-1",
      },
    ];

    const activeResult = selectLibraryRecords(
      recordsWithArchive,
      DEFAULT_CONTENT_QUERY,
      "editor-1",
    );
    const archivedResult = selectLibraryRecords(
      recordsWithArchive,
      { ...DEFAULT_CONTENT_QUERY, statuses: ["archived"] },
      "editor-1",
    );

    expect(activeResult.records.map((record) => record.id)).not.toContain("a-archived");
    expect(activeResult.total).toBe(3);
    expect(activeResult.statusCounts.archived).toBe(1);
    expect(archivedResult.records.map((record) => record.id)).toEqual(["a-archived"]);
  });

  it("filters true assignments independently from the person who last edited", () => {
    const result = selectLibraryRecords(
      records,
      { ...DEFAULT_CONTENT_QUERY, assignmentMode: "me" },
      "editor-1",
    );

    expect(result.records.map((record) => record.id)).toEqual(["p-1", "a-2"]);
    expect(result.assignedCount).toBe(2);
    expect(result.mineCount).toBe(2);
  });

  it("sorts deterministically and clamps paging to a real page", () => {
    const result = selectLibraryRecords(
      records,
      {
        ...DEFAULT_CONTENT_QUERY,
        sortField: "title",
        sortDirection: "asc",
        page: 99,
      },
      undefined,
      2,
    );

    expect(result.page).toBe(2);
    expect(result.pageCount).toBe(2);
    expect(result.records.map((record) => record.title)).toEqual(["Trenton tonight"]);
  });
});
