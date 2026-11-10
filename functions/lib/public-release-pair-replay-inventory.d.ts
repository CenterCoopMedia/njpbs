import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayCursor, ReplayViewReference } from "./public-release-pair-replay";
export type ReplayOutput = import("./public-release-pair-view").PairViewOutput;
export type ReplaySelectionMember = Readonly<{ path: string; view: ReplayViewReference; bodyDigest: string }>;
export type ReplayArtifact = Readonly<{
  path: string;
  mime: string;
  size: number;
  sha256: string;
  family: string;
  source: string;
  dynamic: boolean;
}>;
type ReadContext = { firestore: Firestore; transaction: Transaction; pair: PublicReleasePair };
export function readReplayOutputInventory(
  options: ReadContext & {
    reference: ReplayViewReference;
    cursor: ReplayCursor;
    inventoryDigest?: string;
    renderTargetProofDigest?: string;
    requireRenderTargets?: boolean;
  },
): Promise<ReplayOutput[]>;
export function readReplayCodePackInventory(
  options: ReadContext & {
    codePackView: ReplayViewReference;
    baseline: { logBaselineDigest: string; sourceInventoryDigest: string; cursor: ReplayCursor };
  },
): Promise<Map<string, ReplayArtifact>>;
export function selectReplayOutputs(options: {
  content: Map<string, ReplaySelectionMember>;
  overlay: Map<string, ReplaySelectionMember>;
  artifacts: Map<string, ReplayArtifact>;
  outputs: readonly ReplayOutput[];
  reference: ReplayViewReference;
  baseline?: boolean;
  compositeVerified?: boolean;
}): void;
export function replaySelectionManifest(options: {
  pair: PublicReleasePair;
  kind: "content" | "code-pack-overlay";
  cursor: ReplayCursor;
  members: Map<string, ReplaySelectionMember>;
}): unknown;
export function readReplaySelectionMembers(
  options: ReadContext & {
    kind: "content" | "code-pack-overlay";
    cursor: ReplayCursor;
    selectionDigest: string;
  },
): Promise<Map<string, ReplaySelectionMember>>;

export function verifyReplayOutputReadback(options: {
  pair: PublicReleasePair;
  reference: ReplayViewReference;
  cursor: ReplayCursor;
  outputs: readonly ReplayOutput[];
  staged: unknown;
}): ReplayOutput[];

export function applyReplayCatalogImages(
  options: ReadContext & {
    artifacts: Map<string, ReplayArtifact>;
    outputs: readonly ReplayOutput[];
    reference: ReplayViewReference;
    cursor: ReplayCursor;
    overlay: Map<string, ReplaySelectionMember>;
  },
): Promise<readonly ReplayOutput[]>;

export function assertReplayCompositeOutputs(options: {
  pair: PublicReleasePair;
  reference: ReplayViewReference;
  cursor: ReplayCursor;
  outputs: readonly ReplayOutput[];
  manifest: unknown;
}): import("./public-release-pair-composite-view").PairCompositeManifest;
