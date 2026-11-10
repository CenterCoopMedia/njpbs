export type ReplayNamespaceSelection =
  | import("./public-release-pair-replay-namespace").ReplaySearchNamespaceSelection
  | import("./public-release-pair-replay-content-feed").ReplayContentFeedNamespaceSelection;
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type {
  PublicReleasePair,
  PublicReleasePairReference,
  PublicReleaseChange,
} from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "./public-release-pair-work";
export type ReplayCursor = Readonly<{ baselineDigest: string; sequence: number; lastDigest: string }>;
export type ReplayViewReference = Readonly<{
  identity: PairTaskIdentity;
  claimDigest: string;
  manifestDigest: string;
  manifestBytes: number;
}>;
export type ReplayWitness = Readonly<{
  schemaVersion: 2;
  pairRef: PublicReleasePairReference;
  pairDigest: string;
  logBaselineDigest: string;
  pairBaselineDigest: string;
  fromCursor: ReplayCursor;
  headCursor: ReplayCursor;
  pageCount: number;
  logPagesRootDigest: string;
  coveredMembersDigest: string;
  contentViewDigest: string;
  codeAssetManifestDigest: string;
  codePackOverlayDigest: string;
  codePackView: ReplayViewReference;
  capsuleDigest: string;
  completedAt: number;
}>;
export type ReplayPairBaseline = Readonly<{
  schemaVersion: 2;
  pairDigest: string;
  logBaselineDigest: string;
  cursor: ReplayCursor;
  sourceInventoryDigest: string;
  codeAssetManifestDigest: string;
  inputReceiptDigests: readonly string[];
  viewReceiptDigests: readonly string[];
  views: readonly ReplayViewReference[];
  codePackView: ReplayViewReference;
  contentViewDigest: string;
  codePackOverlayDigest: string;
}>;
export type ReplayCoverage = Readonly<{
  entryDigest: string;
  membersDigest: string;
  memberContentDigests: readonly string[];
  reference: ReplayViewReference;
  inputReceiptDigest: string;
  viewReceiptDigest: string;
  outputInventoryDigest: string;
  renderTargetProofDigest: string;
}>;
export type ReplayPage = Readonly<{
  schemaVersion: 2;
  pairDigest: string;
  fromCursor: ReplayCursor;
  headCursor: ReplayCursor;
  entries: readonly PublicReleaseChange[];
  coverage: readonly ReplayCoverage[];
}>;
export type ReplayCheckpoint = Readonly<{
  schemaVersion: 2;
  pairDigest: string;
  pairBaselineDigest: string;
  cursor: ReplayCursor;
  history: import("./public-release-pair-replay-history").ReplayHistoryDescriptor;
  coveredMembersDigest: string;
  contentViewDigest: string;
  codePackOverlayDigest: string;
  capsuleDigest: string;
  witnessDigest: string | null;
}>;
export const PAGE_LIMIT: 20;
export class PairReplayError extends Error {
  code: string;
}
export function parseReplayCursor(value: unknown): ReplayCursor;
export function parseReplayViewReference(value: unknown, pair: PublicReleasePair): ReplayViewReference;
export function parseReplayWitness(value: unknown, pair: PublicReleasePair): ReplayWitness;
export function parseReplayPairBaseline(value: unknown, pair: PublicReleasePair): ReplayPairBaseline;
export function parseReplayPage(value: unknown, pair: PublicReleasePair): ReplayPage;
export function parseReplayCheckpoint(value: unknown, pair: PublicReleasePair): ReplayCheckpoint;
export function checkpointPath(pair: PublicReleasePair): string;
export function assertStagedReplayViewInTransaction(input: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  reference: ReplayViewReference;
  cursor: ReplayCursor;
}): Promise<{
  reference: ReplayViewReference;
  inputReceiptDigest: string;
  viewReceiptDigest: string;
  workReceiptDigest: string;
  renderTargetProofDigest: string | null;
  captured: import("./public-release-pair-input").PairInputReceipt;
}>;
export function commitPublicReleasePairReplayBaseline(input: {
  firestore: Firestore;
  pair: PublicReleasePair;
  baseline: ReplayPairBaseline;
}): Promise<{ idempotent: boolean; pairBaselineDigest: string }>;
export function commitPublicReleasePairReplayPage(input: {
  firestore: Firestore;
  pair: PublicReleasePair;
  page: ReplayPage;
  contentViewDigest: string;
  codePackOverlayDigest: string;
}): Promise<{ idempotent: boolean; pageDigest: string }>;
export function assertReadReplayWitnessInTransaction(input: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  headCursor: ReplayCursor;
  witnessDigest: string;
  selectedViews?: readonly ReplayViewReference[];
}): Promise<ReplayWitness>;
export function sealPublicReleasePairReplayWitness(input: {
  firestore: Firestore;
  pair: PublicReleasePair;
  completedAt?: number;
}): Promise<{ idempotent: boolean; witnessDigest: string; witness: ReplayWitness }>;

export function assertReadReplayWitnessProofInTransaction(input: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  headCursor: ReplayCursor;
  witnessDigest: string;
  selectedViews?: readonly ReplayViewReference[];
  headView?: ReplayViewReference;
  namespaces?: readonly ReplayNamespaceSelection[];
}): Promise<{
  witness: ReplayWitness;
  namespaces: ReplayNamespaceSelection[];
  headView: ReplayViewReference;
}>;

export function readReplayWitnessLogPagesInTransaction(input: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  witness: ReplayWitness;
}): Promise<string[]>;

export function preparePublicReleasePairReplayBaselineCapsule(options: {
  firestore: Firestore;
  pair: PublicReleasePair;
  baseline: ReplayPairBaseline;
  verifiedAt?: number;
}): Promise<{ capsuleDigest: string }>;
export function preparePublicReleasePairReplayPageCapsule(options: {
  firestore: Firestore;
  pair: PublicReleasePair;
  page: ReplayPage;
  contentViewDigest: string;
  codePackOverlayDigest: string;
  verifiedAt?: number;
}): Promise<{ capsuleDigest: string }>;
export function auditPublicReleasePairReplayWitness(options: {
  firestore: Firestore;
  pair: PublicReleasePair;
  headCursor: ReplayCursor;
  witnessDigest: string;
  selectedViews?: readonly ReplayViewReference[];
}): Promise<{
  witness: ReplayWitness;
  namespaces: ReplayNamespaceSelection[];
}>;
export function openPublicReleasePairReplayWitnessProof(options: {
  firestore: Firestore;
  pair: PublicReleasePair;
  headCursor: ReplayCursor;
  witnessDigest: string;
  selectedViews?: readonly ReplayViewReference[];
}): Promise<{
  witness: ReplayWitness;
  namespaces: ReplayNamespaceSelection[];
  headView: ReplayViewReference;
}>;

export function readReplayBaselineSelectionState(input: {
  firestore: Firestore;
  pair: PublicReleasePair;
  baseline: Pick<
    ReplayPairBaseline,
    "views" | "codePackView" | "cursor" | "logBaselineDigest" | "sourceInventoryDigest"
  >;
}): Promise<{
  content: Map<string, import("./public-release-pair-replay-inventory").ReplaySelectionMember>;
  overlay: Map<string, import("./public-release-pair-replay-inventory").ReplaySelectionMember>;
}>;
