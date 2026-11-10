import type { DataFigureVersion, DatasetPublicProjection } from "../../../packages/content-core/src/data-figure";
import type { DatasetRecord, DatasetRelease } from "../../../packages/content-core/src/datasets";
import { postFunction } from "./functions";

export type DatasetSummary = Omit<DatasetRecord, "workingRelease" | "workingReleaseId" | "updatedBy">;
export interface DatasetUse { title: string; publicPath?: string; policy: string }
export interface DatasetRefreshSummary { owners: { title: string; status: string; error: string | null }[]; id: string; status: "preparing" | "pending" | "partial" | "success"; expectedUseCount: number; expectedOwnerCount: number; verifiedOwnerCount: number; supersededOwnerCount: number; failedOwnerCount: number; receipt: unknown }
export interface DatasetApi {
  refresh(id: string): Promise<{ refresh: DatasetRefreshSummary | null }>;
  retry(id: string): Promise<{ refresh: DatasetRefreshSummary | null }>;
  figure(input: { id: string; version: DataFigureVersion }): Promise<DatasetPublicProjection>;
  list(cursor?: string, approvedOnly?: boolean): Promise<{ datasets: DatasetSummary[]; nextCursor: string | null }>;
  get(id: string): Promise<{ dataset: DatasetRecord; useCount: number; affectedUseCount?: number; uses?: DatasetUse[] }>;
  releases(id: string, cursor?: string): Promise<{ releases: { id: string; label: string; releasedOn: string; approvedRevision: number }[]; hasMore: boolean; nextCursor?: string | null }>;
  release(id: string, releaseId: string): Promise<{ release: DatasetRelease }>;
  owners(cursor?: string): Promise<{ owners: { uid: string; name: string }[]; nextCursor: string | null }>;
  assign(input: { id: string; baseVersion: number; ownerUid: string; requestId: string }): Promise<{ dataset: DatasetRecord }>;
  save(input: { id?: string; baseVersion?: number; title: string; release: DatasetRelease; releaseId?: string; requestId: string }): Promise<{ dataset: DatasetRecord }>;
  transition(input: { action: "review" | "approve" | "archive"; id: string; baseVersion: number; requestId: string; expectedUseCount?: number }): Promise<{ dataset: DatasetRecord }>;
}
export function datasetApi(getToken: () => Promise<string>): DatasetApi {
  async function request<T>(body: unknown, write = false) {
    return postFunction<T>("cmsDatasets", await getToken(), body, {}, { operation: write ? "content-write" : "content-list" });
  }
  return {
    refresh: id => request({ action: "refresh", id }),
    retry: id => request({ action: "retry", id }, true),
    figure: input => request<{ figure: DatasetPublicProjection }>({ action: "figure", ...input }).then(result => result.figure),
    list: (cursor, approvedOnly = false) => request({ action: "list", approvedOnly, ...(cursor ? { cursor } : {}) }),
    get: id => request({ action: "get", id }),
    releases: (id, cursor) => request({ action: "releases", id, ...(cursor ? { cursor } : {}) }),
    release: (id, releaseId) => request({ action: "release", id, releaseId }),
    owners: cursor => request({ action: "owners", ...(cursor ? { cursor } : {}) }),
    assign: input => request({ action: "assign", ...input }, true),
    save: input => request({ action: "save", ...input }, true),
    transition: input => request(input, true),
  };
}
