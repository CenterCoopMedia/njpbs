import type { Firestore, Transaction } from "firebase-admin/firestore";
export function assertPublicReleasePairDatabase(firestore: Firestore, pair: PublicReleasePair): void;
import type { PublicReleasePair, PublicReleasePairReference } from "../../packages/content-core/src/public-release";
export type PairTaskInput = Readonly<{
  kind: "accepted" | "qualification" | "recovery";
  sourceOperationId: string;
  sourceVersion: number;
  snapshotDigest: string;
  contextSequence: number;
  inputManifestDigest: string;
}>;
export type PairTaskIdentity = PairTaskInput & Readonly<{ schemaVersion: 2; pair: PublicReleasePairReference }>;
export type PairClaim = Readonly<{ taskId: string; token: string; leaseUntil: number; identity: PairTaskIdentity; outputPrefix: string }>;
export const PAIRS: "system/publicReleasePairs";
export const LEASE_MS: 60000;
export type PairFailureCode = "input-unavailable" | "render-failed" | "byte-mismatch" | "storage-unavailable" |
  "author-input-missing" | "author-input-mismatch" | "author-route-collision" | "author-owner-mismatch" |
  `replay-frozen-${"request" | "code" | "schedule" | "program-images"}-${"missing" | "mismatch"}` |
  "unsupported-cross-source-schedule" | "unsupported-cross-source-record-images" | "reader-mismatch" | "lease-lost" | "lease-expired" | "unexpected-executor-error";
export class PairExecutionError extends Error { constructor(code: PairFailureCode); readonly code: PairFailureCode }
export function assertPrivatePairResources(pair: PublicReleasePair): void;
export function publicReleasePairKey(pairId: string): string;
export function publicReleasePairPath(pairId: string): string;
export function readPublicReleasePairWorkHint(input: {
  pair: PublicReleasePair;
  read(path: string): Promise<unknown>;
  listDue(field: "acceptedDueAt" | "nextAttemptAt" | "leaseUntil", limit: number): Promise<{ id: string; data: unknown }[]>;
  now?: number;
}): Promise<{ taskIds: string[]; billingDisabled?: boolean }>;
export function registerPublicReleasePair(input: { firestore: Firestore; pair: PublicReleasePair }): Promise<{ idempotent: boolean; pair: PublicReleasePair }>;
export function enqueuePublicReleasePairWorkInTransaction(input: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair; input: PairTaskInput;
}): Promise<{ idempotent: boolean; taskId: string; task: unknown }>;
export function readPublicReleasePairWork(input: { firestore: Firestore; pair: PublicReleasePair; now?: number }): Promise<{ taskIds: string[] }>;
export function claimPublicReleasePairWork(input: { firestore: Firestore; pair: PublicReleasePair; taskId: string; now?: number }): Promise<PairClaim | null>;
export function renewPublicReleasePairWork(input: {
  firestore: Firestore; pair: PublicReleasePair; taskId: string; token: string; now?: number;
}): Promise<{ leaseUntil: number }>;
export function settlePublicReleasePairWork(input: {
  firestore: Firestore; pair: PublicReleasePair; taskId: string; token: string;
  manifestDigest: string | null; retryAt?: number | null; failureCode?: PairFailureCode | null; now?: number;
}): Promise<{ idempotent: boolean }>;
export function assertPublicReleasePairCompletedReceiptInTransaction(input: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair;
  taskId: string; manifestDigest: string; claimDigest: string;
}): Promise<Readonly<{ schemaVersion: 2; taskId: string; identity: PairTaskIdentity;
  manifestDigest: string; claimDigest: string }>>;
export function assertPublicReleasePairInputOwnerInTransaction(input: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair;
  scope: import("./public-release-pair-input").PairInputScope; inputManifestDigest: string;
}): Promise<Readonly<{ receipt: import("./public-release-pair-input").PairInputReceipt | null;
  slot: import("./public-release-pair-input").PairInputSlot | null }>>;
