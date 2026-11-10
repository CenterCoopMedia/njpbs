import type { ListMediaResponse, MediaAssetSummary } from "../lib/functions";

// A small images list for the toolbar specimens and tests: counts as the server returns
// them, and records that carry the page tags. Nothing here is requested.

const CATEGORY_LABELS: Record<string, string> = {
  "arts-culture": "Arts and culture",
  news: "News",
  sports: "Sports",
};

export const mediaToolbarCategoryLabel = (id: string) => CATEGORY_LABELS[id] ?? id;

function asset(id: string, name: string, overrides: Partial<MediaAssetSummary>): MediaAssetSummary {
  return {
    id, name, originalName: `${id}.jpg`, category: "news", categories: ["news"], tags: [],
    description: null, altText: null, license: null, credit: null, mimeType: "image/jpeg",
    kind: "image", sizeBytes: 2_202_009, width: 2400, height: 1600,
    url: `https://media.njpbs.org/${id}.jpg`, lifecycle: "active", version: 1, etag: `"${id}.1"`,
    createdAt: null, createdBy: null, updatedAt: "2026-09-23T16:05:00.000Z", updatedBy: null,
    ...overrides,
  };
}

export const MEDIA_TOOLBAR_RESULT: ListMediaResponse = {
  success: true,
  records: [
    asset("statehouse-dome", "Statehouse dome at dusk", { tags: ["trenton", "statehouse", "b-roll"] }),
    asset("budget-notes", "FY2027 budget briefing notes", {
      kind: "document", mimeType: "application/pdf", width: null, height: null, tags: ["Trenton", "budget"],
    }),
    asset("shore-turbines", "Offshore wind turbines", { category: "sports", categories: ["sports"], tags: ["b-roll", "shore"] }),
  ],
  total: 3,
  allCount: 16,
  page: 1,
  pageCount: 1,
  categoryCounts: { news: 12, sports: 1, "arts-culture": 3 },
  kindCounts: { image: 1, document: 2 },
};
