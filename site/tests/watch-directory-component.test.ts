import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/WatchDirectory.astro", "utf8");

describe("WatchDirectory", () => {
  it("renders a labeled search, filter controls, result status, and reset path", () => {
    expect(source).toContain('for="watch-search"');
    expect(source).toContain('type="search"');
    expect(source).toContain('role="group"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("data-watch-reset");
    expect(source).toContain("data-watch-empty-reset");
  });

  it("provides a semantic sortable table and a separate mobile card view", () => {
    expect(source).toContain("<table");
    expect(source).toContain("<caption");
    expect(source).toContain('scope="col"');
    expect(source).toContain('scope="row"');
    expect(source).toContain("data-watch-sort-heading");
    expect(source).toContain("data-watch-card-list");
  });

  it("supports details, plain-language definitions, print, and shareable URL state", () => {
    expect(source).toContain("data-watch-detail");
    expect(source).toContain("watchDeliveryTypes.map");
    expect(source).toContain("data-watch-print");
    expect(source).toContain("data-watch-copy-link");
    expect(source).toContain("parseWatchDirectoryState");
    expect(source).toContain("serializeWatchDirectoryState");
    expect(source).toContain("window.history.replaceState");
    expect(source).toContain('value="area:desc"');
    expect(source).toContain('value="delivery:desc"');
    expect(source).toContain("detailReturnTarget");
    expect(source).toContain("closeDetail(true)");
    expect(source.indexOf("returnTarget?.focus()"))
      .toBeLessThan(source.indexOf("detail.hidden = true"));
    expect(source).toContain(".watch-detail__link[hidden]");
    expect(source).toContain('data-print-watch-directory');
    expect(source).toContain('class="watch-action-status"');
  });
});
