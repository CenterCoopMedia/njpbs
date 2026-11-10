import type { Firestore, Transaction } from "firebase-admin/firestore";
export const PUBLIC_RELEASE_CHANGE_LOG_CONTROL: "system/publicReleaseChangeLog";
export function publicReleaseSnapshotJson(value: unknown, maxBytes?: number): string;
export function publicReleaseMemberPath(operationId: string, kind: string, id: string): string;
export function publicReleaseProducerOperation(kind: string, id: string, version: number, snapshot: unknown): string;
export function preparePublicReleaseProducerInTransaction(input: {
  firestore: Firestore; transaction: Transaction; operationId: string;
  changes: { kind: "post" | "page" | "record" | "settings" | "library" | "media" | "author" | "provider" | "schedule" | "dataHub";
    id: string; action: "publish" | "withdraw" | "dependency"; sourceVersion: number; snapshot: unknown; mediaSource?: { source: string }; sourceDocuments?: { path: string; data: unknown }[] }[];
  pairActivation?: { commitSha: string; codeReference: import("./public-release-pair-code-reference").PairCodeReference };
  contextRevision?: number; revisionDelta?: number; activation?: { buildBatchId: string; commitSha: string };
}): Promise<() => void>;
export function publicContentChange(collection: string, id: string, document: { published: unknown }, visible?: boolean, owner?: { path: string; data: unknown }): {
  kind: "post" | "page" | "record"; id: string; action: "publish" | "withdraw"; sourceVersion: number; snapshot: unknown;
};
export function preparePublicMediaChangeInTransaction(input: {
  firestore: Firestore; transaction: Transaction; id: string; version: number; before?: unknown; after?: unknown; mediaSource?: { source: string };
}): Promise<() => void>;
