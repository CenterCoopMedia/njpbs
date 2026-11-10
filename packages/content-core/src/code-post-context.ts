// Shared contract for the private service and public renderer.
export type CodePostReceipt = {
  schemaVersion: 1; postId: string; sourceVersion: number; canonicalPath: string; path: string; rendererSha: string;
  snapshotDigest: string; contextRevision: number; contextDigest: string; codeContextDigest: string;
  codeFrameDigest: string; inputSourceDigest: string;
  code: { schemaVersion: 1; digestAlgorithm: "sha256"; buildBatchId: string; generation: number; commitSha: string;
    artifactDigest: string; artifactReceiptDigest: string; mediaManifestDigest: string };
};
export type CodePostReply = { kind: "pass" } | { kind: "code-post-unavailable" }
  | { kind: "code-post"; receipt: CodePostReceipt; published: unknown; codeFrame: unknown }
  | { kind: "code-post-alias"; receipt: CodePostReceipt; location: string };
