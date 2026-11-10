import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { ReplayCursor, ReplayViewReference } from "../../functions/lib/public-release-pair-replay";
import type { ReplayOutput } from "../../functions/lib/public-release-pair-replay-inventory";
import type { PairCodePack } from "./public-release-pair-code-pack";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import type { PairCompositeManifest } from "../../functions/lib/public-release-pair-composite-view";
import catalog from "../../functions/lib/public-release-pair-catalog-images.js";
import { createRequire } from "node:module";
const capsules = createRequire(import.meta.url)("../../functions/lib/public-release-pair-replay-capsule.js");
import type { PairCatalogImagesManifest } from "../../functions/lib/public-release-pair-catalog-images";
import inventory from "../../functions/lib/public-release-pair-replay-inventory.js";

async function immutable(firestore: Firestore, path: string, value: Record<string, unknown>) {
  return firestore.runTransaction(async (transaction) => {
    const ref = firestore.doc(path),
      row = await transaction.get(ref);
    if (row.exists) {
      if (protocol.publicReleaseDigest(row.data()) !== protocol.publicReleaseDigest(value))
        throw new protocol.PublicReleaseProtocolError();
    } else transaction.create(ref, value);
  });
}
/** Only call after full H/plan/G readback and original completed-owner proof. */
export async function stageReplayOutputInventory({
  firestore,
  pair,
  reference,
  cursor,
  outputs,
  renderTargetProofDigest = null,
  catalogImages = null,
  compositeManifest = null,
}: {
  firestore: Firestore;
  pair: PublicReleasePair;
  reference: ReplayViewReference;
  cursor: ReplayCursor;
  outputs: readonly ReplayOutput[];
  renderTargetProofDigest?: string | null;
  catalogImages?: PairCatalogImagesManifest | null;
  compositeManifest?: PairCompositeManifest | null;
}) {
  const base = work.publicReleasePairPath(pair.pairId),
    pages: string[] = [];
  const verified = await firestore.runTransaction(
    async (transaction) => {
      await work.assertPublicReleasePairCompletedReceiptInTransaction({
        firestore,
        transaction,
        pair,
        taskId: protocol.publicReleaseDigest(reference.identity),
        manifestDigest: reference.manifestDigest,
        claimDigest: reference.claimDigest,
      });
      const staged = (await transaction.get(firestore.doc(`${base}/views/${reference.manifestDigest}`))).data();
      return inventory.verifyReplayOutputReadback({ pair, reference, cursor, outputs, staged });
    },
    { readOnly: true },
  );
  if (renderTargetProofDigest) {
    const target = (await firestore.doc(`${base}/renderTargets/${reference.manifestDigest}`).get()).data();
    if (!target || protocol.publicReleaseDigest(target) !== renderTargetProofDigest)
      throw new protocol.PublicReleaseProtocolError();
  }
  let pending: ReplayOutput[] = [],
    pendingBytes = 0;
  const pageValue = (rows: readonly ReplayOutput[]) => ({
    schemaVersion: 2,
    pairDigest: protocol.publicReleaseDigest(pair),
    referenceDigest: protocol.publicReleaseDigest(reference),
    cursor,
    index: pages.length,
    outputs: rows,
  });
  const flush = async () => {
    if (!pending.length) return;
    const page = pageValue(pending),
      digest = protocol.publicReleaseDigest(page);
    await immutable(firestore, `${base}/replayOutputPages/${digest}`, page);
    pages.push(digest);
    pending = [];
    pendingBytes = 0;
  };
  for (const output of verified) {
    const size = Buffer.byteLength(JSON.stringify(output));
    if (pending.length && (pending.length === 256 || pendingBytes + 1 + size > 512 * 1024)) await flush();
    pendingBytes = pending.length ? pendingBytes + 1 + size : Buffer.byteLength(JSON.stringify(pageValue([]))) + size;
    if (pendingBytes > 512 * 1024 || pages.length >= 1024) throw new protocol.PublicReleaseProtocolError();
    pending.push(output);
  }
  await flush();
  let catalogDescriptor = null;
  if (catalogImages) {
    const manifest = catalog.parsePublicReleasePairCatalogImages(catalogImages, pair, reference.identity, cursor);
    await firestore.runTransaction(
      (transaction) =>
        catalog.assertReadPublicReleasePairCatalogImagesInTransaction({
          firestore,
          transaction,
          pair,
          identity: reference.identity,
          claimDigest: reference.claimDigest,
          viewManifestDigest: reference.manifestDigest,
          manifest,
          manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
        }),
      { readOnly: true },
    );
    catalogDescriptor = await capsules.writeReplayNamespaceProof({ firestore, pair, namespaces: [manifest] });
  }
  let compositeDescriptor = null;
  if (compositeManifest) {
    const manifest = inventory.assertReplayCompositeOutputs({
      pair,
      reference,
      cursor,
      outputs: verified,
      manifest: compositeManifest,
    });
    await firestore.runTransaction(
      (transaction) =>
        composite.assertReadPublicReleasePairCompositeInTransaction({
          firestore,
          transaction,
          pair,
          identity: reference.identity,
          claimDigest: reference.claimDigest,
          viewManifestDigest: reference.manifestDigest,
          manifest,
          manifestDigest: composite.publicReleasePairCompositeManifestDigest(manifest),
        }),
      { readOnly: true },
    );
    compositeDescriptor = await capsules.writeReplayNamespaceProof({ firestore, pair, namespaces: [manifest] });
  }
  const root = {
    schemaVersion: 2,
    pairDigest: protocol.publicReleaseDigest(pair),
    reference,
    cursor,
    inventoryDigest: protocol.publicReleaseDigest(verified),
    renderTargetProofDigest,
    catalogImages: catalogDescriptor,
    composite: compositeDescriptor,
    count: verified.length,
    pages,
  };
  await immutable(firestore, `${base}/replayOutputInventories/${reference.manifestDigest}`, root);
  return root;
}
/** The source-owned parser and full G byte readback precede this receipt. */
export async function stageReplayCodePackInventory({
  firestore,
  pair,
  codePackView,
  manifest,
  sourceInputs,
  sourceInputsDigest,
}: {
  firestore: Firestore;
  pair: PublicReleasePair;
  codePackView: ReplayViewReference;
  manifest: PairCodePack;
  sourceInputs: {
    schemaVersion: 1;
    logBaselineDigest: string;
    sourceMemberCensusDigest: string;
    baselineCursor: ReplayCursor;
  };
  sourceInputsDigest: string;
}) {
  const base = work.publicReleasePairPath(pair.pairId),
    pages: string[] = [];
  for (let start = 0; start < manifest.members.length; start += 256) {
    const page = {
      schemaVersion: 2,
      pairDigest: protocol.publicReleaseDigest(pair),
      index: pages.length,
      members: manifest.members.slice(start, start + 256),
    };
    const digest = protocol.publicReleaseDigest(page);
    await immutable(firestore, `${base}/replayCodePackPages/${digest}`, page);
    pages.push(digest);
  }
  await immutable(firestore, `${base}/replayCodePacks/${pair.codeAssetManifestDigest}`, {
    schemaVersion: 2,
    pairDigest: protocol.publicReleaseDigest(pair),
    codeAssetManifestDigest: pair.codeAssetManifestDigest,
    codePackView,
    sourceInputs,
    sourceInputsDigest,
    count: manifest.members.length,
    pages,
  });
}
