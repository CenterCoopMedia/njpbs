import type { ElectionRace } from "../../packages/content-core/src/election-results";

export function electionRace(patch: Partial<ElectionRace> = {}): ElectionRace {
  return { id: "district-7", office: "U.S. House", district: "District 7", status: "counting",
    candidates: [{ id: "ellis", name: "Jordan Ellis", votes: 620, share: 62 },
      { id: "rivera", name: "Morgan Rivera", votes: 380, share: 38 }],
    sourceKind: "official", sourceLabel: "Example county election office", sourceUrl: "https://results.example.test/election",
    asOf: "2026-11-04T02:15:00.000Z", reportingShare: 75.5, ...patch };
}
export function electionBlock(race = electionRace()) {
  return { id: "results-block", type: "election_results" as const, order: 0, visible: true, data: { races: [race] } };
}
