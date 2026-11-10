import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { BootstrapAdmissionFence } from "./public-release-bootstrap-admission";
export type BootstrapAdmissionAttempt = Readonly<{ schemaVersion: 2; operationId: string;
  environment: "production" | "development"; legacyPointerDigest: string }>;
export function legacyBootstrapPointerDigest(value: unknown): string;
export function closePublicReleaseBootstrapAdmission(input: { firestore: Firestore; attempt: BootstrapAdmissionAttempt
}): Promise<{ idempotent: boolean; fence: BootstrapAdmissionFence }>;
export function assertClosedBootstrapFenceInTransaction(input: { firestore: Firestore; transaction: Transaction;
  environment: "production" | "development"; before: unknown; operationId?: string }): Promise<BootstrapAdmissionFence>;
export function abandonPublicReleaseBootstrapAdmission(input: { firestore: Firestore; attempt: BootstrapAdmissionAttempt
}): Promise<{ idempotent: boolean; receipt: BootstrapAdmissionAttempt & Readonly<{ kind: "bootstrap-admission-abandoned"; attemptDigest: string }> }>;
