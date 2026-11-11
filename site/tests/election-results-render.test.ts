import { describe, expect, it } from "vitest";
import { renderElectionResults } from "../../packages/content-core/src/election-results-render";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { renderBlock } from "../../packages/content-core/src/content-render";
import type { ElectionResultsData } from "../../packages/content-core/src/election-results";
import hub from "./fixtures/election-results-hub.json";

export function renderHub(data = hub.data as ElectionResultsData, publicResults = true) {
  const parsed = parseBlocks([{ ...hub, data }]);
  if (!parsed.ok) throw new Error(parsed.error);
  document.body.innerHTML = renderBlock(parsed.blocks[0], { publicElectionResults: publicResults })!;
  return document.querySelector<HTMLElement>(".election-results")!;
}

describe("Published hub election results contract", () => {
  it("withholds live reader controls and CSV from unqualified or private block renders", () => {
    const parsed = parseBlocks([hub]);
    if (!parsed.ok) throw new Error(parsed.error);
    for (const html of [renderBlock(parsed.blocks[0]), renderBlock(parsed.blocks[0], { publicElectionResults: false })]) {
      document.body.innerHTML = html!;
      expect(document.querySelector("[data-election-download]")).toBeNull();
      expect(document.querySelector("template[data-election-csv]")).toBeNull();
      expect(document.querySelector("[data-election-live]")).toBeNull();
      expect(document.querySelectorAll("article")).toHaveLength(13);
    }
  });
  it("provides 13 unique native race anchors, including Senate and CD 1–12", () => {
    const root = renderHub();
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("[data-election-jump]"));
    expect(links.map(link => link.textContent)).toEqual(["Senate", ...Array.from({ length: 12 }, (_, i) => `CD ${i + 1}`)]);
    expect(new Set(links.map(link => link.hash)).size).toBe(13);
    for (const link of links) {
      const target = document.getElementById(link.hash.slice(1));
      expect(target?.closest("article")).not.toBeNull();
      expect(target?.getAttribute("tabindex")).toBe("-1");
    }
  });
  it("renders the recorded 13 races and 39 candidates with a single dash and readable unknown label for each number", () => {
    const root = renderHub();
    expect(root.dataset.electionResults).toBe("97679801-b710-4fc7-8e15-a422faaaff1a");
    expect(root.querySelectorAll("article")).toHaveLength(13);
    expect(root.querySelectorAll(".election-results__candidate")).toHaveLength(39);
    expect(root.querySelectorAll(".election-results__status")).toHaveLength(13);
    for (const status of root.querySelectorAll(".election-results__status")) expect(status.textContent).toBe("Awaiting results");
    for (const value of root.querySelectorAll(".election-results__counts > p, td:nth-child(3), td:nth-child(4)")) {
      expect(value.querySelector('[aria-hidden="true"]')?.textContent).toBe("—");
      expect(value.querySelector(".election-results__sr-only")?.textContent).toBe("Not reported");
    }
    expect(root.querySelectorAll("table caption")).toHaveLength(13);
    expect(root.querySelectorAll("tbody th[scope=row]")).toHaveLength(39);
    expect(root.querySelectorAll(".election-results__bar")).toHaveLength(0);
  });
  it("keeps reported zero distinct from an unknown count and escapes public text", () => {
    const data = structuredClone(hub.data) as ElectionResultsData;
    data.races = [data.races[0]];
    data.races[0].status = "counting";
    data.races[0].candidates = data.races[0].candidates.map(candidate => ({ ...candidate, votes: 0, share: 0 }));
    data.races[0].candidates[0].name = '<script>alert("x")</script>';
    const root = renderHub(data);
    expect(root.querySelector(".election-results__votes")?.textContent).toBe("0 votes");
    expect(root.querySelector(".election-results__share")?.textContent).toBe("0%");
    expect(root.querySelector("script")).toBeNull();
    expect(renderElectionResults(hub.id, { races: [] })).toContain("not available");
  });
  it("marks only the AP-called winner with a check and keeps the AP credit and table label", () => {
    const data = structuredClone(hub.data) as ElectionResultsData;
    const race = data.races[0];
    race.status = "called";
    race.calledCandidateId = race.candidates[0].id;
    race.apCallUrl = "https://apnews.com/hub/election-2026";
    race.candidates = race.candidates.map((candidate, index) => ({ ...candidate, votes: index === 0 ? 100 : 0, share: index === 0 ? 100 : 0 }));
    const root = renderHub(data);
    expect(root.querySelectorAll(".election-results__winner-check")).toHaveLength(1);
    expect(root.querySelector(".election-results__winner-check")?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector(".election-results__winner")?.textContent).toBe("Winner");
    expect(root.querySelector(".election-results__ap a")?.textContent).toBe("Race called by The Associated Press");
    expect(root.querySelector("tbody th")?.textContent).toContain("Winner; AP called this race");
  });
  it("exports only the displayed public snapshot, with unknown counts blank and identities omitted", () => {
    const root = renderHub();
    const payload = root.querySelector<HTMLTemplateElement>("template[data-election-csv]");
    expect(payload).not.toBeNull();
    const csv = payload!.content.textContent!;
    expect(csv.startsWith('\uFEFF"Office","District","Status","Candidate","Party","Votes","Share (%)","Reporting (%)","Expected vote counted (fraction)","Source","Source URL","Source updated (ISO 8601)","AP called winner","AP call URL"\r\n')).toBe(true);
    expect(csv).toContain('"U.S. Senate","New Jersey","Awaiting results","Cory Booker","Democratic","","","","","The Associated Press","https://apnews.com/hub/election-2026","2026-11-03T01:14:17.868Z","",""\r\n');
    expect(csv.split("\r\n")).toHaveLength(41); // Header + 39 public candidates + trailing newline.
    for (const race of hub.data.races) {
      expect(csv).not.toContain(race.id);
      for (const candidate of race.candidates) expect(csv).not.toContain(candidate.id);
    }
    expect(root.querySelector("[data-election-download]")?.textContent).toContain("Download CSV");
    expect(root.querySelector<HTMLElement>("[data-election-download]")?.hidden).toBe(true);
    expect(root.querySelector("[data-election-download]")?.textContent).toContain("All races, including those hidden by filters. Unknown values are blank.");
  });
  it("keeps exact numbers, source time and AP calls while escaping spreadsheet formulas and CSV delimiters", () => {
    const data = structuredClone(hub.data) as ElectionResultsData;
    const race = data.races[0];
    data.races = [race];
    race.status = "called";
    race.calledCandidateId = race.candidates[0].id;
    race.apCallUrl = "https://apnews.com/hub/election-2026";
    race.expectedVoteShare = 0.5;
    race.candidates = race.candidates.slice(0, 2).map((candidate, index) => ({
      ...candidate, votes: index === 0 ? 1000 : 0, share: index === 0 ? 100 : 0,
    }));
    race.candidates[0].name = '=HYPERLINK("https://example.test","x")';
    race.candidates[1].party = "  @SUM(1,2)";
    race.office = "+Office";
    race.district = "-District";
    const root = renderHub(data);
    const payload = root.querySelector<HTMLTemplateElement>("template[data-election-csv]");
    expect(payload).not.toBeNull();
    const csv = payload!.content.textContent!;
    expect(csv).toContain(`"'+Office","'-District","AP race call","'=HYPERLINK(""https://example.test"",""x"")","Democratic","1000","100","","0.5","The Associated Press","https://apnews.com/hub/election-2026","2026-11-03T01:14:17.868Z","Yes","https://apnews.com/hub/election-2026"\r\n`);
    expect(csv).toContain(`"Justin Murphy","'  @SUM(1,2)","0","0"`);
    expect(root.querySelector("tbody th")?.textContent).toContain(race.candidates[0].name);
    expect(root.querySelector("tbody td:nth-child(3)")?.textContent).toBe("1,000");
    expect(root.querySelector(".election-results__votes")?.textContent).toBe("1,000 votes");
  });
});
