import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
export type PairFailureCode = "input-unavailable" | "render-failed" | "byte-mismatch" | "storage-unavailable" |
  "author-input-missing" | "author-input-mismatch" | "author-route-collision" | "author-owner-mismatch" |
  `replay-frozen-${"request" | "code" | "schedule" | "program-images"}-${"missing" | "mismatch"}` |
  "unsupported-cross-source-schedule" | "unsupported-cross-source-record-images" | "reader-mismatch" | "lease-lost" | "lease-expired" |
  "render-interrupted" | "release-state-refused" | "unexpected-executor-error";
export function isPairFailureCode(code: unknown): code is PairFailureCode;
export const WAITING_FAILURE_CODES: readonly PairFailureCode[];
export function isPairFinalFailure(code: unknown): boolean;
export function isHostCapacityFailure(error: unknown): boolean;
export function isPairTransportFailure(error: unknown): boolean;
export function rethrowPairTransport(error: unknown): void;
export class PairExecutionError extends Error {
  constructor(code: PairFailureCode, digests?: { got: string; want: string });
  readonly code: PairFailureCode; readonly digests?: Readonly<{ got: string; want: string }>;
}
export function assertPrivatePairResources(pair: PublicReleasePair): void;
