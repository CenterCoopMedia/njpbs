export const MEDIA_PERF_ASSET_COUNT: number;
export const MEDIA_PERF_CATEGORY_IDS: readonly string[];

export interface MediaPerfAsset {
  id: string;
  data: {
    name: string;
    originalName: string;
    category: string;
    categories: string[];
    tags: string[];
    description: string;
    altText: string | null;
    license: null;
    credit: string;
    mimeType: "image/jpeg" | "application/pdf";
    kind: "image" | "document";
    sizeBytes: number;
    width: number | null;
    height: number | null;
    url: string;
    source: "upload";
    lifecycle: "active";
    version: number;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
  };
}

export function mediaPerfAssets(options?: { count?: number }): MediaPerfAsset[];

export function assertSeedPassword(value: unknown): string;
