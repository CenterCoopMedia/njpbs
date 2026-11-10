// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const TOKENS = readFileSync(new URL("../src/styles/design-tokens.css", import.meta.url), "utf8");

function customProperty(name: string): string {
  const match = TOKENS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return match?.[1].trim() ?? "";
}

describe("the concept 4 token contract", () => {
  it("defines the 24px floor, 44px preferred target, and spacing scale", () => {
    expect(customProperty("target-min")).toBe("1.5rem");
    expect(customProperty("target-comfortable")).toBe("2.75rem");
    expect(customProperty("space-1")).toBe("0.25rem");
    expect(customProperty("space-2")).toBe("0.5rem");
    expect(customProperty("space-3")).toBe("0.75rem");
    expect(customProperty("space-4")).toBe("1rem");
    expect(customProperty("space-6")).toBe("1.5rem");
    expect(customProperty("space-8")).toBe("2rem");
  });

  it("defines one focus treatment and a reduced-motion token override", () => {
    expect(customProperty("focus-outline")).toBe(
      "3px solid var(--color-focus-ring)",
    );
    expect(customProperty("focus-offset")).toBe("3px");
    expect(customProperty("focus-offset-inset")).toBe("-6px");
    expect(customProperty("motion-duration-fast")).toBe("150ms");
    expect(customProperty("motion-duration-standard")).toBe("200ms");
    expect(customProperty("motion-duration-emphasis")).toBe("360ms");
    expect(customProperty("motion-duration-loop")).toBe("5.6s");
    expect(TOKENS).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?--motion-duration-fast:\s*0\.01ms;/,
    );
    expect(TOKENS).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?--motion-duration-loop:\s*0\.01ms;/,
    );
  });
});
