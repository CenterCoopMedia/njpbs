import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Safety guard for the public OKF wiki render. The render must never link to this
// project's own GitHub repo: the repo is private today, but a "View source" /
// "Source on GitHub" link would expose every internal wiki file one click from
// the public render the moment the repo is made public. Curation must not depend
// on the repo staying private, so we pin the absence of any such link at the
// source level (the links live in .astro templates, not in unit-testable code).

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, "..");

const renderSources = [
  "src/layouts/WikiLayout.astro",
  "src/components/WikiNavigation.astro",
  "src/pages/wiki/[...slug].astro",
  "src/pages/wiki/index.astro",
  "src/lib/wiki.ts",
];

describe("public wiki render links nowhere into the project repo", () => {
  for (const rel of renderSources) {
    it(`${rel} has no github.com/jamditis/njpbs-site reference`, () => {
      const src = readFileSync(join(siteRoot, rel), "utf8");
      expect(src).not.toContain("github.com/jamditis/njpbs-site");
    });
  }
});

describe("public wiki search indexing remains disabled", () => {
  it("renders every wiki page with robots noindex", () => {
    const layout = readFileSync(
      join(siteRoot, "src/layouts/WikiLayout.astro"),
      "utf8",
    );
    expect(layout).toContain("noindex={true}");
  });

  it("keeps wiki routes out of the sitemap", () => {
    const config = readFileSync(join(siteRoot, "astro.config.mjs"), "utf8");
    expect(config).toContain('!page.includes("/wiki/")');
  });
});
