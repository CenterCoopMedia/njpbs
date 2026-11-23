import { describe, expect, it } from "vitest";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { createReadingSections } from "../../packages/content-core/src/reading-sections";

const renderHeadings = (headings: [number, string][], sectionHeadingId: ReturnType<typeof createReadingSections>["addHeading"]) => {
  const block: PageBlock = {
    id: "body", order: 0, visible: true, type: "prose",
    data: { content: { type: "doc", content: headings.map(([level, text]) => ({
      type: "heading", attrs: { level }, content: [{ type: "text", text }],
    })) } },
  };
  return renderBlock(block, { sectionHeadingId });
};

describe("Reading section links", () => {
  it("uses H2 labels from both authored heading forms with unique focus targets", () => {
    const sections = createReadingSections();
    const headline: PageBlock = {
      id: "headline", order: 0, visible: true, type: "headline", data: { text: "News & notes", level: 2 },
    };
    const first = renderBlock(headline, { sectionHeadingId: sections.addHeading });
    const more = renderHeadings([[3, "Detail"], [2, ""], [2, "News & notes 2"], [2, "News & notes"]], sections.addHeading);
    const ids = ["reading-section-news-notes", "reading-section-news-notes-2", "reading-section-news-notes-3"];
    expect([...sections.renderIndex().matchAll(/href="#([^"]+)"/g)].map(match => match[1])).toEqual(ids);
    expect([...(first + more).matchAll(/<h2 id="([^"]+)" tabindex="-1">/g)].map(match => match[1])).toEqual(ids);
    expect(sections.renderIndex()).toContain("News &amp; notes");
  });

  it.each([" ", "One section"])("omits the section box with fewer than two non-empty H2s (%j)", text => {
    const sections = createReadingSections();
    renderHeadings([[2, text], [3, "Detail"]], sections.addHeading);
    expect(sections.renderIndex()).toBe("");
  });
});
