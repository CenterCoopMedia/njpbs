// Synthetic measure for the approved #3865 contract. No production data.
export function datasetRelease() {
  return { label: "Synthetic employment rate", unit: "percent", value: 4.2,
    period: { start: "2026-09-01", end: "2026-09-30", label: "September 2026" },
    geography: { level: "state", code: "NJ", label: "New Jersey" }, adjustment: "seasonally_adjusted",
    points: [{ period: "2026-07-31", value: 4.1 }, { period: "2026-08-31", value: null, missingReason: "Not reported" }, { period: "2026-09-30", value: 4.2 }],
    chartText: "The synthetic rate is 4.2%. August is not reported. These values are for testing.",
    methodNote: "Synthetic monthly observations. No interpolation across missing data.", comparators: [],
    source: { publisher: "Example agency", title: "Synthetic monthly release", url: "https://example.test/data", seriesId: "example-rate" },
    releasedOn: "2026-10-15", verifiedOn: "2026-10-16", changeKind: "new_release", changeNote: "",
    reuse: { display: "allowed", exports: "denied", evidence: "Synthetic rights fixture", note: "Example agency" } };
}
