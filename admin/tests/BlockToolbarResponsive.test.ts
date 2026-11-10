import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
const layoutModeStyles = readFileSync(
  resolve(process.cwd(), "src/editor-layout-mode.css"),
  "utf8",
);

// Issue #1043 leaves a shorter block toolbar. These assertions hold the narrow-width behavior the
// remaining controls depend on: at a narrow editor the floating toolbar becomes a plain, always
// visible row that wraps, so no control is hover-only or pushed off the card.
describe("Block card toolbar at narrow widths", () => {
  it("keeps block and layout movement controls visible for touch input", () => {
    expect(styles).toMatch(
      /@media \(hover: none\), \(any-pointer: coarse\), \(max-width: 720px\)[\s\S]*?\.block-toolbar\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/,
    );
    expect(layoutModeStyles).toMatch(
      /@media \(hover: none\), \(any-pointer: coarse\)[\s\S]*?\.editor-bento\[data-layout-mode="customize"\] \.editor-bento-card-controls\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/,
    );
  });

  it("keeps customize controls in the keyboard path and reveals the focused card", () => {
    expect(layoutModeStyles).toMatch(
      /\.editor-bento\[data-layout-mode="customize"\] \.editor-bento-card-controls\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/,
    );
    expect(layoutModeStyles).not.toMatch(
      /\.editor-bento\[data-layout-mode="customize"\] \.editor-bento-card-controls\s*\{[^}]*display:\s*none/,
    );
    expect(layoutModeStyles).toMatch(
      /\.editor-bento\[data-layout-mode="customize"\][\s\S]*?\.editor-bento-card:focus-within[\s\S]*?\.editor-bento-card-controls\s*\{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/,
    );
  });

});
