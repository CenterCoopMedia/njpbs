import { describe, expect, it } from "vitest";
import snapshots from "../../functions/lib/preview-snapshot.js";
import targets from "../../functions/lib/preview-target.js";

const description = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Saved synopsis" }] }] };
const now = Date.parse("2026-10-12T18:00:00.000Z");

describe("saved structured-record preview snapshots", () => {
  it("freezes a Program route, synopsis and key art without changing the working record", () => {
    const stored = { type: "program", title: "Saved Program", description: structuredClone(description), slug: "saved-program",
      previousSlugs: ["previous-program"], locale: "en", status: "draft", version: 7, keyArtAssetId: "saved-art", keyArtAlt: "Saved artwork" };
    const original = structuredClone(stored);
    const snapshot = snapshots.createPostPreviewSnapshot("program-one", stored, now);
    expect(stored).toEqual(original);
    expect(snapshot.published.metadata).toMatchObject({ type: "program", slug: "saved-program", description, keyArtAssetId: "saved-art" });
    expect(snapshot.published.sourceVersion).toBe(7);
    expect(snapshot.published.metadata).not.toHaveProperty("firstPublishedAt");
    expect(targets.previewTargetPath("cmsPosts", "program-one", snapshot)).toBe("/programs/saved-program/");
    expect(snapshots.referencedPreviewAssetIds(snapshot)).toEqual(["saved-art"]);
    stored.description.content[0].content[0].text = "Later edit";
    expect(snapshot.published.metadata.description).toEqual(description);
  });

  it("renders an unfinished Program using only private placeholders", () => {
    const stored = { type: "program", status: "draft", version: 1, title: "" };
    const snapshot = snapshots.createPostPreviewSnapshot("new-program", stored, now);
    expect(snapshot.blocks).toEqual([]);
    expect(snapshot.published.metadata.title).toBe("Untitled program");
    expect(snapshot.published.metadata.description.content[0].content[0].text).toBe("Program synopsis is not ready yet.");
    expect(snapshot.published.metadata.slug).toMatch(/^draft-[a-f0-9]{24}$/);
    expect(stored).toEqual({ type: "program", status: "draft", version: 1, title: "" });
  });

  it("retains Event private routing, details and image snapshots", () => {
    const stored = { type: "event", title: "Saved Event", status: "draft", version: 2, slug: "saved-event", description,
      startsAt: "2026-10-13T18:00:00.000Z", imageAssetId: "event-art", imageAlt: "Event artwork" };
    const snapshot = snapshots.createPostPreviewSnapshot("event-one", stored, now);
    expect(targets.previewTargetPath("cmsPosts", "event-one", snapshot)).toBe("/events/saved-event/");
    expect(snapshots.referencedPreviewAssetIds(snapshot)).toEqual(["event-art"]);
    expect(snapshot.published.metadata.description).toEqual(description);
  });

  it.each([{ type: "sponsor" }, { type: "newsletter" }, { type: "program", deleted: true }, { type: "event", status: "archived" }])(
    "refuses library-only or inactive targets: %j", overrides => {
      expect(() => snapshots.createPostPreviewSnapshot("closed-target", { version: 1, status: "draft", ...overrides }, now)).toThrow(/active routed records/);
    },
  );
});
