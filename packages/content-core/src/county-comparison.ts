/** Reviewed, immutable dataset identity; new data requires a new version. */
export const COUNTY_COMPARISON_VERSION = "nj-federal-counties-2020-2024-v1";

export interface CountyComparisonData {
  datasetVersion: typeof COUNTY_COMPARISON_VERSION;
  heading: string;
  intro: string;
  source: string;
}

export const COUNTY_COMPARISON_DEFAULTS: CountyComparisonData = {
  datasetVersion: COUNTY_COMPARISON_VERSION,
  heading: "",
  intro: "",
  source: "",
};

export function isCountyComparisonData(value: unknown): value is CountyComparisonData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Reflect.ownKeys(data).every(key => typeof key === "string" &&
    ["datasetVersion", "heading", "intro", "source"].includes(key)) &&
    data.datasetVersion === COUNTY_COMPARISON_VERSION &&
    typeof data.heading === "string" && data.heading.length <= 300 &&
    typeof data.intro === "string" && data.intro.length <= 4000 &&
    typeof data.source === "string" && data.source.length <= 1000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.heading + data.intro + data.source);
}
