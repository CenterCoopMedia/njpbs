export type PublicReleaseChangeBaseline = Readonly<{ schemaVersion: 2; logEpoch: string;
 baselineCursor: Readonly<{ baselineDigest: string; sequence: number; lastDigest: string }>;
 liveReleaseSha: string; sourceMemberCensusDigest: string; codeAssetManifestDigest: string | null;
 codeAssetManifestReason?: "legacy-release-predates-code-packs"; createdAt: string }>;
export function parsePublicReleaseChangeBaseline(value: unknown): PublicReleaseChangeBaseline;
