// @vitest-environment node
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { applyHubElectricity, hubElectricityEmbed, hubElectricityProblem, readHubElectricity } from "../../packages/content-core/src/data-hub-electricity";
import { serveDataHubEmbed } from "../../packages/content-core/src/data-hub-embed";
import { defaultDataHubBlocks, isDefaultDataHubComposition } from "../../packages/content-core/src/data-hub-composition";
import type { DatasetPublicProjection } from "../../packages/content-core/src/data-figure";
import { electricityProjection as projection } from "./fixtures/hub-electricity";
import { dataHubEmbedPages } from "../src/lib/data-hub-embed-pages";
import { dataHubSectionHtml } from "../src/lib/data-hub-composition-render";
import { hubElectricityBinding } from "../src/lib/data-hub-figure-binding";

const reader = readFileSync(new URL("../src/data/njpbs-data-hub-v16.html", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../src/styles/design-tokens.css", import.meta.url), "utf8");
const seedOf = (html: string) => JSON.parse(html.match(/<script id="source-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
// The price compiled into the reader. It must not show once a release replaces it.
const compiled = seedOf(reader).metrics.find((item: { id: string }) => item.id === "electricity");
const page = (figure: DatasetPublicProjection, visible = true) => ({
  dataHubCompositionVersion: 1 as const,
  blocks: [...defaultDataHubBlocks(), { id: "price", type: "data_figure" as const, order: 25, visible,
    data: { datasetId: figure.datasetId, version: { mode: "latestApproved" as const }, display: "expanded" as const } }],
  datasetFigures: { figures: [{ blockId: "price", datasetId: figure.datasetId, releaseId: figure.releaseId, revision: 1, digest: figure.digest }], releases: [figure] },
});
const pages = await dataHubEmbedPages({ DATA_HUB_PUBLIC: "1" });
async function embed(path: string, hub: string | null | Response | Error, method = "GET") {
  const response = await serveDataHubEmbed(new Request(`https://njpbs.org/data/figures/${path}`, { method }), async asset => {
    const found = pages.find(item => `/data/figures/${item.id}/embed/${item.snapshot ? `${item.snapshot}/` : ""}` === new URL(asset.url).pathname);
    return new Response(found?.html ?? "missing", { status: found ? 200 : 404, headers: { "content-type": "text/html" } });
  }, async () => {
    if (hub instanceof Error) throw hub;
    if (hub instanceof Response) return hub.clone();
    return hub === null ? null : new Response(hub, { headers: { "content-type": "text/html" } });
  });
  return { status: response!.status, html: await response!.text(), headers: response!.headers };
}
const built = (id: string, snapshot?: string) => pages.find(item => item.id === id && item.snapshot === snapshot)!.html;

function mount(html: string) {
  const window = new Window({ url: "https://njpbs.org/data-hub/", settings: { disableIframePageLoading: true } });
  window.document.head.innerHTML = `<style>${tokens}</style>`;
  window.document.body.innerHTML = `<main class="data-hub">${html}</main>`;
  window.eval(html.match(/<script>([\s\S]*?)<\/script>/i)![1]);
  return window;
}

describe("Data Hub electricity price from an approved dataset release", () => {
  it("shows the release in the Hub record, the finding list and the no-script table", () => {
    const html = applyHubElectricity(reader, projection());
    const metric = readHubElectricity(html)!;
    expect(metric).toMatchObject({ value: 31.25, display: "31.25¢/kWh", period: "February 2027", checked: "2027-04-25", released: "2027-04-24",
      electricityComparison: [{ year: 2026, nj: 33, us: 18.9 }, { year: 2027, nj: 31.25, us: 18.4 }],
      datasetRelease: { approvedOn: "2027-04-25" } });
    expect(metric.insight).toBe("In February, New Jersey's average residential electricity price declined 5.3% year over year, while the U.S. average declined 2.6%. New Jersey was 69.8% above the U.S. price per kWh.");
    expect(html).toContain("<td>31.25¢/kWh</td><td>February 2027</td>");
    expect(html.match(/<li data-latest-metric="electricity">[\s\S]*?<\/li>/)![0]).toContain("Source released Apr 24, 2027");
    for (const text of [compiled.display, compiled.period, compiled.nextCheck]) expect(JSON.stringify(metric)).not.toContain(text);
    const { metrics: before, releaseCalendar: datesBefore } = seedOf(reader), { metrics: after, releaseCalendar: datesAfter } = seedOf(html);
    expect(after.filter((item: { id: string }) => item.id !== "electricity")).toEqual(before.filter((item: { id: string }) => item.id !== "electricity"));
    expect(datesAfter).toEqual(datesBefore.filter((row: { dataset: string }) => row.dataset !== "electricity"));
  });

  it.each([
    ["a fall above the 30-cent axis", projection()],
    ["a rise below the U.S. price", projection({ now: ["2026-09", 17, 18.5], before: ["2025-09", 16.5, 18.5] })],
  ])("draws the same embed as the Hub reader for %s", async (_name, figure) => {
    const html = applyHubElectricity(reader, figure);
    const metric = readHubElectricity(html)!;
    const window = mount(html);
    try {
      (window.document.querySelector('[data-open-figure="electricity"]') as unknown as { click(): void }).click();
      for (const view of ["chart", "number"] as const) {
        (window.document.querySelector(`input[name="figure-view"][value="${view}"]`) as unknown as { click(): void }).click();
        const drawn = (window.document.querySelector("#figure-frame") as unknown as { srcdoc: string }).srcdoc;
        // The page stylesheet supplies the palette, so compare the document body without its resolved colors.
        expect(hubElectricityEmbed(built("electricity", view === "number" ? "number" : undefined), metric, view)
          .replace(/(fill|stroke)="[^"]*"/g, "").match(/<main>[\s\S]*<\/main>/)![0])
          .toBe(drawn.replace(/(fill|stroke)="[^"]*"/g, "").match(/<main>[\s\S]*<\/main>/)![0]);
      }
    } finally { await window.happyDOM.close(); }
  });

  it("says equal prices are the same on the Hub page, in the reader's chart and in the embed", async () => {
    const html = applyHubElectricity(reader, projection({ now: ["2026-09", 18.5, 18.5], before: ["2025-09", 17, 18] }));
    const metric = readHubElectricity(html)!;
    expect(metric.insight).toContain("New Jersey's price per kWh was the same as the U.S. price.");
    expect(html).toContain("NJ electricity prices were the same as the U.S. average</a>");
    expect(metric.comparisonsPublic).toContainEqual(expect.objectContaining({ kind: "difference", label: "NJ and U.S. prices", value: "The same" }));
    const window = mount(html);
    try {
      (window.document.querySelector('[data-open-figure="electricity"]') as unknown as { click(): void }).click();
      const drawn = (window.document.querySelector("#figure-frame") as unknown as { srcdoc: string }).srcdoc;
      const embedded = hubElectricityEmbed(built("electricity"), metric, "chart");
      for (const text of [drawn, embedded]) {
        expect(text).toContain("In September 2026, New Jersey's price was the same as the U.S. price.</p>");
        expect(text.match(/<main>[\s\S]*<\/main>/)![0]).not.toMatch(/\b(above|below)\b/);
      }
    } finally { await window.happyDOM.close(); }
  });

  it("keeps staff text in the CSV from running as a formula and leaves negative numbers as they are", async () => {
    const figure = projection();
    const csv = async (html: string, id: string) => {
      const window = mount(html);
      const downloads: Blob[] = [];
      Object.defineProperty(window.URL, "createObjectURL", { value: (blob: Blob) => { downloads.push(blob); return "blob:test"; } });
      Object.defineProperty(window.URL, "revokeObjectURL", { value: () => {} });
      try {
        const click = (selector: string) => (window.document.querySelector(selector) as unknown as { click(): void }).click();
        click(`[data-open-figure="${id}"]`);
        click('[data-export-format="csv"]');
        return await downloads[0].text();
      } finally { await window.happyDOM.close(); }
    };
    for (const start of ["-", "=", "+", "@", "\t", "\r"]) {
      const text = await csv(applyHubElectricity(reader, { ...figure, release: { ...figure.release, methodNote: `${start}1+1 note`,
        reuse: { ...figure.release.reuse, note: `${start}2+2 credit` } } }), "electricity");
      expect(text).toContain(`,"'${start}1+1 note","'${start}2+2 credit"\r\n`);
    }
    expect(await csv(applyHubElectricity(reader, figure), "electricity")).toContain(',"Average price <per> kWh.","Example <credit>"\r\n');
    expect(await csv(reader, "industryjobs")).toMatch(/,"-\d/);
  });

  it("serves the Hub's price in the latest embed and leaves every other embed byte-identical", async () => {
    const hub = applyHubElectricity(reader, projection());
    for (const view of ["chart", "number"]) {
      const result = await embed(`electricity/embed/?view=${view}`, hub);
      expect(result.html).toContain("31.25¢/kWh");
      expect(result.html).not.toContain(compiled.display);
      expect(result.html).not.toMatch(/preliminary|<script/i);
      expect(result.html).toContain("Example &lt;credit&gt;");
      expect(result.headers.get("cache-control")).toBe("no-cache");
    }
    for (const item of pages.filter(item => item.snapshot?.includes("/") || item.id !== "electricity")) {
      expect((await embed(`${item.id}/embed/${item.snapshot ? `${item.snapshot}/` : ""}`, hub)).html).toBe(item.html);
    }
  });

  it("keeps the direct number address and the base address in agreement", async () => {
    const hub = applyHubElectricity(reader, projection());
    const html = (await embed("electricity/embed/number/", hub)).html;
    expect(html).toBe((await embed("electricity/embed/?view=number", hub)).html);
    expect(html).toContain("31.25¢/kWh");
  });

  it("keeps the built embed when the Hub has no approved release", async () => {
    expect((await embed("electricity/embed/", reader)).html).toBe(built("electricity"));
    expect((await embed("electricity/embed/?view=number", reader)).html).toBe(built("electricity", "number"));
  });

  it.each([
    ["withdrawn", new Response(null, { status: 410 }), 404], ["missing", new Response(null, { status: 404 }), 404],
    ["unavailable", new Response(null, { status: 503 }), 503], ["redirected", new Response(null, { status: 302 }), 503],
    ["unreachable", new Error("Page authority unavailable"), 503], ["unserved", null, 503],
  ])("shows no price in the latest embed while the Hub is %s", async (_name, hub, status) => {
    for (const path of ["electricity/embed/", "electricity/embed/?view=number", "electricity/embed/number/"]) {
      for (const method of ["GET", "HEAD"]) {
        const result = await embed(path, hub, method);
        expect(result.status).toBe(status);
        expect(result.html).not.toContain(compiled.display);
        expect(result.headers.get("content-security-policy")).toContain("frame-ancestors *");
        if (status === 503) expect(result.headers.get("cache-control")).toBe("no-store");
        else if (method === "GET") expect(result.html).toContain("Figure not found");
      }
    }
    expect((await embed("electricity/embed/?revision=2026-11-19", hub)).html).toBe(built("electricity", "2026-11-19/chart"));
    expect((await embed("unemployment/embed/", hub)).html).toBe(built("unemployment"));
  });

  it("reads only a visible frozen release and keeps the reviewed page layout", () => {
    const figure = projection();
    const bound = hubElectricityBinding(page(figure))!;
    expect(bound.projection).toEqual(figure);
    expect(isDefaultDataHubComposition(bound.blocks)).toBe(true);
    expect(hubElectricityBinding(page(figure, false))).toBeUndefined();
    expect(hubElectricityBinding({ ...page(figure), datasetFigures: undefined })).toBeUndefined();
    expect(hubElectricityBinding({ ...page(figure), dataHubCompositionVersion: undefined })).toBeUndefined();
  });

  it("shows the release's credit on the card, without JavaScript and in every download", async () => {
    const figure = projection();
    const note = `Example <credit> ${"W".repeat(700)}`;
    const html = applyHubElectricity(reader, { ...figure, release: { ...figure.release, reuse: { ...figure.release.reuse, note } } });
    const window = mount(html);
    const downloads: Blob[] = [];
    Object.defineProperty(window.URL, "createObjectURL", { value: (blob: Blob) => { downloads.push(blob); return "blob:test"; } });
    Object.defineProperty(window.URL, "revokeObjectURL", { value: () => {} });
    try {
      expect(html.match(/<noscript>[\s\S]*?<\/noscript>/)![0]).toContain("Example &lt;credit&gt;");
      expect(dataHubSectionHtml(html, { sectionId: "electricity", heading: "", introduction: "" }, 2)).toContain("Example &lt;credit&gt;");
      const click = (selector: string) => (window.document.querySelector(selector) as unknown as { click(): void }).click();
      expect(window.document.querySelector("#metric-electricity .measure__source")!.textContent).toContain(note);
      click('[data-open-figure="electricity"]');
      expect(window.document.querySelector<never>('input[name="figure-revision"][value="pinned"]')).toMatchObject({ disabled: true });
      for (const view of ["chart", "number"]) {
        click(`input[name="figure-view"][value="${view}"]`);
        for (const format of ["csv", "json", "html", "svg"]) {
          downloads.length = 0;
          click(`[data-export-format="${format}"]`);
          // An image shows its text elements only.
          const download = await downloads[0].text();
          const text = format === "svg" ? download.replace(/<(desc|title)\b[\s\S]*?<\/\1>/gi, "") : download;
          expect(text.replaceAll("&lt;", "<").replaceAll("&gt;", ">"), `${view} ${format}`).toContain("Example <credit>");
          if (format === "svg") {
            const longest = Math.max(...[...text.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(match => match[1].replace(/&[#a-z0-9]+;/g, "x").length));
            expect(longest, `${view} svg line length`).toBeLessThanOrEqual(102);
            const credit = [...text.matchAll(/<text\b[^>]*>([^<]*W{5}[^<]*)<\/text>/g)].map(match => match[1].length);
            expect(Math.max(...credit), `${view} credit line`).toBeLessThanOrEqual(50);
          }
          if (format === "csv") expect(text).toContain("Average price <per> kWh.");
        }
      }
    } finally { await window.happyDOM.close(); }
  });

  it("keeps the data figure as a chart when the electricity section is hidden", () => {
    const hidden = page(projection());
    const bound = hubElectricityBinding({ ...hidden, blocks: hidden.blocks.map(block =>
      block.type === "data_hub_section" && block.data.sectionId === "electricity" ? { ...block, visible: false } : block) })!;
    expect(bound.projection).toEqual(projection());
    expect(bound.blocks.some(block => block.id === "price")).toBe(true);
  });

  it("refuses a release without the four matched prices", () => {
    const release = projection().release;
    expect(hubElectricityProblem(release)).toBeNull();
    expect(hubElectricityProblem({ ...release, comparators: release.comparators.slice(0, 1) })).toContain("U.S. comparison");
    expect(hubElectricityProblem({ ...release, points: release.points.slice(1) })).toContain("New Jersey observation");
    expect(hubElectricityProblem({ ...release, value: 30 })).toContain("must equal");
    expect(hubElectricityProblem({ ...release, period: { ...release.period, end: "2027-03-31" } })).toContain("one calendar month");
    expect(hubElectricityProblem({ ...release, period: { ...release.period, start: "2027-02-02" } })).toContain("one calendar month");
    expect(hubElectricityProblem({ ...release, reuse: { ...release.reuse, exports: "denied" } })).toContain("export rights");
    expect(hubElectricityProblem({ ...release, source: { ...release.source, url: "https://www.eia.gov/other" } })).toMatch(/^source\.url: .*epmt_5_6_a/);
    const credited = (note: string) => hubElectricityProblem({ ...release, reuse: { ...release.reuse, note } });
    for (const note of ["\u2e3b".repeat(50), "\u0d5d".repeat(50), "cre\u0301dito \u0301", "Credit\u000bAgency", "Credit\u000cAgency"]) expect(credited(note)).toMatch(/^reuse\.note: Use Latin letters/);
    for (const note of ["Fuente: Administración de Información Energética — “año”", "Administracio\u0301n", "Two\tlines\r\nof credit"]) expect(credited(note)).toBeNull();
    const [current, prior] = release.comparators;
    for (const change of [{ adjustment: "seasonally_adjusted" as const }, { source: { ...current.source, url: "https://example.org/other" } },
      { source: { ...current.source, seriesId: "EIA-EPM-5.6.A-US-COM" } },
      { period: { ...current.period, end: "2027-02-14" } }]) {
      expect(hubElectricityProblem({ ...release, comparators: [{ ...current, ...change }, prior] })).toContain("U.S. comparison");
    }
    // Another cents-per-kWh New Jersey series stays an ordinary data figure.
    expect(hubElectricityBinding(page({ ...projection(), release: { ...release, source: { ...release.source, seriesId: "commercial" } } }))).toBeUndefined();
  });
});
