import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "./public-release-pair-work";
export type PairStaticTargetProof = Readonly<{ schemaVersion: 1; kind: "pair-static-target-proof"; status: "staged"; pairDigest: string;
  taskId: string; identity: PairTaskIdentity; claimDigest: string; viewManifestDigest: string; viewReadbackDigest: string;
  inputManifestDigest: string; descriptor: { digest: string; key: string; bytes: number };
  sourcePublicationDigest: string; sourceStatusDigest: string; targetPublicationDigest: string; targetStatusDigest: string }>;
export function publicReleasePairStaticTargetClaimPath(pair: PublicReleasePair, claimDigest: string): string;
export function publicReleasePairStaticTargetProofPath(pair: PublicReleasePair, manifestDigest: string): string;
export function parsePublicReleasePairStaticTargetProof(value: unknown, pair: PublicReleasePair, identity: PairTaskIdentity,
  claimDigest: string, manifestDigest: string, targetDigest: string, readbackDigest: string): PairStaticTargetProof;
