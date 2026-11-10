import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { approvedLibraryVersion, resolveApprovedLibraryVersions } = require("../../functions/lib/approved-library-records.js");

const record = { id: "sponsor", type: "sponsor", status: "draft", version: 12, name: "Draft sponsor", publiclyVisible: false };
const row = (action, version, fields = {}) => ({ collection: "cmsPosts", documentId: "sponsor", action,
  after: { type: "sponsor", status: action === "approve" ? "approved" : "draft", version, name: "Approved sponsor", ...fields } });

describe("approved library history", () => {
  it("uses the latest approval, preserving its exact fields through reopen, draft saves and send-back", () => {
    const first = row("approve", 3, { name: "First approval" });
    const latest = row("approve", 8, { href: "https://approved.example.test/" });
    expect(approvedLibraryVersion(record, [row("sendBack", 12), first, row("reopen", 9), latest, row("save", 10)]))
      .toEqual({ id: "sponsor", type: "sponsor", status: "approved", version: 8,
        name: "Approved sponsor", href: "https://approved.example.test/" });
  });

  it.each(["archive", "unpublish"])("requires another approval after %s, including after restore", action => {
    const history = [row("approve", 3), row(action, 4), row("restore", 5)];
    expect(approvedLibraryVersion(record, history)).toBeNull();
    expect(approvedLibraryVersion(record, [...history, row("approve", 6)]))
      .toMatchObject({ name: "Approved sponsor", version: 6 });
  });

  it.each([{ deleted: true }, { status: "archived" }])("revokes approval for historical tombstones regardless of action: %j", fields => {
    expect(approvedLibraryVersion(record, [row("approve", 3), row("update", 4, fields), row("restore", 5)])).toBeNull();
    expect(approvedLibraryVersion(record, [row("approve", 3), row("update", 4, fields), row("approve", 6)]))
      .toMatchObject({ name: "Approved sponsor", version: 6 });
  });

  it.each([{ deleted: true }, { status: "archived" }, { version: 0 }])("omits unavailable records: %j", fields => {
    expect(approvedLibraryVersion({ ...record, ...fields }, [row("approve", 3)])).toBeNull();
  });

  it.each([
    { status: "in_review" }, { type: "newsletter" }, { version: 0 }, { version: 13 }, { deleted: true },
  ])("does not fall back to an older approval when the latest is invalid: %j", fields => {
    expect(approvedLibraryVersion(record, [row("approve", 3), row("approve", 8, fields)])).toBeNull();
  });

  it("allows a newer approval to supersede an older incomplete history row with a proven version", () => {
    const incomplete = { ...row("approve", 3), before: { version: 2 }, after: { status: "approved" } };
    expect(approvedLibraryVersion(record, [incomplete, row("approve", 8)]))
      .toMatchObject({ name: "Approved sponsor", version: 8 });
    expect(approvedLibraryVersion(record, [row("approve", 1), incomplete])).toBeNull();
    expect(approvedLibraryVersion(record, [{ ...incomplete, before: { version: 10 } }, row("approve", 8)])).toBeNull();
  });

  it("omits ambiguous latest history versions in either query order, until a later approval", () => {
    const approved = row("approve", 3);
    const tombstone = row("update", 3, { deleted: true });
    for (const history of [[approved, tombstone], [tombstone, approved]]) {
      expect(approvedLibraryVersion(record, history)).toBeNull();
      expect(approvedLibraryVersion(record, [...history, row("approve", 8)]))
        .toMatchObject({ name: "Approved sponsor", version: 8 });
      expect(approvedLibraryVersion(record, [row("approve", 8), ...history]))
        .toMatchObject({ name: "Approved sponsor", version: 8 });
    }
  });

  it("never treats a published snapshot, working status or another record's history as approval", () => {
    expect(approvedLibraryVersion({ ...record, status: "approved", published: { metadata: record } }, [
      { ...row("approve", 3), documentId: "another" }, { ...row("approve", 4), collection: "cmsPages" },
      row("save", 10, { status: "approved" }),
    ])).toBeNull();
  });

  it("replaces stored lookalike approval fields with immutable history and bounds each query to its target", async () => {
    const get = vi.fn(async () => ({ docs: [{ data: () => row("approve", 3) }] }));
    const where = vi.fn(() => ({ where, get }));
    const database = { collection: vi.fn(() => ({ where })) };
    const result = await resolveApprovedLibraryVersions(database, [{ ...record, approvedLibraryVersion: record }]);
    expect(database.collection).toHaveBeenCalledWith("cmsVersionHistory");
    expect(where.mock.calls).toEqual([["collection", "==", "cmsPosts"], ["documentId", "==", "sponsor"]]);
    expect(result[0].approvedLibraryVersion).toMatchObject({ name: "Approved sponsor", version: 3 });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
