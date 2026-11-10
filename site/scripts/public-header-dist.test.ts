import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Window } from "happy-dom";
import { isPublicOnlyBuild } from "../src/lib/build-target";
import { POLITICS_PREVIEW_ROOT } from "../src/lib/politics-guide-preview";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
// The shared owner is the oracle, so a copied wordmark or an unrelated header
// cannot satisfy the check. Do not learn the expected header from built output.
const layout = readFileSync(new URL("../src/layouts/PublicSiteLayout.astro", import.meta.url), "utf8");
const headerClass = layout.match(/<header class="([^"]+)"/)![1];
const brand = layout.match(/<a class="brand"[^>]*>\s*(<img[^>]+>)/)![1];
const document = new Window().document;
document.body.innerHTML = brand;
const expectedLogo = document.querySelector("img")!;

// Wiki and opt-in staff specimens have deliberately separate shells. Redirect
// stubs are not reading pages. The noindex 404 remains inside the public gate.
const separateShell = /^(?:wiki|design-system|atlas|admin\/docs)\//;
describe.skipIf(isPublicOnlyBuild(process.env))("every built public page uses the shared header", () => {
  it("renders the shared logo, primary navigation, menu control and skip target", () => {
    const pages = (readdirSync(dist, { recursive: true }) as string[])
      .map(path => path.replaceAll("\\", "/"))
      .filter(path => path.endsWith(".html") && !separateShell.test(path) && !path.startsWith(POLITICS_PREVIEW_ROOT.slice(1)));
    expect(pages).toContain("404.html");
    expect(pages).toContain("index.html");
    for (const path of pages) {
      document.documentElement.innerHTML = readFileSync(join(dist, path), "utf8");
      if (document.querySelector('meta[http-equiv="refresh" i]')) continue;
      const headers = document.querySelectorAll(`header.${headerClass}`);
      expect(headers.length, path).toBe(1);
      const header = headers[0];
      const logo = header?.querySelector("a.brand img");
      for (const name of ["src", "alt", "width", "height"]) {
        expect(logo?.getAttribute(name), `${path}: logo ${name}`).toBe(expectedLogo.getAttribute(name));
      }
      expect(header?.querySelector('nav[aria-label="Primary"] a'), `${path}: primary links`).not.toBeNull();
      const menu = header?.querySelector('button[aria-controls]');
      expect(menu, `${path}: menu`).not.toBeNull();
      expect(header?.querySelector(`[id="${menu?.getAttribute("aria-controls")}"]`), `${path}: menu target`).not.toBeNull();
      const skip = document.querySelector('a.skip[href^="#"]');
      expect(skip, `${path}: skip`).not.toBeNull();
      expect(document.getElementById(skip?.getAttribute("href")?.slice(1) ?? ""), `${path}: skip target`).not.toBeNull();
      expect(document.querySelectorAll("main").length, `${path}: main landmark`).toBe(1);
    }
  });
});
