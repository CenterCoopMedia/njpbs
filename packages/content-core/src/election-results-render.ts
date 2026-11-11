import { escapeHtml } from "./safe-href.ts";
import { ELECTION_CANDIDATE_DETAILS } from "./election-candidate-details.ts";
import { ELECTION_RACE_STATUSES, electionResultsError, type ElectionCandidate, type ElectionRace, type ElectionResultsData } from "./election-results.ts";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/New_York" });
const time = new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: "America/New_York" });
const unreported = '<span class="election-results__not-reported"><span aria-hidden="true">—</span><span class="election-results__sr-only">Not reported</span></span>';
const percent = (value: number | null) => value === null ? unreported : `${number.format(value)}%`;
const votes = (value: number | null) => value === null ? unreported : number.format(value);

/** Labels supply color meaning. Unlabeled candidates all use the same neutral. */
export function electionPartyTone(party?: string): "neutral" | "democratic" | "republican" {
  const label = party?.trim().toLowerCase();
  if (["d", "democrat", "democratic", "democratic party"].includes(label ?? "")) return "democratic";
  if (["r", "republican", "republican party"].includes(label ?? "")) return "republican";
  return "neutral";
}

function leadingCandidate(race: ElectionRace): string | undefined {
  if (race.status !== "counting" || race.candidates.some(candidate => candidate.votes === null)) return;
  const highest = Math.max(...race.candidates.map(candidate => candidate.votes!));
  const leaders = race.candidates.filter(candidate => candidate.votes === highest);
  return highest > 0 && leaders.length === 1 ? leaders[0].id : undefined;
}

function totalVotes(race: ElectionRace): string {
  if (race.candidates.some(candidate => candidate.votes === null)) return unreported;
  // Individual counts are safe integers; their sum can exceed Number's exact range.
  return number.format(race.candidates.reduce((total, candidate) => total + BigInt(candidate.votes!), 0n));
}

function candidateLink(url: string, label: string, context: string, focusKey: string): string {
  const external = !["njpbs.org", "www.njpbs.org"].includes(new URL(url).hostname);
  return `<a data-election-focus="${escapeHtml(focusKey)}" href="${escapeHtml(url)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(label)}<span class="election-results__sr-only">${escapeHtml(context)}${external ? " (opens in new tab)" : ""}</span>${external ? '<span aria-hidden="true"> ↗</span>' : ""}</a>`;
}

function candidateName(candidate: ElectionCandidate, focusPrefix: string): string {
  const profile = ELECTION_CANDIDATE_DETAILS[candidate.id]?.profileUrl;
  return profile
    ? candidateLink(profile, candidate.name, " — NJ Spotlight News profile", `${focusPrefix}-profile`)
    : escapeHtml(candidate.name);
}

function candidateCampaign(candidate: ElectionCandidate, focusPrefix: string): string {
  const campaign = ELECTION_CANDIDATE_DETAILS[candidate.id]?.campaignWebsite;
  return campaign ? `<div class="election-results__candidate-links">${candidateLink(campaign, "Campaign website", ` for ${candidate.name}`, `${focusPrefix}-campaign`)}</div>` : "";
}

function candidateCard(candidate: ElectionCandidate, race: ElectionRace, leading: string | undefined,
  resolvePhoto?: (candidate: ElectionCandidate) => string): string {
  const called = race.status === "called" && race.calledCandidateId === candidate.id;
  const photo = candidate.photo ? resolvePhoto?.(candidate) ?? "" : "";
  const position = called
    ? '<span class="election-results__winner"><span class="election-results__winner-check" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Winner</span>'
    : candidate.id === leading ? '<span class="election-results__leading">Leading</span>' : "";
  const party = candidate.party?.trim()
    ? `<span class="election-results__party">${escapeHtml(candidate.party.trim())}</span>` : "";
  const incumbent = ELECTION_CANDIDATE_DETAILS[candidate.id]?.incumbent ? '<span class="election-results__incumbent">Incumbent</span>' : "";
  return `<li class="election-results__candidate election-results__candidate--${electionPartyTone(candidate.party)}${photo ? "" : " election-results__candidate--no-photo"}">
    <div class="election-results__identity">${photo ? `<div class="election-results__portrait">${photo}</div>` : ""}<div class="election-results__candidate-copy"><p class="election-results__name">${candidateName(candidate, `${race.id}-${candidate.id}-card`)}</p><div class="election-results__labels">${party}${incumbent}${position}</div>${candidateCampaign(candidate, `${race.id}-${candidate.id}-card`)}${called ? '<p class="election-results__call">AP called this race</p>' : ""}</div></div>
    <div class="election-results__counts"><p class="election-results__votes">${votes(candidate.votes)}${candidate.votes === null ? "" : " votes"}</p><p class="election-results__share${candidate.share === null ? " election-results__share--unknown" : ""}">${percent(candidate.share)}</p></div>
    ${candidate.share === null ? "" : `<div class="election-results__bar" aria-hidden="true"><span style="width:${candidate.share}%"></span></div>`}
  </li>`;
}

function table(race: ElectionRace, leading: string | undefined): string {
  const rows = race.candidates.map(candidate => `<tr><th scope="row">${candidateName(candidate, `${race.id}-${candidate.id}-table`)}${ELECTION_CANDIDATE_DETAILS[candidate.id]?.incumbent ? " (Incumbent)" : ""}${race.status === "called" && race.calledCandidateId === candidate.id ? " (Winner; AP called this race)" : candidate.id === leading ? " (Leading)" : ""}${candidateCampaign(candidate, `${race.id}-${candidate.id}-table`)}</th><td>${escapeHtml(candidate.party?.trim() || "Not specified")}</td><td>${votes(candidate.votes)}</td><td>${percent(candidate.share)}</td></tr>`).join("");
  return `<details class="election-results__details"><summary data-election-focus="${escapeHtml(race.id)}-table-toggle"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none"><rect x="2" y="3" width="16" height="14" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M2 7h16M7 7v10" stroke="currentColor" stroke-width="1.5"/></svg><span>View results as a table</span></summary><div class="election-results__table-scroll" role="region" data-election-focus="${escapeHtml(race.id)}-table-scroll" tabindex="0" aria-label="${escapeHtml(race.office)} ${escapeHtml(race.district)} results table"><table><caption>${escapeHtml(race.office)} · ${escapeHtml(race.district)}. ${ELECTION_RACE_STATUSES[race.status]}.</caption><thead><tr><th scope="col">Candidate</th><th scope="col">Party</th><th scope="col">Votes</th><th scope="col">Share</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function jumpLabel(race: ElectionRace): string {
  if (race.office === "U.S. Senate" && race.district === "New Jersey") return "Senate";
  const district = /^District (\d+)$/.exec(race.district);
  return race.office === "U.S. House" && district ? `CD ${district[1]}` : `${race.office} · ${race.district}`;
}

const DEFAULT_RESULTS_EXPLAINER = `AP calls a race when it determines the trailing candidates cannot catch the leader. A call is not official certification.

Percent reporting shows how many reporting units have sent results, not how many ballots have been counted. Expected vote counted estimates the share of all votes counted. Votes can still be added when all reporting units have reported.

Totals and vote shares can change as more ballots are counted or corrections are made.

Each race lists its source and the source’s update time in Eastern time.`;

function resultsExplainer(): string {
  const text = DEFAULT_RESULTS_EXPLAINER;
  return `<details class="election-results__explainer"><summary>How to read these results</summary><div>${text.split(/\n\s*\n/).map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join("")}</div></details>`;
}

function resultsCsv(data: ElectionResultsData): string {
  const rows: (string | number | null | undefined)[][] = [[
    "Office", "District", "Status", "Candidate", "Party", "Votes", "Share (%)", "Reporting (%)",
    "Expected vote counted (fraction)", "Source", "Source URL", "Source updated (ISO 8601)",
    "AP called winner", "AP call URL",
  ]];
  for (const race of data.races) {
    for (const candidate of race.candidates) rows.push([
      race.office, race.district, ELECTION_RACE_STATUSES[race.status], candidate.name, candidate.party,
      candidate.votes, candidate.share, race.reportingShare, race.expectedVoteShare,
      race.sourceLabel, race.sourceUrl, race.asOf,
      race.status === "called" && race.calledCandidateId === candidate.id ? "Yes" : "", race.apCallUrl,
    ]);
  }
  return "\uFEFF" + rows.map(row => row.map(value => {
    const text = String(value ?? "");
    // CSV quotes preserve delimiters; the apostrophe prevents spreadsheet formulas.
    const safe = /^[\s\u0000-\u001f\u007f-\u009f]*[=+@-]/u.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n") + "\r\n";
}

/** Static HTML works in full builds, fast publication and private saved previews. */
export function renderElectionResults(blockId: string, data: ElectionResultsData, heading = 2,
  resolvePhoto?: (candidate: ElectionCandidate) => string, publicResults = false): string {
  if (electionResultsError(data, true)) return '<p class="election-results__unavailable">Election results are not available.</p>';
  const level = Math.min(6, Math.max(2, heading));
  const raceLevel = Math.min(6, level + 1);
  const panelLevel = Math.min(6, raceLevel + 1);
  const raceAnchor = (race: ElectionRace) => `election-${blockId}-${race.id}`;
  const jumps = `<nav class="election-results__jumps" aria-label="Jump to a race"><p>Jump to a race</p><ul role="list">${data.races.map(race => `<li><a data-election-jump="${escapeHtml(race.id)}" href="#${escapeHtml(raceAnchor(race))}">${escapeHtml(jumpLabel(race))}</a></li>`).join("")}</ul></nav>`;
  const filters = `<div class="election-results__filters" data-election-filters hidden><label>Search races<input type="search" data-election-search-input placeholder="Office, district or candidate" autocomplete="off" /></label><label>Race status<select data-election-status-input><option value="all">All races</option><option value="called">AP called</option><option value="awaiting">Awaiting results</option></select></label><p class="election-results__filter-count" data-election-filter-count role="status" aria-live="polite" aria-atomic="true"></p></div><p class="election-results__no-matches" data-election-no-matches hidden>No races match. Change the search or race status.</p>`;
  const csvHelp = escapeHtml(`election-${blockId}-csv-help`);
  const download = publicResults ? `<div class="election-results__download" data-election-download hidden><button type="button" class="election-results__button" aria-describedby="${csvHelp}">Download CSV</button><p id="${csvHelp}">All races, including those hidden by filters. Unknown values are blank.</p></div>` : "";
  const liveHelp = escapeHtml(`election-${blockId}-live-help`);
  const update = publicResults
    ? `<div class="election-results__live" data-election-live hidden><p class="election-results__refresh" role="status" aria-live="polite" aria-atomic="true" data-election-results-update><span class="election-results__live-dot" data-election-live-dot aria-hidden="true" hidden></span><span data-election-live-text>Checking for updates</span><span data-election-update-time></span></p><button type="button" class="election-results__button" aria-describedby="${liveHelp}">Pause updates</button><p class="election-results__sr-only" id="${liveHelp}">Checks for result updates every minute. Each race shows its source time. Pause applies to all results on this page.</p></div>`
    : '<p class="election-results__refresh election-results__sr-only" role="status" aria-live="polite" aria-atomic="true" data-election-results-update></p>';
  // Character references retain CRLF through HTML parsing. The inert payload moves
  // atomically with its cards/tables, including when a refresh is deferred for focus.
  const csv = publicResults ? `<template data-election-csv>${escapeHtml(resultsCsv(data)).replaceAll("\r", "&#13;")}</template>` : "";
  return `<section class="election-results" data-election-results="${escapeHtml(blockId)}" aria-label="Election results"><h${level} class="election-results__title">Election results</h${level}>${update}${filters}${download}${resultsExplainer()}<div data-election-results-content>${csv}${jumps}${data.races.map(race => {
    const leading = leadingCandidate(race);
    const credits = race.candidates.filter(candidate => candidate.photo?.caption?.trim())
      .map(candidate => `${candidate.name}: ${candidate.photo!.caption!.trim()}`).join("; ");
    const titleId = escapeHtml(raceAnchor(race));
    const counted = race.expectedVoteShare !== undefined
      ? `Est. ${number.format(race.expectedVoteShare * 100)}% of expected vote counted`
      : race.reportingShare === null ? "Reporting share unavailable" : `${number.format(race.reportingShare)}% reporting`;
    const instant = new Date(race.asOf);
    const attribution = race.status === "called" ? `<p class="election-results__ap"><a data-election-focus="${escapeHtml(race.id)}-ap-call" href="${escapeHtml(race.apCallUrl!)}" rel="noopener noreferrer">Race called by The Associated Press</a>. Vote totals can change.</p>` : "";
    const note = race.status === "certified" ? "Certified results from the official source."
      : race.sourceKind === "official" ? "Official-source results only. No projections."
      : race.status === "awaiting" ? "Results will appear here as The Associated Press reports them."
      : "Unofficial vote totals. No race call unless attributed to AP.";
    const search = [race.office, race.district, jumpLabel(race), ...race.candidates.map(candidate => candidate.name)].join(" ");
    return `<article class="election-results__race" data-election-race="${escapeHtml(race.id)}" data-election-status="${race.status}" data-election-search="${escapeHtml(search)}" aria-labelledby="${titleId}">
      <header class="election-results__header"><div><p class="election-results__eyebrow">New Jersey</p><h${raceLevel} id="${titleId}" tabindex="-1">${escapeHtml(race.office)} · ${escapeHtml(race.district)}</h${raceLevel}></div><p class="election-results__status">${ELECTION_RACE_STATUSES[race.status]}</p></header>
      <div class="election-results__body"><aside class="election-results__panel" aria-label="${escapeHtml(race.office)} ${escapeHtml(race.district)} results status"><h${panelLevel}>Results status</h${panelLevel}><div class="election-results__total"><p class="election-results__total-value">${totalVotes(race)}</p><p>Total votes counted</p></div><div class="election-results__updates">${race.status === "awaiting" ? "" : `<p class="election-results__reporting">${escapeHtml(counted)}</p>`}<p class="election-results__as-of"><span class="election-results__updated-wide">Last updated</span><span class="election-results__updated-compact">Updated </span><time datetime="${escapeHtml(race.asOf)}">${escapeHtml(date.format(instant))} · ${escapeHtml(time.format(instant))} ET</time></p></div></aside><div class="election-results__standings"><div class="election-results__columns" aria-hidden="true"><span>Candidate</span><span>Votes</span><span>Share</span></div><ul class="election-results__candidates" role="list">${race.candidates.map(candidate => candidateCard(candidate, race, leading, resolvePhoto)).join("")}</ul></div>
</div>
      ${table(race, leading)}
      <footer class="election-results__footer"><p>Source: <a data-election-focus="${escapeHtml(race.id)}-source" href="${escapeHtml(race.sourceUrl)}" rel="noopener noreferrer">${escapeHtml(race.sourceLabel)}</a></p>${attribution}<p class="election-results__note">${note}</p>${credits ? `<p class="election-results__photo-credits">Photo credits: ${escapeHtml(credits)}</p>` : ""}</footer>
    </article>`;
  }).join("")}</div></section>`;
}
