import type { PublicReleaseSelector } from "../../packages/content-core/src/public-release";
export type PublicReleasePairMedia = Readonly<{ schemaVersion: 2; epoch: number; activeGeneration: number;
  lastReservedGeneration: number; newestEligibleGeneration: number;
  references: readonly Readonly<{ pairId: string; manifestDigest: string }>[] }>;
export function parsePairMedia(value: unknown, selector: PublicReleaseSelector): PublicReleasePairMedia;
