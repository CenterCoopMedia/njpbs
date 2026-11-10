import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio, meetsAA } from "../src/lib/contrast";

const repoRoot = join(process.cwd(), "..");
const archivedKitRoot = join(repoRoot, "archive", "theme-chooser", "public", "kits", "glasshouse");
const restoredKitRoot = join(process.cwd(), "public", "kits", "glasshouse");
const kitRoot = existsSync(archivedKitRoot) ? archivedKitRoot : restoredKitRoot;
const archivedPreviewPath = join(
  repoRoot,
  "archive",
  "theme-chooser",
  "src",
  "components",
  "previews",
  "GlasshousePreview.astro",
);
const restoredPreviewPath = join(process.cwd(), "src", "components", "previews", "GlasshousePreview.astro");
const previewPath = existsSync(archivedPreviewPath) ? archivedPreviewPath : restoredPreviewPath;

interface Pairing {
  name: string;
  fg: string;
  bg: string;
  large?: boolean;
  minRatio?: number;
}

interface KitTokens {
  name: string;
  title: string;
  colors: Record<string, string>;
  pairings: Pairing[];
}

function readKitFile(name: string): string {
  return readFileSync(join(kitRoot, name), "utf8");
}

function loadTokens(): KitTokens {
  return JSON.parse(readKitFile("tokens.json")) as KitTokens;
}

describe("glasshouse archived kit", () => {
  it("ships the restorable kit files", () => {
    for (const file of ["glasshouse.css", "glasshouse.js", "tokens.json", "README.md"]) {
      expect(existsSync(join(kitRoot, file)), file).toBe(true);
    }
  });

  it("declares valid color tokens and wcag aa pairings", () => {
    const tokens = loadTokens();
    expect(tokens.name).toBe("glasshouse");
    expect(tokens.title).toBe("Garden signal glasshouse");
    expect(Object.keys(tokens.colors).length).toBeGreaterThan(0);
    expect(tokens.pairings.length).toBeGreaterThan(0);

    for (const [name, value] of Object.entries(tokens.colors)) {
      expect(value, name).toMatch(/^#[0-9a-fA-F]{6}$/);
    }

    for (const pair of tokens.pairings) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      const floor = pair.minRatio ?? (pair.large ? 3 : 4.5);
      expect(
        ratio,
        `${pair.name} (${pair.fg} on ${pair.bg}) = ${ratio.toFixed(2)}:1, needs ${floor}:1`,
      ).toBeGreaterThanOrEqual(floor);
      expect(meetsAA(floor, { large: pair.large })).toBe(true);
    }
  });

  it("keeps motion passive and avoids scroll jacking", () => {
    const js = readKitFile("glasshouse.js");
    expect(js).not.toMatch(/preventDefault\s*\(/);
    expect(js).not.toMatch(/scrollTo\s*\(/);
    expect(js).not.toMatch(/scrollIntoView\s*\(/);
    expect(js).not.toMatch(/scroll-snap/i);
    expect(js).toMatch(/passive:\s*true/);
    expect(js).toMatch(/pointermove', updatePointer, \{ passive: true \}/);
    expect(js).not.toMatch(/initThree\s*\(/);
    expect(js).toMatch(/mountThree/);
  });

  it("keeps dynamic layers decorative and reduced-motion aware", () => {
    const preview = readFileSync(previewPath, "utf8");
    const css = readKitFile("glasshouse.css");
    expect(preview).toMatch(/glasshouse-signal-orbit" aria-hidden="true"/);
    expect(preview).toMatch(/glasshouse-vine-field" aria-hidden="true"/);
    expect(preview).toMatch(/glasshouse-scan-window" aria-hidden="true"/);
    expect(preview).toMatch(/glasshouse-dial__screen" aria-hidden="true"/);
    expect(css).toMatch(/@keyframes glasshouse-meter/);
    expect(css).toMatch(/@keyframes glasshouse-scan/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
  });

  it("documents the decorative Three.js layer and accessibility limits", () => {
    const readme = readKitFile("README.md");
    expect(readme).toMatch(/Three\.js layer/);
    expect(readme).toMatch(/WCAG AA/);
    expect(readme).toMatch(/aria-hidden/);
    expect(readme).toMatch(/never intercept/);
  });
});
