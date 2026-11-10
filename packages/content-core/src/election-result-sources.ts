import { electionResultsError, electionRaceKey, isElectionInstant,
  type ElectionCandidate, type ElectionRace, type ElectionResultsData } from "./election-results.ts";
import { isExactHttpsUrl } from "./exact-https-url.ts";

/** Provider metadata stays outside the version-1 public snapshot. */
export interface ElectionRosterCandidate {
  id: string; raceId: string; name: string; firstName: string; lastName: string;
  ballotLabel: string; party: string; incumbent: boolean; campaignWebsite: string;
  ballotStatus: string; aliases: string[]; publishedProfileUrl?: string;
}
export interface ElectionRoster {
  schemaVersion: 1; electionDate: string;
  races: { id: string; office: string; district: string; candidateIds: string[] }[];
  candidates: ElectionRosterCandidate[];
}
export const ELECTION_SOURCE_MODES = ["approve-once", "counts-auto", "automatic"] as const;
export type ElectionSourceMode = typeof ELECTION_SOURCE_MODES[number];
export const AP_PUBLIC_RESULTS_URL = "https://apnews.com/hub/election-2026";
export const ELECTION_SHEET_COLUMNS = ["race_id", "candidate_id", "votes", "share", "status", "as_of",
  "reporting_share", "source_kind", "source_label", "source_url", "called_candidate_id", "ap_call_url"] as const;
export type ElectionSheetColumn = typeof ELECTION_SHEET_COLUMNS[number];
export type ElectionSheetMapping = Partial<Record<ElectionSheetColumn, string>>;
export interface ElectionApRehearsalClock { sourceTimeOrigin: string; replayTimeOrigin: string }
export interface ElectionSourceContext {
  roster: ElectionRoster; raceIds: string[]; now: string; maxAgeSeconds?: number;
  rehearsal?: boolean;
  apRehearsal?: ElectionApRehearsalClock;
  /** Full queries may confirm identical values with an older provider time. */
  apFullReconciliation?: boolean;
  /** Emit estimates only after the installed reader and admitted pair support them. */
  expectedVoteShareEnabled?: boolean;
  photos?: Record<string, ElectionCandidate["photo"]>;
  previous?: ElectionResultsData;
}
export class ElectionSourceError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "ElectionSourceError"; }
}
function fail(code: string, message: string): never { throw new ElectionSourceError(code, message); }
type ObjectValue = Record<string, unknown>;
function object(value: unknown): asserts value is ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("shape", "Expected a source object.");
}
function fields(value: ObjectValue, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) {
    fail("shape", "The source has missing or unknown fields.");
  }
}
function text(value: unknown, max = 160): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function array(value: unknown, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) fail("shape", "The source exceeds its row or race limit.");
}
function unique(values: string[], code = "identity") {
  if (new Set(values).size !== values.length) fail(code, "The source contains duplicate identities.");
}
export function parseElectionRoster(input: unknown, electionDate = "2026-11-03"): ElectionRoster {
  object(input); fields(input, ["schemaVersion", "electionDate", "races", "candidates"]);
  if (input.schemaVersion !== 1 || input.electionDate !== electionDate) fail("roster", "Use the selected election roster.");
  array(input.races, 20); array(input.candidates, 480);
  if (!input.races.length || !input.candidates.length) fail("roster", "The roster is empty.");
  const candidates = input.candidates.map(candidate => {
    object(candidate); fields(candidate, ["id", "raceId", "name", "firstName", "lastName", "ballotLabel", "party",
      "incumbent", "campaignWebsite", "ballotStatus", "aliases"], ["publishedProfileUrl"]);
    if (!id(candidate.id) || !id(candidate.raceId) || !text(candidate.name, 120) ||
        !text(candidate.firstName, 120) || !text(candidate.lastName, 120) || !text(candidate.ballotLabel, 60) ||
        !text(candidate.party, 60) || typeof candidate.incumbent !== "boolean" || !text(candidate.ballotStatus, 60) ||
        !(candidate.campaignWebsite === "" || isExactHttpsUrl(candidate.campaignWebsite, 2000))) fail("roster", "The roster has invalid candidate details.");
    array(candidate.aliases, 24);
    if (candidate.aliases.some(alias => !text(alias, 120))) fail("roster", "The roster has invalid aliases.");
    if (candidate.publishedProfileUrl !== undefined && (!isExactHttpsUrl(candidate.publishedProfileUrl, 2000) ||
        new URL(candidate.publishedProfileUrl as string).hostname !== "www.njspotlightnews.org")) fail("roster", "A profile link must be a published NJ Spotlight News URL.");
    return candidate as unknown as ElectionRosterCandidate;
  });
  unique(candidates.map(candidate => candidate.id));
  const races = input.races.map(race => {
    object(race); fields(race, ["id", "office", "district", "candidateIds"]);
    if (!id(race.id) || !text(race.office) || !text(race.district)) fail("roster", "The roster has an invalid race.");
    array(race.candidateIds, 24);
    if (race.candidateIds.length < 2 || race.candidateIds.some(cid => !id(cid))) fail("roster", "Each roster race needs candidate identities.");
    unique(race.candidateIds as string[]);
    if (race.candidateIds.some(cid => !candidates.some(candidate => candidate.id === cid && candidate.raceId === race.id)) ||
        candidates.filter(candidate => candidate.raceId === race.id).length !== race.candidateIds.length) fail("roster", "Race and candidate roster identities disagree.");
    return race as unknown as ElectionRoster["races"][number];
  });
  unique(races.map(race => race.id));
  if (candidates.some(candidate => !races.some(race => race.id === candidate.raceId))) fail("roster", "A candidate has no roster race.");
  return structuredClone({ schemaVersion: 1, electionDate: input.electionDate, races, candidates });
}
function contextCheck(context: ElectionSourceContext) {
  if (!isElectionInstant(context.now) || !Array.isArray(context.raceIds) || !context.raceIds.length || context.raceIds.length > 20 ||
      context.raceIds.some(rid => !context.roster.races.some(race => race.id === rid))) fail("mapping", "Select known roster races.");
  unique(context.raceIds);
  const age = context.maxAgeSeconds ?? 300;
  if (!Number.isSafeInteger(age) || age < 60 || age > 86400) fail("mapping", "Source age must be between 60 seconds and 24 hours.");
  return age;
}
function checked(data: ElectionResultsData, context: ElectionSourceContext, freshness: "race" | "poll" = "race"): ElectionResultsData {
  const age = contextCheck(context);
  const error = electionResultsError(data, true);
  if (error) fail("contract", error);
  for (const rid of context.raceIds) {
    const race = data.races.find(item => item.id === rid);
    if (!race) fail("missing-race", "A selected race disappeared from the source.");
    const time = Date.parse(race.asOf);
    if (time > Date.parse(context.now)) fail("future", "The source time is in the future.");
    if (freshness === "race" && Date.parse(context.now) - time > age * 1000) fail("stale", "The source is older than the connection allows.");
    const previous = context.previous?.races.find(item => item.id === rid);
    if (previous && time < Date.parse(previous.asOf)) fail("regression", "The source time moved backward.");
  }
  return data;
}
const raceFields = ["id", "status", "asOf", "reportingShare", "sourceKind", "sourceLabel", "sourceUrl", "candidates"];
function rosterRace(input: unknown, context: ElectionSourceContext, directAttribution: boolean): ElectionRace {
  object(input); fields(input, raceFields, ["calledCandidateId", "apCallUrl", "expectedVoteShare"]);
  const roster = context.roster.races.find(race => race.id === input.id);
  if (!roster) fail("roster", "The source contains a race outside the roster.");
  array(input.candidates, 24);
  const candidates = input.candidates.map(value => {
    object(value); fields(value, ["id", "votes", "share"]);
    const candidate = context.roster.candidates.find(item => item.id === value.id && item.raceId === input.id);
    if (!candidate) fail("roster", "The source contains a candidate outside the race roster.");
    return { id: candidate.id, name: candidate.name, party: candidate.ballotLabel,
      votes: value.votes, share: value.share,
      ...(context.photos?.[candidate.id] ? { photo: structuredClone(context.photos[candidate.id]) } : {}) } as ElectionCandidate;
  });
  unique(candidates.map(candidate => candidate.id));
  if (candidates.length !== roster.candidateIds.length) fail("missing-candidate", "A roster candidate disappeared from the source.");
  const { candidates: _candidates, ...race } = input;
  return { ...race, office: roster.office, district: roster.district,
    candidates: roster.candidateIds.map(cid => candidates.find(candidate => candidate.id === cid)!),
    ...(input.status === "called" && directAttribution && !input.apCallUrl ? { apCallUrl: AP_PUBLIC_RESULTS_URL } : {}) } as unknown as ElectionRace;
}
export function normalizeRepoResults(input: unknown, context: ElectionSourceContext): ElectionResultsData {
  contextCheck(context); object(input);
  fields(input, ["schemaVersion", "electionDate", "generatedAt", "sample", "races"]);
  if (input.schemaVersion !== 1 || input.electionDate !== context.roster.electionDate || input.sample !== (context.rehearsal === true) ||
      !isElectionInstant(input.generatedAt) || Date.parse(input.generatedAt) > Date.parse(context.now)) fail("envelope", "Use live results for the selected election with a valid generation time.");
  array(input.races, 20);
  const all = input.races.map(race => rosterRace(race, context, true));
  unique(all.map(race => race.id));
  return checked({ races: context.raceIds.map(rid => all.find(race => race.id === rid) ??
    fail("missing-race", "A selected race disappeared from the source.")) }, context);
}
function cellNumber(value: unknown): unknown {
  if (value === "" || value === undefined || value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  fail("number", "Use unformatted numbers; blank means unknown.");
}
export function normalizeSheetResults(values: unknown, mapping: ElectionSheetMapping, context: ElectionSourceContext): ElectionResultsData {
  contextCheck(context); array(values, 501);
  if (!values.length || !Array.isArray(values[0])) fail("sheet", "The Sheet needs a header row.");
  const headers = values[0];
  const names = ELECTION_SHEET_COLUMNS.map(key => mapping[key] ?? key);
  if (names.some(name => !text(name, 120))) fail("mapping", "Choose a header for each mapped column.");
  unique(names, "mapping");
  const positions = ELECTION_SHEET_COLUMNS.map((key, index) => {
    const matches = headers.flatMap((header, i) => header === names[index] ? [i] : []);
    if (matches.length > 1 || matches.length === 0 && !["called_candidate_id", "ap_call_url"].includes(key)) fail("mapping", "A mapped header is missing or repeated.");
    return matches[0] ?? -1;
  });
  const races = new Map<string, ObjectValue>();
  const repeated = new Map<string, string>();
  for (const row of values.slice(1)) {
    if (!Array.isArray(row)) fail("sheet", "Each Sheet row must be a cell list.");
    if (row.every(value => value === "" || value === null)) continue;
    const cells = Object.fromEntries(ELECTION_SHEET_COLUMNS.map((key, i) => [key, positions[i] < 0 ? "" : row[positions[i]] ?? ""]));
    if (!id(cells.race_id) || !id(cells.candidate_id)) fail("identity", "Each Sheet row needs roster race and candidate IDs.");
    const candidate = { id: cells.candidate_id, votes: cellNumber(cells.votes), share: cellNumber(cells.share) };
    const race = { id: cells.race_id, status: cells.status, asOf: cells.as_of,
      reportingShare: cellNumber(cells.reporting_share), sourceKind: cells.source_kind,
      sourceLabel: cells.source_label, sourceUrl: cells.source_url,
      ...(cells.called_candidate_id ? { calledCandidateId: cells.called_candidate_id } : {}),
      ...(cells.ap_call_url ? { apCallUrl: cells.ap_call_url } : {}) };
    const signature = electionRaceKey(race);
    if (repeated.has(race.id) && repeated.get(race.id) !== signature) fail("sheet", "Repeated race fields disagree in the Sheet.");
    repeated.set(race.id, signature);
    const existing = races.get(race.id);
    if (existing) (existing.candidates as unknown[]).push(candidate);
    else races.set(race.id, { ...race, candidates: [candidate] });
  }
  const all = [...races.values()].map(race => rosterRace(race, context, false));
  return checked({ races: context.raceIds.map(rid => all.find(race => race.id === rid) ??
    fail("missing-race", "A selected race disappeared from the source.")) }, context);
}

/** Keep number-format metadata until after percentages have been refused. */
export function normalizeSheetGridResults(input: unknown, mapping: ElectionSheetMapping, context: ElectionSourceContext): ElectionResultsData {
  object(input); array(input.sheets, 1);
  if (input.sheets.length !== 1) fail("sheet", "Read one bounded Sheet range.");
  const sheet = input.sheets[0]; object(sheet); array(sheet.data, 1);
  if (sheet.data.length !== 1) fail("sheet", "Read one bounded Sheet range.");
  const grid = sheet.data[0]; object(grid); array(grid.rowData, 501);
  const header = grid.rowData[0]; object(header);
  const headerCells = header.values ?? []; array(headerCells, 40);
  const mappedNames = new Set(ELECTION_SHEET_COLUMNS.map(key => mapping[key] ?? key));
  const mappedPositions = new Set(headerCells.flatMap((cell, index) => {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) return [];
    const value = (cell as ObjectValue).effectiveValue;
    return value && typeof value === "object" && !Array.isArray(value) &&
      mappedNames.has(String((value as ObjectValue).stringValue)) ? [index] : [];
  }));
  const values = grid.rowData.map((row, rowIndex) => {
    object(row); const cells = row.values ?? []; array(cells, 40);
    return cells.map((cell, index) => {
      if (rowIndex > 0 && !mappedPositions.has(index)) return "";
      object(cell);
      const format = cell.effectiveFormat;
      if (rowIndex > 0 && format !== undefined) {
        object(format);
        const number = format.numberFormat;
        if (number !== undefined) { object(number);
          if (number.type === "PERCENT") fail("sheet-format", "Use percentage points from 0 to 100, with plain number formatting instead of percent cells.");
        }
      }
      const value = cell.effectiveValue;
      if (value === undefined) return "";
      object(value);
      if (Object.hasOwn(value, "errorValue") || Object.hasOwn(value, "boolValue")) fail("sheet", "Sheet formulas must resolve to text or numbers without errors.");
      return value.numberValue ?? value.stringValue ?? "";
    });
  });
  return normalizeSheetResults(values, mapping, context);
}

export interface ElectionApMapping { raceId: string; candidateIds: Record<string, string> }
export interface ElectionApCache { mappingKey: string; data: ElectionResultsData }
/** AP v3 emits microseconds; the public contract stores millisecond instants. */
function apInstant(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail("ap", "AP returned an invalid source time.");
  }
  // Truncate, never round across a second or a regression boundary. Validate
  // the calendar and offset before this value reaches replay/cache/publication.
  const instant = value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, "$1");
  if (!isElectionInstant(instant)) fail("ap", "AP returned an invalid source time.");
  return instant;
}
export function electionApCache(data: ElectionResultsData, mapping: Record<string, ElectionApMapping>): ElectionApCache {
  return { mappingKey: electionRaceKey(mapping), data: structuredClone(data) };
}
export function parseElectionApMapping(input: unknown, context: ElectionSourceContext): Record<string, ElectionApMapping> {
  contextCheck(context); object(input);
  const pairs = Object.entries(input);
  if (pairs.length !== context.raceIds.length) fail("mapping", "Map every selected race exactly once.");
  const mapped = pairs.map(([providerId, value]) => {
    object(value); fields(value, ["raceId", "candidateIds"]);
    if (!/^\d{1,20}$/.test(providerId) || typeof value.raceId !== "string" || !context.raceIds.includes(value.raceId)) fail("mapping", "Map AP race IDs to the selected roster races.");
    const race = context.roster.races.find(race => race.id === value.raceId)!;
    object(value.candidateIds);
    const candidates = Object.entries(value.candidateIds);
    if (candidates.length !== race.candidateIds.length || candidates.some(([apid, cid]) =>
      !/^\d{1,20}$/.test(apid) || typeof cid !== "string" || !race.candidateIds.includes(cid))) fail("mapping", "Map every AP candidate to its roster identity.");
    unique(candidates.map(([, cid]) => String(cid)), "mapping");
    return [providerId, { raceId: value.raceId, candidateIds: Object.fromEntries(candidates) }] as const;
  });
  unique(mapped.map(([, value]) => value.raceId), "mapping");
  return Object.fromEntries(mapped) as Record<string, ElectionApMapping>;
}
export function parseElectionApRehearsal(input: unknown, now: string, electionDate = "2026-11-03"): ElectionApRehearsalClock {
  object(input); fields(input, ["sourceTimeOrigin", "replayTimeOrigin"]);
  if (!isElectionInstant(now) || !isElectionInstant(input.sourceTimeOrigin) || !isElectionInstant(input.replayTimeOrigin)) {
    fail("rehearsal", "AP rehearsal requires explicit valid simulation and replay origins.");
  }
  const sourceTime = Date.parse(input.sourceTimeOrigin);
  const replayTime = Date.parse(input.replayTimeOrigin);
  const electionStart = Date.parse(`${electionDate}T00:00:00Z`);
  if (sourceTime < electionStart || sourceTime >= electionStart + 172800000 || replayTime > Date.parse(now) ||
      Date.parse(now) - replayTime > 86400000) fail("rehearsal", "Use the selected AP test event and a replay origin within the last day.");
  return { sourceTimeOrigin: input.sourceTimeOrigin, replayTimeOrigin: input.replayTimeOrigin };
}
export function electionApInitialUrl(mapping: Record<string, ElectionApMapping>, context: ElectionSourceContext): string {
  const checked = parseElectionApMapping(mapping, context);
  if (context.apRehearsal) parseElectionApRehearsal(context.apRehearsal, context.now, context.roster.electionDate);
  const url = new URL(`https://api.ap.org/v3/elections/${context.roster.electionDate}`);
  url.search = new URLSearchParams({ statePostal: "NJ", raceID: Object.keys(checked).sort().join(","),
    level: "state", resultsType: context.apRehearsal ? "t" : "b", candidateInfo: "brief", format: "json" }).toString();
  return url.href;
}
/** A full initial AP response and subsequent deltas share this boundary. */
export function normalizeApResults(input: unknown, mapping: Record<string, ElectionApMapping>,
  context: ElectionSourceContext, cache?: ElectionApCache): ElectionResultsData {
  mapping = parseElectionApMapping(mapping, context); object(input);
  const replay = context.apRehearsal ? parseElectionApRehearsal(context.apRehearsal, context.now, context.roster.electionDate) : undefined;
  if (replay && context.rehearsal) fail("rehearsal", "AP and historical rehearsals use separate modes.");
  const matchingCache = cache?.mappingKey === electionRaceKey(mapping);
  const linkOnly = input.electionDate === undefined && !Object.hasOwn(input, "electionDate") &&
    input.races === undefined && typeof input.nextrequest === "string" && matchingCache;
  if (input.electionDate !== context.roster.electionDate && !linkOnly || input.isTruncated === true) fail("ap", "AP returned a different election or an incomplete response.");
  const raw = input.races ?? [];
  array(raw, 20);
  // Mapping changes require a complete new provider response. Reapply roster
  // labels and current Media picks even for races absent from a quiet delta.
  const cached = matchingCache ? cache!.data.races : [];
  const current = new Map(cached.map(race => [race.id, rosterRace({ id: race.id, status: race.status,
    asOf: race.asOf, reportingShare: race.reportingShare, sourceKind: race.sourceKind,
    ...(context.expectedVoteShareEnabled && race.expectedVoteShare !== undefined ? { expectedVoteShare: race.expectedVoteShare } : {}),
    sourceLabel: race.sourceLabel, sourceUrl: race.sourceUrl,
    candidates: race.candidates.map(candidate => ({ id: candidate.id, votes: candidate.votes, share: candidate.share })),
    ...(race.calledCandidateId ? { calledCandidateId: race.calledCandidateId, apCallUrl: race.apCallUrl } : {}) }, context, true)]));
  const seen: string[] = [];
  for (const value of raw) {
    object(value);
    if (!id(String(value.raceID)) || !Object.hasOwn(mapping, String(value.raceID))) fail("roster", "An AP race is not mapped to the roster.");
    const bind = mapping[String(value.raceID)];
    seen.push(bind.raceId);
    if (value.test !== undefined && typeof value.test !== "boolean") fail("ap", "AP returned an invalid test marker.");
    const supportedType = replay ? value.resultsType === "test" && value.test !== false
      : ["live", "certified"].includes(String(value.resultsType)) && value.test !== true;
    if (!supportedType || value.raceTypeID !== "G" ||
        !["S", "H"].includes(String(value.officeID))) fail("ap", "AP test or unsupported race data cannot publish.");
    array(value.reportingUnits, 1);
    const unit = value.reportingUnits[0]; object(unit);
    if (unit.statePostal !== "NJ" || unit.reportingunitLevel !== "1" && unit.reportingunitLevel !== 1) fail("ap", "Use AP New Jersey state totals only.");
    array(unit.candidates, 24);
    const reported = unit.candidates.map(candidate => {
      object(candidate);
      const cid = String(candidate.candidateID);
      if (!Object.hasOwn(bind.candidateIds, cid)) fail("roster", "An AP candidate is not mapped to the roster.");
      if (!Number.isSafeInteger(candidate.voteCount) || Number(candidate.voteCount) < 0) fail("contract", "AP votes must be nonnegative whole numbers.");
      if (candidate.winner !== undefined && !["X", "N", "R", ""].includes(String(candidate.winner))) fail("ap", "AP returned an unknown winner marker.");
      if (candidate.winner === "R") fail("ap", "A runoff requires a separately supported race contract.");
      return { id: bind.candidateIds[cid], votes: candidate.voteCount as number, winner: candidate.winner };
    });
    const sum = reported.reduce((total, candidate) => total + candidate.votes, 0);
    if (!Number.isSafeInteger(sum)) fail("contract", "AP vote totals exceed the safe number limit.");
    const winners = reported.filter(candidate => candidate.winner === "X");
    if (winners.length > 1) fail("ap", "AP returned multiple winners for a single-seat race.");
    const certified = value.resultsType === "certified";
    const awaiting = !certified && !winners.length && sum === 0 && unit.precinctsReporting === 0;
    const status = certified ? "certified" : winners.length ? "called" : awaiting ? "awaiting" : "counting";
    const sourceTime = apInstant(unit.lastUpdated);
    if (replay && (Date.parse(sourceTime) < Date.parse(`${context.roster.electionDate}T00:00:00Z`) ||
        Date.parse(sourceTime) >= Date.parse(`${context.roster.electionDate}T00:00:00Z`) + 172800000)) fail("ap", "Use source times from the selected AP test event.");
    const asOf = replay ? new Date(Date.parse(sourceTime) - Date.parse(replay.sourceTimeOrigin) + Date.parse(replay.replayTimeOrigin)).toISOString() : sourceTime;
    const eevp = Object.hasOwn(unit, "eevp") ? unit.eevp : value.eevp;
    if (eevp !== undefined && eevp !== null && (typeof eevp !== "number" || !Number.isFinite(eevp) || eevp < 0 || eevp > 100)) fail("ap", "AP returned an invalid expected vote percentage.");
    const race = rosterRace({ id: bind.raceId, status, asOf,
      sourceKind: certified ? "official" : "ap",
      sourceLabel: replay ? "REHEARSAL: AP 2026 test data; replay time" : "The Associated Press",
      sourceUrl: AP_PUBLIC_RESULTS_URL, reportingShare: context.expectedVoteShareEnabled ? null : unit.precinctsReportingPct ?? null,
      ...(context.expectedVoteShareEnabled && typeof eevp === "number" ? { expectedVoteShare: eevp / 100 } : {}),
      candidates: reported.map(candidate => ({ id: candidate.id, votes: awaiting ? null : candidate.votes,
        share: awaiting ? null : sum ? Math.round(candidate.votes / sum * 1000000) / 10000 : 0 })),
      ...(winners.length && !certified ? { calledCandidateId: winners[0].id, apCallUrl: AP_PUBLIC_RESULTS_URL } : {}) }, context, true);
    const before = current.get(race.id);
    const previous = context.previous?.races.find(item => item.id === race.id);
    const newest = previous && (!before || Date.parse(previous.asOf) > Date.parse(before.asOf)) ? previous : before;
    if (context.apFullReconciliation && newest && Date.parse(race.asOf) < Date.parse(newest.asOf) &&
        electionRaceKey({ ...race, asOf: newest.asOf }) === electionRaceKey(newest)) {
      // An unchanged full response confirms the newer stored race, not its older clock.
      current.set(race.id, structuredClone(newest));
      continue;
    }
    if (before && Date.parse(race.asOf) < Date.parse(before.asOf)) fail("regression", "The AP source time moved backward from its cached race.");
    current.set(race.id, race);
  }
  unique(seen);
  // A valid AP delta confirms unchanged races. The server records successful
  // poll time separately; failed/non-2xx polls never call this or refresh it.
  return checked({ races: context.raceIds.map(rid => current.get(rid) ?? fail("missing-race", "AP has not supplied a selected race.")) }, context, "poll");
}

/** Counts continue while a new call/status tuple awaits one publisher click. */
export function electionStatusKey(race: ElectionRace): string {
  return electionRaceKey({ status: race.status, calledCandidateId: race.calledCandidateId ?? null,
    apCallUrl: race.apCallUrl ?? null, sourceKind: race.sourceKind });
}
export function selectElectionSourceMode(incoming: ElectionResultsData, previous: ElectionResultsData | undefined,
  mode: ElectionSourceMode, authorizedStatuses: Record<string, string> = {}): { data: ElectionResultsData; pending: string[] } {
  if (!(ELECTION_SOURCE_MODES as readonly string[]).includes(mode)) fail("mode", "Choose a known publication mode.");
  const pending: string[] = [];
  const races = incoming.races.map(race => {
    const before = previous?.races.find(item => item.id === race.id);
    if (mode !== "counts-auto" || before && electionStatusKey(before) === electionStatusKey(race) || ["awaiting", "counting"].includes(race.status) &&
        (!before || ["awaiting", "counting"].includes(before.status)) || authorizedStatuses[race.id] === electionStatusKey(race)) return race;
    pending.push(race.id);
    // An awaiting reset supplies no counts to publish under the retained call.
    // Keep this race's prior values while other races continue updating.
    if (race.status === "awaiting" && before) return structuredClone(before);
    const { calledCandidateId: _called, apCallUrl: _url, ...counts } = race;
    const fallback = before?.status === "awaiting" ? "counting" : before?.status ?? "counting";
    return { ...counts, status: fallback,
      ...(before?.status === "called" ? { calledCandidateId: before.calledCandidateId, apCallUrl: before.apCallUrl } : {}),
      ...(before && ["called", "official", "certified"].includes(before.status)
        ? { sourceKind: before.sourceKind, sourceLabel: before.sourceLabel, sourceUrl: before.sourceUrl } : {}) };
  });
  const data = { races };
  const error = electionResultsError(data, true);
  if (error) fail("contract", error);
  return { data, pending };
}
