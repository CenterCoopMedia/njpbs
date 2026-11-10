import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayArtifact, ReplayOutput, ReplaySelectionMember } from "./public-release-pair-replay-inventory";
import type { ReplayCursor, ReplayViewReference } from "./public-release-pair-replay";
import type { PairContentFeedNamespaceManifest } from "./public-release-pair-content-feed-namespace";
export type ReplayContentFeedNamespaceState = {
  manifest: PairContentFeedNamespaceManifest;
  view: ReplayViewReference;
  priorPaths: Set<string>;
  namespaceRootDigest: string;
  namespaceManifestDigest: string;
};
export type ReplayContentFeedNamespaceSelection = Readonly<{
  namespace: "/api/v1/content/";
  namespaceRootDigest: string;
  namespaceManifestDigest: string;
  cursor: ReplayCursor;
  headCursor: ReplayCursor;
  view: ReplayViewReference;
  manifest: PairContentFeedNamespaceManifest;
  members: PairContentFeedNamespaceManifest["members"];
  index: PairContentFeedNamespaceManifest["index"] & Readonly<{ view: ReplayViewReference; cursor: ReplayCursor }>;
  priorPaths: readonly string[];
  withdrawnPaths: readonly string[];
}>;
export class ReplayContentFeedError extends Error {
  readonly code: string;
}
export function replayContentFeedAuthority(pair: PublicReleasePair, artifacts: Map<string, ReplayArtifact>): boolean;
export function baselineReplayContentFeedNamespace(options: {
  pair: PublicReleasePair;
  artifacts: Map<string, ReplayArtifact>;
  codePackView: ReplayViewReference;
  cursor: ReplayCursor;
}): ReplayContentFeedNamespaceState | null;
export function applyReplayContentFeedNamespace(options: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  artifacts: Map<string, ReplayArtifact>;
  outputs: readonly ReplayOutput[];
  reference: ReplayViewReference;
  cursor: ReplayCursor;
  previous: ReplayContentFeedNamespaceState | null;
  overlay: Map<string, ReplaySelectionMember>;
  retainEqual?: boolean;
}): Promise<{
  state: ReplayContentFeedNamespaceState | null;
  proof: import("./public-release-pair-content-feed-namespace").PairContentFeedNamespaceProof | null;
  outputs: readonly ReplayOutput[];
}>;
export function replayContentFeedNamespaceProof(
  state: ReplayContentFeedNamespaceState | null,
  headCursor: ReplayCursor,
): ReplayContentFeedNamespaceSelection[];
