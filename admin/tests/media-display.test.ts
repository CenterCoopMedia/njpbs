import { describe, expect, it } from "vitest";
import type { MediaAssetSummary } from "../src/lib/functions";
import {
  DEFAULT_MEDIA_DISPLAY,
  DEFAULT_VIDEO_MEDIA_DISPLAY,
  MEDIA_DISPLAY_STORAGE_KEY,
  VIDEO_MEDIA_DISPLAY_STORAGE_KEY,
  listColumns,
  mediaCardFactEntries,
  mediaCardFacts,
  readMediaDisplay,
  resetMediaDisplay,
  thumbnailToken,
  writeMediaDisplay,
} from "../src/lib/media-display";

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

const throwing = {
  getItem: () => { throw new Error("blocked"); },
  setItem: () => { throw new Error("full"); },
  removeItem: () => { throw new Error("blocked"); },
};

function asset(overrides: Partial<MediaAssetSummary> = {}): MediaAssetSummary {
  return {
    id: "a1", name: "Studio", originalName: "studio.jpg", category: "news", categories: ["news"],
    tags: ["studio", "b-roll", "trenton", "night"], description: null, altText: null, license: null,
    credit: null, mimeType: "image/jpeg", kind: "image", sizeBytes: 2_202_009, width: 2400, height: 1600,
    url: "https://example.org/a.jpg", lifecycle: "active", version: 1, etag: "e", createdAt: null,
    createdBy: null, updatedAt: "2026-09-23T16:05:00.000Z", updatedBy: null, ...overrides,
  };
}

describe("media display preferences", () => {
  it("returns the approved defaults when nothing is stored", () => {
    expect(readMediaDisplay("images", memoryStore())).toEqual(DEFAULT_MEDIA_DISPLAY);
    expect(DEFAULT_MEDIA_DISPLAY).toEqual({
      layout: "grid",
      thumbnail: "m",
      density: "app",
      fields: { type: true, size: true, dimensions: true, tags: true, category: false, updated: false },
    });
  });

  it("keeps each valid stored value, replaces only invalid ones and ignores unknown keys", () => {
    const store = memoryStore({
      [MEDIA_DISPLAY_STORAGE_KEY]: JSON.stringify({
        thumbnail: "l", density: "huge", layout: "filmstrip", future: 3, fields: { category: true, size: "yes", extra: true },
      }),
    });
    expect(readMediaDisplay("images", store)).toEqual({
      layout: "grid",
      thumbnail: "l",
      density: "app",
      fields: { ...DEFAULT_MEDIA_DISPLAY.fields, category: true },
    });
  });

  it("reads a missing layout as grid and keeps other keys", () => {
    const store = memoryStore({
      [MEDIA_DISPLAY_STORAGE_KEY]: JSON.stringify({ thumbnail: "s", density: "compact", fields: { updated: true } }),
    });
    expect(readMediaDisplay("images", store)).toEqual({
      layout: "grid",
      thumbnail: "s",
      density: "compact",
      fields: { ...DEFAULT_MEDIA_DISPLAY.fields, updated: true },
    });
  });

  it("round-trips list", () => {
    const store = memoryStore();
    writeMediaDisplay("images", store, { ...DEFAULT_MEDIA_DISPLAY, layout: "list" });
    expect(readMediaDisplay("images", store).layout).toBe("list");
    writeMediaDisplay("images", store, { ...DEFAULT_MEDIA_DISPLAY, layout: "grid" });
    expect(readMediaDisplay("images", store).layout).toBe("grid");
  });

  it("listColumns adds Updated as the last column", () => {
    expect(listColumns(DEFAULT_MEDIA_DISPLAY.fields)).toEqual(["name", "type", "size", "dimensions", "tags", "updated"]);
    expect(listColumns({ type: false, category: true, size: false, dimensions: false, updated: false, tags: false }))
      .toEqual(["name", "category", "updated"]);
    expect(listColumns({ type: true, category: true, size: true, dimensions: true, updated: true, tags: true }))
      .toEqual(["name", "type", "category", "size", "dimensions", "tags", "updated"]);
  });

  it("falls back to defaults when storage is missing or throws on read", () => {
    expect(readMediaDisplay("images", null)).toEqual(DEFAULT_MEDIA_DISPLAY);
    expect(readMediaDisplay("images", throwing)).toEqual(DEFAULT_MEDIA_DISPLAY);
    expect(readMediaDisplay("images", memoryStore({ [MEDIA_DISPLAY_STORAGE_KEY]: "{not json" }))).toEqual(DEFAULT_MEDIA_DISPLAY);
  });

  it("ignores a throwing or full store on write and reset", () => {
    expect(() => writeMediaDisplay("images", throwing, DEFAULT_MEDIA_DISPLAY)).not.toThrow();
    expect(() => resetMediaDisplay("images", throwing)).not.toThrow();
    expect(() => writeMediaDisplay("images", null, DEFAULT_MEDIA_DISPLAY)).not.toThrow();
  });

  it("stores under njpbs-admin:media-display:images", () => {
    expect(MEDIA_DISPLAY_STORAGE_KEY).toBe("njpbs-admin:media-display:images");
    const store = memoryStore();
    writeMediaDisplay("images", store, { ...DEFAULT_MEDIA_DISPLAY, thumbnail: "s" });
    expect(JSON.parse(store.data.get(MEDIA_DISPLAY_STORAGE_KEY) ?? "{}").thumbnail).toBe("s");
    resetMediaDisplay("images", store);
    expect(store.data.has(MEDIA_DISPLAY_STORAGE_KEY)).toBe(false);
  });

  it("uses a separate video key and keeps page size out of display storage", () => {
    expect(VIDEO_MEDIA_DISPLAY_STORAGE_KEY).toBe("njpbs-admin:media-display:video");
    const store = memoryStore({
      [MEDIA_DISPLAY_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_MEDIA_DISPLAY, layout: "list" }),
      [VIDEO_MEDIA_DISPLAY_STORAGE_KEY]: JSON.stringify({
        ...DEFAULT_VIDEO_MEDIA_DISPLAY,
        pageSize: 47,
        fields: { duration: false, rights: true, uploader: true, category: true, future: true },
      }),
    });

    expect(readMediaDisplay("images", store).layout).toBe("list");
    expect(readMediaDisplay("video", store)).toEqual({
      ...DEFAULT_VIDEO_MEDIA_DISPLAY,
      pageSize: 24,
      fields: { ...DEFAULT_VIDEO_MEDIA_DISPLAY.fields, duration: false, uploader: true },
    });

    writeMediaDisplay("video", store, { ...DEFAULT_VIDEO_MEDIA_DISPLAY, pageSize: 96 });
    expect(JSON.parse(store.data.get(VIDEO_MEDIA_DISPLAY_STORAGE_KEY) ?? "{}")).not.toHaveProperty("pageSize");
    expect(JSON.parse(store.data.get(MEDIA_DISPLAY_STORAGE_KEY) ?? "{}").layout).toBe("list");
  });

  it("falls back without throwing when video storage is blocked", () => {
    expect(readMediaDisplay("video", throwing)).toEqual(DEFAULT_VIDEO_MEDIA_DISPLAY);
    expect(() => writeMediaDisplay("video", throwing, DEFAULT_VIDEO_MEDIA_DISPLAY)).not.toThrow();
    expect(() => resetMediaDisplay("video", throwing)).not.toThrow();
  });

  it("maps small, medium and large to the thumb-sm, thumb-md and thumb-lg tokens", () => {
    expect(thumbnailToken("s")).toBe("var(--cms-thumb-sm)");
    expect(thumbnailToken("m")).toBe("var(--cms-thumb-md)");
    expect(thumbnailToken("l")).toBe("var(--cms-thumb-lg)");
  });

  it("lists card facts for visible fields in the fixed order Type, Category, Size, Dimensions, Updated, Tags", () => {
    const all = { type: true, size: true, dimensions: true, tags: true, category: true, updated: true };
    expect(mediaCardFacts(asset(), all, () => "News")).toEqual([
      "Image", "News", "2.1 MB", "2400 × 1600", "Sep 23, 2026, 12:05 PM", "4 tags",
    ]);
    expect(mediaCardFacts(asset(), DEFAULT_MEDIA_DISPLAY.fields, () => "News")).toEqual([
      "Image", "2.1 MB", "2400 × 1600", "4 tags",
    ]);
    expect(mediaCardFacts(
      asset({ kind: "document", mimeType: "application/pdf", width: null, height: null, tags: ["budget"] }),
      DEFAULT_MEDIA_DISPLAY.fields,
      () => "News",
    )).toEqual(["PDF", "2.1 MB", "1 tag"]);
    expect(mediaCardFacts(asset({ tags: [], height: null }), DEFAULT_MEDIA_DISPLAY.fields, () => "News")).toEqual(["Image", "2.1 MB"]);
  });

  it("names the field of each card fact, so a card can hide one field by width", () => {
    expect(mediaCardFactEntries(asset(), DEFAULT_MEDIA_DISPLAY.fields, () => "News")).toEqual([
      { field: "type", text: "Image" },
      { field: "size", text: "2.1 MB" },
      { field: "dimensions", text: "2400 × 1600" },
      { field: "tags", text: "4 tags" },
    ]);
    expect(mediaCardFactEntries(asset({ tags: [] }), { ...DEFAULT_MEDIA_DISPLAY.fields, category: true }, () => "News").map((fact) => fact.field))
      .toEqual(["type", "category", "size", "dimensions"]);
  });
});
