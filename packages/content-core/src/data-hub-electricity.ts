import type { DatasetPublicProjection } from "./data-figure.ts";
import type { DatasetRelease } from "./datasets.ts";

/** The electricity figure reads four matched prices from one approved dataset release. */
type ElectricityRelease = Pick<DatasetRelease, "unit" | "value" | "period" | "geography" | "adjustment" | "points" | "comparators" | "source"> &
  { reuse: Pick<DatasetRelease["reuse"], "exports" | "note"> };
/** The dataset's Source series names the one series this figure describes. */
export const HUB_ELECTRICITY_SERIES = "EIA-EPM-5.6.A-NJ-RES";
/** The figure and its embed name this table as their source. */
export const HUB_ELECTRICITY_SOURCE = "https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a";
/** Each U.S. comparison names the national series for the same sector. */
export const HUB_ELECTRICITY_US_SERIES = "EIA-EPM-5.6.A-US-RES";
export interface HubElectricityRow { year: number; nj: number; us: number }
interface Published { releaseId: string; revision: number; approvedOn: string; credit: string }
export interface HubElectricityMetric {
  id: string; title: string; value: number; display: string; period: string; insight: string; checked: string;
  source: string; sourceUrl: string; methodNote: string; electricityComparison: HubElectricityRow[]; datasetRelease: Published;
  [field: string]: unknown;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SOURCE_DATA = /(<script id="source-data" type="application\/json">)([\s\S]*?)(<\/script>)/;

export function isHubElectricity(release: ElectricityRelease): boolean {
  return release.source.seriesId === HUB_ELECTRICITY_SERIES && release.unit === "cents_kwh" && release.geography.level === "state" && release.geography.code === "NJ";
}
function rows(release: ElectricityRelease): [HubElectricityRow, HubElectricityRow] | string {
  const month = release.period.start.slice(0, 7);
  const fullMonth = (period: DatasetRelease["period"], key: string) => period.start === `${key}-01` &&
    period.end === new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)), 0)).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}$/.test(month) || !fullMonth(release.period, month)) return "period.start: The Data Hub electricity price needs a reporting period of one calendar month.";
  // A field path before the colon marks that field in Boardwalk.
  if (release.source.url !== HUB_ELECTRICITY_SOURCE) return `source.url: The Data Hub electricity price needs the address ${HUB_ELECTRICITY_SOURCE}.`;
  const year = Number(month.slice(0, 4));
  const pair = [year - 1, year].map(value => {
    const key = `${value}${month.slice(4)}`;
    const nj = release.points.filter(point => point.period.slice(0, 7) === key && point.value !== null);
    const us = release.comparators.filter(item => item.geography.level === "nation" && item.geography.code === "US" && fullMonth(item.period, key) &&
      item.source.seriesId === HUB_ELECTRICITY_US_SERIES && item.adjustment === release.adjustment && item.source.publisher === release.source.publisher && item.source.url === release.source.url);
    return nj.length === 1 && us.length === 1 && nj[0].value! > 0 && us[0].value > 0 ? { year: value, nj: nj[0].value!, us: us[0].value } : null;
  });
  if (!pair[0] || !pair[1]) return "points: The Data Hub electricity price needs one New Jersey observation and one U.S. comparison for this month and for the same month last year, with the same source and adjustment and the source series " + HUB_ELECTRICITY_US_SERIES + ".";
  if (pair[1].nj !== release.value) return "value: The electricity price must equal the New Jersey observation for its reporting month.";
  // The Hub offers downloads and third-party embeds for every figure it shows.
  if (release.reuse.exports !== "allowed") return "reuse.exports: Clear export rights before the Data Hub shows this price.";
  // Image downloads draw the credit on fixed lines. Other scripts have characters wider than the line allows.
  if (!/^[\t\n\r\u0020-\u007e\u00a0-\u017e\u2013\u2014\u2018-\u201d\u2022\u2026\u20ac\u2122]*$/.test(release.reuse.note.normalize("NFC"))) {
    return "reuse.note: Use Latin letters, digits and common punctuation in the public credit. Image downloads cannot draw other characters reliably.";
  }
  return [pair[0], pair[1]];
}
/** Staff message for an electricity release the Hub cannot show, or null. */
export function hubElectricityProblem(release: ElectricityRelease): string | null {
  const result = isHubElectricity(release) ? rows(release) : null;
  return typeof result === "string" ? result : null;
}

const cents = (value: number) => value.toFixed(2);
const percent = (to: number, from: number) => ((to / from - 1) * 100).toFixed(1);
const signed = (value: string, minus = "-") => Number(value) > 0 ? `+${value}` : value.replace("-", minus);
const size = (value: string) => value.replace("-", "");
const side = (gap: number) => gap >= 0 ? "above" : "below";
const moved = (value: string) => Number(value) === 0 ? "was unchanged" : `${Number(value) > 0 ? "increased" : "declined"} ${size(value)}%`;

/** Replace the compiled electricity record and its two server-rendered copies. */
export function applyHubElectricity(html: string, projection: DatasetPublicProjection): string {
  const { release } = projection;
  const pair = rows(release);
  if (typeof pair === "string") throw new Error(pair);
  const seed = JSON.parse(SOURCE_DATA.exec(html)![2]);
  const base = seed.metrics.find((metric: { id: string }) => metric.id === "electricity");
  const metric = hubElectricityMetric(base, projection, pair);
  const index = seed.metrics.indexOf(base);
  seed.metrics[index] = metric;
  // The frozen projection carries no next review date, so the compiled one is dropped.
  seed.releaseCalendar = seed.releaseCalendar.filter((row: { dataset: string }) => row.dataset !== "electricity");
  const payload = JSON.stringify(seed).replace(/</g, "\\u003c");
  const released = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${release.releasedOn}T00:00:00Z`));
  const gap = side(pair[1].nj - pair[1].us);
  const finding = `<li data-latest-metric="electricity"><time datetime="${release.releasedOn}">Source released ${released}</time><h3><a href="#metric-electricity" data-go-figure="electricity">NJ electricity prices were ${gap} the U.S. average</a></h3><p>${escape(metric.insight)} This is not an average bill.</p><p class="latest-findings__period">Data: ${metric.period}</p></li>`;
  const row = `<tr><th scope="row">${escape(metric.title)}</th><td>${metric.display}</td><td>${metric.period}</td><td><a href="${escape(metric.sourceUrl)}">${escape(metric.source)}</a>${credit(metric)}</td></tr>`;
  return swap(swap(swap(html, SOURCE_DATA, (_all, open, _json, close) => open + payload + close),
    /<li data-latest-metric="electricity">[\s\S]*?<\/li>/, () => finding),
    /<tr><th scope="row">Residential electricity price<\/th>[\s\S]*?<\/tr>/, () => row);
}
function swap(html: string, pattern: RegExp, next: (...parts: string[]) => string): string {
  if (!pattern.test(html)) throw new Error("The compiled Data Hub electricity slot is missing.");
  return html.replace(pattern, next);
}
function hubElectricityMetric(base: Record<string, unknown>, projection: DatasetPublicProjection, pair: [HubElectricityRow, HubElectricityRow]): HubElectricityMetric {
  const { release } = projection;
  const [before, now] = pair;
  const month = MONTHS[Number(release.period.start.slice(5, 7)) - 1];
  const period = `${month} ${now.year}`, priorPeriod = `${month} ${before.year}`;
  const nj = percent(now.nj, before.nj), us = percent(now.us, before.us);
  const gap = cents(Math.abs(now.nj - now.us)), gapPercent = size(percent(now.nj, now.us)), above = side(now.nj - now.us);
  const source = `${release.source.publisher}, ${release.source.title}`, sourceUrl = release.source.url;
  const public_ = (label: string, value: string, detail: string, when: string, kind: string) => ({ label, value, detail, period: when, kind, sourceUrl });
  const kept = Object.fromEntries(Object.entries(base).filter(([field]) => field !== "nextCheck" && field !== "nextReleaseLabel"));
  return { ...kept, id: "electricity", title: String(base.title), checked: release.verifiedOn, released: release.releasedOn,
    value: now.nj, display: `${cents(now.nj)}¢/kWh`, period,
    description: `Average New Jersey residential electricity price per kilowatt-hour in ${period}, not a household's monthly electricity bill.`,
    insight: `In ${month}, New Jersey's average residential electricity price ${moved(nj)} year over year, while the U.S. average ${moved(us)}. New Jersey was ${gapPercent}% ${above} the U.S. price per kWh.`,
    source, sourceUrl, historySource: source, historySourceUrl: sourceUrl,
    points: [{ label: priorPeriod, value: before.nj }, { label: period, value: now.nj }],
    history: pair.map(row => ({ date: String(row.year), value: row.nj })),
    chartTitle: `Average residential price · ${priorPeriod} vs. ${period}`,
    historyChartNote: release.chartText, methodNote: release.methodNote,
    comparisonsPublic: [
      public_("U.S. residential average", `${cents(now.us)}¢/kWh`, `Same source and sector · ${period}`, period, "national"),
      public_(`NJ ${above} U.S.`, `${above === "above" ? "+" : "−"}${gap}¢/kWh (${above === "above" ? "+" : "−"}${gapPercent}%)`, "Same month, source table and sector", period, "difference"),
      public_(`NJ change since ${priorPeriod}`, `${signed(nj, "−")}%`, `${cents(before.nj)}¢/kWh to ${cents(now.nj)}¢/kWh`, `${priorPeriod}–${period}`, "historical"),
      public_(`U.S. change since ${priorPeriod}`, `${signed(us, "−")}%`, `${cents(before.us)}¢/kWh to ${cents(now.us)}¢/kWh`, `${priorPeriod}–${period}`, "historical"),
    ],
    electricityComparison: pair,
    datasetRelease: { releaseId: projection.releaseId, revision: projection.revision, credit: release.reuse.note.normalize("NFC"),
      approvedOn: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(projection.approvedAt)) },
  };
}

/** The electricity record in a served Hub page, only when it came from a dataset release. */
export function readHubElectricity(html: string): HubElectricityMetric | null {
  const json = SOURCE_DATA.exec(html)?.[2];
  const metric = json && JSON.parse(json).metrics.find((item: { id: string }) => item.id === "electricity");
  return metric?.datasetRelease ? metric : null;
}

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
const credit = (metric: HubElectricityMetric) => metric.datasetRelease.credit ? ` · ${escape(metric.datasetRelease.credit)}` : "";
const dateLabel = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const f = (value: number) => value.toFixed(1);

type Palette = { ink: string; secondary: string; track: string; highlight: string; data: string; grid: string };
/** The built embed already holds the resolved design tokens, in drawing order. */
function builtPalette(shell: string): Palette {
  const fills = (tag: string) => [...shell.matchAll(new RegExp(`<${tag} [^>]*fill="([^"]+)"`, "g"))].map(match => match[1]);
  const text = fills("text"), rect = fills("rect");
  return { ink: text[0], secondary: text[1], track: rect[0], highlight: rect[1], data: rect[3], grid: /<line [^>]*stroke="([^"]+)"/.exec(shell)![1] };
}
/** Same drawing as electricSVG in the reader; a test holds the two byte-identical. */
function chart(pair: HubElectricityRow[], month: string, compact: boolean, color: Palette): string {
  const W = compact ? 480 : 1000, H = compact ? 365 : 370, start = compact ? 130 : 172, end = compact ? 380 : 870, width = end - start;
  const max = Math.max(30, Math.ceil(Math.max(...pair.flatMap(row => [row.nj, row.us])) / 10) * 10);
  const text = (x: number, y: number, value: string, fontSize: number, weight: number, anchor: string, fill: string) =>
    `<text x="${f(x)}" y="${f(y)}" fill="${fill}" text-anchor="${anchor}" font-size="${fontSize}" font-weight="${weight}" font-family="PBS Sans,Avenir Next,Segoe UI,Arial,sans-serif">${escape(value)}</text>`;
  const rect = (x: number, y: number, w: number, h: number, fill: string) => `<rect x="${f(x)}" y="${f(y)}" width="${f(Math.max(0, w))}" height="${f(Math.max(0, h))}" fill="${fill}" />`;
  let parts = "";
  for (const [i, row] of pair.entries()) {
    const groupY = 34 + i * 149;
    parts += text(9, groupY, `${month} ${row.year}`, compact ? 22 : 24, 750, "start", color.ink);
    for (let j = 0; j < 2; j++) {
      const value = j === 0 ? row.nj : row.us, y = groupY + 22 + j * 49;
      parts += text(9, y + 20, j === 0 ? "New Jersey" : "United States", compact ? 17 : 20, 550, "start", color.secondary);
      parts += rect(start, y, width, 24, color.track) + rect(start, y, width * value / max, 24, j === 0 ? color.highlight : color.data);
      parts += text(W - 7, y + 20, `${cents(value)}¢`, compact ? 18 : 22, 750, "end", color.ink);
    }
  }
  parts += `<line x1="${f(start)}" y1="333.0" x2="${f(end)}" y2="333.0" stroke="${color.grid}" stroke-width="1" />`;
  for (const [i, v] of [0, max / 2, max].entries()) parts += text(start + width * v / max, 362, `${v}¢`, compact ? 17 : 18, 450, ["start", "middle", "end"][i], color.secondary);
  const id = `electricity-page-${compact ? "mobile" : "desktop"}`;
  const detail = pair.map(row => `${month} ${row.year}: NJ ${cents(row.nj)}¢/kWh, U.S. ${cents(row.us)}¢/kWh`).join("; ");
  return `<svg class="history-svg--${compact ? "mobile" : "desktop"} v7-viz" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">New Jersey and U.S. residential electricity prices, ${month} ${pair[0].year} and ${pair[1].year}</title><desc id="${id}-desc">${escape(detail)}. Source: EIA Table 5.6.A, residential sector. The bars begin at zero.</desc>${parts}</svg>`;
}
/** Put one Hub record into the built embed document for the same view. */
export function hubElectricityEmbed(shell: string, metric: HubElectricityMetric, view: "chart" | "number"): string {
  const pair = metric.electricityComparison, [before, now] = pair;
  const month = metric.period.split(" ")[0], color = view === "chart" ? builtPalette(shell) : undefined, link = escape(metric.sourceUrl);
  const opens = '<span class="sr-only"> (opens in new tab)</span></a>';
  const gap = now.nj - now.us;
  const body = view === "number" ? "" : `<p class="context">${escape(metric.insight)}</p><div class="history-block v7-history"><div class="history-block__head"><p class="history-block__title">${month} electricity prices: ${before.year} and ${now.year}</p><p class="history-block__unit">New Jersey vs. United States · residential cents per kilowatt-hour</p></div><div class="history-plot">${chart(pair, month, false, color!)}${chart(pair, month, true, color!)}</div><p class="v7-reading">Since ${month} ${before.year}, NJ's average price changed ${signed(percent(now.nj, before.nj))}%; the U.S. price changed ${signed(percent(now.us, before.us))}%. In ${month} ${now.year}, New Jersey was ${cents(Math.abs(gap))}¢/kWh (${size(percent(now.nj, now.us))}%) ${side(gap)} the U.S.</p><p class="v7-reading">Prices per kilowatt-hour, not average monthly utility bills.</p><details><summary>View all four source prices as a table</summary><div class="history-table-scroller"><table><caption>${month} residential electricity prices · EIA Table 5.6.A · cents per kilowatt-hour</caption><thead><tr><th scope="col">Month</th><th scope="col">New Jersey</th><th scope="col">United States</th></tr></thead><tbody>${pair.map(row => `<tr><th scope="row">${month} ${row.year}</th><td>${cents(row.nj)}¢/kWh</td><td>${cents(row.us)}¢/kWh</td></tr>`).join("")}</tbody></table></div></details><details class="v7-source-notes"><summary>Method and limitations</summary><p>${escape(metric.methodNote)}</p><p><a href="${link}" target="_blank" rel="noopener noreferrer">Official EIA source${opens}</p></details></div>`;
  const main = `<main><h1>${escape(metric.title)}</h1><p class="value">${escape(metric.display)}</p><p class="period">${escape(metric.period)}</p>${body}
      <footer class="meta"><p><strong>Source:</strong> <a href="${link}" target="_blank" rel="noopener noreferrer">${escape(metric.source)}${opens}</p><p><strong>Checked:</strong> ${dateLabel(metric.checked)}. Latest published figure.</p><p class="note">Published on NJ PBS${credit(metric)}</p></footer>
    <footer class="njpbs-figure-credit"><p>Data snapshot: <time datetime="${metric.datasetRelease.approvedOn}">${dateLabel(metric.datasetRelease.approvedOn)}</time> · <a href="https://njpbs.org/data-hub/" target="_blank" rel="noopener noreferrer">NJ PBS Data Hub${opens}</p></footer></main>`;
  return swap(shell, /<main>[\s\S]*<\/main>/, () => main);
}
