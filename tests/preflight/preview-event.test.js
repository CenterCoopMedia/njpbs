import { describe, expect, it } from "vitest";
import previewPkg from "../../functions/lib/preview-snapshot.js";
import targetPkg from "../../functions/lib/preview-target.js";
const { createPostPreviewSnapshot, referencedPreviewAssetIds } = previewPkg;
const { previewTargetPath } = targetPkg;
const description = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Join us." }] }] };

describe("saved Event preview", () => {
  it("freezes an incomplete draft for private preview", () => {
    const snapshot = createPostPreviewSnapshot("event-draft", { type: "event", version: 1 });
    expect(snapshot.published.metadata.title).toBe("Untitled event");
    expect(snapshot.published.metadata.startsAt).toBeTruthy();
    expect(snapshot.published.metadata.description.content[0].content[0].text).toMatch(/not ready/);
    expect(snapshot.published.metadata.slug).toMatch(/^draft-/);
  });
  it("uses the Event route and includes its station image", () => {
    const snapshot = createPostPreviewSnapshot("event-1", { type: "event", title: "Screening", version: 2, slug: "screening", previousSlugs: [], locale: "en", startsAt: "2026-10-01T22:00:00.000Z", description, imageAssetId: "asset-1", imageAlt: "Audience" });
    expect(previewTargetPath("cmsPosts", "event-1", snapshot)).toBe("/events/screening/");
    expect(referencedPreviewAssetIds(snapshot)).toContain("asset-1");
  });
});
