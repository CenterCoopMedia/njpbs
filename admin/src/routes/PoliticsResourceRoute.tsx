import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useOptionalShell } from "./ShellContext";
import { ElectionsPanel } from "./ElectionsPanel";
import type { GuidePreviewLoader, PoliticsPreviewSource } from "../lib/guide-preview-source";
import {
  displayValue, matchesSearch, normalSearch, parsePoliticsResource, partyCode, partyCounts,
  type PoliticsResource, type ResourceColumn, type ResourcePerson, type ResourceRecord, type ResourceSection,
} from "../lib/politics-resource";
import "./PoliticsResourceRoute.css";

const DATA_PATH = "/guide-content/resources/nj-politics.json";
const PAGE_SIZE = 24;
const GROUPS = [
  { id: "people", label: "People & roles", description: "Bios, responsibilities & contacts", sections: [] },
  { id: "elections", label: "2026 election", description: "Candidates, races & ballot sources", sections: [] },
  { id: "places", label: "Districts & counties", description: "Towns, representation & demographics", sections: ["congressional-districts", "legislative-districts", "district-towns", "county-power-map"] },
  { id: "influence", label: "Influence & finance", description: "Organizations, networks & money", sections: ["influence-network", "campaign-finance"] },
  { id: "sources", label: "Sources & methods", description: "Research notes & complete directories", sections: ["sources-and-methods", "study-index", "age-directory", "governor-and-cabinet", "federal-delegation", "state-senate", "general-assembly"] },
] as const;
const OFFICES = [
  ["governor-and-cabinet", "Governor & cabinet"], ["federal-delegation", "Congress"],
  ["state-senate", "State Senate"], ["general-assembly", "General Assembly"],
  ["county-power-map", "County party chairs"], ["influence-network", "Influence network"],
];
function dateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
function href(params: URLSearchParams, change: Record<string, string | null>): string {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(change)) value ? next.set(key, value) : next.delete(key);
  const query = next.toString();
  return query ? `?${query}` : "/resources/nj-politics";
}
function recordTitle(section: ResourceSection, record: ResourceRecord): string {
  const values = record.values;
  for (const key of ["name", "personOrOrganization", "entityOrPerson", "county", "datasetOrMethod", "nameOrTerm"]) {
    if (values[key]) return String(values[key]);
  }
  if (values.district != null) return `${section.id === "congressional-districts" ? "Congressional district" : section.id === "legislative-districts" ? "Legislative district" : (values.districtType ? `${values.districtType} district` : "District")} ${values.district}`;
  return record.id;
}
function partyLabel(party: string): string {
  const code = partyCode(party);
  return code === "D" ? "Democrat" : code === "R" ? "Republican" : party || "Party not recorded";
}
function PartyBadge({ party }: { party: string }) {
  return <span className={`politics-badge politics-party-${partyCode(party)}`}>{partyLabel(party)}</span>;
}
function StatusBadge({ role }: { role: string }) {
  return /\bformer\b/i.test(role) ? <span className="politics-badge politics-former">Former office</span>
    : /\bacting\b/i.test(role) ? <span className="politics-badge politics-acting">Acting</span> : null;
}
function Balance({ data }: { data: PoliticsResource }) {
  const rows = [
    { section: "federal-delegation", label: "U.S. House", chamber: "U.S. House" },
    { section: "state-senate", label: "State Senate" },
    { section: "general-assembly", label: "General Assembly" },
  ];
  return <details className="politics-balance">
    <summary>Party balance <span>Dated research snapshot · {dateLabel(data.meta.researchAsOf)}</span></summary>
    <div className="politics-balance-grid">
      {rows.map(row => {
        const section = data.sections.find(s => s.id === row.section);
        if (!section) return null;
        const counts = partyCounts(section, row.chamber);
        const total = counts.reduce((n, p) => n + p.count, 0);
        return <figure key={row.section}>
          <figcaption>{row.label} <span>{total} seats</span></figcaption>
          <div className="politics-stacked-bar" aria-hidden="true">{counts.map(p => <span key={p.party} className={`politics-fill-${p.party}`} style={{ width: `${total ? p.count / total * 100 : 0}%` }} />)}</div>
          <p>{counts.map(p => `${p.count} ${p.party === "other" ? "other / unknown" : p.party}`).join(" · ")}</p>
        </figure>;
      })}
    </div>
    <p className="politics-muted">D = Democrat · R = Republican. Counts come from the dated workbook; they are not a live election feed.</p>
  </details>;
}
const FIELD_GROUPS = ["Role & responsibilities", "Background & context", "Place & community", "Contacts", "Age reference", "Sources & verification"];
function fieldGroup(column: ResourceColumn, record: ResourceRecord): string {
  const key = column.key;
  if (["email", "districtOffice", "districtPhone", "contactForm"].includes(key)) return "Contacts";
  if (record.links[key]?.url || /source|checked|verification|censusRelease|accessOrSnapshotDate|limitsAndNotes|limitsOnUse|selectionNote/i.test(key)) return "Sources & verification";
  if (/ageAtSnapshot|ageStatus|ChairAge|AgeStatus|dateOfBirth|birthYear|calculatedAge/.test(key)) return "Age reference";
  if (/region|counties|municipalities|population|median|NonHispanic|hispanicAnyRace|foreignBorn|bachelorsDegreeOrHigher|ownerOccupiedHousing|poverty|Communities|communityType|economicAnchors|constituencyAtAGlance/.test(key)) return "Place & community";
  if (["name", "nameOrTerm", "personOrOrganization", "entityOrPerson", "role", "status", "organization", "formalAuthority", "whyTheRoleMatters", "chamber", "district", "districtType", "party", "partyOrCategory", "leadership", "committees", "currentTerm", "firstElected", "firstServiceYear", "currentRepresentative", "senator", "assemblyMember1", "assemblyMember2", "currentComposition", "senatorParty", "party1", "party2", "county", "democraticChair", "republicanChair", "governmentStructure"].includes(key)) return "Role & responsibilities";
  return "Background & context";
}
function RecordDetails({ section, record, params, data, nested = false }: {
  section: ResourceSection; record: ResourceRecord; params: URLSearchParams; data: PoliticsResource; nested?: boolean;
}) {
  const FieldHeading = nested ? "h4" : "h3";
  const people = new Set([record.personId, ...(record.personIds ?? [])].filter(Boolean));
  const columns = section.columns.filter(c => !["sortName", "recordId"].includes(c.key));
  const hasValue = (column: ResourceColumn) => Boolean(record.links[column.key]?.url || record.links[column.key]?.sectionId) || (record.values[column.key] !== null && record.values[column.key] !== undefined && record.values[column.key] !== "");
  const filled = columns.filter(hasValue), empty = columns.filter(c => !hasValue(c));
  const demographics = columns.filter(c => ["foreignBorn", "bachelorsDegreeOrHigher", "ownerOccupiedHousing", "poverty"].includes(c.key) && typeof record.values[c.key] === "number");
  function fields(items: ResourceColumn[]) {
    return <dl className="politics-fields">{items.map(column => {
      const link = record.links[column.key];
      const internal = link?.sectionId ? data.sections.find(s => s.id === link.sectionId) : undefined;
      const group = internal && GROUPS.find(g => (g.sections as readonly string[]).includes(internal.id));
      return <div key={column.key}>
        <dt>{column.label}</dt>
        <dd>{link?.url ? <a href={link.url} target="_blank" rel="noopener noreferrer" aria-label={`${column.label} (opens in a new tab)`}>{column.label}<span className="sr-only"> (opens in a new tab)</span></a>
          : internal ? <Link to={href(params, { tab: group?.id ?? "sources", section: internal.id, record: link.recordId ?? null, person: null, q: null })}>{link.label}</Link>
          : displayValue(record.values[column.key], column.format)}</dd>
      </div>;
    })}</dl>;
  }
  return <>
    {people.size ? <p className="politics-related">Related people: {data.people.filter(p => people.has(p.id)).map(p => <Link key={p.id} to={href(params, { person: p.id, record: null })}>{p.name}</Link>)}</p> : null}
    {demographics.length ? <details className="politics-demographic-disclosure" open><summary>Demographic snapshot <span>Selected ACS estimates</span></summary><div className="politics-demographics" aria-label="Selected demographic estimates">
      {demographics.map(column => <div key={column.key}>
        <span>{column.label}</span><strong>{displayValue(record.values[column.key], "percent")}</strong>
        <div className="politics-meter" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(1, Number(record.values[column.key]))) * 100}%` }} /></div>
      </div>)}
      <p>Each bar runs from 0% to 100%. ACS estimates; see the release and source below.</p>
    </div></details> : null}
    {FIELD_GROUPS.map(title => {
      const items = filled.filter(column => fieldGroup(column, record) === title);
      return items.length ? <section className="politics-field-group" key={title} aria-label={title}><FieldHeading>{title}</FieldHeading>{fields(items)}</section> : null;
    })}
    {empty.length ? <details className="politics-unfilled"><summary>Unfilled research fields <span>{empty.length} not recorded</span></summary><p className="politics-muted">These fields were blank in the source research. A blank does not establish that something does not exist.</p>{fields(empty)}</details> : null}
  </>;
}
function Profile({ person, data, params }: { person: ResourcePerson; data: PoliticsResource; params: URLSearchParams }) {
  const groups = data.sections.map(section => ({ section, records: person.records.filter(r => r.sectionId === section.id).flatMap(ref => section.records.filter(r => r.id === ref.recordId)) })).filter(g => g.records.length);
  const primary = groups.find(g => !["study-index", "age-directory", "campaign-finance"].includes(g.section.id))?.records[0];
  const values = primary?.values ?? {};
  const district = values.district;
  const facts = [
    { label: "Party", value: partyLabel(person.party) },
    { label: "District", value: district },
    { label: "Organization", value: values.organization },
    { label: "Current term", value: values.currentTerm },
    { label: "Role checked", value: typeof values.roleChecked === "string" ? dateLabel(values.roleChecked) : null },
  ].filter(f => f.value !== null && f.value !== undefined && f.value !== "");
  return <article className="politics-detail">
    <Link className="politics-back" to={href(params, { person: null })}>← Back to results</Link>
    <header><div className="politics-badges"><StatusBadge role={person.role} /></div>
      <h2>{person.name}</h2><p className="politics-role">{person.role}</p>
    </header>
    <section className="politics-glance" aria-label="Profile at a glance"><h3>At a glance</h3><p>{person.summary}</p>
      <dl>{facts.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{String(f.value)}</dd></div>)}</dl>
    </section>
    <div className="politics-record-heading"><h3>Research & sources</h3><p className="politics-muted">Open a collection for the complete record. Ages reflect {dateLabel(data.meta.asOf)}.</p></div>
    {groups.map(({ section, records }, i) => <details key={section.id} className="politics-record-group" open={i === 0}>
      <summary>{section.title} <span>{records.length} {records.length === 1 ? "record" : "records"}</span></summary>
      {records.map(record => <section key={record.id} className="politics-record-detail" aria-label={recordTitle(section, record)}>
        {records.length > 1 ? <h3>{recordTitle(section, record)}</h3> : null}
        {section.id === "campaign-finance" ? <p className="politics-caution">Compare amounts only when period, jurisdiction and measurement type match.</p> : null}
        <RecordDetails section={section} record={record} data={data} params={params} nested />
      </section>)}
    </details>)}
  </article>;
}

/** The CMS transport requires staff admission; a protected preview can supply its own loader. */
export function PoliticsResourceRoute({ previewSource }: { previewSource?: PoliticsPreviewSource } = {}) {
  const shell = useOptionalShell();
  const uid = shell?.user.uid;
  const getIdToken = shell?.getIdToken;
  const loadPreview = previewSource?.politics;
  const [params, setParams] = useSearchParams();
  const [loaded, setLoaded] = useState<{ uid: string | undefined; source: GuidePreviewLoader | undefined; data: PoliticsResource } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const detailRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const previousDetail = useRef(false);
  const data = loaded && loaded.uid === uid && loaded.source === loadPreview ? loaded.data : null;
  const group = GROUPS.find(g => g.id === params.get("tab")) ?? GROUPS[0];
  const electionView = group.id === "elections";
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(current => current && (current.uid !== uid || current.source !== loadPreview) ? null : current);
    setError(false);
    if (electionView || data) return () => controller.abort();
    void (async () => {
      try {
        let value: unknown;
        if (loadPreview) value = await loadPreview(controller.signal);
        else {
          if (!uid || !getIdToken) throw new Error("No staff session");
          const token = await getIdToken();
          if (controller.signal.aborted) return;
          const response = await fetch(DATA_PATH, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("Resource unavailable");
          value = await response.json();
        }
        if (controller.signal.aborted) return;
        const parsed = parsePoliticsResource(value);
        setLoaded({ uid, source: loadPreview, data: parsed });
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => controller.abort();
  }, [getIdToken, uid, loadPreview, attempt, electionView, data]);
  const query = (params.get("q") ?? "").slice(0, 180);
  const party = params.get("party") ?? "";
  const office = params.get("office") ?? "";
  const personId = params.get("person");
  const recordId = params.get("record");
  const sections = data?.sections.filter(s => (group.sections as readonly string[]).includes(s.id)) ?? [];
  const selectedSection = sections.find(s => s.id === params.get("section")) ?? sections[0];
  const personIndex = useMemo(() => {
    if (!data) return [];
    const records = new Map(data.sections.flatMap(s => s.records.map(r => [`${s.id}:${r.id}`, r] as const)));
    return data.people.map(person => ({ person, text: normalSearch([person.name, person.sortName, person.party, person.role, person.summary, ...person.records.map(ref => Object.values(records.get(`${ref.sectionId}:${ref.recordId}`)?.values ?? {}).join(" "))].join(" ")) }));
  }, [data]);
  const people = useMemo(() => personIndex.filter(({ person, text }) => (!party || partyCode(person.party) === party) && (!office || person.records.some(r => r.sectionId === office)) && matchesSearch(text, query)).map(p => p.person).sort((a, b) => Number(matchesSearch(normalSearch(`${b.name} ${b.sortName}`), query)) - Number(matchesSearch(normalSearch(`${a.name} ${a.sortName}`), query)) || a.sortName.localeCompare(b.sortName)), [personIndex, query, party, office]);
  const records = useMemo(() => (selectedSection?.records ?? []).filter(r => matchesSearch(normalSearch(Object.values(r.values).join(" ")), query)), [selectedSection, query]);
  const signature = `${query}:${party}:${office}:${group.id}:${selectedSection?.id}`;
  useEffect(() => { setVisible(PAGE_SIZE); }, [signature]);
  useEffect(() => {
    const hasDetail = Boolean(personId || recordId);
    if (hasDetail) detailRef.current?.focus();
    else if (previousDetail.current) searchRef.current?.focus();
    previousDetail.current = hasDetail;
  }, [personId, recordId, data]);
  function changeFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    next.delete("person"); next.delete("record");
    setParams(next, { replace: true });
  }
  function clearFilters() {
    const next = new URLSearchParams(params);
    for (const key of ["q", "party", "office", "section"]) next.delete(key);
    setParams(next, { replace: true });
    searchRef.current?.focus();
  }
  const navigation = <>
      <header className="politics-intro"><div><h2>Resources</h2><p>A newsroom guide to people, places and elections. Find a name, get the context, check the source.</p></div><span className="politics-badge">Staff resource</span></header>
      <nav className="politics-tabs" aria-label="Politics reference sections">{GROUPS.map(g => <Link key={g.id} aria-label={g.label} aria-description={g.description} aria-current={group.id === g.id ? "page" : undefined} to={href(params, { tab: g.id, section: null, q: null, party: null, office: null })}><strong>{g.label}</strong><span>{g.description}</span></Link>)}</nav>
  </>;
  if (electionView) return <div className="politics-resource">{navigation}<ElectionsPanel previewSource={previewSource?.elections} /></div>;
  if (error) return <div className="politics-resource">{navigation}<section className="politics-empty" role="alert"><h2>Politics resource unavailable</h2><p>We couldn’t load the staff resource. Please try again.</p><button type="button" onClick={() => setAttempt(n => n + 1)}>Try again</button></section></div>;
  if (!data) return <div className="politics-resource">{navigation}<p className="politics-loading" role="status">Loading the politics resource…</p></div>;
  const person = data.people.find(p => p.id === personId);
  const record = selectedSection?.records.find(r => r.id === recordId);
  const resultCount = group.id === "people" ? people.length : records.length;
  const activeFilters = [
    ...(query ? [{ key: "q", label: `Search: ${query}` }] : []),
    ...(group.id === "people" && office ? [{ key: "office", label: OFFICES.find(([id]) => id === office)?.[1] ?? office }] : []),
    ...(group.id === "people" && party ? [{ key: "party", label: party === "other" ? "Other / not recorded" : partyLabel(party) }] : []),
    ...(group.id !== "people" && selectedSection && params.has("section") ? [{ key: "section", label: selectedSection.title }] : []),
  ];
  return <div className="politics-resource">
    {personId || recordId ? <section ref={detailRef} tabIndex={-1} aria-label="Selected reference">
      {personId && person ? <Profile person={person} data={data} params={params} />
        : record && selectedSection ? <article className="politics-detail"><Link className="politics-back" to={href(params, { record: null })}>← Back to results</Link><header><p className="politics-eyebrow">{selectedSection.title}</p><h2>{recordTitle(selectedSection, record)}</h2></header>{selectedSection.id === "campaign-finance" ? <p className="politics-caution">Compare amounts only when period, jurisdiction and measurement type match.</p> : null}<RecordDetails section={selectedSection} record={record} data={data} params={params} /></article>
        : <div className="politics-empty"><h2>Reference not found</h2><p>This link doesn’t match a record in this edition.</p><Link to={href(params, { person: null, record: null })}>Back to results</Link></div>}
    </section> : <>
      {navigation}
      <>
        <section className="politics-search-panel" aria-label={`Search ${group.label.toLowerCase()}`}>
          <div className="politics-filters">
            <label className="politics-search">{group.id === "people" ? "Search people, places or roles" : "Search this collection"}<input ref={searchRef} type="search" maxLength={180} value={query} onChange={e => changeFilter("q", e.target.value)} placeholder={group.id === "people" ? "Try Emehelu, Newark or District 35" : "Enter a name, place or keyword"} aria-describedby="politics-search-help" /></label>
            {group.id === "people" ? <>
              <label>Office or role<select value={office} onChange={e => changeFilter("office", e.target.value)}><option value="">All roles</option>{OFFICES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
              <label>Party<select value={party} onChange={e => changeFilter("party", e.target.value)}><option value="">All parties</option><option value="D">Democrat</option><option value="R">Republican</option><option value="other">Other / not recorded</option></select></label>
            </> : <label>Collection<select value={selectedSection?.id ?? ""} onChange={e => changeFilter("section", e.target.value)}>{sections.map(s => <option value={s.id} key={s.id}>{s.title}</option>)}</select></label>}
          </div>
          <p id="politics-search-help" className="politics-search-help">{group.id === "people" ? "Search names and the full research, including towns, districts and background." : selectedSection?.description || group.description} Results update as you type.</p>
          {activeFilters.length ? <div className="politics-active-filters" aria-label="Active filters"><span>Filtered by</span>{activeFilters.map(filter => <button type="button" key={filter.key} aria-label={`Remove filter: ${filter.label}`} onClick={() => { changeFilter(filter.key, ""); searchRef.current?.focus(); }}>{filter.label}<span aria-hidden="true"> ×</span></button>)}<button type="button" className="politics-reset" onClick={clearFilters}>Reset all</button></div> : null}
        </section>
        {group.id === "sources" ? <details className="politics-methods"><summary>Research dates, methods and limits</summary><ul>{data.meta.notes.map(note => <li key={note}>{note}</li>)}</ul><p>Source workbook: {data.meta.sourceWorkbook}</p></details> : null}
        {group.id === "influence" ? <p className="politics-caution">The influence list is a selected reference, not a ranking. Finance records use different periods and measurement types; compare matching definitions.</p> : null}
        <div className="politics-result-header"><p role="status" aria-live="polite">{resultCount} {group.id === "people" ? (resultCount === 1 ? "person" : "people") : (resultCount === 1 ? "record" : "records")}{query ? ` matching “${query}”` : ""}</p><span>{group.id === "people" ? (query ? "Name matches first" : "A–Z by last name") : selectedSection?.title}</span></div>
        {resultCount === 0 ? <div className="politics-empty"><h3>No matches found</h3><p>Try fewer words, a different spelling, or remove a filter.</p><button type="button" onClick={clearFilters}>Reset all filters</button></div> : <ul className="politics-results">
          {group.id === "people" ? people.slice(0, visible).map(p => <li key={p.id}><article className="politics-card">
            <div className="politics-card-heading"><h3><Link to={href(params, { person: p.id })} aria-label={`View profile: ${p.name}`}>{p.name}<span aria-hidden="true"> →</span></Link></h3><StatusBadge role={p.role} /></div><p className="politics-role">{p.role}</p><div className="politics-badges"><PartyBadge party={p.party} /></div><p className="politics-excerpt">{p.summary}</p>
          </article></li>) : selectedSection && records.slice(0, visible).map(r => <li key={r.id}><article className="politics-card"><h3><Link to={href(params, { section: selectedSection.id, record: r.id })} aria-label={`View record: ${recordTitle(selectedSection, r)}`}>{recordTitle(selectedSection, r)}<span aria-hidden="true"> →</span></Link></h3>
            <p className="politics-excerpt">{[r.values.constituencyAtAGlance, r.values.atAGlance, r.values.quickBio, r.values.roleOrContext, r.values.useOrDefinition, r.values.region, r.values.context].find(v => typeof v === "string" && v) ?? "Open for the complete record and sources."}</p>
            {selectedSection.id === "campaign-finance" ? <p className="politics-finance"><strong>{displayValue(r.values.amount, "currency")}</strong><span>{String(r.values.measurementType ?? "")} · {String(r.values.period ?? "")} · {String(r.values.jurisdiction ?? "")}</span></p> : null}
          </article></li>)}
        </ul>}
        {visible < resultCount ? <div className="politics-more"><p>Showing {Math.min(visible, resultCount)} of {resultCount}</p><button type="button" onClick={() => setVisible(n => n + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, resultCount - visible)} more</button></div> : null}
        {group.id === "people" ? <Balance data={data} /> : null}
      </>
    </>}
    <footer className="politics-footer"><p>Verify time-sensitive details against the linked sources before use.</p><div className="politics-dateline"><span>Base research: {dateLabel(data.meta.researchAsOf)}</span><span>Executive update: {dateLabel(data.meta.lastTargetedUpdate)}</span></div></footer>
  </div>;
}
