// Post-build scope lock over the generated Pagefind index (issue #226).
//
// Runs only via `npm run guardrails`, after a build has produced dist/. The
// production deploy builds the FULL tree with no PUBLIC_ONLY, so dist/ at index
// time contains the public /wiki/ tree. The wiki has its own navigation and is
// deliberately absent from site-wide search. The retired /prototype/ prefix
// remains a deny-list tombstone. A search index that made either queryable would
// violate the search-scope or retired-route contract.
//
// What keeps them out is Pagefind's opt-in body: while ANY page in the build
// carries data-pagefind-body, ONLY tagged pages are indexed. PublicSiteLayout
// carries it; WikiLayout and any accidentally restored retired route do not.
// That guarantee is
// global and implicit, which is why it is pinned here rather than trusted:
// deleting the attribute from one layout silently flips the index from
// public-only to everything, and both builds succeed with no warning.
//
// Two build modes, two different correct answers, so the mode is part of the
// assertion rather than something the scan tries to tolerate:
//
//   full build (PUBLIC_ONLY unset)  -> an index must exist, be non-empty, and
//                                      carry no redacted url.
//   PUBLIC_ONLY build               -> an index must NOT exist. Only the
//                                      coming-soon apex and 404 ship, and
//                                      index.astro renders <Base>, not
//                                      PublicSiteLayout — so no page carries
//                                      data-pagefind-body. Pagefind's opt-in
//                                      would flip OFF and it would index every
//                                      page it found, and /wiki/ renders in
//                                      PUBLIC_ONLY builds too (see
//                                      src/lib/build-target.ts). Running the
//                                      indexer there is the leak, so the deploy
//                                      pipelines deliberately skip it and this
//                                      asserts they kept skipping it.
//
// The scan reads fragments through src/lib/pagefind-index.ts because Pagefind
// stores them gzipped: a text search over dist/pagefind/ returns zero hits no
// matter what the index holds, so the obvious version of this guard passes green
// on exactly the build it exists to catch.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import {
  decodePagefindFragment,
  findRedactedUrls,
  type PagefindFragment,
} from "../src/lib/pagefind-index";
import { isPublicOnlyBuild } from "../src/lib/build-target";

// Subtrees that must never be queryable. /wiki/ is public but deliberately
// outside site-wide search, while the retired /prototype/ prefix,
// and the staff Boardwalk guide are noindexed internal
// surfaces.
const REDACTED_PREFIXES = [
  "/wiki/",
  "/prototype/",
  "/admin/docs/",
] as const;

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
const fragmentDir = join(distDir, "pagefind", "fragment");
const publicOnly = isPublicOnlyBuild(process.env);

const readFragments = (): PagefindFragment[] =>
  readdirSync(fragmentDir)
    .filter((name) => name.endsWith(".pf_fragment"))
    .map((name) => decodePagefindFragment(readFileSync(join(fragmentDir, name))));

describe("Pagefind index scope", () => {
  it("does not publish the custom-link search build input", () => {
    expect(existsSync(join(distDir, "search", "content-links.json"))).toBe(false);
  });

  it("matches the build mode: indexed on a full build, absent on PUBLIC_ONLY", () => {
    if (publicOnly) {
      // Not a nicety. With no data-pagefind-body anywhere in a PUBLIC_ONLY
      // build, an index here means Pagefind indexed everything it could reach,
      // wiki included.
      expect(
        existsSync(fragmentDir),
        "PUBLIC_ONLY build produced a Pagefind index. No page carries " +
          "data-pagefind-body in this mode, so the index is unscoped and " +
          "includes /wiki/. Remove the index:search step from this pipeline.",
      ).toBe(false);
      return;
    }

    expect(
      existsSync(fragmentDir),
      "full build produced no Pagefind index at dist/pagefind/fragment/. " +
        "pagefind is a declared dependency, so this pipeline is missing its " +
        "`npm run index:search` step between the build and the guardrail scan.",
    ).toBe(true);
  });

  it("indexed at least one page", () => {
    if (publicOnly || !existsSync(fragmentDir)) return;
    // An index that failed to generate produces zero fragments, and would
    // otherwise sail through the redacted-url check below by having nothing to
    // find. Absence of evidence is the failure mode this whole file is about.
    expect(readFragments().length).toBeGreaterThan(0);
  });

  it("indexes no redacted subtree", () => {
    if (publicOnly || !existsSync(fragmentDir)) return;
    const leaked = findRedactedUrls(readFragments(), REDACTED_PREFIXES);
    expect(
      leaked,
      `Pagefind indexed redacted pages: ${leaked.join(", ")}. Check that ` +
        "PublicSiteLayout still carries data-pagefind-body and that no other " +
        "layout gained it.",
    ).toEqual([]);
  });

  it("indexes only canonical pages without a noindex directive", () => {
    if (publicOnly || !existsSync(fragmentDir)) return;
    const window = new Window();
    for (const fragment of readFragments()) {
      const url = new URL(fragment.url, "https://njpbs.org");
      expect(url.origin).toBe("https://njpbs.org");
      const file = resolve(distDir, `.${decodeURIComponent(url.pathname)}`,
        url.pathname.endsWith("/") ? "index.html" : "");
      expect(file.startsWith(resolve(distDir) + sep)).toBe(true);
      const doc = new window.DOMParser().parseFromString(readFileSync(file, "utf8"), "text/html");
      const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
      expect(canonical, `${fragment.url} has no canonical URL`).toBeTruthy();
      expect(new URL(canonical!, url).href, `${fragment.url} is an alias`).toBe(url.href);
      const robots = [...doc.querySelectorAll('meta[name="robots" i]')]
        .flatMap((meta) => (meta.getAttribute("content") ?? "").toLowerCase().split(/[\s,]+/));
      expect(robots, `${fragment.url} is marked noindex`).not.toContain("noindex");
      expect(robots, `${fragment.url} is marked none`).not.toContain("none");
    }
  });

  it("indexes the public pages it is supposed to", () => {
    if (publicOnly || !existsSync(fragmentDir)) return;
    // The mirror of the exclusion check. A scoping mistake that indexes nothing
    // public would satisfy every assertion above while shipping a search box
    // that returns no results.
    const urls = readFragments().map((fragment) => fragment.url);
    expect(urls.some((url) => !REDACTED_PREFIXES.some((p) => url.startsWith(p)))).toBe(true);
  });
});
