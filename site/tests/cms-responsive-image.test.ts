import { describe, expect, it, vi } from "vitest";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import {
  cmsResponsiveImageRequests,
  resolveCmsResponsiveAssets,
  resolveCmsResponsiveImage,
  resolveCmsPostAssets,
  responsiveImageKey,
} from "../src/lib/cms-responsive-image";

const optimizer = vi.fn(
  async (options: {
    src: string;
    width: number;
    height: number;
    widths: number[];
    format: string;
  }) => ({
    src: `/_astro/${options.format}-${options.width}.image`,
    srcSet: {
      attribute: options.widths
        .map((width) => `/_astro/${options.format}-${width}.image ${width}w`)
        .join(", "),
    },
  }),
);

describe("CMS responsive image adapter", () => {
  it("builds bounded AVIF and WebP sources plus the input-MIME fallback", async () => {
    optimizer.mockClear();

    const image = await resolveCmsResponsiveImage(
      {
        url: "https://media.njpbs.org/cms-media/2026/08/mural.jpg",
        mimeType: "image/jpeg",
        width: 1000,
        height: 563,
      },
      "content",
      optimizer,
    );

    expect(optimizer).toHaveBeenCalledTimes(3);
    expect(optimizer.mock.calls.map(([call]) => call.format)).toEqual([
      "avif",
      "webp",
      "jpeg",
    ]);
    for (const [call] of optimizer.mock.calls) {
      expect(call.widths).toEqual([320, 480, 640, 960, 1000]);
      expect(Math.max(...call.widths)).toBeLessThanOrEqual(1000);
      expect(call).toMatchObject({
        src: "https://media.njpbs.org/cms-media/2026/08/mural.jpg",
        width: 1000,
        height: 563,
      });
    }
    expect(image).toEqual({
      url: "/_astro/jpeg-1000.image",
      mimeType: "image/jpeg",
      width: 1000,
      height: 563,
      srcset:
        "/_astro/jpeg-320.image 320w, /_astro/jpeg-480.image 480w, /_astro/jpeg-640.image 640w, /_astro/jpeg-960.image 960w, /_astro/jpeg-1000.image 1000w",
      sizes: "(max-width: 1184px) calc(100vw - 64px), 1120px",
      sources: [
        {
          type: "image/avif",
          srcset:
            "/_astro/avif-320.image 320w, /_astro/avif-480.image 480w, /_astro/avif-640.image 640w, /_astro/avif-960.image 960w, /_astro/avif-1000.image 1000w",
        },
        {
          type: "image/webp",
          srcset:
            "/_astro/webp-320.image 320w, /_astro/webp-480.image 480w, /_astro/webp-640.image 640w, /_astro/webp-960.image 960w, /_astro/webp-1000.image 1000w",
        },
      ],
    });
  });

  it("uses the grid width contract, never upscales, and deduplicates a WebP fallback", async () => {
    optimizer.mockClear();

    const image = await resolveCmsResponsiveImage(
      {
        url: "https://njpbs.org/brand/spotlight/watch.webp",
        mimeType: "image/webp",
        width: 500,
        height: 281,
      },
      "grid",
      optimizer,
    );

    expect(optimizer).toHaveBeenCalledTimes(2);
    expect(optimizer.mock.calls.map(([call]) => call.format)).toEqual([
      "avif",
      "webp",
    ]);
    expect(optimizer.mock.calls[0]?.[0].widths).toEqual([240, 320, 480, 500]);
    expect(image.url).toBe("/_astro/webp-500.image");
    expect(image.sizes).toBe(
      "(max-width: 560px) calc(100vw - 48px), (max-width: 1120px) calc(50vw - 32px), 320px",
    );
  });

  it("does not add an intrinsic-size derivative above the fixed placement ceiling", async () => {
    optimizer.mockClear();

    const image = await resolveCmsResponsiveImage(
      {
        url: "https://media.njpbs.org/cms-media/2026/08/large.png",
        mimeType: "image/png",
        width: 4000,
        height: 2000,
      },
      "content",
      optimizer,
    );

    expect(optimizer).toHaveBeenCalledTimes(3);
    for (const [call] of optimizer.mock.calls) {
      expect(call.widths).toEqual([320, 480, 640, 960, 1280]);
      expect(call).toMatchObject({ width: 1280, height: 640 });
    }
    expect(image).toMatchObject({ width: 4000, height: 2000 });
  });

  it("keeps a GIF on its immutable original so animation is not destroyed", async () => {
    optimizer.mockClear();
    const asset = {
      url: "https://media.njpbs.org/cms-media/2026/08/animation.gif",
      mimeType: "image/gif" as const,
      width: 400,
      height: 240,
    };

    await expect(
      resolveCmsResponsiveImage(asset, "content", optimizer),
    ).resolves.toEqual(asset);
    expect(optimizer).not.toHaveBeenCalled();
  });

  it("does not advertise variants when the optimizer returns the original URL", async () => {
    const asset = {
      url: "https://media.njpbs.org/cms-media/2026/08/original.jpg",
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    };
    await expect(resolveCmsResponsiveImage(asset, "content", async ({ src }) => ({
      src,
      srcSet: { attribute: `${src} 320w, ${src} 640w` },
    }))).resolves.toEqual(asset);
  });

  it("collects each referenced asset and placement once", () => {
    const parsed = parseBlocks([
      {
        id: "image",
        type: "image",
        order: 0,
        visible: true,
        data: { assetId: "hero", alt: "Hero" },
      },
      {
        id: "gallery",
        type: "image_gallery",
        order: 1,
        visible: true,
        data: { images: [{ assetId: "hero", alt: "Detail" }] },
      },
      {
        id: "cards",
        type: "card_grid",
        order: 2,
        visible: true,
        data: {
          cards: [
            { title: "One", imageAssetId: "card" },
            { title: "Two", imageAssetId: "card" },
          ],
        },
      },
    ]);
    if (!parsed.ok) throw new Error(parsed.error);

    expect(cmsResponsiveImageRequests(parsed.blocks)).toEqual([
      { assetId: "hero", placement: "content" },
      { assetId: "hero", placement: "grid" },
      { assetId: "card", placement: "grid" },
    ]);
    expect(responsiveImageKey("hero", "grid")).not.toBe(
      responsiveImageKey("hero", "content"),
    );
  });

  it("resolves bio portraits at grid size and skips hidden or imageless bios", () => {
    const data = {
      profileId: "sample-person", kind: "person", name: "Sample Person", role: "Mayor",
      summary: "Leads the municipal government.", sourceUrl: "https://example.org/mayor",
      sourceLabel: "Official biography", asOf: "2026-10-03",
    };
    const parsed = parseBlocks([
      { id: "bio", type: "bio_card", order: 0, visible: true,
        data: { ...data, image: { assetId: "portrait", alt: "Sample Person" } } },
      { id: "repeat", type: "bio_card", order: 1, visible: true,
        data: { ...data, image: { assetId: "portrait", alt: "Sample Person" } } },
      { id: "hidden", type: "bio_card", order: 2, visible: false,
        data: { ...data, image: { assetId: "unpublished", alt: "Sample Person" } } },
      { id: "no-photo", type: "bio_card", order: 3, visible: true, data },
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(cmsResponsiveImageRequests(parsed.blocks)).toEqual([
      { assetId: "portrait", placement: "grid" },
    ]);
  });

  it("omits an empty promotion image from an incomplete draft", () => {
    const parsed = parseBlocks([{
      id: "draft-shelf",
      type: "promotion_playlist",
      order: 0,
      visible: true,
      data: { title: "", placement: "before_featured", cards: [{
        itemId: "draft-card",
        title: "",
        summary: "",
        imageAssetId: "",
        alt: "",
        href: "",
      }] },
    }], { complete: false });
    if (!parsed.ok) throw new Error(parsed.error);

    expect(cmsResponsiveImageRequests(parsed.blocks)).toEqual([]);
  });

  it("resolves the unique request map and fails closed when one asset is absent", async () => {
    const parsed = parseBlocks([
      {
        id: "cards",
        type: "card_grid",
        order: 0,
        visible: true,
        data: { cards: [{ title: "Watch", imageAssetId: "watch" }] },
      },
    ]);
    if (!parsed.ok) throw new Error(parsed.error);
    const asset = {
      url: "https://njpbs.org/brand/spotlight/watch.jpg",
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    };

    const resolved = await resolveCmsResponsiveAssets(
      parsed.blocks,
      { watch: asset },
      optimizer,
    );
    expect(resolved.get(responsiveImageKey("watch", "grid"))).toMatchObject({
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
      sources: [
        { type: "image/avif" },
        { type: "image/webp" },
      ],
    });
    await expect(
      resolveCmsResponsiveAssets(parsed.blocks, {}, optimizer),
    ).rejects.toThrow(/missing: watch/);
  });
});


it("preserves current credit through transformed, unchanged and GIF descriptors; Post originals need no optimizer", async () => {
  const asset = { url: "https://media.njpbs.org/cms-media/news/image/hash.webp", mimeType: "image/webp", width: 1600, height: 900, credit: "Current credit" };
  expect((await resolveCmsResponsiveImage(asset, "content", optimizer)).credit).toBe(asset.credit);
  const noop = vi.fn(async ({ src }: { src: string }) => ({ src, srcSet: { attribute: "" } }));
  expect(await resolveCmsResponsiveImage(asset, "content", noop)).toEqual(asset);
  expect(await resolveCmsResponsiveImage({ ...asset, mimeType: "image/gif" }, "content", noop)).toEqual({ ...asset, mimeType: "image/gif" });
  const blocks = parseBlocks([{ id: "image", type: "image", visible: true, order: 0, data: { assetId: "image", alt: "Context" } }]);
  if (!blocks.ok) throw new Error(blocks.error);
  expect((await resolveCmsPostAssets(blocks.blocks, { image: asset })).get("content:image")).toEqual(asset);
});
