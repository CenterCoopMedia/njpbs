import type { ElectionResultsBlock } from "../../../../packages/content-core/src/content-model";

export const results: ElectionResultsBlock = { id: "result", type: "election_results", order: 0, visible: true,
  data: { races: [{ id: "sample", office: "Sample office", district: "Sample district", status: "awaiting",
    candidates: [{ id: "sample-candidate", name: "Sample candidate", votes: null, share: null },
      { id: "other-candidate", name: "Other sample candidate", votes: null, share: null }],
    sourceKind: "official", sourceLabel: "Sample official source", sourceUrl: "https://www.nj.gov/state/elections/",
    asOf: "2026-10-27T12:00:00.000Z", reportingShare: null }] } };
