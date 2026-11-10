// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

const astroConfig = readSource("../astro.config.mjs");
const page = readSource("../src/pages/_design-system.astro");

describe("internal Design and Asset Lab surface", () => {
  it("keeps the page and exports behind the existing internal-surface gate", () => {
    expect(astroConfig).toMatch(
      /if \(!internalSurfaceRoutesEnabled\(process\.env\)\) return;[\s\S]*?pattern: "\/design-system\/"/,
    );
    expect(astroConfig).toContain('pattern: "/design-system/tokens.css"');
    expect(astroConfig).toContain('pattern: "/design-system/tokens.json"');
    expect(astroConfig).toContain('pattern: "/design-system/specimens/public/"');
    expect(astroConfig).toContain('!page.includes("/design-system/")');
  });

  it("is excluded from indexing and labels the lifecycle states plainly", () => {
    expect(page).toContain("noindex={true}");
    expect(page).toContain("searchable={false}");
    expect(page).toContain("data-pagefind-ignore");
    expect(page).toContain("Official brand asset");
    expect(page).toContain("Production web token");
    expect(page).toContain("Experimental draft");
    expect(page).toContain("Deprecated");
  });
});
