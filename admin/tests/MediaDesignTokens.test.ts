import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Tokens for shared media library controls.
// Thumbnail scrims are checked over their worst background; opaque chrome is independent of posters.
const tokens = JSON.parse(
  readFileSync(resolve(process.cwd(), "src/design-system/tokens.json"), "utf8"),
).tokens as Record<string, string>;
type Rgb = [number, number, number];

function hex(value: string): Rgb {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Not a hex color: ${value}`);
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as Rgb;
}

function rgba(value: string): { rgb: Rgb; alpha: number } {
  const match = value.match(/^rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)$/);
  if (!match) throw new Error(`Not an rgb() color with alpha: ${value}`);
  return { rgb: [Number(match[1]), Number(match[2]), Number(match[3])], alpha: Number(match[4]) / 100 };
}

function over(top: { rgb: Rgb; alpha: number }, bottom: Rgb): Rgb {
  return top.rgb.map((channel, index) =>
    Math.round(channel * top.alpha + bottom[index] * (1 - top.alpha))) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: Rgb, b: Rgb): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const white: Rgb = [255, 255, 255];

describe("media library design tokens", () => {
  it("keeps text on opaque chrome readable regardless of the poster", () => {
    const chrome = hex(tokens["surface-chrome"]);
    expect(contrast(hex(tokens.ink), chrome)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(tokens["ink-muted"]), chrome)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex(tokens.brand), chrome)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps thumbnail badge text readable over the lightest image", () => {
    const scrim = over(rgba(tokens["thumb-scrim"]), white);
    expect(contrast(hex(tokens["sidebar-text"]), scrim)).toBeGreaterThanOrEqual(4.5);
  });

});
