// @vitest-environment node
// Base.astro carries the site-wide accessibility floor: the one style layer
// shared by every shell (apex launch, inner subpages, wiki). These rules are
// easy to drop in a refactor and invisible until an assistive-tech user hits the
// gap, so they are pinned here rather than left to hope. The contrast lock in
// contrast.test.ts guards the color tokens; this guards the structural floor.
//
// Assertions run against the <style is:global> block with CSS comments stripped,
// so a commented-out or relocated rule cannot satisfy them by leaving the text in
// the file. The build remains the authoritative gate; this is the fast tripwire.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = readFileSync(
  fileURLToPath(new URL("../src/layouts/Base.astro", import.meta.url)),
  "utf8",
);

// The concatenated contents of every <style is:global> block, with CSS comments
// removed. Matching against this (not the raw file) means a rule that is commented
// out, or sitting in a script/HTML comment, does not count as present.
const GLOBAL_CSS = [...BASE.matchAll(/<style is:global>([\s\S]*?)<\/style>/g)]
  .map((m) => m[1])
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const STYLE_SOURCES = (readdirSync(SOURCE_ROOT, { recursive: true }) as string[])
  .filter((path) => /\.(?:astro|css)$/.test(path))
  .map((path) => ({
    path: path.replaceAll("\\", "/"),
    css: readFileSync(join(SOURCE_ROOT, path), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
  }));

function reducedMotionBlocks(css: string): string[] {
  const blocks: string[] = [];
  const media = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;

  while (media.exec(css) !== null) {
    const contentStart = media.lastIndex;
    let cursor = contentStart;
    let depth = 1;

    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }

    blocks.push(css.slice(contentStart, cursor - 1));
    media.lastIndex = cursor;
  }

  return blocks;
}

function transformNoneSelectors(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , declarations]) =>
      /(?:^|;)\s*transform\s*:\s*none\s*(?:!important\s*)?(?:;|$)/.test(declarations),
    )
    .flatMap(([, selectors]) => selectors.split(","))
    .map((selector) => selector.replace(/\s+/g, " ").trim());
}

function dataMotionSelector(selector: string): string | null {
  const prefix = /^(?::global\()?html\[data-motion=["']off["']\]\)?\s+/;
  return prefix.test(selector) ? selector.replace(prefix, "") : null;
}

describe("Base.astro ships the site-wide accessibility floor", () => {
  it("has a non-empty global style block", () => {
    expect(GLOBAL_CSS.trim().length).toBeGreaterThan(0);
  });

  it("defines the .sr-only utility used for new-tab and other screen-reader cues", () => {
    // Components render <span class="sr-only"> ...</span>; without this rule the
    // cue text would be visible. Pin the class and its visually-hidden mechanic.
    expect(GLOBAL_CSS).toMatch(/\.sr-only\s*\{/);
    expect(GLOBAL_CSS).toMatch(/clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
  });

  it("provides a keyboard :focus-visible outline for every interactive element", () => {
    expect(GLOBAL_CSS).toMatch(/:focus-visible\s*\{[\s\S]*?outline:/);
    expect(GLOBAL_CSS).toContain("outline: var(--focus-outline)");
    expect(GLOBAL_CSS).toContain("outline-offset: var(--focus-offset)");
  });

  it("honors prefers-reduced-motion site-wide", () => {
    expect(GLOBAL_CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(GLOBAL_CSS).toContain("animation-duration: var(--motion-duration-fast)");
    expect(GLOBAL_CSS).toContain("transition-duration: var(--motion-duration-fast)");
  });

  it("gives the footer motion toggle a matching site-wide reset", () => {
    expect(GLOBAL_CSS).toMatch(
      /html\[data-motion="off"\][\s\S]*?animation-iteration-count:\s*1\s*!important/,
    );
    expect(BASE).toContain('localStorage.getItem("njpbs-motion")');
    expect(BASE).toContain('setAttribute("data-motion", "off")');
  });

  it("mirrors every reduced-motion transform reset for the saved preference", () => {
    const reducedMotionResets = STYLE_SOURCES.flatMap(({ path, css }) =>
      reducedMotionBlocks(css).flatMap((block) =>
        transformNoneSelectors(block).map((selector) => `${path}: ${selector}`),
      ),
    ).sort();
    const expectedResets = [
      "styles/not-found.css: .nf-dial-offset",
      "styles/not-found.css: .nf-card-art img",
      "components/CinematicHomePage.astro: .card:hover .card__art",
      "styles/public-site.css: .spotlight-card:hover .spotlight-card__media",
      "styles/service-page.css: .public-page__card:hover",
      "styles/service-page.css: .public-page__card:hover .public-page__card-media",
      "styles/public-site.css: .card:hover .card__art",
      "styles/public-site.css: .card:hover .card__image",
      "styles/public-site.css: .sched--public .sched__item:hover",
      "styles/public-site.css: .sched--public .sched__item:hover .sched__media",
    ].sort();

    expect(reducedMotionResets).toEqual(expectedResets);

    for (const { path, css } of STYLE_SOURCES) {
      expect(css, `${path} must not flatten every hover transform`).not.toMatch(
        /html\[data-motion=["']off["']\]\s+\*:hover\s*\{/,
      );

      const osSelectors = reducedMotionBlocks(css).flatMap(transformNoneSelectors);
      const toggleSelectors = transformNoneSelectors(css)
        .map(dataMotionSelector)
        .filter((selector): selector is string => selector !== null);

      for (const selector of osSelectors) {
        expect(
          toggleSelectors,
          `${path} must mirror the reduced-motion reset for ${selector}`,
        ).toContain(selector);
      }
    }
  });

  it("supports forced-colors / Windows High Contrast for focus", () => {
    expect(GLOBAL_CSS).toMatch(/@media\s*\(forced-colors:\s*active\)/);
  });
});
