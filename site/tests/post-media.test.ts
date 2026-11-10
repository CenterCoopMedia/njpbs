import { describe, expect, it } from "vitest";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import {
  assertMultimediaInventory,
  postMediaInventory,
  postMediaInventoryText,
} from "../src/lib/post-media";

const imageBlock: PageBlock = {
  id: "image",
  type: "image",
  order: 0,
  visible: true,
  data: { assetId: "asset-image", alt: "A newsroom." },
};
const galleryBlock: PageBlock = {
  id: "gallery",
  type: "image_gallery",
  order: 1,
  visible: true,
  data: {
    images: [
      { assetId: "asset-a", alt: "First view." },
      { assetId: "asset-b", alt: "Second view." },
    ],
  },
};

function embed(id: string, url: string, visible = true): PageBlock {
  return {
    id,
    type: "embed",
    order: 2,
    visible,
    data: { url },
  };
}

describe("postMediaInventory", () => {
  it("counts the lead image, ordinary images, gallery images, and usable media links", () => {
    expect(
      postMediaInventory({
        heroImage: { assetId: "hero" },
        blocks: [
          imageBlock,
          galleryBlock,
          embed("video", "https://www.youtube.com/watch?v=example"),
        ],
      }),
    ).toEqual({
      images: 4,
      galleries: 1,
      videos: 0,
      mediaLinks: 1,
      totalModules: 5,
    });
  });

  it("does not count hidden media", () => {
    expect(
      postMediaInventory({
        heroImage: null,
        blocks: [
          { ...imageBlock, visible: false },
          embed("hidden", "https://example.org/media", false),
        ],
      }),
    ).toEqual({
      images: 0,
      galleries: 0,
      videos: 0,
      mediaLinks: 0,
      totalModules: 0,
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["unsafe scheme", "javascript:alert(1)"],
    ["protocol relative", "//example.org/media"],
  ])("does not report an unusable %s embed as media", (_label, url) => {
    expect(
      postMediaInventory({
        heroImage: null,
        blocks: [embed("bad-link", url)],
      }),
    ).toEqual({
      images: 0,
      galleries: 0,
      videos: 0,
      mediaLinks: 0,
      totalModules: 0,
    });
  });

  it("counts a safe relative media destination exactly as the renderer does", () => {
    expect(
      postMediaInventory({
        heroImage: null,
        blocks: [embed("relative", "/watch/feature/")],
      }).mediaLinks,
    ).toBe(1);
  });

  it("counts a visible uploaded video as a media module and skips a hidden one", () => {
    const video = (id: string, visible: boolean): PageBlock => ({
      id,
      type: "video",
      order: 3,
      visible,
      data: { sourceId: "video-library", assetId: `asset-${id}`, title: "Interview" },
    });
    expect(
      postMediaInventory({ heroImage: null, blocks: [video("shown", true), video("hidden", false)] }),
    ).toEqual({ images: 0, galleries: 0, videos: 1, mediaLinks: 0, totalModules: 1 });
    expect(() =>
      assertMultimediaInventory(postMediaInventory({ heroImage: null, blocks: [video("only", true)] })),
    ).not.toThrow();
  });
});

describe("multimedia inventory copy", () => {
  it("uses plain singular and plural labels", () => {
    expect(
      postMediaInventoryText({
        images: 1,
        galleries: 0,
        videos: 0,
        mediaLinks: 2,
        totalModules: 3,
      }),
    ).toBe("1 image · 2 media links");
    expect(
      postMediaInventoryText({
        images: 0,
        galleries: 0,
        videos: 2,
        mediaLinks: 0,
        totalModules: 2,
      }),
    ).toBe("2 videos");
  });

  it("refuses a Multimedia Feature with no usable media to present", () => {
    expect(() =>
      assertMultimediaInventory({
        images: 0,
        galleries: 0,
        videos: 0,
        mediaLinks: 0,
        totalModules: 0,
      }),
    ).toThrow(/must include/);
  });
});
