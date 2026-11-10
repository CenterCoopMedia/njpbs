import type { ElectionResultsData, ElectionCandidate } from "../../../packages/content-core/src/election-results";
import type { ElectionRoster, ElectionSourceMode, ElectionSheetMapping } from "../../../packages/content-core/src/election-result-sources";
import { postFunction } from "./functions";

export interface ElectionSourceTarget { collection: "cmsPages" | "cmsPosts"; documentId: string; blockId: string }
export interface ElectionSourceConfig {
  source: { kind: "repo" } | { kind: "sheet"; spreadsheetId: string; tab: string; columns: ElectionSheetMapping }
    | { kind: "ap"; mapping: Record<string, { raceId: string; candidateIds: Record<string, string> }> };
  raceIds: string[]; mode: ElectionSourceMode; maxAgeSeconds: number; photos?: Record<string, NonNullable<ElectionCandidate["photo"]>>;
}
export interface ElectionSourceConnection {
  config: ElectionSourceConfig; version: number; configRevision: number; authorizedConfigRevision: number | null; paused: boolean;
  lastCheckAt: string | null; lastSourceSuccessAt: string | null; lastGoodAt: string | null;
  lastGoodData: ElectionResultsData | null; lastGoodDigest: string | null;
  lastHoldReason: { code: string; message: string; at: string } | null;
  lastSchedulingReason?: { code: string; message: string; at: string } | null;
  pendingStatuses: string[]; pendingDigest: string | null; pendingData: ElectionResultsData | null;
}
export interface ElectionSourceState {
  documentVersion?: number; publicData?: ElectionResultsData | null;
  connection: ElectionSourceConnection | null; canManage: boolean; canConnect: boolean;
  roster?: ElectionRoster | null; rosterError?: string;
}
export type ElectionSourceMutation = { action: "connect"; baseVersion: number; contentVersion: number; config: ElectionSourceConfig }
  | { action: "approve" | "pause" | "resume"; baseVersion: number }
  | { action: "status"; baseVersion: number; pendingDigest: string };
export interface ElectionSourceApi {
  get(target: ElectionSourceTarget, includeRoster: boolean, signal?: AbortSignal): Promise<ElectionSourceState>;
  mutate(target: ElectionSourceTarget, request: ElectionSourceMutation): Promise<{ connection: ElectionSourceConnection }>;
}
export function electionSourceApi(getToken: () => Promise<string>): ElectionSourceApi {
  return {
    get: async (target, includeRoster, signal) => postFunction("cmsElectionResultsSources", await getToken(),
      { action: "get", ...target, includeRoster }, {}, { signal, operation: "content-list" }),
    mutate: async (target, request) => postFunction("cmsElectionResultsSources", await getToken(),
      { ...target, ...request }, {}, { operation: "content-write" }),
  };
}
