import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeApp, deleteApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { installedConsumerFixture } from "../helpers/public-release-installed-consumers";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import p from "../../functions/lib/public-release-pair.js";
import bootstrap from "../../functions/lib/public-release-bootstrap.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { prepareInstalledPublicReleaseConsumers } from "../../site/scripts/public-release-installed-consumer-owner";
import { inspectBootstrapControls, installBootstrapOldControls, BOOTSTRAP_CONTROL_RECEIPTS } from "../../site/scripts/public-release-bootstrap-controls";
import { prepareInitialBootstrapInstalledGuard } from "../../site/scripts/public-release-bootstrap-installed-guard";
import { parseInitialBootstrapOperatorArgs } from "../../site/scripts/bootstrap-public-release-initial";

let app: ReturnType<typeof initializeApp>, db: Firestore, f: ReturnType<typeof installedConsumerFixture>, attempt: any, proofs: any[], controls: any;
const { pair, seals } = sealedPair(), recovery = releasePair("c", "c".repeat(40)), operationId = "initial-bound-guard";
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the loopback demo emulator");
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "bootstrap-installed-guard"); db = getFirestore(app);
});
afterAll(async () => { if (app) await deleteApp(app); vi.unstubAllEnvs(); });
beforeEach(async () => {
  for (const collection of ["system", "cmsDeploymentReceipts", "cmsReaderCompatibilityReceipts", "admin_logs"]) await db.recursiveDelete(db.collection(collection));
  f = installedConsumerFixture(); f.data.get("system/publicDeployment").updatedAt = Timestamp.fromMillis(1_800_000_000_000);
  const batch = db.batch();
  for (const [path, value] of f.data) batch.set(db.doc(path), value);
  batch.set(db.doc("system/cmsPublicationRuntime"), { schemaVersion: 1, phase: "ready", commitSha: pair.commitSha,
    serializerId: "node-compute", cloud: { phase: "ready", commitSha: pair.commitSha, serializerId: "cloudflare-dev-publisher" } });
  batch.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 1 });
  for (const current of [pair, recovery]) {
    const base = work.publicReleasePairPath(current.pairId);
    batch.set(db.doc(base), current); batch.set(db.doc(`${base}/controls/runtime`), { schemaVersion: 2, pairId: current.pairId, status: "retained" });
    batch.set(db.doc(`${base}/rollouts/publisher`), { schemaVersion: 2, pairId: current.pairId, pairDigest: p.publicReleaseDigest(current), state: "verified", readbackDigest: "d".repeat(64) });
  }
  batch.set(db.doc(`${work.publicReleasePairPath(pair.pairId)}/seals/privateReader`), seals); await batch.commit();
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: { schemaVersion: 2, operationId, environment: "development", legacyPointerDigest: adoption.legacyBootstrapPointerDigest(f.root) } });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  const code = publicReleaseBaselineCodeFixture(db, pair.commitSha), observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db });
  const enrolled = await enrollment.enrollPublicReleaseChangeLog({ firestore: db, dryRun: false, currentCodeRequest: code.request, request: {
    schemaVersion: 1, operationId, logEpoch: "initial-epoch", baselineDigest: "f".repeat(64), expected: observed.expected } });
  const expected = await inspectBootstrapControls({ firestore: db, pair });
  controls = await installBootstrapOldControls({ firestore: db, dryRun: false, installed: await prepareInstalledPublicReleaseConsumers({ ...f.options, firestore: db }), attempt: {
    schemaVersion: 2, operationId, pair, ...expected, enrollmentReceiptDigest: enrolled.receiptDigest, admittedContractDigest: f.contractDigest,
    consumerSourceSha: f.options.sourceSha, familyAdmission: { schemaVersion: 2, revision: 1, enabled: true, families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" } } });
  const head = (await db.doc("system/publicReleaseChanges").get()).data()!;
  const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
  // Qualification itself remains the original owner's seam. This suite proves
  // the real installed/control/fence SDK binding, not full pair qualification.
  proofs = [pair, recovery].map((current, index) => {
    const witness = { pairDigest: p.publicReleaseDigest(current), codeAssetManifestDigest: current.codeAssetManifestDigest, contentViewDigest: String(index + 2).repeat(64), headCursor: cursor };
    return { witness, receipt: { schemaVersion: 2, kind: "private-pair-qualification", qualificationId: `qualified-${index}`,
      pairDigest: p.publicReleaseDigest(current), readerReceiptDigest: current.readerReceiptDigest, codeAssetManifestDigest: current.codeAssetManifestDigest,
      witnessDigest: p.publicReleaseDigest(witness), contentViewDigest: witness.contentViewDigest } };
  });
  attempt = { schemaVersion: 2, operationId, expectedSourceDigest: p.publicReleaseDigest(f.root), currentPair: pair, recoveryPair: recovery,
    admittedContractDigest: f.contractDigest, qualifications: proofs.map(proof => ({ qualificationId: proof.receipt.qualificationId, receiptDigest: p.publicReleaseDigest(proof.receipt) })) };
});
const prepare = () => prepareInitialBootstrapInstalledGuard({ firestore: db, attempt, evidence: f.options });
const run = (installed: Awaited<ReturnType<typeof prepare>>) => bootstrap.bootstrapPublicReleaseSelector({ firestore: db, attempt, dryRun: false, ...installed,
  qualificationGuard: { begin: transaction => ({ transaction, verify: async () => proofs, finish() {} }) } });
it("binds actual enrollment, ready controls, installed source and the original selector CAS while keeping admission closed", async () => {
  const installed = await prepare(), result = await run(installed);
  expect(result.idempotent).toBe(false); expect(result.after.selectedPair.pairId).toBe(pair.pairId); expect(result.after.epoch).toBe(1);
  expect((await db.doc("system/publicReleaseAdmissions/controls/bootstrapFence").get()).data()!.status).toBe("closed");
  expect((await db.doc("system/publicReleaseChangeLog").get()).data()!.enabled).toBe(false);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(controls.after[0]);
  expect((await run(installed)).receipt).toEqual(result.receipt);
});
it.each(["receipt", "pins", "enrollment", "deployment", "root", "producer", "families"])("refuses late %s drift with zero selector writes", async fault => {
  const installed = await prepare();
  const path = fault === "producer" ? "system/publicReleaseChangeLog" : fault === "families" ? "system/noBuildPostAdmission" :
    fault === "receipt" ? `${BOOTSTRAP_CONTROL_RECEIPTS}/${operationId}` : fault === "pins" ? "system/cmsPublicationRuntime" :
    fault === "enrollment" ? "system/publicReleaseChanges/enrollment/initial" : fault === "deployment" ? "cmsDeploymentReceipts/functions" : "system/publicDeployment";
  if (fault === "producer") await db.doc(path).update({ enabled: true });
  else if (fault === "families") await db.doc(path).update({ revision: 2 });
  else if (fault === "pins") await db.doc(path).update({ phase: "paused" });
  else if (fault === "root") await db.doc(path).update({ activeDeploymentId: "changed" });
  else await db.doc(path).delete();
  await expect(run(installed)).rejects.toThrow();
  expect((await db.doc("system/publicDeployment").get()).data()!.schemaVersion).toBe(1);
  expect((await db.collection("system/publicDeployment/bootstrapSelectors").get()).empty).toBe(true);
});
it("validates the named dry-run operator before initializing credentials", () => {
  const count = getApps().length;
  expect(parseInitialBootstrapOperatorArgs(["--attempt", "attempt.json"])).toEqual({ attemptFile: "attempt.json", dryRun: true });
  expect(parseInitialBootstrapOperatorArgs(["--attempt", "attempt.json", "--apply"])).toEqual({ attemptFile: "attempt.json", dryRun: false });
  expect(() => parseInitialBootstrapOperatorArgs(["--attempt", "attempt.json", "--force"])).toThrow(); expect(getApps().length).toBe(count);
});
it("loads the actual qualification owners through Node22+tsx and reaches a real SDK receipt read", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bootstrap-node-loader-")), file = path.join(directory, "attempt.json");
  try {
    await writeFile(file, JSON.stringify(attempt));
    const child = spawn(process.execPath, ["--import", path.resolve("site/node_modules/tsx/dist/loader.mjs"), "--eval", `
      const { initializeApp, deleteApp } = require('firebase-admin/app');
      const { getFirestore } = require('firebase-admin/firestore');
      const { prepareBootstrapQualificationGuard } = require('./site/scripts/bootstrap-public-release-selector.ts');
      const attempt = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
      const app = initializeApp({ projectId: 'njpbs-site-dev' }); const db = getFirestore(app); let reads = 0;
      const firestore = new Proxy(db, { get(target, key) {
        if (key === 'doc') return path => { const ref = target.doc(path); return { get: async () => { reads++; return ref.get(); } }; };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      prepareBootstrapQualificationGuard({ firestore, attempt, store: { get() { throw new Error('No byte read after missing receipt'); } } })
        .then(() => { throw new Error('A missing real qualification receipt must refuse'); }, () => {
          process.stdout.write(JSON.stringify({ reads, refused: true }));
        }).finally(() => deleteApp(app));
    `, file], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    expect({ code, error }).toEqual({ code: 0, error: "" }); expect(JSON.parse(output)).toEqual({ reads: 1, refused: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
