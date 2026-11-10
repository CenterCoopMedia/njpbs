import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayArtifact, ReplayOutput, ReplaySelectionMember } from "./public-release-pair-replay-inventory";
import type { ReplayCursor, ReplayViewReference } from "./public-release-pair-replay";
import type { PairSearchNamespaceManifest, PairSearchNamespaceProof } from "./public-release-pair-search-namespace";
export type ReplaySearchNamespaceState = {
  manifest: PairSearchNamespaceManifest;
  view: ReplayViewReference;
  priorPaths: Set<string>;
  namespaceRootDigest: string;
  namespaceManifestDigest: string;
};
export type ReplaySearchNamespaceSelection = Readonly<{
  namespace: "/pagefind/";
  namespaceRootDigest: string;
  namespaceManifestDigest: string;
  cursor: ReplayCursor;
  headCursor: ReplayCursor;
  view: ReplayViewReference;
  manifest: PairSearchNamespaceManifest;
  members: PairSearchNamespaceManifest["members"];
  priorPaths: readonly string[];
  withdrawnPaths: readonly string[];
}>;
export function replaySearchAuthority(pair: PublicReleasePair, artifacts: Map<string, ReplayArtifact>): boolean;
export function baselineReplaySearchNamespace(options: {
  pair: PublicReleasePair;
  artifacts: Map<string, ReplayArtifact>;
  codePackView: ReplayViewReference;
  cursor: ReplayCursor;
}): ReplaySearchNamespaceState | null;
export function applyReplaySearchNamespace(options: {
  firestore: Firestore;
  transaction: Transaction;
  pair: PublicReleasePair;
  artifacts: Map<string, ReplayArtifact>;
  outputs: readonly ReplayOutput[];
  reference: ReplayViewReference;
  cursor: ReplayCursor;
  previous: ReplaySearchNamespaceState | null;
  overlay: Map<string, ReplaySelectionMember>;
  retainEqual?: boolean;
}): Promise<{
  state: ReplaySearchNamespaceState | null;
  proof: PairSearchNamespaceProof | null;
  outputs: readonly ReplayOutput[];
}>;
export function replaySearchNamespaceProof(
  state: ReplaySearchNamespaceState | null,
  headCursor: ReplayCursor,
): ReplaySearchNamespaceSelection[];

export class ReplaySearchNamespaceError extends Error {
  readonly code: string;
}
