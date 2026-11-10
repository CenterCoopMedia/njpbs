import { describe, expect, it } from "vitest";
import { mediaDisplayUrl, mediaImageSources, mediaPreviewImage, mediaPreviewUrl } from "../src/lib/media-image";
import type { MediaAssetSummary } from "../src/lib/functions";

const asset = {
  url: "https://example.test/original.jpg",
  width: 2000,
  height: 1000,
  thumbnails: [
    { url: "https://example.test/960.webp", width: 960, height: 480 },
    { url: "https://example.test/480.webp", width: 480, height: 240 },
  ],
} as MediaAssetSummary;

describe("media image sources", () => {
  it("chooses the smallest sufficient thumbnail and offers both widths", () => {
    expect(mediaImageSources(asset, 480)).toEqual({
      src: "https://example.test/480.webp",
      srcSet: "https://example.test/480.webp 480w, https://example.test/960.webp 960w",
      sizes: "480px",
      width: 2000,
      height: 1000,
    });
    expect(mediaImageSources(asset, 600).src).toBe("https://example.test/960.webp");
  });

  it("uses the largest thumbnail or original when needed", () => {
    expect(mediaImageSources(asset, 1200).src).toBe("https://example.test/960.webp");
    expect(mediaImageSources({ ...asset, thumbnails: [] }, 480)).toEqual({
      src: asset.url, srcSet: undefined, sizes: undefined, width: 2000, height: 1000,
    });
  });

  it("picks a thumbnail for a small portrait and falls back to the original", () => {
    expect(mediaDisplayUrl(asset, 80, 80)).toBe("https://example.test/480.webp");
    expect(mediaDisplayUrl(asset, 600)).toBe("https://example.test/960.webp");
    expect(mediaDisplayUrl(asset, 1200)).toBe(asset.url);
    expect(mediaDisplayUrl({
      url: asset.url,
      thumbnails: [{ url: "https://example.test/wide.webp", width: 480, height: 40 }],
    }, 104, 104)).toBe(asset.url);
    expect(mediaDisplayUrl({ url: asset.url }, 80)).toBe(asset.url);
  });

  it("keeps animated GIFs and multi-frame uploads on the original", () => {
    expect(mediaPreviewUrl({ ...asset, mimeType: "image/gif" }, 480)).toBe(asset.url);
    expect(mediaPreviewUrl({ ...asset, mimeType: "image/gif" }, 960)).toBe(asset.url);
    expect(mediaPreviewUrl({ ...asset, mimeType: "image/webp", animated: true }, 960)).toBe(asset.url);
    expect(mediaPreviewImage({ ...asset, mimeType: "image/webp", animated: true }, 320)).toEqual({
      src: asset.url,
      srcSet: undefined,
      sizes: undefined,
      width: 2000,
      height: 1000,
    });
    expect(mediaPreviewUrl({ ...asset, mimeType: "image/jpeg" }, 480)).toBe("https://example.test/480.webp");
    expect(mediaPreviewUrl({ ...asset, mimeType: "image/jpeg" }, 320)).toBe("https://example.test/480.webp");
    expect(mediaPreviewUrl({ ...asset, mimeType: "image/webp", animated: false }, 320)).toBe("https://example.test/480.webp");
    expect(mediaPreviewImage({ ...asset, mimeType: "image/jpeg" }, 320).srcSet).toBe(
      "https://example.test/480.webp 480w, https://example.test/960.webp 960w",
    );
    expect(mediaPreviewUrl({ ...asset, mimeType: "image/jpeg" }, 1200)).toBe(asset.url);
    expect(mediaPreviewImage({ ...asset, mimeType: "image/jpeg" }, 1200).srcSet).toBeUndefined();
  });

  it("keeps a shelf thumbnail only when it covers the 16:9 frame", () => {
    const wide = {
      ...asset,
      thumbnails: [
        { url: "https://example.test/short.webp", width: 480, height: 120 },
        { url: "https://example.test/cover.webp", width: 960, height: 540 },
      ],
    };
    expect(mediaPreviewImage(wide, 480, 270)).toEqual({
      src: "https://example.test/cover.webp",
      srcSet: "https://example.test/cover.webp 960w",
      sizes: "480px",
      width: 2000,
      height: 1000,
    });
    expect(mediaPreviewImage({
      ...asset,
      thumbnails: [{ url: "https://example.test/short.webp", width: 480, height: 120 }],
    }, 480, 270)).toMatchObject({ src: asset.url, srcSet: undefined });
  });
});
