import { describe, expect, it } from "vitest";

import { buildRevisionDiff } from "../src/lib/revision-diff";

describe("buildRevisionDiff", () => {
  it("identifies field, ordered-block, visibility, content, and media changes", () => {
    const before = {
      title: "Before",
      status: "draft",
      social: { imageAssetId: "social-old" },
      blocks: [
        {
          id: "a",
          type: "image",
          order: 0,
          visible: true,
          data: { assetId: "image-old", alt: "Before" },
        },
        {
          id: "b",
          type: "prose",
          order: 1,
          visible: true,
          data: { content: { type: "doc", content: [] } },
        },
        { id: "removed", type: "divider", order: 2, visible: true, data: {} },
      ],
    };
    const after = {
      title: "After",
      status: "in_review",
      social: { imageAssetId: "social-new" },
      blocks: [
        {
          id: "b",
          type: "prose",
          order: 0,
          visible: true,
          data: { content: { type: "doc", content: [{ type: "paragraph" }] } },
        },
        {
          id: "a",
          type: "image",
          order: 1,
          visible: false,
          data: { assetId: "image-new", alt: "After" },
        },
        { id: "added", type: "divider", order: 2, visible: true, data: {} },
      ],
    };

    const diff = buildRevisionDiff(before, after);

    expect(diff.fields.map(({ field }) => field)).toEqual([
      "social",
      "status",
      "title",
    ]);
    expect(diff.blocks).toEqual([
      expect.objectContaining({
        id: "a",
        kind: "changed",
        beforeIndex: 0,
        afterIndex: 1,
        moved: true,
        visibilityChanged: true,
        changedDataFields: ["alt", "assetId"],
        dataChanges: [
          { field: "alt", before: "Before", after: "After" },
          { field: "assetId", before: "image-old", after: "image-new" },
        ],
        envelopeChanges: [{ field: "order", before: 0, after: 1 }],
      }),
      expect.objectContaining({
        id: "added",
        kind: "added",
      }),
      expect.objectContaining({
        id: "b",
        kind: "changed",
        moved: true,
        changedDataFields: ["content"],
        dataChanges: [{
          field: "content",
          before: { type: "doc", content: [] },
          after: { type: "doc", content: [{ type: "paragraph" }] },
        }],
        envelopeChanges: [{ field: "order", before: 1, after: 0 }],
      }),
      expect.objectContaining({
        id: "removed",
        kind: "removed",
      }),
    ]);
    expect(diff.media).toEqual({
      added: ["image-new", "social-new"],
      removed: ["image-old", "social-old"],
    });
  });

  it("treats missing or malformed snapshots as empty records", () => {
    expect(buildRevisionDiff(null, "bad")).toEqual({
      fields: [],
      blocks: [],
      media: { added: [], removed: [] },
    });
  });

  it("does not report semantically equal objects whose keys arrived in another order", () => {
    const before = { seo: { title: "One", description: "Two" } };
    const after = { seo: { description: "Two", title: "One" } };
    expect(buildRevisionDiff(before, after).fields).toEqual([]);
  });

  it("reports order and section envelope changes at a stable array position", () => {
    const before = {
      blocks: [{
        id: "stable",
        type: "prose",
        order: 9,
        section: "lead",
        visible: true,
        data: { content: "Same" },
      }],
    };
    const after = {
      blocks: [{
        id: "stable",
        type: "prose",
        order: 0,
        section: "body",
        visible: true,
        data: { content: "Same" },
      }],
    };

    expect(buildRevisionDiff(before, after).blocks).toEqual([
      expect.objectContaining({
        id: "stable",
        moved: false,
        changedDataFields: [],
        envelopeChanges: [
          { field: "order", before: 9, after: 0 },
          { field: "section", before: "lead", after: "body" },
        ],
      }),
    ]);
  });

  it.each([
    [{ rowId: "row-a", column: 0 }, { rowId: "row-a", column: 1 }],
    [{ rowId: "row-a", column: 0 }, { rowId: "row-b", column: 0 }],
    [undefined, { rowId: "row-a", column: 0 }],
    [{ rowId: "row-a", column: 0 }, undefined],
  ])("reports row membership changes without an array move", (beforeLayout, afterLayout) => {
    const block = { id: "child", type: "prose", order: 0, visible: true, data: { content: "Same" } };
    const before = { blocks: [{ ...block, layout: beforeLayout }] };
    const after = { blocks: [{ ...block, layout: afterLayout }] };

    expect(buildRevisionDiff(before, after).blocks).toEqual([
      expect.objectContaining({
        id: "child", kind: "changed", moved: false, changedDataFields: [],
        envelopeChanges: [{ field: "layout", before: beforeLayout, after: afterLayout }],
      }),
    ]);
    expect(buildRevisionDiff(after, after).blocks).toEqual([]);
  });
});
