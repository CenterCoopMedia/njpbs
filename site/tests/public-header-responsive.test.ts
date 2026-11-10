// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Report br_abdd3a0cf1c9c510ed6f72cacfabc0e5 found a narrow desktop range where
// Support wrapped below the other primary links. The header must switch to its
// existing disclosure before any primary link can start a second row, including
// when the reader increases the browser's default text size.
const LAYOUT = readFileSync(
  fileURLToPath(
    new URL("../src/layouts/PublicSiteLayout.astro", import.meta.url),
  ),
  "utf8",
);

describe("public header responsive navigation", () => {
  it("keeps the inline primary links on one row", () => {
    expect(LAYOUT).toMatch(
      /\.primary ul\s*{[^}]*flex-direction:\s*row;[^}]*flex-wrap:\s*nowrap;/s,
    );
    expect(LAYOUT).toMatch(/\.primary a\s*{\s*white-space:\s*nowrap;/);
  });

  it("preserves a compact desktop band before using the disclosure", () => {
    expect(LAYOUT).toMatch(
      /@media \(80em <= width <= 86\.1875em\)\s*{[\s\S]*?\.primary ul\s*{\s*gap:\s*0\.8rem;/,
    );
    expect(LAYOUT).toMatch(
      /@media \(width < 80em\)\s*{[\s\S]*?\.nav-toggle\s*{\s*display:\s*inline-flex;/,
    );
  });

  // Staff can publish up to 12 header links, which do not fit on one desktop
  // row. scripts/header-fit-browser-check.mjs measures this in a browser.
  it("uses the menu button at desktop widths when the links do not fit", () => {
    expect(LAYOUT).toMatch(/inner\.scrollWidth > inner\.clientWidth/);
    expect(LAYOUT).toMatch(/setAttribute\("data-nav-collapsed", ""\)/);
    expect(LAYOUT).toMatch(
      /\.site-head\[data-nav-collapsed\] \.nav-toggle\s*{\s*display:\s*inline-flex;/,
    );
    expect(LAYOUT).toMatch(
      /@media \(scripting: none\) and \(width >= 80em\)\s*{[\s\S]*?\.primary ul\s*{\s*flex-wrap:\s*wrap;/,
    );
  });
});
