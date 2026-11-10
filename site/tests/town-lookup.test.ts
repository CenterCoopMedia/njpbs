import { beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import elections from "../../packages/content-core/data/nj-town-elections-v1.json";
import boundaries from "../../packages/content-core/data/nj-town-boundaries-v1.json";
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
    expect(document.querySelector('tr[data-town-id="0101"]')?.textContent).toContain("5,154 ballots / 7,462 registered voters");
    expect(html).not.toMatch(/<script|<iframe|governor/i);
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
});
