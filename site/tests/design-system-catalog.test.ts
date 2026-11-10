// @vitest-environment node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DESIGN_ASSET_GROUPS, DESIGN_ASSETS, DESIGN_FONT_ASSETS, DESIGN_SYSTEM_VERSION } from "../src/lib/design-system-catalog";

// Vitest stubs CSS imports by default; supply the actual raw token source.
vi.mock("../src/styles/design-tokens.css?raw", async () => ({
  default: (await import("node:fs")).readFileSync(
    new URL("../src/styles/design-tokens.css", import.meta.url), "utf8",
  ),
}));
import { GET } from "../src/pages/_design-system-tokens.json";

describe("design-system catalog", () => {
  it("exports technical catalog metadata and parsed tokens", async () => {
    const response = GET();
    const catalog = await response.json();
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(Object.keys(catalog).sort()).toEqual(["name", "source", "tokens", "version"]);
    expect(catalog.version).toBe(DESIGN_SYSTEM_VERSION);
    expect(catalog.tokens.length).toBeGreaterThan(0);
  });

  it("registers every image asset with usable guidance and an existing download", () => {
    expect(DESIGN_SYSTEM_VERSION).toBe("0.3.1");
    expect(DESIGN_ASSETS).toHaveLength(55);
    expect(new Set(DESIGN_ASSETS.map((asset) => asset.id)).size).toBe(DESIGN_ASSETS.length);
    expect(new Set(DESIGN_ASSETS.map((asset) => asset.path)).size).toBe(DESIGN_ASSETS.length);

    for (const asset of DESIGN_ASSETS) {
      expect(asset.path).toMatch(/^\/[a-z0-9/.-]+$/);
      expect(DESIGN_ASSET_GROUPS).toContain(asset.group);
      expect(asset.alt).not.toBe("");
      expect(asset.use).not.toBe("");
      expect(asset.avoid).not.toBe("");
      expect(asset.version).not.toBe("");
      expect(asset.width).toBeGreaterThan(0);
      expect(asset.height).toBeGreaterThan(0);
      expect(
        existsSync(fileURLToPath(new URL(`../public${asset.path}`, import.meta.url))),
        asset.path,
      ).toBe(true);
    }
  });

  it("registers the hosted PBS Sans family with content-addressed URLs", () => {
    expect(DESIGN_FONT_ASSETS).toHaveLength(5);
    expect(new Set(DESIGN_FONT_ASSETS.map((font) => font.id)).size).toBe(
      DESIGN_FONT_ASSETS.length,
    );
    expect(new Set(DESIGN_FONT_ASSETS.map((font) => font.path)).size).toBe(
      DESIGN_FONT_ASSETS.length,
    );

    for (const font of DESIGN_FONT_ASSETS) {
      expect(font.path).toMatch(/^https:\/\/media\.njpbs\.org\/cms-media\/fonts\/[a-f0-9]{64}\/PBSSans(?:-[A-Za-z]+)?\.woff2$/);
      expect(font.use).not.toBe("");
      expect(font.version).not.toBe("");
      expect([300, 400, 500, 700, 900]).toContain(font.weight);
    }
  });
});
