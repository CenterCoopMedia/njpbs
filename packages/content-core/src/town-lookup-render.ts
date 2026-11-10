import elections from "../data/nj-town-elections-v1.json" with { type: "json" };
import boundaries from "../data/nj-town-boundaries-v1.json" with { type: "json" };
import { escapeHtml } from "./safe-href.ts";
import type { TownLookupData } from "./town-lookup";

const figures = [
  ["president2016", "2016 president", "Clinton", "Trump", "president"],
  ["president2020", "2020 president", "Biden", "Trump", "president"],
  ["president2024", "2024 president", "Harris", "Trump", "federal"],
  ["senate2024", "2024 U.S. Senate", "Kim", "Bashaw", "federal"],
  ["house2024", "2024 U.S. House", "", "", "federal"],
] as const;
const shapes = new Map(boundaries.towns.map(town => [town.id, town]));
const percent = (value: number) => `${value.toFixed(1)}%`;
const number = (value: number) => value.toLocaleString("en-US");
const source = (key: keyof typeof elections.sources, text: string) =>
  `<a href="${escapeHtml(elections.sources[key].url)}">${escapeHtml(text)}</a>`;

/** Complete real tables ship as HTML. JavaScript only adds the town selection. */
export function renderTownLookup(id: string, data: TownLookupData, level = 2): string {
  const prefix = `town-lookup-${id}`;
  const heading = Math.max(2, Math.min(6, level));
  const headers = figures.map(([, label, , , key]) => `<th scope="col">${source(key, label)}</th>`).join("");
  const rows = elections.towns.map(town => {
    const shape = shapes.get(town.id)!;
    const cells = figures.map(([key, , dem, rep]) => {
      const shares = key === "house2024" ? town.house2024.shares : town[key];
      return `<td data-town-figure>${key === "house2024" ? `<span>${escapeHtml(town.house2024.district)}</span>` : ""}<span>${escapeHtml(dem || town.house2024.democrat)} (D): ${percent(shares[0])}</span><span>${escapeHtml(rep || town.house2024.republican)} (R): ${percent(shares[1])}</span></td>`;
    }).join("");
    const turnout = town.turnout2024;
    return `<tr data-town-id="${town.id}" data-town-label="${escapeHtml(`${town.name}, ${town.county} County`)}" data-town-path="${escapeHtml(shape.path)}" data-town-marker="${shape.marker.join(" ")}"><th scope="row">${escapeHtml(town.name)}<span>${escapeHtml(town.county)} County</span></th>${cells}<td data-town-figure><span>${percent(turnout.percent)}</span><span>${number(turnout.ballots)} ballots / ${number(turnout.registered)} registered voters</span></td></tr>`;
  }).join("");
  return `<section class="town-lookup" aria-labelledby="${escapeHtml(prefix)}-heading">
    <header><h${heading} id="${escapeHtml(prefix)}-heading">${escapeHtml(data.heading)}</h${heading}>${data.introduction.trim() ? `<p>${escapeHtml(data.introduction)}</p>` : ""}</header>
    <form class="town-lookup__search" hidden role="search" aria-label="Find past town election results"><label for="${escapeHtml(prefix)}-search">Find your municipality</label><div class="town-lookup__search-row"><input id="${escapeHtml(prefix)}-search" type="search" list="${escapeHtml(prefix)}-towns" autocomplete="off" placeholder="Start typing a town or county" aria-describedby="${escapeHtml(prefix)}-help" /><button type="submit">Show results</button></div><datalist id="${escapeHtml(prefix)}-towns"></datalist><p id="${escapeHtml(prefix)}-help">Choose a town and county from the suggestions, then select Show results. All 564 municipalities are included.</p></form>
    <p class="town-lookup__status" role="status" hidden></p>
    <div class="town-lookup__selected" hidden><div class="town-lookup__results"></div><figure class="town-lookup__map"><svg viewBox="${boundaries.viewBox.join(" ")}" role="img" aria-label="Selected town in New Jersey"><g class="town-lookup__counties">${boundaries.counties.map(county => `<path d="${escapeHtml(county.path)}" />`).join("")}</g><path class="town-lookup__highlight" fill-rule="evenodd" /><circle class="town-lookup__marker" r="9" /></svg><figcaption></figcaption><a href="${escapeHtml(boundaries.source.url)}">Map: NJ Office of GIS</a></figure></div>
    <p class="town-lookup__method">Vote shares are percentages of votes cast in each race, rounded to one decimal. D = Democratic; R = Republican. Other candidates are not shown, so shares may not add to 100%. Turnout is ballots cast divided by registered voters in the 2024 general election.</p>
    <details class="town-lookup__all"><summary>Browse all 564 municipalities</summary><p>Election headings link to the source for every figure in that column.</p><div class="town-lookup__scroll" tabindex="0" role="region" aria-label="Historical results for all New Jersey municipalities"><table><caption>Past election results by municipality and county</caption><thead><tr><th scope="col">Municipality</th>${headers}<th scope="col">${source("turnout", "2024 turnout")}</th></tr></thead><tbody>${rows}</tbody></table></div></details>
    <footer>${data.sourceLine.trim() ? `<p>${escapeHtml(data.sourceLine)}</p>` : ""}<p>Sources: <a href="${escapeHtml(elections.analysisUrl)}">NJ Spotlight News municipal election analysis</a>. Data downloaded ${escapeHtml(elections.downloadedAt)} (UTC).</p></footer>
  </section>`;
}
