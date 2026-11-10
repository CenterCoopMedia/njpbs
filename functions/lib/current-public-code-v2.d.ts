import type { PublicReleasePairReference } from "../../packages/content-core/src/public-release";
import type { PublicationTarget } from "./publication-target";
import type { CurrentCodeReference } from "./current-public-code-source";
export type PairCodeSelection = Readonly<{ pair: PublicReleasePairReference; expectedPublicSelectorDigest: string;
  previewPairId: string; previewCandidateReceiptId: string | null }>;
export type PairCurrentCodeReference = Readonly<{ schemaVersion: 2; kind: "pair-current-code"; rendererSha: string;
  selection: PairCodeSelection; source: { schemaVersion: 2; kind: "pair"; side: PublicReleasePairReference;
    commitSha: string; codeAssetManifestDigest: string; publicationDigest: string }; pairDigest: string;
  readerDigests: Readonly<{ functions: string; cmsApi: string }>; qualifiedCodeDigest: string; qualifiedCodeBytes: number }>;
/** The renderer normalizes this wire payload with its own retained-context validator.
 * Keep the transport independent of the Site/Node implementation graph. */
export type PairQualifiedCode = Readonly<{ publicContext: unknown;
  publication: CurrentCodeReference["publication"]; reference: CurrentCodeReference; originalProgramImageCatalog?: unknown }>;
export type PairCurrentEditorialReference = Readonly<{ schemaVersion: 2; kind: "pair-current-editorial"; rendererSha: string;
  selection: PairCodeSelection; pairDigest: string; readerDigests: Readonly<{ functions: string; cmsApi: string }>;
  contentHead: Readonly<{ pairId: string; viewId: string; manifestDigest: string; contextSequence: number }>;
  manifest: import("./cms-pair-editorial-context").PairEditorialContextManifest }>;
export type PairCodeTransportOptions = { target: PublicationTarget; rendererSha: string; pairSelection: PairCodeSelection;
  request?: typeof fetch; readSecret?: () => string };
export function createPairCurrentCodeTransport(options: PairCodeTransportOptions): {
  readPairCodeReference(): Promise<PairCurrentCodeReference>;
  readPairCodeContext(): Promise<{ reference: PairCurrentCodeReference; qualifiedCode: PairQualifiedCode }>;
  readPairEditorialReference(): Promise<PairCurrentEditorialReference>;
  readPairEditorialContext(): Promise<{ reference: PairCurrentEditorialReference; source: import("./cms-pair-editorial-context").PairEditorialContextSource }> };
export const MAX_BYTES: number;
export const WIRE_BYTES: number;
export function parsePairCodeSelection(value: unknown): PairCodeSelection;
export function parsePairCodeRequest(value: unknown): { schemaVersion: 2; mode: "current-code-v2" | "current-code-reference-v2" | "current-editorial-v2" | "current-editorial-reference-v2";
  rendererSha: string; selection: PairCodeSelection };
