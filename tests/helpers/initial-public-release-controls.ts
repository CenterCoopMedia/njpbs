import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { installedConsumerFixture } from "./public-release-installed-consumers";
import { sealedPair } from "./sealed-public-release-pair";
import { releasePair } from "./private-public-release-pair.js";
import { publicReleaseBaselineCodeFixture } from "./public-release-baseline-code";
import p from "../../functions/lib/public-release-pair.js";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { prepareInstalledPublicReleaseConsumers } from "../../site/scripts/public-release-installed-consumer-owner";
import { prepareInitialBootstrapInstalledGuard } from "../../site/scripts/public-release-bootstrap-installed-guard";
import { inspectBootstrapControls, installBootstrapOldControls } from "../../site/scripts/public-release-bootstrap-controls";

/** Real enrollment, controls, fences and SDK initial-CAS boundary. Qualification
 * is explicitly a seam here; full H/G qualification belongs to its own suite. */
export async function initialPublicReleaseControlsFixture(firestore: Firestore) {
  const f = installedConsumerFixture(), { pair, seals } = sealedPair(), recoveryPair = releasePair("c", "c".repeat(40));
  const operationId = "bootstrap-store-boundary";
  f.data.get("system/publicDeployment").updatedAt = Timestamp.fromMillis(1_800_000_000_000);
  const batch = firestore.batch();
  for (const [path, value] of f.data) batch.set(firestore.doc(path), value);
  batch.set(firestore.doc("system/cmsPublicationRuntime"), { schemaVersion: 1, phase: "ready", commitSha: pair.commitSha,
    serializerId: "node-compute", cloud: { phase: "ready", commitSha: pair.commitSha, serializerId: "cloudflare-dev-publisher" } });
  batch.set(firestore.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 1 });
  for (const current of [pair, recoveryPair]) {
    const base = work.publicReleasePairPath(current.pairId);
    batch.set(firestore.doc(base), current); batch.set(firestore.doc(`${base}/controls/runtime`), { schemaVersion: 2, pairId: current.pairId, status: "retained" });
    batch.set(firestore.doc(`${base}/rollouts/publisher`), { schemaVersion: 2, pairId: current.pairId, pairDigest: p.publicReleaseDigest(current), state: "verified", readbackDigest: "d".repeat(64) });
  }
  batch.set(firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/seals/privateReader`), seals); await batch.commit();
  await adoption.closePublicReleaseBootstrapAdmission({ firestore, attempt: { schemaVersion: 2, operationId, environment: "development", legacyPointerDigest: adoption.legacyBootstrapPointerDigest(f.root) } });
  await firestore.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  const code = publicReleaseBaselineCodeFixture(firestore, pair.commitSha), observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore });
  const enrolled = await enrollment.enrollPublicReleaseChangeLog({ firestore, dryRun: false, currentCodeRequest: code.request, request: {
    schemaVersion: 1, operationId, logEpoch: "initial-epoch", baselineDigest: "f".repeat(64), expected: observed.expected } });
  const expected = await inspectBootstrapControls({ firestore, pair });
  await installBootstrapOldControls({ firestore, dryRun: false, installed: await prepareInstalledPublicReleaseConsumers({ ...f.options, firestore }), attempt: {
    schemaVersion: 2, operationId, pair, ...expected, enrollmentReceiptDigest: enrolled.receiptDigest, admittedContractDigest: f.contractDigest,
    consumerSourceSha: f.options.sourceSha, familyAdmission: { schemaVersion: 2, revision: 1, enabled: true, families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" } } });
  const head = (await firestore.doc("system/publicReleaseChanges").get()).data()!;
  const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
  const proofs = [pair, recoveryPair].map((current, index) => {
    const witness = { pairDigest: p.publicReleaseDigest(current), codeAssetManifestDigest: current.codeAssetManifestDigest, contentViewDigest: String(index + 2).repeat(64), headCursor: cursor };
    return { witness, receipt: { schemaVersion: 2, kind: "private-pair-qualification", qualificationId: `qualified-${index}`,
      pairDigest: p.publicReleaseDigest(current), readerReceiptDigest: current.readerReceiptDigest, codeAssetManifestDigest: current.codeAssetManifestDigest,
      witnessDigest: p.publicReleaseDigest(witness), contentViewDigest: witness.contentViewDigest } };
  });
  const attempt = { schemaVersion: 2 as const, operationId, expectedSourceDigest: p.publicReleaseDigest(f.root), currentPair: pair, recoveryPair,
    admittedContractDigest: f.contractDigest, qualifications: proofs.map(proof => ({ qualificationId: proof.receipt.qualificationId, receiptDigest: p.publicReleaseDigest(proof.receipt) })) };
  return { ...f, pair, recoveryPair, attempt, convert: async () => bootstrap.bootstrapPublicReleaseSelector({ firestore, attempt, dryRun: false,
    ...await prepareInitialBootstrapInstalledGuard({ firestore, attempt, evidence: f.options }),
    qualificationGuard: { begin: transaction => ({ transaction, verify: async () => proofs, finish() {} }) } }) };
}
