export interface CurrentCodeReference {
  publication: { schemaVersion: 1; digestAlgorithm: "sha256"; buildBatchId: string; generation: number; commitSha: string;
    artifactDigest: string; artifactReceiptDigest: string; mediaManifestDigest: string };
  manifest: { schemaVersion: 1; buildBatchId: string; artifactReceiptDigest: string; sha256: string; byteLength: number; key: string };
}
export const CURRENT_CODE_BYTES: number;
export function validateCurrentCodeReference(value: unknown): CurrentCodeReference;
