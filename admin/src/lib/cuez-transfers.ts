import { postFunction } from "./functions";
import type { RichTextDoc } from "../../../packages/content-core/src/content-model";

export type CuezKind = "video" | "clip" | "image" | "transcript" | "post";
export interface CuezResource { kind: CuezKind; id: string; jobId?: string }
export interface CuezChoice { resource: CuezResource; label: string; detail: string }
export interface CuezStory { id: string; title: string; description: string; descriptionTooLong: boolean; link: string }
export interface CuezOperation {
  operationId: string;
  label?: string;
  direction: "export" | "import";
  state: "queued" | "transferring" | "complete" | "conflict" | "reconciliation" | "failed";
  kind: CuezKind | "story";
  errorCode: string | null;
  message: string | null;
  canRetry: boolean;
  canClosePartial?: boolean;
  partialAcknowledged?: boolean;
  updatedAt: string | null;
  draftId?: string;
  acknowledged: boolean;
}
export interface CuezPreview {
  operation: CuezOperation;
  story: CuezStory;
  brief: RichTextDoc;
  dossiers: { id: string; title: string; document: RichTextDoc }[];
  warnings: string[];
}
export interface CuezOperationPage {
  operations: CuezOperation[];
  nextCursor: string | null;
  boundary: Pick<CuezOperation, "operationId" | "updatedAt"> | null;
}
export interface CuezApi {
  status(): Promise<{ enabled: boolean; canImport: boolean }>;
  resources(kind: CuezKind, assetId?: string, cursor?: string): Promise<{ items: CuezChoice[]; nextCursor: string | null }>;
  stories(search: string, page: number, importing?: boolean): Promise<{ stories: CuezStory[]; page: number; totalPages: number }>;
  prepare(resource: CuezResource, target: { kind: "new-story" | "story-asset" | "dossier"; storyId?: string }): Promise<{ operation: CuezOperation }>;
  send(operationId: string): Promise<{ operation: CuezOperation }>;
  operations(cursor?: string): Promise<CuezOperationPage>;
  preview(storyId: string): Promise<CuezPreview>;
  confirm(operationId: string): Promise<{ operation: CuezOperation }>;
  retry(operationId: string): Promise<{ operation: CuezOperation }>;
  reconcile(operationId: string, closePartial?: boolean): Promise<{ operation: CuezOperation }>;
}

export function createCuezApi(getIdToken: () => Promise<string>): CuezApi {
  const call = async <T>(endpoint: string, body: object = {}): Promise<T> =>
    postFunction<T>(endpoint, await getIdToken(), body, {}, { appCheck: true });
  return {
    status: () => call("cmsCuezStatus"),
    resources: (kind, assetId, cursor) => call("cmsCuezPrepareExport", { action: "list", kind, ...(assetId ? { assetId } : {}), ...(cursor ? { cursor } : {}) }),
    stories: (search, page, importing) => call(importing ? "cmsCuezListImportCandidates" : "cmsCuezListDestinations", { search, page }),
    prepare: (resource, target) => call("cmsCuezPrepareExport", { action: "prepare", resource, target }),
    send: operationId => call("cmsCuezSendExport", { operationId }),
    operations: cursor => call("cmsCuezOperationStatus", cursor ? { cursor } : {}),
    preview: storyId => call("cmsCuezPreviewImport", { storyId }),
    confirm: operationId => call("cmsCuezConfirmImport", { operationId, confirmed: true }),
    retry: operationId => call("cmsCuezRetry", { operationId }),
    reconcile: (operationId, closePartial) => call("cmsCuezReconcile", { operationId, acknowledged: true, ...(closePartial ? { closePartial: true } : {}) }),
  };
}
