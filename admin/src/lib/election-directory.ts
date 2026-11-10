import { normalSearch, safeSourceUrl } from "./politics-resource";
export type ElectionLevel = "federal" | "state" | "county" | "municipal" | "school";
export const NJ_COUNTIES = ["Atlantic", "Bergen", "Burlington", "Camden", "Cape May", "Cumberland", "Essex", "Gloucester", "Hudson", "Hunterdon", "Mercer", "Middlesex", "Monmouth", "Morris", "Ocean", "Passaic", "Salem", "Somerset", "Sussex", "Union", "Warren"] as const;
export type CoverageStatus = "complete" | "partial" | "unavailable";
export interface ElectionSource { id: string; jurisdiction: string; title: string; url: string; sourceDate: string | null; checkedAt: string; status: string; notes: string; }
export interface ElectionCandidate { id: string; name: string; office: string; level: ElectionLevel; county: string | null; counties: string[]; municipality: string | null; district: string | null; party: string | null; ballotLabel: string | null; ballotLabelsByCounty: Record<string, string>; term: string | null; seats: string | null; electionDate: "2026-11-03"; sourceId: string; sourceUrl: string; }
export interface ElectionCoverage { jurisdiction: string; status: CoverageStatus; notes: string; sourceIds: string[]; }
export interface ElectionDirectory { schemaVersion: 1; electionDate: "2026-11-03"; checkedAt: string; note: string; sources: ElectionSource[]; candidates: ElectionCandidate[]; coverage: ElectionCoverage[]; }
export const ELECTION_LEVELS: { value: ElectionLevel; label: string }[] = [{ value: "federal", label: "Federal" }, { value: "state", label: "State" }, { value: "county", label: "County" }, { value: "municipal", label: "Municipal & fire district" }, { value: "school", label: "School board" }];
const invalid = () => { throw new Error("The election directory could not be read."); };
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) return invalid(); return v as Record<string, unknown>; }
function text(v: unknown, max = 2000): string { return typeof v === "string" && v.length <= max ? v : invalid(); }
function required(v: unknown, max = 200): string { const s = text(v, max); return s.trim() ? s : invalid(); }
function nullable(v: unknown): string | null { return v == null ? null : text(v, 500); }
function list(v: unknown, max: number): unknown[] { return Array.isArray(v) && v.length <= max ? v : invalid(); }
function day(v: unknown): string { const s = text(v, 10); return /^2026-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : invalid(); }
function url(v: unknown): string { const s = required(v, 2000); return safeSourceUrl(s)?.startsWith("https://") ? s : invalid(); }
function unique(values: string[]) { if (new Set(values).size !== values.length) invalid(); }
/** Project reviewed ballot facts only; the private JSON is fetched after staff admission. */
export function parseElectionDirectory(value: unknown): ElectionDirectory {
  const root = obj(value);
  if (root.schemaVersion !== 1 || root.electionDate !== "2026-11-03") invalid();
  const sources = list(root.sources, 1000).map(v => { const s = obj(v); return { id: required(s.id), jurisdiction: required(s.jurisdiction), title: required(s.title, 500), url: url(s.url), sourceDate: nullable(s.sourceDate), checkedAt: day(s.checkedAt), status: required(s.status), notes: text(s.notes) }; });
  unique(sources.map(s => s.id)); const sourceById = new Map(sources.map(s => [s.id, s]));
  const candidates = list(root.candidates, 20000).map(v => {
    const c = obj(v); const level = c.level as ElectionLevel;
    if (!ELECTION_LEVELS.some(l => l.value === level) || c.electionDate !== "2026-11-03") invalid();
    const sourceId = required(c.sourceId); const source = sourceById.get(sourceId); if (!source) invalid();
    const sourceUrl = url(c.sourceUrl); const documentUrl = new URL(sourceUrl); documentUrl.hash = ""; const expectedUrl = new URL(source!.url); expectedUrl.hash = ""; if (documentUrl.href !== expectedUrl.href) invalid();
    const county = nullable(c.county); if (!["federal", "state"].includes(level) && !county) invalid();
    const labels = Object.fromEntries(Object.entries(obj(c.ballotLabelsByCounty ?? {})).map(([k, v]) => [required(k), text(v, 500)]));
    return { id: required(c.id), name: required(c.name), office: required(c.office, 300), level, county, counties: list(c.counties ?? [], 21).map(v => required(v)), municipality: nullable(c.municipality), district: nullable(c.district), party: nullable(c.party), ballotLabel: nullable(c.ballotLabel), ballotLabelsByCounty: labels, term: nullable(c.term), seats: nullable(c.seats), electionDate: "2026-11-03" as const, sourceId, sourceUrl };
  });
  unique(candidates.map(c => c.id));
  const coverage = list(root.coverage, 30).map(v => { const c = obj(v); if (!["complete", "partial", "unavailable"].includes(String(c.status))) invalid(); const sourceIds = list(c.sourceIds, 100).map(v => required(v)); if (sourceIds.some(id => !sourceById.has(id))) invalid(); return { jurisdiction: required(c.jurisdiction), status: c.status as CoverageStatus, notes: text(c.notes, 5000), sourceIds }; });
  unique(coverage.map(c => c.jurisdiction));
  if (coverage.length !== 22 || [...NJ_COUNTIES, "Statewide"].some(county => !coverage.some(c => c.jurisdiction === county))) invalid();
  return { schemaVersion: 1, electionDate: "2026-11-03", checkedAt: day(root.checkedAt), note: text(root.note, 5000), sources, candidates, coverage };
}
export interface ElectionFilters { query: string; county: string; level: string; party: string; }
export function filterCandidates(data: ElectionDirectory, filters: ElectionFilters): ElectionCandidate[] {
  const terms = normalSearch(filters.query).split(/\s+/).filter(Boolean);
  return data.candidates.filter(c => (!filters.county || c.county === filters.county || c.counties.includes(filters.county) || (c.level === "federal" && c.office === "U.S. Senate")) && (!filters.level || c.level === filters.level) && (!filters.party || (filters.party === "unlisted" ? !c.party : c.party === filters.party)) && terms.every(t => normalSearch([c.name, c.office, c.county, ...c.counties, c.municipality, c.district, c.party, c.ballotLabel, ...Object.values(c.ballotLabelsByCounty), c.term].filter(Boolean).join(" ")).includes(t)));
}
export interface ElectionRace { id: string; office: string; area: string; level: ElectionLevel; term: string | null; seats: string | null; candidates: ElectionCandidate[]; }
export function groupRaces(candidates: ElectionCandidate[]): ElectionRace[] {
  const races = new Map<string, ElectionRace>();
  for (const c of candidates) {
    const key = [c.level, c.county, c.municipality, c.district, c.office, c.term].map(v => normalSearch(v ?? "")).join("|");
    if (!races.has(key)) races.set(key, { id: key, office: c.office, area: [...new Set([c.municipality, c.district && c.district !== c.municipality ? (/^\d+$/.test(c.district) ? `District ${c.district}` : c.district) : null, c.county ? `${c.county} County` : (c.office === "U.S. Senate" ? "Statewide" : null)].filter(Boolean))].join(" · "), level: c.level, term: c.term, seats: c.seats, candidates: [] });
    const race = races.get(key)!; if (race.seats !== c.seats) race.seats = null; race.candidates.push(c);
  }
  return [...races.values()].sort((a, b) => ELECTION_LEVELS.findIndex(l => l.value === a.level) - ELECTION_LEVELS.findIndex(l => l.value === b.level) || a.area.localeCompare(b.area, "en", { numeric: true }) || a.office.localeCompare(b.office)).map(r => ({ ...r, candidates: r.candidates.sort((a, b) => a.name.localeCompare(b.name)) }));
}

export function candidateBallotLabel(candidate: ElectionCandidate, county: string): string | null {
  if (county && candidate.ballotLabelsByCounty[county]) return candidate.ballotLabelsByCounty[county];
  const labels = [...new Set(Object.values(candidate.ballotLabelsByCounty))];
  return candidate.ballotLabel ?? (labels.length === 1 ? labels[0] : null);
}
