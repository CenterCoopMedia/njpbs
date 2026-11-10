import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleaseChange, PublicReleaseChangeHead, PublicReleaseChangeInput } from "../../packages/content-core/src/public-release";
export const PUBLIC_RELEASE_CHANGES_PATH: "system/publicReleaseChanges";
export function initialPublicReleaseChangeHead(baselineDigest: string): PublicReleaseChangeHead;
export function parsePublicReleaseChangeInput(value: unknown): PublicReleaseChangeInput;
export function parsePublicReleaseChangeHead(value: unknown): PublicReleaseChangeHead;
export function parsePublicReleaseChange(value: unknown): PublicReleaseChange;
export function preparePublicReleaseChangeInTransaction(input: {
  firestore: Firestore;
  transaction: Transaction;
  input: PublicReleaseChangeInput;
}): Promise<{ idempotent: boolean; entry: PublicReleaseChange; write(): void }>;
export function appendPublicReleaseChangeInTransaction(input: {
  firestore: Firestore;
  transaction: Transaction;
  input: PublicReleaseChangeInput;
}): Promise<{ idempotent: boolean; entry: PublicReleaseChange }>;
export function verifyPublicReleaseChangePage(cursor: { sequence: number; lastDigest: string }, values: unknown[]): Readonly<{
  sequence: number;
  lastDigest: string;
}>;
