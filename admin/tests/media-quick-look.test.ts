import { afterEach, describe, expect, it } from "vitest";
import type { MediaAssetSummary } from "../src/lib/functions";
import { quickLookImage, quickLookPoster } from "../src/lib/media-quick-look";
import { cachePoster, clearMediaSessionCache } from "../src/lib/media-session-cache";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

function image(extra: Partial<MediaAssetSummary> = {}): MediaAssetSummary {
  return {
    id: "img", name: "Sunset", originalName: "sunset.jpg", category: "news", categories: ["news"], tags: [],
    description: null, altText: "Sunset over Newark", license: null, credit: null, mimeType: "image/jpeg", kind: "image",
    sizeBytes: 1, width: 2400, height: 1600, url: "https://media.example/sunset.jpg",
    thumbnails: [
      { url: "https://media.example/sunset-960.webp", width: 960, height: 640 },
      { url: "https://media.example/sunset-480.webp", width: 480, height: 320 },
    ],
    lifecycle: "active", version: 1, etag: '"e"', createdAt: null, createdBy: null, updatedAt: null, updatedBy: null, ...extra,
  };
}

function video(extra: Partial<SourceMediaAssetSummary> = {}): SourceMediaAssetSummary {
  return {
    id: "vid", sourceId: "video-library", name: "Studio B", description: null, originalName: "b.mp4", mimeType: "video/mp4",
    kind: "video", sizeBytes: 1, preview: "browser", viewingCopy: { state: "ready" }, license: null, credit: null, tags: [],
    rightsStatus: "pending", version: 1, createdAt: null, updatedAt: null, ...extra,
  };
}

afterEach(() => clearMediaSessionCache());

describe("Quick Look sources", () => {
  it("uses the 960 thumbnail, the original only for GIF, and the PDF placeholder for documents", () => {
    expect(quickLookImage(image())).toEqual({ kind: "image", url: "https://media.example/sunset-960.webp", width: 960, height: 640, alt: "Sunset over Newark" });
    // A small image stores one thumbnail at its own width.
    expect(quickLookImage(image({ thumbnails: [{ url: "https://media.example/small.webp", width: 400, height: 300 }] })))
      .toMatchObject({ kind: "image", url: "https://media.example/small.webp", width: 400 });
    expect(quickLookImage(image({ thumbnails: undefined }))).toMatchObject({ kind: "image", url: "https://media.example/sunset.jpg", width: 2400, height: 1600 });
    expect(quickLookImage(image({ mimeType: "image/gif", url: "https://media.example/a.gif" }))).toMatchObject({ kind: "image", url: "https://media.example/a.gif" });
    expect(quickLookImage(image({ mimeType: "image/webp", animated: true }))).toMatchObject({ kind: "image", url: "https://media.example/sunset.jpg" });
    expect(quickLookImage(image({ kind: "document", mimeType: "application/pdf", thumbnails: undefined }))).toEqual({ kind: "placeholder", label: "PDF" });
  });

  it("returns a cached poster with no read, and allows one queued read only for a video with no cached poster", () => {
    expect(quickLookPoster(video())).toEqual({ url: null, read: true });
    cachePoster("video-library", "vid", "https://posters.example/vid.jpg", new Date(Date.now() + 10 * 60_000).toISOString(), Date.now());
    expect(quickLookPoster(video())).toEqual({ url: "https://posters.example/vid.jpg", read: false });
    // No viewing copy means no poster to read, as on the card.
    expect(quickLookPoster(video({ id: "other", viewingCopy: { state: "processing" } }))).toEqual({ url: null, read: false });
    expect(quickLookPoster(video({ id: "other", viewingCopy: undefined }))).toEqual({ url: null, read: false });
  });

  it("requires a new poster for a replacement file while retaining the current file's cached read", () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    cachePoster("video-library", "vid", "https://posters.example/original.jpg", expiresAt, Date.now(), "original-file");
    expect(quickLookPoster(video({ fileVersion: "original-file" })))
      .toEqual({ url: "https://posters.example/original.jpg", read: false });
    expect(quickLookPoster(video({ fileVersion: "replacement-file" }))).toEqual({ url: null, read: true });
    cachePoster("video-library", "vid", "https://posters.example/replacement.jpg", expiresAt, Date.now(), "replacement-file");
    expect(quickLookPoster(video({ fileVersion: "replacement-file" })))
      .toEqual({ url: "https://posters.example/replacement.jpg", read: false });
  });

  it("keeps cached posters with equal asset ids separate by source", () => {
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    cachePoster("source-a", "shared", "https://posters.example/source-a.jpg", expiresAt, Date.now());
    cachePoster("source-b", "shared", "https://posters.example/source-b.jpg", expiresAt, Date.now());

    expect(quickLookPoster(video({ sourceId: "source-a", id: "shared" })))
      .toEqual({ url: "https://posters.example/source-a.jpg", read: false });
    expect(quickLookPoster(video({ sourceId: "source-b", id: "shared" })))
      .toEqual({ url: "https://posters.example/source-b.jpg", read: false });
  });
});
