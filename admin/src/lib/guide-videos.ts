import GithubSlugger from "github-slugger";
import { GUIDE_VIDEOS } from "./guide-video-assets";

export function guideHeadingSlug(markdown: string, heading: string): string {
  const slugger = new GithubSlugger();
  let found: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^##\s+(.+)$/.exec(line);
    if (!match) continue;
    const slug = slugger.slug(match[1]);
    if (match[1] === heading) found = slug;
  }
  if (!found) throw new Error(`Missing guide heading: ${heading}`);
  return found;
}

export function guidePlaylistSlug(title: string): string {
  const slugger = new GithubSlugger();
  let found: string | null = null;
  for (const video of GUIDE_VIDEOS) {
    const slug = slugger.slug(video.title);
    if (video.title === title) found = slug;
  }
  if (!found) throw new Error(`Missing guide video: ${title}`);
  return found;
}
