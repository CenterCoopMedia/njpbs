import { describe, expect, it } from "vitest";
import serverLibrary from "../../functions/lib/content-library.js";
import {
  DEFAULT_CONTENT_QUERY,
  parseContentQuery as parseBrowserContentQuery,
} from "../../admin/src/lib/content-query";
import { selectLibraryRecords } from "../../admin/src/lib/content-library";
import { contentStatusPresentation } from "../../admin/src/lib/content-status";
import {
  ASSIGNABLE_CONTENT_STATUSES as BROWSER_ASSIGNABLE_CONTENT_STATUSES,
  CONTENT_STATUSES as BROWSER_CONTENT_STATUSES,
  LIBRARY_RECORD_KINDS as BROWSER_LIBRARY_RECORD_KINDS,
  RECORD_KINDS as BROWSER_RECORD_KINDS,
} from "../../admin/src/lib/content-vocab";

const {
  ASSIGNABLE_CONTENT_STATUSES,
  CONTENT_STATUSES,
  CREATABLE_RECORD_KINDS,
  DEFAULT_CONTENT_QUERY: SERVER_DEFAULT_CONTENT_QUERY,
  RECORD_KINDS,
  RETIRED_RECORD_KINDS,
  parseContentQuery: parseServerContentQuery,
  selectContentLibrary,
  contentRecordSummary,
} = serverLibrary;

const records = [
  {
    id: "article-1",
    kind: "article",
    title: "Shore report",
    status: "draft",
    updatedAt: "2026-07-20T15:00:00.000Z",
    updatedBy: "editor-1",
    assignee: "editor-2",
  },
  {
    id: "program-1",
    kind: "program",
    title: "Garden State",
    status: "published",
    updatedAt: "2026-07-20T14:00:00.000Z",
    updatedBy: "editor-2",
    assignee: "editor-1",
  },
  {
    id: "article-2",
    kind: "article",
    title: "Trenton tonight",
    status: "in_review",
    updatedAt: "2026-07-20T13:00:00.000Z",
    updatedBy: "editor-1",
    assignee: "editor-1",
  },
];

describe("content library deployment mirror", () => {
  it.each([
    { name: "both legacy counters absent", contentVersion: undefined, liveContentVersion: undefined, newerDraft: false },
    { name: "published counter absent", contentVersion: 3, liveContentVersion: undefined, newerDraft: false },
    { name: "working counter absent", contentVersion: undefined, liveContentVersion: 2, newerDraft: false },
    { name: "lifecycle-only transaction", contentVersion: 2, liveContentVersion: 2, newerDraft: false },
    { name: "newer saved content", contentVersion: 3, liveContentVersion: 2, newerDraft: true },
  ])("keeps Post list and editor status consistent: $name", ({ contentVersion, liveContentVersion, newerDraft }) => {
    const row = contentRecordSummary("post-legacy", {
      type: "post", title: "Station update", status: "approved", version: 44,
      contentVersion, publiclyVisible: true, publicSourceVersion: 8,
      published: { sourceVersion: 8, contentVersion: liveContentVersion },
    });
    expect(row.version).toBe(44);
    expect(row.liveSourceVersion).toBe(8);
    expect(row.contentVersion).toBe(contentVersion);
    expect(row.publishedContentVersion).toBe(liveContentVersion);
    expect(contentStatusPresentation({ status: row.status, publicState: "live",
      liveLabel: "Published copy live", savedVersion: row.version,
      contentVersion: row.contentVersion, liveContentVersion: row.publishedContentVersion,
    })).toEqual({ label: "Published copy live", tone: "success", newerDraft });
  });

  it("retains other record kinds' existing revision projection", () => {
    expect(contentRecordSummary("program-legacy", {
      type: "program", title: "Garden State", status: "published", version: 9,
      published: { sourceVersion: 8 },
    })).toMatchObject({ version: 9, contentVersion: 9, publishedContentVersion: 8, liveSourceVersion: 8 });
  });

  it("honors explicit Event sort on both server and browser", () => {
    const events = [
      { id: "z", kind: "event", title: "Z upcoming", status: "draft", startsAt: "2099-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "a", kind: "event", title: "A past", status: "draft", startsAt: "2000-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
    ];
    for (const queryString of ["type=event", "type=event&sort=title&dir=asc", "type=event&sort=updatedAt"]) {
      const server = selectContentLibrary(events, parseServerContentQuery(queryString));
      const browser = selectLibraryRecords(events, parseBrowserContentQuery(queryString));
      expect(server.records.map(record => record.id)).toEqual(browser.records.map(record => record.id));
    }
    expect(selectContentLibrary(events, parseServerContentQuery("type=event")).records.map(record => record.id)).toEqual(["z", "a"]);
    expect(selectContentLibrary(events, parseServerContentQuery("type=event&sort=title&dir=asc")).records.map(record => record.id)).toEqual(["a", "z"]);
  });
  it("keeps the server vocabularies and defaults aligned with the browser codec", () => {
    // The read vocabulary is what both surfaces filter and select against, so it is
    // the one that has to match exactly, order included.
    expect(RECORD_KINDS).toEqual([...BROWSER_LIBRARY_RECORD_KINDS]);
    expect(CREATABLE_RECORD_KINDS).toEqual([...BROWSER_RECORD_KINDS]);
    expect(CONTENT_STATUSES).toEqual([...BROWSER_CONTENT_STATUSES]);
    expect(ASSIGNABLE_CONTENT_STATUSES).toEqual([
      ...BROWSER_ASSIGNABLE_CONTENT_STATUSES,
    ]);
    expect(SERVER_DEFAULT_CONTENT_QUERY).toEqual(DEFAULT_CONTENT_QUERY);
  });

  it("reads retired kinds that neither surface can create (#1039, #1227)", () => {
    expect(RETIRED_RECORD_KINDS).toEqual(["article", "staff"]);
    for (const kind of RETIRED_RECORD_KINDS) {
      expect(RECORD_KINDS).toContain(kind);
      expect(CREATABLE_RECORD_KINDS).not.toContain(kind);
      expect([...BROWSER_RECORD_KINDS]).not.toContain(kind);
    }
  });

  it.each([
    "",
    "type=article&type=post&status=draft&owner=me&assigned=me&q=Trenton&sort=title&dir=asc&page=3&v=1",
    "type=unknown&type=program&status=nope&owner=editor-2&assigned=editor-1&sort=wat&dir=sideways&page=-4",
    "type=program&type=program&status=published&q=%20Garden%20&v=999",
  ])("parses %s identically on both deployment surfaces", (query) => {
    expect(parseServerContentQuery(query)).toEqual(parseBrowserContentQuery(query));
  });

  it.each([
    "v=1",
    "type=article&owner=me&v=1",
    "assigned=me&v=1",
    "status=draft&sort=title&dir=asc&v=1",
    "q=Garden&page=4&v=1",
  ])("selects %s identically on both deployment surfaces", (query) => {
    expect(
      selectContentLibrary(records, parseServerContentQuery(query), "editor-1", 2),
    ).toEqual(
      selectLibraryRecords(records, parseBrowserContentQuery(query), "editor-1", 2),
    );
  });
});


describe("typed event list ordering", () => {
  it("puts upcoming dates first before paging, then recent past dates", () => {
    const events = [
      { id: "past-old", kind: "event", title: "Old", status: "published", startsAt: "2025-01-01T00:00:00.000Z" },
      { id: "future-later", kind: "event", title: "Later", status: "published", startsAt: "2099-02-01T00:00:00.000Z" },
      { id: "past-recent", kind: "event", title: "Recent", status: "published", startsAt: "2026-01-01T00:00:00.000Z" },
      { id: "future-soon", kind: "event", title: "Soon", status: "published", startsAt: "2099-01-01T00:00:00.000Z" },
    ];
    const result = selectContentLibrary(events, { ...SERVER_DEFAULT_CONTENT_QUERY, types: ["event"] }, "editor", 2);
    expect(result.records.map(record => record.id)).toEqual(["future-soon", "future-later"]);
  });
});


describe("settled record list receipts", () => {
  it.each(["program", "event"].flatMap(type => [true, false].map(visible => ({ type, visible }))))(
    "projects confirmed $type receipt with visible=$visible", ({ type, visible }) => {
    const row = contentRecordSummary("record-one", { type, status: "draft", title: "Private later title", version: 12,
      published: { sourceVersion: 10 }, publiclyVisible: visible, publicSourceVersion: visible ? 10 : null,
      publishBuildPending: false, publishBuildSettlement: { status: "success", sourceVersion: 10,
        operation: visible ? "publish" : "withdraw", recordQueueId: "A".repeat(20) } });
    expect(row.recordPublication).toEqual({ queueId: "A".repeat(20), sourceVersion: 10, withdrawal: !visible, status: "success", missingConsumers: [] });
  });
  it.each([
    { publishBuildPending: true }, { publicSourceVersion: 9 }, { published: { sourceVersion: 11 } },
    { publishBuildSettlement: { status: "failed", sourceVersion: 10, operation: "publish", recordQueueId: "A".repeat(20) } },
    { publishBuildSettlement: { status: "success", sourceVersion: 10, operation: "publish" } },
  ])("refuses incomplete or mismatched list confirmation %s", patch => {
    const row = contentRecordSummary("record-one", { type: "program", status: "published", version: 10,
      published: { sourceVersion: 10 }, publiclyVisible: true, publicSourceVersion: 10, publishBuildPending: false,
      publishBuildSettlement: { status: "success", sourceVersion: 10, operation: "publish", recordQueueId: "A".repeat(20) }, ...patch });
    expect(row.recordPublication).toBeUndefined();
  });
});
