export type PairAuthorOwner = Readonly<{ authorId: string; sourceVersion: number; snapshotDigest: string;
  canonicalPath: string; sourceCensusDigest: string; readerProvenanceDigest: string }>;
export function isPublicReleasePairAuthorPath(path: unknown): boolean;
export function parsePublicReleasePairAuthorOwner(value: unknown): PairAuthorOwner;
