import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "./public-release-pair-work";
import type { PairViewCursor } from "./public-release-pair-view";
import type { PairSearchNamespaceMember } from "./public-release-pair-search-namespace";
export const PAIR_CONTENT_FEED_NAMESPACE: "/api/v1/content/";
export const PAIR_CONTENT_FEED_INDEX: "/api/v1/content.json";
export type PairContentFeedNamespaceManifest = Readonly<{ schemaVersion: 1; kind: "pair-content-feed-namespace";
  namespace: "/api/v1/content/"; pairDigest: string; inputManifestDigest: string; cursor: PairViewCursor;
  index: PairSearchNamespaceMember & Readonly<{ path: "/api/v1/content.json"; pageCount: number }>;
  members: readonly PairSearchNamespaceMember[] }>;
export type PairContentFeedIndex = Readonly<{ apiVersion: 1; title: "NJ PBS released content"; homeUrl: string; feedUrl: string; rssUrl: string;
  pageSize: number; totalItems: number; pages: readonly Readonly<{ page: number; url: string; itemCount: number }>[] }>;
export type PairContentFeedPage = Readonly<{ apiVersion: 1; title: "NJ PBS released content"; indexUrl: string; selfUrl: string;
  previousUrl: string | null; nextUrl: string | null; page: number; pageSize: number; totalItems: number; totalPages: number; items: readonly unknown[] }>;
export function isPublicReleasePairContentFeedPagePath(value: unknown): value is string;
export function parsePublicReleasePairContentFeedNamespace(value: unknown, pair: PublicReleasePair, identity: PairTaskIdentity, cursor?: PairViewCursor): PairContentFeedNamespaceManifest;
export function publicReleasePairContentFeedNamespaceRootDigest(members: readonly PairSearchNamespaceMember[]): string;
export function publicReleasePairContentFeedNamespaceManifestDigest(manifest: unknown, pair: PublicReleasePair, identity: PairTaskIdentity, cursor?: PairViewCursor): string;
export function assertPublicReleasePairContentFeedIndex(bytes: Uint8Array, manifest: PairContentFeedNamespaceManifest): PairContentFeedIndex;
export function assertPublicReleasePairContentFeedPage(bytes: Uint8Array, path: string, manifest: PairContentFeedNamespaceManifest, index: PairContentFeedIndex): PairContentFeedPage;

export type PairContentFeedNamespaceProof = Omit<import("./public-release-pair-namespace-proof").PairOutputNamespaceProof, "kind" | "namespace"> &
  Readonly<{ kind: "pair-content-feed-namespace-proof"; namespace: "/api/v1/content/" }>;
export function publicReleasePairContentFeedNamespaceProofPath(pair: PublicReleasePair, digest: string): string;
export function parsePublicReleasePairContentFeedNamespaceProof(value: unknown, pair: PublicReleasePair, identity: PairTaskIdentity, claimDigest: string, viewManifestDigest: string): PairContentFeedNamespaceProof;
export function assertReadPublicReleasePairContentFeedNamespaceInTransaction(args: { firestore: Firestore; transaction: Transaction; pair: PublicReleasePair;
  identity: PairTaskIdentity; claimDigest: string; viewManifestDigest: string; cursor: PairViewCursor; manifest: unknown;
  namespaceRootDigest: string; namespaceManifestDigest: string }): Promise<PairContentFeedNamespaceProof>;
