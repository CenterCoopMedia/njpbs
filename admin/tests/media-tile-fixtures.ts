import type { MediaAssetSummary } from "../src/lib/functions";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

// Shared records for the MediaTile, MediaRow and MediaHoverFacts specs. Nothing is requested.

export function imageAsset(overrides: Partial<MediaAssetSummary> = {}): MediaAssetSummary {
  return {
    id: "a1", name: "Sunset over Newark", originalName: "sunset.jpg", category: "news", categories: ["news"],
    tags: ["newark", "b-roll", "sunset", "skyline"], description: null, altText: null, license: null,
    credit: null, mimeType: "image/jpeg", kind: "image", sizeBytes: 2_202_009, width: 2400, height: 1600,
    url: "https://media.example.org/sunset-original.jpg",
    thumbnails: [
      { url: "https://media.example.org/sunset-320.webp", width: 320, height: 213 },
      { url: "https://media.example.org/sunset-640.webp", width: 640, height: 427 },
      { url: "https://media.example.org/sunset-1280.webp", width: 1280, height: 853 },
    ],
    lifecycle: "active", version: 1, etag: "e", createdAt: null, createdBy: null,
    updatedAt: "2026-09-23T16:05:00.000Z", updatedBy: null, ...overrides,
  };
}

export function documentAsset(overrides: Partial<MediaAssetSummary> = {}): MediaAssetSummary {
  return imageAsset({
    id: "d1", name: "FY2027 budget briefing notes", originalName: "budget.pdf", mimeType: "application/pdf",
    kind: "document", sizeBytes: 831_898, width: null, height: null, thumbnails: undefined,
    url: "https://media.example.org/budget.pdf", tags: ["budget"], ...overrides,
  });
}

export function videoAsset(overrides: Partial<SourceMediaAssetSummary> = {}): SourceMediaAssetSummary {
  return {
    id: "v1", sourceId: "video-library", name: "Studio B walkthrough", description: "A tour of the new studio.",
    originalName: "studio-b.mp4", mimeType: "video/mp4", kind: "video", sizeBytes: 1_503_238_554, preview: "download_only",
    viewingCopy: { state: "ready", durationSeconds: 754, width: 1920, height: 1080, sizeBytes: 188_743_680 },
    license: null, credit: null, tags: ["studio", "b-roll", "tours", "newsroom"], rightsStatus: "pending", version: 1,
    uploadedBy: { uid: "u1", name: "Pat Lee" }, createdAt: null, updatedAt: "2026-09-10T20:41:00.000Z", ...overrides,
  };
}

export const categoryLabel = (id: string) => ({ news: "News", programs: "Programs" })[id] ?? id;
