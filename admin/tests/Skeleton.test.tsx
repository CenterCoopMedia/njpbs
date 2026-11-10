import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkeletonBlock, SkeletonRegion, SkeletonText } from "../src/components/ui/Skeleton";
// The accepted browse grammar reserves Edit followed by More in a trailing
// action column. Loading shapes share its classes/targets without becoming controls.
function expectBusyRegion(name: string) {
  const status = screen.getByRole("status", { name });
  expect(status).toHaveClass("sr-only");
  const region = status.closest("[data-skeleton]");
  expect(region).toHaveAttribute("aria-busy", "true");
  // Only the status line is announced; every shape is hidden from assistive technology.
  const shapes = region!.querySelectorAll(".skeleton-shape");
  expect(shapes.length).toBeGreaterThan(0);
  for (const shape of shapes) expect(shape.closest("[aria-hidden='true']")).not.toBeNull();
  return region as HTMLElement;
}

describe("Skeleton primitives", () => {
  it("marks the region busy, names the wait once and hides the shapes", () => {
    render(
      <SkeletonRegion label="Loading posts">
        <SkeletonBlock width={120} height={32} radius="control" />
        <SkeletonText lines={3} width="90%" lastLineWidth="40%" />
      </SkeletonRegion>,
    );
    const region = expectBusyRegion("Loading posts");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(region.querySelectorAll(".skeleton-text-line")).toHaveLength(3);
    const block = region.querySelector(".skeleton-block") as HTMLElement;
    expect(block).toHaveClass("skeleton-radius-control");
    expect(block.style.width).toBe("120px");
  });

  it("stops the sweep under reduced motion and forced colors", () => {
    const css = readFileSync(resolve(process.cwd(), "src/components/ui/Skeleton.css"), "utf8");
    expect(css).toMatch(/\.skeleton-shape \{[^}]*animation: skeleton-sweep/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.skeleton-shape \{\s*animation: none;\s*background-image: none;/,
    );
    expect(css).toMatch(/@media \(forced-colors: active\) \{\s*\.skeleton-shape \{\s*animation: none;\s*background-image: none;/);
  });

});
