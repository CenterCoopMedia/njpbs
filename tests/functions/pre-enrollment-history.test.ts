import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { refusedOperatorPrelaunch } from "../helpers/operator-prelaunch.mjs";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import p from "../../functions/lib/public-release-pair.js";
import pause from "../../functions/lib/dev-public-release-pause.js";
import recovery from "../../functions/lib/dev-public-release-pause-recovery.js";
import context from "../../functions/lib/public-context-publication.js";
import home from "../../functions/lib/no-build-home-ownership.js";
import targets from "../../functions/lib/publication-target.js";
import owner from "../../functions/lib/pre-enrollment-history.js";
import { publicContextDigest } from "../../functions/lib/public-context-revision.js";
import { runPreEnrollmentHistoryOperator } from "../../scripts/lib/pre-enrollment-history-operator.mjs";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "history-retirement-sdk"), db = getFirestore(app);
afterAll(() => deleteApp(app));
const sha = "a".repeat(40), runtime = { owner: "cloudflare", release: sha }, historicalId = "Z".repeat(20);
const path = `cmsPublishQueue/${historicalId}`, operationId = "C".repeat(20);
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: sha,
  activeDeploymentId: "original-old", lastReservedGeneration: 1, newestEligibleGeneration: 1,
  newestEligibleBuildBatchId: "original-build", mediaLifecycleReady: true };
const pins = { schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "original-primary",
  cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } };
const pauseAttempt = { schemaVersion: 1, operationId: "original-development-pause", environment: "development", projectId: "njpbs-site-dev",
  oldRuntime: pins, legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) };
const request = { schemaVersion: 1, operationId: "reviewed-history-retirement", target: targets.publicationTarget("development") };
const list = () => owner.listPreEnrollmentHistory({ firestore: db, request });
const apply = (operatorReceipt: any) => owner.retirePreEnrollmentHistory({ firestore: db, request, operatorReceipt });
const pauseApply = () => pause.pauseDevPublicRelease({ firestore: db, attempt: pauseAttempt });
const identity = { projectId: "njpbs-site-dev", clientEmail: "fixture-operator@njpbs-site-dev.iam.gserviceaccount.com",
  privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev/bootstrap-operator" };
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set(pointer);
  await db.doc("system/cmsPublicationRuntime").set(pins);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 2 });
});
async function historical(kind: string) {
  await db.doc(path).set({ schemaVersion: 1, status: "success", transport: "post-no-build-v1", backgroundRuntime: runtime,
    noBuildPost: { operationId: historicalId, postId: "historical-post", sourceVersion: 1, rendererSha: sha } });
  const taskPath = kind === "admission" ? `${path}/backgroundOutputs/_admission` : `${path}/backgroundPreparation/${publicContextDigest(1)}`;
  // These are the shapes written by post-background-outputs.prepareInTransaction
  // and site/scripts/no-build-post-background.ts's prepareJob reservation.
  await db.doc(taskPath).set(kind === "admission" ? {
    schemaVersion: 1, runtime, owner: "post-background-v1", postId: "historical-post", stage: "preparation",
    status: "failed", error: "background_preparation_failed", nextAttemptAt: null,
  } : {
    schemaVersion: 1, runtime, contextDigest: publicContextDigest(1), attempts: 1, admissionRevision: null,
    backgroundBucket: "njpbs-dev-public-artifacts", status: kind === "claim" ? "building" : "failed",
    claim: kind === "claim" ? "11111111-1111-4111-8111-111111111111" : null, nextAttemptAt: 1,
    reservation: { schemaVersion: 1, buildBatchId: `post-background-${historicalId}-${publicContextDigest(1)}`, generation: 2,
      commitSha: sha, status: "reserved", reservedAgainstGeneration: 1, reservedAgainstDeploymentId: "original-old",
      reservedAgainstCommitSha: sha, cutoffAt: Timestamp.fromMillis(1), reservedAt: Timestamp.fromMillis(1) },
  });
  return taskPath;
}
async function failedPause() {
  await db.runTransaction(async transaction => {
    (await context.enqueuePublicContextInTransaction({ firestore: db, transaction, operationId, runtime, reason: "settings", contextRevision: 2 })).write();
  });
  await expect(pauseApply()).rejects.toThrow();
  for (const output of context.OUTPUTS) {
    await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/${output}`).update({ status: "verified", claim: null, nextAttemptAt: null });
    await db.doc(`cmsBackgroundOutputs/${output}`).update({ status: "verified" });
  }
  await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).update({ status: "failed", attempts: 4 });
  await db.doc("cmsBackgroundOutputs/search").update({ status: "failed" });
  await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "failed", claim: null, nextAttemptAt: null });
  expect(await pauseApply()).toMatchObject({ stop: true, drainCommitted: false });
  const original = await pause.readDevPublicReleasePause({ firestore: db, attempt: pauseAttempt });
  return { schemaVersion: 1, pauseAttempt, pauseReceiptDigest: p.publicReleaseDigest(original.pauseReceipt), failureReceiptDigest: original.failureReceiptDigest };
}
async function paused() { await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" }); }
async function historicalHome() {
  const homeId = "H".repeat(20), newerId = "N".repeat(20);
  const operation = { schemaVersion: 1, operationId: homeId, pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"],
    rendererSha: sha, generation: 1, sourceVersion: 1, visible: true };
  const document = { status: "published", publiclyVisible: true, published: { sourceVersion: 1, metadata: {}, blocks: [] } };
  await db.runTransaction(async transaction => {
    const plan = await home.prepareHomePlanInTransaction({ firestore: db, transaction, nextDocument: document, operation, runtime });
    transaction.set(db.doc("system/publicDeployment/noBuildPageOwners/home"), { ...operation, runtime });
    transaction.set(db.doc(`cmsPublishQueue/${homeId}`), { status: "success", transport: "page-no-build-v1", backgroundRuntime: runtime, noBuildPage: operation });
    transaction.set(db.doc("cmsPages/home"), document); plan!.write();
  });
  for (const id of [historicalId, newerId]) {
    await db.doc(`cmsPublishQueue/${id}`).set({ status: "success", transport: "post-no-build-v1", backgroundRuntime: runtime,
      noBuildPost: { operationId: id, postId: "historical-post", sourceVersion: 1, rendererSha: sha } });
    await db.runTransaction(async transaction => (await home.prepareHomePostRefreshInTransaction({ firestore: db, transaction,
      postId: "historical-post", nextDocument: document, queueId: id, affectedSections: [] }))());
  }
  await db.doc(`cmsPublishQueue/${newerId}/homePageRefresh/home`).update({ status: "verified", claim: null, nextAttemptAt: null });
  await db.doc("system/publicDeployment/noBuildPageOwners/home").update({ "homeRefresh.status": "verified" });
  return `${path}/homePageRefresh/home`;
}
it.each(["retry", "claim", "admission", "home", "home-retry"])("keeps %s history at STOP, then permits recovery after exact reviewed retirement", async kind => {
  const taskPath = kind.startsWith("home") ? await historicalHome() : await historical(kind);
  if (kind === "home-retry") await db.doc(taskPath).update({ status: "failed", attempts: 1, claim: null, nextAttemptAt: 1 });
  const attempt = await failedPause();
  await expect(recovery.recoverDevPublicReleasePause({ firestore: db, attempt })).rejects.toThrow();
  const original = await db.doc(`system/devPublicReleasePause/failures/${pauseAttempt.operationId}`).get();
  const parent = await db.doc(path).get();
  const operatorReceipt = await list();
  expect(operatorReceipt.listing).toMatchObject({ records: [{ path: taskPath, digest: p.publicReleaseDigest((await db.doc(taskPath).get()).data()) }], blocked: [] });
  const before = await db.doc(taskPath).get();
  await list(); expect((await db.doc(taskPath).get()).updateTime).toEqual(before.updateTime);
  expect(await apply(operatorReceipt)).toMatchObject({ idempotent: false, receipt: { outcome: "cancelled-not-published", queuesChanged: 0 } });
  expect((await db.doc(taskPath).get()).data()).toMatchObject({ status: "cancelled", claim: null, nextAttemptAt: null });
  expect((await db.doc(path).get()).updateTime).toEqual(parent.updateTime);
  expect((await db.doc(`system/devPublicReleasePause/failures/${pauseAttempt.operationId}`).get()).updateTime).toEqual(original.updateTime);
  expect(await recovery.recoverDevPublicReleasePause({ firestore: db, attempt })).toMatchObject({ recoveryCommitted: true, canContinue: true });
  expect(await apply(operatorReceipt)).toMatchObject({ idempotent: true });
});
it.each(["claim", "retry", "missing-expiry", "selected", "current-context", "pending-parent", "wrong-runtime"])("never retires %s preparation history", async change => {
  const taskPath = await historical("claim"); await paused();
  if (["claim", "retry"].includes(change)) await db.doc(taskPath).update({ claim: change === "retry" ? null : "11111111-1111-4111-8111-111111111111", nextAttemptAt: Date.now() + 60_000 });
  if (change === "missing-expiry") await db.doc(taskPath).update({ nextAttemptAt: null });
  if (change === "selected") await db.doc("system/publicDeployment/aggregateContexts/current").set({ preparationOperationId: historicalId });
  if (change === "current-context") await db.doc("system/publicDeployment/contexts/public").update({ revision: 1 });
  if (change === "pending-parent") await db.doc(path).update({ status: "pending" });
  if (change === "wrong-runtime") await db.doc(taskPath).update({ "runtime.release": "f".repeat(40) });
  const before = await db.doc(taskPath).get(), receipt = await list();
  expect(receipt.listing.records).toEqual([]); expect(receipt.listing.blocked).toHaveLength(1);
  await expect(apply(receipt)).rejects.toThrow(); expect((await db.doc(taskPath).get()).updateTime).toEqual(before.updateTime);
});
it.each(["live", "selected"])("never retires %s historical Home work", async change => {
  const taskPath = await historicalHome(); await paused();
  if (change === "live") await db.doc(taskPath).update({ claim: "11111111-1111-4111-8111-111111111111", nextAttemptAt: Date.now() + 60_000 });
  else await db.doc("system/publicDeployment/noBuildPageOwners/home").update({ "homeRefresh.taskPath": taskPath });
  const receipt = await list(), before = await db.doc(taskPath).get();
  expect(receipt.listing.records).toEqual([]); expect(receipt.listing.blocked).toHaveLength(1);
  await expect(apply(receipt)).rejects.toThrow(); expect((await db.doc(taskPath).get()).updateTime).toEqual(before.updateTime);
});
it.each(["changed-record", "aba-record", "new-history", "new-queue", "changed-owner", "forged-digest", "enrollment", "runtime-ready"])("refuses a %s listing/apply mismatch atomically", async change => {
  const taskPath = await historical("retry"); await paused(); const receipt = await list();
  if (change === "changed-record") await db.doc(taskPath).update({ attempts: 2 });
  if (change === "aba-record") { await db.doc(taskPath).update({ attempts: 2 }); await db.doc(taskPath).update({ attempts: 1 }); }
  if (change === "new-history") await db.doc(`${path}/backgroundOutputs/_admission`).set({ schemaVersion: 1 });
  if (change === "new-queue") await db.doc("cmsPublishQueue/new-queue").set({ status: "success" });
  if (change === "changed-owner") await db.doc("system/publicDeployment/aggregateContexts/current").set({ preparationOperationId: historicalId });
  if (change === "forged-digest") receipt.listingDigest = "f".repeat(64);
  if (change === "enrollment") await db.doc("system/publicReleaseChanges/enrollment/initial").set({ schemaVersion: 1 });
  if (change === "runtime-ready") await db.doc("system/cmsPublicationRuntime").set(pins);
  const before = await db.doc(taskPath).get(); await expect(apply(receipt)).rejects.toThrow();
  expect((await db.doc(taskPath).get()).updateTime).toEqual(before.updateTime);
  expect((await db.doc(`system/preEnrollmentHistory/retirements/${request.operationId}`).get()).exists).toBe(false);
});
it("leaves pending preparation siblings and outputs untouched", async () => {
  const taskPath = await historical("retry"), attempt = await failedPause();
  const sibling = db.doc(`${path}/backgroundOutputs/search`), output = db.doc("cmsBackgroundOutputs/search");
  await sibling.set({ schemaVersion: 1, owner: "post-background-v1", runtime, status: "pending", claim: null, nextAttemptAt: 1 });
  const before = await sibling.get(), state = await output.get(); await apply(await list());
  expect((await db.doc(taskPath).get()).data()?.status).toBe("cancelled");
  expect((await sibling.get()).updateTime).toEqual(before.updateTime); expect((await output.get()).updateTime).toEqual(state.updateTime);
  await expect(recovery.recoverDevPublicReleasePause({ firestore: db, attempt })).rejects.toThrow();
});
it("reconciles a lost committed reply in a fresh process without a second cancellation", async () => {
  const taskPath = await historical("retry"); await paused(); const receipt = await list();
  const boundary = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => { await (target.runTransaction as any)(...args); throw new Error("lost reply"); };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(owner.retirePreEnrollmentHistory({ firestore: boundary, request, operatorReceipt: receipt })).rejects.toThrow("lost reply");
  const before = await db.doc(taskPath).get();
  const script = `import{initializeApp,deleteApp}from'firebase-admin/app';import{getFirestore}from'firebase-admin/firestore';
    import o from './functions/lib/pre-enrollment-history.js';const a=initializeApp({projectId:'njpbs-site-dev'});
    try{process.stdout.write(JSON.stringify(await o.retirePreEnrollmentHistory({firestore:getFirestore(a),...JSON.parse(process.argv[1])})));}finally{await deleteApp(a);}`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ request, operatorReceipt: receipt })], { encoding: "utf8", timeout: 8000 }));
  expect(result.idempotent).toBe(true); expect((await db.doc(taskPath).get()).updateTime).toEqual(before.updateTime);
  await expect(apply({ ...receipt, listingDigest: "f".repeat(64) })).rejects.toThrow();
});
it("requires an explicit complete production target and matching database before any transaction", async () => {
  const transaction = vi.fn(), firestore = { projectId: "njpbs-site-dev", runTransaction: transaction };
  for (const target of [{ projectId: "njpbs-site" }, { ...targets.publicationTarget("production"), environment: undefined }, targets.publicationTarget("production")]) {
    await expect(owner.listPreEnrollmentHistory({ firestore, request: { ...request, target } })).rejects.toThrow();
  }
  expect(transaction).not.toHaveBeenCalled();
});
it.each(["dirty-tree", "wrong-commit"])("refuses %s before repository modules or credential fields evaluate", async mode => {
  expect(await refusedOperatorPrelaunch({ filename: "retire-pre-enrollment-history.mjs", businessPath: "scripts/lib/pre-enrollment-history-operator.mjs",
    mode, packetFields: { request, credentialIdentity: identity } })).toMatchObject({ status: 1, evaluated: false });
});
it("dispatches default read-only listing and receipt-bound apply through the protected operator", async () => {
  await historical("retry"); await paused(); const dir = await mkdtemp(join(tmpdir(), "history-operator-"));
  try {
    const packet: any = { schemaVersion: 1, kind: "pre-enrollment-history-operator", operatorCommitSha:
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), credentialIdentity: identity, request, operatorReceipt: null };
    const file = join(dir, "packet.json"), close = vi.fn(), openDatabase = vi.fn(async () => ({ firestore: db, close }));
    const readServiceAccount = vi.fn(async () => JSON.stringify({ type: "service_account", project_id: identity.projectId, client_email: identity.clientEmail,
      private_key_id: identity.privateKeyId, private_key: "synthetic-private-key-for-local-operator-tests" }));
    const args = async () => { const bytes = JSON.stringify(packet); await writeFile(file, bytes);
      return ["--packet", file, "--packet-digest", createHash("sha256").update(bytes).digest("hex")]; };
    const result = await runPreEnrollmentHistoryOperator(await args(), { readServiceAccount, openDatabase });
    expect(result.mode).toBe("list"); packet.operatorReceipt = { listing: result.listing, listingDigest: result.listingDigest };
    expect(await runPreEnrollmentHistoryOperator([...await args(), "--apply"], { readServiceAccount, openDatabase })).toMatchObject({ mode: "apply", idempotent: false });
    expect(close).toHaveBeenCalledTimes(2);
    packet.request = { ...request, target: { projectId: "njpbs-site" } }; readServiceAccount.mockClear(); openDatabase.mockClear();
    await expect(runPreEnrollmentHistoryOperator(await args(), { readServiceAccount, openDatabase })).rejects.toThrow();
    expect(readServiceAccount).not.toHaveBeenCalled(); expect(openDatabase).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("runs both held Bash fixtures as written with closed credential/provider fixtures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-runbook-"));
  try {
    const blocks = await Promise.all([0, 1].map(index =>
      readFile(new URL(`../fixtures/pre-enrollment-history-${index}.sh`, import.meta.url), "utf8")));
    expect(blocks).toHaveLength(2);
    // Temporary node/pass fixtures take precedence in PATH. The actual protected
    // operator/SDK dispatch is covered above; no provider or vault is contacted.
    await writeFile(join(dir, "pass"), "#!/bin/sh\ntest \"$1\" = show && test \"$2\" = fixture/history-sdk || exit 1\nprintf synthetic-credential\n", { mode: 0o700 });
    await writeFile(join(dir, "node"), `#!/usr/bin/python3
import json, os, sys
assert os.read(3, 1024) == b'synthetic-credential'
assert not os.read(3, 1)
print(json.dumps({'args':sys.argv[1:], 'credentialRead': True}))
`, { mode: 0o700 });
    for (const [index, block] of blocks.entries()) {
      const packet = join(dir, `${index}-packet.json`), output = join(dir, `${index}-result.json`), digest = "d".repeat(64);
      const prefix = index ? "HISTORY_APPLY" : "HISTORY_LIST";
      execFileSync("/bin/bash", ["-s"], { input: block, encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin`, HOME: process.env.HOME,
        HISTORY_SDK_ENTRY: "fixture/history-sdk", [`${prefix}_PACKET`]: packet, [`${prefix}_PACKET_DIGEST`]: digest, [`${prefix}_RESULT`]: output } });
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ credentialRead: true,
        args: ["scripts/retire-pre-enrollment-history.mjs", "--packet", packet, "--packet-digest", digest, ...(index ? ["--apply"] : [])] });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
