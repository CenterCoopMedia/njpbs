import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  pageSeedAsset,
  pageSeedAssetIds,
} from "../../packages/content-core/src/page-composition-seeds";
import { PAGE_SEED_MEDIA } from "../../scripts/backfill-page-seed-media.mjs";

describe("page seed media deployment parity", () => {
  it("keeps the Firestore backfill manifest equal to the canonical page seed registry", () => {
    expect(PAGE_SEED_MEDIA.map(({ id }) => id)).toEqual(pageSeedAssetIds());

    for (const seed of PAGE_SEED_MEDIA) {
      const canonical = pageSeedAsset(seed.id);
      expect(canonical).toEqual({
        id: seed.id,
        publicPath: `/${seed.path}`,
        sourceUrl: `https://njpbs.org/${seed.path}`,
        mimeType: seed.mimeType,
        width: seed.width,
        height: seed.height,
      });
    }
  });

  it("keeps every built-in page image to a single frame", async () => {
    for (const seed of PAGE_SEED_MEDIA) {
      const bytes = readFileSync(resolve("site/public", seed.path));
      const metadata = await sharp(bytes, { animated: true, failOn: "error" }).metadata();
      expect(metadata.pages ?? 1, seed.id).toBe(1);
    }
  });
});
