// @vitest-environment node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Window, type HTMLAnchorElement, type HTMLButtonElement, type HTMLDialogElement, type HTMLInputElement } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/data/njpbs-data-hub-v16.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const seed = JSON.parse(html.match(/<script id="source-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
const windows: Window[] = [];

// Execute the shipped reader against its real source payload, rather than a copy
// of its formatting/export helpers. Intercept only browser downloads and loading.
function mount(source = html, theme = "") {
  const win = new Window({
    url: "https://njpbs.example/data-hub/",
    settings: { disableIframePageLoading: true },
  });
  windows.push(win);
  const downloads: Blob[] = [];
  Object.defineProperty(win.URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => { downloads.push(blob); return "blob:reader-test"; },
  });
  Object.defineProperty(win.URL, "revokeObjectURL", { configurable: true, value: () => {} });
  win.HTMLAnchorElement.prototype.click = () => {};
  win.document.body.innerHTML = `<main class="data-hub" style="${theme}">${source}</main>`;
  win.eval(script);
  const doc = win.document;
  async function exportText(id: string, format: "csv" | "json" | "html" | "svg", view: "chart" | "number" = "chart") {
    (doc.querySelector(`#metric-${id} [data-open-figure]`) as HTMLButtonElement).click();
    (doc.querySelector(`input[name="figure-view"][value="${view}"]`) as HTMLInputElement).click();
    (doc.querySelector(`[data-export-format="${format}"]`) as HTMLButtonElement).click();
    return downloads.at(-1)!.text();
  }
  async function csv(id: string) {
    const text = await exportText(id, "csv");
    // Every exported cell is quoted; these source rows have no embedded CRLF.
    return text.replace(/^\uFEFF/, "").trimEnd().split("\r\n").map(line =>
      [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(cell => cell[1].replaceAll('""', '"')));
  }
  return { doc, csv, exportText };
}

function sourceWith(change: (payload: typeof seed) => void) {
  const payload = structuredClone(seed);
  change(payload);
  return html.replace(/(<script id="source-data" type="application\/json">)[\s\S]*?(<\/script>)/,
    (_, open, close) => `${open}${JSON.stringify(payload)}${close}`);
}

afterEach(() => {
  for (const win of windows.splice(0)) win.happyDOM.abort();
});

describe("Data Hub reader and downloads", () => {
  it("keeps the regional rent tick labels inside the chart viewport", () => {
    const { doc } = mount();
    (doc.querySelector('#metric-medianrent [data-gross-rent-view="regional"]') as HTMLButtonElement).click();
    const svg = doc.querySelector("#metric-medianrent .gross-rent-svg")!;
    const height = Number(svg.getAttribute("height"));
    for (const text of svg.querySelectorAll("text")) {
      expect(Number(text.getAttribute("y")) + Number(text.getAttribute("font-size")) / 4).toBeLessThan(height);
    }
  });

  it("omits unsafe graduation source links from the reader and HTML export", async () => {
    const id = "graduation";
    const source = sourceWith(payload => {
      const metric = payload.metrics.find((row: { id: string }) => row.id === id);
      for (const key of Object.keys(metric.cohortSources)) metric.cohortSources[key] = "javascript:alert(1)";
    });
    const { doc, exportText } = mount(source);
    expect(doc.querySelector(`#metric-${id}`)).not.toBeNull();
    expect(doc.querySelectorAll(`#metric-${id} a[href^="javascript:"]`)).toHaveLength(0);
    const exported = new Window();
    windows.push(exported);
    exported.document.write(await exportText(id, "html"));
    expect(exported.document.querySelectorAll('a[href^="javascript:"]')).toHaveLength(0);
    expect(exported.document.body.textContent).toContain("NJDOE");
  });

  it.each(["snap", "graduation", "medianrent", "inflationmetro"])("keeps %s chart labels readable in light HTML and dark image exports", async (id) => {
    const theme = "--bg-0:#070810;--text:#f3f4fb;--color-data-hub-muted:#c8cce0;--color-data-hub-export-muted:#c8cce0;--color-data-hub-comparison-edge:#707590;--color-data-hub-table-track:#353a50;--color-data-hub-line-highlight:#ecf0ff;--color-data-hub-export-emphasis:#9cb0ff;--color-data-hub-grid-edge:#707590";
    const { exportText } = mount(html, theme);
    const luminance = (hex: string) => {
      expect(hex).toMatch(/^#[\da-f]{6}$/i);
      const c = hex.slice(1).match(/../g)!.map(n => parseInt(n, 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
      return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
    };
    for (const format of ["html", "svg"] as const) {
      const exported = new Window();
      windows.push(exported);
      exported.document.body.innerHTML = await exportText(id, format);
      const background = format === "html" ? "#ffffff" : "#070810";
      const backdrop = luminance(background);
      for (const text of exported.document.querySelectorAll("svg text")) {
        const ink = luminance(text.getAttribute("fill")!);
        expect((Math.max(ink, backdrop) + .05) / (Math.min(ink, backdrop) + .05), `${format}: ${text.textContent}`).toBeGreaterThanOrEqual(4.5);
      }
      if (id === "medianrent") {
        const marks = exported.document.querySelectorAll(".gross-rent-uncertainty");
        expect(marks).toHaveLength(2);
        const ratio = (a: number, b: number) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        for (const mark of marks) {
          const bar = luminance(mark.previousElementSibling!.getAttribute("fill")!);
          const strokes = [...mark.children].map(layer => luminance(layer.getAttribute("stroke")!));
          expect(Math.max(...strokes.map(stroke => ratio(stroke, bar)))).toBeGreaterThanOrEqual(3);
          expect(Math.max(...strokes.map(stroke => ratio(stroke, backdrop)))).toBeGreaterThanOrEqual(3);
          expect(ratio(strokes[0], strokes[1])).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it.each([
    { id: "graduation", alternate: '[data-graduation-view="groups"]' },
    { id: "inflationmetro", alternate: '[data-metro-view="history"]' },
  ])("exports valid SVG XML for both $id chart views", async ({ id, alternate }) => {
    const { doc, exportText } = mount();
    for (const selector of [null, alternate]) {
      if (selector) (doc.querySelector(`#metric-${id} ${selector}`) as HTMLButtonElement).click();
      const svg = await exportText(id, "svg");
      // Happy DOM repairs malformed attributes; a strict XML parser catches the
      // invalid image documents that make browser PNG conversion fail.
      const parsed = spawnSync("python3", ["-c", "import sys, xml.etree.ElementTree as ET; ET.fromstring(sys.stdin.read())"], { input: svg, encoding: "utf8" });
      expect(parsed.status, parsed.stderr || parsed.error?.message).toBe(0);
    }
  });

  it.each(["snap", "graduation", "inflationmetro"])("keeps screen-reader link hints visually hidden in the standalone %s export", async (id) => {
    const { exportText } = mount();
    const exported = new Window();
    windows.push(exported);
    exported.document.write(await exportText(id, "html"));
    const hint = exported.document.querySelector(".sr-only");
    expect(hint?.textContent).toContain("opens in new tab");
    const style = exported.getComputedStyle(hint!);
    expect(style.position).toBe("absolute");
    expect(style.width).toBe("1px");
    expect(style.height).toBe("1px");
    expect(style.overflow).toBe("hidden");
  });

  it("renders source-matched 2025 ACS median gross rent with national and regional views", async () => {
    const { doc, csv, exportText }=mount();
    const m=seed.metrics.find((r:{id:string})=>r.id==="medianrent");
    const source="https://data.census.gov/table/ACSDT1Y2025.B25064";
    expect(m.period).toBe("2025 ACS 1-year estimate");
    expect(m.value).toBe(1885);
    expect(m.uncertaintyNote).toBe("2025 90% margin of error: ±$19.");
    expect(m.checked).toBe("2026-11-09");
    expect(m.sourceUrl).toBe(source);
    expect(m.acs2025GrossRent.table).toBe("B25064");
    expect(m.acs2025GrossRent.moeLevel).toBe(90);
    expect(m.acs2025GrossRent.geographies).toEqual([
      {id:"NJ",label:"New Jersey",value:1885,moe:19},
      {id:"US",label:"United States",value:1557,moe:4},
      {id:"NY",label:"New York",value:1704,moe:14},
      {id:"PA",label:"Pennsylvania",value:1329,moe:13}
    ]);
    const card=()=>doc.querySelector("#metric-medianrent")!;
    expect(card().querySelector('[data-gross-rent-view="national"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelector(".gross-rent-svg title")!.textContent).toContain("New Jersey versus United States");
    expect(card().textContent).toContain("$1,885");
    expect(card().textContent).toContain("$1,557");
    expect(card().textContent).toContain("21.1%");
    expect(card().querySelectorAll(".gross-rent-table tbody tr")).toHaveLength(2);
    const svg=await exportText("medianrent","svg");
    expect(svg).toContain("2025 Census ACS one-year Table B25064");
    expect(svg).toContain("Published on NJ PBS");
    const [header,...rows]=await csv("medianrent");
    expect(header).toEqual(["geography","median_gross_rent_usd_per_month","moe_90_usd","survey_year","series","census_table","source_url","source_checked"]);
    expect(rows).toHaveLength(4);
    expect(rows.map(r=>r.slice(0,3))).toEqual([["New Jersey","1885","19"],["United States","1557","4"],["New York","1704","14"],["Pennsylvania","1329","13"]]);
    expect(rows.every(r=>r[6]===source&&r[7]==="2026-11-09")).toBe(true);
    const stand=await exportText("medianrent","html");
    expect(stand).toContain("2025 ACS");
    expect(stand).toContain("opens in new tab");
    expect(stand).toContain("±$19");
    (card().querySelector('[data-gross-rent-view="regional"]') as HTMLButtonElement).click();
    expect(card().querySelector('[data-gross-rent-view="regional"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelectorAll(".gross-rent-table tbody tr")).toHaveLength(4);
    expect(card().textContent).toContain("$1,704");
    expect(card().textContent).toContain("$1,329");
    const regionalSVG=await exportText("medianrent","svg");
    expect(regionalSVG).toContain("New Jersey and neighboring states");
    const [header2,...rows2]=await csv("medianrent");
    expect(header2).toEqual(header);
    expect(rows2).toEqual(rows);
    const json=JSON.parse(await exportText("medianrent","json"));
    expect(json.metric.acs2025GrossRent.geographies).toHaveLength(4);
    expect(json.metric.uncertaintyNote).toBe("2025 90% margin of error: ±$19.");
  });

  it("retains all 18 Data Hub metrics after integrating approved visualization branches", () => {
    expect(seed.metrics).toHaveLength(18);
    expect(new Set(seed.metrics.map((m:{id:string})=>m.id)).size).toBe(18);
    const byId=(id:string)=>seed.metrics.find((m:{id:string})=>m.id===id);
    expect(byId("medianincome").value).toBe(107797);
    expect(byId("electricity").value).toBe(24.61);
    expect(byId("housingpermits").value).toBe(22517);
    expect(byId("precipitation").value).toBe(36.98);
    expect(byId("temperature").value).toBe(57.3);
    expect(byId("statebudget").budgetScorecard.totalThousands).toBe(60743569);
    expect(byId("familycare").value).toBe(1786101);
    expect(byId("uninsured").acs2025Uninsured.year).toBe(2025);
    expect(byId("snap").snapYearOverYear.rows).toHaveLength(7);
    expect(byId("graduation").cohortRates).toHaveLength(4);
    expect(byId("schoolabsence").value).toBe(14.4);
    expect(byId("voterregistration").value).toBe(6725177);
    expect(byId("medianrent").period).toBe("2025 ACS 1-year estimate");
    expect(byId("inflationmetro").metroCPI.monthlyMetro).toHaveLength(9);
  });


  it("shows the approved national income comparison and toggles the regional chart and exports", async () => {
    const { doc, csv, exportText } = mount();
    const income = seed.metrics.find((row: { id: string }) => row.id === "medianincome");
    expect(income.value).toBe(107797);
    expect(income.period).toContain("2025 ACS 1-year");
    expect(income.history).toEqual([{ date: "2024", value: 107112 }, { date: "2025", value: 107797 }]);
    expect(income.comparisonsPublic.find((r: { kind: string }) => r.kind === "national").value).toBe("$84,780");
    const figure = () => doc.querySelector("#metric-medianincome")!;
    expect(figure().querySelectorAll(".income-visual .history-plot svg")).toHaveLength(2);
    expect(figure().querySelector('[data-income-view="national"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(figure().querySelector(".income-visual svg desc")!.textContent).toContain("United States: $84,780");
    expect(figure().querySelector(".income-visual svg desc")!.textContent).not.toContain("Pennsylvania");
    const nationalSVG = await exportText("medianincome", "svg");
    expect(nationalSVG).toContain("New Jersey vs. United States");
    expect(nationalSVG).not.toContain("Pennsylvania");
    (figure().querySelector('[data-income-view="regional"]') as HTMLButtonElement).click();
    expect(figure().querySelector('[data-income-view="regional"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(figure().querySelector(".income-visual svg desc")!.textContent).toContain("Pennsylvania: $81,473");
    expect(figure().querySelector(".income-visual svg desc")!.textContent).toContain("New York: $89,210");
    const regionalSVG = await exportText("medianincome", "svg");
    expect(regionalSVG).toContain("Pennsylvania");
    const regionalHTML = await exportText("medianincome", "html");
    expect(regionalHTML).toContain("Regional median household income");
    expect(regionalHTML).toContain("$81,473");
    const [header, ...rows] = await csv("medianincome");
    expect(header).toContain("comparison_view");
    const geography = rows.filter(row => row[0] === "geography");
    expect(geography).toHaveLength(4);
    expect(geography.every(row => row[1] === "regional")).toBe(true);
    expect(rows.filter(row => row[0] === "NJ historical estimate")).toHaveLength(2);
    (figure().querySelector('[data-income-view="national"]') as HTMLButtonElement).click();
    expect(figure().querySelector('[data-income-view="national"]')!.getAttribute("aria-pressed")).toBe("true");
  });

  it("compares matching January–September building permits without combining source datasets", async () => {
    const { doc, csv, exportText } = mount();
    const permit = seed.metrics.find((row: { id: string }) => row.id === "housingpermits");
    expect(permit.value).toBe(22517);
    expect(permit.ytd.total).toBe(22517);
    expect(permit.ytd.priorYearTotal).toBe(23695);
    expect(permit.monthlyReference).toHaveLength(9);
    expect(permit.monthlyReference.map((row: { value: number }) => row.value).reduce((a: number,b: number)=>a+b,0)).toBe(22517);
    expect(permit.monthlyReference.map((row: { previousYear: number }) => row.previousYear).reduce((a: number,b: number)=>a+b,0)).toBe(23695);
    expect(permit.annualHistory).toBeUndefined();
    expect(permit.annualReference).toBeUndefined();
    const card=doc.querySelector("#metric-housingpermits")!;
    expect(card.textContent).toContain("Jan.–Sep. 2025");
    expect(card.textContent).toContain("September 2026");
    expect(card.textContent).toContain("−5.0%");
    expect(card.querySelectorAll(".history-plot svg.v7-viz")).toHaveLength(2);
    const svg=card.querySelector(".history-plot svg.v7-viz")!;
    expect(svg.querySelectorAll("g title")).toHaveLength(18);
    expect(svg.textContent).toContain("2025");
    expect(svg.textContent).toContain("2026");
    const [header,...rows]=await csv("housingpermits");
    expect(header).toContain("housing_units_2026");
    expect(rows).toHaveLength(10);
    expect(rows[8].slice(0,3)).toEqual(["2026-09","1990","2476"]);
    expect(rows[9].slice(0,3)).toEqual(["JAN_SEP_TOTAL","22517","23695"]);
    const svgFile=await exportText("housingpermits","svg");
    expect(svgFile).toContain("2025");
    expect(svgFile).toContain("2026");
    const htmlFile=await exportText("housingpermits","html");
    expect(htmlFile).toContain("22,517");
    expect(htmlFile).not.toContain("Older complete-year housing permit history");
    const json=JSON.parse(await exportText("housingpermits","json"));
    expect(json.metric.ytd.end).toBe("2026-09");
  });

  it("uses a single November 2026 Rutgers monthly precipitation revision in chart and exports", async () => {
    const { doc, csv, exportText } = mount();
    const rain=seed.metrics.find((row: { id: string }) => row.id === "precipitation");
    const url="https://climate.rutgers.edu/stateclim_v1/nclimdiv/index.php?elem=pcpn&stn=NJ00";
    expect(rain.value).toBe(36.98);
    expect(rain.period).toContain("January–October 2026");
    expect(rain.monthlyReference).toHaveLength(10);
    expect(rain.ytd).toMatchObject({ end:"2026-10",total:36.98,priorYearTotal:33.81,normalTotal:39.93,differenceFrom2025:3.17,differenceFromNormal:-2.95 });
    expect(rain.annualReference).toBeUndefined();
    expect(rain.annualHistory).toBeUndefined();
    expect(rain.monthlyReference.every((r: {sourceUrl:string}) => r.sourceUrl===url)).toBe(true);
    expect(rain.comparisonsPublic.every((r: {sourceUrl:string}) => r.sourceUrl===url)).toBe(true);
    for (const field of ["value","previousYear","normal"] as const) {
      const total=rain.monthlyReference.reduce((v:number,r:Record<string,number>)=>v+r[field],0);
      const expected=field==="value"?36.98:field==="previousYear"?33.81:39.93;
      expect(Number(total.toFixed(2))).toBe(expected);
    }
    const card=doc.querySelector("#metric-precipitation")!;
    expect(card.textContent).toContain("January–October");
    expect(card.textContent).toContain("9.4%");
    expect(card.textContent).toContain("7.4%");
    expect(card.textContent).toContain("October 2026");
    expect(card.textContent).toContain("2.69 inches");
    expect(card.querySelectorAll(".history-plot svg.v7-viz")).toHaveLength(2);
    expect(card.querySelectorAll(".history-plot .history-svg--desktop g title")).toHaveLength(10);
    const [header, ...rows]=await csv("precipitation");
    expect(header).toContain("precip_2025_in");
    expect(rows).toHaveLength(11);
    expect(rows[8].slice(0,5)).toEqual(["2026-09","5.77","2.65","4.16","1.61"]);
    expect(rows[9].slice(0,5)).toEqual(["2026-10","2.69","3.45","4.19","-1.5"]);
    expect(rows.at(-1)!.slice(0,5)).toEqual(["JAN_OCT_TOTAL","36.98","33.81","39.93","-2.95"]);
    expect(rows.every(row=>row[header.indexOf("source_url")]===url)).toBe(true);
    const svg=await exportText("precipitation","svg");
    expect(svg).toContain("Jan.–Oct. 1991–2020 normal");
    const embedded=await exportText("precipitation","html");
    expect(embedded).toContain("October 2026");
    expect(embedded).not.toContain("Older annual context");
    const record=JSON.parse(await exportText("precipitation","json"));
    expect(record.metric.value).toBe(36.98);
    expect(record.metric.checked).toBe("2026-11-09");
  });

  it("uses the same October 2026 Rutgers nClimDiv temperature revision in the chart and exports", async () => {
    const { doc, csv, exportText } = mount();
    const temperature=seed.metrics.find((row: {id:string})=>row.id==="temperature");
    const url="https://climate.rutgers.edu/stateclim_v1/nclimdiv/index.php?elem=avgt&stn=NJ00";
    expect(temperature.value).toBe(57.3);
    expect(temperature.period).toBe("October 2026 statewide monthly mean");
    expect(temperature.checked).toBe("2026-11-09");
    expect(temperature.sourceUrl).toBe(url);
    expect(temperature.annualHistory).toBeUndefined();
    expect(temperature.monthlyReference).toHaveLength(10);
    expect(temperature.monthlyReference.every((r: {sourceUrl:string})=>r.sourceUrl===url)).toBe(true);
    expect(temperature.comparisonsPublic.every((r: {sourceUrl:string})=>r.sourceUrl===url)).toBe(true);
    const months=temperature.monthlyReference;
    expect(months.slice(6).map((r: {value:number,normal:number,departure:number})=>[r.value,r.normal,r.departure])).toEqual([
      [75.9,75.4,0.5],[74.9,73.6,1.3],[68.1,66.9,1.2],[57.3,55.4,1.9],
    ]);
    expect(months.every((r: {value:number,normal:number,departure:number})=>
      Math.abs(Number((r.value-r.normal).toFixed(1))-r.departure)<0.0001)).toBe(true);
    const card=doc.querySelector("#metric-temperature")!;
    expect(card.textContent).toContain("October 2026");
    expect(card.textContent).toContain("57.3°F");
    expect(card.textContent).toContain("+1.9°F");
    expect(card.textContent).toContain("View all ten months");
    expect(card.querySelectorAll(".history-plot svg.v7-viz")).toHaveLength(2);
    const chart=card.querySelector(".history-plot .history-svg--desktop")!;
    expect(chart.querySelectorAll("g title")).toHaveLength(10);
    expect(chart.querySelector("title")?.textContent).toContain("Monthly temperature departure");
    const [header,...rows]=await csv("temperature");
    expect(header).toEqual(["month","nj_mean_temperature_2026_f","normal_1991_2020_f","departure_from_normal_f","source_url","source_checked"]);
    expect(rows).toHaveLength(10);
    expect(rows[6].slice(0,4)).toEqual(["2026-07","75.9","75.4","0.5"]);
    expect(rows[7].slice(0,4)).toEqual(["2026-08","74.9","73.6","1.3"]);
    expect(rows[8].slice(0,4)).toEqual(["2026-09","68.1","66.9","1.2"]);
    expect(rows[9].slice(0,4)).toEqual(["2026-10","57.3","55.4","1.9"]);
    expect(rows.every(row=>row.length===header.length&&row[4]===url&&row[5]==="2026-11-09")).toBe(true);
    const svg=await exportText("temperature","svg");
    expect(svg).toContain("Monthly temperature departure from normal");
    expect(svg).toContain("January–October 2026");
    const embedded=await exportText("temperature","html");
    expect(embedded).toContain("October 2026");
    expect(embedded).toContain("View all ten months");
    expect(embedded).not.toContain("Completed annual statewide temperatures");
    const record=JSON.parse(await exportText("temperature","json"));
    expect(record.metric.checked).toBe("2026-11-09");
    expect(record.metric.monthlyReference).toHaveLength(10);
  });


  it("renders the FY2027 enacted-state-funds treemap with reconciled type and account views", async () => {
    const { doc, csv, exportText } = mount();
    const m=seed.metrics.find((r: {id:string})=>r.id==="statebudget");
    const source="https://pub.njleg.state.nj.us/publications/budget/FY%202027%20Appropriations%20Act%20Scoresheet.pdf";
    expect(m.value).toBe(60.743569);
    expect(m.budgetScorecard.totalThousands).toBe(60743569);
    expect(m.sourceUrl).toBe(source);
    const types=m.budgetScorecard.spendingTypes;
    const departments=m.budgetScorecard.departmentAccounts;
    expect(types).toHaveLength(5);
    expect(departments).toHaveLength(22);
    expect(types.reduce((s:number,r:{valueThousands:number})=>s+r.valueThousands,0)).toBe(60743569);
    expect(departments.reduce((s:number,r:{valueThousands:number})=>s+r.valueThousands,0)).toBe(60743569);
    expect(types.map((r:{valueThousands:number})=>r.valueThousands)).toEqual([24859309,20911242,12523929,1919899,529190]);
    const figure=()=>doc.querySelector("#metric-statebudget")!;
    expect(figure().querySelectorAll(".budget-treemap .budget-tile")).toHaveLength(5);
    expect(figure().querySelector('[data-budget-view="types"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(figure().textContent).toContain("$24,859,309,000");
    expect(figure().textContent).toContain("$60,743,569,000");
    const typeSvg=await exportText("statebudget","svg");
    expect(typeSvg).toContain("spending types");
    expect(typeSvg).toContain("State aid");
    const [typeHeader,...typeRows]=await csv("statebudget");
    expect(typeHeader).toContain("appropriations_usd");
    expect(typeRows).toHaveLength(6);
    expect(typeRows.every(r=>r[0]==="types"&&r[5]===source)).toBe(true);
    expect(typeRows.at(-1)!.slice(1,4)).toEqual(["TOTAL","60743569000","100.0000"]);
    (figure().querySelector('[data-budget-view="departments"]') as HTMLButtonElement).click();
    expect(figure().querySelector('[data-budget-view="departments"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(figure().querySelectorAll(".budget-treemap .budget-tile")).toHaveLength(7);
    expect(figure().textContent).toContain("Other departments and accounts (16 combined)");
    expect(figure().querySelector(".budget-full-table")!.textContent).toContain("Miscellaneous Executive Commissions");
    expect(figure().querySelector(".budget-full-table")!.textContent).toContain("$994,000");
    const [deptHeader,...deptRows]=await csv("statebudget");
    expect(deptHeader).toEqual(typeHeader);
    expect(deptRows).toHaveLength(23);
    expect(deptRows.every(r=>r[0]==="departments"&&r[5]===source)).toBe(true);
    expect(deptRows.filter(r=>r[1]!=="TOTAL").reduce((total,r)=>total+Number(r[2]),0)).toBe(60743569000);
    const deptSvg=await exportText("statebudget","svg");
    expect(deptSvg).toContain("departments and accounts");
    expect(deptSvg).toContain("Other departments and accounts");
    const deptHTML=await exportText("statebudget","html");
    expect(deptHTML).toContain("Complete department and account breakdown");
    expect(deptHTML).toContain("$21,800,104,000");
    expect(deptHTML).toContain("Federal appropriations are excluded");
    const record=JSON.parse(await exportText("statebudget","json"));
    expect(record.metric.budgetScorecard.departmentAccounts).toHaveLength(22);
    expect(record.metric.checked).toBe("2026-11-09");
    (figure().querySelector('[data-budget-view="types"]') as HTMLButtonElement).click();
    expect(figure().querySelectorAll(".budget-treemap .budget-tile")).toHaveLength(5);
  });
  
  it("uses only ten official 2026 DMAHS reports for FamilyCare trend and category toggle", async () => {
    const { doc, csv, exportText } = mount();
    const m = seed.metrics.find((r: {id: string})=>r.id==="familycare");
    const prefix="https://www.nj.gov/humanservices/dmahs/documents/news/reports/enrollment_2026_";
    expect(m.checked).toBe("2026-11-09");
    expect(m.value).toBe(1786101);
    expect(m.period).toBe("October 2026");
    expect(m.monthlyEnrollment).toHaveLength(10);
    expect(m.monthlyEnrollment[0]).toMatchObject({date:"2026-01",total:1809464,changeFromJanuary:0});
    expect(m.monthlyEnrollment.at(-1)).toMatchObject({date:"2026-10",total:1786101,changeFromJanuary:-23363});
    expect(m.monthlyEnrollment[8]).toMatchObject({date:"2026-09",total:1791141,changeFromJanuary:-18323});
    expect(m.monthlyEnrollment.map((r:{total:number})=>r.total)).toEqual([
      1809464,1812049,1815571,1827845,1823772,1799053,1790043,1788321,1791141,1786101
    ]);
    expect(m.monthlyEnrollment.every((r:{date:string,total:number,changeFromJanuary:number,sourceUrl:string},i:number)=>
      r.date==="2026-"+String(i+1).padStart(2,"0")&&
      r.changeFromJanuary===r.total-1809464&&
      r.sourceUrl===prefix+String(i+1).padStart(2,"0")+".pdf")).toBe(true);
    expect(m.octoberEligibilityCategories.map((r:{count:number})=>r.count)).toEqual([108521,941,194449,812517,669673]);
    expect(m.octoberEligibilityCategories.reduce((s:number,r:{count:number})=>s+r.count,0)).toBe(1786101);
    const card=()=>doc.querySelector("#metric-familycare")!;
    expect(card().querySelectorAll(".familycare-svg")).toHaveLength(1);
    expect(card().querySelector(".familycare-svg title")!.textContent).toContain("net change since January 2026");
    expect(card().textContent).toContain("−23,363");
    expect(card().textContent).toContain("−5,040");
    expect(card().querySelector('[data-familycare-view="trend"]')!.getAttribute("aria-pressed")).toBe("true");
    const [header,...rows]=await csv("familycare");
    expect(header).toEqual(["record_type","period","label","enrolled_count","change_from_january","share_of_october_percent","source_name","source_url","checked"]);
    expect(rows).toHaveLength(16);
    expect(rows.slice(0,10).map(r=>r[0])).toEqual(Array(10).fill("monthly_total"));
    expect(rows[9].slice(0,5)).toEqual(["monthly_total","2026-10","NJ FamilyCare","1786101","-23363"]);
    expect(rows[9][7]).toBe(prefix+"10.pdf");
    expect(rows.slice(10,15).every(r=>r[0]==="eligibility_category"&&r[7]===prefix+"10.pdf")).toBe(true);
    expect(rows.at(-1)!.slice(0,4)).toEqual(["monthly_total_check","2026-10","October sum of five eligibility categories","1786101"]);
    const image=await exportText("familycare","svg");
    expect(image).toContain("NJ FamilyCare net change since January");
    expect(image).toContain("−23,363");
    const embed=await exportText("familycare","html");
    expect(embed).toContain("View all ten monthly totals");
    expect(embed).toContain("enrollment_2026_10.pdf");
    expect(embed).toContain("zero is the January baseline");
    (card().querySelector('[data-familycare-view="categories"]') as HTMLButtonElement).click();
    expect(card().querySelector('[data-familycare-view="categories"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelector(".familycare-svg title")!.textContent).toContain("eligibility grouping");
    expect(card().textContent).toContain("812,517");
    expect(card().textContent).toContain("669,673");
    expect(card().textContent).toContain("303,911");
    expect(card().textContent).toContain("View the five original eligibility categories");
    const categorySVG=await exportText("familycare","svg");
    expect(categorySVG).toContain("Eligibility categories in October 2026");
    const categoryHTML=await exportText("familycare","html");
    expect(categoryHTML).toContain("Aged");
    expect(categoryHTML).toContain("194,449");
    const [header2,...rows2]=await csv("familycare");
    expect(header2).toEqual(header);
    expect(rows2).toEqual(rows);
    const json=JSON.parse(await exportText("familycare","json"));
    expect(json.metric.monthlyEnrollment).toHaveLength(10);
    expect(json.metric.octoberEligibilityCategories).toHaveLength(5);
  });

  it("uses the 2025 ACSBR-027 source for national and NJ age uninsured views with survey uncertainty", async () => {
    const { doc, csv, exportText }=mount();
    const m=seed.metrics.find((r: {id:string})=>r.id==="uninsured");
    const source="https://www2.census.gov/library/publications/2026/demo/acsbr-027.pdf";
    expect(m.value).toBe(7.7);
    expect(m.period).toBe("2025 ACS 1-year estimate");
    expect(m.checked).toBe("2026-11-09");
    expect(m.sourceUrl).toBe(source);
    expect(m.acs2025Uninsured.year).toBe(2025);
    expect(m.acs2025Uninsured.table).toBe("ACSBR-027 Appendix Table A-2");
    expect(m.acs2025Uninsured.marginLevel).toBe(90);
    expect(m.acs2025Uninsured.records).toEqual([
      {view:"national",population:"New Jersey · all ages",label:"New Jersey",rate:7.7,moe:0.3,year:2025},
      {view:"national",population:"United States · all ages",label:"United States",rate:8.4,moe:0.1,year:2025},
      {view:"ages",population:"New Jersey · adults ages 19–64",label:"Adults ages 19–64",rate:11.1,moe:0.4,year:2025},
      {view:"ages",population:"New Jersey · children under 19",label:"Children under 19",rate:4.2,moe:0.5,year:2025},
    ]);
    expect(m.comparisonsPublic.every((r: {sourceUrl: string})=>r.sourceUrl===source)).toBe(true);
    const card=()=>doc.querySelector("#metric-uninsured")!;
    expect(card().querySelector('[data-uninsured-view="national"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelector(".uninsured-svg title")!.textContent).toContain("New Jersey versus United States");
    expect(card().querySelector(".uninsured-svg desc")!.textContent).toContain("90 percent margin of error");
    expect(card().querySelectorAll(".uninsured-table tbody tr")).toHaveLength(2);
    expect(card().textContent).toContain("7.7% ±0.3 pp");
    expect(card().textContent).toContain("8.4% ±0.1 pp");
    expect(card().textContent).toContain("0.7 percentage point below");
    expect(card().textContent).toContain("changed the ACS health-insurance questions");
    const svgNational=await exportText("uninsured","svg");
    expect(svgNational).toContain("New Jersey versus United States");
    expect(svgNational).toContain("7.7% ±0.3 pp");
    expect(svgNational).toContain("8.4% ±0.1 pp");
    const htmlNational=await exportText("uninsured","html");
    expect(htmlNational).toContain("ACSBR-027, Appendix Table A-2");
    expect(htmlNational).toContain("90% margin of error");
    expect(htmlNational).toContain("8.4%");
    const [header,...rows]=await csv("uninsured");
    expect(header).toEqual(["comparison_view","population","estimate_year","uninsured_rate_percent","moe_90_percentage_points","source_name","source_url","source_checked","population_definition"]);
    expect(rows).toHaveLength(4);
    expect(rows.map(r=>r.slice(0,5))).toEqual([
      ["national","New Jersey · all ages","2025","7.7","0.3"],
      ["national","United States · all ages","2025","8.4","0.1"],
      ["ages","New Jersey · adults ages 19–64","2025","11.1","0.4"],
      ["ages","New Jersey · children under 19","2025","4.2","0.5"]
    ]);
    expect(rows.every(r=>r.length===header.length&&r[6]===source&&r[7]==="2026-11-09")).toBe(true);
    (card().querySelector('[data-uninsured-view="ages"]') as HTMLButtonElement).click();
    expect(card().querySelector('[data-uninsured-view="ages"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelector(".uninsured-svg title")!.textContent).toContain("2025 uninsured rate in NJ by age");
    expect(card().querySelectorAll(".uninsured-table tbody tr")).toHaveLength(2);
    expect(card().textContent).toContain("11.1% ±0.4 pp");
    expect(card().textContent).toContain("4.2% ±0.5 pp");
    const svgAges=await exportText("uninsured","svg");
    expect(svgAges).toContain("New Jersey by age");
    expect(svgAges).toContain("11.1% ±0.4 pp");
    const htmlAges=await exportText("uninsured","html");
    expect(htmlAges).toContain("Adults ages 19–64");
    expect(htmlAges).toContain("Children under 19");
    const [header2,...rows2]=await csv("uninsured");
    expect(header2).toEqual(header);
    expect(rows2).toEqual(rows);
    const json=JSON.parse(await exportText("uninsured","json"));
    expect(json.metric.acs2025Uninsured.records).toHaveLength(4);
    expect(json.metric.acs2025Uninsured.marginLevel).toBe(90);
  });

  it("restores the saved featured finding, latest findings and matching reporting", () => {
    // Brent's October 22 handoff for #3900: October 17 saved story selection.
    const { doc } = mount();
    expect(doc.querySelector("#featured-title")!.textContent).toBe("A higher minimum wage is coming in January");
    expect(doc.querySelectorAll("#featured-plot svg")).toHaveLength(2);
    expect(doc.querySelector("#featured-plot .history-plot")!.getAttribute("aria-label")).toContain("Minimum hourly wage");
    expect([...doc.querySelectorAll(".latest-findings [data-go-figure]")].map(link => link.getAttribute("href")))
      .toEqual(["#metric-industryjobs", "#metric-inflationmetro", "#metric-electricity"]);
    expect(doc.querySelector("#featured-reporting a")!.getAttribute("href")).toBe(
      "https://www.njspotlightnews.org/2026/09/inflation-is-once-again-lifting-earnings-of-njs-lowest-paid/",
    );
    expect(doc.querySelector("#metric-voterregistration .related-reporting a")!.getAttribute("href")).toBe(
      "https://njpbs.org/posts/new-jersey-voter-registration-review-finds-additional-errors/",
    );
    expect([...doc.querySelectorAll("#metric-results article:has(.related-reporting)")].map(card => card.id).sort())
      .toEqual(["electricity", "familycare", "graduation", "medianrent", "minimumwage", "snap", "statebudget", "voterregistration"].map(id => `metric-${id}`));
    expect(doc.querySelectorAll("#metric-results .related-reporting a")).toHaveLength(12);
    expect(script).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|__local|127\.0\.0\.1|localhost/);
  });

  it("keeps prototype wording out of reader text and accessible descriptions", () => {
    // The format identifier remains stable for existing JSON readers. No other
    // prototype wording belongs in the published source, including old helpers.
    expect(html.replaceAll("njpbs-data-figure-prototype-v1", "").match(/\bprototype\b/gi)).toBeNull();
    const { doc } = mount();
    const reader = doc.body.cloneNode(true);
    reader.querySelectorAll("script, style").forEach(node => node.remove());
    expect(reader.textContent).not.toMatch(/\bprototype\b/i);
    for (const node of reader.querySelectorAll("[aria-label], [title], svg desc")) {
      expect([node.getAttribute("aria-label"), node.getAttribute("title"), node.textContent].join(" "))
        .not.toMatch(/\bprototype\b/i);
    }
  });

  it("charts the 2020–2026 minimum wage as historical bars and keeps 2027 announced separately", async () => {
    const { doc, csv, exportText }=mount();
    const metric=seed.metrics.find((m:{id:string})=>m.id==="minimumwage");
    expect(metric.history).toHaveLength(7);
    expect(metric.history.map((r:{value:number})=>r.value)).toEqual([11,12,13,14.13,15.13,15.49,15.92]);
    const text="Announced for Jan. 1, 2027: $16.48/hr · not yet effective";
    const caption="Each zero-based bar is an effective historical January 1 rate";
    for(const surface of ["#featured-plot","#metric-minimumwage"]){
      const chart=doc.querySelector(surface)!;
      expect(chart.textContent).toContain(caption);
      for(const svg of chart.querySelectorAll(".v7-viz")){
        const bars=[...svg.querySelectorAll("g title")].filter(t=>t.textContent?.includes("hourly minimum wage effective January 1"));
        expect(bars).toHaveLength(7);
        expect(svg.textContent).toContain(text);
        expect(svg.querySelector("desc")!.textContent).toContain(caption);
        expect(svg.querySelector("path[stroke-dasharray]")).toBeNull();
        expect(svg.querySelector('circle[r="6"]')).toBeNull();
      }
    }
    const [header,...rows]=await csv("minimumwage");
    expect(header).toContain("value");
    expect(rows).toHaveLength(7);
    const svg=await exportText("minimumwage","svg");
    expect(svg).toContain(text);
    expect(svg).toContain(caption);
    const html=await exportText("minimumwage","html");
    expect(html).toContain(text);
    const json=JSON.parse(await exportText("minimumwage","json"));
    expect(json.metric.comparisons.some((r:{future?:boolean,referenceValue?:number})=>r.future&&r.referenceValue===16.48)).toBe(true);
  });

  it("keeps saved reporting links on the public news origins", () => {
    const { doc } = mount(html.replace(
      "https://www.njspotlightnews.org/2026/09/inflation-is-once-again-lifting-earnings-of-njs-lowest-paid/",
      "https://unapproved.example/story/",
    ));
    expect(doc.querySelector("#featured-reporting a")).toBeNull();
    for (const link of doc.querySelectorAll(".related-reporting a")) {
      expect(["https://www.njspotlightnews.org", "https://njpbs.org"]).toContain(new URL((link as HTMLAnchorElement).href).origin);
    }
  });

  it("exports approved published snapshots without the retired launch notice", async () => {

    const { doc, exportText } = mount();
    for (const metric of seed.metrics.filter((row: { status: string }) => row.status === "verified")) {
      const record = JSON.parse(await exportText(metric.id, "json"));
      expect(record.format).toBe("njpbs-data-figure-prototype-v1"); // Stable format identifier.
      expect(record.previewOnly).toBe(false);
      expect(record.editorialStatus).toBe("source-verified");
      expect(record.metric.id).toBe(metric.id);
      expect(record.asOf).toBe("2026-11-09");
      expect(doc.querySelector("#figure-release-status")!.textContent).toBe(
        "Published on NJ PBS. Downloads preserve this dated source snapshot.",
      );
      for (const format of ["csv", "html", "svg"] as const) {
        const output = await exportText(metric.id, format);
        expect(output).not.toMatch(/not (?:yet )?published|unpublished|editorial prototype|prototype only/i);
        if (format !== "csv") expect(output).toContain("Published on NJ PBS");
      }
    }
  });

  it("uses the reviewed BLS history value and keeps one source snapshot in exports", async () => {
    const { doc, csv, exportText } = mount();
    expect(doc.querySelector("#metric-unemployment")!.textContent).toContain("October 20, 2026");
    const [header, ...rows] = await csv("unemployment");
    const period = header.indexOf("observation_period");
    const value = header.indexOf("value");
    expect(rows.find(row => row[period] === "2024-10")![value]).toBe("4.7");
    expect(rows.find(row => row[period] === "2025-10")![value]).toBe("");
    const record = JSON.parse(await exportText("unemployment", "json"));
    expect(record.metric.historyRetrieved).toBe("2026-10-20");
    expect(record.metric.historyVerificationUrl).toContain("LASST340000000000003");
    expect(record.metric.history).toHaveLength(62);
    expect(record.metric.history.find((row: { date: string }) => row.date === "2026-09").value).toBe(4.2);
  });

  it("uses 2022–2025 NJDOE state four-year graduation rates and a verified 2025 student-group toggle", async () => {
    const { doc, csv, exportText }=mount();
    const m=seed.metrics.find((r: {id:string})=>r.id==="graduation");
    const trendURL="https://www.nj.gov/education/spr/adddata/doc/acgrdocs/AdjustedCohort4-YearGraduationRates_2022_2023_2024_2025.xlsx";
    const groupURL="https://www.nj.gov/education/spr/adddata/doc/acgrdocs/Cohort2025_4YearAdjustedCohortGraduationRatesbyStudentGroup.xlsx";
    expect(m.value).toBe(91.8);
    expect(m.checked).toBe("2026-11-09");
    expect(m.sourceUrl).toBe(trendURL);
    expect(m.cohortSources.groups).toBe(groupURL);
    expect(m.cohortRates).toEqual([
      {year:2022,rate:90.9},{year:2023,rate:91.1},
      {year:2024,rate:91.3},{year:2025,rate:91.8}
    ]);
    expect(m.cohortGroupRates2025).toEqual([
      {label:"Statewide",rate:91.8},
      {label:"Economically disadvantaged",rate:88.9},
      {label:"Students with disabilities",rate:82.4}
    ]);
    const card=()=>doc.querySelector("#metric-graduation")!;
    expect(card().textContent).toContain("91.8%");
    expect(card().textContent).toContain("+0.9 percentage point");
    expect(card().querySelectorAll(".graduation-figure .graduation-svg")).toHaveLength(1);
    expect(card().querySelector('[data-graduation-view="trend"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelector(".graduation-svg title")!.textContent).toContain("cohort trend");
    expect(card().textContent).toContain("90.6%");
    expect(card().textContent).toContain("historical state-version");
    const [header,...rows]=await csv("graduation");
    expect(header).toEqual(["data_view","cohort","student_group","state_four_year_rate_percent","change_since_2022_percentage_points","source_name","source_url","source_checked"]);
    expect(rows).toHaveLength(7);
    expect(rows.slice(0,4).map(r=>r.slice(0,5))).toEqual([
      ["trend","2022","Statewide","90.9","0.0"],
      ["trend","2023","Statewide","91.1","0.2"],
      ["trend","2024","Statewide","91.3","0.4"],
      ["trend","2025","Statewide","91.8","0.9"]
    ]);
    expect(rows.slice(4).map(r=>[r[2],r[3]])).toEqual([
      ["Statewide","91.8"],["Economically disadvantaged","88.9"],["Students with disabilities","82.4"]
    ]);
    expect(rows.slice(0,4).every(r=>r[6]===trendURL&&r[7]==="2026-11-09")).toBe(true);
    expect(rows.slice(4).every(r=>r[6]===groupURL&&r[7]==="2026-11-09")).toBe(true);
    const trendSVG=await exportText("graduation","svg");
    expect(trendSVG).toContain("Published on NJ PBS");
    expect(trendSVG).toContain("2022: 90.9%");
    const trendHTML=await exportText("graduation","html");
    expect(trendHTML).toContain("91.8%");
    expect(trendHTML).toContain("90.6%");
    expect(trendHTML).toContain("2022");
    (card().querySelector('[data-graduation-view="groups"]') as HTMLButtonElement).click();
    expect(card().querySelector('[data-graduation-view="groups"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelector(".graduation-svg title")!.textContent).toContain("student groups");
    expect(card().textContent).toContain("88.9%");
    expect(card().textContent).toContain("82.4%");
    expect(card().textContent).toContain("Groups can overlap");
    const groupsSVG=await exportText("graduation","svg");
    expect(groupsSVG).toContain("Groups overlap");
    const groupsHTML=await exportText("graduation","html");
    expect(groupsHTML).toContain("Economically disadvantaged");
    expect(groupsHTML).toContain(groupURL);
    const [header2,...rows2]=await csv("graduation");
    expect(header2).toEqual(header);
    expect(rows2).toEqual(rows);
    const record=JSON.parse(await exportText("graduation","json"));
    expect(record.metric.cohortRates).toHaveLength(4);
    expect(record.metric.cohortGroupRates2025).toHaveLength(3);
    expect(record.metric.methodNote).toContain("federal calculation excludes");
  });


  it("keeps the absence methodology break visible when the figure leaves the Hub", async () => {
    const { doc, csv, exportText } = mount();
    const card = doc.querySelector("#metric-schoolabsence")!;
    expect(card.textContent).toContain("not directly comparable");
    expect(card.textContent).toContain("45 to 90 days");
    expect(card.textContent).toContain("State-excused absences");
    expect(card.textContent).not.toContain("+3.8 percentage points");
    const [header, ...rows] = await csv("schoolabsence");
    const note = rows.find(row => row[1] === "2024–25 methodology change")!;
    expect(note[2]).toBe("Not directly comparable");
    expect(note[header.indexOf("source_url")]).toContain("Reporting_Student_Attendance");
    const methods = rows.filter(row => row[0] === "methodology");
    expect(methods.map(row => row[1]).join(" ")).toContain("45 to 90 days");
    expect(methods.map(row => row[1]).join(" ")).toContain("State-excused absences are excluded");
    expect(methods.every(row => row[header.indexOf("source_url")].includes("Reporting_Student_Attendance"))).toBe(true);
    for (const format of ["html", "svg"] as const) {
      const text = await exportText("schoolabsence", format);
      expect(text).toContain("Not directly comparable");
      expect(text).not.toContain("+3.8 percentage points");
    }
    for (const view of ["chart", "number"] as const) {
      const container = doc.createElement("div");
      container.innerHTML = await exportText("schoolabsence", "svg", view);
      const visible = [...container.querySelectorAll("svg text")].map(node => node.textContent).join(" ");
      for (const text of ["45 to 90 days", "qualifying inactive records", "not directly comparable", "State-excused absences are excluded"])
        expect(visible).toContain(text);
    }
    const record = JSON.parse(await exportText("schoolabsence", "json"));
    expect(record.metric.methodNote).toContain("State-excused absences do not");
    expect(record.metric.methodNote).toContain("previously 45");
  });

  it("renders matched Jan–Jul 2026 NJ SNAP year-over-year data from the single DFD Table 5", async () => {
    const { doc, csv, exportText } = mount();
    const url="https://www.nj.gov/humanservices/dfd/news/reports/pdf/cps/2026/CPS_July2026.pdf";
    const policyUrl="https://nj.gov/humanservices/dfd/news/federal-changes/";
    const metric=seed.metrics.find((row: {id:string})=>row.id==="snap");
    expect(metric.checked).toBe("2026-11-09");
    expect(metric.value).toBe(737447);
    expect(metric.period).toBe("July 2026");
    expect(metric.sourceUrl).toBe(url);
    expect(metric.snapYearOverYear.rows).toHaveLength(7);
    expect(metric.snapYearOverYear.rows.map((r:{persons2025:number})=>r.persons2025)).toEqual(
      [819216,817023,817040,806240,824020,810939,793116]);
    expect(metric.snapYearOverYear.rows.map((r:{persons2026:number})=>r.persons2026)).toEqual(
      [785810,776576,766278,757528,748124,739593,737447]);
    expect(metric.snapYearOverYear.rows.every((r:{persons2025:number,persons2026:number,difference:number,percentChange:number})=>
      r.difference===r.persons2026-r.persons2025 &&
      Math.abs(r.percentChange-Number((100*r.difference/r.persons2025).toFixed(4)))<0.00001)).toBe(true);
    expect(metric.snapYearOverYear.rows.at(-1)).toMatchObject({date:"2026-07",persons2025:793116,persons2026:737447,difference:-55669});
    expect(metric.comparisonsPublic.every((r:{sourceUrl:string})=>r.sourceUrl===url)).toBe(true);
    expect(metric.snapPolicyContext.url).toBe(policyUrl);
    expect(metric.snapPolicyContext.milestones.map((r:{date:string})=>r.date)).toEqual(
      ["2025-07-04","2026-02-01","2026-04-10"]);
    const card=doc.querySelector("#metric-snap")!;
    expect(card.textContent).toContain("55,669");
    expect(card.textContent).toContain("−7.0%");
    expect(card.textContent).toContain("737,447");
    expect(card.textContent).toContain("793,116");
    expect(card.textContent).toContain("2025 participants");
    expect(card.textContent).toContain("2026 participants");
    expect(card.textContent).toContain("Federal SNAP policy changes");
    expect(card.textContent).toContain("not evidence that any specific decline");
    expect(card.querySelector(".snap-policy-context a")!.getAttribute("href")).toBe(policyUrl);
    expect(card.querySelectorAll(".snap-yoy-plot .snap-yoy-svg")).toHaveLength(1);
    expect(card.querySelectorAll(".snap-yoy-plot .snap-yoy-svg g title")).toHaveLength(7);
    expect(card.querySelector(".snap-yoy-plot .snap-yoy-svg desc")!.textContent).toContain("All values come from NJ DFD July 2026 Current Program Statistics Table 5");
    const [header, ...rows]=await csv("snap");
    expect(header).toEqual(["month_2026","month","participants_2025","participants_2026","change_people","change_percent","source_name","source_url","checked"]);
    expect(rows).toHaveLength(7);
    expect(rows[0].slice(0,6)).toEqual(["2026-01","Jan","819216","785810","-33406","-4.0778"]);
    expect(rows[6].slice(0,5)).toEqual(["2026-07","Jul","793116","737447","-55669"]);
    expect(rows[6][5].startsWith("-7.0")).toBe(true);
    expect(rows.every(r=>r.length===header.length&&r[7]===url&&r[8]==="2026-11-09")).toBe(true);
    const svg=await exportText("snap","svg");
    expect(svg).toContain("Published on NJ PBS");
    expect(svg).toContain("−55,669 people");
    expect(svg).toContain("−7.0%");
    expect(svg).toContain("year-over-year percent change");
    expect(svg).not.toContain("April 10, 2026"); // Policy milestones are not chart events.
    const standalone=await exportText("snap","html");
    expect(standalone).toContain("January–July 2026");
    expect(standalone).toContain("View exact monthly participant counts");
    expect(standalone).toContain("NJ DFD policy timeline");
    expect(standalone).toContain("2025-07-04");
    expect(standalone).toContain(policyUrl);
    expect(standalone).toContain("Published on NJ PBS");
    const record=JSON.parse(await exportText("snap","json"));
    expect(record.metric.snapYearOverYear.rows).toHaveLength(7);
    expect(record.metric.snapPolicyContext.url).toBe(policyUrl);
  });


  it("keeps the fallback source labels aligned with the corrected dataset records", () => {
    const fallback = html.match(/<noscript>([\s\S]*?)<\/noscript>/)![1];
    const { doc } = mount();
    const container = doc.createElement("div");
    container.innerHTML = fallback;
    for (const metric of seed.metrics) {
      const row = [...container.querySelectorAll("tbody tr")].find(row => row.querySelector("th")!.textContent === metric.title)!;
      expect(row.querySelector("a")!.getAttribute("href")).toBe(metric.sourceUrl);
      expect(row.querySelector("a")!.textContent).toBe(metric.source);
      expect(row.querySelectorAll("td")[0].textContent).toBe(metric.display);
      expect(row.querySelectorAll("td")[1].textContent).toBe(metric.period);
    }
  });

  it("keeps the release calendar hidden and out of section navigation", () => {
    const { doc } = mount();
    expect(doc.querySelector("#releases")!.hasAttribute("hidden")).toBe(true);
    expect(doc.querySelector('a[href="#releases"]')).toBeNull();
    // Update this count only with reviewed compiled release-calendar entries.
    expect(seed.releaseCalendar).toHaveLength(18);
    expect(seed.releaseCalendar.some((row: { type: string }) => row.type === "editorial check")).toBe(true);
    expect(seed.releaseCalendar.some((row: { type: string }) => row.type === "effective date")).toBe(true);
  });

  it("keeps the curated headline in the larger view", () => {
    const { doc } = mount();
    for (const id of ["statebudget", "industryjobs"]) {
      const metric = seed.metrics.find((row: { id: string }) => row.id === id);
      (doc.querySelector(`#metric-${id} [data-focus-metric]`) as HTMLButtonElement).click();
      expect(doc.querySelector(".v7-focus-number")!.textContent).toBe(metric.display);
      (doc.querySelector("#v7-focus-dialog") as HTMLDialogElement).close();
    }
  });

  it("retains only dataset and confirmed or estimated publication copy for later display", () => {
    const payload = { ...seed, releaseCalendar: [
      { dataset: "electricity", label: "EIA monthly residential prices", publicLabel: "Residential electricity prices", date: "2026-10-23", type: "confirmed" },
      { dataset: "temperature", label: "Rutgers monthly values", publicLabel: "Statewide temperature", date: "2026-11-06", type: "estimated" },
      { dataset: "snap", label: "Check for new reports", date: "2026-10-21", type: "editorial check" },
      { dataset: "minimumwage", label: "New wage takes effect", date: "2027-01-01", type: "effective date" },
    ] };
    const source = html.replace(/(<script id="source-data" type="application\/json">)[\s\S]*?(<\/script>)/,
      (_, open, close) => `${open}${JSON.stringify(payload)}${close}`);
    const { doc } = mount(source);
    const items = [...doc.querySelectorAll("#release-list li")];
    expect(items).toHaveLength(2);
    expect(items[0].querySelector(".release-item__title")!.textContent).toBe("Residential electricity prices");
    expect(items[0].textContent).toContain("Confirmed next publication:");
    expect(items[0].querySelector("time")!.getAttribute("datetime")).toBe("2026-10-23");
    expect(items[1].querySelector(".release-item__title")!.textContent).toBe("Statewide temperature");
    expect(items[1].textContent).toContain("Estimated next publication:");
    expect(items[1].querySelector("time")!.getAttribute("datetime")).toBe("2026-11-06");
    expect(doc.querySelector("#release-list")!.textContent).not.toMatch(/check|takes effect|reminder/i);
  });

  it("opens primary sources from V10 export previews in a new tab", () => {
    const { doc } = mount();
    for (const id of ["temperature", "industryjobs", "medianrent", "voterregistration", "statebudget", "familycare", "uninsured"]) {
      (doc.querySelector(`#metric-${id} [data-open-figure]`) as HTMLButtonElement).click();
      const preview = doc.querySelector("#figure-frame") as unknown as { srcdoc: string; getAttribute(name: string): string };
      const sandbox = preview.getAttribute("sandbox").split(/\s+/);
      expect(sandbox).toContain("allow-popups-to-escape-sandbox");
      expect(sandbox).not.toContain("allow-scripts");
      const win = new Window();
      windows.push(win);
      win.document.body.innerHTML = preview.srcdoc;
      const metric = seed.metrics.find((row: { id: string }) => row.id === id);
      const link = [...win.document.querySelectorAll("a")].find(link => link.href === metric.sourceUrl)!;
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noopener noreferrer");
      expect(link.textContent).toContain("opens in new tab");
    }
  });

  it("keeps all matched BLS metro and U.S. CPI sources distinct in labels and exported rows", async () => {
    const { doc, csv, exportText }=mount();
    const m=seed.metrics.find((r:{id:string})=>r.id==="inflationmetro");
    const metro="https://www.bls.gov/regions/northeast/news-release/2026/consumerpriceindex_newyork_20261014.htm";
    const us="https://www.bls.gov/news.release/archives/cpi_10142026.htm";
    expect(m.value).toBe(4.5);
    expect(m.checked).toBe("2026-11-09");
    expect(m.geography).toBe("metro");
    expect(m.metroCPI.sourceMetro).toBe(metro);
    expect(m.metroCPI.sourceUS).toBe(us);
    expect(m.metroCPI.monthlyMetro.map((r:{rate:number})=>r.rate)).toEqual([2.9,3.2,4,4.6,5.1,4.1,4.6,4.3,4.5]);
    const card=()=>doc.querySelector("#metric-inflationmetro")!;
    expect(card().textContent).toContain("not a New Jersey statewide inflation rate");
    expect(card().textContent).toContain("0.8 percentage point above");
    expect(card().querySelector(".metro-cpi-svg title")!.textContent).toContain("metro versus U.S.");
    expect(card().querySelector('[data-metro-view="national"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelector(".v7-source-notes a")!.getAttribute("href")).toBe(metro);
    expect(card().querySelectorAll(".v7-source-notes a")).toHaveLength(2);
    const [header,...csvRows]=await csv("inflationmetro");
    expect(header).toEqual(["view","reporting_period","geography","cpi_u_12_month_change_percent","bls_series","source_url","checked"]);
    expect(csvRows).toHaveLength(10);
    expect(csvRows[0].slice(0,4)).toEqual(["history","2026-01",m.metroCPI.metroArea,"2.9"]);
    expect(csvRows[8].slice(0,4)).toEqual(["history","2026-09",m.metroCPI.metroArea,"4.5"]);
    expect(csvRows[9]).toEqual(["national","2026-09","United States","3.7","BLS CPI-U all items, not seasonally adjusted",us,"2026-11-09"]);
    expect(csvRows.slice(0,9).every(r=>r[5]===metro&&r[6]==="2026-11-09")).toBe(true);
    const svg=await exportText("inflationmetro","svg");
    expect(svg).toContain("September 2026: NY–Newark metro vs. U.S.");
    expect(svg).toContain("Published on NJ PBS");
    const html=await exportText("inflationmetro","html");
    expect(html).toContain("3.7%");
    expect(html).toContain(us);
    (card().querySelector('[data-metro-view="history"]') as HTMLButtonElement).click();
    expect(card().querySelector('[data-metro-view="history"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(card().querySelectorAll(".metro-cpi-data tbody tr")).toHaveLength(9);
    expect(card().querySelector(".metro-cpi-svg title")!.textContent).toContain("January–September 2026");
    const historySvg=await exportText("inflationmetro","svg");
    expect(historySvg).toContain("Jan.–Sep. 2026");
    const [header2,...csvRows2]=await csv("inflationmetro");
    expect(header2).toEqual(header);
    expect(csvRows2).toEqual(csvRows);
    const record=JSON.parse(await exportText("inflationmetro","json"));
    expect(record.metric.metroCPI.monthlyMetro).toHaveLength(9);
  });

  it("does not turn unsafe comparison URLs into links", () => {
    const original = mount();
    expect(original.doc.querySelector("#metric-industryjobs .v10-benchmark dt a")).not.toBeNull();
    const source = sourceWith(payload => {
      const metric = payload.metrics.find((row: { id: string }) => row.id === "industryjobs");
      for (const comparison of metric.comparisonsPublic) comparison.sourceUrl = "javascript:alert(1)";
    });
    const { doc } = mount(source);
    expect(doc.querySelector("#metric-industryjobs .v10-benchmark dt a")).toBeNull();
    expect(doc.querySelector("#metric-industryjobs .v10-benchmark dt")?.textContent).toContain("Revised August change");
  });


  it("keeps industry CSV rows aligned without guessing formatted comparison units", async () => {
    const { csv } = mount();
    const [header, ...rows] = await csv("industryjobs");
    expect(rows.every(row => row.length === header.length)).toBe(true);
    const unit = header.indexOf("unit");
    expect(rows.filter(row => row[0] === "industry_monthly_change")).toHaveLength(10);
    for (const row of rows) {
      expect(row[unit]).toBe(row[0] === "comparison" ? "" : "jobs");
    }
  });


  it("uses one EIA residential table for both years, locations, charts and downloads", async () => {
    const { doc, csv, exportText } = mount();
    const metric = seed.metrics.find((row: { id: string }) => row.id === "electricity");
    const url = "https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a";
    expect(metric.value).toBe(24.61);
    expect(metric.period).toBe("August 2026");
    expect(metric.sourceUrl).toBe(url);
    expect(metric.comparisonsPublic.every((r: { sourceUrl?: string }) => r.sourceUrl === url)).toBe(true);
    expect(metric.electricityComparison).toEqual([
      { year: 2025, nj: 24.7, us: 17.57 },
      { year: 2026, nj: 24.61, us: 18.16 },
    ]);
    const card = doc.querySelector("#metric-electricity")!;
    expect(card.querySelectorAll(".history-plot svg.v7-viz")).toHaveLength(2);
    const desc = card.querySelector(".history-plot svg.v7-viz desc")!.textContent!;
    for (const text of ["NJ 24.70¢/kWh", "U.S. 17.57¢/kWh", "NJ 24.61¢/kWh", "U.S. 18.16¢/kWh"])
      expect(desc).toContain(text);
    expect(card.textContent).toContain("35.5%");
    expect(card.textContent).toContain("not average monthly utility bills");
    const [header, ...rows] = await csv("electricity");
    expect(header).toEqual(["period", "geography", "price_cents_per_kwh", "source_name", "source_url", "released", "checked", "status"]);
    expect(rows.map(row => row.slice(0, 3))).toEqual([
      ["August 2025", "New Jersey", "24.70"],
      ["August 2025", "United States", "17.57"],
      ["August 2026", "New Jersey", "24.61"],
      ["August 2026", "United States", "18.16"],
    ]);
    expect(rows.every(row => row.length === header.length && row[header.indexOf("source_url")] === url)).toBe(true);
    expect(rows.every(row => row[header.indexOf("checked")] === "2026-11-09")).toBe(true);
    const svg = await exportText("electricity", "svg");
    expect(svg).toContain("NJ 24.70¢/kWh");
    expect(svg).toContain("U.S. 18.16¢/kWh");
    const embedded = await exportText("electricity", "html");
    expect(embedded).toContain("View all four source prices as a table");
    expect(embedded).toContain("EIA Table 5.6.A");
    expect(embedded).toContain("18.16");
    const record = JSON.parse(await exportText("electricity", "json"));
    expect(record.metric.value).toBe(24.61);
    expect(record.metric.checked).toBe("2026-11-09");
  });

  it("exports both monthly comparison series and their reconciled totals", async () => {
    const { csv } = mount();
    const [precipHeader, ...precip] = await csv("precipitation");
    expect(precipHeader).toContain("precip_2025_in");
    expect(precipHeader).toContain("normal_1991_2020_in");
    expect(precip).toHaveLength(11);
    expect(precip[9].slice(0, 5)).toEqual(["2026-10", "2.69", "3.45", "4.19", "-1.5"]);
    expect(precip.at(-1)!.slice(0, 5)).toEqual(["JAN_OCT_TOTAL", "36.98", "33.81", "39.93", "-2.95"]);
    const [housingHeader, ...housing] = await csv("housingpermits");
    expect(housingHeader).toContain("housing_units_2025");
    expect(housing).toHaveLength(10);
    expect(housing.at(-1)!.slice(0, 3)).toEqual(["JAN_SEP_TOTAL", "22517", "23695"]);
  });
});
