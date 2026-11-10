import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PairAdmission } from "./public-release-admission";
import type { ReplayCursor, ReplayNamespaceSelection, ReplayViewReference, ReplayWitness } from "./public-release-pair-replay";
export class ContentActivationConflictError extends Error {
  readonly code: "content-activation-stale-snapshot";
}
export type ContentHead = PublicReleaseSelector["contentHead"];
export type ContentActivationAttempt = Readonly<{ schemaVersion: 2; operationId: string; admissionDigest: string;
  pair: PublicReleasePair; expectedSelectorDigest: string; expectedHeadDigest: string; witnessDigest: string; headCursor: ReplayCursor;
  originalView: ReplayViewReference }>;
export type ContentActivationReceipt = Readonly<{ schemaVersion: 2; kind: "pair-content-activation"; status: "activated";
  attempt: ContentActivationAttempt; attemptDigest: string; admission: PairAdmission; headView: ReplayViewReference;
  contentHead: ContentHead; codePackOverlayDigest: string; selectorDigestBefore: string; selectorDigestAfter: string;
  selectedAtActivation: boolean; originalTerminalDigest: string | null; mediaDigestBefore: string; mediaDigestAfter: string }>;
export type ContentActivationTracker = Readonly<{ transaction: Transaction; readCount(): number }>;
export type ContentActivationReadOwner = Readonly<{
  trackQualificationTransactionReads(transaction: Transaction): ContentActivationTracker;
  assertQualificationTransactionReadBudget(tracker: ContentActivationTracker): unknown;
}>;
export type ContentActivationGuardInput = Readonly<{ firestore: Firestore; transaction: Transaction; tracker: ContentActivationTracker;
  pair: PublicReleasePair; admission: PairAdmission; attempt: ContentActivationAttempt; selector: PublicReleaseSelector;
  witness: ReplayWitness; headView: ReplayViewReference }>;
export function activationPath(pair: PublicReleasePair, operationId: string): string;
export function parseContentHead(value: unknown, pair: PublicReleasePair): Readonly<{ schemaVersion: 2; pairDigest: string; contentHead: ContentHead }>;
export function parseContentActivationAttempt(value: unknown): ContentActivationAttempt;
export function parseContentActivationRecord(value: unknown, attempt: ContentActivationAttempt): ContentActivationReceipt;
export function activatePublicReleasePairContent(input: { firestore: Firestore; attempt: ContentActivationAttempt;
  replayProof: { namespaces: readonly ReplayNamespaceSelection[]; headView: ReplayViewReference };
  publicationReadOwner: ContentActivationReadOwner;
  assertPublicationCurrentInTransaction(input: ContentActivationGuardInput): Promise<void>;
  assertOriginalTerminalInTransaction?(input: { firestore: Firestore; transaction: Transaction; operationId: string; admissionDigest: string }): Promise<unknown>;
}): Promise<{ idempotent: boolean; receipt: ContentActivationReceipt }>;
export function readPublicReleasePairContentActivation(input: { firestore: Firestore; attempt: ContentActivationAttempt }): Promise<ContentActivationReceipt | null>;
