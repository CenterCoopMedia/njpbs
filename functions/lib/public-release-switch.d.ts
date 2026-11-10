import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PublicReleaseChangeHead } from "../../packages/content-core/src/public-release";
import type { ReaderSeals } from "../../site/scripts/public-release-pair-reader-contract";
export type SwitchAttempt = Readonly<{ schemaVersion: 2; operationId: string; expectedSelectorDigest: string;
  oldPair: PublicReleasePair; newPair: PublicReleasePair; witnessDigest: string }>;
export type SwitchQualification = Readonly<{ schemaVersion: 2; pairDigest: string;
  contentHead: PublicReleaseSelector["contentHead"]; cursor: PublicReleaseChangeHead;
  validatorDigest: string; capabilities: Readonly<Record<"posts" | "pages" | "records", Readonly<Record<string, unknown>>>>;
  controlsDigest: string;
  coverageDigest: string; acceptedWorkDigest: string; admittedContractDigest: string; readerReceiptDigest: string; providerReadbackDigest: string }>;
export type SwitchWitness = Readonly<{ schemaVersion: 2; oldPairDigest: string; newPairDigest: string;
  oldQualificationDigest: string; newQualificationDigest: string; cursor: PublicReleaseChangeHead;
  validators: readonly Readonly<{ path: string; digest: string }>[]; admittedContractDigest: string; acceptedWorkDigest: string }>;
export type SwitchReceipt = Readonly<{ schemaVersion: 2; operationId: string; attemptDigest: string;
  selectorDigest: string; selector: PublicReleaseSelector }>;
/** Adapter for the actual qualification owner's opaque shared tracker. The
 * private operator passes its exports unchanged, never a count or JSON hint. */
export interface SwitchQualificationReadOwner<T> {
  trackQualificationTransactionReads(transaction: Transaction): T & { transaction: Transaction };
  assertQualificationTransactionReadBudget(tracker: T): number;
  parseReaderSeals(value: unknown, pair: PublicReleasePair): ReaderSeals;
}
export type SwitchGuardInput<T = unknown> = Readonly<{ firestore: Firestore; transaction: Transaction; readTracker: T;
  pairs: readonly PublicReleasePair[]; qualifications: readonly SwitchQualification[]; witness: SwitchWitness }>;
export const ROOT: string;
export const WITNESSES: string;
export const ATTEMPTS: string;
export const RECEIPTS: string;
export const MEDIA: string;
export const ADMISSIONS: string;
export const CAPABILITY_PATHS: Readonly<Record<"posts" | "pages" | "records", string>>;
export const REQUIRED_VALIDATORS: readonly string[];
export function parseSwitchAttempt(value: unknown): SwitchAttempt;
export function switchChangeOperationId(operationId: string): string;
export function parseSwitchWitness(value: unknown): SwitchWitness;
export function parseSwitchQualification(value: unknown, pair: PublicReleasePair): SwitchQualification;
export function publicationControlsForReaderSeals(seals: ReaderSeals, pair: PublicReleasePair): SwitchQualification["capabilities"];
export function reservePublicReleaseSwitch(input: { firestore: Firestore; attempt: SwitchAttempt }): Promise<{ idempotent: boolean; attemptDigest: string }>;
/** Both guards are mandatory server dependencies. Qualification must use the
 * actual owner's opaque outside preparation and late transaction guard for
 * BOTH pairs. Work inclusion must enumerate exact accepted work through the
 * witness. Neither callback may perform I/O outside this Firestore transaction.
 * Missing, stale or unsupported dependencies refuse before writes. */
export function applyPublicReleaseSwitch<T>(input: { firestore: Firestore; attempt: SwitchAttempt;
  qualificationReadOwner: SwitchQualificationReadOwner<T>;
  assertQualificationsCurrentInTransaction(input: SwitchGuardInput<T>): Promise<void>;
  assertAcceptedWorkIncludedInTransaction(input: SwitchGuardInput<T>): Promise<void>;
}): Promise<{ idempotent: boolean; receipt: SwitchReceipt }>;
/** Same complete guards in a read-only SDK snapshot, before reservation. No
 * serializable proof or permission is returned; apply rechecks every input. */
export function assertPublicReleaseSwitchPreflight<T>(input: { firestore: Firestore; attempt: SwitchAttempt;
  qualificationReadOwner: SwitchQualificationReadOwner<T>;
  assertQualificationsCurrentInTransaction(input: SwitchGuardInput<T>): Promise<void>;
  assertAcceptedWorkIncludedInTransaction(input: SwitchGuardInput<T>): Promise<void>;
}): Promise<void>;
export function abandonPublicReleaseSwitch(input: { firestore: Firestore; attempt: SwitchAttempt }): Promise<{ idempotent: boolean }>;
