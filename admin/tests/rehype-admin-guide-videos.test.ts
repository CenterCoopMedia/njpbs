import { describe, expect, it } from "vitest";
import { rewriteGuideHtml } from "../../site/src/lib/rehype-admin-guide-videos.mjs";

describe("internal guide video links", () => {
  it("sends raw tutorial HTML to the staff host", () => {
    const html = [
      '<video controls src="/guide-content/videos/analytics.mp4"><track src="/guide-content/videos/analytics.vtt"></video>',
      '<a href="/guide/analytics#start-with-a-newsroom-question">Analytics</a>',
    ].join("\n");
    const rewritten = rewriteGuideHtml(html);
    expect(rewritten).not.toContain("/guide-content/videos/");
    expect(rewritten).toContain('href="https://admin.njpbs.org/guide/video-tutorials"');
    expect(rewritten).toContain('href="https://admin.njpbs.org/guide/analytics#start-with-a-newsroom-question"');
  });
});
