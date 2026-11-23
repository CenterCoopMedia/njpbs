import { escapeHtml } from "./safe-href.ts";

type Counts = [number, number, number];
type Turnout = [number, number];
type SourcePair = [string | null, string | null];
export type TrendCounts = [Counts | null, Turnout | null, SourcePair?][];
export type TrendSources = SourcePair[];

const elections = ["President", "Governor", null, null, "President", "Governor", null, null, "President", "Governor"] as const;
const firstYear = 2016;
const sourceBase = "https://www.nj.gov/state/elections/assets/pdf/election-results";
export const voteShare = (count: number, total: number) => total > 0 ? 100 * count / total : null;
export const percent = (value: number | null) => value === null ? "Unavailable" : `${value.toFixed(1)}%`;

type Point = { year: number; value: number | null };
type Series = { style: string; points: Point[] };

function chart(title: string, years: readonly number[], series: Series[]): string {
  const x = (year: number) => 39 + 28 * (year - firstYear);
  const y = (value: number) => 119 - value;
  const grid = [0, 25, 50, 75, 100].map(value =>
    `<line x1="39" x2="291" y1="${y(value)}" y2="${y(value)}" /><text x="32" y="${y(value) + 4}" text-anchor="end">${value}%</text>`).join("");
  const labels = years.map(year => `<text x="${x(year)}" y="140" text-anchor="middle">${year}</text>`).join("");
  const marks = series.map(({ style, points }) => {
    // Missing values start a new path. A real zero still gets a point at the baseline.
    let connected = false;
    const dots: string[] = [];
    const path = points.map(({ year, value }) => {
      if (value === null) {
        connected = false;
        return "";
      }
      const point = connected ? "L" : "M";
      connected = true;
      dots.push(style === "republican"
        ? `<rect x="${x(year) - 3}" y="${y(value) - 3}" width="6" height="6" />`
        : `<circle cx="${x(year)}" cy="${y(value)}" r="3" />`);
      return `${point}${x(year)},${y(value)}`;
    }).join(" ");
    return `<g class="town-trends__${style}"><path d="${path}" />${dots.join("")}</g>`;
  }).join("");
  return `<figure aria-hidden="true"><figcaption>${title}</figcaption><svg viewBox="0 0 315 150" focusable="false">${grid}${labels}${marks}</svg></figure>`;
}

function sourceLink(year: number, file: string | null, label: string): string {
  if (!file) return "";
  const href = file.startsWith("https://") ? file : `${sourceBase}/${year}/${encodeURIComponent(file)}`;
  return `<a href="${escapeHtml(href)}" aria-label="${year} ${label.toLowerCase()} (PDF)">${label}</a>`;
}

export function renderTownTrendFallbackCells(counts: TrendCounts): string {
  const governor = elections.flatMap((office, index) => {
    if (office !== "Governor") return [];
    const year = firstYear + index;
    const [race, , countySources] = counts[index];
    const value = race ? `D ${percent(voteShare(race[0], race[2]))} / R ${percent(voteShare(race[1], race[2]))}` : "Unavailable";
    return [`${year}: ${value}${countySources?.[0] ? ` ${sourceLink(year, countySources[0], "Results")}` : ""}`];
  });
  const turnout = counts.flatMap(([, turnoutCounts, countySources], index) => {
    const year = firstYear + index;
    if (year === 2024) return []; // The existing 2024 column includes its counts.
    const value = percent(turnoutCounts ? voteShare(turnoutCounts[1], turnoutCounts[0]) : null);
    return [`${year}: ${value}${countySources?.[1] ? ` ${sourceLink(year, countySources[1], "Turnout")}` : ""}`];
  });
  return `<td>${governor.join("<br>")}</td><td>${turnout.join("<br>")}</td>`;
}

export function renderTownElectionTrends(label: string, id: string, counts: TrendCounts, sources: TrendSources): string {
  const periods = elections.map((office, index) => {
    const [race, turnout, countySources] = counts[index];
    const [raceSource, turnoutSource] = sources[index];
    return {
      year: firstYear + index,
      office,
      dem: race ? voteShare(race[0], race[2]) : null,
      rep: race ? voteShare(race[1], race[2]) : null,
      turnout: turnout ? voteShare(turnout[1], turnout[0]) : null,
      raceSource: race ? countySources?.[0] ?? raceSource : null,
      turnoutSource: turnout ? countySources?.[1] ?? turnoutSource : null,
    };
  });
  const voteCharts = (["President", "Governor"] as const).map(office => {
    const selected = periods.filter(period => period.office === office);
    return chart(`${office} vote share`, selected.map(({ year }) => year), [
      { style: "democratic", points: selected.map(({ year, dem }) => ({ year, value: dem })) },
      { style: "republican", points: selected.map(({ year, rep }) => ({ year, value: rep })) },
    ]);
  }).join("");
  const turnoutChart = chart("General election turnout", [2016, 2019, 2022, 2025], [
    { style: "turnout", points: periods.map(({ year, turnout }) => ({ year, value: turnout })) },
  ]);
  const rows = periods.map(({ year, office, dem, rep, turnout, raceSource, turnoutSource }) => {
    const links = [sourceLink(year, raceSource, "Results"), sourceLink(year, turnoutSource, "Turnout")].filter(Boolean);
    const voteCells = office ? `<td>${percent(dem)}</td><td>${percent(rep)}</td>` : '<td colspan="2">No presidential or governor race</td>';
    return `<tr><th scope="row">${year}${office ? `<span>${office}</span>` : ""}</th>${voteCells}<td>${percent(turnout)}</td><td>${links.join(" ") || "Unavailable"}</td></tr>`;
  }).join("");

  return `<p class="town-trends__legend" aria-hidden="true"><span class="town-trends__democratic">Democratic</span><span class="town-trends__republican">Republican</span></p>
    <div class="town-trends__charts">${voteCharts}${turnoutChart}</div>
    <p class="town-lookup__method">Vote share uses all votes listed for candidates in the municipality, including other parties. Turnout is ballots cast divided by registered voters in the general election. Source links go to official state or county reports (PDFs).</p>
    ${periods.some(({ office, dem, turnout }) => (office && dem === null) || turnout === null) ? '<p class="town-lookup__method">Unavailable values could not be verified from the published returns.</p>' : ""}
    ${id === "0428" ? '<p class="town-lookup__method">Pine Valley joined Pine Hill in 2022. Figures through 2021 combine the two former boroughs.</p>' : ""}
    <table><caption>${escapeHtml(label)} general election results</caption><thead><tr><th scope="col">Election</th><th scope="col">Democratic</th><th scope="col">Republican</th><th scope="col">Turnout</th><th scope="col">Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}
