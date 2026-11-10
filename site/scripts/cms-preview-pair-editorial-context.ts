import { COVERAGE_LABELS_SETTINGS_ID } from "../../packages/content-core/src/cms-settings.ts";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { firebaseAdminRuntime } from "./firebase-admin-runtime.ts";
import type { PairEditorialContextSource } from "../../functions/lib/cms-pair-editorial-context";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, SITE_NAVIGATION_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID, NJ_DECIDES_SETTINGS_ID } from "../../packages/content-core/src/cms-settings.ts";
import { assertPublicArtifactBundle, type PublicArtifactBundle } from "../src/lib/public-artifact-bundle";
import { projectPublicArtifactContent, type PublicArtifactContentRead } from "../src/lib/cms-loader";
import { resolveApprovedLibraryVersions, type HistoryDatabase, type HistoryQuery } from "../src/lib/approved-library-records";
import { createPreviewPairContextReader, readPreviewPairContextAuthority, type PreviewPairContextOptions } from "./cms-preview-pair-context";
import { EditorialPreviewContextNotReadyError } from "./cms-preview-editorial-context";
import type { PublicPublicationReceipt } from "../src/lib/public-publication-receipt";
import { assertProgramImageCatalog, verifyProgramImageCatalog, programImageReferences, type ProgramImageCatalog } from "../src/lib/published-record-images";
const require = createRequire(import.meta.url), codec = require("../../functions/lib/cms-pair-editorial-context.js");
const protocol = require("../../functions/lib/public-release-pair.js");

/** Private rendering inventory derived from the selected immutable H/G DTO.
 * Its receipt is an internal inventory, never evidence of a public deployment.
 * Original CODE and Home publication identities are left intact. */
export async function projectPairEditorialPreviewSource(raw: PairEditorialContextSource, pair: PublicReleasePair): Promise<PublicArtifactBundle> {
  const source = codec.parsePairEditorialContextSource(raw, pair) as PairEditorialContextSource;
  const documents = new Map(source.documents.map(row => [row.path, structuredClone(row.data)]));
  const time = firebaseAdminRuntime.Timestamp.fromDate(new Date(source.renderedAt));
  // The library resolver needs only this exact immutable approval-history query.
  // Supplying that narrow facade also keeps the Node bundle independent of the
  // public executor's wider SDK reader and its provider capabilities.
  const history = new Map<string, Record<string, unknown>[]>();
  for (const [path, data] of documents) if (path.startsWith("cmsVersionHistory/") && data.collection === "cmsPosts" && typeof data.documentId === "string") {
    history.set(data.documentId, [...(history.get(data.documentId) ?? []), data]);
  }
  const query = (filters: Record<string, string> = {}): HistoryQuery => ({
    where(field, operator, value) {
      if (!["collection", "documentId"].includes(field) || operator !== "==" || Object.hasOwn(filters, field)) throw new Error("Unsupported frozen approval query");
      return query({ ...filters, [field]: value });
    }, async get() {
      if (filters.collection !== "cmsPosts" || typeof filters.documentId !== "string") throw new Error("Incomplete frozen approval query");
      return { docs: (history.get(filters.documentId) ?? []).map(data => ({ data: () => structuredClone(data) })) };
    },
  });
  const frozen: HistoryDatabase = { collection(name) { if (name !== "cmsVersionHistory") throw new Error("Unsupported frozen approval collection"); return query(); } };
  const rows = (collection: string) => [...documents].filter(([path]) => path.startsWith(`${collection}/`) && path.split("/").length === 2)
    .map(([path, data]) => ({ ...data, id: path.slice(collection.length + 1) }));
  const setting = (id: string) => documents.has(`cmsSettings/${id}`) ? { ...documents.get(`cmsSettings/${id}`), id } : undefined;
  const home = source.homeSources as NonNullable<PublicArtifactBundle["homeSources"]>, publication = home.publication;
  if (!publication) throw new Error("Paired Home publication is unavailable");
  const posts = await resolveApprovedLibraryVersions(frozen, rows("cmsPosts"));
  const input = { pages: rows("cmsPages"), posts, authors: rows("cmsAuthorProfilesPublic").map(({ id, ...data }) => ({ authorId: id, data })),
    setting: setting(PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID), navigation: setting(SITE_NAVIGATION_SETTINGS_ID),
    chrome: setting(PUBLIC_SITE_CHROME_SETTINGS_ID), njDecides: setting(NJ_DECIDES_SETTINGS_ID), coverageLabels: setting(COVERAGE_LABELS_SETTINGS_ID), assets: rows("media_assets_public"),
    reservation: { schemaVersion: 1, ...publication, reservedAgainstGeneration: 0,
      reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt: time, reservedAt: time },
    admissionTime: time.toDate() } as unknown as PublicArtifactContentRead;
  const projected = projectPublicArtifactContent(input);
  let programImageDescriptors: ProgramImageCatalog | undefined;
  if (source.originalCode.programImageDescriptors !== undefined) {
    const original = source.originalCode.programImageDescriptors as ProgramImageCatalog;
    // Validate every original descriptor/file before deriving a smaller private
    // inventory. Its image bytes and original key-art source never change.
    assertProgramImageCatalog(original, original.programs.map(entry => ({ programId: entry.programId, sourceVersion: entry.sourceVersion,
      path: entry.path, keyArt: entry.original })), { rendererSha: source.sourcePair.commitSha });
    await verifyProgramImageCatalog(original);
    const programs = projected.programs.filter(program => program.keyArt).map(program => {
      const entry = original.programs.find(entry => entry.programId === program.programId);
      if (!entry || !isDeepStrictEqual(entry.original, program.keyArt)) throw new Error("Frozen paired program art is unavailable");
      return { ...entry, sourceVersion: program.sourceVersion, path: program.path };
    });
    const referenced = new Set(programs.flatMap(program => [program.content, program.grid].flatMap(programImageReferences)));
    programImageDescriptors = { ...original, buildBatchId: projected.receipt.buildBatchId, generation: projected.receipt.generation,
      rendererSha: projected.receipt.commitSha, mediaManifestDigest: projected.receipt.mediaManifestDigest, programs,
      files: original.files.filter(file => referenced.has(file.path)) };
  }
  return assertPublicArtifactBundle({ schemaVersion: 3, ...projected, homeSources: home,
    ...(programImageDescriptors === undefined ? {} : { programImageDescriptors }) });
}
export type PairEditorialLegacyReader = (publication: PublicPublicationReceipt) => Promise<{ publicContext: PublicArtifactBundle; publication: PublicPublicationReceipt }>;
export function createPreviewPairEditorialContextReader(options: PreviewPairContextOptions) {
  const codeReader = createPreviewPairContextReader(options);
  let cached: { digest: string; value: PublicArtifactBundle; publication: PublicPublicationReceipt } | undefined;
  return async (readLegacy: PairEditorialLegacyReader) => {
    const before = await readPreviewPairContextAuthority(options);
    if (before.publicSchemaVersion === 1) {
      // The legacy aggregate reader retains its original selection/checkpoint
      // fences. CODE is supplied by the admitted v2 bridge, not a SHA-bound HTTP
      // fallback. Schema adoption or source movement invalidates the result.
      try {
        const code = await codeReader(), result = await readLegacy(code.publication);
        const afterCode = await codeReader();
        if (!isDeepStrictEqual(before, await readPreviewPairContextAuthority(options)) ||
            !isDeepStrictEqual(code.codeReferenceV2, afterCode.codeReferenceV2)) throw new EditorialPreviewContextNotReadyError();
        return result;
      } catch (error) {
        if (!isDeepStrictEqual(before, await readPreviewPairContextAuthority(options))) throw new EditorialPreviewContextNotReadyError();
        throw error;
      }
    }
    const transport = options.createTransport({ target: options.target, rendererSha: options.rendererSha,
      pairSelection: before.selection, readSecret: options.readSecret });
    if (!transport.readPairEditorialReference || !transport.readPairEditorialContext) throw new Error("Paired editorial transport is unbound");
    try {
      const reference = await transport.readPairEditorialReference();
      const valid = (value: typeof reference) => {
        if (value?.schemaVersion !== 2 || value.kind !== "pair-current-editorial" || value.rendererSha !== options.rendererSha ||
            !isDeepStrictEqual(value.selection, before.selection) || value.pairDigest !== before.pairDigest ||
            !/^[a-f0-9]{64}$/.test(value.readerDigests?.functions) || !/^[a-f0-9]{64}$/.test(value.readerDigests?.cmsApi)) throw new Error("Paired editorial identity differs");
        codec.parsePairEditorialContextManifest(value.manifest, before.publicPair);
      };
      valid(reference);
      let publicContext: PublicArtifactBundle, publication: PublicPublicationReceipt;
      if (cached?.digest === reference.manifest.bodyDigest) { publicContext = structuredClone(cached.value); publication = structuredClone(cached.publication); }
      else {
        const result = await transport.readPairEditorialContext(); valid(result.reference);
        if (!isDeepStrictEqual(reference, result.reference)) throw new EditorialPreviewContextNotReadyError();
        const source = codec.parsePairEditorialContextSource(result.source, before.publicPair) as PairEditorialContextSource;
        if (protocol.publicReleaseDigest(source.identity) !== protocol.publicReleaseDigest(reference.manifest.identity) ||
            source.claimDigest !== reference.manifest.claimDigest || source.viewManifestDigest !== reference.manifest.viewManifestDigest ||
            protocol.publicReleaseDigest(source.cursor) !== protocol.publicReleaseDigest(reference.manifest.cursor)) throw new Error("Paired editorial source differs");
        publicContext = await projectPairEditorialPreviewSource(source, before.publicPair);
        publication = structuredClone(source.originalCode.reference.publication);
        cached = { digest: reference.manifest.bodyDigest, value: structuredClone(publicContext), publication: structuredClone(publication) };
      }
      // A cache hit still verifies today's actual head and deployed reader
      // cohort through the real producer, after any projection/I/O.
      if (!isDeepStrictEqual(reference, await transport.readPairEditorialReference()) ||
          !isDeepStrictEqual(before, await readPreviewPairContextAuthority(options))) throw new EditorialPreviewContextNotReadyError();
      return { publicContext, publication, pairEditorialReference: reference };
    } catch (error) {
      if (error instanceof EditorialPreviewContextNotReadyError) throw error;
      // A pending or missing side output is deliberately preview-only. The
      // bounded existing refresh loop owns its retry and staff status.
      if ((error as { code?: unknown })?.code === "pair_editorial_context_refreshing" ||
          !isDeepStrictEqual(before, await readPreviewPairContextAuthority(options))) throw new EditorialPreviewContextNotReadyError();
      throw error;
    }
  };
}
