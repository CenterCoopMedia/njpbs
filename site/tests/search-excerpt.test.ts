import { describe, expect, it } from "vitest";
import { pagefindExcerpt, plainExcerpt } from "../src/lib/search-excerpt";

describe("search excerpts", () => {
  it("keeps relevance highlights and indicates both omitted ends", () => {
    const result = pagefindExcerpt(
      'the <mark class="ignored">school</mark> budget',
      "Earlier: the school budget was approved.",
    );
    expect(result.textContent).toBe("… the school budget …");
    expect(result.querySelector("mark")?.textContent).toBe("school");
    expect(result.querySelector("mark")?.attributes.length).toBe(0);
  });
  it("does not infer a selected occurrence from repeated text", () => {
    const excerpt = "<mark>news</mark> bulletin";
    expect(
      pagefindExcerpt(excerpt, "news bulletin followed by news bulletin")
        .textContent,
    ).toBe("news bulletin");
    expect(
      pagefindExcerpt(excerpt, "Intro news bulletin followed by news bulletin")
        .textContent,
    ).toBe("… news bulletin");
    expect(
      pagefindExcerpt(excerpt, "news bulletin followed by news bulletin end")
        .textContent,
    ).toBe("news bulletin …");
    expect(
      pagefindExcerpt(
        excerpt,
        "Intro news bulletin followed by news bulletin end",
      ).textContent,
    ).toBe("… news bulletin …");
  });
  it("normalizes whitespace across highlights without inventing omissions", () => {
    const result = pagefindExcerpt(
      "  the\n <mark>school</mark>\t budget  ",
      " the school budget ",
    );
    expect(result.textContent).toBe("the school budget");
    expect(pagefindExcerpt("budget", "the budget").textContent).toBe(
      "… budget",
    );
    expect(pagefindExcerpt("the", "the budget").textContent).toBe("the …");
    expect(pagefindExcerpt("unknown", "different content").textContent).toBe(
      "unknown",
    );
  });
  it("compares decoded excerpt entities with literal Pagefind content", () => {
    const result = pagefindExcerpt(
      "Arts &amp; <mark>culture</mark> &lt;guide&gt;",
      "Explore Arts & culture <guide> today",
    );
    expect(result.textContent).toBe("… Arts & culture <guide> …");
    expect(result.querySelector("mark")?.textContent).toBe("culture");
    expect(result.querySelector("guide")).toBeNull();
  });
  it("emits only text and clean highlights, without executable markup", () => {
    const result = pagefindExcerpt(
      '<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">safe</a> <mark onclick="alert(1)">text</mark>',
    );
    expect(result.textContent).toBe("safe text");
    expect(
      [...result.querySelectorAll("*")].map((node) => node.tagName),
    ).toEqual(["MARK"]);
    expect(result.querySelector("mark")?.attributes.length).toBe(0);
  });
  it("truncates plain text at whole words and marks only actual cuts", () => {
    expect(plainExcerpt(" short\ntext ", 20)).toBe("short text");
    expect(plainExcerpt("one two three four", 9)).toBe("one two …");
    expect(plainExcerpt("one two", 7)).toBe("one two");
    expect(plainExcerpt("longword next", 4)).toBe("…");
    expect(plainExcerpt("longword", 4)).toBe("…");
  });
});
