import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp, GeoPoint, FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import owner from "../../scripts/lib/dev-inactive-bootstrap.cjs";
import protocol from "../../functions/lib/public-release-pair.js";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import pause from "../../functions/lib/dev-public-release-pause.js";
import renderer from "../../functions/lib/dev-preview-renderer-bootstrap.js";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import previewSerializer from "../../functions/lib/cms-preview-serializer.js";
import { parseDevInactiveBootstrapPacket } from "../../scripts/lib/dev-inactive-bootstrap-operator.mjs";
import { installPrivatePairAccess } from "../../scripts/lib/public-release-private-access-operator.mjs";
import { repositoryFixture } from "../helpers/repository-identity.mjs";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "dev-inactive-bootstrap-test"), db = getFirestore(app);
const sha = "a".repeat(40), operationId = "retire-unused-development-bootstrap", bootstrapId = "original-bootstrap";
const runtime = { schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "original-dev-primary",
  cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } };
const oldEnvironment = process.env.CMS_DEPLOYMENT_ENVIRONMENT;
let retained: { path: string; data: any }[], request: any, enrollmentRequest: any;
const clear = () => clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, db);
const inspect = (id = operationId) => owner.inspectDevInactiveBootstrap({ firestore: db, operationId: id });
const apply = (value = request, dryRun = false) => owner.retireDevInactiveBootstrap({ firestore: db, request: value, dryRun });
const read = (value = request) => owner.readDevInactiveBootstrap({ firestore: db, request: value });
async function originalAccess() {
  const uid = (i: number) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const packet = { schemaVersion: 1, kind: "private-pair-access-operator", operatorCommitSha: sha,
    environment: "development", operationId: "retained-original-access", accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "fixture-operator@njpbs-site-dev.iam.gserviceaccount.com",
      privateKeyId: "b".repeat(40), secretRef: "pass://fixture/development" }, providerCredentialRef: "pass://fixture/access-provider",
    targets: ["old-reader", "new-reader", "operator"].map((role, i) => ({ role,
      origin: `https://dev-pair-${i === 2 ? "operator" : "reader"}-retained-${i}.njpbs.org`,
      serviceTokenId: uid(i + 1), clientId: `fixture${i}.access`, credentialRef: `pass://fixture/access-${i}` })) };
  const apps: any[] = [], policies = new Map<string, any[]>(), posts: string[] = [];
  const fetchImpl = async (input: any, init: any) => {
    const path = new URL(input).pathname.replace(`/client/v4/accounts/${packet.accountId}/access`, "");
    const envelope = (result: unknown) => Response.json({ success: true, result });
    if (path.startsWith("/service_tokens/")) {
      const target = packet.targets.find(t => path.endsWith(t.serviceTokenId))!;
      return envelope({ id: target.serviceTokenId, client_id: target.clientId, enabled: true, expires_at: "2099-01-01T00:00:00Z" });
    }
    if (init.method === "POST") {
      posts.push(path); const body = JSON.parse(init.body);
      if (path === "/apps") { const app = { ...body, id: uid(10 + apps.length), aud: String(apps.length + 1).repeat(64) };
        apps.push(app); policies.set(app.id, []); return envelope(app); }
      const list = policies.get(path.split("/")[2])!; const policy = { ...body, id: uid(20 + apps.length) };
      list.push(policy); return envelope(policy);
    }
    if (path === "/apps") return envelope(apps);
    if (path.endsWith("/policies")) return envelope(policies.get(path.split("/")[2]) ?? []);
    throw new Error("Unexpected synthetic provider boundary");
  };
  const input = { firestore: db, packet, fetchImpl, readToken: async () => "synthetic-provider-token" };
  await installPrivatePairAccess(input);
  const receipt = { mode: "readback", ...await installPrivatePairAccess({ ...input, readback: true }) };
  expect(posts).toHaveLength(6);
  const root = "system/publicReleasePrivateInstalls";
  const queries = await Promise.all([`${root}/plans`, `${root}/workers`, `${root}/attempts/${packet.operationId}/steps`,
    `${root}/attempts/${packet.operationId}/readbacks`].map(path => db.collection(path).get()));
  expect(queries.map(row => row.size)).toEqual([1, 3, 6, 6]);
  const snapshots = queries.flatMap(row => row.docs), data = snapshots.map(row => ({ path: row.ref.path, data: row.data() }));
  return { proof: { schemaVersion: 1, packet, receipt }, data, snapshots, posts };
}
async function allDocuments() {
  const rows: { path: string; data: any }[] = [];
  async function visit(collection: any) {
    const result = await collection.get();
    for (const row of result.docs) {
      rows.push({ path: row.ref.path, data: row.data() });
      for (const nested of await row.ref.listCollections()) await visit(nested);
    }
    // Firestore does not return missing ancestor documents in a query.
    for (const ref of await collection.listDocuments()) if (!result.docs.some(row => row.ref.path === ref.path))
      for (const nested of await ref.listCollections()) await visit(nested);
  }
  for (const collection of await db.listCollections()) await visit(collection);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
beforeAll(async () => {
  process.env.CMS_DEPLOYMENT_ENVIRONMENT = "development";
  await clear();
  const pointer = { ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true, activeGeneration: 1,
    activeDeploymentId: "original-release", activeCommitSha: sha, lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "original-release" };
  await db.doc("system/publicDeployment").set(pointer);
  await db.doc("system/cmsPublicationRuntime").set(runtime);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  const code = publicReleaseBaselineCodeFixture(db, sha);
  const initializer = { schemaVersion: 1, operationId: "original-initializer", environment: "development", projectId: "njpbs-site-dev",
    oldRuntime: runtime, legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer),
    publicReceiptBytes: JSON.stringify(code.qualified.publication), deploymentId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222" };
  for (const step of ["runtime", "media-lifecycle"]) await db.doc(`system/devPublicPredecessor/initializations/${step}`).create({
    schemaVersion: 1, kind: `dev-public-predecessor-${step}`, request: initializer, requestDigest: protocol.publicReleaseDigest(initializer) });
  await pause.pauseDevPublicRelease({ firestore: db, attempt: { schemaVersion: 1, operationId: bootstrapId,
    environment: "development", projectId: "njpbs-site-dev", oldRuntime: runtime,
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) } });
  const priorPreview = { schemaVersion: 1, phase: "paused", rendererSha: "b".repeat(40), serializerId: "cloudflare-preview" };
  const image = "registry.cloudflare.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/template-dev-cms-preview-renderer@sha256:" + "c".repeat(64);
  const provider = { worker: "template-dev-cms-preview-renderer", rendererSha: priorPreview.rendererSha, serializerId: "cloudflare-preview",
    imageFingerprint: createHash("sha256").update(JSON.stringify({ image, digest: null })).digest("hex"),
    applicationId: "11111111-1111-4111-8111-111111111111", workerVersionId: "22222222-2222-4222-8222-222222222222",
    workerDeploymentId: "33333333-3333-4333-8333-333333333333" };
  const component = { schemaVersion: 1, environment: "development", projectId: "njpbs-site-dev", state: "complete",
    sourceSha: priorPreview.rendererSha, releaseStartedAt: "2026-11-01T12:00:00.000Z", provider };
  await db.doc(renderer.PREVIEW).set(priorPreview); await db.doc(renderer.COMPONENT).set(component);
  const observed = await renderer.inspectDevPreviewBootstrap({ firestore: db, rendererSha: sha });
  const attempt = { schemaVersion: 1, operationId: "dev-renderer-7", rendererSha: sha, operatorCommitSha: sha,
    provenance: { schemaVersion: 1, rendererSha: sha, operatorCommitSha: sha, rendererTree: sha, workerSourceDigest: "e".repeat(64) },
    bootstrapOperationId: bootstrapId, publicDigest: observed.publicDigest, startedAt: "2026-11-01T12:00:00.000Z",
    prior: { provider, image, preview: priorPreview, component } };
  const claimed = await renderer.claimDevPreviewBootstrap({ firestore: db, attempt });
  await renderer.finishDevPreviewBootstrap({ firestore: db, attemptDigest: claimed.attemptDigest,
    provider: { ...provider, rendererSha: sha, enabled: false, imageState: "configured", image, operationId: attempt.operationId } });
  const cutoff = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db });
  enrollmentRequest = { schemaVersion: 1, operationId: bootstrapId, logEpoch: "original-epoch", baselineDigest: "f".repeat(64), expected: cutoff.expected };
  await enrollment.enrollPublicReleaseChangeLog({ firestore: code.firestore, request: enrollmentRequest, currentCodeRequest: code.request, dryRun: false });
  // Additional native field types must survive archival without JSON coercion.
  await db.doc(renderer.ROOT).update({ preservedFields: { at: new Timestamp(1700000000, 123456789), bytes: Buffer.from([0, 255]),
    point: new GeoPoint(40.7, -74.1), reference: db.doc("cmsPages/example"), map: { constructor: { name: "Timestamp" }, timestamp: "ordinary map" }, array: [null, -0] } });
  retained = await allDocuments();
}, 20000);
beforeEach(async () => {
  await clear(); const batch = db.batch(); retained.forEach(row => batch.create(db.doc(row.path), row.data)); await batch.commit();
  request = await inspect();
});
afterAll(async () => { if (oldEnvironment === undefined) delete process.env.CMS_DEPLOYMENT_ENVIRONMENT;
  else process.env.CMS_DEPLOYMENT_ENVIRONMENT = oldEnvironment; await deleteApp(app); });

it("retains the actual original Access owner's complete history through retirement", async () => {
  const access = await originalAccess();
  const inspected = await owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess: access.proof });
  expect(inspected.retainedAccessDigest).toBe(protocol.publicReleaseDigest(access.proof));
  expect(JSON.stringify(inspected)).not.toContain("njpbs.org");
  expect(inspected).not.toHaveProperty("retainedAccess");
  const input = { firestore: db, request: inspected, retainedAccess: access.proof };
  expect(await owner.retireDevInactiveBootstrap({ ...input, dryRun: true })).toMatchObject({ dryRun: true, idempotent: false });
  expect(await owner.retireDevInactiveBootstrap({ ...input, dryRun: false })).toMatchObject({ committed: true, archiveVerified: true, preserved: true, legacyCodeCycleOpen: true });
  expect(await owner.readDevInactiveBootstrap(input)).toMatchObject({ archiveVerified: true, preserved: true, legacyCodeCycleOpen: true });
  const after = await db.getAll(...access.snapshots.map(row => row.ref));
  after.forEach((row, i) => { expect(row.data()).toEqual(access.snapshots[i].data());
    expect(row.createTime!.isEqual(access.snapshots[i].createTime!)).toBe(true); expect(row.updateTime!.isEqual(access.snapshots[i].updateTime!)).toBe(true); });
  expect((await owner.retireDevInactiveBootstrap({ ...input, dryRun: false })).idempotent).toBe(true);
  expect(access.posts).toHaveLength(6);
});

it("dry-runs the exact digest plan, archives all original bytes and removes only the named slots atomically", async () => {
  const before = await allDocuments(), dry = await apply(request, true);
  expect(dry).toMatchObject({ dryRun: true, idempotent: false, request, slots: owner.SLOTS });
  expect(await allDocuments()).toEqual(before);
  const result = await apply();
  expect(result).toMatchObject({ committed: true, archiveVerified: true, slotsAbsent: true, preserved: true, legacyCodeCycleOpen: true });
  const after = await allDocuments();
  expect(after.filter(row => !row.path.startsWith("system/devInactiveBootstraps/")))
    .toEqual(before.filter(row => !owner.SLOTS.includes(row.path)));
  const copies = after.filter(row => row.path.includes(`/retirements/${operationId}/documents/`));
  expect(copies).toHaveLength(owner.SLOTS.length);
  for (const copy of copies) expect(copy.data.data).toEqual(before.find(row => row.path === copy.data.metadata.path)!.data);
  expect(result.receipt.manifestDigest).toBe(protocol.publicReleaseDigest(result.receipt.documents));
  expect((await apply()).idempotent).toBe(true);
  expect(await allDocuments()).toEqual(after);
});
it.each(["njpbs-site", "demo-njpbs", "njpbs-site-dev-typo"])("refuses %s before any transaction", async projectId => {
  const firestore = { projectId, runTransaction: () => { throw new Error("Must not open a transaction"); } };
  for (const fn of [owner.inspectDevInactiveBootstrap, owner.retireDevInactiveBootstrap, owner.readDevInactiveBootstrap])
    await expect(fn({ firestore, operationId, request })).rejects.toThrow("Development inactive bootstrap retirement refused");
});
it.each(["system/publicReleaseChangeLog", "system/publicReleasePairs", "system/publicReleasePairUploads",
  "system/publicReleaseAdmissions", "system/publicReleaseAdmissions/controls/adoption", "system/publicReleasePrivateInstalls",
  "system/devPublication", "system/publicDeployment/pairMedia/current", "system/devPublicReleasePauseRecovery"])
  ("refuses any existing control or index at %s, even disabled or empty", async path => {
    await db.doc(path).create({ enabled: false }); await expect(apply()).rejects.toThrow();
    expect((await db.doc(owner.SLOTS[0]).get()).exists).toBe(true);
  });
it.each(owner.EMPTY)("refuses an orphan effect or operation in %s", async path => {
  await db.collection(path).doc("orphan").create({ status: "unknown" }); await expect(apply()).rejects.toThrow();
});
it.each(["system/publicReleasePairs/entries/absent/rollouts/publisher",
  "system/publicReleasePrivateInstalls/attempts/absent/steps/create-worker",
  "system/publicReleasePrivateInstalls/attempts/absent/readbacks/create-worker"])("refuses an orphan descendant at %s", async path => {
  await db.doc(path).create({ status: "uncertain" }); await expect(apply()).rejects.toThrow();
});
it.each(["operations/identity", "completions/pair"])("refuses orphan upload %s during inspection and apply", async suffix => {
  const path = `system/publicReleasePairs/entries/orphan/rollouts/upload/${suffix}`;
  await db.doc(path).create({ state: "uncertain" });
  await expect(inspect()).rejects.toThrow(); await expect(apply()).rejects.toThrow();
  expect((await db.doc(`${owner.ROOT}/${operationId}`).get()).exists).toBe(false);
});
it.each(["operations/identity", "completions/pair"])("detects orphan upload %s in original readback", async suffix => {
  await apply();
  await db.doc(`system/publicReleasePairs/entries/orphan/rollouts/upload/${suffix}`).create({ state: "uncertain" });
  expect(await read()).toMatchObject({ archiveVerified: true, slotsAbsent: true, legacyCodeCycleOpen: false });
});
it("keeps unrelated operation history outside the public upload prefix", async () => {
  await db.doc("system/devPublicationHistory/operations/retained").create({ status: "terminal" });
  const fresh = await inspect();
  expect(await apply(fresh)).toMatchObject({ archiveVerified: true, legacyCodeCycleOpen: true });
  expect((await db.doc("system/devPublicationHistory/operations/retained").get()).data()).toEqual({ status: "terminal" });
});
it.each(["pointer", "context", "runtime", "preview", "renderer-uncertain", "renderer-enabled", "fence", "drain", "head", "initializer", "preview-journal"])
  ("refuses %s drift without an archive or removal", async field => {
    if (field === "pointer") await db.doc("system/publicDeployment").update({ activeGeneration: 2 });
    if (field === "context") await db.doc("system/publicDeployment/contexts/public").update({ revision: 2 });
    if (field === "runtime") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "ready" });
    if (field === "preview") await db.doc(renderer.PREVIEW).update({ phase: "ready" });
    if (field === "renderer-uncertain") await db.doc(renderer.ROOT).update({ status: "failed" });
    if (field === "renderer-enabled") await db.doc(renderer.ROOT).update({ "receipt.provider.enabled": true });
    if (field === "fence") await db.doc("system/publicDeployment/releaseWriter/fence").update({ operationId: "foreign" });
    if (field === "drain") await db.doc(`system/devPublicReleasePause/drains/${bootstrapId}`).delete();
    if (field === "head") await db.doc("system/publicReleaseChanges").update({ sequence: 1 });
    if (field === "initializer") await db.doc("system/devPublicPredecessor/initializations/runtime").update({ requestDigest: "0".repeat(64) });
    if (field === "preview-journal") await db.doc("cmsPreviewSerializerJournals/cloudflare-preview").create({ schemaVersion: 1, serializerId: "cloudflare-preview", job: { status: "claimed" } });
    const stages: string[] = [];
    await expect(owner.inspectDevInactiveBootstrap({ firestore: db, operationId, stage: (value: string) => stages.push(value) })).rejects.toThrow();
    const expectedStage: Record<string, string> = {
      pointer: "inspect-pointer-guard", context: "inspect-context-guard", runtime: "inspect-predecessor-guard",
      preview: "inspect-renderer-guard", "renderer-uncertain": "inspect-renderer-guard", "renderer-enabled": "inspect-renderer-guard",
      fence: "inspect-fence-read", drain: "inspect-original-drain-read", head: "inspect-enrollment-guard",
      initializer: "inspect-predecessor-guard", "preview-journal": "inspect-preview-journal-guard",
    };
    expect(stages.at(-1)).toBe(expectedStage[field]);
    await expect(apply()).rejects.toThrow();
    expect((await db.doc(`${owner.ROOT}/${operationId}`).get()).exists).toBe(false);
  });
it.each(["inspect-archive-read", "inspect-state-read", "inspect-empty-collections-read", "inspect-empty-groups-read",
  "inspect-enrollment-read", "inspect-prior-attempts-read", "inspect-fence-read", "inspect-original-drain-read",
  "inspect-current-drain-read", "inspect-preview-journal-read", "inspect-preview-queues-read", "inspect-census-read"])
  ("preserves the exact SDK failure at %s without writes", async expected => {
    const originalError = new Error("PRIVATE SDK payload"), before = await allDocuments();
    let lastStage = "", readOnly = false;
    const firestore = new Proxy(db, { get(target, key) {
      if (key === "runTransaction") return (callback: any, options: any) => {
        readOnly = options?.readOnly === true;
        return target.runTransaction(tx => callback(new Proxy(tx, { get(transaction, method) {
          const value = Reflect.get(transaction, method);
          if (method === "get" || method === "getAll") return (...args: any[]) => {
            if (lastStage === expected) throw originalError;
            return value.apply(transaction, args);
          };
          return typeof value === "function" ? value.bind(transaction) : value;
        } })), options);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(owner.inspectDevInactiveBootstrap({ firestore, operationId, stage: (value: string) => { lastStage = value; } }))
      .rejects.toBe(originalError);
    expect(lastStage).toBe(expected); expect(readOnly).toBe(true);
    expect(await allDocuments()).toEqual(before);
  });
it("returns the unchanged request after all inspect diagnostics complete", async () => {
  const stages: string[] = [];
  const result = await owner.inspectDevInactiveBootstrap({ firestore: db, operationId, stage: (value: string) => stages.push(value) });
  expect(result).toEqual(request);
  expect(stages[0]).toBe("inspect-input-guard");
  expect(stages.at(-1)).toBe("inspect-transaction-complete");
  expect(stages).toEqual(expect.arrayContaining(["inspect-state-guard", "inspect-empty-collections-guard",
    "inspect-empty-groups-guard", "inspect-enrollment-guard", "inspect-initializer-runtime-guard",
    "inspect-preview-queues-guard", "inspect-census-guard", "inspect-renderer-guard", "inspect-observations-encode",
    "inspect-observations-guard", "inspect-request-size-guard"]));
});
it.each(["cmsPublishQueue", "system/publicDeployment/buildBatches", "cmsPreviewQueue"])("refuses live work in %s", async path => {
  await db.collection(path).doc("accepted").create({ status: "pending", claim: null }); await expect(apply()).rejects.toThrow();
});
it("accepts real ready, failed and expired previews with their retained native claims", async () => {
  const requestedAt = 1760000000000, expiresAtMs = requestedAt + 60000;
  for (const [index, status] of ["ready", "failed", "expired"].entries()) {
    const queueId = String(index + 1).repeat(20), claimToken = "22222222-2222-4222-8222-222222222222";
    const ref = db.doc(`cmsPreviewQueue/${queueId}`);
    await ref.create({ status: "pending", transport: "serializer", pageId: "contact", sourceVersion: 7, rendererSha: sha,
      requestedAt: Timestamp.fromMillis(requestedAt), expiresAt: Timestamp.fromMillis(expiresAtMs),
      completedAt: null, previewUrl: null, error: null, snapshot: { id: "contact", version: 7 }, assets: [] });
    await previewSerializer.claimCmsPreviewQueue({ firestore: db, queueId, rendererSha: sha, serializerId: "cloudflare-preview",
      claimToken, now: () => requestedAt + 1000 });
    await previewSerializer.finishCmsPreviewQueue({ firestore: db, deploymentEnvironment: "development", queueId, rendererSha: sha,
      serializerId: "cloudflare-preview", claimToken, pageId: "contact", sourceVersion: 7, expiresAtMs,
      status: status === "failed" ? "failed" : "ready", now: () => status === "expired" ? expiresAtMs + 1 : requestedAt + 2000 });
    expect((await ref.get()).data()).toMatchObject({ status, serializerClaim: { serializerId: "cloudflare-preview", rendererSha: sha } });
  }
  const before = (await db.collection("cmsPreviewQueue").get()).docs.map(row => row.data());
  const fresh = await inspect();
  expect(await apply(fresh)).toMatchObject({ archiveVerified: true, legacyCodeCycleOpen: true });
  expect((await db.collection("cmsPreviewQueue").get()).docs.map(row => row.data())).toEqual(before);
});
it.each(["success", "superseded", "cancelled", "building"])("refuses the unsupported or active preview status %s", async status => {
  await db.doc("cmsPreviewQueue/unknown").create({ status });
  await expect(inspect()).rejects.toThrow();
});
it("refuses malformed retained preview claims", async () => {
  await db.doc("cmsPreviewQueue/terminal").create({ status: "ready", serializerClaim: { invalid: true } });
  await expect(inspect()).rejects.toThrow();
});
it("refuses unchanged bytes rewritten after dry-run, and changed requests", async () => {
  const ref = db.doc(renderer.ROOT), before = (await ref.get()).data()!;
  // Firestore can keep the version on a no-op set. Make and undo an actual
  // change to prove that equal bytes at a different version still refuse.
  await ref.update({ temporary: true }); await ref.update({ temporary: FieldValue.delete() });
  expect((await ref.get()).data()).toEqual(before); await expect(apply()).rejects.toThrow();
  const fresh = await inspect();
  const changed = structuredClone(fresh); changed.observations[0].dataDigest = "0".repeat(64);
  await expect(apply(changed)).rejects.toThrow();
  expect((await db.doc(`${owner.ROOT}/${operationId}`).get()).exists).toBe(false);
});
it("permits the shipped fresh pre-enrollment inspection while retaining the original baseline and history", async () => {
  const originalBaseline = (await db.doc(`system/publicReleaseChanges/baselines/${enrollmentRequest.logEpoch}`).get()).data();
  await apply();
  // Native CODE publication and control initialization need their own GO. This
  // test only proves their fixed active-slot gates are available again.
  expect((await db.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
  expect((await db.doc("system/cmsPublicationRuntime").get()).exists).toBe(false);
  await db.doc("system/cmsPublicationRuntime").create({ ...runtime, phase: "paused", cloud: { ...runtime.cloud, phase: "paused" } });
  const cutoff = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db });
  expect(cutoff.expected.liveReleaseSha).toBe(sha);
  expect((await db.doc(`system/publicReleaseChanges/baselines/${enrollmentRequest.logEpoch}`).get()).data()).toEqual(originalBaseline);
  expect((await read()).legacyCodeCycleOpen).toBe(false);
  expect((await apply()).idempotent).toBe(true);
  expect((await db.doc("system/cmsPublicationRuntime").get()).exists).toBe(true); // Never delete successor controls on replay.
});
it("keeps original readback after later progress and refuses a rewritten archive", async () => {
  await apply(); await db.doc("system/publicDeployment/contexts/public").update({ revision: 2 });
  expect(await read()).toMatchObject({ committed: true, archiveVerified: true, preserved: false, legacyCodeCycleOpen: false });
  const copy = (await db.collection(`${owner.ROOT}/${operationId}/documents`).get()).docs[0];
  await copy.ref.update({ "data.tampered": true }); await expect(read()).rejects.toThrow();
});
it("does not remove active slots in a partial archive state", async () => {
  await db.doc(`${owner.ROOT}/${operationId}/documents/orphan`).create({ original: "partial" });
  const before = await allDocuments();
  await expect(apply(request, true)).rejects.toThrow(); await expect(apply()).rejects.toThrow();
  expect(await allDocuments()).toEqual(before);
});
it("does not call a later-added terminal queue an exact original readback", async () => {
  await apply(); await db.doc("cmsPublishQueue/later").create({ status: "success", claim: null });
  expect(await read()).toMatchObject({ archiveVerified: true, legacyCodeCycleOpen: false });
});
it("serializes simultaneous identical applies into one original archive", async () => {
  const results = await Promise.all([apply(), apply()]);
  expect(results.filter(row => row.idempotent)).toHaveLength(1);
  expect(results[0].receipt).toEqual(results[1].receipt);
  expect((await db.collection(owner.ROOT).get()).size).toBe(1);
});
it("refuses a competing retirement request after one winner", async () => {
  const other = await inspect("another-retirement"); await apply();
  await expect(apply(other)).rejects.toThrow();
  expect((await db.collection(owner.ROOT).get()).size).toBe(1);
});
it("validates development-only operator packets and exact frozen requests without credentials", () => {
  const packet = { schemaVersion: 1, kind: "dev-inactive-bootstrap-operator", environment: "development", projectId: "njpbs-site-dev",
    operationId, operatorCommitSha: sha, credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com",
      privateKeyId: "a".repeat(40), secretRef: "pass://claude/fixture" }, request };
  expect(parseDevInactiveBootstrapPacket(packet)).toEqual(packet);
  expect(parseDevInactiveBootstrapPacket({ ...packet, request: null }, true).request).toBe(null);
  expect(() => parseDevInactiveBootstrapPacket({ ...packet, projectId: "njpbs-site" })).toThrow();
  expect(() => parseDevInactiveBootstrapPacket({ ...packet, request: { ...request, projectId: "njpbs-site" } })).toThrow();
  expect(() => parseDevInactiveBootstrapPacket({ ...packet, operationId: "another" })).toThrow();
});
it("uses the configured writer and refuses missing or mismatched identities", () => {
  const prior = process.env.CMS_DEV_SDK_CLIENT_EMAIL;
  const packet = { schemaVersion: 1, kind: "dev-inactive-bootstrap-operator", environment: "development", projectId: "njpbs-site-dev",
    operationId, operatorCommitSha: sha, credentialIdentity: { projectId: "njpbs-site-dev",
      clientEmail: "configured-writer@njpbs-site-dev.iam.gserviceaccount.com", privateKeyId: "a".repeat(40), secretRef: "pass://claude/fixture" }, request: null };
  try {
    process.env.CMS_DEV_SDK_CLIENT_EMAIL = packet.credentialIdentity.clientEmail;
    expect(parseDevInactiveBootstrapPacket(packet, true)).toEqual(packet);
    process.env.CMS_DEV_SDK_CLIENT_EMAIL = "other-writer@njpbs-site-dev.iam.gserviceaccount.com";
    expect(() => parseDevInactiveBootstrapPacket(packet, true)).toThrow();
    delete process.env.CMS_DEV_SDK_CLIENT_EMAIL;
    expect(() => parseDevInactiveBootstrapPacket(packet, true)).toThrow("Configure CMS_DEV_SDK_CLIENT_EMAIL");
  } finally {
    if (prior === undefined) delete process.env.CMS_DEV_SDK_CLIENT_EMAIL;
    else process.env.CMS_DEV_SDK_CLIENT_EMAIL = prior;
  }
});
it("runs the actual protected CLI offline plan and refuses production, tamper and absent fd3", () => {
  const dir = mkdtempSync(join(tmpdir(), "inactive-bootstrap-cli-"));
  const packet = { schemaVersion: 1, kind: "dev-inactive-bootstrap-operator", environment: "development", projectId: "njpbs-site-dev", operationId,
    operatorCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "configured-writer@njpbs-site-dev.iam.gserviceaccount.com",
      privateKeyId: "a".repeat(40), secretRef: "pass://claude/fixture" }, request };
  const run = (value: any, flags: string[] = [], writerEmail = packet.credentialIdentity.clientEmail) => {
    const bytes = JSON.stringify(value), file = join(dir, "packet.json"); writeFileSync(file, bytes);
    return spawnSync(process.execPath, ["scripts/retire-dev-inactive-bootstrap.mjs", "--packet", file,
      "--packet-digest", createHash("sha256").update(bytes).digest("hex"), ...flags], { env: { PATH: process.env.PATH,
        ...(writerEmail ? { CMS_DEV_SDK_CLIENT_EMAIL: writerEmail } : {}) }, encoding: "utf8", timeout: 7000 });
  };
  try {
    const planned = run(packet); expect(planned.status, planned.stderr).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({ mode: "plan", request, authorityReads: 0, authorityWrites: 0, providerWrites: 0 });
    expect(run(packet, [], "").status).toBe(1);
    expect(run(packet, [], "other-writer@njpbs-site-dev.iam.gserviceaccount.com").status).toBe(1);
    const refused = run({ ...packet, projectId: "njpbs-site" }, ["--apply"]);
    expect(refused.status).toBe(1); expect(refused.stdout).toBe("");
    expect(refused.stderr).toMatch(/^Development inactive bootstrap retirement was not confirmed;/);
    expect(run({ ...packet, operatorCommitSha: "0".repeat(40) }, ["--apply"]).status).toBe(1);
    expect(run(packet, ["--apply"]).status).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps the original strict empty requirement without an explicit retained proof", async () => {
  const access = await originalAccess();
  await expect(inspect()).rejects.toThrow();
  expect((await db.doc(owner.SLOTS[0]).get()).exists).toBe(true); expect(access.posts).toHaveLength(6);
});
it.each(["plans", "workers", "steps", "readbacks"])("refuses missing retained Access %s", async kind => {
  const access = await originalAccess(), row = access.data.find(row => row.path.includes(`/${kind}/`))!;
  await db.doc(row.path).delete();
  await expect(owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess: access.proof })).rejects.toThrow();
  expect((await db.doc(`${owner.ROOT}/${operationId}`).get()).exists).toBe(false);
});
it.each(["plans", "workers", "steps", "readbacks"])("refuses changed retained Access %s", async kind => {
  const access = await originalAccess(), row = access.data.find(row => row.path.includes(`/${kind}/`))!;
  await db.doc(row.path).update({ unexpected: true });
  await expect(owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess: access.proof })).rejects.toThrow();
  expect(access.posts).toHaveLength(6);
});
it.each([
  "system/publicReleasePrivateInstalls/plans/foreign", "system/publicReleasePrivateInstalls/workers/foreign",
  "system/publicReleasePrivateInstalls/attempts/foreign/steps/worker", "system/publicReleasePrivateInstalls/attempts/foreign/readbacks/worker",
  "system/publicReleasePairs/entries/orphan/rollouts/publisher",
  "system/publicReleasePairs/entries/orphan/rollouts/upload/operations/identity",
  "system/publicReleasePairs/entries/orphan/rollouts/upload/completions/pair",
])("never extends retained Access to another install effect at %s", async path => {
  const access = await originalAccess(); await db.doc(path).create({ status: "uncertain" });
  await expect(owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess: access.proof })).rejects.toThrow();
  expect((await db.doc(owner.SLOTS[0]).get()).exists).toBe(true);
});
it("distinguishes per-target Access seals from the whole-packet plan digest and not-sent claims", async () => {
  const access = await originalAccess(), worker = access.data.find(row => row.path.includes("/workers/"))!;
  await db.doc(worker.path).update({ planDigest: access.proof.receipt.packetDigest });
  await expect(owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess: access.proof })).rejects.toThrow();
  await db.doc(worker.path).set(worker.data);
  const step = access.data.find(row => row.path.includes("/steps/"))!;
  await db.doc(step.path).update({ notSent: true });
  await expect(owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess: access.proof })).rejects.toThrow();
});
it("refuses partial or uncertain original Access readback before opening a transaction", async () => {
  const access = await originalAccess(), firestore = { projectId: "njpbs-site-dev", runTransaction: () => { throw new Error("Unexpected transaction"); } };
  for (const change of ["partial", "unclaimed", "not-sent", "foreign-project"]) {
    const proof = structuredClone(access.proof);
    if (change === "partial") proof.receipt.targets[0].policy = null as any;
    if (change === "unclaimed") (proof.receipt.targets[0] as any).policyUnclaimed = true;
    if (change === "not-sent") (proof.receipt.targets[0] as any).policyNotSent = true;
    if (change === "foreign-project") proof.packet.environment = "production";
    await expect(owner.inspectDevInactiveBootstrap({ firestore, operationId, retainedAccess: proof })).rejects.not.toThrow("Unexpected transaction");
  }
});
it("freezes Access native versions even if changed data is restored before apply", async () => {
  const access = await originalAccess(), retainedAccess = access.proof;
  const frozen = await owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess });
  const ref = access.snapshots[0].ref; await ref.update({ temporary: true }); await ref.update({ temporary: FieldValue.delete() });
  const changed = await ref.get(); expect(changed.data()).toEqual(access.snapshots[0].data());
  expect(changed.updateTime!.isEqual(access.snapshots[0].updateTime!)).toBe(false);
  await expect(owner.retireDevInactiveBootstrap({ firestore: db, request: frozen, retainedAccess, dryRun: false })).rejects.toThrow();
  expect((await db.doc(`${owner.ROOT}/${operationId}`).get()).exists).toBe(false);
});
it("requires the same explicit Access proof and all sixteen frozen observations", async () => {
  const access = await originalAccess(), retainedAccess = access.proof;
  const frozen = await owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess });
  await expect(owner.retireDevInactiveBootstrap({ firestore: db, request: frozen, dryRun: false })).rejects.toThrow();
  const changed = structuredClone(frozen); changed.retainedAccessDigest = "e".repeat(64);
  await expect(owner.retireDevInactiveBootstrap({ firestore: db, request: changed, retainedAccess, dryRun: false })).rejects.toThrow();
  const missing = structuredClone(frozen); missing.observations = missing.observations.filter(row => row.path !== access.data[0].path);
  await expect(owner.retireDevInactiveBootstrap({ firestore: db, request: missing, retainedAccess, dryRun: false })).rejects.toThrow();
  expect((await db.doc(owner.SLOTS[0]).get()).exists).toBe(true);
});
it.each(["new-effect", "changed-version"])("retained Access readback detects %s while conserving the original archive", async mode => {
  const access = await originalAccess(), retainedAccess = access.proof;
  const frozen = await owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess });
  const input = { firestore: db, request: frozen, retainedAccess };
  await owner.retireDevInactiveBootstrap({ ...input, dryRun: false });
  if (mode === "new-effect") await db.doc("system/publicReleasePrivateInstalls/attempts/foreign/steps/worker").create({ state: "uncertain" });
  else { const ref = access.snapshots[0].ref; await ref.update({ temporary: true }); await ref.update({ temporary: FieldValue.delete() }); }
  expect(await owner.readDevInactiveBootstrap(input)).toMatchObject({ committed: true, archiveVerified: true, legacyCodeCycleOpen: false });
  expect((await db.collection(`${owner.ROOT}/${operationId}/documents`).get()).size).toBe(7);
});
it("concurrent retained Access applies converge without changing original ownership", async () => {
  const access = await originalAccess(), retainedAccess = access.proof;
  const frozen = await owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess });
  const input = { firestore: db, request: frozen, retainedAccess, dryRun: false };
  const results = await Promise.all([owner.retireDevInactiveBootstrap(input), owner.retireDevInactiveBootstrap(input)]);
  expect(results.map(row => row.idempotent).sort()).toEqual([false, true]);
  const after = await db.getAll(...access.snapshots.map(row => row.ref));
  after.forEach((row, i) => { expect(row.data()).toEqual(access.snapshots[i].data()); expect(row.updateTime!.isEqual(access.snapshots[i].updateTime!)).toBe(true); });
  expect(access.posts).toHaveLength(6);
});
it("actual CLI plans the retained proof offline without emitting its private origins", async () => {
  const access = await originalAccess(), retainedAccess = access.proof;
  const frozen = await owner.inspectDevInactiveBootstrap({ firestore: db, operationId, retainedAccess });
  const dir = mkdtempSync(join(tmpdir(), "retained-access-cli-"));
  try {
    const clientEmail = "retained-access-writer@njpbs-site-dev.iam.gserviceaccount.com";
    const packet = { schemaVersion: 1, kind: "dev-inactive-bootstrap-operator", environment: "development", projectId: "njpbs-site-dev",
      operationId, operatorCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      credentialIdentity: { projectId: "njpbs-site-dev", clientEmail, privateKeyId: "c".repeat(40), secretRef: "pass://fixture/dev" },
      request: frozen, retainedAccess };
    const bytes = JSON.stringify(packet), filename = join(dir, "packet.json"); writeFileSync(filename, bytes);
    const planned = spawnSync(process.execPath, ["scripts/retire-dev-inactive-bootstrap.mjs", "--packet", filename, "--packet-digest", createHash("sha256").update(bytes).digest("hex")],
      { env: { PATH: process.env.PATH, ...repositoryFixture,
        CLOUDFLARE_ACCOUNT_ID: retainedAccess.packet.accountId,
        CMS_DEV_SDK_CLIENT_EMAIL: clientEmail }, encoding: "utf8", timeout: 5000 });
    expect(planned.status, planned.stderr).toBe(0);
    expect(JSON.parse(planned.stdout)).toMatchObject({ mode: "plan", authorityReads: 0, authorityWrites: 0, request: { retainedAccessDigest: protocol.publicReleaseDigest(retainedAccess) } });
    expect(planned.stdout).not.toContain("njpbs.org"); expect(planned.stdout).not.toContain("credentialIdentity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
