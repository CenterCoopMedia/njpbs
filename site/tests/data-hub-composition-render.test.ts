// @vitest-environment node
import { readFileSync } from "node:fs";
import { Window, type HTMLInputElement, type HTMLSelectElement, type HTMLButtonElement } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataHubBlocks } from "../../packages/content-core/src/data-hub-composition";
import { generatedHeadingLevelAt, renderBlock } from "../../packages/content-core/src/content-render";
import { contentBlockHtml, renderContentGroups } from "../../packages/content-core/src/content-row-render";
import type { PageBlock } from "../../packages/content-core/src/content-model";
import { dataHubCompositionHtml, dataHubSectionHtml } from "../src/lib/data-hub-composition-render";
import { emptyDataHubReporting, emptyReportingMapping } from "../../packages/content-core/src/data-hub-reporting";
import { dataHubReportingHtml } from "../src/lib/data-hub-reporting-render";
const html = readFileSync(new URL("../src/data/njpbs-data-hub-v16.html", import.meta.url), "utf8");
const source = (value: string) => value.match(/<script id="source-data" type="application\/json">([\s\S]*?)<\/script>/)![1];
const windows: Window[] = [];
function mount(blocks: PageBlock[], source = html) {
  const reader = dataHubCompositionHtml(source, blocks, 1);
  const groups = renderContentGroups(blocks, (block, index) => ({ html: renderBlock(block, {
    generatedHeadingLevel: generatedHeadingLevelAt(blocks, index),
    resolveDataHubSection: (data, level) => dataHubSectionHtml(source, data, level),
  }) }));
  const window = new Window({ url: "https://njpbs.example/data-hub/", settings: { disableIframePageLoading: true } });
  windows.push(window);
  const downloads: Blob[] = [];
  Object.defineProperty(window.URL, "createObjectURL", { value: (blob: Blob) => { downloads.push(blob); return "blob:test"; } });
  Object.defineProperty(window.URL, "revokeObjectURL", { value: () => {} });
  window.HTMLAnchorElement.prototype.click = () => {};
  window.document.body.innerHTML = `<main class="data-hub data-hub--composed"><div class="cms-page__blocks">${groups.map(contentBlockHtml).join("")}</div>${reader}</main>`;
  window.eval(reader.match(/<script>([\s\S]*?)<\/script>/)![1]);
  return { document: window.document, window, reader, downloads };
}
afterEach(() => { for (const window of windows.splice(0)) window.happyDOM.abort(); });

describe("compiled Data Hub Page composition", () => {
  it("keeps legacy and unchanged migrated bytes exact, including immutable source values", () => {
    expect(dataHubCompositionHtml(html, [])).toBe(html);
    const legacy = [{ id: "old-heading", type: "headline", order: 0, visible: true,
      data: { text: "Retained legacy content", level: 2 } }] satisfies PageBlock[];
    expect(dataHubCompositionHtml(html, legacy)).toBe(html);
    expect(legacy[0].data.text).toBe("Retained legacy content");
    expect(dataHubCompositionHtml(html, defaultDataHubBlocks(), 1)).toBe(html);
    expect(dataHubCompositionHtml(html, defaultDataHubBlocks().map(block => ({ ...block,
      data: { ...block.data, heading: "  ", introduction: "\n " } })), 1)).toBe(html);
    const edited = defaultDataHubBlocks();
    edited[0].data.heading = "Staff heading";
    expect(source(dataHubCompositionHtml(html, edited, 1))).toBe(source(html));
  });
  it("inherits compiled copy for whitespace-only overrides in an edited layout", () => {
    const source = defaultDataHubBlocks().find(block => block.data.sectionId === "unemployment")!;
    const block = { ...source, data: { ...source.data, heading: "  ", introduction: "\n " } };
    const { document } = mount([block]);
    expect(document.querySelector('.cms-page__blocks .measure__summary [tabindex="-1"]')!.textContent).toBe("Unemployment rate");
    expect(document.querySelector('.cms-page__blocks .measure__description')!.textContent).toContain("Share of the New Jersey labor force");
    expect(dataHubSectionHtml(html, block.data, 2)).toContain("Unemployment rate</h2>");
    expect(block.data.heading).toBe("  ");
  });
  it("requires an explicit supported version and refuses unknown section payloads", () => {
    expect(() => dataHubCompositionHtml(html, defaultDataHubBlocks())).toThrow();
    expect(() => dataHubCompositionHtml(html, [], 2 as 1)).toThrow();
    expect(() => dataHubCompositionHtml(html, [{ ...defaultDataHubBlocks()[0], data: { sectionId: "forged", heading: "", introduction: "" } }] as unknown as PageBlock[], 1)).toThrow();
  });
  it("honors section order, edited copy and ordinary Page content without changing source-data", () => {
    const blocks = defaultDataHubBlocks();
    blocks[0].data.heading = "The edited Page heading";
    blocks[0].data.introduction = "An edited Page introduction.";
    const { document, reader } = mount(blocks);
    expect(document.querySelector("#main-title")!.textContent).toBe("The edited Page heading");
    expect(document.querySelector(".intro__lead")!.textContent).toBe("An edited Page introduction.");
    expect(document.querySelectorAll('.cms-page__blocks .measure')).toHaveLength(18);
    expect(reader.match(/<script id="source-data" type="application\/json">([\s\S]*?)<\/script>/)![1])
      .toBe(html.match(/<script id="source-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
    expect(document.querySelector("#metric-unemployment")!.textContent).toContain("4.2%");
    const ids = [...document.querySelectorAll("[id]")].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("removes figures from selection, retains staff order, and filters the same movable figures", () => {
    const blocks = defaultDataHubBlocks();
    const selected = ["finder", "collection", "snap", "unemployment"];
    const arranged: PageBlock[] = selected.map((id, order) => ({ ...blocks.find(block => block.data.sectionId === id)!, order }));
    arranged.splice(3, 0, { id: "staff-copy", type: "prose", order: 3, visible: true, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Staff context between the figures." }] }] } } });
    arranged.forEach((block, order) => { block.order = order; });
    const { document, window } = mount(arranged);
    expect([...document.querySelectorAll(".cms-page__blocks .measure")].map(node => node.id)).toEqual(["metric-snap", "metric-unemployment"]);
    expect(document.querySelector(".cms-page__blocks")!.textContent).toContain("Staff context between the figures.");
    expect(document.querySelector("#metric-electricity")).toBeNull();
    const search = document.querySelector("#metric-search") as HTMLInputElement;
    search.value = "SNAP";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(document.querySelector("#metric-snap")).not.toBeNull();
    expect(document.querySelector("#metric-unemployment")).toBeNull();
    search.value = "";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect([...document.querySelectorAll(".cms-page__blocks .measure")].map(node => node.id)).toEqual(["metric-snap", "metric-unemployment"]);
  });
  it("keeps Featured and exports usable when its full figure section is removed", async () => {
    const blocks = defaultDataHubBlocks().filter(block => ["featured", "collection", "snap"].includes(block.data.sectionId)).map((block, order) => ({ ...block, order }));
    const { document, downloads } = mount(blocks);
    expect(document.querySelector("#featured-plot svg")).not.toBeNull();
    expect(document.querySelector("#metric-minimumwage")).toBeNull();
    (document.querySelector('#metric-snap [data-open-figure]') as HTMLButtonElement).click();
    (document.querySelector('[data-export-format="json"]') as HTMLButtonElement).click();
    expect(JSON.parse(await downloads.at(-1)!.text()).metric.value).toBe(737447);
  });
  it("keeps an explicitly empty staff composition empty", () => {
    const { document } = mount([]);
    expect(document.querySelector(".cms-page__blocks")!.children).toHaveLength(0);
    expect(document.querySelector("#data-hub-content")!.hasAttribute("hidden")).toBe(true);
  });
  it("keeps compiled figure copy in dated downloads when staff change Page copy", async () => {
    const block = defaultDataHubBlocks().find(block => block.data.sectionId === "unemployment")!;
    block.order = 0; block.data.heading = "Staff heading"; block.data.introduction = "Staff introduction";
    const { document, downloads } = mount([block]);
    expect(document.querySelector(".measure__summary")!.textContent).toContain("Staff heading");
    (document.querySelector('[data-open-figure]') as HTMLButtonElement).click();
    expect(document.querySelector("#figure-dialog-title")!.textContent).toContain("Unemployment rate");
    (document.querySelector('[data-export-format="json"]') as HTMLButtonElement).click();
    const exported = JSON.parse(await downloads.at(-1)!.text());
    expect(exported.metric).toMatchObject({ title: "Unemployment rate", value: 4.2,
      description: "Share of the New Jersey labor force unemployed in September 2026, seasonally adjusted." });
    expect(JSON.stringify(exported)).not.toContain("Staff heading");
  });
});

describe("composed reader accessibility and source content", () => {
  it("keeps the complete Featured and methodology copy without JavaScript", () => {
    const sections = defaultDataHubBlocks();
    const featured = dataHubSectionHtml(html, sections.find(block => block.data.sectionId === "featured")!.data, 2);
    for (const text of ["$15.92", "$16.48", "Sept. 29, 2026", "Different rules apply to tipped workers"]) expect(featured).toContain(text);
    const methodology = dataHubSectionHtml(html, sections.at(-1)!.data, 2);
    expect(methodology).toContain("Property tax bills are not rates");
    expect(methodology).toContain("reuse rights are cleared");
    expect(featured).not.toMatch(/\bid="|href="#/);
  });
  it("uses the standard generated heading rank and keeps reader jump focus", async () => {
    const blocks: PageBlock[] = [
      { id: "group", type: "headline", order: 0, visible: true, data: { text: "Employment", level: 2 } },
      ...defaultDataHubBlocks().filter(block => ["finder", "unemployment"].includes(block.data.sectionId)).map((block, index) => ({ ...block, order: index + 1 })),
    ];
    const { document, window } = mount(blocks);
    expect(document.querySelector("#metric-unemployment .measure__summary h3")).not.toBeNull();
    const jump = document.querySelector("#metric-jump") as HTMLSelectElement;
    jump.value = "unemployment";
    jump.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(document.querySelector('#metric-unemployment .measure__summary [tabindex="-1"]'));
  });
  it("uses the standard mixed row renderer for figures, text and links", () => {
    const metric = defaultDataHubBlocks().find(block => block.data.sectionId === "unemployment")!;
    const blocks: PageBlock[] = [
      { id: "columns", type: "row", order: 0, visible: true, data: { columns: [6, 6] } },
      { ...metric, order: 1, layout: { rowId: "columns", column: 0 } },
      { id: "context", type: "link_card", order: 2, visible: true, layout: { rowId: "columns", column: 1 },
        data: { title: "Read the official context", url: "https://www.nj.gov/labor/" } },
    ];
    const { document } = mount(blocks);
    expect(document.querySelector(".cms-row__column:first-child .measure")).not.toBeNull();
    expect(document.querySelector('.cms-row__column:nth-child(2) a[href="https://www.nj.gov/labor/"]')).not.toBeNull();
  });
  it("treats staff headings and introductions as text in both the page and source-safe script", () => {
    const block = defaultDataHubBlocks().find(block => block.data.sectionId === "unemployment")!;
    block.data.heading = '</script><img src=x onerror="window.exposed=true">';
    block.data.introduction = "<script>window.exposed=true</script>";
    const { document, window } = mount([block]);
    expect(document.querySelector("#metric-unemployment .measure__summary")!.textContent).toContain(block.data.heading);
    expect(document.querySelector("#metric-unemployment img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).exposed).toBeUndefined();
  });
});


it("keeps related reporting attached to figure identity after rearrangement", () => {
  const mapping = { ...emptyReportingMapping(), posts: { tags: ["wages"], categories: [] } };
  const config = { ...emptyDataHubReporting(), figures: { minimumwage: mapping } };
  const source = dataHubReportingHtml(html, config, [{ source: "posts", id: "wage-story", title: "Published wage context",
    href: "https://njpbs.org/posts/wage-context/", publishedAt: "2026-10-20T12:00:00.000Z", tags: ["wages"], categories: [] }], undefined, Date.parse("2026-10-23T12:00:00.000Z"));
  const selected = defaultDataHubBlocks().filter(block => ["minimumwage", "featured"].includes(block.data.sectionId));
  for (const order of [selected, [...selected].reverse()]) {
    const { document } = mount(order.map((block, index) => ({ ...block, order: index })), source);
    expect(document.querySelector("#featured-reporting a")!.getAttribute("href")).toBe("https://njpbs.org/posts/wage-context/");
    expect(document.querySelector("#metric-minimumwage .related-reporting a")!.getAttribute("href")).toBe("https://njpbs.org/posts/wage-context/");
  }
});
