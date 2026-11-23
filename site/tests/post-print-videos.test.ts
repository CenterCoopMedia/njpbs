import { expect, it } from "vitest";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { postPrintVideoUrls } from "../src/lib/post-print-videos";

it("prints each public video once and skips unpublished, hidden and non-video embeds", () => {
  const embed = (id: string, url: string, visible = true): PageBlock => ({
    id, type: "embed", order: 0, visible, data: { url },
  });
  const publicVideoUrl = `https://media.njpbs.org/cms-media/video/fixture-video/${"a".repeat(64)}.mp4`;
  const video = { sourceId: "video-library", assetId: "fixture-video", title: "Train departure", public: {
    url: publicVideoUrl, posterUrl: `https://media.njpbs.org/cms-media/video/fixture-video/${"b".repeat(64)}.jpg`,
    width: 640, height: 360, mimeType: "video/mp4",
  } } as const;
  const blocks: PageBlock[] = [
    embed("pasted", '<iframe src="https://www.youtube.com/embed/abcdefghijk?start=30"></iframe>'),
    embed("body-video", "https://vimeo.com/456"),
    { id: "hidden-row", type: "row", order: 0, visible: false, data: { columns: [12] } },
    { ...embed("in-hidden-row", "https://youtu.be/lmnopqrstuv"), layout: { rowId: "hidden-row", column: 0 } },
    embed("hidden", "https://vimeo.com/123", false),
    embed("ordinary-link", "https://example.org/document"),
    { id: "unpublished", type: "video", order: 0, visible: true,
      data: { sourceId: "video-library", assetId: "pending", title: "Pending" } },
    { id: "scroll", type: "scroll_story", order: 0, visible: true, data: { steps: [
      { text: "Train departure.", assetId: "", alt: "", caption: "", video },
    ] } },
    { id: "body-copy", type: "video", order: 0, visible: true, data: video },
  ];
  const lead = { kind: "embed", data: { url: "https://youtu.be/abcdefghijk?t=30", title: "Interview" } };
  expect(postPrintVideoUrls(lead, blocks)).toEqual([
    "https://www.youtube-nocookie.com/embed/abcdefghijk?start=30",
    "https://player.vimeo.com/video/456?dnt=1",
    publicVideoUrl,
  ]);
});
