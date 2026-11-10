import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleasePairReference } from "../../packages/content-core/src/public-release";
export type PairCodeReference = Readonly<{ schemaVersion: 2; kind: "pair"; side: PublicReleasePairReference;
  commitSha: string; codeAssetManifestDigest: string; publicationDigest: string }>;
export type PairCodePublication = Readonly<{ schemaVersion: 2; kind: "pair-code-publication"; pairDigest: string;
  baselineDigest: string; codePackManifestDigest: string; reference: PairCodeReference;
  historicalCode: Readonly<{ reference: unknown; qualifiedCodeDigest: string; qualifiedCodeBytes: number; chunks: readonly string[] }> }>;
export function pairCodePublicationPath(pair: PublicReleasePair): string;
export function parsePairCodeReference(value: unknown): PairCodeReference;
export function parsePairCodePublication(value: unknown, pair: PublicReleasePair): PairCodePublication;
export function assertPairCodeReferenceInTransaction(input: { firestore: Firestore; transaction: Transaction; reference: PairCodeReference }): Promise<{
  pair: PublicReleasePair; reference: PairCodeReference; publication: PairCodePublication; baseline: unknown }>;
