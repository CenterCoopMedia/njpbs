import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayViewReference, ReplayWitness } from "../../functions/lib/public-release-pair-replay";
import type { PairCatalogImagesManifest, PairCatalogImagesProof } from "../../functions/lib/public-release-pair-catalog-images";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import catalog from "../../functions/lib/public-release-pair-catalog-images.js";
import { openStagedPublicReleasePairCatalogImages } from "./public-release-pair-catalog-image-storage";
import { openPublicReleasePairViewMetadata, type PairViewStore } from "./public-release-pair-view-storage";
import { bytesDigest, same } from "./public-release-pair-reader-contract";
import { PairQualificationError, QUALIFICATION_ROUTE_LIMIT } from "./public-release-pair-qualification-authority";

export type QualificationCatalog = Readonly<{ view: ReplayViewReference; manifest: PairCatalogImagesManifest; proof: PairCatalogImagesProof }>;
export function bindQualificationCatalogs(pair: PublicReleasePair, witness: Pick<ReplayWitness, "codePackView" | "fromCursor" | "headCursor">,
  rawCatalogs: readonly QualificationCatalog[]) {
  const refuse = (): never => { throw new PairQualificationError("coverage-mismatch"); };
  if (!Array.isArray(rawCatalogs) || rawCatalogs.length > QUALIFICATION_ROUTE_LIMIT) refuse();
  const seen = new Set<string>();
  const catalogs = rawCatalogs.map(raw => {
    const reference = replay.parseReplayViewReference(raw.view, pair), key = protocol.publicReleaseDigest(reference);
    if (seen.has(key)) refuse(); seen.add(key);
    const proof = catalog.parsePublicReleasePairCatalogImagesProof(raw.proof, pair, reference.identity, reference.claimDigest, reference.manifestDigest);
    const manifest = catalog.parsePublicReleasePairCatalogImages(raw.manifest, pair, reference.identity, proof.cursor);
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (proof.cursor.baselineDigest !== witness.fromCursor.baselineDigest || proof.cursor.sequence < witness.fromCursor.sequence ||
        proof.cursor.sequence > witness.headCursor.sequence || proof.authority.baselineInputManifestDigest !== witness.codePackView.identity.inputManifestDigest ||
        proof.authority.baselineViewManifestDigest !== witness.codePackView.manifestDigest || proof.descriptor.digest !== bytesDigest(bytes) ||
        proof.descriptor.bytes !== bytes.length || proof.memberCount !== manifest.members.length ||
        proof.memberBytes !== manifest.members.reduce((sum, member) => sum + member.size, 0)) refuse();
    return Object.freeze({ view: reference, manifest, proof });
  }).sort((a, b) => protocol.publicReleaseDigest(a.view).localeCompare(protocol.publicReleaseDigest(b.view)));
  return Object.freeze({ catalogs: Object.freeze(catalogs), catalogProofDigest: protocol.publicReleaseDigest(catalogs) });
}

/** Open actual original G/H authorities before the later transaction. No fresh
 * whole-body read is claimed; qualification separately exhausts actual HTTP. */
export async function openQualificationCatalogs({ firestore, store, pair, witness, references, signal }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; witness: ReplayWitness;
  references: readonly ReplayViewReference[]; signal: AbortSignal;
}) {
  const catalogs: QualificationCatalog[] = [];
  for (let offset = 0; offset < references.length; offset += 4) {
    signal.throwIfAborted();
    const results = await Promise.allSettled(references.slice(offset, offset + 4).map(async reference => {
      const metadata = await openPublicReleasePairViewMetadata({ store, pair, ...reference, signal });
      if (!metadata.root.catalogImages) return null;
      const opened = await openStagedPublicReleasePairCatalogImages({ firestore, store, pair, identity: reference.identity,
        claimDigest: reference.claimDigest, viewManifestDigest: reference.manifestDigest, signal });
      return { view: reference, manifest: opened.manifest, proof: opened.proof };
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const result of results) if (result.status === "fulfilled" && result.value) catalogs.push(result.value);
  }
  return bindQualificationCatalogs(pair, witness, catalogs);
}
export async function assertQualificationCatalogsInTransaction({ firestore, transaction, pair, witness, catalogs: rawCatalogs, expectedDigest }: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair; witness: ReplayWitness;
  catalogs: readonly QualificationCatalog[]; expectedDigest: string;
}) {
  const bound = bindQualificationCatalogs(pair, witness, rawCatalogs);
  if (bound.catalogProofDigest !== expectedDigest) throw new PairQualificationError("stale-qualification");
  for (let offset = 0; offset < bound.catalogs.length; offset += 4) {
    const results = await Promise.allSettled(bound.catalogs.slice(offset, offset + 4).map(async selected => {
      const proof = await catalog.assertReadPublicReleasePairCatalogImagesInTransaction({ firestore, transaction, pair,
        identity: selected.view.identity, claimDigest: selected.view.claimDigest, viewManifestDigest: selected.view.manifestDigest,
        manifest: selected.manifest, manifestDigest: selected.proof.descriptor.digest });
      if (!same(proof, selected.proof)) throw new PairQualificationError("stale-qualification");
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  return bound;
}
