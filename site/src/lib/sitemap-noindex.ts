// Keep pages that declare themselves noindex out of the sitemap.
//
// The sitemap's other exclusions are static path rules: /wiki/, the retired
// /prototype/ prefix, and /design-system/. Alias routes are
// content-derived because
// a saved Page can make a former alias its canonical URL. Retired-slug stubs and
// the fallback /donate/ alias declare noindex in their rendered page instead.
// Listing a noindex stub would give a crawler two contradictory instructions
// about the same URL: "index this page" and "do not index this page".
//
// So the decision is read from the page itself. `@astrojs/sitemap` runs at
// `astro:build:done`, by which point every page has been written to dist, so the
// emitted HTML is available and is the most direct evidence of what the page
// actually declares. A page that cannot be read is KEPT: the sitemap's job is to
// list the site, and dropping a real page because a read hiccuped is the worse
// failure of the two.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "parse5";

/**
 * The dist file that backs one emitted route, or null for a route shape this
 * build does not produce as a directory index.
 *
 * Path traversal is refused rather than clamped: a URL that escapes dist is not
 * a page this build emitted, and reading it would be reading something else.
 */
export function distFileForPage(
  pageUrl: string,
  distDirectory: string,
): string | null {
  let pathname: string;
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith("/") || !pathname.endsWith("/")) return null;
  const root = path.resolve(distDirectory);
  const target = path.resolve(root, `.${pathname}index.html`);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

/** Read document metadata without matching HTML examples inside scripts. */
export function htmlDeclaresNoindex(source: string): boolean {
  const document = parse(source);
  const html = document.childNodes.find(node => node.nodeName === "html");
  if (!html || !("childNodes" in html)) return false;
  const head = html.childNodes.find(node => node.nodeName === "head");
  if (!head || !("childNodes" in head)) return false;
  return head.childNodes.some(node => {
    if (!("tagName" in node) || node.tagName !== "meta") return false;
    const name = node.attrs.find(attr => attr.name === "name")?.value;
    const content = node.attrs.find(attr => attr.name === "content")?.value;
    return name?.toLowerCase() === "robots" && /\bnoindex\b/i.test(content ?? "");
  });
}

/** Whether an emitted page declares robots noindex. Unreadable pages say false. */
export function pageDeclaresNoindex(
  pageUrl: string,
  distDirectory: string,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): boolean {
  const file = distFileForPage(pageUrl, distDirectory);
  if (file === null) return false;
  try {
    return htmlDeclaresNoindex(read(file));
  } catch {
    return false;
  }
}
