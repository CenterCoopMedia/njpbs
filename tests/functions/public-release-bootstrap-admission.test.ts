import { beforeEach, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import deployment from "../../functions/lib/public-deployment.js";
import fence from "../../functions/lib/public-release-bootstrap-admission.js";
import operator from "../../functions/lib/public-release-bootstrap-adoption.js";
import producer from "../../functions/lib/public-release-producer.js";
import p from "../../functions/lib/public-release-pair.js";
import settings from "../../functions/settings.js";
import coordinator from "../../functions/lib/public-deployment-coordinator.js";
import scheduler from "../../functions/scheduled-publish.js";
import audit from "../../functions/list-audit.js";
import { DEFAULT_PUBLIC_SITE_CHROME_SETTINGS } from "../../packages/content-core/src/cms-settings";
const db = isolatedFirestore("public-release-bootstrap-admission.test.ts");
const actor = { uid: "settings-editor", principal: { id: "settings-editor", grants: [{ role: "admin" }] } };
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: "a".repeat(40),
  activeDeploymentId: "fixture-release", lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-build", mediaLifecycleReady: true };
const attempt = { schemaVersion: 2, operationId: "initial-install", environment: "development", legacyPointerDigest: operator.legacyBootstrapPointerDigest(pointer) };
async function seed() {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set(pointer);
  await db.doc(`users/${actor.uid}`).set({ role: "admin", active: true });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: pointer.activeCommitSha,
    serializerId: "node-compute", cloud: { phase: "ready", commitSha: pointer.activeCommitSha, serializerId: "cloudflare-publisher" } });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc("cmsSettings/public-site-chrome").set({ schemaVersion: 1, values: DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, version: 1 });
}
beforeEach(seed);
it("keeps operator export preflight free of default Firebase app initialization", () => {
  const output = execFileSync(process.execPath, ["-e", "require('./functions/lib/public-release-bootstrap-adoption.js'); process.stdout.write(String(require('firebase-admin/app').getApps().length))"],
    { cwd: process.cwd(), encoding: "utf8" });
  expect(output).toBe("0");
});
async function publish(firestore: any = db) {
  const handler = settings.createCmsPublishSettingsHandler({ firestore, requirePrincipalFn: async () => actor, log: { error() {} } });
  const body = { id: "public-site-chrome", baseVersion: 1, publicationTransport: "public-context-no-build-v1" };
  const res: any = { code: 200, headersSent: false, set() {}, status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } }, res);
  return res;
}
it("closes once before the pause and binds the initial CAS to the exact immutable attempt", async () => {
  const first = await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt });
  expect(first.idempotent).toBe(false);
  expect((await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt })).idempotent).toBe(true);
  expect((await db.collection("admin_logs").get()).size).toBe(1);
  await db.runTransaction(transaction => operator.assertClosedBootstrapFenceInTransaction({ firestore: db, transaction,
    environment: "development", before: pointer, operationId: attempt.operationId }));
  await expect(db.runTransaction(transaction => operator.assertClosedBootstrapFenceInTransaction({ firestore: db, transaction,
    environment: "development", before: { ...pointer, activeCommitSha: "b".repeat(40) } }))).rejects.toThrow();
});
it("keeps both operator audit rows readable through the real Activity endpoint", async () => {
  await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt });
  await operator.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt });
  const handler = audit.createCmsListAuditHandler({ firestore: db, requirePrincipalFn: async () => actor, log: { error() {} } });
  const response: any = { code: 200, headersSent: false, set() { return this; }, status(code: number) { this.code = code; return this; },
    json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
  await handler({ method: "POST", body: {}, headers: {} }, response);
  expect(response.code, JSON.stringify(response.body)).toBe(200);
  expect(response.body.entries).toHaveLength(2);
  for (const entry of response.body.entries) expect(entry).toMatchObject({ action: "public-release.bootstrap-admission",
    actorUid: "system:public-release-bootstrap", at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
});
it("refuses actual Settings acceptance with the named retryable pause before enrollment exists", async () => {
  await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt });
  const before = (await db.doc("cmsSettings/public-site-chrome").get()).data();
  const result = await publish();
  expect(result.code).toBe(409);
  expect(result.body.error).toBe("Publishing paused for an update. Please try again shortly.");
  expect((await db.doc("cmsSettings/public-site-chrome").get()).data()).toEqual(before);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
  await expect(db.runTransaction(transaction => producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction,
    operationId: "withdrawal", changes: [{ kind: "provider", id: "dependency", action: "dependency", sourceVersion: 1, snapshot: {} }] })))
    .rejects.toMatchObject({ code: "public_release_bootstrap_admission_paused", retryable: true, scheduleDeferred: true, status: 409 });
});
it("does not reopen admission when both runtime pins are readied", async () => {
  await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  await db.doc("system/cmsPublicationRuntime").update({ phase: "ready", "cloud.phase": "ready" });
  expect((await publish()).code).toBe(409);
  expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.status).toBe("closed");
});
it("defers a real scheduled Page during the closed pause without losing its due source", async () => {
  const document = { id: "contact", version: 1, title: "Contact", blocks: [], status: "scheduled",
    publishAt: "2026-10-28T12:00:00.000Z", publiclyVisible: false, createdBy: actor.uid };
  await db.doc("cmsPages/contact").set(document);
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { pages: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-artifacts" });
  await db.doc("system/publicDeployment/noBuildPages/capability").set({ schemaVersion: 1, rendererSha: pointer.activeCommitSha,
    servingEnabled: true, generation: 1, terminalOwner: { schemaVersion: 1, transport: "page-no-build-v1", rendererSha: pointer.activeCommitSha } });
  await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt });
  const localFirestore = new Proxy(db, { get(owner, key) {
    if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(owner, key); return typeof value === "function" ? value.bind(owner) : value;
  } });
  const run = scheduler.createScheduledPublishRunner({ firestore: localFirestore, now: () => document.publishAt, log: { info() {}, warn() {}, error() {} },
    reconcileStaleFn: async () => {}, assertPublishReadyFn: async () => { throw new Error("The legacy build must not start"); } });
  expect((await run()).publishedCount).toBe(0);
  expect((await db.doc("cmsPages/contact").get()).data()).toEqual(document);
  expect((await db.collection("cmsPublishQueue").get()).empty).toBe(true);
  expect((await db.collection("cmsVersionHistory").get()).empty).toBe(true);
});
it("preserves absent and open-fence Settings behavior", async () => {
  expect((await publish()).code).toBe(200);
  await seed();
  // A valid historical opened receipt; only the operator writes this in use.
  await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).set({ schemaVersion: 2, operationId: attempt.operationId,
    attemptDigest: p.publicReleaseDigest(attempt), status: "open", resumeReceiptDigest: "e".repeat(64) });
  expect((await publish()).code).toBe(200);
});
it("blocks a new legacy reservation and can abandon once before conversion with a logged release", async () => {
  await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt });
  await expect(coordinator.reservePublicBuildBatch({ firestore: db, buildBatchId: "racing-release", commitSha: "b".repeat(40) }))
    .rejects.toMatchObject({ name: "PublicReleaseProtocolError", status: 409 });
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(pointer);
  expect((await operator.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt })).idempotent).toBe(false);
  expect((await operator.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt })).idempotent).toBe(true);
  await expect(operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt })).rejects.toThrow();
  expect((await db.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
  expect((await db.collection("admin_logs").get()).size).toBe(2);
  const retry = { ...attempt, operationId: "retry-initial-install" };
  expect((await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: retry })).idempotent).toBe(false);
  await operator.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt: retry });
  expect((await publish()).code).toBe(200);
});
it("refuses a real outstanding legacy reservation before taking either pause fence", async () => {
  await coordinator.reservePublicBuildBatch({ firestore: db, buildBatchId: "prior-release", commitSha: "b".repeat(40) });
  const reserved = (await db.doc("system/publicDeployment").get()).data();
  expect(reserved?.lastReservedGeneration).toBeGreaterThan(reserved!.activeGeneration);
  await expect(operator.closePublicReleaseBootstrapAdmission({ firestore: db,
    attempt: { ...attempt, legacyPointerDigest: operator.legacyBootstrapPointerDigest(reserved) } })).rejects.toThrow();
  expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
});
it.each(["reserved", "pending", "publishing"])("refuses an undrained %s public queue while leaving admission open", async status => {
  await db.doc("cmsPublishQueue/prior-acceptance").set({ status });
  await expect(operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt })).rejects.toThrow();
  expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
});
it.each([{ mediaLifecycleReady: false }, { lastReservedGeneration: 2, newestEligibleGeneration: 2, newestEligibleBuildBatchId: "queued-build" }])(
  "requires a stable media-ready legacy cutoff %j", async change => {
    const current = { ...pointer, ...change }; await db.doc("system/publicDeployment").set(current);
    await expect(operator.closePublicReleaseBootstrapAdmission({ firestore: db,
      attempt: { ...attempt, legacyPointerDigest: operator.legacyBootstrapPointerDigest(current) } })).rejects.toThrow();
    expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
  });
it("places a real Settings acceptance on one side of close without stranding a queue", async () => {
  const [closed, accepted] = await Promise.allSettled([
    operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt }), publish(),
  ]);
  expect(accepted.status).toBe("fulfilled");
  if (accepted.status !== "fulfilled") throw accepted.reason;
  const queues = await db.collection("cmsPublishQueue").get();
  if (closed.status === "fulfilled") {
    expect(accepted.value.code).toBe(409); expect(queues.empty).toBe(true);
    expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.status).toBe("closed");
  } else {
    expect(accepted.value.code).toBe(200); expect(queues.empty).toBe(false);
    expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
    expect((await db.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
  }
});
it("serializes a racing legacy reservation and the first-install pause on one side", async () => {
  const results = await Promise.allSettled([
    operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt }),
    coordinator.reservePublicBuildBatch({ firestore: db, buildBatchId: "racing-release", commitSha: "b".repeat(40) }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  const closed = (await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists;
  expect(closed).toBe(results[0].status === "fulfilled");
});
it.each(["system/publicReleaseChanges", "system/publicReleaseChanges/enrollment/initial", "system/publicReleaseChangeLog"])(
  "cannot abandon the closed pause after enrollment authority appears at %s", async path => {
    await operator.closePublicReleaseBootstrapAdmission({ firestore: db, attempt });
    await db.doc(path).set({ schemaVersion: 2 });
    await expect(operator.abandonPublicReleaseBootstrapAdmission({ firestore: db, attempt })).rejects.toThrow();
    expect((await db.doc(fence.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).data()?.status).toBe("closed");
    expect((await db.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(true);
    expect((await db.doc(`system/publicReleaseAdmissions/bootstrapAbandons/${attempt.operationId}`).get()).exists).toBe(false);
  });
it("measures the extra document in the existing producer RPC on actual Settings publishes", async () => {
  const samples: { baseline: number[]; batched: number[] } = { baseline: [], batched: [] };
  for (const mode of ["batched", "baseline", "baseline", "batched"] as const) {
    await seed();
    let calls = 0, fenceReads = 0;
    const measured = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return (callback: any, ...options: unknown[]) => target.runTransaction(transaction => callback(new Proxy(transaction, {
        get(owner, field) {
          if (field === "getAll") return async (...refs: any[]) => {
            if (refs.length === 2 && refs[0].path === producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL && refs[1].path === fence.BOOTSTRAP_ADMISSION_FENCE_PATH) {
              calls++;
              if (mode === "baseline") return [...await owner.getAll(refs[0]), { data: () => undefined }];
              fenceReads++; return owner.getAll(...refs);
            }
            const value = Reflect.get(owner, field); return value.apply(owner, refs);
          };
          const value = Reflect.get(owner, field); return typeof value === "function" ? value.bind(owner) : value;
        },
      })), ...options);
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const start = performance.now(), result = await publish(measured);
    samples[mode].push(Number((performance.now() - start).toFixed(2)));
    expect(result.code).toBe(200); expect(calls).toBe(1); expect(fenceReads).toBe(mode === "batched" ? 1 : 0);
  }
  process.stdout.write(`Bootstrap fence actual Settings acceptance milliseconds ${JSON.stringify(samples)}\n`);
});
