import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlDeclaresNoindex } from "../src/lib/sitemap-noindex";

// Post-build structured-data lock (issue #222). Runs only via npm run
// guardrails, after a build has produced dist/. The homepage must carry the
// Organization entity, every other indexed page a BreadcrumbList, and every
// emitted JSON-LD block must parse — a malformed blob is worse than none, since
// it can poison how a crawler reads the rest of the page's markup.
//
// Scope matches the other dist scans: noindex pages (/wiki/, the retired
// /prototype/ prefix, the
// 404 page) are out, and must stay structured-data-free — schema claims on a
// preview render would describe pages that do not exist publicly.

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const normalizeRel = (rel: string): string => rel.replaceAll("\\", "/");

const isIndexedPath = (rel: string): boolean => {
  const segments = rel.split("/");
  return (
    rel.endsWith(".html") &&
    !segments.includes("prototype") &&
    !segments.includes("wiki")
  );
};

const JSON_LD =
  /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

const blocksIn = (html: string): unknown[] =>
  [...html.matchAll(JSON_LD)].map((m) => JSON.parse(m[1]));

describe("indexed pages carry valid structured data (#222)", () => {
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
  const indexed = all.filter(
    (rel) => !htmlDeclaresNoindex(readFileSync(join(distDir, rel), "utf8")),
  );
  const noindexed = all.filter((rel) => !indexed.includes(rel));

  it("build emitted pages", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  const homeIsIndexed = indexed.includes("index.html");

  it.skipIf(!homeIsIndexed)("homepage carries the Organization entity", () => {
    const blocks = blocksIn(readFileSync(join(distDir, "index.html"), "utf8"));
    const types = blocks.map((b) => (b as { "@type": string })["@type"]);
    expect(types).toContain("Organization");
  });

  for (const page of indexed.filter((p) => p !== "index.html")) {
    it(`${page} carries a parseable BreadcrumbList`, () => {
      const html = readFileSync(join(distDir, page), "utf8");
      const blocks = blocksIn(html);
      const crumbs = blocks.filter(
        (b) => (b as { "@type": string })["@type"] === "BreadcrumbList",
      ) as Array<{ itemListElement: Array<{ item: string }> }>;
      expect(crumbs).toHaveLength(1);
      for (const item of crumbs[0].itemListElement) {
        expect(item.item.startsWith("https://njpbs.org/")).toBe(true);
      }
      // The trail must advertise the same URL as the page's canonical tag —
      // an alias route (/donate/ canonicalizes to /give/) otherwise hands
      // crawlers two disagreeing signals on the same indexed duplicate.
      const canonical = html.match(
        /<link rel="canonical" href="([^"]*)"\s*\/?>/,
      )?.[1];
      const last = crumbs[0].itemListElement.at(-1);
      expect(last?.item).toBe(canonical);
    });
  }

  for (const page of noindexed) {
    it(`${page} is noindex and carries no structured data`, () => {
      const html = readFileSync(join(distDir, page), "utf8");
      expect(blocksIn(html)).toEqual([]);
    });
  }
});
