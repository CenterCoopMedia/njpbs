/** Private operator: run inside the reviewed pair container with its fixed
 * pair-storage.internal binding and workload credentials. Default: dry run. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { applicationDefault, deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore, type Transaction } from "firebase-admin/firestore";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import protocol from "../../functions/lib/public-release-pair.js";
import changeLog from "../../functions/lib/public-release-change-log.js";
import targets from "../../functions/lib/publication-target.js";
import { publicReleasePairRpcStore } from "./public-release-pair-storage-rpc";
const refuse = (): never => { throw new Error("Private selector bootstrap was refused"); };
/** Import real owners at use time. Missing source refuses before any write;
 * serialized inputs cannot substitute for opaque qualification preparation. */
export async function prepareBootstrapQualificationGuard({ firestore, attempt, store = publicReleasePairRpcStore(), signal = AbortSignal.timeout(30_000) }: {
  firestore: Firestore; attempt: ReturnType<typeof bootstrap.parseBootstrapAttempt>;
  store?: ReturnType<typeof publicReleasePairRpcStore>; signal?: AbortSignal;
}) {
  const [qualification, receipts, replay] = (() => {
    try {
      const require = createRequire(import.meta.url);
      return [require("./public-release-pair-qualification.ts"), require("./public-release-pair-qualification-receipt.ts"),
        require("../../functions/lib/public-release-pair-replay.js")];
    } catch { return refuse(); }
  })();
  const pairs = [attempt.currentPair, attempt.recoveryPair];
  const prepared: Array<{ selectedViews: unknown; namespaces: unknown; catalogs: unknown; composites: unknown; source: unknown }> = [];
  for (const [index, pair] of pairs.entries()) {
    signal.throwIfAborted();
    const reference = attempt.qualifications[index];
    const receipt = receipts.parseQualificationReceipt((await firestore.doc(receipts.qualificationReceiptPath(pair, reference.qualificationId)).get()).data(), pair);
    if (protocol.publicReleaseDigest(receipt) !== reference.receiptDigest) refuse();
    const changes = changeLog.parsePublicReleaseChangeHead((await firestore.doc("system/publicReleaseChanges").get()).data());
    const headCursor = { baselineDigest: changes.baselineDigest, sequence: changes.sequence, lastDigest: changes.lastDigest };
    const proof = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair, headCursor, witnessDigest: receipt.witnessDigest });
    prepared.push(await qualification.verifyStoredQualificationEvidence({ firestore, store, pair, witness: proof.witness,
      namespaces: proof.namespaces, receipt, signal }));
  }
  signal.throwIfAborted();
  return { begin(original: Transaction) {
    const tracker = qualification.trackQualificationTransactionReads(original), transaction = tracker.transaction;
    return { transaction,
      async verify() {
        signal.throwIfAborted(); const proofs = [];
        for (const [index, pair] of pairs.entries()) {
          const { selectedViews, namespaces, catalogs, composites, source } = prepared[index];
          proofs.push(await qualification.assertPublicReleasePairQualificationCurrentInTransaction({ firestore, transaction, pair,
            ...attempt.qualifications[index], selectedViews, namespaces, catalogs, composites, source, readTracker: tracker }));
        }
        return proofs;
      },
      finish() { signal.throwIfAborted(); qualification.assertQualificationTransactionReadBudget(tracker); },
    };
  } };
}
/** Required installed-owner contract, checked before ADC. In particular the
 * owner must prove Schedule/Live/export readers along with all other consumers;
 * the closed writer fence alone cannot authorize this first conversion. */
export function requireBootstrapAdoptionOwner(value: unknown) {
  const owner = value as { assertInstalledPublicReleaseConsumersInTransaction?: unknown; assertClosedBootstrapFenceInTransaction?: unknown } | null;
  if (owner === null || owner === undefined) return refuse();
  if (typeof owner.assertInstalledPublicReleaseConsumersInTransaction !== "function" ||
      typeof owner.assertClosedBootstrapFenceInTransaction !== "function") refuse();
  type Input = Parameters<typeof bootstrap.bootstrapPublicReleaseSelector>[0];
  return { assertInstalledConsumersInTransaction: owner.assertInstalledPublicReleaseConsumersInTransaction as Input["assertInstalledConsumersInTransaction"],
    assertClosedFenceInTransaction: owner.assertClosedBootstrapFenceInTransaction as Input["assertClosedFenceInTransaction"] };
}
export async function runBootstrapOperator(args: string[]) {
  const apply = args.length === 3 && args[2] === "--apply";
  if (args[0] !== "--attempt" || !args[1] || !(args.length === 2 || apply)) refuse();
  const bytes = await readFile(args[1]); if (bytes.length > 64 * 1024) refuse();
  const attempt = bootstrap.parseBootstrapAttempt(JSON.parse(bytes.toString("utf8")));
  const target = targets.publicationTarget(attempt.currentPair.environment);
  const adoption = requireBootstrapAdoptionOwner(await import(new URL("../../functions/lib/public-release-bootstrap-adoption.js", import.meta.url).href)
    .then(module => module.default ?? module).catch(refuse));
  const app = initializeApp({ projectId: target.projectId, credential: applicationDefault() });
  try {
    const firestore = getFirestore(app), qualificationGuard = await prepareBootstrapQualificationGuard({ firestore, attempt });
    const result = await bootstrap.bootstrapPublicReleaseSelector({ firestore, attempt, dryRun: !apply, qualificationGuard,
      ...adoption });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBootstrapOperator(process.argv.slice(2)).catch(() => { process.stderr.write("Private selector bootstrap was refused\n"); process.exitCode = 1; });
}
