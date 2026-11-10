import { describe, expect, it } from "vitest";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { chapterHeadingIdResolver, postChapters } from "../src/lib/post-chapters";

function prose(
  id: string,
  headings: Array<{ text: string; level?: number }>,
  visible = true,
): PageBlock {
  return {
    id,
    type: "prose",
    order: 0,
    visible,
    data: {
      content: {
        type: "doc",
        content: headings.map((heading) => ({
          type: "heading",
          attrs: { level: heading.level ?? 2 },
          content: [{ type: "text", text: heading.text }],
        })),
      },
    },
  };
}

describe("postChapters", () => {
  it("ignores hidden prose and empty headings", () => {
    expect(
      postChapters([
        prose("hidden", [{ text: "Hidden chapter" }], false),
        prose("empty", [{ text: "   " }]),
      ]),
    ).toEqual([]);
  });

  it("keeps duplicate labels unique without zero-padded display numbering", () => {
    expect(
      postChapters([
        prose("block", [
          { text: "Evidence" },
          { text: "Evidence" },
          { text: "Evidence" },
        ]),
      ]).map((chapter) => chapter.id),
    ).toEqual(["report-evidence", "report-evidence-2", "report-evidence-3"]);
  });
});

describe("chapterHeadingIdResolver", () => {
  it("assigns the extracted ids only to their matching rendered headings", () => {
    const chapters = postChapters([
      prose("block", [
        { text: "First chapter" },
        { text: "A detail", level: 3 },
        { text: "Second chapter" },
      ]),
    ]);
    const resolve = chapterHeadingIdResolver(chapters, "block");

    expect(resolve("A detail", 3)).toBeUndefined();
    expect(resolve("First chapter", 2)).toBe("report-first-chapter");
    expect(resolve("Second chapter", 2)).toBe("report-second-chapter");
    expect(resolve("Anything else", 2)).toBeUndefined();
  });
});
