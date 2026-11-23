import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import elections from "../../packages/content-core/data/nj-town-elections-v1.json";
import boundaries from "../../packages/content-core/data/nj-town-boundaries-v1.json";
import trends from "../../packages/content-core/data/nj-town-election-trends.json";
import type { TrendCounts } from "../../packages/content-core/src/town-election-trends";
import { TOWN_LOOKUP_DEFAULTS } from "../../packages/content-core/src/town-lookup";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import { SECTION_BLOCK_CATALOG, validateSection } from "../../packages/content-core/src/editor-admin";
import { installTownLookupControls } from "../../packages/content-core/src/town-lookup-controls";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/content-blocks.js");
const sections = require("../../functions/lib/editor-section-contract.js");
const generated = require("../../functions/lib/block-content-validation.js");
const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
const { projectPublicPageDocument } = require("../../functions/lib/public-content-projection.js");
const block = { id: "lookup", type: "town_lookup" as const, order: 0, visible: true, data: { ...TOWN_LOOKUP_DEFAULTS } };
const html = renderBlock(block);

describe("town lookup save and publish contracts", () => {
  it.each([
    ["watch", "programLanding"], ["privacy", "genericPage"],
  ])("projects a published lookup through the real %s Page read boundary", (pageId, template) => {
    const blocks = [block];
    const document = { id: pageId, template, title: "Town results", description: "Past election results.",
      status: "published", publiclyVisible: true, publishAt: "2026-11-02T20:00:00.000Z", version: 2, blocks,
    };
    const published = createPublishedSnapshot({ collection: "cmsPages", document,
      publishedAt: "2026-11-02T20:00:00.000Z", publishedBy: "fixture-editor" });
    const projected = projectPublicPageDocument({ pageId, document: { ...document, published },
      assets: new Map(), now: new Date("2026-11-02T21:00:00.000Z") });
    expect(projected.state).toBe("live");
    const selected = projected.page.blocks.find((item: { id: string }) => item.id === block.id);
    expect(selected.data).toEqual(block.data);
    expect(renderBlock(selected)).toContain("Past election results by municipality and county");
  });

  it("round trips editable copy on the two allowed Page templates through both validators", () => {
    for (const section of ["programLanding", "genericPage"] as const) {
      expect(SECTION_BLOCK_CATALOG[section]).toContain("town_lookup");
      const county = SECTION_BLOCK_CATALOG[section].indexOf("county_comparison");
      expect(SECTION_BLOCK_CATALOG[section].slice(county, county + 2)).toEqual(["county_comparison", "town_lookup"]);
      expect(validateSection(section, [block])).toBe(null);
      expect(sections.validateSection(section, [block])).toBe(null);
    }
    expect(SECTION_BLOCK_CATALOG.post).not.toContain("town_lookup");
    expect(server.parseBlocks(JSON.parse(JSON.stringify([block])))).toEqual(parseBlocks([block]));
    expect(parseBlocks([block]).ok).toBe(true);
    expect(generated.blockContentError([block])).toBe(null);
  });

  it.each(["home", "post"] as const)("refuses town lookups on %s in client and server placement", section => {
    expect(SECTION_BLOCK_CATALOG[section]).not.toContain("town_lookup");
    for (const visible of [true, false]) {
      const placed = [{ ...block, visible }];
      expect(validateSection(section, placed)).not.toBe(null);
      expect(sections.validateSection(section, placed)).not.toBe(null);
    }
  });

  it.each([
    { heading: "" }, { heading: "x".repeat(201) }, { introduction: 42 },
    { introduction: "x".repeat(4001) }, { sourceLine: "x".repeat(501) },
    { datasetUrl: "https://example.test/unreviewed.json" },
  ])("rejects invalid or unreviewed payload %#", change => {
    const input = [{ ...block, data: { ...block.data, ...change } }];
    expect(parseBlocks(input).ok).toBe(false);
    expect(server.parseBlocks(input)).toEqual(parseBlocks(input));
  });

  it("keeps incomplete headings editable in drafts and hidden planks", () => {
    const input = [{ ...block, data: { ...block.data, heading: "" } }];
    expect(parseBlocks(input, { complete: false }).ok).toBe(true);
    expect(server.parseBlocks(input, { complete: false })).toEqual(parseBlocks(input, { complete: false }));
    expect(parseBlocks([{ ...input[0], visible: false }]).ok).toBe(true);
  });
});

describe("reviewed municipal data", () => {
  it("preserves official counts, the Pine Hill merger and real zero turnout across the decade", () => {
    expect(Object.keys(trends.towns).sort()).toEqual(elections.towns.map(town => town.id).sort());
    let votePeriods = 0;
    let turnoutPeriods = 0;
    for (const periods of Object.values(trends.towns) as TrendCounts[]) {
      expect(periods).toHaveLength(10);
      const registrations = periods.flatMap(([, turnout]) => turnout ? [turnout[0]] : []).sort((a, b) => a - b);
      const typical = registrations[Math.floor(registrations.length / 2)];
      for (const [index, [race, turnout]] of periods.entries()) {
        if (race) {
          votePeriods++;
          expect([0, 1, 4, 5, 8, 9]).toContain(index);
          expect(race[0] + race[1]).toBeLessThanOrEqual(race[2]);
          expect(race[2]).toBeLessThanOrEqual(turnout?.[1] ?? typical);
        }
        if (turnout) {
          turnoutPeriods++;
          expect(turnout[1]).toBeLessThanOrEqual(turnout[0]);
          // Reconciled county aggregates alone cannot catch transposed municipal rows.
          expect(turnout[0]).toBeGreaterThanOrEqual(typical / 2);
          expect(turnout[0]).toBeLessThanOrEqual(typical * 2);
        }
      }
    }
    expect(votePeriods).toBe(564 * 6 - 8);
    expect(turnoutPeriods).toBe(564 * 10 - 17);
    expect(trends.towns["0101"][0]).toEqual([[1949, 2163, 4240], [6066, 4343]]);
    expect(trends.towns["0101"][9]).toEqual([[1942, 1961, 3928], [7413, 3994]]);
    expect(trends.towns["0428"][5]).toEqual([[1589 + 2, 946 + 6, 2553 + 8], [7830 + 14, 2589 + 8]]);
    expect(trends.towns["0428"][6]).toEqual([null, [7750, 2431]]);
    expect(trends.towns["0433"][3]).toEqual([null, [6, 0]]);
    expect(trends.towns["0112"][5][1]).toEqual([21801, 8255]);
    expect(trends.towns["0418"][9][0]).toEqual([2797, 1358, 4176]);
    expect(trends.towns["1425"][7][1]).toEqual([3681, 972]);
    expect(trends.towns["0822"][5]).toEqual([null, null]);
    expect(trends.towns["0823"][5]).toEqual([null, null]);
  });

  it("covers 564 unique codes across 21 counties with complete source provenance", () => {
    expect(elections.towns).toHaveLength(564);
    expect(new Set(elections.towns.map(t => t.id)).size).toBe(564);
    expect(new Set(elections.towns.map(t => t.county)).size).toBe(21);
    expect(new Set(boundaries.towns.map(t => t.id))).toEqual(new Set(elections.towns.map(t => t.id)));
    for (const source of Object.values(elections.sources)) {
      expect(source.rows).toBe(564);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.url).toMatch(/^https:\/\/datawrapper.dwcdn.net\/.+\/dataset.csv$/);
    }
    for (const town of elections.towns) {
      for (const pair of [town.president2016, town.president2020, town.president2024, town.senate2024, town.house2024.shares]) {
        expect(pair.every(v => Number.isFinite(v) && v >= 0 && v <= 100)).toBe(true);
        expect(pair[0] + pair[1]).toBeLessThanOrEqual(100.1);
      }
      const turnout = town.turnout2024;
      expect(Math.abs(turnout.percent - 100 * turnout.ballots / turnout.registered)).toBeLessThanOrEqual(.11);
    }
  });

  it("matches Absecon shares and turnout against official DOE totals", () => {
    // DOE 2024 Atlantic president, Senate, House CD2 and ballots-cast PDFs.
    // Links and denominator checks: docs/cms/town-election-lookup.md.
    const town = elections.towns.find(t => t.id === "0101")!;
    const shares = (counts: number[]) => counts.slice(0, 2).map(v => Number((100 * v / counts.reduce((a, b) => a + b, 0)).toFixed(1)));
    expect(town.president2024).toEqual(shares([2248, 2753, 28, 35, 10, 5, 8, 2, 2]));
    expect(town.senate2024).toEqual(shares([2247, 2575, 14, 15, 36, 14]));
    expect(town.house2024.shares).toEqual(shares([2139, 2796, 24]));
    expect(town.turnout2024).toEqual({ registered: 7462, ballots: 5154, percent: 69.1 });
  });
});

describe("HTML fallback and progressive selection", () => {
  beforeEach(() => { document.body.innerHTML = html; });

  it("ships every figure in real tables with dated source links before scripts run", () => {
    expect(document.querySelectorAll("tbody tr")).toHaveLength(564);
    expect(document.querySelector(".town-lookup__search")?.hasAttribute("hidden")).toBe(true);
    const headers = Array.from(document.querySelectorAll("thead th a"));
    expect(headers).toHaveLength(6);
    expect(headers.map(h => h.textContent)).toEqual(["2016 president", "2020 president", "2024 president", "2024 U.S. Senate", "2024 U.S. House", "2024 turnout"]);
    const absecon = document.querySelector('tr[data-town-id="0101"]')!;
    expect(absecon.textContent).toContain("5,154 ballots / 7,462 registered voters");
    expect(absecon.querySelector("td:nth-last-child(2)")?.textContent).toContain("2025: D 49.4% / R 49.9%");
    expect(absecon.querySelector("td:last-child")?.textContent).toContain("2025: 53.9%");
    expect(html).not.toMatch(/<script|<iframe/i);
    const escaped = renderBlock({ ...block, data: { ...block.data, heading: '<img src=x onerror="alert(1)">', sourceLine: "<script>bad</script>" } });
    expect(escaped).toContain("&lt;img");
    expect(escaped).not.toContain("<script>");
  });

  it("fits every official town/county outline and the full location markers in the SVG viewport", () => {
    const [left, top, width, height] = document.querySelector("svg")!.getAttribute("viewBox")!.split(" ").map(Number);
    const right = left + width;
    const bottom = top + height;
    for (const shape of [...boundaries.counties, ...boundaries.towns]) {
      const coordinates = shape.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      for (let index = 0; index < coordinates.length; index += 2) {
        expect(coordinates[index]).toBeGreaterThanOrEqual(left + 2);
        expect(coordinates[index]).toBeLessThanOrEqual(right - 2);
        expect(coordinates[index + 1]).toBeGreaterThanOrEqual(top + 2);
        expect(coordinates[index + 1]).toBeLessThanOrEqual(bottom - 2);
      }
    }
    // Radius 9 plus half the 2-unit marker stroke needs 10 units of room.
    for (const town of boundaries.towns) {
      expect(town.marker[0] - 10).toBeGreaterThanOrEqual(left);
      expect(town.marker[0] + 10).toBeLessThanOrEqual(right);
      expect(town.marker[1] - 10).toBeGreaterThanOrEqual(top);
      expect(town.marker[1] + 10).toBeLessThanOrEqual(bottom);
    }
  });

  it("submits exact county-qualified identities, updates the map and clears stale results", () => {
    installTownLookupControls(document);
    installTownLookupControls(document);
    expect(document.querySelectorAll("datalist option")).toHaveLength(564);
    const input = document.querySelector<HTMLInputElement>(".town-lookup input")!;
    const status = document.querySelector(".town-lookup__status")!;
    const submit = () => document.querySelector<HTMLButtonElement>(".town-lookup button")!.click();
    const set = (value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
    set("Washington Township");
    submit();
    expect(status.textContent).toContain("No exact match");
    set("Washington Township, Bergen County");
    expect(document.querySelector(".town-lookup__results caption")).toBe(null);
    submit();
    expect(document.querySelector(".town-lookup__results caption")?.textContent).toBe("Washington Township, Bergen County");
    expect(document.querySelectorAll(".town-lookup__results tbody tr")).toHaveLength(6);
    const id = elections.towns.find(t => t.name === "Washington Township" && t.county === "Bergen")!.id;
    expect(document.querySelector(".town-lookup__highlight")?.getAttribute("d")).toBe(boundaries.towns.find(t => t.id === id)!.path);
    set("Washington Township, Warren County");
    submit();
    expect(document.querySelector(".town-lookup__results caption")?.textContent).toContain("Warren County");
    set("not a town");
    submit();
    expect(status.textContent).toContain("No exact match");
    expect(document.querySelector(".town-lookup__selected")?.hasAttribute("hidden")).toBe(true);
    set("");
    expect(document.querySelector(".town-lookup__results")?.textContent).toBe("");
  });

  it("replaces the source-linked trend table when the selected town changes", () => {
    installTownLookupControls(document);
    const input = document.querySelector<HTMLInputElement>(".town-lookup input")!;
    const submit = document.querySelector<HTMLButtonElement>(".town-lookup button")!;
    const trend = document.querySelector(".town-trends")!;
    input.value = "Tavistock Borough, Camden County";
    // The button must handle selection before the default submit action so it
    // works in the editor's sandboxed preview, where native submits are blocked.
    expect(submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(false);
    const rows = trend.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(10);
    expect(rows[3].querySelectorAll("td")[1].textContent).toBe("0.0%");
    expect(rows[9].querySelector("a")?.getAttribute("href")).toMatch(/2025-official-general-results-governor-camden\.pdf$/);
    input.value = "Hamilton Township, Atlantic County";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(trend.querySelector("table")).toBeNull();
    submit.click();
    expect(trend.querySelector("caption")?.textContent).toContain("Hamilton Township");
    const corrected = trend.querySelectorAll("tbody tr")[5];
    expect(corrected.querySelectorAll("td")[2].textContent).toBe("37.9%");
    expect(corrected.querySelector('a[aria-label="2021 turnout (PDF)"]')?.getAttribute("href")).toContain("atlanticcountyclerk.org");
    input.value = "Neptune Township, Monmouth County";
    submit.click();
    const gap = trend.querySelectorAll("tbody tr")[1];
    expect(Array.from(gap.querySelectorAll("td")).slice(0, 2).map(cell => cell.textContent)).toEqual(["Unavailable", "Unavailable"]);
    expect(gap.querySelector('a[aria-label="2017 results (PDF)"]')).toBeNull();
    expect(document.querySelector(".town-lookup__results tbody tr")?.textContent).toContain("Clinton (D): 66.8%");
  });
});
