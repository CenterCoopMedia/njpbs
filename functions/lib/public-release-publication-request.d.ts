import type { Firestore, Transaction, DocumentReference } from "firebase-admin/firestore";
import type { PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PairAdmission } from "./public-release-admission";
export type PairContentPublicationResponse = Readonly<{ queueId: string; transport: "release-pair-publication-v2";
  status: "pending" | "queued"; warnings?: readonly string[]; affectedHomeSections?: readonly unknown[] }>;
export type PairSaveAcceptance = Readonly<{ success: true; collection: "cmsPages" | "cmsPosts"; id: string;
  document: Readonly<Record<string, unknown>>; publication: PairContentPublicationResponse }>;
export type PairTransitionAcceptance = PairSaveAcceptance & Readonly<{ action: "unpublish" | "archive";
  fromStatus: string; toStatus: string; version: number }>;
export type PairPublicationRequest = Readonly<{ operationId: string; queueRef: DocumentReference; selector: PublicReleaseSelector;
  replay: Readonly<{ action: unknown; before: Record<string, unknown> | null; after: Record<string, unknown>; metadata: Record<string, unknown> }> | null;
  write(input: { historyRef: DocumentReference; version: number; metadata: Record<string, unknown> }): void }>;
/** Current source authorization must succeed before using a replay. */
export function preparePairPublicationRequestInTransaction(input: { firestore: Firestore; transaction: Transaction;
  endpoint: "save" | "transition"; actorUid: string; body: Record<string, unknown>;
  collection: "cmsPages" | "cmsPosts"; documentId: string }): Promise<PairPublicationRequest | null>;
export function readPendingPairWithdrawalInTransaction(input: { firestore: Firestore; transaction: Transaction;
  operationId: string; collection: "cmsPages" | "cmsPosts"; documentId: string; sourceVersion: number;
  sourceKind: "post" | "page" | "record" }): Promise<PairAdmission | null>;
