export function previewRuntimeIdentity(value: unknown): unknown;
export function readPreviewPairRuntimeAuthority(options: { read(path: string): Promise<unknown>;
  pairId: string; rendererSha: string; workerVersion?: string; now?: number }): Promise<{
    mode: "candidate" | "retained"; pair: { workerVersion: string }; runtimeDigest: string;
    candidateReceiptId: string | null; bootstrapPublicPair?: unknown;
  }>;
export function recordPreviewPairCandidatePointer(options: { firestore: unknown; request: unknown;
  clock?: () => number; signal?: AbortSignal }): Promise<unknown>;
export const POINTERS: string;
export const RECEIPTS: string;
export function readPreviewPairWorkAuthority(options: { read(path: string): Promise<unknown>;
  pairId: string; rendererSha: string; workerVersion?: string; now?: number }): Promise<{
  mode: "retained" | "unretained" | "disabled"; pair?: { workerVersion: string }; runtimeDigest?: string }>;
