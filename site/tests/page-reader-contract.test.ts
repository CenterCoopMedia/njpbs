import { expect, it } from "vitest";
import { BLOCK_TYPES, parseBlocks } from "../../packages/content-core/src/content-model";
import { validateSection } from "../../packages/content-core/src/editor-admin";
import contract from "../../functions/lib/page-reader-contract.js";
const cases = [
  { type: "county_comparison", data: { datasetVersion: "nj-federal-counties-2020-2024-v1", heading: "", intro: "", source: "" } },
  { type: "town_lookup", data: { heading: "Past results", introduction: "", sourceLine: "NJ Spotlight News" } },
  { type: "embed", data: { url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html" } },
];
it.each(cases)("requires contract 1 for $type, including its hidden saved form", ({ type, data }) => {
  for (const visible of [true, false]) {
    const blocks = [{ id: "reader-window", type, order: 0, visible, data }];
    const current = parseBlocks(blocks);
    expect(current.ok).toBe(true);
    if (current.ok) expect(validateSection("genericPage", current.blocks)).toBe(null);
    expect(contract.pageReaderSupports(blocks, "contact", 0)).toBe(false);
    expect(contract.pageReaderSupports(blocks, "contact", 1)).toBe(true);
  }
});
it("pins every supported plank type and refuses unknown contract versions and future types", () => {
  expect([...contract.PAGE_BLOCK_TYPES].sort()).toEqual([...BLOCK_TYPES].sort());
  expect(contract.pageReaderSupports([{ type: "headline" }], "contact", 0)).toBe(true);
  expect(contract.pageReaderSupports([{ type: "headline" }], "contact", 2)).toBe(false);
  expect(contract.pageReaderSupports([{ type: "future" }], "contact", 1)).toBe(false);
  for (const pageId of ["contact", "data-hub", `page-${"a".repeat(32)}`]) {
    expect(contract.pageReaderSupports([{ type: "embed", visible: false, data: { url: "https://www.youtube.com/watch?v=abcdef12345" } }], pageId, 0)).toBe(false);
  }
  for (const pageId of ["home", "watch"]) expect(contract.pageReaderSupports([{ type: "embed" }], pageId, 0)).toBe(true);
  // Expected-vote election data keeps its independent version-2 contract.
  expect(contract.requiredPageReaderVersion([{ type: "election_results", data: { races: [{ expectedVoteShare: 0.8 }] } }], "contact")).toBe(0);
});
