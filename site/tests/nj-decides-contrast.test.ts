// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "../src/lib/contrast";

const source = readFileSync(new URL("../src/styles/design-tokens.css", import.meta.url), "utf8");
function color(name: string): string {
  const value = source.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
  if (!value) throw new Error(`Missing token: ${name}`);
  const alias = value.match(/^var\(--(.+)\)$/);
  return alias ? color(alias[1]) : value;
}

describe("NJ Decides text and focus pairings", () => {
  it.each([
    ["color-nj-decides-text", "color-nj-decides-surface", 4.5],
    ["color-nj-decides-ink", "color-nj-decides-paper", 4.5],
    ["color-nj-decides-paper", "color-nj-decides-action", 4.5],
    ["color-nj-decides-action", "color-nj-decides-paper", 4.5],
    ["color-nj-decides-focus", "color-nj-decides-surface", 3],
    ["color-nj-decides-focus", "color-nj-decides-action", 3],
    ["color-nj-decides-ink", "color-nj-decides-field", 4.5],
    ["color-nj-decides-action", "color-nj-decides-field", 4.5],
  ])("%s on %s meets AA", (foreground, background, minimum) => {
    expect(contrastRatio(color(foreground as string), color(background as string))).toBeGreaterThanOrEqual(minimum as number);
  });
});
