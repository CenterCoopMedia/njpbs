import { describe, expect, it } from "vitest";
import type {
  PageBlock,
  PromotionPlaylistBlock,
} from "../../packages/content-core/src/content-model";
import { admittedHomePromotions } from "../src/lib/home-admission";

const promotion: PromotionPlaylistBlock = {
  id: "manual-shelf",
  type: "promotion_playlist",
  order: 2,
  visible: true,
  data: {
    title: "Programs to watch",
    placement: "before_featured",
    cards: [1, 2, 3].map((number) => ({
      itemId: `item-${number}`,
      title: `Content ${number}`,
      summary: `Summary ${number}`,
      imageAssetId: `asset-${number}`,
      alt: `Content image ${number}`,
      href: `/watch/content-${number}/`,
    })),
  },
};

describe("Home content admission", () => {
  it("admits the manual content shelves and no unrelated visible Home block", () => {
    const blocks: readonly PageBlock[] = [
      {
        id: "heading",
        type: "headline",
        order: 0,
        visible: true,
        data: { text: "Saved Home heading" },
      },
      {
        id: "shelf",
        type: "content_shelf",
        order: 1,
        visible: true,
        data: {
          title: "Derived programs",
          source: "pbs_featured",
          itemLimit: 8,
          moreLabel: "Browse all",
          moreHref: "/watch/",
        },
      },
      promotion,
      {
        id: "copy",
        type: "prose",
        order: 3,
        visible: true,
        data: { content: { type: "doc", content: [] } },
      },
    ];

    expect(admittedHomePromotions([...blocks, { ...promotion, id: "second", order: 4 }])).toEqual([promotion, { ...promotion, id: "second", order: 4 }]);
  });

  it("returns no admitted block when Home has no manual content shelf", () => {
    const blocks: readonly PageBlock[] = [
      {
        id: "heading",
        type: "headline",
        order: 0,
        visible: true,
        data: { text: "Saved Home heading" },
      },
    ];

    expect(admittedHomePromotions(blocks)).toEqual([]);
  });
});
