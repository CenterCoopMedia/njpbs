import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import history from "../../functions/lib/dev-publication-history.js";
import owner from "../../scripts/lib/dev-publication-history.cjs";
import pause from "../../functions/lib/dev-public-release-pause.js";
import { Timestamp } from "firebase-admin/firestore";
import { parseDevPublicationHistoryPacket } from "../../scripts/lib/dev-publication-history-operator.mjs";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import coordinator from "../../functions/lib/public-deployment-coordinator.js";
import manifests from "../../functions/lib/public-media-manifest.js";
import manifestStore from "../../functions/lib/public-media-manifest-store.js";
import candidateStore from "../../functions/lib/public-worker-candidate-store.js";
import candidates from "../../functions/lib/public-worker-candidate.js";
import outcomes from "../../functions/lib/public-deployment-outcome-store.js";
import targets from "../../functions/lib/publication-target.js";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "dev-publication-history-test");
const db = getFirestore(app), target = targets.publicationTarget("development");
const sha = "a85fe93e24f2c3f4664816d3c08311f20c804667", runtime = { owner: "cloudflare", release: sha };
const oldRuntime = { schemaVersion: 1, phase: "ready", commitSha: sha, serializerId: "original-dev-primary",
  cloud: { phase: "ready", commitSha: sha, serializerId: "cloudflare-dev-publisher" } };
const buildBatchId = "original-dev-baseline", batchPath = `system/publicDeployment/buildBatches/${buildBatchId}`;
const deploymentId = "33333333-3333-4333-8333-333333333333", versionId = "22222222-2222-4222-8222-222222222222";
const source = "f".repeat(40);
let retained: any, request: any;
const apply = (value = request) => owner.operate({ firestore: db, request: value, operatorCommitSha: source });
const read = (value = request) => owner.operate({ firestore: db, request: value, operatorCommitSha: source, readOnly: true });
const clear = () => clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, db);
afterAll(() => deleteApp(app));
beforeAll(async () => {
  await clear();
  // The predecessor is produced by the real reservation/manifest/candidate/
  // activation owners; the initializer cannot manufacture a deployed baseline.
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), lastReservedGeneration: 124 });
  const { batch } = await coordinator.reservePublicBuildBatch({ firestore: db, buildBatchId, commitSha: sha, runtime, target });
  const inventory = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], posts: [], programs: [], authors: [], settings: [] });
  const manifest = manifests.createPublicMediaManifest({ reservation: batch,
    artifactInventory: inventory.families.map(f => ({ collection: f.collection, complete: true, documentIds: f.artifacts.map(a => a.documentId) })), owners: inventory.owners });
  await manifestStore.stagePublicMediaManifest({ firestore: db, manifest });
  await manifestStore.markPublicMediaManifestReady({ firestore: db, manifest });
  const publicReceiptBytes = JSON.stringify({ schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId, generation: batch.generation,
    commitSha: sha, artifactDigest: "b".repeat(64), artifactReceiptDigest: "c".repeat(64), mediaManifestDigest: manifest.mediaManifestDigest }) + "\n";
  await candidateStore.recordPublicWorkerCandidate({ firestore: db, runtime, target, candidate: {
    schemaVersion: 1, runtime, buildBatchId, generation: batch.generation, commitSha: sha, workerName: "template-dev-public",
    workerVersionId: versionId, workerVersionTag: candidates.publicWorkerCandidateTag({ generation: batch.generation, artifactDigest: "b".repeat(64) }),
    versionCreatedOn: "2026-11-01T12:00:00.000Z", artifactDigest: "b".repeat(64), artifactReceiptDigest: "c".repeat(64),
    publicationReceiptDigest: createHash("sha256").update(publicReceiptBytes).digest("hex"), mediaManifestDigest: manifest.mediaManifestDigest,
    artifactFileCount: 2, artifactBytes: 1000, wranglerVersion: "4.123.0" } });
  const acquisition = await coordinator.acquirePublicDeploymentLease({ firestore: db, buildBatchId, commitSha: sha, runtime, target });
  expect(acquisition.outcome).toBe("acquired");
  await outcomes.settlePublicDeploymentOutcome({ firestore: db, lease: acquisition.lease, runtime, target,
    evidence: { action: "activate", buildBatchId, deploymentId, versionId, commitSha: sha } });
  await db.doc("system/publicDeployment").update({ mediaLifecycleReady: true });
  await db.doc("system/cmsPublicationRuntime").set(oldRuntime);
  const activePointer = (await db.doc("system/publicDeployment").get()).data();
  for (let i = 1; i <= 10; i++) {
    const queueId = String(i).padStart(20, "0"), id = `cms-${queueId}`, commit = String(i % 9 + 1).repeat(40);
    const batch = { schemaVersion: 1, buildBatchId: id, generation: i, status: "reserved", commitSha: commit,
      reservedAgainstGeneration: 0, reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null,
      cutoffAt: Timestamp.fromMillis(1000), reservedAt: Timestamp.fromMillis(1000),
      ...(i === 3 ? { runtime: { owner: "node-compute", release: commit } } : i > 3 ? { runtime: { owner: "cloudflare", release: commit } } : {}) };
    await db.doc(`system/publicDeployment/buildBatches/${id}`).set(batch);
    await db.doc(`cmsPublishQueue/${queueId}`).set({ status: "failed", transport: "github", environment: "development", projectId: "njpbs-site-dev",
      changes: [], completedAt: Timestamp.fromMillis(3000), error: "original historical failure", ...batch.runtime && { runtime: batch.runtime },
      artifactBuild: { buildBatchId: id, generation: i, commitSha: commit },
      ...(i <= 3 ? { serializerClaim: { buildBatchId: id, claimToken: "immutable-original-terminal-evidence" } } : {}) });
    if (i > 3) await db.doc(`system/publicDeployment/buildBatches/${id}/inputs/devFrozen`).set({ schemaVersion: 1, queueId,
      buildBatchId: id, commitSha: commit, inputDigest: "e".repeat(64), recordedAt: Timestamp.fromMillis(1100) });
    if (i === 4) {
      await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), lastReservedGeneration: 125, newestEligibleGeneration: 4, newestEligibleBuildBatchId: id });
      const inventory = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], posts: [], programs: [], authors: [], settings: [] });
      const manifest = manifests.createPublicMediaManifest({ reservation: batch,
        artifactInventory: inventory.families.map(f => ({ collection: f.collection, complete: true, documentIds: f.collection === "cmsPages" ? ["historical-page"] : [] })),
        owners: [{ collection: "cmsPages", documentId: "historical-page", sourceVersion: 1, assetIds: [], occurrenceCount: 0 }] });
      await manifestStore.stagePublicMediaManifest({ firestore: db, manifest });
      await manifestStore.markPublicMediaManifestReady({ firestore: db, manifest });
      await candidateStore.recordPublicWorkerCandidate({ firestore: db, runtime: batch.runtime, target, candidate: {
        schemaVersion: 1, runtime: batch.runtime, buildBatchId: id, generation: i, commitSha: commit, workerName: "template-dev-public",
        workerVersionId: versionId, workerVersionTag: candidates.publicWorkerCandidateTag({ generation: i, artifactDigest: "b".repeat(64) }),
        versionCreatedOn: "2026-11-01T12:00:00.000Z", artifactDigest: "b".repeat(64), artifactReceiptDigest: "c".repeat(64),
        publicationReceiptDigest: "d".repeat(64), mediaManifestDigest: manifest.mediaManifestDigest,
        artifactFileCount: 2, artifactBytes: 1000, wranglerVersion: "4.123.0" } });
    }
  }
  await db.doc("system/publicDeployment").set(activePointer!);
  // Native terminal refresh carries the next ordinary poll, including while
  // idle/ready. Both 08c and the actual 09 drain must accept this settled row.
  await db.doc("system/publicDeployment/externalRefresh/current").set({ schemaVersion: 1, status: "verified", claim: null,
    runtime, operationId: "E".repeat(20), nextAttemptAt: Date.now() + 1_800_000 });
  retained = await snapshot();
  const activeBatch = (await db.doc(batchPath).get()).data(), activeCandidate = (await db.doc(`${batchPath}/candidates/worker`).get()).data();
  request = { schemaVersion: 1, operationId: "original-dev-history", environment: "development", projectId: "njpbs-site-dev",
    active: { buildBatchId, generation: 125, commitSha: sha, deploymentId, versionId, publicReceiptBytes,
      pointerDigest: history.digest((await db.doc("system/publicDeployment").get()).data()), batchDigest: history.digest(activeBatch),
      candidateDigest: history.digest(activeCandidate), runtimeDigest: history.digest(oldRuntime) }, rows: [],
    queuesDigest: await collectionDigest("cmsPublishQueue"), batchesDigest: await collectionDigest("system/publicDeployment/buildBatches") };
  for (let i = 1; i <= 10; i++) {
    const queueId = String(i).padStart(20, "0"), id = `cms-${queueId}`, root = `system/publicDeployment/buildBatches/${id}`;
    request.rows.push({ buildBatchId: id, queueId, generation: i, status: i === 4 ? "ready" : "reserved", owner: i <= 3 ? "node-compute" : "cloudflare",
      batchDigest: history.digest((await db.doc(root).get()).data()), queueDigest: history.digest((await db.doc(`cmsPublishQueue/${queueId}`).get()).data()),
      inputsDigest: await collectionDigest(`${root}/inputs`), candidatesDigest: await collectionDigest(`${root}/candidates`),
      manifestsDigest: await collectionDigest(`${root}/manifests`), verificationsDigest: await collectionDigest(`${root}/manifests/publicMedia/verifications`), chunksDigest: await collectionDigest(`${root}/manifests/publicMedia/chunks`) });
  }
});
async function collectionDigest(path: string) { return history.digest(owner.dataRows((await db.collection(path).get()).docs)); }
async function snapshot() {
  const result: any[] = [];
  async function visit(collection: any) {
    for (const doc of (await collection.get()).docs) {
      result.push({ path: doc.ref.path, data: doc.data() });
      for (const sub of await doc.ref.listCollections()) await visit(sub);
    }
  }
  for (const root of await db.listCollections()) await visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
beforeEach(async () => {
  await clear();
  const batch = db.batch(); retained.forEach((row: any) => batch.create(db.doc(row.path), row.data)); await batch.commit();
});
it("terminalizes the mixed retained set, preserves every other byte, and reads the exact original on retries", async () => {
  const before = await snapshot();
  await expect(pause.pauseDevPublicRelease({ firestore: db, attempt: pauseAttempt() })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
  const result = await apply();
  expect(result).toMatchObject({ committed: true, conservationVerified: true });
  const after = await snapshot(), changed = new Set(request.rows.map((r: any) => `system/publicDeployment/buildBatches/${r.buildBatchId}`));
  expect(after.filter((r: any) => before.some((b: any) => b.path === r.path) && !changed.has(r.path)))
    .toEqual(before.filter((r: any) => !changed.has(r.path)));
  for (const row of request.rows) {
    const batch = (await db.doc(`system/publicDeployment/buildBatches/${row.buildBatchId}`).get()).data();
    if (row.status === "reserved") {
      expect(batch).toMatchObject({ status: "retired", retirementReceipt: { reason: history.REASON, original: row,
        reservation: { buildBatchId: row.buildBatchId, generation: row.generation, owner: row.owner }, active: request.active } });
      expect(() => history.assertDevHistoricalRetiredBatch(batch, row.buildBatchId)).not.toThrow();
      expect(() => deployment.assertPublicDeploymentRetiredBatch(batch, row.buildBatchId)).toThrow();
    } else {
      expect(batch).toMatchObject({ status: "superseded", supersededReason: "newer_eligible_generation", supersededByGeneration: 125,
        supersededByBuildBatchId: request.active.buildBatchId });
    }
  }
  expect(await read()).toEqual(result); expect(await apply()).toEqual(result); expect(await snapshot()).toEqual(after);
  expect((await db.collection("admin_logs").get()).docs.filter(d => d.data().action === "public-release.dev-historical-terminalization")).toHaveLength(1);
  expect(await pause.pauseDevPublicRelease({ firestore: db, attempt: pauseAttempt() })).toMatchObject({ pauseCommitted: true, drainCommitted: true });
});
function pauseAttempt() {
  return { schemaVersion: 1, operationId: "after-history-pause", environment: "development", projectId: "njpbs-site-dev", oldRuntime,
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest(retained.find((r: any) => r.path === "system/publicDeployment").data) };
}
it.each(["pointer", "active-batch", "active-candidate", "runtime", "queue", "input", "candidate", "batch", "new-queue", "new-batch",
  "claim", "retry", "chunk", "verification", "writer", "journal", "later", "unexpected-candidate", "unknown-owner", "current", "future"])("refuses changed %s atomically", async field => {
  const row = request.rows[3], root = `system/publicDeployment/buildBatches/${row.buildBatchId}`;
  if (field === "pointer") await db.doc("system/publicDeployment").update({ mediaLifecycleReady: false });
  if (field === "active-batch") await db.doc(batchPath).update({ deploymentVersionId: deploymentId });
  if (field === "active-candidate") await db.doc(`${batchPath}/candidates/worker`).update({ artifactBytes: 1001 });
  if (field === "runtime") await db.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
  if (field === "queue") await db.doc(`cmsPublishQueue/${row.queueId}`).update({ error: "changed" });
  if (field === "input") await db.doc(`${root}/inputs/devFrozen`).update({ inputDigest: "0".repeat(64) });
  if (field === "candidate") await db.doc(`${root}/candidates/worker`).update({ workerVersionId: deploymentId });
  if (field === "batch") await db.doc(root).update({ reservedAt: Timestamp.fromMillis(1001) });
  if (field === "new-queue") await db.doc("cmsPublishQueue/unknown").set({ status: "pending" });
  if (field === "new-batch") await db.doc("system/publicDeployment/buildBatches/unknown").set({ status: "reserved" });
  if (field === "claim") await db.doc(`cmsPublishQueue/${row.queueId}`).update({ claim: "live" });
  if (field === "retry") await db.doc(`cmsPublishQueue/${row.queueId}`).update({ nextAttemptAt: 123 });
  if (field === "chunk") await db.doc(`${root}/manifests/publicMedia/chunks/000000`).update({ chunkDigest: "0".repeat(64) });
  if (field === "verification") await db.doc(`${root}/manifests/publicMedia/verifications/complete`).update({ ownerCount: 100 });
  if (field === "writer") await db.doc("system/publicDeployment/releaseWriter/fence").set({ operationId: "live" });
  if (field === "journal") await db.doc("cmsPublicationSerializerJournals/original-dev-primary").set({ job: { claim: "live" } });
  if (field === "later") await db.doc("system/publicReleaseChanges").set({ schemaVersion: 2 });
  if (field === "unexpected-candidate") await db.doc(`system/publicDeployment/buildBatches/${request.rows[0].buildBatchId}/candidates/worker`).set({ uploaded: true });
  if (field === "unknown-owner") await db.doc(root).update({ runtime: { owner: "unknown", release: "a".repeat(40) } });
  if (field === "current" || field === "future") await db.doc(root).update({ generation: field === "current" ? 125 : 126 });
  const before = await snapshot(); await expect(apply()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it.each(["receipt", "audit", "queue", "input", "batch", "candidate", "pointer", "request", "source"])("refuses altered original %s readback", async field => {
  await apply(); const row = request.rows[3], root = `system/publicDeployment/buildBatches/${row.buildBatchId}`;
  if (field === "receipt") await db.doc(`${owner.RECEIPTS}/${request.operationId}`).update({ planDigest: "0".repeat(64) });
  if (field === "audit") await db.doc(`admin_logs/dev-history-${request.operationId}`).update({ action: "changed" });
  if (field === "queue") await db.doc(`cmsPublishQueue/${row.queueId}`).update({ error: "changed" });
  if (field === "input") await db.doc(`${root}/inputs/devFrozen`).update({ inputDigest: "0".repeat(64) });
  if (field === "batch") await db.doc(root).update({ supersededByGeneration: 124 });
  if (field === "candidate") await db.doc(`${root}/candidates/worker`).update({ artifactBytes: 10 });
  if (field === "pointer") await db.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
  const changed = structuredClone(request); if (field === "request") changed.operationId += "-other";
  const before = await snapshot();
  await expect(owner.operate({ firestore: db, request: changed, operatorCommitSha: field === "source" ? "e".repeat(40) : source, readOnly: true })).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
it.each(["production", "database", "active", "rows", "duplicate", "ready-count"])("refuses invalid %s packet or target", async field => {
  const changed = structuredClone(request);
  if (field === "production") changed.environment = "production";
  if (field === "active") changed.active.generation = 126;
  if (field === "rows") changed.rows.pop();
  if (field === "duplicate") changed.rows[1] = changed.rows[0];
  if (field === "ready-count") changed.rows[0].status = "ready";
  await expect(owner.operate({ firestore: field === "database" ? { projectId: "njpbs-site" } : db, request: changed, operatorCommitSha: source })).rejects.toThrow();
});
it("will never acquire even if a packet is rehashed to select current ready work", async () => {
  const row = request.rows[3], changed = structuredClone(request);
  changed.rows[3].generation = 125;
  await expect(apply(changed)).rejects.toThrow();
  expect(deployment.planPublicDeploymentLeaseAcquisition({ ...retained.find((r: any) => r.path === "system/publicDeployment").data,
    activeGeneration: 0, mediaLifecycleReady: false, activeCommitSha: null, activeDeploymentId: null, newestEligibleGeneration: 4, newestEligibleBuildBatchId: row.buildBatchId },
    (await db.doc(`system/publicDeployment/buildBatches/${row.buildBatchId}`).get()).data()).action).toBe("acquire");
});
it("refuses source-pinned CLI tamper, wrong target and missing fd3", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-history-cli-")), env = { ...process.env };
  for (const key of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "FIREBASE_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS"]) delete env[key];
  const packet: any = { schemaVersion: 1, kind: "dev-publication-history-operator", operatorCommitSha:
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), credentialIdentity: { projectId: "njpbs-site-dev",
      clientEmail: "dev-seed-writer@njpbs-site-dev.iam.gserviceaccount.com", privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev" }, request };
  const run = (value: any, extra: string[] = []) => {
    const bytes = JSON.stringify(value), file = join(dir, "packet.json"); writeFileSync(file, bytes);
    return spawnSync(process.execPath, ["scripts/terminalize-dev-publication-history.mjs", "--packet", file,
      "--packet-digest", createHash("sha256").update(bytes).digest("hex"), ...extra], { env, encoding: "utf8" });
  };
  try {
    expect(parseDevPublicationHistoryPacket(packet)).toEqual(packet);
    const result = run(packet); expect(result.status).toBe(1); expect(result.stdout).toBe(""); // No inherited SDK pipe.

    expect(run({ ...packet, operatorCommitSha: source }, ["--apply"]).status).toBe(1);
    const wrong = structuredClone(packet); wrong.request.projectId = "njpbs-site";
    expect(run(wrong, ["--apply"]).status).toBe(1); expect(run(packet, ["--apply"]).status).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("collects a hash-only guarded plan from fixed original identities and requires its reviewed finalized request", async () => {
  const seed = structuredClone(request);
  seed.queuesDigest = seed.batchesDigest = null;
  for (const key of ["pointerDigest", "batchDigest", "candidateDigest", "runtimeDigest"]) seed.active[key] = null;
  for (const row of seed.rows) for (const key of ["inputsDigest", "candidatesDigest", "manifestsDigest", "verificationsDigest", "chunksDigest"]) row[key] = null;
  const before = await snapshot();
  const plan = await owner.plan({ firestore: db, request: seed, operatorCommitSha: source });
  expect(plan.plannedRequest).toEqual(request); expect(plan.authorityWrites).toBe(0);
  expect(plan.plan.rows.map((row: any) => row.action)).toEqual(request.rows.map((row: any) => row.status === "ready" ? "supersede" : "retire"));
  expect(await snapshot()).toEqual(before); await expect(apply(seed)).rejects.toThrow();
  seed.rows[0].batchDigest = "0".repeat(64);
  await expect(owner.plan({ firestore: db, request: seed, operatorCommitSha: source })).rejects.toThrow();
});
it.each(["claim", "retry", "publishing"])("refuses %s even when current work is rehashed into a seed", async field => {
  const row = request.rows[0]; await db.doc(`cmsPublishQueue/${row.queueId}`).update(field === "claim" ? { claim: "live" } : field === "retry" ? { nextAttemptAt: 0 } : { status: "publishing" });
  const changed = structuredClone(request); changed.rows[0].queueDigest = history.digest((await db.doc(`cmsPublishQueue/${row.queueId}`).get()).data());
  changed.queuesDigest = await collectionDigest("cmsPublishQueue");
  await expect(owner.plan({ firestore: db, request: changed, operatorCommitSha: source })).rejects.toThrow();
});

it("matches the diagnostic Timestamp canonicalizer without substituting publicReleaseDigest", () => {
  const value = { z: Timestamp.fromMillis(1001), a: [{ nested: Timestamp.fromMillis(2002) }] };
  const canonicalBytes = '{"a":[{"nested":{"seconds":2,"nanoseconds":2000000}}],"z":{"seconds":1,"nanoseconds":1000000}}';
  expect(history.digest(value)).toBe(createHash("sha256").update(canonicalBytes).digest("hex"));
});

it("strict drain validator refuses altered request/plan or reservation receipt bindings", async () => {
  await apply();
  const row = request.rows[0], batch = (await db.doc(`system/publicDeployment/buildBatches/${row.buildBatchId}`).get()).data()!;
  for (const field of ["requestDigest", "planDigest", "operationId", "reservation", "active", "original"]) {
    const receipt = { ...batch.retirementReceipt };
    if (field.endsWith("Digest")) receipt[field] = "0".repeat(64);
    if (field === "operationId") receipt.operationId += "-other";
    if (field === "reservation") receipt.reservation = { ...receipt.reservation, commitSha: "0".repeat(40) };
    if (field === "active") receipt.active = { ...receipt.active, versionId: deploymentId };
    if (field === "original") receipt.original = { ...receipt.original, queueDigest: "0".repeat(64) };
    expect(() => history.assertDevHistoricalRetiredBatch({ ...batch, retirementReceipt: receipt }, row.buildBatchId)).toThrow();
  }
});
it.each(["fetching", "claim", "owner", "source", "schedule", "operation"])("refuses unsafe external refresh %s before writes", async field => {
  const ref = db.doc("system/publicDeployment/externalRefresh/current");
  if (field === "fetching") await ref.update({ status: "fetching" });
  if (field === "claim") await ref.update({ claim: "live-refresh-claim" });
  if (field === "owner") await ref.update({ "runtime.owner": "node-compute" });
  if (field === "source") await ref.update({ "runtime.release": "b".repeat(40) });
  if (field === "schedule") await ref.update({ nextAttemptAt: null });
  if (field === "operation") await ref.update({ operationId: "unrecognized" });
  const before = await snapshot();
  await expect(owner.plan({ firestore: db, request, operatorCommitSha: source })).rejects.toThrow();
  await expect(apply()).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});
it("preserves native terminal failed refresh scheduling through apply, readback and the real drain", async () => {
  await db.doc("system/publicDeployment/externalRefresh/current").update({ status: "failed" });
  const plan = await owner.plan({ firestore: db, request, operatorCommitSha: source });
  expect(plan.authorityWrites).toBe(0);
  const result = await apply(); expect(await read()).toEqual(result);
  expect(await pause.pauseDevPublicRelease({ firestore: db, attempt: pauseAttempt() })).toMatchObject({ pauseCommitted: true, drainCommitted: true });
});
