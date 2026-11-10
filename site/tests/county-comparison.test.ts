// @vitest-environment happy-dom
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { allowedBlocksForSection } from "../../packages/content-core/src/editor-admin";
import { COUNTY_COMPARISON_DEFAULTS, isCountyComparisonData } from "../../packages/content-core/src/county-comparison";
import { countyMargin, countyStatewide, renderCountyComparison } from "../../packages/content-core/src/county-comparison-render";
import { installCountyComparisonControls } from "../../packages/content-core/src/county-comparison-controls";
import dataset from "../../packages/content-core/src/data/nj-federal-counties-2020-2024.v1.json";
import geometry from "../../packages/content-core/src/data/nj-county-svg-paths.json";
import { officialNjCountyShapes } from "../src/data/official-nj-boundaries";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/content-blocks.js");
const sectionServer = require("../../functions/lib/editor-section-contract.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const block = (data: unknown) => ({ id: "comparison", type: "county_comparison", order: 0, visible: true, data });

describe("county comparison saved contract", () => {
  it("projects a published Page with the reviewed comparison and excludes draft values", () => {
    const data = { ...COUNTY_COMPARISON_DEFAULTS, heading: "County election history" };
    const instant = "2026-11-02T12:00:00.000Z";
    const result = projectPublicPageDocument({
      pageId: "contact", assets: new Map(), now: new Date("2026-11-03T00:00:00.000Z"),
      document: {
        template: "genericPage", status: "published", publiclyVisible: true, publishAt: instant,
        title: "Private working title", blocks: [block({ ...data, heading: "Private working text" })],
        published: { sourceVersion: 1, publishedAt: instant,
          metadata: { title: "Election history", description: "Official county comparisons" }, blocks: [block(data)] },
      },
    });
    expect(result.state).toBe("live");
    expect(result.page.blocks).toEqual([block(data)]);
    expect(JSON.stringify(result)).not.toContain("Private working");
  });

  it("round-trips through the reader and server with the reviewed dataset pinned", () => {
    const input = JSON.parse(JSON.stringify([block(COUNTY_COMPARISON_DEFAULTS)]));
    expect(parseBlocks(input)).toEqual(server.parseBlocks(input));
    for (const section of ["programLanding", "genericPage"] as const) {
      expect(allowedBlocksForSection(section)).toContain("county_comparison");
      expect(sectionServer.validateSection(section, input)).toBeNull();
    }
    expect(allowedBlocksForSection("home")).not.toContain("county_comparison");
    expect(sectionServer.validateSection("home", input)).toMatchObject({
      detail: expect.stringContaining("not in the home catalog"),
    });
  });

  it.each([
    { ...COUNTY_COMPARISON_DEFAULTS, datasetVersion: "unreviewed" },
    { ...COUNTY_COMPARISON_DEFAULTS, rows: [] },
    { ...COUNTY_COMPARISON_DEFAULTS, heading: "x".repeat(301) },
    { ...COUNTY_COMPARISON_DEFAULTS, intro: "x".repeat(4001) },
    { ...COUNTY_COMPARISON_DEFAULTS, source: "x".repeat(1001) },
    { ...COUNTY_COMPARISON_DEFAULTS, source: "bad\u0000text" },
    { ...COUNTY_COMPARISON_DEFAULTS, heading: 7 },
    { heading: "", intro: "", source: "" },
  ])("rejects tampered or malformed data at both boundaries", data => {
    expect(isCountyComparisonData(data)).toBe(false);
    expect(parseBlocks([block(data)]).ok).toBe(false);
    expect(server.parseBlocks([block(data)]).ok).toBe(false);
  });
});

describe("reviewed official election snapshot", () => {
  it("covers all counties with the existing official geometry", () => {
    expect(dataset.rowCount).toBe(21);
    expect(dataset.counties).toHaveLength(21);
    expect(new Set(dataset.counties.map(row => row.county)).size).toBe(21);
    expect(geometry.counties).toEqual(officialNjCountyShapes);
    expect(dataset.counties.map(row => row.county)).toEqual(geometry.counties.map(row => row.name));
    expect(dataset.sources).toHaveLength(6);
    expect(dataset.sources.every(source => source.countyRows === 21 && /^[a-f0-9]{64}$/.test(source.sha256))).toBe(true);
  });

  it("reconciles with published DOE candidate and turnout totals", () => {
    // Official statewide PDF totals, downloaded November 3, 2026; see the dataset source URLs.
    const statewide = countyStatewide();
    expect(statewide["2020"].senate).toEqual({ democratic: 2541239, republican: 1817091, other: 82210 });
    expect(statewide["2024"].senate).toEqual({ democratic: 2161491, republican: 1773589, other: 96715 });
    expect(statewide["2020"].house).toEqual({ democratic: 2539187, republican: 1843088, other: 50748 });
    expect(statewide["2024"].house).toEqual({ democratic: 2115843, republican: 1828853, other: 92430 });
    expect(statewide["2020"].turnout).toEqual({ registered: 6407297, ballotsCast: 4635686 });
    expect(statewide["2024"].turnout).toEqual({ registered: 6682699, ballotsCast: 4321921 });
    expect(countyMargin(statewide["2024"].senate)).toBeCloseTo(100 * (2161491 - 1773589) / (2161491 + 1773589 + 96715), 8);
    expect(countyMargin({ democratic: 55, republican: 40, other: 5 })).toBe(15);
  });
});

function render(id = "one") {
  const root = document.createElement("div");
  root.innerHTML = renderCountyComparison(id, COUNTY_COMPARISON_DEFAULTS);
  return root;
}

describe("county comparison reader", () => {
  it("renders both complete tables, map labels and source links before JavaScript", () => {
    const root = render();
    expect(root.querySelectorAll("tbody tr")).toHaveLength(42);
    expect(root.querySelectorAll("tfoot tr")).toHaveLength(2);
    expect(root.querySelectorAll("table caption")).toHaveLength(2);
    expect(root.querySelectorAll("svg a")).toHaveLength(21);
    for (const link of root.querySelectorAll<HTMLAnchorElement>("svg a")) {
      expect(link.getAttribute("aria-label")).toMatch(/2024/);
      expect(root.querySelector(`[id="${link.getAttribute("href")!.slice(1)}"]`)?.getAttribute("tabindex")).toBe("-1");
    }
    expect(root.textContent).toContain("Congressional boundaries changed");
    expect(root.textContent).toContain("Write-ins are not separately reported");
    expect(root.textContent).toContain("Downloaded Nov. 3, 2026 (UTC).");
    expect(root.querySelectorAll('a[href^="https://nj.gov/state/elections/"]')).toHaveLength(6);
    expect([...root.querySelectorAll<HTMLButtonElement>("button")].every(button => button.hidden)).toBe(true);
    expect(root.querySelector("script, iframe")).toBeNull();
  });

  it("escapes editorial text and keeps IDs distinct across instances", () => {
    const root = document.createElement("div");
    root.innerHTML = renderCountyComparison("a", { ...COUNTY_COMPARISON_DEFAULTS, heading: '<img src=x onerror="bad()">', intro: "<script>bad()</script>", source: "<b>Credit</b>" }, 3) + renderCountyComparison("b", COUNTY_COMPARISON_DEFAULTS);
    expect(root.querySelector("img, script, b")).toBeNull();
    expect(root.querySelector("h3")?.textContent).toContain("<img");
    const ids = [...root.querySelectorAll("[id]")].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts numeric signed margins, keeps totals last, and limits sorting to its table", () => {
    const root = render();
    const cleanup = installCountyComparisonControls(root);
    const tables = root.querySelectorAll("table");
    const firstRow = (section: HTMLTableSectionElement) => section.querySelector<HTMLTableRowElement>(":scope > tr")!;
    expect(tables[0].querySelector('[data-county-sort="1"]')?.getAttribute("aria-label")).toContain("2020 result");
    const button = tables[0].querySelector<HTMLButtonElement>('[data-county-sort="2"]')!;
    expect(button.getAttribute("aria-label")).toContain("2024 result");
    button.click();
    expect(firstRow(tables[0].tBodies[0]).cells[0].textContent).toBe("Ocean");
    expect(button.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    button.click();
    expect(firstRow(tables[0].tBodies[0]).cells[0].textContent).toBe("Essex");
    expect(firstRow(tables[1].tBodies[0]).cells[0].textContent).toBe("Atlantic");
    expect(firstRow(tables[0].tFoot!).cells[0].textContent).toBe("Statewide");
    expect(root.querySelector('[role="status"]')?.textContent).toContain("descending");
    cleanup();
    button.click();
    expect(firstRow(tables[0].tBodies[0]).cells[0].textContent).toBe("Essex");
  });
});
