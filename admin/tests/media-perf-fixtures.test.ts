import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  MEDIA_PERF_ASSET_COUNT,
  MEDIA_PERF_CATEGORY_IDS,
  assertSeedPassword,
  mediaPerfAssets,
} from "../../scripts/lib/media-perf-fixtures.mjs";
import { seedMediaPerfFixtures } from "../../scripts/seed-media-perf-fixtures.mjs";

const { MEDIA_LIBRARY_PAGE_SIZE, mediaAssetSummary } = createRequire(import.meta.url)(
  "../../functions/lib/media-library.js",
) as {
  MEDIA_LIBRARY_PAGE_SIZE: number;
  mediaAssetSummary: (id: string, data: unknown) => { id: string; kind: string; categories: string[] } | null;
};

describe("media speed-check fixtures", () => {
  it("fill more than one library page so paging is measured", () => {
    expect(MEDIA_PERF_ASSET_COUNT).toBeGreaterThan(MEDIA_LIBRARY_PAGE_SIZE);
    expect(mediaPerfAssets()).toHaveLength(MEDIA_PERF_ASSET_COUNT);
  });

  it("are records the media list accepts, images and documents both", () => {
    const summaries = mediaPerfAssets().map(({ id, data }) => mediaAssetSummary(id, data));
    expect(summaries.every(Boolean)).toBe(true);
    const kinds = new Set(summaries.map((summary) => summary?.kind));
    expect([...kinds].sort()).toEqual(["document", "image"]);
  });

  it("use only the categories the seed creates", () => {
    const used = new Set(mediaPerfAssets().flatMap(({ data }) => data.categories));
    for (const id of used) expect(MEDIA_PERF_CATEGORY_IDS).toContain(id);
  });

  it("are the same on every run, so before and after samples compare", () => {
    expect(mediaPerfAssets()).toEqual(mediaPerfAssets());
    expect(new Set(mediaPerfAssets().map(({ id }) => id)).size).toBe(MEDIA_PERF_ASSET_COUNT);
  });

  it("never point at a real host", () => {
    for (const { data } of mediaPerfAssets()) expect(new URL(data.url).hostname.endsWith(".invalid")).toBe(true);
  });

  it("require a strong password from the environment, never a default", () => {
    expect(() => assertSeedPassword(undefined)).toThrow(/MEDIA_PERF_SEED_PASSWORD/);
    expect(() => assertSeedPassword("short")).toThrow(/20/);
    expect(assertSeedPassword("x".repeat(24))).toBe("x".repeat(24));
  });

  it("refuse to run without --reset, and outside the demo emulator project", async () => {
    await expect(seedMediaPerfFixtures({ env: {}, argv: [] })).rejects.toThrow(/--reset/);
    await expect(
      seedMediaPerfFixtures({ env: { GCLOUD_PROJECT: "njpbs-site", MEDIA_PERF_SEED_PASSWORD: "x".repeat(24) }, argv: ["--reset"] }),
    ).rejects.toThrow(/demo-njpbs/);
  });
});
