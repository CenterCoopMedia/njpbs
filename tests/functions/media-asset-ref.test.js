import { describe, expect, it } from "vitest";
import mediaAssetRef from "../../functions/lib/media-asset-ref.js";
import mediaFavoriteRef from "../../functions/lib/media-favorites.js";

const {
  canonicalMediaAssetRef,
  mediaAssetRefDocumentId,
  parseMediaAssetRef,
  parseUniqueMediaAssetRefs,
  storedMediaAssetRef,
} = mediaAssetRef;
const { canonicalFavoriteRef, favoriteDocumentId } = mediaFavoriteRef;

describe("media asset references", () => {
  it("keeps the persisted favorite canonical value and document id", () => {
    const refs = [
      { backend: "r2", id: "same-id" },
      { backend: "s3", sourceId: "video-library", id: "same-id" },
      { backend: "s3", sourceId: "archive-working", id: "same-id" },
    ];

    expect(refs.map(canonicalMediaAssetRef)).toEqual([
      "r2:same-id",
      "s3:video-library:same-id",
      "s3:archive-working:same-id",
    ]);
    expect(refs.map(canonicalMediaAssetRef)).toEqual(refs.map(canonicalFavoriteRef));
    expect(refs.map(mediaAssetRefDocumentId)).toEqual(refs.map(favoriteDocumentId));
    expect(new Set(refs.map(mediaAssetRefDocumentId)).size).toBe(3);
  });

  it("parses only opaque R2 and source-qualified S3 identities", () => {
    expect(parseMediaAssetRef({ backend: "r2", id: "asset-1" })).toEqual({
      backend: "r2",
      id: "asset-1",
    });
    expect(parseMediaAssetRef({
      backend: "s3",
      sourceId: "video-library",
      id: "asset-1",
    })).toEqual({ backend: "s3", sourceId: "video-library", id: "asset-1" });
    expect(() => parseMediaAssetRef({
      backend: "s3",
      sourceId: "video-library",
      id: "asset-1",
      objectKey: "private.mp4",
    })).toThrow(/Unknown asset reference field/);
    expect(() => parseMediaAssetRef({ backend: "voiceover", id: "take-1" }))
      .toThrow(/backend is invalid/);
  });

  it("deduplicates bounded references and rejects a changed stored identity", () => {
    const ref = { backend: "r2", id: "asset-1" };
    expect(parseUniqueMediaAssetRefs([ref, ref], 2)).toEqual([ref]);
    expect(() => parseUniqueMediaAssetRefs([ref, ref], 1)).toThrow(/too many/);
    expect(storedMediaAssetRef({
      ref,
      canonicalRef: canonicalMediaAssetRef(ref),
    })).toEqual(ref);
    expect(storedMediaAssetRef({ ref, canonicalRef: "r2:other" })).toBeNull();
  });
});
