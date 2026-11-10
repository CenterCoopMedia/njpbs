import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayCursor } from "./public-release-pair-replay";
export type ReplayHistoryDescriptor = Readonly<{
  fromCursor: ReplayCursor;
  headCursor: ReplayCursor;
  pageCount: number;
  logPagesRootDigest: string;
}>;
export const REPLAY_HISTORY_PAGE_SIZE: 128;
export class ReplayHistoryError extends Error {
  readonly code: "replay-history-invalid";
}
export function parseReplayHistoryCursor(value: unknown): ReplayCursor;
export function emptyReplayHistory(pair: PublicReleasePair, cursor: ReplayCursor): ReplayHistoryDescriptor;
export function parseReplayHistoryDescriptor(value: unknown, pair: PublicReleasePair): ReplayHistoryDescriptor;
export function readReplayHistoryInTransaction(options: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  history: ReplayHistoryDescriptor;
}): Promise<string[]>;
export function appendReplayHistoryInTransaction(options: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  history: ReplayHistoryDescriptor;
  pageDigest: string;
  headCursor: ReplayCursor;
}): Promise<{ history: ReplayHistoryDescriptor; write(): void }>;

export function readReplayHistoryTailInTransaction(options: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  history: ReplayHistoryDescriptor;
}): Promise<{ logPageDigests: string[] } | null>;
