import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
export const INPUT_ROOT_BYTES_LIMIT: number;
export const INPUT_FILE_BYTES_LIMIT: number;
export const INPUT_FILE_LIMIT: 10000;
export const INPUT_TOTAL_BYTES_LIMIT: number;
export type PairInputScope = Readonly<{ kind: "accepted" | "qualification" | "recovery";
  sourceOperationId: string; sourceVersion: number; snapshotDigest: string; contextSequence: number }>;
export type PairInputCursor = Readonly<{ baselineDigest: string; sequence: number; lastDigest: string }>;
export type PairInputSource = Readonly<{ kind: "post" | "page" | "record" | "settings" | "library" | "media" |
  "author" | "provider" | "schedule" | "dataHub" | "inventory"; id: string }>;
export type PairInputFile = Readonly<{ name: string; digest: string; bytes: number;
  objectKey: string; dependencies: readonly string[] }>;
export type PairInputRoot = Readonly<{ schemaVersion: 2; kind: "pair-render-input"; pairDigest: string;
  source: PairInputSource; scope: PairInputScope; cursor: PairInputCursor; snapshotFile: string; entryFiles: readonly string[]; files: readonly PairInputFile[] }>;
export type PairInputReceipt = Readonly<{ schemaVersion: 2; status: "captured"; pairDigest: string;
  source: PairInputSource; scope: PairInputScope; inputManifestDigest: string; manifestKey: string; manifestBytes: number; cursor: PairInputCursor;
  fileCount: number; inputBytes: number; readbackDigest: string }>;
export type PairInputSlot = Readonly<{ schemaVersion: 2; pairDigest: string; scope: PairInputScope;
  inputManifestDigest: string; receiptDigest: string }>;
export function parsePublicReleasePairInputScope(value: unknown): PairInputScope;
export function parsePublicReleasePairInputSource(value: unknown): PairInputSource;
export function parsePublicReleasePairInputRoot(value: unknown, pair: PublicReleasePair): PairInputRoot;
export function parsePublicReleasePairInputReceipt(value: unknown, pair: PublicReleasePair,
  scope: PairInputScope, inputManifestDigest: string): PairInputReceipt;
export function publicReleasePairInputPrefix(pair: PublicReleasePair): string;
export function publicReleasePairInputObjectKey(pair: PublicReleasePair, bodyDigest: string): string;
export function publicReleasePairInputRootKey(pair: PublicReleasePair, manifestDigest: string): string;
export function publicReleasePairInputScopeKey(pair: PublicReleasePair, scope: PairInputScope): string;
export function parsePublicReleasePairInputSlot(value: unknown, pair: PublicReleasePair,
  scope: PairInputScope, inputManifestDigest: string): PairInputSlot;
