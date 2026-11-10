import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("article-only bio integration", () => {
  it("does not load the private profile catalog or research into public consumers", () => {
    for (const path of ["PostPresentation.astro", "PostPage.astro", "PostBlockList.astro", "PostBioEnhancement.astro"]) {
      expect(source(`../src/components/${path}`)).not.toMatch(/private-resources|public-bios\.json|nj-politics\.json|guide-content/);
    }
  });
});
