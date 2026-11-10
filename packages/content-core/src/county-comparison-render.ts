import dataset from "./data/nj-federal-counties-2020-2024.v1.json";
import geometry from "./data/nj-county-svg-paths.json";
import { escapeHtml } from "./content-model";
import { isCountyComparisonData, type CountyComparisonData } from "./county-comparison";
import { clampHeadingLevel } from "./heading-outline";
import { formatEditorialDate } from "./editorial-date-format";

type Votes = { democratic: number; republican: number; other: number };
type Year = { senate: Votes; house: Votes; turnout: { registered: number; ballotsCast: number } };
type County = { county: string; "2020": Year; "2024": Year };
type Office = "senate" | "house";
const counties: readonly County[] = dataset.counties;
const number = (value: number) => value.toLocaleString("en-US");
const pct = (value: number) => `${value.toFixed(1)}%`;

export function countyMargin(votes: Votes): number {
  return 100 * (votes.democratic - votes.republican) / (votes.democratic + votes.republican + votes.other);
}

export function countyStatewide(): County {
  const empty = (): Year => ({ senate: { democratic: 0, republican: 0, other: 0 }, house: { democratic: 0, republican: 0, other: 0 }, turnout: { registered: 0, ballotsCast: 0 } });
  const total: County = { county: "Statewide", "2020": empty(), "2024": empty() };
  for (const county of counties) for (const year of ["2020", "2024"] as const) {
    for (const office of ["senate", "house"] as const) for (const party of ["democratic", "republican", "other"] as const) total[year][office][party] += county[year][office][party];
    total[year].turnout.registered += county[year].turnout.registered;
    total[year].turnout.ballotsCast += county[year].turnout.ballotsCast;
  }
  return total;
}

function marginLabel(margin: number): string {
  return margin === 0 ? "Tie" : `${margin > 0 ? "D" : "R"} +${Math.abs(margin).toFixed(1)} pts`;
}

function winner(office: Office, year: "2020" | "2024", margin: number): string {
  if (margin === 0) return "Tie";
  if (office === "house") return margin > 0 ? "Democratic candidates" : "Republican candidates";
  return margin > 0 ? (year === "2020" ? "Cory Booker" : "Andy Kim") : (year === "2020" ? "Rikin Mehta" : "Curtis Bashaw");
}

function changeLabel(value: number): string {
  return Math.abs(value) < .05 ? "No change" : `${Math.abs(value).toFixed(1)} pts toward ${value > 0 ? "D" : "R"}`;
}

function row(county: County, office: Office, prefix: string): string {
  const result = (["2020", "2024"] as const).map(year => {
    const margin = countyMargin(county[year][office]);
    return `<td data-county-sort-value="${margin}">${escapeHtml(winner(office, year, margin))}<small>${marginLabel(margin)}</small></td>`;
  }).join("");
  const change = countyMargin(county["2024"][office]) - countyMargin(county["2020"][office]);
  const turnout = (["2020", "2024"] as const).map(year => {
    const { registered, ballotsCast } = county[year].turnout;
    const rate = 100 * ballotsCast / registered;
    return `<td data-county-sort-value="${rate}">${pct(rate)}<small>${number(ballotsCast)} ballots</small></td>`;
  }).join("");
  // The adjacent text carries the exact value; the dot is a redundant visual cue.
  const dot = `<svg class="county-comparison__dot" viewBox="0 0 100 12" aria-hidden="true"><path d="M0 6H100M50 0V12"/><circle cx="${50 + change}" cy="6" r="4"/></svg>`;
  return `<tr tabindex="-1" id="${prefix}-${county.county.toLowerCase().replaceAll(" ", "-")}"><th scope="row">${escapeHtml(county.county)}</th>${result}<td data-county-sort-value="${change}">${changeLabel(change)}${dot}</td>${turnout}</tr>`;
}

function table(office: Office, prefix: string): string {
  const title = office === "senate" ? "U.S. Senate results and election turnout by county" : "Combined U.S. House votes by county and election turnout";
  const labels = ["County", "2020 result", "2024 result", "Margin change", "2020 turnout", "2024 turnout"];
  const headings = labels.map((label, index) => `<th scope="col"${index === 0 ? ' aria-sort="ascending"' : ""}><span>${label}</span><button type="button" hidden data-county-sort="${index}" aria-label="${index === 1 || index === 2 ? `${label}, sort by Democratic minus Republican margin` : `Sort by ${label.toLowerCase()}`}">${label}<span aria-hidden="true"> ↕</span></button></th>`).join("");
  return `<div class="county-comparison__scroll" tabindex="0" role="region" aria-label="${title}; scroll to see all columns"><table><caption>${title}</caption><thead><tr>${headings}</tr></thead><tbody>${counties.map(county => row(county, office, prefix)).join("")}</tbody><tfoot>${row(countyStatewide(), office, prefix)}</tfoot></table></div>`;
}

function map(prefix: string): string {
  const paths = geometry.counties.map(shape => {
    const county = counties.find(row => row.county === shape.name)!;
    const margin = countyMargin(county["2024"].senate);
    const band = margin >= 10 ? "democratic" : margin >= 0 ? "democratic-close" : margin > -10 ? "republican-close" : "republican";
    const label = `${shape.name} County: ${winner("senate", "2024", margin)}, ${marginLabel(margin)} in 2024. Go to table row.`;
    return `<a href="#${prefix}-${shape.name.toLowerCase().replaceAll(" ", "-")}" aria-label="${escapeHtml(label)}"><path class="county-comparison__county county-comparison__county--${band}" d="${shape.path}"><title>${escapeHtml(label)}</title></path></a>`;
  }).join("");
  return `<figure class="county-comparison__map"><figcaption>2024 U.S. Senate margin</figcaption><p>Select a county to reach its table row.</p><svg viewBox="225 105 460 840" role="group" aria-label="New Jersey counties, colored by 2024 U.S. Senate margin">${paths}</svg><ul class="county-comparison__legend"><li><i class="county-comparison__county--democratic" aria-hidden="true"></i>D +10 pts or more</li><li><i class="county-comparison__county--democratic-close" aria-hidden="true"></i>D lead under 10 pts</li><li><i class="county-comparison__county--republican-close" aria-hidden="true"></i>R lead under 10 pts</li><li><i class="county-comparison__county--republican" aria-hidden="true"></i>R +10 pts or more</li></ul></figure>`;
}

export function renderCountyComparison(blockId: string, data: CountyComparisonData, headingLevel = 2): string {
  if (!isCountyComparisonData(data)) return "";
  const level = clampHeadingLevel(headingLevel);
  const prefix = `county-${encodeURIComponent(blockId)}-senate`;
  const heading = data.heading.trim() || "How counties voted in 2020 and 2024";
  const intro = data.intro.trim() || "Compare New Jersey’s U.S. Senate results and voter turnout across all 21 counties. The map shows 2024 results; the table compares both elections.";
  const source = data.source.trim() || dataset.source;
  const downloaded = formatEditorialDate(dataset.downloadedAt);
  const links = dataset.sources.map(item => `<a href="${item.url}">${item.year} ${item.measure === "turnout" ? "turnout" : `U.S. ${item.measure === "senate" ? "Senate" : "House"}`}</a>`).join(" · ");
  return `<section class="county-comparison" aria-label="${escapeHtml(heading)}"><h${level}>${escapeHtml(heading)}</h${level}><p>${escapeHtml(intro)}</p><p class="county-comparison__method">D = Democratic; R = Republican. Margins use all listed candidate votes. Change compares the Democratic minus Republican margin in percentage points. Turnout is ballots cast ÷ registered voters. With JavaScript enabled, select a column heading to sort; results sort by Democratic minus Republican margin.</p><p class="county-comparison__status" role="status" aria-live="polite"></p><div class="county-comparison__layout">${map(prefix)}${table("senate", prefix)}</div><details class="county-comparison__house"><summary>Compare combined U.S. House votes</summary><p>${escapeHtml(dataset.methodology.house)}</p>${table("house", `county-${encodeURIComponent(blockId)}-house`)}</details><p class="county-comparison__source">Source: ${escapeHtml(source)}. <span>${downloaded ? `Downloaded ${downloaded} (UTC). ` : ""}${links}.</span> <a href="${geometry.source}">County boundaries: New Jersey Office of GIS</a>.</p><p class="county-comparison__method">${escapeHtml(dataset.methodology.margin)} ${escapeHtml(dataset.methodology.turnout)}</p></section>`;
}
