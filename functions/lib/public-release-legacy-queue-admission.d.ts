import type { Firestore, Transaction } from "firebase-admin/firestore";
export class LegacyPublicQueueAdmissionError extends Error {
  readonly name: "LegacyPublicQueueAdmissionError";
  readonly code: "public_release_legacy_queue_unavailable";
  readonly status: 409;
  readonly scheduleDeferred: true;
}
export function assertLegacyPublicQueueAdmissionInTransaction(input: {
  firestore: Firestore; transaction: Transaction;
}): Promise<void>;
