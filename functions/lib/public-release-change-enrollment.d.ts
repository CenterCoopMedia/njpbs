import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleaseChangeBaseline } from "./public-release-change-baseline";
export type EnrollmentExpected = Readonly<{ projectId: string; liveReleaseSha: string; pointerDigest: string; runtimeDigest: string;
  contextRevision: number; contextDigest: string; publicSourceCensusDigest: string }>;
export type EnrollmentRequest = Readonly<{ schemaVersion: 1; operationId: string; logEpoch: string; baselineDigest: string; expected: EnrollmentExpected }>;
export type EnrollmentReceipt = Readonly<{ schemaVersion: 1; kind: "initial-public-release-change-enrollment"; request: EnrollmentRequest;
  requestDigest: string; initialHead: Readonly<{ schemaVersion: 2; baselineDigest: string; sequence: number; lastDigest: string }>;
  baseline: Readonly<{ receipt: PublicReleaseChangeBaseline; logBaselineDigest: string }>; createdAt: string }>;
export class PublicReleaseEnrollmentError extends Error { readonly code: string; constructor(code: string); }
export const ENROLLMENT_PATH: string;
export function parsePublicReleaseChangeEnrollmentRequest(value: unknown): EnrollmentRequest;
export function parsePublicReleaseChangeEnrollmentReceipt(value: unknown): EnrollmentReceipt;
export function inspectPublicReleaseChangeEnrollment(options: { firestore: Firestore }): Promise<{ schemaVersion: 1; expected: EnrollmentExpected; publicSourceMemberCount: number }>;
export function enrollPublicReleaseChangeLog(options: { firestore: Firestore; request: EnrollmentRequest; dryRun?: boolean; currentCodeRequest?: typeof fetch; readSecret?: () => string }): Promise<{
  status: "dry-run" | "enrolled"; idempotent: boolean; receipt: EnrollmentReceipt; receiptDigest: string }>;
export function assertReadPublicReleaseChangeEnrollmentInTransaction(options: { firestore: Firestore; transaction: Transaction; requestDigest?: string }): Promise<{
  receipt: EnrollmentReceipt; receiptDigest: string; head: Readonly<{ schemaVersion: 2; baselineDigest: string; sequence: number; lastDigest: string }> }>;
