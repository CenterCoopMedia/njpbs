import { describe, expect, it } from "vitest";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";
import { viewingCopyStatus } from "../src/lib/media-format";

function video(overrides: Partial<SourceMediaAssetSummary> = {}): SourceMediaAssetSummary {
  return {
    id: "v1", sourceId: "s1", name: "Studio B", description: null, originalName: "studio-b.mp4",
    mimeType: "video/mp4", kind: "video", sizeBytes: 188_743_680, preview: "download_only",
    license: null, credit: null, tags: [], rightsStatus: "pending", version: 1,
    createdAt: null, updatedAt: null, ...overrides,
  };
}

// Characterizes the strings the admin shows today, before and after the move into one module.
describe("media formatters", () => {
  it("keeps every viewing-copy label and detail word for word", () => {
    const pairs = (overrides: Partial<SourceMediaAssetSummary>) => {
      const status = viewingCopyStatus(video(overrides));
      return [status.label, status.detail ?? null, status.tone];
    };
    expect(pairs({ viewingCopy: { state: "ready" } })).toEqual(["Preview ready", null, "success"]);
    expect(pairs({ viewingCopy: { state: "processing" }, preview: "browser" })).toEqual(["Preparing web copy", "Original preview available", "publishing"]);
    expect(pairs({ viewingCopy: { state: "processing" } })).toEqual(["Preparing preview", null, "publishing"]);
    expect(pairs({ viewingCopy: { state: "failed" }, preview: "browser" })).toEqual(["Web copy unavailable", "Original preview available", "failed"]);
    expect(pairs({ viewingCopy: { state: "failed" } })).toEqual(["Preview unavailable", "Original file is safe", "failed"]);
    expect(pairs({ viewingCopy: { state: "not_prepared" }, preview: "browser" })).toEqual(["Web copy not prepared", "Original preview available", "neutral"]);
    expect(pairs({ viewingCopy: { state: "not_prepared" } })).toEqual(["Preview not prepared", "Download original to watch", "neutral"]);
    expect(pairs({ preview: "browser" })).toEqual(["Preview available", null, "brand"]);
    expect(pairs({})).toEqual(["Download to watch", null, "neutral"]);
  });
});
