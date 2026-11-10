export type StaticPostInput = { schemaVersion: 1; postId: string; operationId: string; sourceVersion: number; visible: boolean;
  slug: string; ownedSlugs: string[]; snapshotDigest: string; contextDigest: string };
export type StaticPostProof = StaticPostInput & { files: { path: string; bytes: number; digest: string }[] };
export const MAX_FILES: number;
export const MAX_FILE_BYTES: number;
export const MAX_TOTAL_BYTES: number;
export function projectStaticInput(value: unknown): StaticPostInput;
export function projectStaticProof(value: unknown): StaticPostProof;
export function staticProofInput(proof: StaticPostProof): StaticPostInput;
