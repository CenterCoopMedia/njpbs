import elections from "../data/nj-town-elections-v1.json" with { type: "json" };
import boundaries from "../data/nj-town-boundaries-v1.json" with { type: "json" };
import trends from "../data/nj-town-election-trends.json" with { type: "json" };
import { escapeHtml } from "./safe-href.ts";
import { percent, renderTownTrendFallbackCells, voteShare, type TrendCounts } from "./town-election-trends.ts";
import type { TownLookupData } from "./town-lookup";

const stateReturns = (year: number) => `https://www.nj.gov/state/elections/election-information-${year}.shtml#general`;
const resultsArchive = "https://www.nj.gov/state/elections/election-information-results.shtml";
const turnoutArchive = "https://www.nj.gov/state/elections/election-information-ballots-cast.shtml";
const figures = [
  ["2016 president", "Clinton", "Trump", stateReturns(2016), 0],
  ["2020 president", "Biden", "Trump", stateReturns(2020), 4],
  ["2024 president", "Harris", "Trump", stateReturns(2024), 8],
  ["2024 U.S. Senate", "Kim", "Bashaw", elections.sources.federal.url, null],
  ["2024 U.S. House", "", "", elections.sources.federal.url, null],
] as const;
const shapes = new Map(boundaries.towns.map(town => [town.id, town]));
const number = (value: number) => value.toLocaleString("en-US");
const source = (href: string, text: string) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;

/** All values ship in the browse table. JavaScript adds the selected view and charts. */
export function renderTownLookup(id: string, data: TownLookupData, level = 2): string {
  const prefix = `town-lookup-${id}`;
  const heading = Math.max(2, Math.min(6, level));
  const trendHeading = Math.min(6, heading + 1);
  const headers = figures.map(([label, , , href]) => `<th scope="col">${source(href, label)}</th>`).join("");
  const rows = elections.towns.map(town => {
    const shape = shapes.get(town.id)!;
    const counts = trends.towns[town.id as keyof typeof trends.towns] as TrendCounts;
    const cells = figures.map(([, dem, rep, , period]) => {
      const house = !dem;
      const race = period === null ? null : counts[period][0];
      const shares = period === null ? (house ? town.house2024.shares : town.senate2024)
        : race ? [voteShare(race[0], race[2]), voteShare(race[1], race[2])] : [null, null];
      return `<td data-town-figure>${house ? `<span>${escapeHtml(town.house2024.district)}</span>` : ""}<span>${escapeHtml(dem || town.house2024.democrat)} (D): ${percent(shares[0])}</span><span>${escapeHtml(rep || town.house2024.republican)} (R): ${percent(shares[1])}</span></td>`;
    }).join("");
    const turnout = town.turnout2024;
    return `<tr data-town-id="${town.id}" data-town-label="${escapeHtml(`${town.name}, ${town.county} County`)}" data-town-path="${escapeHtml(shape.path)}" data-town-marker="${shape.marker.join(" ")}" data-town-trends="${escapeHtml(JSON.stringify(counts))}"><th scope="row">${escapeHtml(town.name)}<span>${escapeHtml(town.county)} County</span></th>${cells}<td data-town-figure><span>${percent(voteShare(turnout.ballots, turnout.registered))}</span><span>${number(turnout.ballots)} ballots / ${number(turnout.registered)} registered voters</span></td>${renderTownTrendFallbackCells(counts)}</tr>`;
  }).join("");
  return `<section class="town-lookup" aria-labelledby="${escapeHtml(prefix)}-heading" data-trend-sources="${escapeHtml(JSON.stringify(trends.sources))}">
    <header><h${heading} id="${escapeHtml(prefix)}-heading">${escapeHtml(data.heading)}</h${heading}>${data.introduction.trim() ? `<p>${escapeHtml(data.introduction)}</p>` : ""}</header>
    <form class="town-lookup__search" hidden role="search" aria-label="Find past town election results"><label for="${escapeHtml(prefix)}-search">Find your municipality</label><div class="town-lookup__search-row"><input id="${escapeHtml(prefix)}-search" type="search" list="${escapeHtml(prefix)}-towns" autocomplete="off" placeholder="Start typing a town or county" aria-describedby="${escapeHtml(prefix)}-help" /><button type="submit">Show results</button></div><datalist id="${escapeHtml(prefix)}-towns"></datalist><p id="${escapeHtml(prefix)}-help">Choose a town and county from the suggestions, then select Show results. All 564 municipalities are included.</p></form>
    <p class="town-lookup__status" role="status" hidden></p>
    <div class="town-lookup__selected" hidden><div class="town-lookup__results"></div><figure class="town-lookup__map"><svg viewBox="${boundaries.viewBox.join(" ")}" role="img" aria-label="Selected town in New Jersey"><g class="town-lookup__counties">${boundaries.counties.map(county => `<path d="${escapeHtml(county.path)}" />`).join("")}</g><path class="town-lookup__highlight" fill-rule="evenodd" /><circle class="town-lookup__marker" r="9" /></svg><figcaption></figcaption><a href="${escapeHtml(boundaries.source.url)}">Map: NJ Office of GIS</a></figure>
      <section class="town-trends" aria-labelledby="${escapeHtml(prefix)}-trends"><h${trendHeading} id="${escapeHtml(prefix)}-trends">Election trends, 2016–2025</h${trendHeading}><div class="town-trends__content"></div></section>
    </div>
    <p class="town-lookup__method">Vote shares use the votes listed for all candidates in each race. D = Democratic. R = Republican. Turnout is ballots cast divided by registered voters in that year's general election. Figures are rounded to one decimal.</p>
    <details class="town-lookup__all"><summary>Browse all 564 municipalities</summary><p>Earlier Pine Hill figures combine Pine Hill and Pine Valley through 2021. Unavailable values could not be verified from the published returns.</p><div class="town-lookup__scroll" tabindex="0" role="region" aria-label="Historical results for all New Jersey municipalities"><table><caption>Past election results by municipality and county</caption><thead><tr><th scope="col">Municipality</th>${headers}<th scope="col">${source(elections.sources.turnout.url, "2024 turnout")}</th><th scope="col">Governor vote shares</th><th scope="col">Turnout in other years</th></tr></thead><tbody>${rows}</tbody></table></div></details>
    <footer>${data.sourceLine.trim() ? `<p>${escapeHtml(data.sourceLine)}</p>` : ""}<p>${source(resultsArchive, "Official election results")} and ${source(turnoutArchive, "registered voters and ballots cast")} from the New Jersey Division of Elections. The 2024 U.S. Senate and House comparisons and turnout counts are from the <a href="${escapeHtml(elections.analysisUrl)}">NJ Spotlight News municipal election analysis</a>, downloaded ${escapeHtml(elections.downloadedAt)} (UTC).</p></footer>
  </section>`;
}
