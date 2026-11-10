import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("the public Post presentation", () => {
  it("keeps sharing off retired-slug redirect stubs", () => {
    const route = readSource("../src/pages/posts/[...slug].astro");

    expect(route).toMatch(
      /redirectFrom \? \([\s\S]*?<PermanentRedirect[\s\S]*?\) : \([\s\S]*?<PostPresentation/,
    );
  });

  it("treats blank Post metadata titles as Header inheritance", () => {
    const route = readSource("../src/pages/posts/[...slug].astro");

    expect(route).toContain("seoTitle={post.seo?.title?.trim() || undefined}");
    expect(route).toContain("socialTitle={post.social?.title?.trim() || post.title}");
  });
});
