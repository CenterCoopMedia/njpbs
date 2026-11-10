import type { PublicReleasePair, PublicReleasePairReference, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
export function releasePair(slot?: string, commitSha?: string): PublicReleasePair;
export function pairReference(pair?: PublicReleasePair): PublicReleasePairReference;
export function releaseSelector(): PublicReleaseSelector;
