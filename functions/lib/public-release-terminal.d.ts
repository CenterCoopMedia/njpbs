import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePairReference, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "./public-release-pair-work";
export const TERMINAL_RECEIPTS: string;
export type CompletedPairPublicationExecution = Readonly<{ schemaVersion: 2; pair: PublicReleasePairReference; pairDigest: string;
  identity: PairTaskIdentity & { kind: "accepted" }; taskId: string; inputManifestDigest: string; claimDigest: string; manifestDigest: string }>;
export type PairPublicationTerminalReceipt = Readonly<{ schemaVersion: 2; kind: "pair-publication-terminal";
  operationId: string; admissionDigest: string; outcome: "success" | "superseded"; selector: PublicReleaseSelector; selectorDigest: string;
  originalExecution: CompletedPairPublicationExecution | null;
  activation: Readonly<{ kind: "pair-publication" | "pair-switch"; operationId: string; receiptDigest: string }>;
  coverageDigest: string; canonicalProofDigest: string;
  supersededBy: Readonly<{ operationId: string; admissionDigest: string; terminalReceiptDigest: string }> | null }>;
export function parseCompletedPairPublicationExecution(value: unknown): CompletedPairPublicationExecution;
export function parsePairPublicationTerminalReceipt(value: unknown): PairPublicationTerminalReceipt;
/** Same caller-owned SDK transaction. Historical fact validation performs no
 * mutations and cannot replace the private canonical byte-proof issuer. */
export function assertPairPublicationTerminalReceiptInTransaction(input: { firestore: Firestore; transaction: Transaction;
  operationId: string; admissionDigest: string }): Promise<PairPublicationTerminalReceipt>;
