import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicPublicationReceipt } from "../src/lib/public-publication-receipt.ts";
import { assertContextMatchesPublication } from "../src/lib/retained-public-context.ts";
import type { PublicationTarget } from "../../functions/lib/publication-target";
import { EditorialPreviewContextNotReadyError } from "./cms-preview-editorial-context";

const require = createRequire(import.meta.url);
const preview = require("../../functions/lib/cms-preview-pair-candidate.js");
const previewPairs = require("../../functions/lib/cms-preview-pair.js");
const publicPairs = require("../../functions/lib/public-release-pair.js");
const work = require("../../functions/lib/public-release-pair-work.js");
type PairReference = { pairId: string; commitSha: string; publicWorkerVersionId: string };
export type Selection = { pair: PairReference; expectedPublicSelectorDigest: string; previewPairId: string; previewCandidateReceiptId: string | null };
type Reference = { schemaVersion: 2; kind: "pair-current-code"; rendererSha: string; selection: Selection;
  pairDigest: string; qualifiedCodeDigest: string; qualifiedCodeBytes: number;
  readerDigests: { functions: string; cmsApi: string };
  source: { schemaVersion: 2; kind: "pair"; side: PairReference; commitSha: string; codeAssetManifestDigest: string; publicationDigest: string } };
type Context = { publicContext: ReturnType<typeof assertContextMatchesPublication>; publication: PublicPublicationReceipt };
// Structural boundary to the versioned CODE transport.
// Its actual implementation verifies exact wire bytes, DTO and reader receipts.
export type PreviewPairCodeTransportFactory = (options: { target: PublicationTarget; rendererSha: string;
  pairSelection: Selection; readSecret: () => string; request?: typeof fetch }) => {
  readPairCodeReference(): Promise<Reference>;
  readPairCodeContext(): Promise<{ reference: Reference; qualifiedCode: { publicContext: unknown; publication: PublicPublicationReceipt } }>;
  readPairEditorialReference?(): Promise<import("../../functions/lib/current-public-code-v2").PairCurrentEditorialReference>;
  readPairEditorialContext?(): Promise<{ reference: import("../../functions/lib/current-public-code-v2").PairCurrentEditorialReference;
    source: import("../../functions/lib/cms-pair-editorial-context").PairEditorialContextSource }>;
};
const hex = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const refuse = () => { throw new Error("Versioned preview context is unavailable"); };

export type PreviewPairContextOptions = { firestore: Firestore; rendererSha: string; pairId: string; workerVersion: string; target: PublicationTarget;
  readSecret: () => string; createTransport: PreviewPairCodeTransportFactory };
export function readPreviewPairContextAuthority({ firestore, rendererSha, pairId, workerVersion, target }: PreviewPairContextOptions) {
  return firestore.runTransaction(async transaction => {
    const read = async (path: string) => (await transaction.get(firestore.doc(path))).data();
    const previewAuthority = await preview.readPreviewPairRuntimeAuthority({ read, pairId, rendererSha, workerVersion });
    const root = await read("system/publicDeployment");
    // Match the CODE authority's stored-selector normalization before hashing;
    // updatedAt is valid storage metadata, not part of schema-two selection.
    const publicSelector = root?.schemaVersion === 2 ? publicPairs.parseStoredPublicReleaseSelector(root) : root;
    let bootstrapPublicPair = previewAuthority.bootstrapPublicPair;
    if (root?.schemaVersion === 1 && previewAuthority.mode === "retained") {
      // Preview bootstrap precedes the public-root CAS. Retention no longer
      // depends on candidate freshness, but still needs its originally bound
      // public OLD reference until that separate CAS commits.
      const pointer = await read(`${preview.POINTERS}/${pairId}`);
      if (pointer?.schemaVersion !== 1 || pointer.pairId !== pairId || pointer.pairDigest !== previewPairs.digest(previewAuthority.pair)) refuse();
      bootstrapPublicPair = pointer!.bootstrapPublicPair;
    }
    const reference = root?.schemaVersion === 2 ? publicSelector.selectedPair
      : publicPairs.parsePublicReleasePairReference(bootstrapPublicPair);
    if (root?.schemaVersion !== 2 && (root?.schemaVersion !== 1 || root.activeCommitSha !== reference.commitSha)) refuse();
    const registered = publicPairs.parsePublicReleasePair(await read(work.publicReleasePairPath(reference.pairId)));
    if (registered.environment !== target.environment || !isDeepStrictEqual(publicPairs.publicReleasePairReference(registered), reference)) refuse();
    return { selection: { pair: reference, expectedPublicSelectorDigest: publicPairs.publicReleaseDigest(publicSelector),
      previewPairId: pairId, previewCandidateReceiptId: previewAuthority.candidateReceiptId } as Selection,
    pairDigest: publicPairs.publicReleaseDigest(registered) as string,
    publicPair: registered as import("../../packages/content-core/src/public-release").PublicReleasePair,
    publicSchemaVersion: root!.schemaVersion as 1 | 2 };
  }, { readOnly: true });
}
/** Always recheck authority and the current deployed reader cohort. Cache only
 * the immutable, verified DTO bytes; never a selector or freshness observation. */
export function createPreviewPairContextReader(options: PreviewPairContextOptions) {
  const { rendererSha, target, readSecret, createTransport } = options;
  if (typeof createTransport !== "function" || typeof readSecret !== "function") refuse();
  let cached: { digest: string; value: Context } | undefined;
  const authority = () => readPreviewPairContextAuthority(options);
  return async () => {
    const before = await authority();
    try {
    const transport = createTransport({ target, rendererSha, pairSelection: before.selection, readSecret });
    const reference = await transport.readPairCodeReference();
    const validReference = (value: Reference) => {
      if (value?.schemaVersion !== 2 || value.kind !== "pair-current-code" || value.rendererSha !== rendererSha ||
          !isDeepStrictEqual(value.selection, before.selection) || value.pairDigest !== before.pairDigest ||
          value.source?.schemaVersion !== 2 || value.source.kind !== "pair" || !isDeepStrictEqual(value.source.side, before.selection.pair) ||
          value.source.commitSha !== before.selection.pair.commitSha || !hex(value.qualifiedCodeDigest) ||
          !Number.isSafeInteger(value.qualifiedCodeBytes) || value.qualifiedCodeBytes < 1 || value.qualifiedCodeBytes > 20 * 1024 * 1024 ||
          !hex(value.readerDigests?.functions) || !hex(value.readerDigests?.cmsApi)) refuse();
    };
    validReference(reference);
    let context: Context;
    if (cached?.digest === reference.qualifiedCodeDigest) context = structuredClone(cached.value);
    else {
      const read = await transport.readPairCodeContext();
      validReference(read.reference);
      if (!isDeepStrictEqual(read.reference, reference)) throw new EditorialPreviewContextNotReadyError();
      if (!read.qualifiedCode?.publicContext || read.qualifiedCode.publication?.commitSha !== reference.source.commitSha) refuse();
      context = structuredClone({ publicContext: assertContextMatchesPublication(read.qualifiedCode.publicContext, read.qualifiedCode.publication), publication: read.qualifiedCode.publication });
      cached = { digest: reference.qualifiedCodeDigest, value: structuredClone(context) };
    }
    // Even a cache hit cannot bypass a selector/candidate change during I/O.
    if (!isDeepStrictEqual(before, await authority())) throw new EditorialPreviewContextNotReadyError();
    return { ...context, codeReferenceV2: structuredClone(reference) };
    } catch (error) {
      if (error instanceof EditorialPreviewContextNotReadyError) throw error;
      // A versioned request can lose its selector fence before the bridge
      // responds. Retry only an observed authority change; preserve real
      // malformed DTO/provider failures when that authority is unchanged.
      let changed = false;
      try { changed = !isDeepStrictEqual(before, await authority()); } catch { /* Preserve the original refusal. */ }
      if (changed) throw new EditorialPreviewContextNotReadyError();
      throw error;
    }
  };
}
