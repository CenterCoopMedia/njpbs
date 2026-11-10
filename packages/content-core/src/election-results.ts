import { isExactHttpsUrl } from "./exact-https-url.ts";

export const ELECTION_RACE_STATUSES = {
  awaiting: "Awaiting results",
  counting: "Votes being counted",
  called: "AP race call",
  official: "Official results",
  certified: "Certified results",
} as const;
export type ElectionRaceStatus = keyof typeof ELECTION_RACE_STATUSES;
export interface ElectionCandidate {
  id: string;
  name: string;
  party?: string;
  photo?: { assetId: string; alt: string; caption?: string };
  votes: number | null;
  share: number | null;
}
export interface ElectionRace {
  id: string;
  office: string;
  district: string;
  status: ElectionRaceStatus;
  candidates: ElectionCandidate[];
  sourceKind: "official" | "ap";
  sourceLabel: string;
  sourceUrl: string;
  asOf: string;
  reportingShare: number | null;
  /** AP expected vote counted, as a fraction from 0 to 1. */
  expectedVoteShare?: number;
  calledCandidateId?: string;
  apCallUrl?: string;
}
export interface ElectionResultsData { races: ElectionRace[] }
export interface ElectionStatusApproval {
  revision: number;
  status: ElectionRaceStatus;
  approvedAt: string;
  approvedBy: { uid: string; displayName: string };
}
export interface ElectionRaceApproval extends ElectionStatusApproval {
  blockId: string;
  raceId: string;
  digest: string;
  race: ElectionRace;
  statusHistory: ElectionStatusApproval[];
}
export const ELECTION_RESULTS_LIMITS = { races: 20, candidates: 24 } as const;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function text(value: unknown, max: number, required: boolean): value is string {
  return typeof value === "string" && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value) && (!required || value.trim().length > 0);
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
function share(value: unknown): boolean {
  return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function source(value: unknown, complete: boolean): boolean {
  return (!complete && value === "") || isExactHttpsUrl(value, 2000);
}
export function isElectionInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  // Date.parse normalizes impossible days such as February 30.
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return day.toISOString().slice(0, 10) === value.slice(0, 10);
}
function candidateError(value: unknown, complete: boolean): string | null {
  if (!record(value) || !fields(value, ["id", "name", "party", "photo", "votes", "share"]) || !id(value.id)) return "Each candidate needs a unique identity.";
  if (!text(value.name, 120, complete) || value.party !== undefined && !text(value.party, 60, false)) return "Use a candidate name of up to 120 characters and a party label of up to 60 characters.";
  if (value.votes !== null && (!Number.isSafeInteger(value.votes) || Number(value.votes) < 0)) return "Votes must be a whole number of zero or more, or blank when unknown.";
  if (!share(value.share)) return "Candidate shares must be between 0 and 100, or blank when unknown.";
  if (value.votes === 0 && typeof value.share === "number" && value.share > 0) return "A candidate with zero votes cannot have a positive vote share.";
  if (value.photo !== undefined) {
    const photo = value.photo;
    if (!record(photo) || !fields(photo, ["assetId", "alt", "caption"]) || !id(photo.assetId) ||
      !text(photo.alt, 300, complete) || photo.caption !== undefined && !text(photo.caption, 300, false)) return "Choose a Media photo and add a description of up to 300 characters.";
  }
  return null;
}
export function electionRaceError(value: unknown, complete = false): string | null {
  if (!record(value) || !fields(value, ["id", "office", "district", "status", "candidates", "sourceKind", "sourceLabel", "sourceUrl", "asOf", "reportingShare", "expectedVoteShare", "calledCandidateId", "apCallUrl"]) || !id(value.id)) return "Each race needs a unique identity and known fields.";
  if (!text(value.office, 160, complete) || !text(value.district, 160, complete)) return "Add the office and district, using up to 160 characters each.";
  if (typeof value.status !== "string" || !Object.hasOwn(ELECTION_RACE_STATUSES, value.status)) return "Choose a race status.";
  if (!Array.isArray(value.candidates) || value.candidates.length > ELECTION_RESULTS_LIMITS.candidates || complete && value.candidates.length < 2) return "Add between 2 and 24 candidates, including any reported write-ins.";
  const identities = new Set<string>();
  for (const candidate of value.candidates) {
    const error = candidateError(candidate, complete);
    if (error) return error;
    if (identities.has(candidate.id)) return "Candidate identities must be unique within a race.";
    identities.add(candidate.id);
  }
  const candidates = value.candidates as ElectionCandidate[];
  if (candidates.reduce((sum, candidate) => sum + (candidate.share ?? 0), 0) > 100.1) return "Candidate shares cannot total more than 100% (apart from rounding).";
  if (!["official", "ap"].includes(String(value.sourceKind)) || !text(value.sourceLabel, 160, complete) || !source(value.sourceUrl, complete)) return "Name the source and use a credential-free HTTPS source link.";
  if (!(value.asOf === "" && !complete) && !isElectionInstant(value.asOf)) return "Use a real as-of date and time with a time zone.";
  if (!share(value.reportingShare)) return "Reporting share must be between 0 and 100, or blank when unknown.";
  if (Object.hasOwn(value, "expectedVoteShare") && (typeof value.expectedVoteShare !== "number" ||
      !Number.isFinite(value.expectedVoteShare) || value.expectedVoteShare < 0 || value.expectedVoteShare > 1)) return "Expected vote share must be a fraction between 0 and 1, or omitted when unknown.";
  if (value.status === "called") {
    const candidateMissing = value.calledCandidateId === undefined || value.calledCandidateId === "";
    const candidateValid = candidateMissing && !complete || id(value.calledCandidateId) && identities.has(value.calledCandidateId);
    if (value.sourceKind !== "ap" || !candidateValid || !source(value.apCallUrl ?? "", complete)) return "An AP call needs the called candidate, an AP source and a link to the AP call. A concession is not a call.";
  } else if (value.calledCandidateId !== undefined || value.apCallUrl !== undefined) return "AP call details are allowed only for an AP race call.";
  if (["official", "certified"].includes(value.status) && value.sourceKind !== "official") return "Official or certified results must use an official source.";
  if (complete && value.status !== "awaiting" && candidates.some(candidate => candidate.votes === null || candidate.share === null)) return "Add the reported votes and share for every candidate before approval.";
  if (value.status === "awaiting" && candidates.some(candidate => candidate.votes !== null || candidate.share !== null)) return "Use Votes being counted when numbers are available. Leave unknown numbers blank.";
  return null;
}
export function electionResultsError(value: unknown, complete = false): string | null {
  if (!record(value) || !fields(value, ["races"]) || !Array.isArray(value.races) || value.races.length > ELECTION_RESULTS_LIMITS.races || complete && value.races.length === 0) return "Add between 1 and 20 races to the results section.";
  const identities = new Set<string>();
  for (const race of value.races) {
    const error = electionRaceError(race, complete);
    if (error) return error;
    if (identities.has(race.id)) return "Race identities must be unique within the results section.";
    identities.add(race.id);
  }
  return null;
}
export function isElectionResultsData(value: unknown, complete = false): value is ElectionResultsData {
  return electionResultsError(value, complete) === null;
}
/** One canonical value for exact approval comparisons across browser and server. */
export function electionRaceKey(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (record(input)) return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]));
    return input;
  }
  return JSON.stringify(canonical(value));
}
