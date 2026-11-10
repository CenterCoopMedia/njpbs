import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayViewReference, ReplayWitness } from "../../functions/lib/public-release-pair-replay";
import type { PairCompositeManifest, PairCompositeProof } from "../../functions/lib/public-release-pair-composite-view";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import { openStagedPublicReleasePairComposite } from "./public-release-pair-composite-storage";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { same } from "./public-release-pair-reader-contract";
import { PairQualificationError, QUALIFICATION_ROUTE_LIMIT } from "./public-release-pair-qualification-authority";

export type QualificationComposite = Readonly<{ view: ReplayViewReference; manifest: PairCompositeManifest; proof: PairCompositeProof }>;
export function bindQualificationComposites(pair: PublicReleasePair, witness: Pick<ReplayWitness, "codePackView" | "fromCursor" | "headCursor">,
  rawComposites: readonly QualificationComposite[]) {
  const refuse = (): never => { throw new PairQualificationError("coverage-mismatch"); };
  if (!Array.isArray(rawComposites) || rawComposites.length > QUALIFICATION_ROUTE_LIMIT) refuse();
  const seen = new Set<string>();
  const composites = rawComposites.map(raw => {
    const reference = replay.parseReplayViewReference(raw.view, pair), key = protocol.publicReleaseDigest(reference);
    if (seen.has(key) || same(reference, witness.codePackView)) refuse(); seen.add(key);
    const proof = composite.parsePublicReleasePairCompositeProof(raw.proof, pair, reference.identity, reference.claimDigest, reference.manifestDigest);
    const manifest = composite.parsePublicReleasePairCompositeManifest(raw.manifest, pair, reference.identity, proof.cursor);
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (proof.cursor.baselineDigest !== witness.fromCursor.baselineDigest || proof.cursor.sequence < witness.fromCursor.sequence ||
        proof.cursor.sequence > witness.headCursor.sequence || !same(proof.authority, manifest.authority) ||
        proof.authority.baselineInputManifestDigest !== witness.codePackView.identity.inputManifestDigest ||
        proof.authority.baselineViewManifestDigest !== witness.codePackView.manifestDigest ||
        proof.descriptor.digest !== composite.publicReleasePairCompositeManifestDigest(manifest) || proof.descriptor.bytes !== bytes.length ||
        proof.outputCount !== manifest.members.length || proof.outputBytes !== manifest.members.reduce((sum, member) => sum + member.size, 0) ||
        proof.routeCount !== manifest.members.filter(member => member.role === "route").length) refuse();
    return Object.freeze({ view: reference, manifest, proof });
  }).sort((a, b) => protocol.publicReleaseDigest(a.view).localeCompare(protocol.publicReleaseDigest(b.view)));
  return Object.freeze({ composites: Object.freeze(composites), compositeProofDigest: protocol.publicReleaseDigest(composites) });
}

/** Single owner adapter for complete original H/G output authority. Every
 * non-baseline selected view requires the actual composite proof; a missing
 * link, omitted member or failed read never falls back to a dynamic flag. */
export async function openQualificationComposites({ firestore, store, pair, witness, references, signal }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; witness: ReplayWitness;
  references: readonly ReplayViewReference[]; signal: AbortSignal;
}) {
  const selected = references.filter(reference => !same(reference, witness.codePackView)), composites: QualificationComposite[] = [];
  for (let offset = 0; offset < selected.length; offset += 4) {
    signal.throwIfAborted();
    const results = await Promise.allSettled(selected.slice(offset, offset + 4).map(async reference => {
      const opened = await openStagedPublicReleasePairComposite({ firestore, store, pair, identity: reference.identity,
        claimDigest: reference.claimDigest, viewManifestDigest: reference.manifestDigest, signal });
      return { view: reference, manifest: opened.manifest, proof: opened.proof };
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    for (const result of results) if (result.status === "fulfilled") composites.push(result.value);
  }
  return bindQualificationComposites(pair, witness, composites);
}
export async function assertQualificationCompositesInTransaction({ firestore, transaction, pair, witness, composites, expectedDigest }: {
  firestore: Firestore; transaction: Transaction; pair: PublicReleasePair; witness: ReplayWitness;
  composites: readonly QualificationComposite[]; expectedDigest: string;
}) {
  const bound = bindQualificationComposites(pair, witness, composites);
  if (bound.compositeProofDigest !== expectedDigest) throw new PairQualificationError("stale-qualification");
  for (let offset = 0; offset < bound.composites.length; offset += 4) {
    const results = await Promise.allSettled(bound.composites.slice(offset, offset + 4).map(async selected => {
      const proof = await composite.assertReadPublicReleasePairCompositeInTransaction({ firestore, transaction, pair,
        identity: selected.view.identity, claimDigest: selected.view.claimDigest, viewManifestDigest: selected.view.manifestDigest,
        manifest: selected.manifest, manifestDigest: selected.proof.descriptor.digest });
      if (!same(proof, selected.proof)) throw new PairQualificationError("stale-qualification");
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  return bound;
}
