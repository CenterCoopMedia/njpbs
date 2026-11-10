import { describe, expect, it } from "vitest";
import { emptyDatasetRelease, validateDatasetRelease } from "../packages/content-core/src/datasets";
import { datasetRelease } from "./fixtures/dataset-release";
import { can } from "../packages/content-core/src/rbac";

describe("dataset release trust boundary", () => {
  it("requires a global approval grant and keeps the Editor access level draft-only", () => {
    for (const tier of ["viewer", "contributor", "editor"] as const) expect(can({ id: "staff", grants: [{ role: "editor", tier }] }, "datasets.approve", {})).toBe(false);
    for (const tier of ["publisher", "admin", "owner"] as const) expect(can({ id: "staff", grants: [{ role: "editor", tier }] }, "datasets.approve", {})).toBe(true);
    expect(can({ id: "staff", grants: [{ role: "editor", sections: ["news"] }] }, "datasets.approve", { section: "news" })).toBe(false);
    expect(can({ id: "staff", grants: [{ role: "editor" }] }, "datasets.approve", {})).toBe(true);
  });
  it("keeps incomplete drafts separate from approved data", () => {
    expect(() => validateDatasetRelease(emptyDatasetRelease())).not.toThrow();
    expect(() => validateDatasetRelease(emptyDatasetRelease(), { complete: true })).toThrow();
    expect(() => validateDatasetRelease(datasetRelease(), { complete: true })).not.toThrow();
  });
  it.each([
    ["forged approval", release => { release.approvedBy = "client"; }],
    ["forged revision", release => { release.revision = 40; }],
    ["impossible date", release => { release.period.end = "2026-02-30"; }],
    ["reversed period", release => { release.period.start = "2026-10-01"; }],
    ["unbounded percentage", release => { release.value = 101; }],
    ["nonfinite number", release => { release.points[0].value = Infinity; }],
    ["unexplained gap", release => { delete release.points[1].missingReason; }],
    ["duplicate period", release => { release.points[1].period = release.points[0].period; }],
    ["too many observations", release => { release.points = Array.from({ length: 241 }, () => release.points[0]); }],
    ["script URL", release => { release.source.url = "javascript:alert(1)"; }],
    ["credential URL", release => { release.source.url = "https://user:synthetic@example.test/data"; }],
    ["unapproved rights", release => { release.reuse.display = "unknown"; }],
    ["missing rights evidence", release => { release.reuse.evidence = ""; }],
    ["unexplained correction", release => { release.changeKind = "correction"; }],
    ["missing chart text", release => { release.chartText = ""; }],
    ["unrecognized geography", release => { release.geography.level = "unknown"; }],
  ] as const)("refuses %s", (_name, change) => {
    const release: any = datasetRelease();
    change(release);
    expect(() => validateDatasetRelease(release, { complete: true })).toThrow();
  });
  it("requires compatible units and reviewed differences in comparison context", () => {
    const release = datasetRelease();
    const comparison = { label: "National rate", value: 4, unit: "percent", period: release.period,
      geography: { level: "nation", code: "US", label: "United States" }, adjustment: release.adjustment,
      source: release.source, comparisonNote: "" };
    release.comparators.push(comparison);
    expect(() => validateDatasetRelease(release, { complete: true })).toThrow(/comparisonNote/);
    comparison.comparisonNote = "This compares New Jersey with the national population in the same period.";
    expect(() => validateDatasetRelease(release, { complete: true })).not.toThrow();
    comparison.unit = "people";
    expect(() => validateDatasetRelease(release, { complete: true })).toThrow(/same unit/);
  });
  it("allows negative percentage changes and refuses release-sized text abuse", () => {
    const release = datasetRelease();
    release.unit = "percent_change"; release.value = -12;
    expect(() => validateDatasetRelease(release, { complete: true })).not.toThrow();
    release.points = Array.from({ length: 240 }, (_, index) => ({ period: "2026-01-01", value: null, missingReason: "x".repeat(1000) }));
    expect(() => validateDatasetRelease(release)).toThrow(/200 KiB/);
  });
});
