import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Post-build accessibility lock (issue #174). Runs only via npm run guardrails,
// after a build has produced dist/. Every link that opens a new tab on an indexed
// page must carry the screen-reader cue "(opens in new tab)" inside its accessible
// name, so the accessibility statement's claim holds for the public site.
//
// The markdown pages are locked separately at the source by
// tests/external-link-cue.test.ts; this locks the rendered surface, which is the
// only thing that catches the homepage's conditional component links (a source
// grep undercounts them: the target is applied three ways — a literal attribute,
// a spread, and a per-item spread inside a map). The gated, noindex /wiki/
// render and retired /prototype/ prefix are out of scope and excluded.

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const CUE = "(opens in new tab)";
const normalizeRel = (rel: string): string => rel.replaceAll("\\", "/");

// An indexed page is any emitted HTML outside the noindex /wiki/ subtree and
// retired /prototype/ prefix. Path segments are matched exactly, so a slug like
// "wikipedia" is not excluded by a loose substring match on "wiki".
const isIndexedPage = (rel: string): boolean => {
  const segments = rel.split("/");
  return (
    rel.endsWith(".html") &&
    !segments.includes("prototype") &&
    !segments.includes("wiki")
  );
};

// Each <a ...> ... </a>. Anchors never nest, so the first </a> closes the match.
const ANCHOR = /<a\b[^>]*>[\s\S]*?<\/a>/g;
const opensNewTab = (anchor: string): boolean =>
  /\btarget=["']_blank["']/.test(anchor);

describe("indexed pages cue every new-tab link for screen readers (#174)", () => {
  it("dist/ exists — run a build first", () => {
    expect(existsSync(distDir)).toBe(true);
  });

  const pages = existsSync(distDir)
    ? (readdirSync(distDir, { recursive: true }) as string[])
        .map(normalizeRel)
        .filter(isIndexedPage)
    : [];

  it("emits at least one indexed HTML page to scan", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it("has no uncued target=_blank anchor on any indexed page", () => {
    const offenders: { file: string; anchor: string }[] = [];
    for (const rel of pages) {
      const html = readFileSync(join(distDir, rel), "utf8");
      for (const anchor of html.match(ANCHOR) ?? []) {
        if (opensNewTab(anchor) && !anchor.includes(CUE)) {
          // Trim long anchors so a failure lists the offender readably.
          offenders.push({ file: rel, anchor: anchor.slice(0, 120) });
        }
      }
    }
    // Equality against [] surfaces the offending file + anchor text on failure.
    expect(offenders).toEqual([]);
  });
});
