import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
  chunkGuideSearchText,
  GUIDE_SEARCH_TEXT_LIMIT,
} from "./guide-video-assets";

export interface GuideSearchPassage {
  url: string;
  title: string;
  text: string;
}

export function guideSearchPassages(
  source: string,
  page: { slug: string; title: string; description: string },
): GuideSearchPassage[] {
  const tree = unified().use(remarkParse).parse(source);
  const slugger = new GithubSlugger();
  const passages: GuideSearchPassage[] = [];
  let title = page.title;
  let url = `/guide/${page.slug}`;
  let parts = [page.description];

  const emit = () => {
    const text = parts.join(" ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    for (const chunk of chunkGuideSearchText(text)) {
      if (chunk.length > GUIDE_SEARCH_TEXT_LIMIT) {
        throw new Error(`Boardwalk guide search passage is too long: ${url}`);
      }
      passages.push({ url, title, text: chunk });
    }
    parts = [];
  };

  for (const node of tree.children) {
    if (node.type === "heading" && node.depth <= 3) {
      emit();
      const heading = toString(node).replace(/\s+/g, " ").trim();
      title = heading ? `${page.title}: ${heading}` : page.title;
      url = heading ? `/guide/${page.slug}#${slugger.slug(heading)}` : `/guide/${page.slug}`;
      continue;
    }
    const value = toString(node).trim();
    if (value) parts.push(value);
  }
  emit();
  return passages;
}
