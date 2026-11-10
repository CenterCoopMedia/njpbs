import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicOnlyBuild } from "../src/lib/build-target";

const searchPage = resolve("dist/search/index.html");

describe.skipIf(isPublicOnlyBuild(process.env))("built search runtime", () => {
  it("ships executable scripts without unresolved Vite preload markers", () => {
    expect(existsSync(searchPage)).toBe(true);
    const html = readFileSync(searchPage, "utf8");
    expect(html).not.toContain("__VITE_PRELOAD__");
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="(\/_astro\/[^"?#]+)"/g)) {
      const script = readFileSync(resolve("dist", match[1].slice(1)), "utf8");
      expect(script).not.toContain("__VITE_PRELOAD__");
    }
  });
});
