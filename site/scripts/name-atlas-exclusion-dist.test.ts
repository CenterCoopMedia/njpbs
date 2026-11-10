// Issue #2375: private research must not ride along in a public artifact.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { containsNameAtlasContent, nameAtlasRoutesEnabled } from "../src/lib/name-atlas-preview";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

describe("name atlas publication boundary", () => {
  it("checks an actual built artifact", () => {
    expect(existsSync(dist)).toBe(true);
    expect(readdirSync(dist, { recursive: true }).length).toBeGreaterThan(0);
  });

  it("excludes private routes and embedded reader content from public outputs", () => {
    if (nameAtlasRoutesEnabled(process.env)) return;
    const files = (readdirSync(dist, { recursive: true }) as string[])
      .map((path) => path.replaceAll("\\", "/"));
    expect(files.filter((path) => /^(?:atlas|name-atlas)(?:\/|\.|$)/.test(path))).toEqual([]);
    const leaks = files.filter((path) => /\.(?:html?|[cm]?js|json|geojson|css|map|txt|xml)$/i.test(path))
      .filter((path) => containsNameAtlasContent(readFileSync(join(dist, path), "utf8")));
    expect(leaks).toEqual([]);
  });

  it("emits both HTML documents only for the internal review build", () => {
    if (!nameAtlasRoutesEnabled(process.env)) return;
    for (const path of ["atlas/index.html", "atlas/reader/index.html"]) {
      expect(existsSync(join(dist, path)), path).toBe(true);
      const html = readFileSync(join(dist, path), "utf8");
      expect(html).toMatch(/<meta[^>]+name=["']robots["'][^>]+noindex/);
      expect(html).toContain("data-pagefind-ignore");
    }
    expect(containsNameAtlasContent(readFileSync(join(dist, "atlas/reader/index.html"), "utf8"))).toBe(true);
  });
});
