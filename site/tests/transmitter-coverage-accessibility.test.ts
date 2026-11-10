import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src", "components", "TransmitterCoverageMap.astro"),
  "utf8",
);

describe("transmitter coverage accessibility", () => {
  it("uses the station list as the single keyboard interface for choosing stations", () => {
    const contour = source.match(
      /<path\s+class:list=\{\["coverage-contour",[\s\S]*?<\/path>/,
    )?.[0] ?? "";

    expect(contour).toContain('aria-hidden="true"');
    expect(contour).not.toContain('role="button"');
    expect(contour).not.toContain('tabindex="0"');
    expect(source).not.toContain("data-map-control");
    expect(source).toMatch(
      /<button[\s\S]*?class:list=\{\["coverage-site-button",[\s\S]*?data-site-control[\s\S]*?aria-label=\{\`Select /,
    );
    expect(source).toContain(
      'aria-pressed={site.id === initialSite.id ? "true" : "false"}',
    );
  });

  it("preserves map distinctions in Windows High Contrast Mode", () => {
    expect(source).toContain("@media (forced-colors: active)");
    expect(source).toContain("stroke: CanvasText");
    expect(source).toContain("stroke: Highlight");
    expect(source).toContain("stroke-dasharray: 0.08 0.025");
    expect(source).toContain("stroke-dasharray: 0.015 0.02");
    expect(source).toMatch(
      /\.key-mark--coming\s*\{\s*border-block-color:\s*CanvasText;\s*background:\s*transparent;\s*\}/,
    );
  });
});
