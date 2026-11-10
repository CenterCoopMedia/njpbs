import { describe, it, expect } from "vitest";
import { extractPassages } from "../src/search/build-corpus";
const page = (body: string, ignore = "") =>
  `<html ${ignore}><head><title>Guide</title></head><body><main data-pagefind-body>${body}</main></body></html>`;
describe("meaning search corpus boundary", () => {
  it("excludes private, noindex and ignored content from public passages", () => {
    for (const url of [
      "/wiki/secret/",
      "/admin/docs/",
      "/prototype/",
      "/design-system/",
    ])
      expect(extractPassages(page("<p>secret</p>"), url, "public")).toEqual([]);
    expect(
      extractPassages(
        page("<p>draft</p>", 'data-pagefind-ignore="all"'),
        "/draft/",
        "public",
      ),
    ).toEqual([]);
    expect(
      extractPassages(
        page(
          "<p>public words</p><section data-pagefind-ignore><p>private transcript</p></section>",
        ),
        "/about/",
        "public",
      )
        .map((p) => p.text)
        .join(" "),
    ).toBe("public words");
  });
  it("honors rendered robots exclusions independently of Pagefind attributes", () => {
    const html = page("<p>retired draft</p>").replace(
      "<head>",
      '<head><meta content="noindex, follow" name="robots">',
    );
    expect(extractPassages(html, "/retired/", "public")).toEqual([]);
  });
  it("indexes guide sections only in its separate scope with anchors", () => {
    const html = page(
      '<h1>Publishing</h1><h2 id="schedule">Schedule a story</h2><p>Choose a New York publication time.</p>',
      'data-pagefind-ignore="all"',
    );
    expect(
      extractPassages(html, "/admin/docs/publishing/", "guide"),
    ).toMatchObject([
      {
        url: "/admin/docs/publishing/#schedule",
        title: "Publishing: Schedule a story",
        text: "Choose a New York publication time.",
      },
    ]);
    expect(extractPassages(html, "/about/", "guide")).toEqual([]);
  });
  it("keeps passage size bounded and covers the middle of long pages", () => {
    const parts = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    const passages = extractPassages(
      page(`<p>${parts}</p>`),
      "/long/",
      "public",
    );
    expect(passages.every((p) => p.text.split(" ").length <= 180)).toBe(true);
    expect(passages.map((p) => p.text).join(" ")).toContain("word500");
    expect(new Set(passages.map((p) => p.id)).size).toBe(passages.length);
  });
});
