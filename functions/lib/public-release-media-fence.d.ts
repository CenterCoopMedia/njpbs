import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleaseSelector } from "../../packages/content-core/src/public-release";
export function assertPairMediaFenceInTransaction(input: { firestore: Firestore; transaction: Transaction;
  selector: PublicReleaseSelector }): Promise<PublicReleaseSelector>;
export function parseStoredSelector(value: unknown): PublicReleaseSelector;
