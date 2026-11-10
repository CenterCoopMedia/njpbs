import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { ELECTION_CANDIDATE_DETAILS } from "../../packages/content-core/src/election-candidate-details";
import { renderElectionResults } from "../../packages/content-core/src/election-results-render";
import { normalizeRepoResults, parseElectionRoster } from "../../packages/content-core/src/election-result-sources";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import rosterFixture from "../fixtures/election-sources/roster.json";
import resultsFixture from "../fixtures/election-sources/repo-live.json";
import { electionBlock, electionRace } from "../fixtures/election-results";
const require = createRequire(import.meta.url);
const serverBlocks = require("../../functions/lib/content-blocks.js");
const compatibility = require("../../functions/lib/election-results-compatibility.js");
const roster = parseElectionRoster(rosterFixture);
const data = () => normalizeRepoResults(resultsFixture, { roster, raceIds: roster.races.map(race => race.id), now: "2026-11-04T01:01:00Z" });

describe("verified candidate link map and unchanged results data", () => {
  it("covers the real 39-candidate roster with its sourced campaign sites and incumbency", () => {
    expect(Object.keys(ELECTION_CANDIDATE_DETAILS).sort()).toEqual(roster.candidates.map(candidate => candidate.id).sort());
    expect(roster.candidates).toHaveLength(39);
    for (const candidate of roster.candidates) {
      const details = ELECTION_CANDIDATE_DETAILS[candidate.id];
      expect(details.incumbent).toBe(candidate.incumbent);
      expect(details.campaignWebsite ?? "").toBe(candidate.campaignWebsite);
      const profile = new URL(details.profileUrl);
      expect(profile.origin).toBe("https://www.njspotlightnews.org");
      expect(profile.username).toBe("");
      expect(profile.password).toBe("");
      if (candidate.raceId === "us-senate") expect(profile.pathname).toBe("/special-report/2026-primary-u-s-senate/");
      else {
        const district = Number(candidate.raceId.split("-").at(-1));
        const ordinal = ({ 1: "1st", 2: "2nd", 3: "3rd" } as Record<number, string>)[district] ?? `${district}th`;
        expect(profile.pathname).toContain(`${ordinal}-congressional-district/`);
      }
    }
  });
  it("renders each verified profile and available campaign site in both cards and table with stable focus keys", () => {
    const html = renderElectionResults("results", data());
    for (const race of roster.races) for (const id of race.candidateIds) {
      const details = ELECTION_CANDIDATE_DETAILS[id];
      for (const location of ["card", "table"]) {
        expect(html).toContain(`data-election-focus="${race.id}-${id}-${location}-profile" href="${details.profileUrl}" target="_blank" rel="noopener noreferrer"`);
        if (details.campaignWebsite) expect(html).toContain(`data-election-focus="${race.id}-${id}-${location}-campaign" href="${details.campaignWebsite}" target="_blank"`);
        else expect(html).not.toContain(`data-election-focus="${race.id}-${id}-${location}-campaign"`);
      }
    }
    expect(html).toContain("NJ Spotlight News profile (opens in new tab)");
    expect(html).toContain("Campaign website<span class=\"election-results__sr-only\"> for Cory Booker (opens in new tab)");
    const keys = [...html.matchAll(/data-election-focus="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(html.match(/class="election-results__incumbent"/g)).toHaveLength(roster.candidates.filter(candidate => candidate.incumbent).length);
  });
  it("adds no stored fields and keeps legacy readers and save boundaries compatible", () => {
    const input = data();
    const before = JSON.stringify(input);
    renderElectionResults("results", input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.keys(input)).toEqual(["races"]);
    expect(input.races.flatMap(race => race.candidates).every(candidate => Object.keys(candidate).every(key => ["id", "name", "party", "votes", "share"].includes(key)))).toBe(true);
    const block = { ...electionBlock(), data: JSON.parse(before) };
    expect(parseBlocks([block]).ok).toBe(true);
    expect(serverBlocks.parseBlocks([block])).toEqual(parseBlocks([block]));
    expect(compatibility.requiredElectionResultsVersion({ blocks: [block] })).toBe(1);
    expect(compatibility.supportsElectionResults({ blocks: [block] }, { electionResultsVersion: 1 })).toBe(true);
  });
  it("keeps unknown candidate identities as plain names and escapes their text", () => {
    const race = electionRace(); race.candidates[0].name = '<script>alert("x")</script>';
    const html = renderElectionResults("results", { races: [race] });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Campaign website");
    expect(html).not.toContain("NJ Spotlight News profile");
    expect(html).not.toContain('class="election-results__incumbent"');
  });
  it("provides a collapsed default explanation outside live count replacements", () => {
    const html = renderElectionResults("results", { races: [electionRace()] });
    const staticContent = html.split("<div data-election-results-content>")[0];
    expect(staticContent).toContain('<details class="election-results__explainer"><summary>How to read these results</summary>');
    expect(staticContent).toContain("A call is not official certification.");
    expect(staticContent).toContain("Expected vote counted estimates");
    expect(staticContent).toContain("corrections are made");
    expect(staticContent).toContain("update time in Eastern time");
  });
});
