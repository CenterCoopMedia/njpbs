import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = ["design-system/tokens.css", "design-system/legacy-aliases.css", "styles.css"]
  .map((file) => readFileSync(resolve(process.cwd(), "src", file), "utf8"))
  .join("\n");
const publicTokens = readFileSync(
  resolve(process.cwd(), "../site/src/styles/design-tokens.css"),
  "utf8",
);

function colorToken(name: string): string {
  const value = tokenValue(name);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid color token: ${name}`);
  return value;
}

function tokenValue(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`Circular token: ${name}`);
  seen.add(name);
  const match = styles.match(new RegExp(`--${name}:\\s*([^;]+);`, "i"));
  if (!match) throw new Error(`Missing token: ${name}`);
  return match[1].trim().replace(/var\(--([a-z0-9-]+)\)/gi,
    (_, target: string) => tokenValue(target, new Set(seen)));
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function cssBlocks(source: string, marker: string): string[] {
  const blocks: string[] = [];
  let offset = 0;

  while (true) {
    const start = source.indexOf(marker, offset);
    if (start < 0) return blocks;
    const open = source.indexOf("{", start + marker.length);
    if (open < 0) return blocks;
    let depth = 1;
    let cursor = open + 1;

    while (depth > 0 && cursor < source.length) {
      if (source[cursor] === "{") depth += 1;
      if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }

    if (depth > 0) return blocks;
    blocks.push(source.slice(start, cursor));
    offset = cursor;
  }
}

describe("admin design tokens", () => {
  it("keeps control borders at 3:1 contrast on action surfaces", () => {
    for (const surface of ["cms-surface", "cms-surface-field", "cms-surface-context", "cms-surface-muted", "cms-brand-soft"]) {
      expect(contrastRatio(colorToken("cms-control-border"), colorToken(surface)))
        .toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps each semantic action role readable in default, hover and pressed states", () => {
    for (const { role, text } of [
      { role: "brand", text: "action-text" },
      { role: "danger", text: "action-text" },
      { role: "action-secondary", text: "action-secondary-text" },
    ]) {
      for (const state of ["", "-hover", "-pressed"]) {
        const fill = colorToken(`cms-${role}${state}`);
        expect(contrastRatio(colorToken(`cms-${text}`), fill)).toBeGreaterThanOrEqual(4.5);
      }
    }

    for (const state of ["", "-hover", "-pressed"]) {
      expect(contrastRatio(colorToken(`cms-danger${state}`), colorToken(`cms-danger-soft${state}`)))
        .toBeGreaterThanOrEqual(4.5);
    }

    for (const role of ["action-secondary"]) {
      const border = colorToken(`cms-${role}-border`);
      for (const state of ["", "-hover", "-pressed"]) {
        const fill = colorToken(`cms-${role}${state}`);
        expect(relativeLuminance(fill)).toBeGreaterThan(0.2);
        expect(border).not.toBe(fill);
        for (const prohibited of [
          "cms-brand",
          "cms-danger",
          "cms-positive",
          "cms-brand-green",
          "cms-brand-green-strong",
          "cms-brand-green-hover",
          "cms-brand-green-pressed",
        ]) {
          expect(fill).not.toBe(colorToken(prohibited));
        }
      }
    }
  });

  it("keeps quiet actions transparent at rest and readable against their real surfaces", () => {
    expect(tokenValue("cms-action-quiet")).toBe("transparent");
    expect(tokenValue("cms-action-quiet-border")).toBe("transparent");
    for (const background of ["cms-surface-workspace", "cms-surface-context", "cms-surface-chrome", "cms-surface-header", "cms-surface-content", "cms-surface-selected", "cms-action-quiet-hover", "cms-action-quiet-pressed"]) {
      expect(contrastRatio(colorToken("cms-action-quiet-text"), colorToken(background)), background).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps leave guard text at AA contrast", () => {
    expect(
      contrastRatio(colorToken("color-text-muted"), colorToken("color-surface")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps placeholder text at AA contrast on form surfaces", () => {
    expect(
      contrastRatio(colorToken("color-text-quiet"), colorToken("color-surface")),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps muted-surface label text at AA contrast", () => {
    expect(
      contrastRatio(colorToken("color-text-muted"), colorToken("color-surface-muted")),
    ).toBeGreaterThanOrEqual(4.5);

    const assetPreview = styles.match(/\.asset-field-preview\s*\{[^}]*\}/)?.[0];
    expect(assetPreview).toContain("color: var(--color-text-muted)");
    expect(assetPreview).not.toContain("var(--color-text-quiet)");
  });

  it("stops spinner motion when reduced motion is requested", () => {
    expect(styles).toMatch(/\.spinner-orbit-middle\s*\{[^}]*animation:/);
    const reducedMotion = cssBlocks(styles, "@media (prefers-reduced-motion: reduce)");

    expect(reducedMotion.some((block) =>
      /\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation-duration:\s*0\.01ms\s*!important[^}]*animation-iteration-count:\s*1\s*!important/.test(block),
    )).toBe(true);
  });

  it("keeps density panel text and focus indicators at readable contrast", () => {
    expect(
      contrastRatio(colorToken("color-ink-soft"), colorToken("color-surface-muted")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colorToken("color-brand-strong"), colorToken("color-surface")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colorToken("color-focus"), colorToken("color-surface-muted")),
    ).toBeGreaterThanOrEqual(3);
  });

  it("keeps public primary-button hover text at AA contrast", () => {
    const publicBright = publicTokens.match(/--pbs-blue-bright:\s*(#[0-9a-f]{6})/i)?.[1];
    expect(publicBright).toBeDefined();
    expect(
      contrastRatio(colorToken("color-surface"), publicBright!),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
