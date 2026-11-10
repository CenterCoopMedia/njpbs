import { describe, expect, it } from "vitest";
import { parseBioCatalog, publicBioCard } from "../src/lib/bio-catalog";

export const bioFixture = { profileId: "example-official", kind: "person" as const, name: "Example Official",
  role: "State senator", party: "Democratic", area: "Legislative District 1", summary: "A sourced short biography.",
  sourceUrl: "https://example.org/official", sourceLabel: "Official biography", asOf: "2026-10-03" };

describe("public bio selection boundary", () => {
  it("copies only explicitly public fields from private catalog entries", () => {
    const source = { ...bioFixture, reviewStatus: "reviewed", internalSourceIds: ["internal-record-42"], internalNotes: "Never public",
      sources: [{ url: "https://example.org/proof", checkedAt: "2026-10-03", supports: ["name", "role"] }] };
    expect(publicBioCard(source)).toEqual(bioFixture);
    expect(JSON.stringify(publicBioCard(source))).not.toMatch(/internalSourceIds|internalNotes|reviewStatus|sources/);
  });
  it("requires reviewed, complete source-backed entries with unique identities", () => {
    const entry = { ...bioFixture, reviewStatus: "reviewed" };
    expect(parseBioCatalog({ schemaVersion: 1, profiles: [entry] }).profiles).toHaveLength(1);
    expect(parseBioCatalog({ schemaVersion: 1, profiles: [{ ...entry, sources: [
      { url: "https://example.org/proof", checkedAt: "2026-10-03", supports: ["role"] },
    ] }] }).profiles[0].sources).toHaveLength(1);
    for (const profiles of [[{ ...entry, reviewStatus: "draft" }], [{ ...entry, sourceUrl: "javascript:alert(1)" }],
      [{ ...entry, name: "" }], [{ ...entry, asOf: "2026-02-30" }], [entry, entry], [{ ...entry, financeNotes: "Private" }]]) {
      expect(() => parseBioCatalog({ schemaVersion: 1, profiles })).toThrow();
    }
  });
});
