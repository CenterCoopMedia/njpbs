import { describe, expect, it } from "vitest";
import { candidateBallotLabel, filterCandidates, groupRaces, parseElectionDirectory } from "../src/lib/election-directory";
import { electionFixture } from "./fixtures/election-directory";
import source from "./fixtures/resources/nj-election-2026.json";

describe("reviewed election directory", () => {
  it("requires all 21 county coverage entries and the statewide evidence note", () => {
    expect(parseElectionDirectory(electionFixture()).coverage).toHaveLength(22);
    const missing = electionFixture(); missing.coverage.pop(); expect(() => parseElectionDirectory(missing)).toThrow();
    const duplicate = electionFixture(); duplicate.coverage[0] = duplicate.coverage[1]; expect(() => parseElectionDirectory(duplicate)).toThrow();
  });
  it("keeps a page citation on its exact source document and rejects redirected attribution", () => {
    expect(parseElectionDirectory(electionFixture()).candidates[0].sourceUrl).toContain("#page=1");
    const bad = electionFixture(); bad.candidates[0].sourceUrl = "https://elsewhere.example/roster.pdf"; expect(() => parseElectionDirectory(bad)).toThrow();
    bad.candidates[0].sourceUrl = "javascript:alert(1)"; expect(() => parseElectionDirectory(bad)).toThrow();
  });
  it("rejects another election year, duplicate candidates and unknown source references", () => {
    const bad = electionFixture(); bad.electionDate = "2025-11-04"; expect(() => parseElectionDirectory(bad)).toThrow();
    const dup = electionFixture(); dup.candidates.push(dup.candidates[0]); expect(() => parseElectionDirectory(dup)).toThrow();
    const ref = electionFixture(); ref.candidates[0].sourceId = "missing"; expect(() => parseElectionDirectory(ref)).toThrow();
  });
  it("filters by verified ballot county and includes county-specific ballot labels in search", () => {
    const data = parseElectionDirectory(electionFixture());
    expect(filterCandidates(data, { query: "local ballot", county: "Bergen", level: "federal", party: "Independent" })).toHaveLength(1);
    expect(candidateBallotLabel(data.candidates[0], "Bergen")).toBe("Local ballot label");
    expect(candidateBallotLabel(data.candidates[0], "")).toBe("Local ballot label");
    data.candidates[0].office = "U.S. House"; data.candidates[0].counties = ["Bergen"];
    expect(filterCandidates(data, { query: "", county: "Cape May", level: "", party: "" })).toHaveLength(0);
  });
  it("separates full and unexpired contests and does not choose one conflicting seat count", () => {
    const row = parseElectionDirectory(electionFixture()).candidates[0];
    expect(groupRaces([row])[0].area).toBe("Statewide");
    expect(groupRaces([row, { ...row, id: "two", term: "Unexpired 1 year" }])).toHaveLength(2);
    expect(groupRaces([row, { ...row, id: "two", seats: "2" }])[0].seats).toBeNull();
  });
  it("validates the synthetic directory and preserves all expected jurisdictions and candidates", () => {
    const data = parseElectionDirectory(source);
    expect(data.coverage).toHaveLength(22); expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates.map(candidate => ({ id: candidate.id, level: candidate.level })))
      .toEqual([{ id: "candidate-one", level: "federal" }]);
  });
});
