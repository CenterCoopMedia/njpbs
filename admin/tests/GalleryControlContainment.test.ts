import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...styles.matchAll(new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm")),
  ].map((match) => match[1]);
}

function cssBlocks(marker: string): string[] {
  const blocks: string[] = [];
  let offset = 0;

  while (true) {
    const start = styles.indexOf(marker, offset);
    if (start < 0) return blocks;
    const open = styles.indexOf("{", start + marker.length);
    if (open < 0) return blocks;
    let depth = 1;
    let cursor = open + 1;

    while (depth > 0 && cursor < styles.length) {
      if (styles[cursor] === "{") depth += 1;
      if (styles[cursor] === "}") depth -= 1;
      cursor += 1;
    }

    if (depth > 0) return blocks;
    blocks.push(styles.slice(start, cursor));
    offset = cursor;
  }
}

describe("gallery control containment", () => {
  it("lets every nested gallery surface shrink inside the post canvas", () => {
    for (const selector of [
      ".inline-gallery-item",
      ".inline-gallery-item .inline-image-editor",
      ".inline-gallery-item .inline-image-picker-selection",
      ".inline-gallery-item .inline-image-picker-actions",
    ]) {
      expect(ruleBodies(selector).join("\n")).toMatch(/min-width:\s*0/);
    }
    expect(ruleBodies(".inline-gallery-item").join("\n")).toMatch(
      /container(?:-type)?:\s*inline-size/,
    );
  });

  it("stacks picker and destructive actions from the card's width", () => {
    const cardQueries = cssBlocks("@container gallery-item");
    expect(cardQueries).not.toHaveLength(0);
    const query = cardQueries.join("\n");

    expect(query).toMatch(
      /\.inline-image-picker-selection\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(query).toMatch(
      /\.inline-image-picker-actions\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(query).toMatch(
      /\.inline-gallery-item \.inline-collection-controls\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(query).toMatch(
      /\.inline-gallery-remove\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
    );
  });

  // The carousel mode edits as one scrolling row (#1034). The row is the only thing that
  // scrolls: each item keeps the container query that stacks its controls, so a narrow screen or
  // a deep zoom still gets stacked actions rather than the collision #1062 fixed, and the item
  // width is measured against the viewport so the editor canvas itself never scrolls sideways.
  it("scrolls the carousel row without letting the page scroll with it", () => {
    const row = ruleBodies(
      '.inline-image-gallery[data-presentation="carousel"] .image-gallery',
    ).join("\n");

    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/overflow-x:\s*auto/);
    expect(row).toMatch(/scroll-snap-type:\s*x\s+proximity/);
    expect(row).toMatch(/overscroll-behavior-x:\s*contain/);
    // The two rules that keep the row's scrolling from becoming the canvas's. Without inline-size
    // containment the item widths cannot resolve and every ancestor grows to the widest item;
    // without a positioned row, the visually hidden text inside each item escapes the clip. Both
    // showed up only in the browser, at 320 pixels and at 400% zoom (#1034).
    expect(row).toMatch(/container-type:\s*inline-size/);
    expect(row).toMatch(/position:\s*relative/);
    expect(row).toMatch(/min-width:\s*0/);

    const item = ruleBodies(
      '.inline-image-gallery[data-presentation="carousel"] .inline-gallery-item',
    ).join("\n");
    expect(item).toMatch(/flex:\s*0\s+0\s+min\(/);
    expect(item).toMatch(/scroll-snap-align:\s*start/);
    // The per-item container query is what keeps the controls from colliding, so a carousel
    // item must still be a container.
    expect(ruleBodies(".inline-gallery-item").join("\n")).toMatch(
      /container(?:-type)?:\s*inline-size/,
    );
  });

  it("shows focus on the carousel row, which the keyboard has to reach to scroll it", () => {
    expect(
      ruleBodies(
        '.inline-image-gallery[data-presentation="carousel"] .image-gallery:focus-visible',
      ).join("\n"),
    ).toMatch(/outline/);
  });

  it("keeps every gallery action at the 44 pixel target floor", () => {
    const actionRules = [
      ...ruleBodies(".inline-gallery-item .inline-image-picker-actions .button"),
      ...ruleBodies(".inline-gallery-item .inline-collection-controls .button"),
    ].join("\n");

    expect(actionRules).toMatch(
      /min-height:\s*var\(--target-comfortable\)/,
    );
    expect(actionRules).toMatch(
      /min-width:\s*var\(--target-comfortable\)/,
    );
  });
});
