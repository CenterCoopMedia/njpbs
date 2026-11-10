import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("the public Posts index", () => {
  it("keeps the fallback lockup white with PBS-blue counterforms", () => {
    const logo = readSource("../public/brand/njpbs-vertical-white.svg");

    expect(logo).toContain(".cls-1,.cls-2{fill:#fff;}");
    expect(logo).toContain(".cls-3{fill:#2638c4;}");
    expect(logo).toContain('id="NJPBS_WhiteBlue_Vertical"');
  });
});
