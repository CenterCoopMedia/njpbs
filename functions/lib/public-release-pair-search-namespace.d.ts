import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "./public-release-pair-work";
import type { PairViewCursor } from "./public-release-pair-view";
export const PAIR_SEARCH_NAMESPACE: "/pagefind/";
export const PAIR_SEARCH_REQUIRED_ENTRIES: readonly string[];
export type PairSearchNamespaceMember = Readonly<{ path: string; mime: string; size: number; sha256: string }>;
export type PairSearchNamespaceManifest = Readonly<{ schemaVersion: 1; kind: "pair-search-namespace"; namespace: "/pagefind/";
  pairDigest: string; inputManifestDigest: string; cursor: PairViewCursor; members: readonly PairSearchNamespaceMember[] }>;
export type PairSearchNamespaceProof = Omit<import("./public-release-pair-namespace-proof").PairOutputNamespaceProof, "kind" | "namespace"> &
  Readonly<{ kind: "pair-search-namespace-proof"; namespace: "/pagefind/" }>;
export function parsePublicReleasePairSearchNamespace(value: unknown, pair: PublicReleasePair, identity: PairTaskIdentity, cursor?: PairViewCursor): PairSearchNamespaceManifest;
export function publicReleasePairSearchNamespaceRootDigest(members: readonly PairSearchNamespaceMember[]): string;
export function publicReleasePairSearchNamespaceManifestDigest(manifest: unknown, pair: PublicReleasePair, identity: PairTaskIdentity, cursor?: PairViewCursor): string;
export function publicReleasePairSearchNamespaceProofPath(pair: PublicReleasePair, viewManifestDigest: string): string;
export function parsePublicReleasePairSearchNamespaceProof(value: unknown, pair: PublicReleasePair, identity: PairTaskIdentity, claimDigest: string, viewManifestDigest: string): PairSearchNamespaceProof;
export function assertReadPublicReleasePairSearchNamespaceInTransaction(args: { firestore: Firestore; transaction: Transaction;
  pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string; viewManifestDigest: string; cursor: PairViewCursor;
  manifest: unknown; namespaceRootDigest: string; namespaceManifestDigest: string }): Promise<PairSearchNamespaceProof>;
