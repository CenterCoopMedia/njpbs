import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Window } from "happy-dom";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { isPublicOnlyBuild } from "../src/lib/build-target";
import { POLITICS_PREVIEW_ROOT } from "../src/lib/politics-guide-preview";

type Element = DefaultTreeAdapterTypes.Element;

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
// The shared owner is the oracle, so a copied wordmark or an unrelated header
// cannot satisfy the check. Do not learn the expected header from built output.
const layout = readFileSync(new URL("../src/layouts/PublicSiteLayout.astro", import.meta.url), "utf8");
const headerClass = layout.match(/<header class="([^"]+)"/)![1];
const brand = layout.match(/<a class="brand"[^>]*>\s*(<img[^>]+>)/)![1];
const ownerDocument = new Window().document;
ownerDocument.body.innerHTML = brand;
const expectedLogo = ownerDocument.querySelector("img")!;

// Each built page is parsed with parse5: a happy-dom document per page took
// 2.8-5.1 s for 322 pages and timed out on a slow runner (issue #608).
function elements(root: DefaultTreeAdapterTypes.ParentNode): Element[] {
  const found: Element[] = [];
  const pending = [...root.childNodes].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (!("tagName" in node)) continue;
    found.push(node);
    pending.push(...[...node.childNodes].reverse());
  }
  return found;
}
const attr = (element: Element | undefined, name: string) => element?.attrs.find(item => item.name === name)?.value ?? null;
const hasClass = (element: Element, name: string) => (attr(element, "class") ?? "").split(/\s+/).includes(name);

// Wiki, script-free figure embeds and opt-in staff specimens use separate shells. Redirect
// stubs are not reading pages. The noindex 404 remains inside the public gate.
const separateShell = /^(?:(?:wiki|design-system|atlas|admin\/docs)\/|data\/figures\/[a-z0-9-]+\/embed\/)/;
describe.skipIf(isPublicOnlyBuild(process.env))("every built public page uses the shared header", () => {
  it("renders the shared logo, primary navigation, menu control and skip target", () => {
    expect(headerClass).not.toMatch(/\s/);
    const pages = (readdirSync(dist, { recursive: true }) as string[])
      .map(path => path.replaceAll("\\", "/"))
      .filter(path => path.endsWith(".html") && !separateShell.test(path) && !path.startsWith(POLITICS_PREVIEW_ROOT.slice(1)));
    expect(pages).toContain("404.html");
    expect(pages).toContain("index.html");
    for (const path of pages) {
      const all = elements(parse(readFileSync(join(dist, path), "utf8")));
      if (all.some(element => element.tagName === "meta" && attr(element, "http-equiv")?.toLowerCase() === "refresh")) continue;
      const headers = all.filter(element => element.tagName === "header" && hasClass(element, headerClass));
      expect(headers.length, path).toBe(1);
      const inHeader = elements(headers[0]);
      const brandLink = inHeader.find(element => element.tagName === "a" && hasClass(element, "brand"));
      const logo = brandLink && elements(brandLink).find(element => element.tagName === "img");
      for (const name of ["src", "alt", "width", "height"]) {
        expect(attr(logo, name), `${path}: logo ${name}`).toBe(expectedLogo.getAttribute(name));
      }
      const primary = inHeader.filter(element => element.tagName === "nav" && attr(element, "aria-label") === "Primary");
      expect(primary.some(nav => elements(nav).some(element => element.tagName === "a")), `${path}: primary links`).toBe(true);
      const menu = inHeader.find(element => element.tagName === "button" && attr(element, "aria-controls") !== null);
      expect(menu, `${path}: menu`).toBeDefined();
      expect(inHeader.some(element => attr(element, "id") === attr(menu, "aria-controls")), `${path}: menu target`).toBe(true);
      const skip = all.find(element => element.tagName === "a" && hasClass(element, "skip") && (attr(element, "href") ?? "").startsWith("#"));
      expect(skip, `${path}: skip`).toBeDefined();
      expect(all.some(element => attr(element, "id") === attr(skip, "href")!.slice(1)), `${path}: skip target`).toBe(true);
      expect(all.filter(element => element.tagName === "main").length, `${path}: main landmark`).toBe(1);
    }
  });
});
