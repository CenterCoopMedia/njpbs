// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMIN_DOC_PAGES, ADMIN_DOCS_BASE } from "../src/lib/admin-docs";
import { decodePagefindFragment, findRedactedUrls, type PagefindFragment } from "../src/lib/pagefind-index";
import { internalSurfaceRoutesEnabled } from "../src/lib/build-target";
import { resolveCmsPreviewInput } from "../src/lib/cms-preview-input";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const guideDirectory = path.join(dist, "admin", "docs");
const guideAssets = path.join(dist, "images", "admin-guide");
const fragmentDirectory = path.join(dist, "pagefind", "fragment");
const expectsInternalGuide =
  internalSurfaceRoutesEnabled(process.env) &&
  resolveCmsPreviewInput(process.env) === null;
// Only reviewed, committed guide assets belong in the public source. The
// private screenshot inventory is deliberately absent from this repository.
const sourceGuideAssets = fileURLToPath(new URL("../src/internal/admin-guide/", import.meta.url));
const expectedAssets = existsSync(sourceGuideAssets)
  ? readdirSync(sourceGuideAssets).filter(name => name.endsWith(".webp")) : [];

function fragments(): PagefindFragment[] {
  if (!existsSync(fragmentDirectory)) return [];
  return readdirSync(fragmentDirectory)
    .filter((name) => name.endsWith(".pf_fragment"))
    .map((name) => decodePagefindFragment(
      readFileSync(path.join(fragmentDirectory, name)),
    ));
}

function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

describe("staff guide build boundary", () => {
  it("matches guide HTML and assets to the explicit build target", () => {
    expect(existsSync(guideDirectory)).toBe(expectsInternalGuide);
    expect(existsSync(path.join(guideDirectory, "index.html"))).toBe(
      expectsInternalGuide,
    );
    expect(existsSync(guideAssets)).toBe(expectsInternalGuide && expectedAssets.length > 0);
    if (!expectsInternalGuide) return;

    expect(existsSync(guideAssets) ? readdirSync(guideAssets).sort() : []).toEqual([...expectedAssets].sort());
    for (const [index, page] of ADMIN_DOC_PAGES.entries()) {
      expect(existsSync(path.join(
        guideDirectory,
        page.slug,
        "index.html",
      )), page.href).toBe(true);
      const html = readFileSync(path.join(guideDirectory, page.slug, "index.html"), "utf8");
      for (const [rel, neighbour] of [["prev", ADMIN_DOC_PAGES[index - 1]],
        ["next", ADMIN_DOC_PAGES[index + 1]]] as const) {
        const links = [...html.matchAll(/<a\b[^>]*>/g)]
          .filter(([tag]) => tag.includes(`rel="${rel}"`));
        expect(links, `${page.href}: ${rel}`).toHaveLength(neighbour ? 1 : 0);
        if (neighbour) expect(links[0][0]).toContain(`href="${neighbour.href}"`);
      }
    }
    const guideHome = readFileSync(path.join(guideDirectory, "index.html"), "utf8");
    expect(guideHome).toContain('name="robots" content="noindex, nofollow"');
    expect(guideHome).toContain('data-pagefind-ignore="all"');
    expect(guideHome).toContain(
      'rel="canonical" href="https://dev-public.example.org/admin/docs/"',
    );
    expect(guideHome).toContain(
      'property="og:url" content="https://dev-public.example.org/admin/docs/"',
    );
    expect(guideHome).not.toContain(
      'rel="canonical" href="https://njpbs.org/admin/docs/"',
    );
    expect(guideHome).not.toContain('type="application/ld+json"');
  });

  it("keeps the guide out of the sitemap and Pagefind", () => {
    const sitemapPath = path.join(dist, "sitemap-0.xml");
    if (existsSync(sitemapPath)) {
      expect(readFileSync(sitemapPath, "utf8")).not.toContain(ADMIN_DOCS_BASE);
    }
    const indexed = fragments();
    expect(findRedactedUrls(indexed, [ADMIN_DOCS_BASE])).toEqual([]);
    for (const protectedPhrase of [
      "NJ PBS Newsroom CMS guide",
      "Boardwalk guide",
      "Save draft keeps your work in the CMS",
      "Staff access shows approved identities",
    ]) {
      expect(indexed.some(({ content }) =>
        content.includes(protectedPhrase)
      ), protectedPhrase).toBe(false);
    }
  });

  it("keeps guide text and styles out of builds that omit the guide", () => {
    if (expectsInternalGuide) return;
    const protectedMarkers = [
      "Save draft keeps your work in the CMS",
      "Staff access shows approved identities",
      "admin-docs-page",
      "NJ PBS Newsroom CMS guide",
      "Boardwalk guide",
    ];

    const leaks = filesBelow(dist).flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return protectedMarkers
        .filter((marker) => content.includes(marker))
        .map((marker) => ({
          file: path.relative(dist, file),
          marker,
        }));
    });
    expect(leaks).toEqual([]);
  });
});
