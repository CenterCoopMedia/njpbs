import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useOptionalShell } from "./ShellContext";
import type { GuidePreviewLoader } from "../lib/guide-preview-source";
import { ELECTION_LEVELS, candidateBallotLabel, filterCandidates, groupRaces, parseElectionDirectory, type ElectionDirectory } from "../lib/election-directory";
import "./ElectionsPanel.css";
const DATA_PATH = "/guide-content/resources/nj-election-2026.json";
const PAGE_SIZE = 20;
function dateLabel(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : value; }
export function ElectionsPanel({ previewSource }: { previewSource?: GuidePreviewLoader } = {}) {
  const shell = useOptionalShell();
  const uid = shell?.user.uid;
  const getIdToken = shell?.getIdToken;
  const [params, setParams] = useSearchParams();
  const [loaded, setLoaded] = useState<{ uid: string | undefined; source: GuidePreviewLoader | undefined; data: ElectionDirectory } | null>(null);
  const [failed, setFailed] = useState(false); const [attempt, setAttempt] = useState(0); const [visible, setVisible] = useState(PAGE_SIZE);
  const data = loaded && loaded.uid === uid && loaded.source === previewSource ? loaded.data : null;
  useEffect(() => {
    const controller = new AbortController(); setLoaded(null); setFailed(false);
    void (async () => {
      try {
        let value: unknown;
        if (previewSource) value = await previewSource(controller.signal);
        else {
          if (!uid || !getIdToken) throw new Error("No staff session");
          const token = await getIdToken();
          if (controller.signal.aborted) return;
          const response = await fetch(DATA_PATH, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("Directory unavailable");
          value = await response.json();
        }
        if (controller.signal.aborted) return;
        const result = parseElectionDirectory(value);
        setLoaded({ uid, source: previewSource, data: result });
      } catch { if (!controller.signal.aborted) setFailed(true); }
    })();
    return () => controller.abort();
  }, [getIdToken, uid, previewSource, attempt]);
  const query = (params.get("eq") ?? "").slice(0, 180), county = params.get("county") ?? "", level = params.get("level") ?? "", party = params.get("eparty") ?? "";
  const sourcesView = params.get("eview") === "sources";
  const candidates = useMemo(() => data ? filterCandidates(data, { query, county, level, party }) : [], [data, query, county, level, party]);
  const races = useMemo(() => groupRaces(candidates), [candidates]);
  useEffect(() => setVisible(PAGE_SIZE), [query, county, level, party]);
  function update(key: string, value: string) { const next = new URLSearchParams(params); value ? next.set(key, value) : next.delete(key); setParams(next, { replace: key !== "eview" }); }
  function clear() { const next = new URLSearchParams(params); for (const key of ["eq", "county", "level", "eparty"]) next.delete(key); setParams(next, { replace: true }); }
  if (failed) return <div className="politics-empty" role="alert"><h3>Election directory unavailable</h3><p>The rest of the guide is still available. Try loading the candidate lists again.</p><button onClick={() => setAttempt(n => n + 1)}>Try again</button></div>;
  if (!data) return <p role="status">Loading the 2026 election directory…</p>;
  const countyCoverage = data.coverage.filter(c => c.jurisdiction !== "Statewide");
  const gaps = countyCoverage.filter(c => c.status !== "complete");
  const parties = [...new Set(data.candidates.map(c => c.party).filter((p): p is string => Boolean(p)))].sort();
  return <section className="election-panel" aria-label="2026 general-election candidates">
    <header className="election-heading"><div><p className="politics-eyebrow">November 3, 2026</p><h3>Who’s on the ballot?</h3><p>Browse published candidate lists by race, place or name.</p></div><span className="politics-badge">Sources checked {dateLabel(data.checkedAt)}</span></header>
    <div className="election-coverage-note"><strong>{data.candidates.length.toLocaleString()} candidate entries</strong><span>{gaps.length ? `Coverage gaps remain in ${gaps.length} counties.` : "All county coverage is accounted for."} Entries reflect linked rosters, not live ballot certification. {data.coverage.find(c => c.jurisdiction === "Statewide")?.status !== "complete" ? "State-office coverage also remains unverified; see source notes." : ""}</span><button type="button" onClick={() => update("eview", sourcesView ? "" : "sources")}>{sourcesView ? "Back to candidates" : "Review coverage & sources"}</button></div>
    {sourcesView ? <div className="election-sources"><p className="politics-muted">{data.note}</p><p>“Complete” means the reviewed source covers the requested ballot levels. “Partial” means some records are included but a list, update or race remains unresolved. “Unavailable” means no usable roster was obtained. Candidate totals count race entries, not unique people.</p>
      {data.coverage.map(c => <details key={c.jurisdiction}><summary>{c.jurisdiction}<span className={`politics-badge election-status-${c.status}`}>{c.status === "complete" ? "Roster imported" : c.status === "partial" ? "Partial coverage" : "Roster unavailable"}</span></summary><p>{c.notes}</p><ul>{c.sourceIds.map(id => { const s = data.sources.find(s => s.id === id)!; return <li key={id}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<span className="sr-only"> (opens in a new tab)</span></a><p className="politics-muted">{s.sourceDate ? `Source date: ${dateLabel(s.sourceDate)} · ` : "Source date not stated · "}Checked {dateLabel(s.checkedAt)}</p>{s.notes ? <p>{s.notes}</p> : null}</li>; })}</ul></details>)}
    </div> : <>
      <div className="election-filters"><label className="politics-search">Search candidates or places<input type="search" maxLength={180} value={query} onChange={e => update("eq", e.target.value)} placeholder="Try a candidate, town or district" /></label><label>County<select value={county} onChange={e => update("county", e.target.value)}><option value="">All counties</option>{countyCoverage.map(c => <option key={c.jurisdiction}>{c.jurisdiction}</option>)}</select></label><label>Ballot level<select value={level} onChange={e => update("level", e.target.value)}><option value="">All ballot levels</option>{ELECTION_LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label><label>Party as listed<select value={party} onChange={e => update("eparty", e.target.value)}><option value="">All parties</option>{parties.map(p => <option key={p}>{p}</option>)}<option value="unlisted">Party not listed</option></select></label></div>
      <div className="politics-result-header"><p role="status" aria-live="polite">{candidates.length.toLocaleString()} matching candidate {candidates.length === 1 ? "entry" : "entries"} · {races.length.toLocaleString()} {races.length === 1 ? "race" : "races"}</p>{query || county || level || party ? <button type="button" className="election-clear" onClick={clear}>Clear election filters</button> : <span>Alphabetical within each race</span>}</div>
      {county && data.coverage.find(c => c.jurisdiction === county)?.status !== "complete" ? <p className="politics-caution">{county} has incomplete local coverage. Federal candidates may still appear. <button type="button" className="election-text-button" onClick={() => update("eview", "sources")}>See what’s missing</button></p> : null}
      {races.length ? <div className="election-races">{races.slice(0, visible).map(r => <article key={r.id} className="election-race"><header><span className="politics-eyebrow">{ELECTION_LEVELS.find(l => l.value === r.level)?.label}</span><h4>{r.office}</h4><p>{r.area}</p>{r.term || r.seats ? <p className="politics-muted">{[r.term, r.seats ? `Seats: ${r.seats}` : null].filter(Boolean).join(" · ")}</p> : null}</header><ul>{r.candidates.map(c => <li key={c.id}><div><strong>{c.name}</strong>{data.sources.find(s => s.id === c.sourceId)?.status === "provisional" ? <span className="politics-badge election-status-partial">Provisional list</span> : null}{candidateBallotLabel(c, county) && candidateBallotLabel(c, county)?.trim().toLocaleLowerCase() !== c.party?.trim().toLocaleLowerCase() ? <span className="election-ballot-label">{candidateBallotLabel(c, county)}</span> : null}{new Set(Object.values(c.ballotLabelsByCounty)).size > 1 ? <details className="election-labels"><summary>Ballot labels by county</summary><dl>{Object.entries(c.ballotLabelsByCounty).map(([area, label]) => <div key={area}><dt>{area}</dt><dd>{label}</dd></div>)}</dl></details> : null}</div><span className="election-party">{c.party ?? "Party not listed"}</span><a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`Official source for ${c.name} (opens in a new tab)`}>Source ↗</a></li>)}</ul></article>)}</div> : <div className="politics-empty"><h3>No matching entries</h3><p>This is not proof that a race has no candidates. Clear filters or check the coverage notes.</p><button type="button" onClick={clear}>Clear election filters</button></div>}
      {visible < races.length ? <div className="politics-more"><p>Showing {Math.min(visible, races.length)} of {races.length} races</p><button onClick={() => setVisible(n => n + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, races.length - visible)} more races</button></div> : null}
      <p className="election-footnote">Party and ballot labels follow the source; an unlisted party is not an inferred affiliation. Unnamed vacancies and write-in slots are not candidate entries. Current-officeholder research is separate in <Link to="?tab=people">People & roles</Link>.</p>
    </>}
  </section>;
}
