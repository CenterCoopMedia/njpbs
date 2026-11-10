import { createHash } from "node:crypto";
import type { PairInputRoot } from "../../functions/lib/public-release-pair-input";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairCatalogImageAuthority, PairCatalogImageMember } from "../../functions/lib/public-release-pair-catalog-images";
import codec from "../../functions/lib/public-release-pair-catalog-images.js";
import protocol from "../../functions/lib/public-release-pair.js";
import views from "../../functions/lib/public-release-pair-view.js";
import { projectPublicReleasePairReplay, assertPublicReleasePairReplayInput, type PairReplayContext } from "./public-release-pair-replay";
import { programImageBytes, type ProgramImageFile } from "../src/lib/published-record-images";
export { PairCatalogImageError, parsePublicReleasePairCatalogImages, assertPublicReleasePairCatalogBaseline } from "../../functions/lib/public-release-pair-catalog-images";
export type { PairCatalogImagesManifest, PairCatalogImageMember, PairCatalogImageAuthority } from "../../functions/lib/public-release-pair-catalog-images";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Source/reader/catalog validation runs before any new file authority exists.
 * The input and original source seals remain unchanged. No wildcard is issued. */
export async function derivePublicReleasePairCatalogImages(options: { pair: PublicReleasePair; identity: PairTaskIdentity; root: PairInputRoot;
  contexts: AsyncIterable<PairReplayContext> }) {
  const catalogs = new Map<string, PairCatalogImageAuthority>(), members = new Map<string, PairCatalogImageMember>(), files = new Map<string, ProgramImageFile>();
  for await (const context of options.contexts) {
    if (context.route.renderer !== "record") continue;
    const original = assertPublicReleasePairReplayInput(context), replay = await projectPublicReleasePairReplay(context);
    const catalog = (replay.content as import("../src/lib/published-record-render").PublishedRecordContent).programImageDescriptors;
    if (!catalog?.files.length) continue;
    const authority = { catalogDigest: protocol.publicReleaseDigest(catalog), inputFile: context.route.inputFile, inputDigest: context.inputDigest,
      provenanceDigest: context.provenanceDigest, originalPairDigest: protocol.publicReleaseDigest(original.provenance.pair), rendererSha: original.originalSha,
      readerContractDigest: original.provenance.readerContractDigest, readerReceiptDigest: original.provenance.readerReceiptDigest,
      sourceSealDigest: protocol.publicReleaseDigest(original.sourceSeal) };
    const authorityDigest = protocol.publicReleaseDigest(authority);
    catalogs.set(authorityDigest, { authorityDigest, ...authority });
    for (const file of catalog.files) {
      const before = members.get(file.path);
      if (before && (before.mime !== file.contentType || before.size !== file.size || before.sha256 !== file.digest)) throw new codec.PairCatalogImageError("catalog-baseline-collision");
      files.set(file.path, file);
      members.set(file.path, { path: file.path, mime: file.contentType, size: file.size, sha256: file.digest,
        authorities: [...new Set([...(before?.authorities ?? []), authorityDigest])].sort() });
    }
  }
  const manifest = codec.parsePublicReleasePairCatalogImages({ schemaVersion: 1, kind: "pair-catalog-images", pairDigest: protocol.publicReleaseDigest(options.pair),
    inputManifestDigest: options.identity.inputManifestDigest, cursor: options.root.cursor, catalogs: [...catalogs.values()].sort((a, b) => a.authorityDigest < b.authorityDigest ? -1 : 1),
    members: [...members.values()].sort((a, b) => views.comparePrivatePairArtifactPaths(a.path, b.path)) }, options.pair, options.identity, options.root.cursor);
  return { manifest, async readMember(path: string) {
    const file = files.get(path); if (!file) throw new codec.PairCatalogImageError("catalog-unlisted");
    const bytes = programImageBytes(file); if (hash(bytes) !== file.digest) throw new codec.PairCatalogImageError(); return bytes;
  } };
}
