import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comparePostHtml, postHtmlSemantics } from "../src/lib/post-html-comparison";
const html = readFileSync(resolve("tests/fixtures/shadow-posts/static.html"), "utf8");

describe("offline shadow comparison", () => {
  it("extracts literal content, media, links and SEO from a fixture", () => {
    const parsed = postHtmlSemantics(html);
    expect(parsed.title).toBe("A published fixture | NJ PBS");
    expect(parsed.bodyText).toBe("A published fixture Published body with a link .");
    expect(parsed.mediaSources).toContain("source:src:https://media.njpbs.org/cms-media/video/fixture/video.mp4");
    expect(parsed.links).toEqual(["/about/|a link"]);
    expect(parsed.headTags.join(" ")).toContain("https://njpbs.org/posts/shadow-fixture/");
  });
  it("ignores attribute order and harmless HTML formatting", () => {
    expect(comparePostHtml(html, html.replace('name="description" content="Published fixture summary."', 'content="Published fixture summary." name="description"').replace("<p>", "\n<p>\n"))).toEqual([]);
  });
  it.each([
    ["title", "A published fixture | NJ PBS", "Changed title"],
    ["bodyText", "Published body with", "Changed body with"],
    ["mediaSources", "fixture/video.mp4", "fixture/new.mp4"],
    ["links", 'href="/about/"', 'href="/contact/"'],
    ["headTags", "https://njpbs.org/posts/shadow-fixture/", "https://dev-public.example.org/posts/shadow-fixture/"],
  ])("reports %s changes", (field, old, next) => {
    expect(comparePostHtml(html, html.replace(old, next)).map(value => value.field)).toContain(field);
  });
  it("rejects an error document instead of reporting parity", () => {
    expect(() => comparePostHtml(html, "<html><head><title>Error</title></head><body>Error</body></html>")).toThrow();
  });
});
