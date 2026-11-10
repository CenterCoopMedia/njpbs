import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlDeclaresNoindex } from "../src/lib/sitemap-noindex";

// Post-build canonical lock (issue #224). Runs only via npm run guardrails,
// after a build has produced dist/. Every indexed page must carry exactly one
// rel=canonical, on the https://njpbs.org origin, pointing at a page this build
// actually emitted. That shape is what keeps the weak domain (newnjpbs.org,
// which 301s here) from ever entering a cross-domain canonical pair, and it
// catches a broken alias override (canonicalPath naming a route that does not
// exist) at build time instead of in Search Console weeks later.
//
// The noindex /wiki/ subtree and retired /prototype/ prefix are out of scope, same as the
// other dist scans — and so is any page that declares robots noindex itself
// (the 404 page does: it serves with HTTP 404 for arbitrary URLs, so its
// canonical never participates in indexing).

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const ORIGIN = "https://njpbs.org";
const normalizeRel = (rel: string): string => rel.replaceAll("\\", "/");

const isIndexedPath = (rel: string): boolean => {
  const segments = rel.split("/");
  return (
    rel.endsWith(".html") &&
    !segments.includes("prototype") &&
    !segments.includes("wiki")
  );
};


// HTML attributes are unordered, so canonical extraction inspects each <link>
// tag attribute-by-attribute instead of assuming rel is written before href —
// a duplicate written as <link href="..." rel="canonical"> must be counted,
// not slip past a rel-first pattern.
const LINK_TAG = /<link\b[^>]*>/g;
const extractCanonicals = (html: string): string[] =>
  [...html.matchAll(LINK_TAG)]
    .map((m) => m[0])
    .filter((tag) => /\brel=(["'])canonical\1/.test(tag))
    .map((tag) => /\bhref=(["'])([^"']*)\1/.exec(tag)?.[2] ?? "");

// Every indexed page must canonicalize to itself, except the deliberate alias
// routes listed here. An exists-somewhere check alone would let a regression
// point any page's canonical at another emitted route and silently
// canonicalize it out of search.
const ALIAS_CANONICALS: Record<string, string> = {
  "/donate/": "/give/",
};

// dist rel path -> served route: "give/index.html" -> "/give/", "index.html"
// -> "/". Non-directory files (404.html) map to their slashed route, though
// only indexed pages — all directory-format — reach the assertions.
const routeOf = (rel: string): string =>
  rel.endsWith("index.html")
    ? "/" + rel.slice(0, -"index.html".length)
    : "/" + rel.replace(/\.html$/, "/");

// A canonical URL resolves to a page when this build emitted HTML for its path:
// directory-format routes end in "/" and map to <path>/index.html.
const emittedPage = (pathname: string): string =>
  join(distDir, ...pathname.split("/").filter(Boolean), "index.html");

describe("indexed pages carry a self-resolving njpbs.org canonical (#224)", () => {
  it("dist/ exists — run a build first", () => {
    expect(existsSync(distDir)).toBe(true);
  });

  // CI runs this scan against two build shapes: the launch build (indexed
  // public pages) and the PUBLIC_ONLY build, whose coming-soon apex is noindex
  // and which may emit no indexed page at all. Zero indexed pages is a legal
  // shape for the second; an empty dist is not legal for either.
  const all = existsSync(distDir)
    ? (readdirSync(distDir, { recursive: true }) as string[])
        .map(normalizeRel)
        .filter(isIndexedPath)
    : [];
  const pages = all.filter(
    (rel) => !htmlDeclaresNoindex(readFileSync(join(distDir, rel), "utf8")),
  );

  it("build emitted pages", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  for (const page of pages) {
    it(`${page}`, () => {
      const html = readFileSync(join(distDir, page), "utf8");
      const canonicals = extractCanonicals(html);

      // Exactly one canonical per page — zero means the page skipped the shared
      // Base head; two means a component duplicated it.
      expect(canonicals).toHaveLength(1);

      const url = new URL(canonicals[0]);
      expect(url.origin).toBe(ORIGIN);
      // Query strings or fragments on a canonical split indexing signals.
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      // Directory-format builds emit trailing-slash routes; a slashless
      // canonical would 301 and leak signal through the redirect.
      expect(url.pathname.endsWith("/")).toBe(true);

      // Self-canonical, or the declared alias target — never some other page.
      const route = routeOf(page);
      expect(url.pathname).toBe(ALIAS_CANONICALS[route] ?? route);

      // And the target must be a page this build emitted (for aliases the
      // canonical variant, for everything else the page itself).
      expect(existsSync(emittedPage(url.pathname))).toBe(true);
    });
  }
});
