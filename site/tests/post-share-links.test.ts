import { describe, expect, it } from "vitest";
import { buildPostShareLinks } from "../src/lib/post-share-links";

describe("post share links", () => {
  it("builds each service destination from one canonical title and URL", () => {
    const links = buildPostShareLinks({
      title: "Water & power: New Jersey's next chapter",
      url: "https://njpbs.org/posts/water-and-power/",
    });

    expect(links).toEqual({
      title: "Water & power: New Jersey's next chapter",
      email:
        "mailto:?subject=Water%20%26%20power%3A%20New%20Jersey's%20next%20chapter&body=https%3A%2F%2Fnjpbs.org%2Fposts%2Fwater-and-power%2F",
      facebook:
        "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fnjpbs.org%2Fposts%2Fwater-and-power%2F",
      x: "https://x.com/intent/tweet?text=Water%20%26%20power%3A%20New%20Jersey's%20next%20chapter&url=https%3A%2F%2Fnjpbs.org%2Fposts%2Fwater-and-power%2F",
      linkedin:
        "https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fnjpbs.org%2Fposts%2Fwater-and-power%2F",
    });
  });

  it("removes unsafe subject controls while preserving a readable title", () => {
    const links = buildPostShareLinks({
      title: "  Breaking\r\n\tnews\u0000\u007f\u0085 update  ",
      url: "https://njpbs.org/posts/breaking-news/",
    });

    expect(links.title).toBe("Breaking news update");
    expect(links.email).toBe(
      "mailto:?subject=Breaking%20news%20update&body=https%3A%2F%2Fnjpbs.org%2Fposts%2Fbreaking-news%2F",
    );
    expect(links.x).toContain("text=Breaking%20news%20update&url=");
    expect(links.email).not.toMatch(/%0[0-9A-F]|%7F/i);
  });

  it.each([
    "",
    "/posts/local-only/",
    "javascript:alert(1)",
    "ftp://njpbs.org/posts/story/",
    "https://example.com/posts/story/",
    "https://njpbs.org/posts/",
    "https://njpbs.org/posts/story/extra/",
    "https://njpbs.org/posts/story/?ref=share",
    "https://njpbs.org/posts/story/#section",
  ])("rejects a noncanonical public URL: %s", (url) => {
    expect(() => buildPostShareLinks({ title: "Story", url })).toThrow(
      /canonical nj pbs post url/i,
    );
  });

  it("requires the published title used by the native and service actions", () => {
    for (const title of ["   ", "\r\n\t\u0000"]) {
      expect(() =>
        buildPostShareLinks({
          title,
          url: "https://njpbs.org/posts/story/",
        }),
      ).toThrow(/published post title/i);
    }
  });
});
