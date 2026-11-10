import { openStagedPublicReleasePairComposite } from "./public-release-pair-composite-storage";
import compositeCodec from "../../functions/lib/public-release-pair-composite-view.js";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayViewReference } from "../../functions/lib/public-release-pair-replay";
import type { PairRenderPlan } from "./public-release-pair-render-plan";
import type { PairViewStore } from "./public-release-pair-view-storage";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import { openPublicReleasePairViewMetadata } from "./public-release-pair-view-storage";
import {
  preparePublicReleasePairReplayReadback,
  publicReleasePairReplayProofPath,
  openStagedPublicReleasePairReplayTargets,
} from "./public-release-pair-replay-storage";
import { openStagedPublicReleasePairCatalogImages } from "./public-release-pair-catalog-image-storage";
import {
  openStagedPublicReleasePairSearchNamespace,
  openStagedPublicReleasePairContentFeedNamespace,
} from "./public-release-pair-namespace-storage";

/** The sole boundary to the executor's combined output proof. This version
 * consumes only installed owner APIs; missing composite/auxiliary proof still
 * refuses. No provisional durable fields or row-skipping fallback are used. */
export async function prepareReplayOutputReadback({
  firestore,
  store,
  pair,
  reference,
  ordinaryPlan,
  signal,
}: {
  firestore: Firestore;
  store: PairViewStore;
  pair: PublicReleasePair;
  reference: ReplayViewReference;
  ordinaryPlan: PairRenderPlan;
  signal?: AbortSignal;
}) {
  const owner = {
    firestore,
    store,
    pair,
    identity: reference.identity,
    claimDigest: reference.claimDigest,
    viewManifestDigest: reference.manifestDigest,
    signal,
  };
  const metadata = await openPublicReleasePairViewMetadata({
    ...owner,
    manifestDigest: reference.manifestDigest,
    manifestBytes: reference.manifestBytes,
  });
  const supplementalPaths = new Set<string>();
  let catalogImages: import("../../functions/lib/public-release-pair-catalog-images").PairCatalogImagesManifest | null =
    null;
  if (metadata.root.namespaces) {
    const selectedSearch = await openStagedPublicReleasePairSearchNamespace(owner);
    const selectedFeed = await openStagedPublicReleasePairContentFeedNamespace(owner);
    await selectedSearch.verifyAll();
    await selectedFeed.verifyAll();
    for (const member of [
      ...selectedSearch.manifest.members,
      ...selectedFeed.manifest.members,
      selectedFeed.manifest.index,
    ])
      supplementalPaths.add(member.path);
  }
  if (metadata.root.catalogImages) {
    const catalog = await openStagedPublicReleasePairCatalogImages(owner);
    await catalog.verifyAll();
    catalogImages = catalog.manifest;
    for (const member of catalog.manifest.members) supplementalPaths.add(member.path);
  }
  if (metadata.root.composite) {
    const combined = await openStagedPublicReleasePairComposite(owner);
    if (protocol.publicReleaseDigest(combined.ordinaryPlan) !== protocol.publicReleaseDigest(ordinaryPlan))
      throw new replay.PairReplayError("replay-render-plan-mismatch");
    const targets = await openStagedPublicReleasePairReplayTargets(owner);
    for (const member of combined.manifest.members) if (member.role !== "route") supplementalPaths.add(member.path);
    let index = 0;
    return {
      ordinaryPlan: combined.ordinaryPlan,
      plan: combined.plan,
      supplementalPaths,
      catalogImages,
      compositeManifest: combined.manifest,
      async output(
        output: import("../../functions/lib/public-release-pair-view").PairViewOutput & { body: Uint8Array },
      ) {
        const member = combined.manifest.members[index++];
        if (
          !member ||
          member.path !== output.path ||
          member.status !== output.status ||
          member.mime !== output.headers["content-type"] ||
          member.sha256 !== output.bodyDigest ||
          member.size !== output.bytes ||
          output.headers["x-njpbs-renderer-sha"] !== pair.commitSha
        )
          throw new replay.PairReplayError("replay-output-coverage-missing");
      },
      async complete() {
        if (index !== combined.manifest.members.length)
          throw new replay.PairReplayError("replay-output-coverage-missing");
        await firestore.runTransaction(
          (transaction) =>
            compositeCodec.assertReadPublicReleasePairCompositeInTransaction({
              ...owner,
              transaction,
              manifest: combined.manifest,
              manifestDigest: compositeCodec.publicReleasePairCompositeManifestDigest(combined.manifest),
            }),
          { readOnly: true },
        );
        const stored = (
          await firestore.doc(publicReleasePairReplayProofPath(pair, reference.manifestDigest)).get()
        ).data();
        if (!stored || protocol.publicReleaseDigest(stored) !== protocol.publicReleaseDigest(targets.record))
          throw new replay.PairReplayError("replay-render-target-proof-missing");
        return { renderTargetProofDigest: protocol.publicReleaseDigest(stored) };
      },
    };
  }
  const targetReadback = await preparePublicReleasePairReplayReadback(owner);
  return {
    ordinaryPlan,
    plan: ordinaryPlan,
    supplementalPaths,
    catalogImages,
    compositeManifest: null,
    output: targetReadback.output,
    async complete() {
      await targetReadback.complete();
      const stored = (
        await firestore.doc(publicReleasePairReplayProofPath(pair, reference.manifestDigest)).get()
      ).data();
      if (!stored || protocol.publicReleaseDigest(stored) !== protocol.publicReleaseDigest(targetReadback.record()))
        throw new replay.PairReplayError("replay-render-target-proof-missing");
      return { renderTargetProofDigest: protocol.publicReleaseDigest(stored) };
    },
  };
}
