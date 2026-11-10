import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleasePairReference } from "../../packages/content-core/src/public-release";
import type { PairInputScope } from "./public-release-pair-input";
import type { preparePublicReleaseProducerInTransaction } from "./public-release-producer";
export type PairPublicationChange = Parameters<typeof preparePublicReleaseProducerInTransaction>[0]["changes"][number];
export type PairPublicationSource = Readonly<{ kind: "post" | "page" | "record" | "settings" | "provider"; id: string;
  family: "posts" | "pages" | "programs" | "events" | "settings" | "context"; action: "publish" | "withdraw" | "dependency";
  sourceVersion: number; snapshotDigest: string; requiredFeatures: readonly string[] }>;
export type PairAdmission = Readonly<{ schemaVersion: 2; operationId: string; source: PairPublicationSource;
  pair: PublicReleasePairReference; pairDigest: string; epoch: number; changeSequence: number; contextRevision: number;
  admissionSequence: number; admittedContractDigest: string }>;
export type PairAdmissionHead = Readonly<{ schemaVersion: 2; sequence: number; pendingCount: number; pendingDigest: string }>;
export const ADMISSIONS: string;
export const CONTRACTS: string;
export const TRANSPORT: "release-pair-publication-v2";
/** Durable recovery hint on the originally admitted pair. The global pending
 * marker and census remain independent until private terminal settlement. */
export function publicationPendingPath(pairId: string, operationId: string): string;
export function initialAdmissionHead(): PairAdmissionHead;
export function parseAdmissionHead(value: unknown): PairAdmissionHead;
export function togglePendingDigest(left: string, right: string): string;
export function parsePublicationSource(value: unknown): PairPublicationSource;
export function publicationSource(change: Pick<PairPublicationChange, "kind" | "id" | "action" | "snapshot"> & {
  sourceVersion?: number; family?: PairPublicationSource["family"] }): PairPublicationSource;
export function parseAdmission(value: unknown): PairAdmission;
export function ownerPath(source: PairPublicationSource): string;
export function assertQueue(value: unknown, admission: PairAdmission): void;
/** Original source auth, route/media/snapshot/history checks and context bump
 * stay in the caller's transaction. Writes must run only after all reads. */
export function preparePairPublicationInTransaction(input: { firestore: Firestore; transaction: Transaction;
  operationId: string; source: PairPublicationSource; change: PairPublicationChange; contextRevision: number;
}): Promise<{ idempotent: boolean; admission: PairAdmission; write(): void }>;
export function assertRetainedPairAdmissionInTransaction(input: { firestore: Firestore; transaction: Transaction;
  pair: PublicReleasePair; scope: PairInputScope }): Promise<PairAdmission>;
