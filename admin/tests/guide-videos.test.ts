import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guideSearchPassages } from "../src/lib/guide-search";
import {
  GUIDE_SEARCH_PASSAGE_LIMIT,
  GUIDE_SEARCH_TEXT_LIMIT,
  GUIDE_VIDEOS,
} from "../src/lib/guide-video-assets";
import { guideHeadingSlug, guidePlaylistSlug } from "../src/lib/guide-videos";

const docsRoot = join(import.meta.dirname, "../../site/src/pages/_admin-docs");

function pageSource(slug: string): string {
  return readFileSync(join(docsRoot, slug, "index.md"), "utf8");
}

function guidePages(): Array<{ slug: string; title: string; description: string }> {
  return readdirSync(docsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const source = pageSource(entry.name);
      const title = /^title: (.+)$/m.exec(source)?.[1]?.replace(/^"|"$/g, "");
      const description = /^description: "([\s\S]*?)"$/m.exec(source)?.[1];
      if (!title || !description) throw new Error(`Missing guide frontmatter: ${entry.name}`);
      return { slug: entry.name, title, description };
    });
}

describe("Boardwalk guide videos", () => {
  it("places every tutorial in its guide section and on the playlist", () => {
    const playlist = pageSource("video-tutorials");
    expect(playlist.match(/<video\b/g)).toHaveLength(GUIDE_VIDEOS.length);
    const passages = guidePages().flatMap((page) => guideSearchPassages(pageSource(page.slug), page));

    for (const video of GUIDE_VIDEOS) {
      const source = pageSource(video.page);
      const headingAt = source.indexOf(`## ${video.heading}\n`);
      expect(headingAt, video.id).toBeGreaterThanOrEqual(0);
      const nextHeading = source.indexOf("\n## ", headingAt + video.heading.length);
      const section = source.slice(headingAt, nextHeading === -1 ? undefined : nextHeading);
      const src = `/guide-content/videos/${video.id}.mp4`;
      expect(section).toContain(src);
      expect(section).toContain('preload="none"');
      expect(section).toContain("controls");
      expect(section).not.toContain("autoplay");
      expect(section).toContain(`Transcript: ${video.title}`);
      expect(section).toContain(`/guide/video-tutorials#${guidePlaylistSlug(video.title)}`);
      expect(playlist).toContain(`## ${video.title}`);
      expect(playlist).toContain(src);
      expect(playlist).toContain(`/guide/${video.page}#${guideHeadingSlug(source, video.heading)}`);
      expect(passages.some((passage) => passage.text.includes(video.title))).toBe(true);
    }

    expect(passages.length).toBeGreaterThan(0);
    expect(passages.length).toBeLessThanOrEqual(GUIDE_SEARCH_PASSAGE_LIMIT);
    expect(passages.every((passage) => passage.text.length <= GUIDE_SEARCH_TEXT_LIMIT)).toBe(true);
    expect(passages.every((passage) => passage.url.startsWith("/guide/"))).toBe(true);
  });
});
