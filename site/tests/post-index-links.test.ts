import { describe, expect, it } from "vitest";
import { postCreditHref, postIndexFilterHref } from "../src/lib/post-index-links";

describe("Post index filter links", () => {
  it("encodes category, tag, and byline values as one exact filter", () => {
    expect(postIndexFilterHref("category", "Station News")).toBe(
      "/posts/?category=Station+News",
    );
    expect(postIndexFilterHref("tag", "People & Culture")).toBe(
      "/posts/?tag=People+%26+Culture",
    );
    expect(postIndexFilterHref("by", "NJ PBS staff")).toBe(
      "/posts/?by=NJ+PBS+staff",
    );
  });

  it("links public authors and custom credits but not withdrawn authors", () => {
    expect(
      postCreditHref({ name: "Pat Reporter", authorId: "au_pat", slug: "pat-reporter" }),
    ).toBe("/authors/pat-reporter/");
    expect(postCreditHref({ name: "Pat Reporter", authorId: "au_pat" })).toBeNull();
    expect(postCreditHref({ name: "NJ PBS staff" })).toBe(
      "/posts/?by=NJ+PBS+staff",
    );
  });
});
