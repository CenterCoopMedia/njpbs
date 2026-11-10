import type { Firestore, Transaction } from "firebase-admin/firestore";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { exact } from "./public-release-pair-reader-contract";
import { BOOTSTRAP_CONTROL_PATHS, BOOTSTRAP_CONTROL_RECEIPTS, parseBootstrapControlsAttempt } from "./public-release-bootstrap-controls";
import { prepareInstalledPublicReleaseConsumers, assertInstalledPublicReleaseConsumersInTransaction,
  assertInstalledPublicReleaseConsumersFresh } from "./public-release-installed-consumer-owner";

const hash = protocol.publicReleaseDigest;
function refuse(): never { throw new Error("Initial selector installed-consumer guard was refused"); }
type Evidence = Pick<Parameters<typeof prepareInstalledPublicReleaseConsumers>[0], "provider" | "readSource" | "clock" | "cwd">;

/** Bind the existing initial-selector owner to the actual installed-consumer
 * preparer and original OLD-control receipt. No serialized readiness callback. */
export async function prepareInitialBootstrapInstalledGuard({ firestore, attempt: raw, evidence = {} }: {
  firestore: Firestore; attempt: ReturnType<typeof bootstrap.parseBootstrapAttempt>; evidence?: Evidence;
}) {
  const attempt = bootstrap.parseBootstrapAttempt(raw), environment = attempt.currentPair.environment;
  const receiptPath = `${BOOTSTRAP_CONTROL_RECEIPTS}/${attempt.operationId}`;
  const stored = (await firestore.doc(receiptPath).get()).data();
  const receipt = exact(stored, ["schemaVersion", "kind", "attempt", "attemptDigest", "enrollmentReceiptDigest", "installed", "before", "after"]);
  const controls = parseBootstrapControlsAttempt(receipt.attempt);
  if (receipt.schemaVersion !== 2 || receipt.kind !== "public-release-bootstrap-controls" ||
      receipt.attemptDigest !== hash(controls) || receipt.enrollmentReceiptDigest !== controls.enrollmentReceiptDigest ||
      controls.operationId !== attempt.operationId || hash(controls.pair) !== hash(attempt.currentPair) ||
      controls.admittedContractDigest !== attempt.admittedContractDigest) refuse();
  const installed = await prepareInstalledPublicReleaseConsumers({ ...evidence, firestore, environment,
    sourceSha: controls.consumerSourceSha, contractDigest: attempt.admittedContractDigest });
  const original = exact(receipt.installed, ["environment", "sourceSha", "contractDigest", "sourceDigest", "providerDigest",
    "deploymentReceiptDigest", "readerReceiptDigest"]);
  if (typeof original.providerDigest !== "string" || !/^[a-f0-9]{64}$/.test(original.providerDigest) ||
      ["environment", "sourceSha", "contractDigest", "sourceDigest", "deploymentReceiptDigest", "readerReceiptDigest"]
        .some(key => original[key] !== installed[key as keyof typeof installed])) refuse();
  return {
    assertFresh() { assertInstalledPublicReleaseConsumersFresh(installed); },
    async assertClosedFenceInTransaction(input: { firestore: Firestore; transaction: Transaction;
      environment: string; before: unknown; operationId: string }) {
      if (input.firestore !== firestore || input.environment !== environment || input.operationId !== attempt.operationId) refuse();
      return adoption.assertClosedBootstrapFenceInTransaction({ ...input, environment });
    },
    async assertInstalledConsumersInTransaction(input: { firestore: Firestore; transaction: Transaction;
      environment: string; contractDigest: string; before: unknown }) {
      if (input.firestore !== firestore || input.environment !== environment || input.contractDigest !== attempt.admittedContractDigest) refuse();
      const rows = await input.transaction.getAll(firestore.doc(receiptPath), ...BOOTSTRAP_CONTROL_PATHS.map(path => firestore.doc(path)),
        firestore.doc("system/publicReleaseChanges/enrollment/initial"));
      if (hash(rows[0].data()) !== hash(stored) || hash(rows.slice(1, -1).map(row => row.data() ?? null)) !== hash(receipt.after) ||
          hash(rows.at(-1)!.data()) !== receipt.enrollmentReceiptDigest) refuse();
      return assertInstalledPublicReleaseConsumersInTransaction({ ...input, environment, proof: installed });
    },
  };
}
