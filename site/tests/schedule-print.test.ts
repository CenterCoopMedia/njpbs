import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source-level guard for the print stylesheet (issue #360). happy-dom does not
// lay out print media, so we assert the rules exist and target the right
// surfaces the same way the sibling schedule tests assert on component source;
// the behavioural proof is a headed-browser print-emulation check.
const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const printBlock = (source: string): string => {
  const start = source.indexOf("@media print");
  if (start === -1) return "";
  // Return only the balanced @media print { ... } block, not everything to the
  // end of the file. PublicSiteLayout has non-print styles after the print block
  // (including .site-head, .site-foot, and display:none rules), so slicing to EOF
  // would let these assertions pass even if the print rules were removed or
  // miswired (Copilot review on #361). Brace-count to the matching close.
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
};

describe("public pages print legibly (issue #360)", () => {
  const layout = readSource("../src/layouts/PublicSiteLayout.astro");
  const servicePageStyles = readSource("../src/styles/service-page.css");
  const tokens = readSource("../src/styles/design-tokens.css");

  it("prints dark ink on light paper, hides chrome and leaves listings unclipped", () => {
    expect(layout).toContain("@media print");
    const print = printBlock(layout);
    expect(print).toContain("background: var(--color-paper)");
    expect(print).toContain("color: var(--color-print-ink)");
    expect(tokens).toContain("--color-paper: #ffffff;");
    expect(tokens).toContain("--color-print-ink: #10131f;");
    expect(print).toContain(".site-head");
    expect(print).toContain(".site-foot");
    expect(print).toMatch(/display:\s*none/i);
    expect(servicePageStyles).toContain("@media print");
    const schedulePrint = printBlock(servicePageStyles);
    expect(schedulePrint).toContain(".public-page__schedule");
    expect(schedulePrint).toMatch(/overflow:\s*visible/i);
  });
});
