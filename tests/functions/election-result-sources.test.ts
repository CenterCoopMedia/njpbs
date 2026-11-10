import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AP_PUBLIC_RESULTS_URL, ELECTION_SHEET_COLUMNS, electionApCache, electionApInitialUrl, electionStatusKey, normalizeApResults,
  normalizeRepoResults, normalizeSheetResults, normalizeSheetGridResults, parseElectionRoster, selectElectionSourceMode,
  type ElectionSourceContext } from "../../packages/content-core/src/election-result-sources.ts";
import { electionResultsError } from "../../packages/content-core/src/election-results.ts";
import { apV3Fixture } from "../fixtures/election-sources/ap-v3.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/election-sources/${name}.json`, import.meta.url), "utf8"));
const roster = parseElectionRoster(fixture("roster"));
const repo = () => fixture("repo-live");
const context = (patch: Partial<ElectionSourceContext> = {}): ElectionSourceContext => ({ roster,
  raceIds: ["us-senate", "us-house-01"], now: "2026-11-04T01:01:00Z", ...patch });
// The fixture has no quoted cells; quotes in arbitrary producer CSV are not a runtime input.
const sheet = () => readFileSync(new URL("../fixtures/election-sources/results.csv", import.meta.url), "utf8")
  .trimEnd().split(/\r?\n/).map(row => row.split(","));
const ap = () => ({ electionDate: "2026-11-03", timestamp: "2026-11-04T01:00:00Z",
  races: repo().races.slice(0, 2).map((race: { id: string; candidates: { id: string; votes: number }[] }, i: number) => ({
    raceID: String(100 + i), resultsType: "live", raceTypeID: "G", officeID: i ? "H" : "S",
    reportingUnits: [{ statePostal: "NJ", reportingunitLevel: "1", lastUpdated: "2026-11-04T01:00:00Z",
      precinctsReportingPct: 50, candidates: race.candidates.map((candidate, j) => ({ candidateID: String(i * 10 + j),
        voteCount: candidate.votes, ...(j === 0 ? { winner: "X" } : {}) })) }],
  })), nextrequest: "https://api.ap.org/v3/elections/2026-11-03?statePostal=NJ&minDateTime=2026-11-04T01:00:00Z" });
const mapping = Object.fromEntries(roster.races.slice(0, 2).map((race, i) => [String(100 + i), {
  raceId: race.id, candidateIds: Object.fromEntries(race.candidateIds.map((cid, j) => [String(i * 10 + j), cid])),
}]));

describe("roster and source normalizers at the public version-1 boundary", () => {
  it("keeps all 39 certified ballot candidates and all ballot labels, including minor parties and aliases", () => {
    expect(roster.candidates).toHaveLength(39);
    expect(roster.races).toHaveLength(13);
    expect(roster.races.find(race => race.id === "us-house-07")?.candidateIds).toEqual([
      "us-house-07-thomas-h-kean-jr", "us-house-07-rebecca-bennett", "us-house-07-seamus-patrick-otoole",
    ]);
    expect(roster.candidates.filter(candidate => candidate.party === "Independent or minor party")).toHaveLength(14);
    expect(roster.candidates.find(candidate => candidate.name === "Michael P. McGuire")?.aliases).toContain("Michael McGuire");
  });
  it("normalizes the real-shaped Sheet and repo JSON to the same frozen golden", () => {
    const expected = fixture("golden");
    expect(normalizeRepoResults(repo(), context())).toEqual(expected);
    expect(normalizeSheetResults(sheet(), {}, context())).toEqual(expected);
    expect(electionResultsError(expected, true)).toBeNull();
  });
  it("preserves roster order and Boardwalk Media picks, without adding profile metadata to V1", () => {
    const data = repo(); data.races[0].candidates.reverse();
    const id = roster.candidates[0].id;
    const photo = { assetId: "media-photo", alt: "Candidate portrait", caption: "Photo: test source" };
    const result = normalizeRepoResults(data, context({ photos: { [id]: photo } }));
    expect(result.races[0].candidates[0]).toEqual({ ...fixture("golden").races[0].candidates[0], photo });
    expect(result.races[0].candidates[0]).not.toHaveProperty("campaignWebsite");
    expect(result.races[0].candidates[0]).not.toHaveProperty("incumbent");
  });
  it.each([
    ["negative votes", (data: ReturnType<typeof repo>) => { data.races[0].candidates[0].votes = -1; }],
    ["fractional votes", (data: ReturnType<typeof repo>) => { data.races[0].candidates[0].votes = 1.5; }],
    ["overflow votes", (data: ReturnType<typeof repo>) => { data.races[0].candidates[0].votes = Number.MAX_SAFE_INTEGER + 1; }],
    ["shares above 100", (data: ReturnType<typeof repo>) => { data.races[0].candidates[0].share = 101; }],
    ["total shares above 100", (data: ReturnType<typeof repo>) => { data.races[0].candidates.forEach((c: { share: number }) => { c.share = 50; }); }],
    ["unknown candidates", (data: ReturnType<typeof repo>) => { data.races[0].candidates[0].id = "unknown"; }],
    ["unknown races", (data: ReturnType<typeof repo>) => { data.races[0].id = "unknown"; }],
    ["missing candidates", (data: ReturnType<typeof repo>) => { data.races[0].candidates.pop(); }],
    ["missing races", (data: ReturnType<typeof repo>) => { data.races.shift(); }],
    ["duplicate candidates", (data: ReturnType<typeof repo>) => { data.races[0].candidates[1] = data.races[0].candidates[0]; }],
    ["duplicate races", (data: ReturnType<typeof repo>) => { data.races.push(data.races[0]); }],
    ["future source times", (data: ReturnType<typeof repo>) => { data.races[0].asOf = "2026-11-04T02:00:00Z"; }],
    ["impossible source times", (data: ReturnType<typeof repo>) => { data.races[0].asOf = "2026-02-30T01:00:00Z"; }],
    ["stale values with a fresh envelope", (data: ReturnType<typeof repo>) => { data.races[0].asOf = "2026-11-04T00:00:00Z"; }],
    ["credential-bearing sources", (data: ReturnType<typeof repo>) => { data.races[0].sourceUrl = "https://user:password@example.test/"; }],
    ["sample results", (data: ReturnType<typeof repo>) => { data.sample = true; }],
    ["private unknown fields", (data: ReturnType<typeof repo>) => { data.races[0].draft = "private"; }],
  ] as const)("holds %s", (_reason, mutate) => {
    const data = repo(); mutate(data);
    expect(() => normalizeRepoResults(data, context())).toThrow();
  });
  it("holds timestamp regressions even when still fresh", () => {
    const previous = normalizeRepoResults(repo(), context());
    previous.races[0].asOf = "2026-11-04T01:00:30Z";
    expect(() => normalizeRepoResults(repo(), context({ previous }))).toThrow("backward");
  });
  it("supports explicit Sheet column mapping while refusing conflicting race fields and malformed numbers", () => {
    const values = sheet(); values[0][0] = "Contest";
    expect(normalizeSheetResults(values, { race_id: "Contest" }, context())).toEqual(fixture("golden"));
    const invalid = sheet(); invalid[2][5] = "2026-11-04T01:00:30Z";
    expect(() => normalizeSheetResults(invalid, {}, context())).toThrow("disagree");
    const percent = sheet(); percent[1][3] = "25%";
    expect(() => normalizeSheetResults(percent, {}, context())).toThrow("unformatted");
    expect(() => normalizeSheetResults(sheet(), { candidate_id: "race_id" }, context())).toThrow("duplicate");
  });
  it("keeps blanks distinct from zero and requires the Sheet AP call link", () => {
    const values = sheet();
    for (const row of values.slice(1, 5)) { row[4] = "called"; row[7] = "ap"; row[10] = roster.candidates[0].id; }
    expect(() => normalizeSheetResults(values, {}, context())).toThrow("link to the AP call");
    for (const row of values.slice(1, 5)) row[11] = "https://apnews.com/article/synthetic-election-call";
    expect(normalizeSheetResults(values, {}, context()).races[0].status).toBe("called");
    const zero = sheet(); zero[1][2] = "0"; zero[1][3] = "0";
    expect(normalizeSheetResults(zero, {}, context()).races[0].candidates[0].votes).toBe(0);
    expect(normalizeSheetResults(sheet(), {}, context({ raceIds: ["us-house-02"] })).races[0].candidates[0].votes).toBeNull();
    expect(ELECTION_SHEET_COLUMNS).toHaveLength(12);
  });
  it("supplies the approved AP attribution URL for an explicit repo AP call", () => {
    const data = repo();
    Object.assign(data.races[0], { status: "called", sourceKind: "ap", sourceLabel: "The Associated Press",
      sourceUrl: AP_PUBLIC_RESULTS_URL, calledCandidateId: roster.candidates[0].id });
    const result = normalizeRepoResults(data, context());
    expect(result.races[0].apCallUrl).toBe(AP_PUBLIC_RESULTS_URL);
    expect(electionResultsError(result, true)).toBeNull();
  });
  it("uses actual Sheet effective-format metadata to refuse displayed percentages before numeric conversion", () => {
    const grid = { sheets: [{ data: [{ rowData: sheet().map(row => ({ values: row.map(value => ({
      effectiveValue: value === "" ? {} : /^\d+(\.\d+)?$/.test(value) ? { numberValue: Number(value) } : { stringValue: value },
      effectiveFormat: { numberFormat: { type: "NUMBER" } },
    })) })) }] }] };
    expect(normalizeSheetGridResults(grid, {}, context())).toEqual(fixture("golden"));
    grid.sheets[0].data[0].rowData[1].values[3].effectiveValue = { numberValue: 0.25 };
    grid.sheets[0].data[0].rowData[1].values[3].effectiveFormat.numberFormat.type = "PERCENT";
    expect(() => normalizeSheetGridResults(grid, {}, context())).toThrow("percent cells");
  });
  it("ignores percent formatting and errors in producer columns outside the explicit mapping", () => {
    const values = sheet().map((row, index) => [...row, index ? "75%" : "On-air progress"]);
    const grid = { sheets: [{ data: [{ rowData: values.map((row, rowIndex) => ({ values: row.map((value, column) => ({
      effectiveValue: column === 12 && rowIndex ? { errorValue: { type: "N_A" } } : { stringValue: value },
      effectiveFormat: { numberFormat: { type: column === 12 ? "PERCENT" : "NUMBER" } },
    })) })) }] }] };
    expect(normalizeSheetResults(values, {}, context())).toEqual(fixture("golden"));
    expect(normalizeSheetGridResults(grid, {}, context())).toEqual(fixture("golden"));
  });
  it("refuses unknown roster fields and private profile URLs", () => {
    const value = fixture("roster"); value.candidates[0].email = "private@example.test";
    expect(() => parseElectionRoster(value)).toThrow("unknown");
    delete value.candidates[0].email; value.candidates[0].publishedProfileUrl = "https://docs.google.com/document/d/private";
    expect(() => parseElectionRoster(value)).toThrow("NJ Spotlight");
  });
});

describe("AP recorded format and source mapping", () => {
  it("accepts capture-shaped live-b awaiting data and truncates AP microseconds before the strict contract", () => {
    const raw = apV3Fixture();
    const result = normalizeApResults(raw, mapping, context({ now: "2026-11-04T03:00:00Z", expectedVoteShareEnabled: true }));
    expect(result.races[0]).toMatchObject({ status: "awaiting", asOf: "2026-11-04T02:59:00.243Z",
      reportingShare: null, expectedVoteShare: 0 });
    expect(result.races.every(race => race.candidates.every(candidate => candidate.votes === null && candidate.share === null))).toBe(true);
    expect(electionResultsError(result, true)).toBeNull();
    expect(raw.races[0].reportingUnits[0].lastUpdated).toBe("2026-11-04T02:59:00.243000Z");
  });
  it("uses truncated AP test instants for the replay without inferring calls from raceCallStatus", () => {
    const result = normalizeApResults(apV3Fixture("test"), mapping, context({ now: "2026-11-04T03:00:00Z",
      apRehearsal: { sourceTimeOrigin: "2026-11-04T04:00:00Z", replayTimeOrigin: "2026-11-04T02:59:00Z" },
      expectedVoteShareEnabled: true }));
    expect(result.races[0]).toMatchObject({ status: "counting", asOf: "2026-11-04T02:59:00.258Z" });
    expect(result.races[0].expectedVoteShare).toBeCloseTo(0.9071, 8);
    expect(result.races[0]).not.toHaveProperty("calledCandidateId");
    expect(result.races[0].candidates.map(candidate => candidate.id)).toEqual(roster.races[0].candidateIds);
    expect(electionResultsError(result, true)).toBeNull();
    expect(() => normalizeApResults(apV3Fixture("test"), mapping, context())).toThrow("test or unsupported");
  });
  it("uses the documented X marker for a called candidate even when that candidate is not leading", () => {
    const result = normalizeApResults(apV3Fixture("called"), mapping, context({ now: "2026-11-04T03:00:00Z" }));
    expect(result.races[0]).toMatchObject({ status: "called", calledCandidateId: mapping["100"].candidateIds["0"],
      apCallUrl: AP_PUBLIC_RESULTS_URL, asOf: "2026-11-04T02:59:00.243Z" });
    const reversal = apV3Fixture("called");
    reversal.races.forEach((race: any) => { race.raceCallStatus = "Uncalled";
      race.reportingUnits[0].candidates.forEach((candidate: any) => { if (candidate.winner) candidate.winner = "N"; }); });
    expect(normalizeApResults(reversal, mapping, context({ now: "2026-11-04T03:00:00Z" })).races[0].status).toBe("counting");
  });
  it("retains strict calendar, future, cache and public regression checks after truncation", () => {
    const ctx = context({ now: "2026-11-04T03:00:00Z" });
    const previous = normalizeApResults(apV3Fixture(), mapping, ctx);
    const cache = electionApCache(previous, mapping);
    const older = apV3Fixture(); older.races[0].reportingUnits[0].lastUpdated = "2026-11-04T02:59:00.242999Z";
    expect(() => normalizeApResults(older, mapping, ctx, cache)).toThrow("cached race");
    expect(() => normalizeApResults(older, mapping, { ...ctx, previous })).toThrow("backward");
    for (const time of ["2026-02-30T02:59:00.243000Z", "2026-11-04T25:00:00.243000Z", "2026-11-04T02:59:00.2430000Z",
      "2026-11-04T03:00:00.001000Z", "2026-11-04T02:59:00.243000Z\n"]) {
      const invalid = apV3Fixture(); invalid.races[0].reportingUnits[0].lastUpdated = time;
      expect(() => normalizeApResults(invalid, mapping, ctx)).toThrow();
    }
    const same = apV3Fixture(); same.races[0].reportingUnits[0].lastUpdated = "2026-11-04T02:59:00.243999Z";
    expect(normalizeApResults(same, mapping, { ...ctx, previous }, cache)).toEqual(previous);
    const noRound = apV3Fixture(); noRound.races[0].reportingUnits[0].lastUpdated = "2026-11-04T02:59:00.999999Z";
    expect(normalizeApResults(noRound, mapping, ctx).races[0].asOf).toBe("2026-11-04T02:59:00.999Z");
    expect(electionResultsError({ races: previous.races.map(race => ({ ...race, asOf: "2026-11-04T02:59:00.243000Z" })) }, true)).not.toBeNull();
  });
  it("requests only mapped selected AP races, rather than all NJ races", () => {
    const url = new URL(electionApInitialUrl(mapping, context()));
    expect(url.searchParams.get("raceID")).toBe("100,101");
    expect(url.searchParams.get("statePostal")).toBe("NJ");
    expect(() => electionApInitialUrl({}, context())).toThrow("every selected race");
  });
  it("refuses a synthetic AP response for a different election", () => {
    const synthetic = fixture("ap-synthetic-outside-election");
    expect(synthetic.races[0].reportingUnits[0].candidates[0].voteCount).toBe(1200);
    expect(() => normalizeApResults(synthetic, mapping, context())).toThrow("different election");
  });
  it("maps AP IDs to the real NJ roster and credits calls without an editor-supplied article link", () => {
    const result = normalizeApResults(ap(), mapping, context());
    expect(result.races[0]).toMatchObject({ id: "us-senate", status: "called", sourceKind: "ap",
      calledCandidateId: roster.candidates[0].id, apCallUrl: AP_PUBLIC_RESULTS_URL });
    expect(result.races[0].candidates.map(candidate => candidate.share)).toEqual([25, 25, 25, 25]);
    expect(electionResultsError(result, true)).toBeNull();
    expect(JSON.stringify(result)).not.toContain("candidateID");
  });
  it("keeps quiet AP races current through successful empty deltas without restamping race asOf", () => {
    const cache = electionApCache(normalizeApResults(ap(), mapping, context()), mapping);
    expect(normalizeApResults({ electionDate: "2026-11-03" }, mapping, context(), cache)).toEqual(cache.data);
    expect(normalizeApResults({ electionDate: "2026-11-03" }, mapping,
      context({ now: "2026-11-04T02:06:00Z" }), cache)).toEqual(cache.data);
    expect(() => normalizeApResults({ electionDate: "2026-11-03" }, mapping, context())).toThrow("selected race");
  });
  it("accepts AP's documented link-only response only with a matching complete cache", () => {
    const cache = electionApCache(normalizeApResults(ap(), mapping, context()), mapping);
    const response = { nextrequest: ap().nextrequest };
    expect(normalizeApResults(response, mapping, context(), cache)).toEqual(cache.data);
    expect(() => normalizeApResults(response, mapping, context())).toThrow("different election");
    expect(() => normalizeApResults({ ...response, electionDate: "2024-11-05" }, mapping, context(), cache)).toThrow("different election");
  });
  it("accepts a successful ten-minute AP full check without relaxing Sheet or repo source age", () => {
    const first = normalizeApResults(ap(), mapping, context());
    const next = context({ now: "2026-11-04T01:11:00Z", previous: first });
    // The ten-minute full reconciliation still has AP's unchanged source times.
    expect(normalizeApResults(ap(), mapping, next)).toEqual(first);
    expect(() => normalizeSheetResults(sheet(), {}, next)).toThrow("older");
    expect(() => normalizeRepoResults(repo(), next)).toThrow("older");
  });
  it("refuses a delta older than the source cache even when the public snapshot is older", () => {
    const latest = ap(); latest.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T01:04:00Z"; });
    const ctx = context({ now: "2026-11-04T01:05:00Z" });
    const cache = electionApCache(normalizeApResults(latest, mapping, ctx), mapping);
    const older = ap(); older.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T01:02:00Z"; });
    expect(() => normalizeApResults(older, mapping, { ...ctx, previous: fixture("golden") }, cache)).toThrow("cached race");
    expect(cache.data.races[0].asOf).toBe("2026-11-04T01:04:00Z");
  });
  it("keeps newer stored races when a full query confirms identical values with ten-second-older times", () => {
    // November 4 incident: AP full state totals lagged delta-built times by about
    // ten seconds with identical values. IDs/counts are synthetic; six-digit times
    // retain the captured response shape, not any raw keyed provider response.
    const latest = ap();
    latest.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T01:00:10.123456Z"; });
    const first = normalizeApResults(latest, mapping, context());
    const older = structuredClone(latest);
    older.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T01:00:00.123456Z"; });
    const ctx = context({ now: "2026-11-04T01:11:00Z", previous: first, apFullReconciliation: true });
    expect(normalizeApResults(older, mapping, ctx)).toEqual(first);
    expect(first.races[0].asOf).toBe("2026-11-04T01:00:10.123Z");
    expect(() => normalizeApResults(older, mapping, { ...ctx, apFullReconciliation: false }, electionApCache(first, mapping))).toThrow("backward");
    const missing = structuredClone(older); missing.races.pop();
    expect(() => normalizeApResults(missing, mapping, ctx)).toThrow("selected race");
  });
  it.each(["votes", "winner", "reporting", "estimate", "status"])("still holds a backward full response with changed %s", change => {
    const latest = ap(); latest.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T01:00:10Z"; });
    const first = normalizeApResults(latest, mapping, context({ expectedVoteShareEnabled: true }));
    const older = structuredClone(latest);
    older.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T01:00:00Z"; });
    const race = older.races[0], unit = race.reportingUnits[0];
    if (change === "votes") unit.candidates[0].voteCount++;
    if (change === "winner") { delete unit.candidates[0].winner; unit.candidates[1].winner = "X"; }
    if (change === "reporting") unit.precinctsReportingPct = 51;
    if (change === "estimate") (race as typeof race & { eevp: number }).eevp = 80;
    if (change === "status") race.resultsType = "certified";
    // Use V1 for reporting: V2 deliberately omits precinct reporting in favor of estimates.
    const enabled = change !== "reporting";
    const previous = enabled ? first : normalizeApResults(latest, mapping, context());
    const ctx = context({ now: "2026-11-04T01:11:00Z", previous, apFullReconciliation: true, expectedVoteShareEnabled: enabled });
    expect(() => normalizeApResults(older, mapping, ctx)).toThrow("backward");
    expect(previous).toEqual(enabled ? first : normalizeApResults(latest, mapping, context()));
  });
  it("compares an older full race with the newest cached or pending values", () => {
    const first = normalizeApResults(ap(), mapping, context());
    const latest = ap();
    latest.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T01:00:10Z"; });
    latest.races[0].reportingUnits[0].candidates[0].voteCount++;
    const cache = electionApCache(normalizeApResults(latest, mapping, context()), mapping);
    const older = ap(); older.races.forEach(race => { race.reportingUnits[0].lastUpdated = "2026-11-04T00:59:50Z"; });
    expect(() => normalizeApResults(older, mapping,
      context({ previous: first, apFullReconciliation: true }), cache)).toThrow("backward");
  });
  it("reapplies current roster labels and Media picks to quiet races and refuses cache after mapping changes", () => {
    const cid = roster.candidates[0].id;
    const photo = { assetId: "old-photo", alt: "Portrait" };
    const cache = electionApCache(normalizeApResults(ap(), mapping, context({ photos: { [cid]: photo } })), mapping);
    const renamed = structuredClone(roster); renamed.candidates[0].name = "Corrected public name";
    const result = normalizeApResults({ electionDate: "2026-11-03" }, mapping, context({ roster: renamed }), cache);
    expect(result.races[0].candidates[0].name).toBe("Corrected public name");
    expect(result.races[0].candidates[0]).not.toHaveProperty("photo");
    const changed = structuredClone(mapping);
    [changed["100"].candidateIds["0"], changed["100"].candidateIds["1"]] =
      [changed["100"].candidateIds["1"], changed["100"].candidateIds["0"]];
    expect(() => normalizeApResults({ electionDate: "2026-11-03" }, changed, context(), cache)).toThrow("selected race");
    expect(normalizeApResults(ap(), changed, context(), cache).races[0].calledCandidateId).toBe(changed["100"].candidateIds["0"]);
  });
  it.each(["test", "roster", "unit", "winner", "missing", "truncated"])("holds AP %s failures without mutating cache", kind => {
    const data = ap();
    if (kind === "test") data.races[0].resultsType = "test";
    if (kind === "roster") data.races[0].reportingUnits[0].candidates[0].candidateID = "unknown";
    if (kind === "unit") data.races[0].reportingUnits[0].statePostal = "PA";
    if (kind === "winner") data.races[0].reportingUnits[0].candidates[1].winner = "X";
    if (kind === "missing") data.races[0].reportingUnits[0].candidates.pop();
    if (kind === "truncated") Object.assign(data, { isTruncated: true });
    const cache = electionApCache(normalizeApResults(ap(), mapping, context()), mapping); const frozen = structuredClone(cache);
    expect(() => normalizeApResults(data, mapping, context(), cache)).toThrow();
    expect(cache).toEqual(frozen);
  });
  it("labels AP certified totals as official while retaining AP source credit", () => {
    const data = ap(); data.races[0].resultsType = "certified";
    const result = normalizeApResults(data, mapping, context());
    expect(result.races[0]).toMatchObject({ status: "certified", sourceKind: "official" });
    expect(result.races[0].sourceLabel).toContain("The Associated Press");
    expect(result.races[0]).not.toHaveProperty("apCallUrl");
  });
  it("keeps AP preclose zero files awaiting while preserving reported zero after a precinct reports", () => {
    const data = ap();
    for (const race of data.races) {
      Object.assign(race.reportingUnits[0], { precinctsReporting: 0 });
      race.reportingUnits[0].candidates.forEach(candidate => { candidate.voteCount = 0; delete candidate.winner; });
    }
    const result = normalizeApResults(data, mapping, context());
    expect(result.races.every(race => race.status === "awaiting")).toBe(true);
    expect(result.races[0].candidates.every(candidate => candidate.votes === null && candidate.share === null)).toBe(true);
    Object.assign(data.races[0].reportingUnits[0], { precinctsReporting: 1 });
    expect(normalizeApResults(data, mapping, context()).races[0].candidates[0].votes).toBe(0);
  });
});

describe("the three per-connection modes", () => {
  it.each(["approve-once", "automatic"] as const)("passes validated values in %s after caller authorization", mode => {
    const incoming = normalizeApResults(ap(), mapping, context());
    expect(selectElectionSourceMode(incoming, undefined, mode)).toEqual({ data: incoming, pending: [] });
  });
  it("publishes counts while a call awaits a click, then approves its tuple independently of later counts", () => {
    const previous = normalizeRepoResults(repo(), context());
    const incoming = normalizeApResults(ap(), mapping, context());
    const held = selectElectionSourceMode(incoming, previous, "counts-auto");
    expect(held.pending).toEqual(["us-senate", "us-house-01"]);
    expect(held.data.races[0].status).toBe("counting");
    expect(held.data.races[0]).toMatchObject({ sourceKind: "ap", sourceLabel: "The Associated Press", sourceUrl: AP_PUBLIC_RESULTS_URL });
    const keys = Object.fromEntries(incoming.races.map(race => [race.id, electionStatusKey(race)]));
    incoming.races[0].candidates[0].votes += 1;
    const approved = selectElectionSourceMode(incoming, previous, "counts-auto", keys);
    expect(approved.pending).toEqual([]);
    expect(approved.data.races[0].status).toBe("called");
  });
  it("keeps an existing AP call during pending certification and requires a click on call reversal", () => {
    const previous = normalizeApResults(ap(), mapping, context());
    const data = ap(); data.races[0].resultsType = "certified";
    const incoming = normalizeApResults(data, mapping, context());
    const held = selectElectionSourceMode(incoming, previous, "counts-auto");
    expect(held.data.races[0]).toMatchObject({ status: "called", sourceKind: "ap", apCallUrl: AP_PUBLIC_RESULTS_URL });
    expect(electionResultsError(held.data, true)).toBeNull();
    const reversal = structuredClone(previous); reversal.races[0].status = "counting";
    delete reversal.races[0].calledCandidateId; delete reversal.races[0].apCallUrl;
    expect(selectElectionSourceMode(reversal, previous, "counts-auto").pending).toContain("us-senate");
  });
  it("does not request another click for an unchanged already public status tuple", () => {
    const previous = normalizeApResults(ap(), mapping, context());
    expect(selectElectionSourceMode(previous, previous, "counts-auto").pending).toEqual([]);
  });
  it("keeps a called race intact during an awaiting reset while other counts continue", () => {
    const previous = normalizeApResults(ap(), mapping, context());
    previous.races[1].status = "counting";
    delete previous.races[1].calledCandidateId; delete previous.races[1].apCallUrl;
    const incoming = structuredClone(previous); incoming.races[0].status = "awaiting";
    delete incoming.races[0].calledCandidateId; delete incoming.races[0].apCallUrl;
    incoming.races[0].candidates.forEach(candidate => { candidate.votes = null; candidate.share = null; });
    incoming.races[1].candidates[0].votes! += 1;
    const result = selectElectionSourceMode(incoming, previous, "counts-auto");
    expect(result.pending).toEqual(["us-senate"]);
    expect(result.data.races[0]).toEqual(previous.races[0]);
    expect(result.data.races[1].candidates[0].votes).toBe(incoming.races[1].candidates[0].votes);
    const approved = selectElectionSourceMode(incoming, previous, "counts-auto", { "us-senate": electionStatusKey(incoming.races[0]) });
    expect(approved.data.races[0].status).toBe("awaiting");
    expect(approved.pending).toEqual([]);
  });
});


describe("isolated AP test event normalization", () => {
  const apRehearsal = { sourceTimeOrigin: "2026-11-04T01:00:00Z", replayTimeOrigin: "2026-10-30T14:00:00Z" };
  const testContext = () => context({ now: "2026-10-30T14:01:00Z", apRehearsal });
  const testData = () => { const value = ap(); return { ...value, races: value.races.map(race => ({ ...race, resultsType: "test", test: undefined as boolean | undefined })) }; };
  it("requests AP test data explicitly and leaves ordinary requests on the live/certified route", () => {
    expect(new URL(electionApInitialUrl(mapping, testContext())).searchParams.get("resultsType")).toBe("t");
    expect(new URL(electionApInitialUrl(mapping, context())).searchParams.get("resultsType")).toBe("b");
  });
  it("maps the provider's virtual election time with a fixed explicit offset and visible replay attribution", () => {
    const result = normalizeApResults(testData(), mapping, testContext());
    expect(result.races[0]).toMatchObject({ asOf: "2026-10-30T14:00:00.000Z", status: "called",
      sourceLabel: "REHEARSAL: AP 2026 test data; replay time", apCallUrl: AP_PUBLIC_RESULTS_URL });
    expect(() => normalizeApResults(testData(), mapping, context())).toThrow("test");
    expect(() => normalizeApResults(ap(), mapping, testContext())).toThrow("test");
  });
  it("keeps the same virtual timestamp stable across quiet deltas and rejects a backward source time", () => {
    const result = normalizeApResults(testData(), mapping, testContext());
    const cache = electionApCache(result, mapping);
    expect(normalizeApResults({ electionDate: "2026-11-03" }, mapping,
      { ...testContext(), now: "2026-10-30T14:02:00Z" }, cache)).toEqual(result);
    const old = testData(); old.races[0].reportingUnits[0].lastUpdated = "2026-11-04T00:59:00Z";
    expect(() => normalizeApResults(old, mapping, { ...testContext(), previous: result }, cache)).toThrow("backward");
  });
  it("retains actual-clock future checks and rejects invalid or expired simulation origins", () => {
    const future = testData(); future.races[0].reportingUnits[0].lastUpdated = "2026-11-04T01:02:00Z";
    expect(() => normalizeApResults(future, mapping, testContext())).toThrow("future");
    for (const clock of [ { ...apRehearsal, sourceTimeOrigin: "2024-11-05T01:00:00Z" },
      { ...apRehearsal, replayTimeOrigin: "2026-10-31T14:00:00Z" },
      { ...apRehearsal, replayTimeOrigin: "2026-10-28T14:00:00Z" } ]) {
      expect(() => normalizeApResults(testData(), mapping, { ...testContext(), apRehearsal: clock })).toThrow();
    }
    expect(() => normalizeApResults(testData(), mapping, { ...testContext(), rehearsal: true })).toThrow("separate");
    const outside = testData(); outside.races[0].reportingUnits[0].lastUpdated = "2026-10-30T01:00:00Z";
    expect(() => normalizeApResults(outside, mapping, testContext())).toThrow("selected AP test event");
  });
  it("refuses contradictory test markers, dates and identities in the isolated mode", () => {
    const falseFlag = testData(); falseFlag.races[0].test = false;
    expect(() => normalizeApResults(falseFlag, mapping, testContext())).toThrow("test");
    const historical = testData(); historical.electionDate = "2015-11-03";
    expect(() => normalizeApResults(historical, mapping, testContext())).toThrow("different election");
    const unknown = testData(); unknown.races[0].reportingUnits[0].candidates[0].candidateID = "9999999";
    expect(() => normalizeApResults(unknown, mapping, testContext())).toThrow("not mapped");
  });
});


describe("AP expected vote percentage from its response specification", () => {
  const enabled = () => context({ expectedVoteShareEnabled: true });
  it("keeps synthetic EEVP 85 independent of 100 percent precincts", () => {
    const synthetic = fixture("ap-synthetic-outside-election").races[0];
    const data = ap();
    Object.assign(data.races[0], { eevp: synthetic.eevp });
    data.races[0].reportingUnits[0].precinctsReportingPct = synthetic.reportingUnits[0].precinctsReportingPct;
    const race = normalizeApResults(data, mapping, enabled()).races[0];
    expect(race.expectedVoteShare).toBe(0.85);
    expect(race.reportingShare).toBeNull();
    expect(normalizeApResults(data, mapping, context()).races[0]).toMatchObject({ reportingShare: 100 });
    expect(normalizeApResults(data, mapping, context()).races[0]).not.toHaveProperty("expectedVoteShare");
  });
  it("prefers the selected New Jersey reporting unit estimate and preserves it through quiet delta caches", () => {
    const data = ap();
    Object.assign(data.races[0], { eevp: 85 });
    Object.assign(data.races[0].reportingUnits[0], { eevp: 70 });
    const first = normalizeApResults(data, mapping, enabled());
    expect(first.races[0].expectedVoteShare).toBe(0.7);
    const quiet = normalizeApResults({ nextrequest: data.nextrequest }, mapping, enabled(), electionApCache(first, mapping));
    expect(quiet.races[0].expectedVoteShare).toBe(0.7);
  });
  it("leaves absent or null EEVP unavailable, never substituting precinct percentage", () => {
    for (const eevp of [undefined, null]) {
      const data = ap(); Object.assign(data.races[0], { eevp });
      const race = normalizeApResults(data, mapping, enabled()).races[0];
      expect(race.reportingShare).toBeNull();
      expect(race).not.toHaveProperty("expectedVoteShare");
    }
  });
  it.each([0, 85, 99, 100])("converts AP percent %s to an explicit fraction", eevp => {
    const data = ap(); Object.assign(data.races[0], { eevp, ...(eevp === 100 ? { resultsType: "certified" } : {}) });
    expect(normalizeApResults(data, mapping, enabled()).races[0].expectedVoteShare).toBe(eevp / 100);
  });
  it.each([-1, 101, "85", NaN, Infinity])("holds malformed EEVP %s", eevp => {
    const data = ap(); Object.assign(data.races[0], { eevp });
    expect(() => normalizeApResults(data, mapping, enabled())).toThrow("invalid expected vote percentage");
  });
  it("does not fall back from a present null unit estimate to the race estimate", () => {
    const data = ap(); Object.assign(data.races[0], { eevp: 85 });
    Object.assign(data.races[0].reportingUnits[0], { eevp: null });
    const race = normalizeApResults(data, mapping, enabled()).races[0];
    expect(race).not.toHaveProperty("expectedVoteShare");
    expect(race.reportingShare).toBeNull();
  });
  it.each([-1, 101, "70", NaN, Infinity])("refuses malformed selected-unit EEVP %s despite a valid race fallback", eevp => {
    const data = ap(); Object.assign(data.races[0], { eevp: 85 });
    Object.assign(data.races[0].reportingUnits[0], { eevp });
    expect(() => normalizeApResults(data, mapping, enabled())).toThrow("invalid expected vote percentage");
  });
  it("drops a cached estimate when the reader gate is removed", () => {
    const data = ap(); Object.assign(data.races[0], { eevp: 85 });
    const cache = electionApCache(normalizeApResults(data, mapping, enabled()), mapping);
    const quiet = normalizeApResults({ nextrequest: data.nextrequest }, mapping, context(), cache);
    expect(quiet.races[0]).not.toHaveProperty("expectedVoteShare");
    expect(quiet.races[0].reportingShare).toBeNull();
    expect(cache.data.races[0].expectedVoteShare).toBe(0.85);
  });
  it("supports expected vote in isolated AP test mode without relaxing live refusal", () => {
    const data = ap(); data.races.forEach(race => Object.assign(race, { resultsType: "test", eevp: 85 }));
    const replay = { ...enabled(), now: "2026-10-31T14:01:00Z",
      apRehearsal: { sourceTimeOrigin: "2026-11-04T01:00:00Z", replayTimeOrigin: "2026-10-31T14:00:00Z" } };
    expect(normalizeApResults(data, mapping, replay).races[0]).toMatchObject({ expectedVoteShare: 0.85,
      reportingShare: null, asOf: "2026-10-31T14:00:00.000Z", sourceLabel: "REHEARSAL: AP 2026 test data; replay time" });
    expect(() => normalizeApResults(data, mapping, enabled())).toThrow("test");
  });
  it("keeps the existing twelve-column Sheet contract and legacy reporting values", () => {
    expect(ELECTION_SHEET_COLUMNS).toHaveLength(12);
    const data = normalizeSheetResults(sheet(), {}, enabled());
    expect(data.races.every(race => !Object.hasOwn(race, "expectedVoteShare"))).toBe(true);
    expect(data.races[0].reportingShare).toBe(50);
  });
});
