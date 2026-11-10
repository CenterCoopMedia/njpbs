export interface CurrentCodeReference {
  publication: { schemaVersion: 1; digestAlgorithm: "sha256"; buildBatchId: string; generation: number; commitSha: string;
    artifactDigest: string; artifactReceiptDigest: string; mediaManifestDigest: string };
  manifest: { schemaVersion: 1; buildBatchId: string; artifactReceiptDigest: string; sha256: string; byteLength: number; key: string };
}
export function validateCurrentCodeReference(value: unknown): CurrentCodeReference;
export function createCurrentCodeTransport(options: import("./current-public-code-v2").PairCodeTransportOptions): ReturnType<
  typeof import("./current-public-code-v2").createPairCurrentCodeTransport>;
export function createCurrentCodeTransport(options: { target: import("./publication-target").PublicationTarget; rendererSha: string;
  request?: typeof fetch; readSecret?: () => string }): { readCurrentCode(): Promise<{ reference: CurrentCodeReference; bytes: Buffer }>;
  readCurrentCodeReference(): Promise<CurrentCodeReference> };
