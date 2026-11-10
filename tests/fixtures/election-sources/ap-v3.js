import { readFileSync } from "node:fs";

// Shape derived from private November 2 v3.2 captures. IDs, counts and times
// are synthetic. No raw capture is committed. Both captures omit winner.
export function apV3Fixture(kind = "live") {
  const value = JSON.parse(readFileSync(new URL("./ap-v3-live-b.json", import.meta.url), "utf8"));
  if (kind === "live") return value;
  for (const race of value.races) {
    race.tabulationStatus = "Active Tabulation";
    race.eevp = 90.71;
    const unit = race.reportingUnits[0];
    Object.assign(unit, { eevp: 90.71, precinctsReporting: 490, precinctsReportingPct: 90.57 });
    unit.candidates.forEach((candidate, index) => { candidate.voteCount = (index + 1) * 100; });
    unit.candidates.reverse(); // IDs, never the AP array order, bind to roster.
    if (kind === "test") {
      Object.assign(race, { eventID: "20261103_ET_synthetic", test: true, resultsType: "test" });
      unit.lastUpdated = "2026-11-04T04:00:00.258413Z";
      delete unit.bestSources;
    } else {
      // AP docs: raceCallStatus is informational; candidate winner=X identifies
      // the winner. A winner need not currently lead the vote count.
      race.raceCallStatus = "Winner Not Leading";
      unit.candidates.find(candidate => Number(candidate.candidateID) % 10 === 0).winner = "X";
      unit.candidates.find(candidate => Number(candidate.candidateID) % 10 === 0).winnerDateTime = "2026-11-04T02:59:00.999999Z";
    }
  }
  if (kind === "test") {
    value.timestamp = "2026-11-04T04:00:01.128427Z";
    value.nextrequest = value.nextrequest.replace("resultstype=b", "resultstype=t");
  }
  return value;
}
