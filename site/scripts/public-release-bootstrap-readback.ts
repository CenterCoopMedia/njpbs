import type { Firestore } from "firebase-admin/firestore";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { exact } from "./public-release-pair-reader-contract";

/** Original-outcome query only. It never claims the old selector is still
 * current, and needs neither R2 credentials nor fresh qualification. */
export async function readInitialBootstrapReceipt({ firestore, attempt: raw }: {
  firestore: Firestore; attempt: ReturnType<typeof bootstrap.parseBootstrapAttempt>;
}) {
  const attempt = bootstrap.parseBootstrapAttempt(raw); work.assertPublicReleasePairDatabase(firestore, attempt.currentPair);
  const row = await firestore.doc(`system/publicDeployment/bootstrapSelectors/${attempt.operationId}`).get();
  if (!row.exists) return null;
  const receipt = exact(row.data(), ["schemaVersion", "kind", "operationId", "attemptDigest", "sourceDigest", "selectorDigest", "storedSelectorDigest", "mediaDigest", "selector"]);
  const selector = protocol.parsePublicReleaseSelector(receipt.selector), hash = protocol.publicReleaseDigest;
  if (receipt.schemaVersion !== 2 || receipt.kind !== "public-release-bootstrap" || receipt.operationId !== attempt.operationId ||
      receipt.attemptDigest !== hash(attempt) || receipt.sourceDigest !== attempt.expectedSourceDigest || receipt.selectorDigest !== hash(selector) ||
      selector.epoch !== 1 || selector.switchOperationId !== attempt.operationId || selector.priorSelectorDigest !== attempt.expectedSourceDigest ||
      selector.admittedContractDigest !== attempt.admittedContractDigest ||
      hash(selector.selectedPair) !== hash(protocol.publicReleasePairReference(attempt.currentPair)) ||
      hash(selector.recoveryPair) !== hash(protocol.publicReleasePairReference(attempt.recoveryPair)) ||
      [receipt.storedSelectorDigest, receipt.mediaDigest].some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)))
    throw new Error("Initial bootstrap receipt was refused");
  return receipt;
}
