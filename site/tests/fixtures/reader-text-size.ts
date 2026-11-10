import { postLeadFixture, type LEAD_LAYOUTS } from "./post-lead-media";

/** Reader proof copy shared by template tests and local visual checks. */
export function readingPostFixture(layout: typeof LEAD_LAYOUTS[number]) {
  const read = postLeadFixture(layout, "image");
  const prose = read.document.published.blocks.find(block => block.type === "prose")!;
  const content = prose.data.content as { type: string; content: unknown[] };
  content.content.push(
    { type: "paragraph", content: [{ type: "text", text: "Readers can choose a comfortable text size while exploring stories from across New Jersey. The page keeps its familiar headings, photographs and navigation." }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Lists follow the selected reading size too." }] }] }] },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "A comfortable reading experience should travel from one story to the next." }] }] },
  );
  return read;
}
