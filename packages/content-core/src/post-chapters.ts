import { visibleLayoutBlocks } from "./content-layout";
import type {
  PageBlock,
  RichTextNode,
} from "./content-model";

export interface PostChapter {
  id: string;
  label: string;
  level: number;
  blockId: string;
}

function readableText(node: RichTextNode): string {
  return [node.text ?? "", ...(node.content ?? []).map(readableText)]
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function visitNodes(
  nodes: readonly RichTextNode[],
  visit: (node: RichTextNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if (node.content) visitNodes(node.content, visit);
  }
}

export function postChapterBaseId(label: string): string {
  const base = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return base || "section";
}

/**
 * Build report navigation from authored level-two headings in visible prose.
 *
 * The title is the page h1, so h2 is the report's chapter level. Generated ids
 * are deterministic within the immutable snapshot. Duplicate labels receive a
 * simple numeric suffix without showing chapter numbers in the interface.
 */
export function postChapters(blocks: readonly PageBlock[]): PostChapter[] {
  const chapters: PostChapter[] = [];
  const used = new Map<string, number>();

  for (const block of visibleLayoutBlocks(blocks)) {
    if (block.visible === false || block.type !== "prose") continue;
    visitNodes(block.data.content.content, (node) => {
      if (node.type !== "heading") return;
      const level = Number(node.attrs?.level ?? 2);
      if (level !== 2) return;
      const label = readableText(node);
      if (!label) return;

      const base = postChapterBaseId(label);
      const occurrence = (used.get(base) ?? 0) + 1;
      used.set(base, occurrence);
      chapters.push({
        id: occurrence === 1 ? `report-${base}` : `report-${base}-${occurrence}`,
        label,
        level,
        blockId: block.id,
      });
    });
  }

  return chapters;
}

function normalizedHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stateful resolver for the canonical rich-text renderer's heading-id hook. */
export function chapterHeadingIdResolver(
  chapters: readonly PostChapter[],
  blockId: string,
): (text: string, level: number) => string | undefined {
  const queue = chapters.filter((chapter) => chapter.blockId === blockId);
  let cursor = 0;

  return (text, level) => {
    const next = queue[cursor];
    if (
      !next ||
      next.level !== level ||
      next.label !== normalizedHeadingText(text)
    ) {
      return undefined;
    }
    cursor += 1;
    return next.id;
  };
}
