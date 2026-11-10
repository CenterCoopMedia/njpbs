// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertLiveBlogData, type LiveBlogData } from "../../packages/content-core/src/live-blog";
import { renderRichText } from "../../packages/content-core/src/content-model";
import { liveBlogPostingJsonLd } from "../src/lib/live-blog-structured-data";
import { jsonLdHtml } from "../src/lib/structured-data";
import { liveBlogPostFixture } from "./fixtures/live-blog-post";

function data(state: LiveBlogData["coverageState"] = "ongoing") {
  const metadata = liveBlogPostFixture({ state }).document.published.metadata;
  return liveBlogPostingJsonLd({ postId: "post-one", title: String(metadata.title), canonicalPath: "/posts/live-blog-local/",
    datePublished: "2026-10-25", liveBlog: metadata.liveBlog as LiveBlogData, site: "https://njpbs.org" });
}
describe("published live blog structured data", () => {
  it("uses the real snapshot's current corrected text and omits withdrawn reporting", () => {
    const result = data()!;
    expect(result).toMatchObject({ "@context": "https://schema.org", "@type": "LiveBlogPosting", headline: "Live coverage across New Jersey",
      url: "https://njpbs.org/posts/live-blog-local/", datePublished: "2026-10-25", dateModified: "2026-10-25T15:00:00.000Z",
      coverageStartTime: "2026-10-25T14:58:00.000Z" });
    expect(result).not.toHaveProperty("coverageEndTime");
    const entries = result.liveBlogUpdate as Record<string, unknown>[];
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ "@type": "BlogPosting", "@id": "https://njpbs.org/posts/live-blog-local/#live-blog-8-post-one-entry-9-entry-two",
      headline: "Meeting location corrected", datePublished: "2026-10-25T14:59:00.000Z", dateModified: "2026-10-25T15:00:00.000Z",
      articleBody: "The meeting will be in the community room." });
    expect(JSON.stringify(entries)).not.toContain("entry-three");
  });
  it("omits LiveBlogPosting for ended coverage and never invents an end instant", () => {
    expect(data("ended")).toBeNull();
    expect(data("paused")).not.toHaveProperty("coverageEndTime");
  });
  it("includes only reporting the canonical renderer displays from an accepted snapshot", () => {
    const blog = liveBlogPostFixture().document.published.metadata.liveBlog as LiveBlogData;
    blog.updates[0].body = { type: "doc", text: "Hidden container claim", content: [
      { type: "paragraph", text: "Hidden paragraph claim", content: [
        { type: "text", text: "Verified reporting", content: [{ type: "text", text: "Hidden text child" }] },
        { type: "hardBreak", text: "Hidden break claim", content: [{ type: "text", text: "Hidden break child" }] },
      ] },
      { type: "horizontalRule", text: "Hidden rule claim", content: [{ type: "text", text: "Hidden rule child" }] },
    ] };
    expect(() => assertLiveBlogData(blog, { complete: true })).not.toThrow();
    expect(renderRichText(blog.updates[0].body)).toBe("<p>Verified reporting<br></p><hr>");
    const result = liveBlogPostingJsonLd({ postId: "post-one", title: "Coverage", canonicalPath: "/posts/live-blog-local/",
      datePublished: null, liveBlog: blog, site: "https://njpbs.org" })!;
    expect((result.liveBlogUpdate as Record<string, unknown>[])[0].articleBody).toBe("Verified reporting");
    expect(JSON.stringify(result)).not.toContain("Hidden");
  });
  it("keeps rich text plain and safely escapes a script terminator", () => {
    const fixture = liveBlogPostFixture();
    const blog = fixture.document.published.metadata.liveBlog as LiveBlogData;
    blog.updates[0].body = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Current ", marks: [{ type: "bold" }] }, { type: "text", text: "report" }] },
      { type: "paragraph", content: [{ type: "text", text: "</script><script>unsafe</script>" }] },
    ] };
    const result = liveBlogPostingJsonLd({ postId: "post-one", title: "Coverage", canonicalPath: "/posts/live-blog-local/",
      datePublished: null, liveBlog: blog, site: "https://njpbs.org" });
    const serialized = jsonLdHtml(result!);
    expect(serialized).not.toContain("</script>");
    expect((JSON.parse(serialized).liveBlogUpdate[0]).articleBody).toBe("Current report\n</script><script>unsafe</script>");
  });
});
