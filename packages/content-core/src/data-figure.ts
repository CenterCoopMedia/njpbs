import { validDatasetId, type DatasetRelease } from "./datasets.ts";

export type DataFigureVersion =
  | { mode: "pinned"; releaseId: string }
  | { mode: "latestApproved" };

export interface DataFigureData {
  datasetId: string;
  version: DataFigureVersion;
  display: "compact" | "expanded";
}

export interface DatasetPublicProjection {
  datasetId: string;
  releaseId: string;
  revision: number;
  digest: string;
  approvedAt: string;
  release: Omit<DatasetRelease, "reuse" | "nextReviewOn"> & {
    reuse: {
      display: "allowed";
      exports: "unknown" | "allowed" | "denied";
      note: string;
    };
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function isDraftId(value: unknown, complete: boolean): value is string {
  return typeof value === "string" && ((!complete && value === "") || validDatasetId(value));
}

/** Strict block-data boundary. Empty ids are retained only while a draft is incomplete. */
export function isDataFigureData(value: unknown, complete = false): value is DataFigureData {
  if (!isObject(value) || !hasOnlyFields(value, ["datasetId", "version", "display"]) ||
    !isDraftId(value.datasetId, complete) ||
    (value.display !== "compact" && value.display !== "expanded") ||
    !isObject(value.version)) return false;

  if (value.version.mode === "latestApproved") {
    return hasOnlyFields(value.version, ["mode"]);
  }
  if (value.version.mode === "pinned") {
    return hasOnlyFields(value.version, ["mode", "releaseId"]) &&
      isDraftId(value.version.releaseId, complete);
  }
  return false;
}
