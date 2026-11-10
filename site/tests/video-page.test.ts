import { describe, expect, it } from "vitest";
import { hasVideoPlayer } from "../../packages/content-core/src/video-page";
import { renderHtmlBlock } from "../../packages/content-core/src/content-render";
import { renderVideoBlock } from "../../packages/content-core/src/video-block";

describe("video page analytics exclusion", () => {
  it("excludes a rendered native video block", () => {
    const html = renderVideoBlock({
      sourceId: "video-library", assetId: "clip", title: "Clip",
      public: {
        url: `https://media.njpbs.org/cms-media/video/clip/${"a".repeat(64)}.mp4`,
        posterUrl: `https://media.njpbs.org/cms-media/video/clip/${"b".repeat(64)}.jpg`,
        width: 1920, height: 1080, mimeType: "video/mp4",
      },
    });
    expect(hasVideoPlayer(html)).toBe(true);
    expect(hasVideoPlayer(renderHtmlBlock({ html }))).toBe(true);
  });

  it("detects an unquoted Vimeo iframe source inside an HTML block", () => {
    const html = '<iframe src=https://player.vimeo.com/video/123>';
    expect(hasVideoPlayer(html)).toBe(true);
    expect(hasVideoPlayer(renderHtmlBlock({ html }))).toBe(true);
  });

  it.each([
    '<iframe src="//player.vimeo.com/video/76979871"></iframe>',
    '<iframe src=//player.vimeo.com/video/76979871></iframe>',
    '<iframe src=https://player.vimeo.com/video/76979871></iframe>',
    '<iframe title="Video"src="https://player.vimeo.com/video/76979871"></iframe>',
    '<iframe/src="https://www.youtube.com/embed/od8NMua_mEw"></iframe>',
    '<iframe src="https://youtube.com/embed/od8NMua_mEw"></iframe>',
    '<iframe src="https://m.facebook.com/plugins/video.php"></iframe>',
    '<iframe src="https://web.facebook.com/plugins/video.php"></iframe>',
    '<iframe src="https://www.tiktok.com/player/v1/6718335390845095173"></iframe>',
    '<iframe src="https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Freel%2F2038437459890192%2F"></iframe>',
    '<script src="https://www.tiktok.com/embed.js"></script>',
    '<script src="//www.instagram.com/embed.js"></script>',
    '<script src=//platform.twitter.com/widgets.js></script>',
    '<script src="https://connect.facebook.net/en_US/sdk.js"></script>',
    '<video src="/sample.mp4"></video>',
  ])("excludes analytics for page content and escaped HTML blocks: %s", html => {
    expect(hasVideoPlayer(html)).toBe(true);
    expect(hasVideoPlayer(renderHtmlBlock({ html }))).toBe(true);
  });

  it.each([
    '<iframe src="https://other-player.example/embed"></iframe>',
    '<script src="https://other-player.example/embed.js"></script>',
    '<script src="https://jaws-prod.cdn.pbs.org/js/gc.js" data-schedule-loader></script>',
  ])("applies the broad external-source rule only inside Custom HTML: %s", html => {
    expect(hasVideoPlayer(html)).toBe(false);
    expect(hasVideoPlayer(renderHtmlBlock({ html }))).toBe(true);
  });

  it.each([
    '<a href="https://youtube.com/embed/od8NMua_mEw">Watch</a>',
    '<iframe src="/local-frame/"></iframe>',
    '<script src="https://njpbs.org/local.js"></script>',
    '<iframe src="//njpbs.org/local-frame/"></iframe>',
    '<script>console.log("local script")</script>',
    '<iframe src="http://["></iframe>',
  ])("keeps non-player content eligible for analytics: %s", html => {
    expect(hasVideoPlayer(html)).toBe(false);
    expect(hasVideoPlayer(renderHtmlBlock({ html }))).toBe(false);
  });
});
