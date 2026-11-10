/** Private dataset input contract. Approved revisions and digests are server-owned. */
export const DATASET_COLLECTION = "cmsDatasets";
export const MAX_DATASET_BYTES = 200 * 1024;
export const DATASET_UNITS = ["percent", "percent_change", "percentage_points", "number", "jobs", "people", "usd", "usd_month", "usd_hour", "usd_billion", "cents_kwh", "inches", "fahrenheit"] as const;
export const DATASET_ADJUSTMENTS = ["seasonally_adjusted", "not_seasonally_adjusted", "not_applicable"] as const;
export const DATASET_GEOGRAPHIES = ["nation", "state", "county", "municipality", "metro"] as const;
export const DATASET_RIGHTS = ["unknown", "allowed", "denied"] as const;
export type DatasetUnit = typeof DATASET_UNITS[number];
export interface DatasetPeriod { start: string; end: string; label: string }
export interface DatasetGeography { level: typeof DATASET_GEOGRAPHIES[number]; code: string; label: string }
export interface DatasetSource { publisher: string; title: string; url: string; seriesId?: string }
export interface DatasetPoint { period: string; value: number | null; missingReason?: string }
export interface DatasetComparator {
  label: string; unit: DatasetUnit; value: number; period: DatasetPeriod;
  geography: DatasetGeography; adjustment: typeof DATASET_ADJUSTMENTS[number];
  source: DatasetSource; comparisonNote: string;
}
export interface DatasetRelease {
  label: string; unit: DatasetUnit; value: number; period: DatasetPeriod;
  geography: DatasetGeography; adjustment: typeof DATASET_ADJUSTMENTS[number];
  points: DatasetPoint[]; chartText: string; methodNote: string; comparators: DatasetComparator[];
  source: DatasetSource; releasedOn: string; verifiedOn: string; nextReviewOn?: string;
  changeKind: "new_release" | "correction"; changeNote: string;
  reuse: { display: typeof DATASET_RIGHTS[number]; exports: typeof DATASET_RIGHTS[number]; evidence: string; note: string };
}
export interface DatasetRecord {
  id: string; title: string; ownerUid: string; version: number; archived: boolean;
  ownerName?: string;
  state: "draft" | "review" | "approved"; workingRelease: DatasetRelease;
  workingReleaseId: string; approvedReleaseId: string | null;
  updatedAt: string; updatedBy: string;
  canEdit: boolean; canApprove: boolean;
  refreshJobId?: string; refreshStatus?: "preparing" | "pending" | "partial" | "success";
}
export class DatasetError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
export function validDatasetId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function fail(path: string, message: string): never { throw new DatasetError(`${path}: ${message}`); }
function fields(value: unknown, keys: string[], path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "Use an object.");
  if (Object.keys(value).some(key => !keys.includes(key))) fail(path, "Unknown field.");
}
function text(value: unknown, limit: number, path: string, required = true): asserts value is string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) fail(path, `Use ${required ? "1" : "0"} to ${limit} characters.`);
}
function choice(value: unknown, choices: readonly string[], path: string) {
  if (typeof value !== "string" || !choices.includes(value)) fail(path, "Choose a listed value.");
}
function date(value: unknown, path: string, required: boolean) {
  if (value === "" && !required) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(path, "Use a real ISO date.");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(path, "Use a real ISO date.");
}
function number(value: unknown, unit: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15) fail(path, "Use a finite number within 1 quadrillion.");
  if (unit === "percent" && (value < 0 || value > 100)) fail(path, "A proportion must be between 0 and 100.");
}
function period(value: unknown, path: string, complete: boolean) {
  fields(value, ["start", "end", "label"], path);
  date(value.start, `${path}.start`, complete); date(value.end, `${path}.end`, complete);
  text(value.label, 120, `${path}.label`, complete);
  if (value.start && value.end && String(value.start) > String(value.end)) fail(path, "Start must be on or before end.");
}
function geography(value: unknown, path: string, complete: boolean) {
  fields(value, ["level", "code", "label"], path);
  choice(value.level, DATASET_GEOGRAPHIES, `${path}.level`);
  text(value.code, 32, `${path}.code`, complete); text(value.label, 240, `${path}.label`, complete);
  const patterns: Record<string, RegExp> = { nation: /^[A-Z]{2}$/, state: /^[A-Z]{2}$/, county: /^\d{5}$/, municipality: /^\d{10}$/, metro: /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/ };
  if (value.code && !patterns[String(value.level)].test(String(value.code))) fail(`${path}.code`, "Use the geographic identifier for this level.");
}
function source(value: unknown, path: string, complete: boolean) {
  fields(value, ["publisher", "title", "url", "seriesId"], path);
  text(value.publisher, 300, `${path}.publisher`, complete); text(value.title, 300, `${path}.title`, complete);
  text(value.url, 2000, `${path}.url`, complete);
  if (value.url) {
    let url: URL;
    try { url = new URL(value.url); } catch { fail(`${path}.url`, "Use an HTTPS address."); }
    if (url.protocol !== "https:" || url.username || url.password || /[\s\\\u0000-\u001f\u007f]/.test(value.url)) fail(`${path}.url`, "Use a credential-free HTTPS address.");
  }
  if (value.seriesId !== undefined) text(value.seriesId, 120, `${path}.seriesId`, false);
}
/** The same strict input boundary is used by the form and the trusted API. */
export function validateDatasetRelease(value: unknown, { complete = false }: { complete?: boolean } = {}): asserts value is DatasetRelease {
  fields(value, ["label", "unit", "value", "period", "geography", "adjustment", "points", "chartText", "methodNote", "comparators", "source", "releasedOn", "verifiedOn", "nextReviewOn", "changeKind", "changeNote", "reuse"], "release");
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_DATASET_BYTES) fail("release", "The release exceeds 200 KiB.");
  text(value.label, 300, "label", complete); choice(value.unit, DATASET_UNITS, "unit"); number(value.value, value.unit, "value");
  period(value.period, "period", complete); geography(value.geography, "geography", complete);
  choice(value.adjustment, DATASET_ADJUSTMENTS, "adjustment"); source(value.source, "source", complete);
  text(value.chartText, 2000, "chartText", complete); text(value.methodNote, 4000, "methodNote", complete);
  date(value.releasedOn, "releasedOn", complete); date(value.verifiedOn, "verifiedOn", complete);
  if (value.nextReviewOn !== undefined) date(value.nextReviewOn, "nextReviewOn", false);
  if (value.verifiedOn && value.releasedOn && String(value.verifiedOn) < String(value.releasedOn)) fail("verifiedOn", "Verification cannot precede the release.");
  choice(value.changeKind, ["new_release", "correction"], "changeKind");
  text(value.changeNote, 2000, "changeNote", complete && value.changeKind === "correction");
  if (!Array.isArray(value.points) || value.points.length > 240 || (complete && !value.points.length)) fail("points", "Use 1 to 240 ordered observations.");
  let previous = "";
  for (const [index, point] of value.points.entries()) {
    const path = `points.${index}`;
    fields(point, ["period", "value", "missingReason"], path); date(point.period, `${path}.period`, true);
    if (String(point.period) <= previous) fail(path, "Periods must be unique and in date order.");
    previous = String(point.period);
    if (point.value === null) text(point.missingReason, 500, `${path}.missingReason`);
    else {
      number(point.value, value.unit, `${path}.value`);
      if (point.missingReason !== undefined) fail(path, "Only a missing observation has a missing-data reason.");
    }
  }
  if (!Array.isArray(value.comparators) || value.comparators.length > 3) fail("comparators", "Use at most three comparisons.");
  for (const [index, comparator] of value.comparators.entries()) {
    const path = `comparators.${index}`;
    fields(comparator, ["label", "unit", "value", "period", "geography", "adjustment", "source", "comparisonNote"], path);
    text(comparator.label, 300, `${path}.label`, complete);
    if (comparator.unit !== value.unit) fail(path, "Comparisons must use the same unit.");
    number(comparator.value, comparator.unit, `${path}.value`); period(comparator.period, `${path}.period`, complete);
    geography(comparator.geography, `${path}.geography`, complete); source(comparator.source, `${path}.source`, complete);
    choice(comparator.adjustment, DATASET_ADJUSTMENTS, `${path}.adjustment`);
    const primaryPeriod = value.period as unknown as DatasetPeriod;
    const comparisonPeriod = comparator.period as unknown as DatasetPeriod;
    const mismatch = comparator.adjustment !== value.adjustment ||
      (comparator.geography as unknown as DatasetGeography).code !== (value.geography as unknown as DatasetGeography).code ||
      (comparator.geography as unknown as DatasetGeography).level !== (value.geography as unknown as DatasetGeography).level ||
      comparisonPeriod.start !== primaryPeriod.start || comparisonPeriod.end !== primaryPeriod.end;
    text(comparator.comparisonNote, 2000, `${path}.comparisonNote`, complete && mismatch);
  }
  fields(value.reuse, ["display", "exports", "evidence", "note"], "reuse");
  choice(value.reuse.display, DATASET_RIGHTS, "reuse.display"); choice(value.reuse.exports, DATASET_RIGHTS, "reuse.exports");
  text(value.reuse.evidence, 2000, "reuse.evidence", value.reuse.display === "allowed" || value.reuse.exports === "allowed");
  text(value.reuse.note, 2000, "reuse.note", false);
  if (complete && value.reuse.display !== "allowed") fail("reuse.display", "Clear display rights before approval.");
}
export function emptyDatasetRelease(): DatasetRelease {
  return { label: "", unit: "number", value: 0, period: { start: "", end: "", label: "" },
    geography: { level: "state", code: "NJ", label: "New Jersey" }, adjustment: "not_applicable",
    points: [], chartText: "", methodNote: "", comparators: [], source: { publisher: "", title: "", url: "" },
    releasedOn: "", verifiedOn: "", changeKind: "new_release", changeNote: "",
    reuse: { display: "unknown", exports: "unknown", evidence: "", note: "" } };
}
