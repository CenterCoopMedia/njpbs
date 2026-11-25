import { HUB_ELECTRICITY_SERIES, HUB_ELECTRICITY_SOURCE, HUB_ELECTRICITY_US_SERIES } from "../../../packages/content-core/src/data-hub-electricity";
import type { DatasetPublicProjection } from "../../../packages/content-core/src/data-figure";

// Synthetic prices. No source data.
const nation = { level: "nation" as const, code: "US", label: "United States" };
const month = (value: string) => ({ start: `${value}-01`, end: new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5)), 0)).toISOString().slice(0, 10), label: value });
const source = { publisher: "U.S. Energy Information Administration", title: "Electric Power Monthly, Table 5.6.A", url: HUB_ELECTRICITY_SOURCE, seriesId: HUB_ELECTRICITY_SERIES };
type Prices = { now: [string, number, number]; before: [string, number, number] };
export function electricityProjection(prices: Prices = { now: ["2027-02", 31.25, 18.4], before: ["2026-02", 33, 18.9] }): DatasetPublicProjection {
  const [period, nj, us] = prices.now, [prior, njBefore, usBefore] = prices.before;
  const compared = (value: number, when: string) => ({ label: "U.S.", unit: "cents_kwh" as const, value, period: month(when), geography: nation,
    adjustment: "not_seasonally_adjusted" as const, source: { ...source, seriesId: HUB_ELECTRICITY_US_SERIES }, comparisonNote: "Same table and sector." });
  return { datasetId: "electricity-price", releaseId: "release-1", revision: 1, digest: "a".repeat(64), approvedAt: "2027-04-26T02:00:00.000Z",
    release: { label: "Residential electricity price", unit: "cents_kwh", value: nj, period: month(period),
      geography: { level: "state", code: "NJ", label: "New Jersey" }, adjustment: "not_seasonally_adjusted",
      points: [{ period: `${prior}-01`, value: njBefore }, { period: `${period}-01`, value: nj }],
      comparators: [compared(us, period), compared(usBefore, prior)], chartText: "Two matched months.", methodNote: "Average price <per> kWh.",
      source, releasedOn: "2027-04-24", verifiedOn: "2027-04-25", changeKind: "new_release", changeNote: "",
      reuse: { display: "allowed", exports: "allowed", note: "Example <credit>" } } };
}
