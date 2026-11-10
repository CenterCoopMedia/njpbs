import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import admission from "../../functions/lib/public-release-bootstrap-admission.js";
import p from "../../functions/lib/public-release-pair.js";
import pause from "../../functions/lib/dev-public-release-pause.js";
import recovery from "../../functions/lib/dev-public-release-pause-recovery.js";
import context from "../../functions/lib/public-context-publication.js";
import home from "../../functions/lib/no-build-home-ownership.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import { publicContextDigest } from "../../functions/lib/public-context-revision.js";
import { projectPublicReleasePairSourceCensusDocuments, preparePublicReleasePairSourceCensus } from "../../site/scripts/public-release-pair-source-census";
import { runDevPublicReleasePauseRecoveryOperator } from "../../scripts/lib/dev-public-release-pause-recovery-operator.mjs";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "dev-pause-recovery-sdk"), db = getFirestore(app);
afterAll(() => deleteApp(app));
const sha = "a".repeat(40), operationId = "C".repeat(20), runtime = { owner: "cloudflare", release: sha };
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: sha,
  activeDeploymentId: "original-old", lastReservedGeneration: 1, newestEligibleGeneration: 1,
  newestEligibleBuildBatchId: "original-build", mediaLifecycleReady: true };
const pins = { schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "original-primary",
  cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } };
const pauseAttempt = { schemaVersion: 1, operationId: "original-development-pause", environment: "development", projectId: "njpbs-site-dev",
  oldRuntime: pins, legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) };
const pauseApply = () => pause.pauseDevPublicRelease({ firestore: db, attempt: pauseAttempt });
const apply = (attempt: any, firestore: any = db) => recovery.recoverDevPublicReleasePause({ firestore, attempt });
const read = (attempt: any) => recovery.readDevPublicReleasePauseRecovery({ firestore: db, attempt });
const identity = { projectId: "njpbs-site-dev", clientEmail: "fixture-operator@njpbs-site-dev.iam.gserviceaccount.com",
  privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev/bootstrap-operator" };
const original = async () => {
  const result = await pause.readDevPublicReleasePause({ firestore: db, attempt: pauseAttempt });
  return { schemaVersion: 1, pauseAttempt, pauseReceiptDigest: p.publicReleaseDigest(result.pauseReceipt), failureReceiptDigest: result.failureReceiptDigest };
};
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set(pointer);
  await db.doc("system/cmsPublicationRuntime").set(pins);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("cmsSettings/public-site-chrome").set({ published: { sourceVersion: 7, metadata: { title: "Intended source" } } });
});
async function contextFailure(kind = "output", contextRevision = 1) {
  await db.runTransaction(async transaction => {
    const plan = await context.enqueuePublicContextInTransaction({ firestore: db, transaction, operationId, runtime, reason: "settings", contextRevision }); plan.write();
  });
  await expect(pauseApply()).rejects.toThrow();
  if (kind === "output") {
    const batch = db.batch();
    for (const output of context.OUTPUTS) {
      batch.update(db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/${output}`), { status: "verified", claim: null, nextAttemptAt: null });
      batch.update(db.doc(`cmsBackgroundOutputs/${output}`), { status: "verified" });
    }
    await batch.commit();
    await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`).update({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
    await db.doc("cmsBackgroundOutputs/search").update({ status: "failed" });
    await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "failed", claim: null, nextAttemptAt: null });
  } else {
    await db.doc(`cmsPublishQueue/${operationId}/backgroundPreparation/${publicContextDigest(contextRevision)}`).set({ schemaVersion: 1,
      status: "failed", attempts: 4, claim: null, nextAttemptAt: null, runtime, contextDigest: publicContextDigest(contextRevision) });
    await context.failPublicContextPreparation({ firestore: db, operationId, runtime });
  }
  expect(await pauseApply()).toMatchObject({ stop: true, drainCommitted: false });
  return original();
}
async function homeFailure() {
  const homeId = "H".repeat(20), sourceId = "P".repeat(20);
  const operation = { schemaVersion: 1, operationId: homeId, pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"],
    rendererSha: sha, generation: 1, sourceVersion: 1, visible: true };
  const nextDocument = { status: "published", publiclyVisible: true, published: { sourceVersion: 1, metadata: {}, blocks: [] } };
  await db.runTransaction(async transaction => {
    const plan = await home.prepareHomePlanInTransaction({ firestore: db, transaction, nextDocument, operation, runtime });
    transaction.set(db.doc("system/publicDeployment/noBuildPageOwners/home"), { ...operation, runtime });
    transaction.set(db.doc(`cmsPublishQueue/${homeId}`), { status: "success", transport: "page-no-build-v1", backgroundRuntime: runtime, noBuildPage: operation });
    transaction.set(db.doc("cmsPages/home"), nextDocument); plan!.write();
  });
  await db.doc(`cmsPublishQueue/${sourceId}`).set({ status: "pending", transport: "post-no-build-v1", backgroundRuntime: runtime,
    noBuildPost: { operationId: sourceId, postId: "native-post", sourceVersion: 1, rendererSha: sha } });
  await db.runTransaction(async transaction => {
    const write = await home.prepareHomePostRefreshInTransaction({ firestore: db, transaction, postId: "native-post", nextDocument,
      queueId: sourceId, affectedSections: [] }); write();
  });
  await expect(pauseApply()).rejects.toThrow();
  await db.doc(`cmsPublishQueue/${sourceId}/homePageRefresh/home`).update({ status: "failed", attempts: 4, claim: null, nextAttemptAt: null });
  await db.doc(`cmsPublishQueue/${sourceId}`).update({ status: "failed", claim: null, nextAttemptAt: null });
  expect(await pauseApply()).toMatchObject({ stop: true });
  return original();
}
async function acceptedSnapshot() {
  const map: any = {};
  for (const collection of ["cmsPublishQueue", "cmsBackgroundOutputs", "system/publicDeployment/noBuildPageOwners"]) {
    for (const row of (await db.collection(collection).get()).docs) {
      map[row.ref.path] = { data: row.data(), updateTime: row.updateTime };
      if (collection === "cmsPublishQueue") for (const family of ["backgroundOutputs", "backgroundPreparation", "homePageRefresh"]) {
        for (const task of (await row.ref.collection(family).get()).docs) map[task.ref.path] = { data: task.data(), updateTime: task.updateTime };
      }
    }
  }
  for (const path of ["system/publicDeployment", "system/cmsPublicationRuntime", `${"system/devPublicReleasePause"}/attempts/${pauseAttempt.operationId}`,
    `system/devPublicReleasePause/failures/${pauseAttempt.operationId}`]) {
    const row = await db.doc(path).get(); map[path] = { data: row.data(), updateTime: row.updateTime };
  }
  return map;
}
it.each(["output", "home"])("seals %s failures without rewriting accepted work or the original STOP", async kind => {
  const attempt = kind === "home" ? await homeFailure() : await contextFailure(kind), before = await acceptedSnapshot();
  const result = await apply(attempt);
  expect(result).toMatchObject({ recoveryCommitted: true, canContinue: true, originalOutcome: "paused-failed", drainCommitted: false,
    receipt: { acceptedWorkChanged: 0, providerWrites: 0, remedy: "logged-republish-after-resume" } });
  expect(result.receipt.failedWork.every((row: any) => row.outcome === "failed-not-published" && row.failureReceiptDigest === attempt.failureReceiptDigest && row.records.length)).toBe(true);
  expect(result.receipt.failedWork.flatMap((row: any) => row.documents)).toContain(kind === "home" ? "cmsPages/home" : "cmsSettings/public-site-chrome");
  expect(await acceptedSnapshot()).toEqual(before);
  expect(await pauseApply()).toMatchObject({ stop: true, drainCommitted: false, currentReady: false });
  expect(await read(attempt)).toEqual({ ...result, idempotent: undefined });
  expect((await db.doc("system/publicReleaseChanges").get()).exists).toBe(false);
  expect((await db.doc(`system/devPublicReleasePause/drains/${pauseAttempt.operationId}`).get()).exists).toBe(false);
});
it("keeps native preparation exhaustion at STOP without changing its never-started pending siblings", async () => {
  const attempt = await contextFailure("preparation"), before = await acceptedSnapshot();
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({
    status: "failed", error: "background_preparation_failed" });
  for (const output of context.OUTPUTS) {
    const task = (await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/${output}`).get()).data()!;
    expect(task).toMatchObject({ status: "pending", attempts: 0, claim: null });
    expect(Number.isFinite(task.nextAttemptAt)).toBe(true);
    expect((await db.doc(`cmsBackgroundOutputs/${output}`).get()).data()).toMatchObject({ status: "pending" });
  }
  await expect(apply(attempt)).rejects.toMatchObject({ name: "PublicReleaseProtocolError", status: 409 });
  expect(await acceptedSnapshot()).toEqual(before);
  expect(await pauseApply()).toMatchObject({ stop: true, drainCommitted: false, currentReady: false });
  for (const path of [admission.BOOTSTRAP_ADMISSION_FENCE_PATH, recovery.RECOVERY_EVIDENCE_PATH,
    `system/devPublicReleasePause/recoveries/${pauseAttempt.operationId}`]) {
    expect((await db.doc(path).get()).exists).toBe(false);
  }
});
it("binds failed-not-published evidence into baseline H and the qualification source seal without dropping intended source", async () => {
  const attempt = await contextFailure(); await apply(attempt);
  const census = await db.runTransaction(transaction => baseline.readPublicReleaseSourceCensusInTransaction({ firestore: db, transaction }), { readOnly: true });
  const documents = new Map<string, any>();
  for (const value of census.values) for (const doc of JSON.parse(value.json).documents) documents.set(doc.path, doc.data);
  expect(documents.get(recovery.RECOVERY_EVIDENCE_PATH)).toMatchObject({ kind: "dev-public-release-failed-not-published",
    failureReceiptDigest: attempt.failureReceiptDigest, failedWork: [{ operationId, outcome: "failed-not-published" }] });
  expect(documents.get("cmsSettings/public-site-chrome").published.sourceVersion).toBe(7);
  const expected = projectPublicReleasePairSourceCensusDocuments(documents);
  expect(expected.members.find(row => row.path === recovery.RECOVERY_EVIDENCE_PATH)).toBeDefined();
  const cursor = { baselineDigest: "b".repeat(64), sequence: 0, lastDigest: "b".repeat(64) };
  await db.doc("system/publicReleaseChanges").set({ schemaVersion: 2, ...cursor });
  expect((await preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor })).metadata).toEqual(expected);
  await db.doc(recovery.RECOVERY_EVIDENCE_PATH).update({ receiptDigest: "c".repeat(64) });
  await expect(preparePublicReleasePairSourceCensus({ firestore: db, expected, cursor })).rejects.toThrow();
});
it("keeps an exhausted Post public proof distinct from the original successful queue outcome", async () => {
  const id = "R".repeat(20), post = { postId: "proof-post", operationId: id, sourceVersion: 1, rendererSha: sha, generation: 2,
    visible: true, slug: "proof-post", ownedSlugs: ["proof-post"] };
  const ref = db.doc(`cmsPublishQueue/${id}`);
  await ref.set({ status: "success", transport: "post-no-build-v1", backgroundRuntime: runtime, noBuildPost: post,
    claim: null, nextAttemptAt: null, postProof: { status: "pending", attempts: 1, claim: null, nextAttemptAt: Date.now() + 60000 } });
  await db.doc("system/publicDeployment/noBuildPostOwners/proof-post").set({ schemaVersion: 1, servingEnabled: true, ...post, runtime });
  await expect(pauseApply()).rejects.toThrow();
  await ref.update({ postProof: { status: "failed", attempts: 4, claim: null, nextAttemptAt: null } });
  expect(await pauseApply()).toMatchObject({ stop: true });
  const attempt = await original(), before = await acceptedSnapshot(), result = await apply(attempt);
  expect(result).toMatchObject({ recoveryCommitted: true, canContinue: true,
    receipt: { failedWork: [{ operationId: id, originalQueueStatus: "success", outcome: "failed-not-published", documents: ["cmsPosts/proof-post"] }] } });
  expect(await acceptedSnapshot()).toEqual(before);
});
it.each(["fence", "receipt"])("reconciles a lost %s commit reply and retries after process restart", async point => {
  const attempt = await contextFailure(), before = await acceptedSnapshot(); let dropped = false;
  const boundary = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      const value = await (target.runTransaction as any)(...args);
      const committed = point === "fence" ? value?.fence?.status === "closed" :
        (await target.doc(`system/devPublicReleasePause/recoveries/${pauseAttempt.operationId}`).get()).exists;
      if (committed && !dropped) { dropped = true; throw new Error("lost committed reply"); }
      return value;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(apply(attempt, boundary)).rejects.toThrow("lost committed reply"); expect(dropped).toBe(true);
  const script = `import {initializeApp,deleteApp} from 'firebase-admin/app';import {getFirestore} from 'firebase-admin/firestore';
    import owner from './functions/lib/dev-public-release-pause-recovery.js';
    const app=initializeApp({projectId:'njpbs-site-dev'});try {process.stdout.write(JSON.stringify(await owner.recoverDevPublicReleasePause({firestore:getFirestore(app),attempt:JSON.parse(process.argv[1])})));}finally{await deleteApp(app);}`;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(attempt)], { encoding: "utf8", timeout: 8000 }));
  expect(result).toMatchObject({ recoveryCommitted: true, canContinue: true });
  const saved = await db.doc(`system/devPublicReleasePause/recoveries/${pauseAttempt.operationId}`).get();
  expect(await apply(attempt)).toMatchObject({ idempotent: true, receiptDigest: result.receiptDigest });
  expect((await db.doc(`system/devPublicReleasePause/recoveries/${pauseAttempt.operationId}`).get()).updateTime).toEqual(saved.updateTime);
  expect(await acceptedSnapshot()).toEqual(before);
});
it.each(["post", "version", "source-operation", "revision"])("refuses a Home refresh with changed %s identity", async change => {
  const attempt = await homeFailure(), ref = db.doc(`cmsPublishQueue/${"P".repeat(20)}/homePageRefresh/home`);
  const field = { post: "input.postId", version: "input.sourceVersion", "source-operation": "input.sourceOperationId", revision: "revision" }[change]!;
  await ref.update({ [field]: change === "post" ? "wrong-post" : change === "source-operation" ? "X".repeat(20) : 99 });
  const before = await acceptedSnapshot();
  await expect(apply(attempt)).rejects.toThrow(); expect(await acceptedSnapshot()).toEqual(before);
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
});
it.each(["source", "serializer", "cloud-source", "cloud-serializer", "phase", "pointer", "enrollment", "producer"])("refuses changed OLD %s before closing fences", async change => {
  const attempt = await contextFailure();
  if (change === "pointer") await db.doc("system/publicDeployment").update({ activeCommitSha: "c".repeat(40) });
  else if (change === "enrollment") await db.doc("system/publicReleaseChanges/enrollment/initial").set({ schemaVersion: 1 });
  else if (change === "producer") await db.doc("system/publicReleaseChangeLog").set({ enabled: false });
  else await db.doc("system/cmsPublicationRuntime").update({ [({ source: "commitSha", serializer: "serializerId", "cloud-source": "cloud.commitSha",
    "cloud-serializer": "cloud.serializerId", phase: "phase" } as any)[change]]: change.includes("source") ? "c".repeat(40) : change === "phase" ? "ready" : "foreign-owner" });
  const before = await acceptedSnapshot(); await expect(apply(attempt)).rejects.toThrow(); expect(await acceptedSnapshot()).toEqual(before);
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
});
it.each(["claim", "retry", "pending", "missing", "wrong-runtime", "wrong-output", "aliased-output", "other-pending", "other-exhausted"])("refuses %s work without reset or transfer", async change => {
  const attempt = await contextFailure(), task = db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/search`);
  if (change === "claim") await task.update({ claim: "held-claim" });
  if (change === "retry") await task.update({ nextAttemptAt: Date.now() });
  if (change === "pending") await task.update({ status: "pending" });
  if (change === "missing") await task.delete();
  if (change === "wrong-runtime") await task.update({ "runtime.release": "c".repeat(40) });
  if (change === "wrong-output") await db.doc("cmsBackgroundOutputs/search").update({ revision: 99 });
  if (change === "aliased-output") await db.doc("cmsBackgroundOutputs/feed").set({ ...(await db.doc("cmsBackgroundOutputs/search").get()).data(), output: "feed" });
  if (change.startsWith("other-")) await db.doc(`cmsPublishQueue/${operationId}/backgroundOutputs/other`).set({ schemaVersion: 1, runtime,
    status: change === "other-pending" ? "pending" : "failed", attempts: 4, claim: null, nextAttemptAt: null });
  const before = await acceptedSnapshot(); await expect(apply(attempt)).rejects.toThrow(); expect(await acceptedSnapshot()).toEqual(before);
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
});
it.each(["preparation-retry", "preparation-claim", "admission"])("keeps historical %s records at STOP without inferring abandonment", async kind => {
  const historicalId = "Z".repeat(20), historicalQueue = `cmsPublishQueue/${historicalId}`;
  await db.doc(historicalQueue).set({ schemaVersion: 1, status: "success", transport: "post-no-build-v1", runtime, backgroundRuntime: runtime,
    noBuildPost: { operationId: historicalId, postId: "historical-post", sourceVersion: 1, rendererSha: sha } });
  const path = kind === "admission" ? `${historicalQueue}/backgroundOutputs/_admission` :
    `${historicalQueue}/backgroundPreparation/${publicContextDigest(1)}`;
  await db.doc(path).set(kind === "admission" ? {
    schemaVersion: 1, runtime, owner: "post-background-v1", postId: "historical-post", stage: "preparation",
    status: "failed", error: "background_preparation_failed", nextAttemptAt: null,
  } : {
    schemaVersion: 1, runtime, contextDigest: publicContextDigest(1), attempts: 1,
    status: kind === "preparation-claim" ? "building" : "failed",
    claim: kind === "preparation-claim" ? "original-claim" : null, nextAttemptAt: Date.now() + 60_000,
  });
  // The context advances without settling the old preparation/admission record.
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 2 });
  const attempt = await contextFailure("output", 2), before = await acceptedSnapshot();
  const failure = (await db.doc(`system/devPublicReleasePause/failures/${pauseAttempt.operationId}`).get()).data()!;
  expect(failure.operations).not.toContain(historicalId);
  expect(failure.blockers.some((row: any) => row.path === path)).toBe(false);
  await expect(apply(attempt)).rejects.toMatchObject({ name: "PublicReleaseProtocolError", status: 409 });
  expect(await acceptedSnapshot()).toEqual(before);
  expect(await pauseApply()).toMatchObject({ stop: true, drainCommitted: false, currentReady: false });
  for (const target of [admission.BOOTSTRAP_ADMISSION_FENCE_PATH, recovery.RECOVERY_EVIDENCE_PATH,
    `system/devPublicReleasePause/recoveries/${pauseAttempt.operationId}`]) {
    expect((await db.doc(target).get()).exists).toBe(false);
  }
});
it.each(["njpbs-site", "demo-njpbs", "unrelated-project"])("refuses %s before any SDK transaction", async projectId => {
  const attempt = await contextFailure(), wrongApp = initializeApp({ projectId }, `recovery-${projectId}`), wrongDb = getFirestore(wrongApp);
  const runTransaction = vi.spyOn(wrongDb, "runTransaction");
  try {
    await expect(apply(attempt, wrongDb)).rejects.toThrow();
    await expect(recovery.readDevPublicReleasePauseRecovery({ firestore: wrongDb, attempt })).rejects.toThrow();
    expect(runTransaction).not.toHaveBeenCalled();
  } finally { runTransaction.mockRestore(); await deleteApp(wrongApp); }
});
it("retains historical recovery after enrollment and never re-closes or re-pauses a later runtime", async () => {
  const attempt = await contextFailure(), result = await apply(attempt);
  await db.doc("system/publicReleaseChanges").set({ schemaVersion: 2 });
  await db.doc("system/publicDeployment").set({ schemaVersion: 2 });
  await db.doc("system/cmsPublicationRuntime").set(pins);
  const before = await acceptedSnapshot();
  expect(await apply(attempt)).toMatchObject({ idempotent: true, recoveryCommitted: true, canContinue: false, receiptDigest: result.receiptDigest });
  expect(await acceptedSnapshot()).toEqual(before);
});
it("refuses changed failure identity, mutated immutable receipts and a missing original STOP", async () => {
  const attempt = await contextFailure();
  await expect(apply({ ...attempt, failureReceiptDigest: "e".repeat(64) })).rejects.toThrow();
  await db.doc(`system/devPublicReleasePause/failures/${pauseAttempt.operationId}`).update({ acceptedWorkChanged: 1 });
  await expect(apply(attempt)).rejects.toThrow();
  await db.doc(`system/devPublicReleasePause/failures/${pauseAttempt.operationId}`).delete();
  await expect(apply(attempt)).rejects.toThrow();
});
it("refuses a census path outside the recovery marker grammar before closing fences or writing evidence", async () => {
  const attempt = await contextFailure();
  await db.doc("cmsSettings/legacy:chrome").set({ published: { sourceVersion: 1, metadata: {} } });
  const before = await acceptedSnapshot();
  await expect(apply(attempt)).rejects.toThrow();
  expect(await acceptedSnapshot()).toEqual(before);
  expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
  expect((await db.doc(recovery.RECOVERY_EVIDENCE_PATH).get()).exists).toBe(false);
  expect((await db.doc(`system/devPublicReleasePause/recoveries/${pauseAttempt.operationId}`).get()).exists).toBe(false);
});
it("runs the protected offline plan and rejects production packets before credential use", async () => {
  const attempt = await contextFailure(), dir = await mkdtemp(join(tmpdir(), "dev-recovery-"));
  try {
    for (const production of [false, true]) {
      const packet = { schemaVersion: 1, kind: "dev-public-release-pause-recovery-operator", operatorCommitSha:
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), credentialIdentity: identity,
        attempt: production ? { ...attempt, pauseAttempt: { ...pauseAttempt, projectId: "njpbs-site", environment: "production" } } : attempt };
      const bytes = JSON.stringify(packet), file = join(dir, "packet.json"); await writeFile(file, bytes);
      const args = ["--packet", file, "--packet-digest", createHash("sha256").update(bytes).digest("hex")];
      const readServiceAccount = vi.fn(), openDatabase = vi.fn();
      if (production) {
        await expect(runDevPublicReleasePauseRecoveryOperator([...args, "--apply"], { readServiceAccount, openDatabase })).rejects.toThrow();
        expect(() => execFileSync(process.execPath, ["scripts/recover-dev-public-release-pause.mjs", ...args], { stdio: "pipe" })).toThrow();
      } else {
        const result = JSON.parse(execFileSync(process.execPath, ["scripts/recover-dev-public-release-pause.mjs", ...args], { encoding: "utf8" }));
        expect(result).toMatchObject({ mode: "plan", authorityReads: 0, authorityWrites: 0 });
        expect(await runDevPublicReleasePauseRecoveryOperator(args, { readServiceAccount, openDatabase })).toMatchObject({ mode: "plan" });
      }
      expect(readServiceAccount).not.toHaveBeenCalled(); expect(openDatabase).not.toHaveBeenCalled();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("binds the credential identity and dispatches apply/readback through the real development SDK", async () => {
  const attempt = await contextFailure(), dir = await mkdtemp(join(tmpdir(), "dev-recovery-dispatch-"));
  try {
    const packet = { schemaVersion: 1, kind: "dev-public-release-pause-recovery-operator", credentialIdentity: identity, attempt,
      operatorCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
    const bytes = JSON.stringify(packet), file = join(dir, "packet.json"); await writeFile(file, bytes);
    const args = ["--packet", file, "--packet-digest", createHash("sha256").update(bytes).digest("hex")];
    const account = { type: "service_account", project_id: identity.projectId, client_email: identity.clientEmail,
      private_key_id: identity.privateKeyId, private_key: "synthetic-private-key-for-local-operator-tests" };
    const close = vi.fn(), openDatabase = vi.fn(async () => ({ firestore: db, close }));
    await expect(runDevPublicReleasePauseRecoveryOperator([...args, "--apply"], {
      readServiceAccount: async () => JSON.stringify({ ...account, project_id: "njpbs-site" }), openDatabase })).rejects.toThrow();
    expect(openDatabase).not.toHaveBeenCalled();
    const readServiceAccount = async () => JSON.stringify(account);
    expect(await runDevPublicReleasePauseRecoveryOperator([...args, "--apply"], { readServiceAccount, openDatabase }))
      .toMatchObject({ mode: "apply", recoveryCommitted: true, canContinue: true });
    expect(await runDevPublicReleasePauseRecoveryOperator([...args, "--readback"], { readServiceAccount, openDatabase }))
      .toMatchObject({ mode: "readback", recoveryCommitted: true, canContinue: true });
    expect(close).toHaveBeenCalledTimes(2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
