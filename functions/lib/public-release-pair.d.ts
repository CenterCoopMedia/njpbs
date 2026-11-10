import type { PublicReleasePair, PublicReleasePairReference, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
export const PUBLIC_RELEASE_PROTOCOL: 2;
export class PublicReleaseProtocolError extends Error { status: number }
export function parsePublicReleasePair(value: unknown): PublicReleasePair;
export function parsePublicReleasePairReference(value: unknown): PublicReleasePairReference;
export function publicReleasePairReference(value: unknown): PublicReleasePairReference;
export function parsePublicReleaseSelector(value: unknown): PublicReleaseSelector;
export function parseStoredPublicReleaseSelector(value: unknown): PublicReleaseSelector;
export function parseVersionedPublicDeployment(value: unknown): PublicReleaseSelector | Record<string, unknown>;
export function publicReleaseDigest(value: unknown): string;
export function exact(value: unknown, fields: readonly string[]): void;
export function digest(value: unknown): value is string;
