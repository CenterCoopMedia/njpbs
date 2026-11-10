import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairRolloutReadback } from "../../functions/lib/public-release-pair-rollout";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { parseReaderSeals, exact, same, readerRefused } from "./public-release-pair-reader-contract";
import { readerSealPath } from "./public-release-pair-private-reader";

/** Install only after actual slot RPC, container reader-code and provider image
 * readbacks agree with the already verified rollout. No provider mutation,
 * selection, execution, qualification or publication is performed here. */
export async function installPublicReleasePairReader({ firestore, pair: input, rollout, readInstalled }: {
  firestore: Firestore; pair: PublicReleasePair; rollout: PairRolloutReadback;
  readInstalled(): Promise<unknown>;
}) {
  const pair = protocol.parsePublicReleasePair(input);
  work.assertPublicReleasePairDatabase(firestore, pair);
  const actual = exact(await readInstalled(), ["seals", "publisher"]);
  const seals = parseReaderSeals(actual.seals, pair);
  const publisher = exact(actual.publisher, ["pairDigest", "publisher", "readerContractDigest", "capabilities"]);
  if (publisher.pairDigest !== protocol.publicReleaseDigest(pair) || !same(publisher.publisher, pair.publisher) ||
      publisher.readerContractDigest !== pair.readerContractDigest || !same(publisher.capabilities, seals.capabilities) ||
      rollout.publisherApplication !== pair.publisher.application || rollout.publisherWorkerVersionId !== pair.publisher.workerVersionId ||
      rollout.imageDigest !== pair.publisher.imageDigest || rollout.publicService !== pair.publicWorker.service ||
      rollout.publicWorkerVersionId !== pair.publicWorker.versionId || rollout.publisherTrafficPercent !== 100 ||
      rollout.publicTrafficPercent !== 100) readerRefused();
  const base = work.publicReleasePairPath(pair.pairId), sealDigest = protocol.publicReleaseDigest(seals);
  const identity = { schemaVersion: 1, kind: "private-pair-reader-install", pairDigest: protocol.publicReleaseDigest(pair),
    sealDigest, rolloutDigest: protocol.publicReleaseDigest(rollout), publisherRpcDigest: protocol.publicReleaseDigest(publisher) };
  const installDigest = protocol.publicReleaseDigest(identity), receiptRef = firestore.doc(`${base}/readerInstalls/${installDigest}`);
  return firestore.runTransaction(async transaction => {
    const [pairRow, controlRow, billingRow, rolloutRow, sealRow, receiptRow] = await transaction.getAll(firestore.doc(base),
      firestore.doc(`${base}/controls/runtime`), firestore.doc("system/billing"), firestore.doc(`${base}/rollouts/publisher`),
      firestore.doc(readerSealPath(pair)), receiptRef);
    const control = exact(controlRow.data(), ["schemaVersion", "pairId", "status"]);
    const verified = exact(rolloutRow.data(), ["schemaVersion", "pairId", "pairDigest", "state", "readbackDigest"]);
    if (!same(protocol.parsePublicReleasePair(pairRow.data()), pair) || billingRow.data()?.disabled === true ||
        control.schemaVersion !== 2 || control.pairId !== pair.pairId || !["candidate", "retained"].includes(control.status as string) ||
        verified.schemaVersion !== 2 || verified.pairId !== pair.pairId || verified.pairDigest !== identity.pairDigest ||
        verified.state !== "verified" || verified.readbackDigest !== identity.rolloutDigest) readerRefused();
    if (sealRow.exists && !same(parseReaderSeals(sealRow.data(), pair), seals)) readerRefused();
    if (receiptRow.exists) {
      const receipt = exact(receiptRow.data(), [...Object.keys(identity), "installDigest", "completedAt"]);
      if (Object.entries(identity).some(([key, value]) => receipt[key] !== value) || receipt.installDigest !== installDigest ||
          !Number.isSafeInteger(receipt.completedAt) || (receipt.completedAt as number) < 1 || !sealRow.exists) readerRefused();
      return { installDigest, receipt, idempotent: true };
    }
    if (control.status !== "candidate" || sealRow.exists) readerRefused();
    const receipt = { ...identity, installDigest, completedAt: Date.now() };
    transaction.create(firestore.doc(readerSealPath(pair)), seals);
    transaction.create(receiptRef, receipt);
    return { installDigest, receipt, idempotent: false };
  });
}
