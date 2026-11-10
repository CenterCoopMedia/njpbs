import type { Firestore, Transaction, DocumentReference } from "firebase-admin/firestore";
import type { PairAdmission, PairPublicationChange } from "./public-release-admission";
import type { PublicReleaseSelector } from "../../packages/content-core/src/public-release";
export type PairPreparedPublication = Readonly<{ idempotent: boolean; admission: PairAdmission;
  operation: Readonly<Record<string, unknown>>; transport: "release-pair-publication-v2";
  requiresPrimaryAdmission: false; queueId: string; contentQueueId: string;
  affectedHomeSections: readonly unknown[]; warnings: readonly string[]; homeFullBuildQueueId: null;
  releaseSelector?: PublicReleaseSelector; write(): void }>;
export type PairSourceOwnerOptions = { firestore: Firestore; transaction: Transaction; documentId: string;
  nextDocument: Record<string, unknown>; queueRef: DocumentReference; actor: { uid: string; email?: string | null };
  target?: unknown; pageScheduleCapture?: unknown; dependencyRefresh?: boolean; electionResultsRefresh?: { blockId: string } };
/** Explicit source-owner API, never an adoption dispatcher. Caller retains
 * authorization and snapshot/history/media writes in the same transaction and
 * must honor idempotent before applying them. No legacy handler selects it. */
export function preparePairContentPublication(input: PairSourceOwnerOptions & {
  collection: "cmsPosts" | "cmsPages"; kind: "post" | "page" | "record";
  family: "posts" | "pages" | "programs" | "events";
}): Promise<PairPreparedPublication>;
export function preparePairSettingsPublication(input: { firestore: Firestore; transaction: Transaction;
  id: string; published: Record<string, unknown>; actor: { uid: string; email?: string | null };
}): Promise<PairPreparedPublication & { publication: { queueId: string; transport: "release-pair-publication-v2";
  sourceVersion: number; status: "pending"; missingConsumers: readonly string[] } }>;
export function preparePairContextPublication(input: { firestore: Firestore; transaction: Transaction;
  operationId: string; change: PairPublicationChange }): Promise<PairPreparedPublication>;
