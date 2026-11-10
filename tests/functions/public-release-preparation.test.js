import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import preparation from "../../functions/lib/public-release-preparation.js";
import deployment from "../../functions/lib/public-deployment.js";
import coordinator from "../../functions/lib/public-deployment-coordinator.js";
import promotion from "../../functions/lib/public-release-promotion.js";
import candidateModule from "../../functions/lib/public-worker-candidate.js";
import mediaModule from "../../functions/lib/public-media-manifest.js";
import mediaStore from "../../functions/lib/public-media-manifest-store.js";
import candidateStore from "../../functions/lib/public-worker-candidate-store.js";
import { createHash } from "node:crypto";
import { runNoBuildCloudRelease } from "../../site/scripts/no-build-cloud-release";

const oldCommitSha = "a".repeat(40), commitSha = "b".repeat(40);
const preparationId = "Release0000000000001";
const path = `system/publicReleasePreparations/entries/${preparationId}`;
let app, db;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") ||
      process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use a local demo Firestore emulator");
  app = initializeApp({ projectId: "demo-njpbs" }, "release-preparation-test");
  db = isolatedFirestore("public-release-preparation.test.js");
});
afterAll(async () => { if (app) await deleteApp(app); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true,
    activeGeneration: 7, activeDeploymentId: "deployment-seven", activeCommitSha: oldCommitSha,
    lastReservedGeneration: 7, newestEligibleGeneration: 7, newestEligibleBuildBatchId: "batch-seven" });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: oldCommitSha,
    serializerId: "node-compute-primary", cloud: { phase: "ready", commitSha: oldCommitSha, serializerId: "cloudflare-publisher" } });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 11 });
});
const prepare = (overrides = {}) => preparation.preparePublicRelease({ firestore: db, preparationId, commitSha, oldCommitSha, ...overrides });
const reserve = () => coordinator.reservePublicBuildBatch({ firestore: db, buildBatchId: `cms-${preparationId}`,
  commitSha, runtime: { owner: "cloudflare", release: commitSha } });
const check = (phase = "ready") => preparation.checkPublicReleasePreparation({ firestore: db, preparationId, commitSha, phase });

it("prepares and retries without changing live admission, generation, eligibility or work", async () => {
  const paths = ["system/publicDeployment", "system/cmsPublicationRuntime", "system/publicDeployment/contexts/public"];
  const before = await Promise.all(paths.map(async name => (await db.doc(name).get()).data()));
  const reservation = await prepare();
  expect(reservation).toMatchObject({ generation: 8, buildBatchId: `cms-${preparationId}`, commitSha,
    runtime: { owner: "cloudflare", release: commitSha }, reservedAgainstGeneration: 7,
    reservedAgainstCommitSha: oldCommitSha, reservedAgainstDeploymentId: "deployment-seven" });
  expect(reservation.cutoffAt).toBeInstanceOf(Timestamp);
  expect(reservation.cutoffAt.toMillis()).toBeGreaterThan(0);
  expect(reservation.cutoffAt.toMillis()).toBeLessThanOrEqual(Date.now());
  const first = await db.doc(path).get();
  expect(await prepare()).toEqual(reservation);
  expect((await db.doc(path).get()).updateTime).toEqual(first.updateTime);
  expect(await preparation.readPublicReleasePreparation({ firestore: db, preparationId, commitSha })).toEqual(reservation);
  const after = await Promise.all(paths.map(async name => (await db.doc(name).get()).data()));
  expect(after).toEqual(before);
  expect(deployment.assertMediaLifecycleDeploymentFence(after[0])).toEqual({ generation: 7,
    deploymentId: "deployment-seven", commitSha: oldCommitSha });
  for (const collection of ["system/publicDeployment/buildBatches", "cmsPublishQueue",
    "cmsPublicationSerializerJournals/cloudflare-publisher/releases"]) {
    expect((await db.collection(collection).get()).empty).toBe(true);
  }
});

it("keeps the original cutoff and rejects a retry after public content moves", async () => {
  const original = await prepare();
  await db.doc("system/publicDeployment/contexts/public").update({ revision: FieldValue.increment(1) });
  await expect(prepare()).rejects.toThrow("stale");
  expect((await db.doc(path).get()).data().cutoffAt).toEqual(original.cutoffAt);
  expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(7);
});

it("refuses a conflicting source and never overwrites the preparation", async () => {
  await prepare();
  const before = await db.doc(path).get();
  await expect(prepare({ commitSha: "c".repeat(40) })).rejects.toThrow("invalid");
  expect((await db.doc(path).get()).updateTime).toEqual(before.updateTime);
});

it.each([
  ["system/cmsPublicationRuntime", { phase: "paused" }],
  ["system/cmsPublicationRuntime", { "cloud.phase": "paused" }],
  ["system/cmsPublicationRuntime", { "cloud.commitSha": commitSha }],
  ["system/publicDeployment", { lastReservedGeneration: 8 }],
  ["system/publicDeployment", { mediaLifecycleReady: false }],
  ["system/publicDeployment/contexts/public", { revision: 0 }],
])("refuses preparation when OLD is unavailable (%s, %j)", async (document, patch) => {
  await db.doc(document).update(patch);
  const pointer = (await db.doc("system/publicDeployment").get()).data();
  await expect(prepare()).rejects.toThrow();
  expect((await db.doc(path).get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(pointer);
});

it("gives concurrent preparations the same proposed generation without reserving it", async () => {
  const results = await Promise.all([prepare(), prepare({ preparationId: "Release0000000000002" })]);
  expect(results.map(row => row.generation)).toEqual([8, 8]);
  expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(7);
});

it("refuses ordinary reservation of a detached operation id before moving the live counter", async () => {
  await prepare();
  const before = (await db.doc("system/publicDeployment").get()).data();
  await expect(reserve()).rejects.toThrow("detached release preparation");
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`).get()).exists).toBe(false);
});

it("never reuses a live or retired operation id as a detached preparation", async () => {
  await db.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`).set({ status: "retired", commitSha });
  const before = (await db.doc("system/publicDeployment").get()).data();
  await expect(prepare()).rejects.toThrow("already belongs to a live release reservation");
  expect((await db.doc(path).get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
});

it("allows only one mode when detached preparation races an ordinary reservation", async () => {
  const results = await Promise.allSettled([prepare(), reserve()]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const detached = (await db.doc(path).get()).exists;
  const live = (await db.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`).get()).exists;
  expect([detached, live].filter(Boolean)).toHaveLength(1);
  expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(detached ? 7 : 8);
});

it("checks freshness before the pause and after the drain without changing either pin", async () => {
  const reservation = await prepare();
  expect(await check()).toEqual(reservation);
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  const before = (await db.doc("system/cmsPublicationRuntime").get()).data();
  expect(await check("paused")).toEqual(reservation);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toEqual(before);
  expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(7);
});

it.each([
  "cmsPages/home", "cmsPosts/story", "cmsSettings/navigation", "cmsAuthorProfilesPublic/author",
  "system/publicDeployment/noBuildPageOwners/page",
  "system/publicDeployment/noBuildRecordRoutes/route", "system/publicDeployment/noBuildPostOwners/post",
])("invalidates preparation when collection membership changes at %s", async document => {
  await prepare();
  await db.doc(document).set({ schemaVersion: 1, publiclyVisible: true, published: { title: "A new published record" } });
  await expect(check()).rejects.toThrow("stale");
  await expect(prepare()).rejects.toThrow("stale");
});

it.each(["update", "delete"])("detects %s without a context revision change, including paused withdrawals", async action => {
  const ref = db.doc("cmsPosts/story");
  await ref.set({ publiclyVisible: true });
  await prepare();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  if (action === "update") await ref.update({ publiclyVisible: false });
  else await ref.delete();
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(11);
  await expect(check("paused")).rejects.toThrow("stale");
});

it("refuses old preparations that predate the content freshness seal", async () => {
  await prepare();
  await db.doc(path).update({ freshnessDigest: FieldValue.delete() });
  await expect(check()).rejects.toThrow("stale");
});

it("refuses a freshness check under NEW pins or an unaccepted phase", async () => {
  await prepare();
  await db.doc("system/cmsPublicationRuntime").update({ commitSha, "cloud.commitSha": commitSha });
  await expect(check()).rejects.toThrow("exact publisher pins");
  await expect(check("starting")).rejects.toThrow("invalid");
});

async function seal() {
  const reservation = await prepare();
  const mediaManifest = mediaModule.createPublicMediaManifest({ reservation, owners: [],
    artifactInventory: ["cmsPages", "cmsPosts", "cmsSettings", "cmsAuthorProfilesPublic"]
      .map(collection => ({ collection, complete: true, documentIds: [] })) });
  const candidate = { schemaVersion: 1, runtime: { owner: "cloudflare", release: commitSha },
    buildBatchId: reservation.buildBatchId, generation: 8, commitSha, workerName: "njpbs-production",
    workerVersionId: "11111111-1111-4111-8111-111111111111", versionCreatedOn: "2026-10-26T12:00:00.000Z",
    artifactDigest: "a".repeat(64), artifactReceiptDigest: "b".repeat(64), publicationReceiptDigest: "c".repeat(64),
    mediaManifestDigest: mediaManifest.mediaManifestDigest, artifactFileCount: 2, artifactBytes: 100, wranglerVersion: "4.76.0" };
  candidate.workerVersionTag = candidateModule.publicWorkerCandidateTag(candidate);
  const { publicationReceiptDigest: _digest, artifactFileCount: _count, artifactBytes: _bytes, ...publication } =
    promotion.preparedArtifactFromCandidate(candidate);
  candidate.publicationReceiptDigest = createHash("sha256").update(JSON.stringify(publication)).digest("hex");
  await preparation.recordPreparedPublicReleaseCheckpoint({ firestore: db, preparationId, commitSha,
    inputSha256: "f".repeat(64), artifactCheckpointDigest: "a".repeat(64),
    preparedArtifact: promotion.preparedArtifactFromCandidate(candidate) });
  await preparation.recordPreparedPublicWorkerCandidate({ firestore: db, preparationId, candidate });
  await db.doc(`cmsPreviewPublicContexts/${reservation.buildBatchId}`).set({ schemaVersion: 1,
    buildBatchId: reservation.buildBatchId, artifactReceiptDigest: candidate.artifactReceiptDigest, sha256: "e".repeat(64),
    byteLength: 100, key: `public-context/${reservation.buildBatchId}/${"e".repeat(64)}.json` });
  const input = { firestore: db, preparationId, commitSha, inputSha256: "f".repeat(64),
    artifactCheckpointDigest: "a".repeat(64), preparedArtifact: promotion.preparedArtifactFromCandidate(candidate), mediaManifest };
  const proof = await promotion.sealPreparedPublicRelease(input);
  return { reservation, candidate, proof, input };
}
const promote = (apply = true) => promotion.promotePreparedPublicRelease({ firestore: db, preparationId, commitSha, apply });
const pauseForHandover = async () => {
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  await promotion.handoverPreparedPublicRelease({ firestore: db, preparationId, commitSha });
};

it("seals complete detached evidence while both OLD pins and the generation remain ready", async () => {
  const before = (await db.doc("system/publicDeployment").get()).data();
  const { proof, input } = await seal();
  expect(await promotion.sealPreparedPublicRelease(input)).toEqual(proof);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data().phase).toBe("ready");
  expect((await db.collection("system/publicDeployment/buildBatches").get()).empty).toBe(true);
  await expect(promotion.sealPreparedPublicRelease({ ...input, artifactCheckpointDigest: "b".repeat(64) }))
    .rejects.toThrow("cannot change");
});

it("atomically changes both OLD-paused pins, reserves the planned generation and creates its original work", async () => {
  const { reservation } = await seal();
  await expect(promote()).rejects.toThrow("OLD publisher pins paused");
  await pauseForHandover();
  await db.doc("cmsPosts/new-draft-after-handover").set({ status: "draft", draft: { title: "Draft work continues" } });
  const first = await promote();
  expect(first.receipt).toMatchObject({ generation: 8, commitSha, preparationId });
  const batch = (await db.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`).get()).data();
  expect(batch).toMatchObject({ generation: 8, cutoffAt: reservation.cutoffAt,
    reservedAgainstGeneration: 7, reservedAgainstCommitSha: oldCommitSha });
  expect((await promote()).receipt).toEqual(first.receipt);
  expect((await db.doc("system/publicDeployment").get()).data()).toMatchObject({ state: "idle", activeGeneration: 7,
    lastReservedGeneration: 8, newestEligibleGeneration: 7, activeCommitSha: oldCommitSha });
  expect((await db.doc("system/cmsPublicationRuntime").get()).data()).toMatchObject({ phase: "paused", commitSha,
    cloud: { phase: "paused", commitSha } });
  expect((await db.doc(`cmsPublicationSerializerJournals/cloudflare-publisher/releases/${preparationId}`).get()).data())
    .toMatchObject({ status: "pending", attempts: 0, preparationId, commitSha });
  expect((await db.doc(`system/publicDeployment/buildBatches/cms-${preparationId}/candidates/worker`).get()).exists).toBe(false);
});

it.each(["content", "generation", "context"])("refuses %s drift at handover before replacing OLD", async kind => {
  await seal();
  if (kind === "content") await db.doc("cmsPages/home").set({ publiclyVisible: true, published: { title: "Newer staff revision" } });
  if (kind === "generation") await db.doc("system/publicDeployment").update({ lastReservedGeneration: 8 });
  if (kind === "context") await db.doc("system/publicDeployment/contexts/public").update({ revision: 12 });
  const before = (await db.doc("system/publicDeployment").get()).data();
  await expect(pauseForHandover()).rejects.toThrow();
  expect((await db.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`).get()).exists).toBe(false);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
});

it("refuses promotion if its retained context or exact candidate changes", async () => {
  await seal();
  await pauseForHandover();
  await db.doc(`${path}/candidates/worker`).update({ workerVersionId: "22222222-2222-4222-8222-222222222222" });
  await expect(promote()).rejects.toThrow("matching complete proof");
  expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(7);
});

it("keeps simultaneous promotion retries on one reservation", async () => {
  await seal();
  await pauseForHandover();
  const results = await Promise.all([promote(), promote()]);
  expect(results.map(result => result.receipt.generation)).toEqual([8, 8]);
  expect((await db.collection("system/publicDeployment/buildBatches").get()).size).toBe(1);
  expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(8);
});

it("defaults promotion to a read-only preview and reads back one bounded apply receipt", async () => {
  await seal();
  await pauseForHandover();
  const names = ["system/publicDeployment", "system/cmsPublicationRuntime"];
  const before = await Promise.all(names.map(async name => (await db.doc(name).get()).data()));
  const preview = await promotion.promotePreparedPublicRelease({ firestore: db, preparationId, commitSha });
  expect(preview).toMatchObject({ dryRun: true, alreadyApplied: false, receipt: { generation: 8 } });
  expect(await Promise.all(names.map(async name => (await db.doc(name).get()).data()))).toEqual(before);
  expect((await db.doc(`${path}/promotions/reservation`).get()).exists).toBe(false);
  expect((await db.collection("system/publicDeployment/buildBatches").get()).empty).toBe(true);
  expect((await db.collection("cmsPublicationSerializerJournals/cloudflare-publisher/releases").get()).empty).toBe(true);
  const applied = await promote();
  expect(applied.receipt).toEqual(preview.receipt);
  expect((await db.doc(`${path}/promotions/reservation`).get()).data().receipt).toEqual(applied.receipt);
  expect(Object.keys(applied.receipt).sort()).toEqual(["buildBatchId", "commitSha", "generation", "preparationId",
    "proofDigest", "schemaVersion", "workerVersionId"]);
  expect(Buffer.byteLength(JSON.stringify(applied.receipt))).toBeLessThan(1024);
  const stable = await Promise.all(names.map(name => db.doc(name).get()));
  expect((await promote()).receipt).toEqual(applied.receipt);
  expect(await Promise.all(names.map(async name => (await db.doc(name).get()).updateTime))).toEqual(stable.map(row => row.updateTime));
});

it.each([false, true])("refuses a handover from a previous pause, even with published change %s", async publishedChange => {
  await seal();
  await pauseForHandover();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "ready", "cloud.phase": "ready" });
  if (publishedChange) {
    await db.doc("cmsPosts/new-story").set({ publiclyVisible: true, published: { title: "New live story" } });
    await db.doc("system/publicDeployment/contexts/public").update({ revision: 12 });
  }
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  await expect(promote()).rejects.toThrow("handover or generation is stale");
  expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(7);
  expect((await db.doc("system/cmsPublicationRuntime").get()).data().commitSha).toBe(oldCommitSha);
});

it("reports a missing preparation as a controlled refusal", async () => {
  await expect(check()).rejects.toMatchObject({ name: "PreparedPublicReleaseError", message: "The public release preparation is invalid" });
});

async function staged() {
  const sealed = await seal();
  await pauseForHandover();
  await promote();
  await mediaStore.stagePublicMediaManifest({ firestore: db, manifest: sealed.input.mediaManifest });
  await mediaStore.markPublicMediaManifestReady({ firestore: db, manifest: sealed.input.mediaManifest });
  await candidateStore.recordPublicWorkerCandidate({ firestore: db, candidate: sealed.candidate,
    runtime: { owner: "cloudflare", release: commitSha } });
  return sealed;
}

it("accepts draft saves after handover and reservation without stranding the release", async () => {
  await staged();
  await db.doc("cmsPosts/newer-draft").set({ status: "draft", draft: { title: "Staff draft during the short switch" } });
  expect(await coordinator.acquirePublicDeploymentLease({ firestore: db, buildBatchId: `cms-${preparationId}`, commitSha,
    runtime: { owner: "cloudflare", release: commitSha } })).toMatchObject({ outcome: "acquired" });
  expect((await db.doc("system/publicDeployment").get()).data().state).toBe("deploying");
});

it.each(["deployed", "uncertain", "exhausted"])("consumes a preuploaded release with %s evidence and no artifact I/O", async outcome => {
  const { candidate } = await seal();
  await pauseForHandover();
  await promote();
  const releaseRequest = db.doc(`cmsPublicationSerializerJournals/cloudflare-publisher/releases/${preparationId}`);
  if (outcome === "exhausted") await releaseRequest.update({ attempts: 3 });
  const workerTag = "d".repeat(32);
  const calls = [];
  let providerReadAvailable = outcome === "deployed";
  const { publicationReceiptDigest: _digest, artifactFileCount: _count, artifactBytes: _bytes, ...publication } =
    promotion.preparedArtifactFromCandidate(candidate);
  const requestJson = async request => {
    calls.push({ method: request.method, path: new URL(request.url).pathname });
    if (request.url.endsWith("/workers/scripts")) return { success: true, result: [{ id: "njpbs-production", tag: workerTag }] };
    if (request.url.endsWith("/triggers")) return { success: true, result: [{
      trigger_uuid: "22222222-2222-4222-8222-222222222222", external_script_id: workerTag,
      trigger_name: "Upload production", deploy_command: "npx wrangler versions upload --config workers/wrangler.jsonc", root_directory: "/",
      branch_includes: ["production"], branch_excludes: [] }] };
    if (request.url.endsWith("/subdomain")) return { success: true, result: { enabled: false, previews_enabled: false } };
    if (request.method === "POST") return { success: true, result: {} };
    if (!providerReadAvailable) throw new Error("Synthetic provider read unavailable");
    return { success: true, result: { deployments: [{ id: "33333333-3333-4333-8333-333333333333", source: "api",
      strategy: "percentage", annotations: { "workers/triggered_by": "deployment" },
      versions: [{ version_id: candidate.workerVersionId, percentage: 100 }], created_on: "2026-10-26T12:01:00.000Z" }] } };
  };
  // Absence of storage and credentials proves this path reaches activation
  // without a restore, upload, input read or context-retention call.
  const run = () => runNoBuildCloudRelease({ firestore: db, serializerId: "cloudflare-publisher", commitSha,
    sourceGit: async args => args[0] === "rev-parse" ? commitSha : "", activationIO: {
      requestJson, requestPublication: async () => JSON.stringify(publication) },
    storage: undefined, previewStorageCredential: undefined, stateDirectory: "/unused", cloudflareApiToken: "x".repeat(32) });
  await run();
  const pointer = (await db.doc("system/publicDeployment").get()).data();
  expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/deployments"))).toHaveLength(1);
  if (outcome === "deployed") {
    expect(pointer).toMatchObject({ state: "idle", activeGeneration: 8, activeCommitSha: commitSha });
    expect((await db.doc("cmsPublicationSerializerJournals/cloudflare-publisher").get()).data().job).toBeNull();
  } else {
    expect(pointer).toMatchObject({ state: "reconciling", activeGeneration: 7 });
    expect((await db.doc("cmsPublicationSerializerJournals/cloudflare-publisher").get()).data().job.queueId).toBe(preparationId);
    if (outcome === "exhausted") {
      const request = (await releaseRequest.get()).data();
      expect(request).toMatchObject({ status: "failed", attempts: 4, nextAttemptAt: null,
        failureReason: expect.stringContaining("exhausted while activation remains nonterminal") });
      const retainedJournal = (await db.doc("cmsPublicationSerializerJournals/cloudflare-publisher").get()).data();
      await run();
      expect((await releaseRequest.get()).data()).toEqual(request);
      expect((await db.doc("system/publicDeployment").get()).data()).toEqual(pointer);
      expect((await db.doc("cmsPublicationSerializerJournals/cloudflare-publisher").get()).data()).toEqual(retainedJournal);
      expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/deployments"))).toHaveLength(1);
      return;
    }
    // A due retry reconciles the existing candidate and lease. It must not
    // register the metadata again or send a second traffic change.
    await db.doc("cmsPosts/new-draft-during-recovery").set({ status: "draft", draft: { title: "A later draft" } });
    await db.doc(`cmsPublicationSerializerJournals/cloudflare-publisher/releases/${preparationId}`).update({ nextAttemptAt: 0 });
    providerReadAvailable = true;
    await run();
    expect((await db.doc("system/publicDeployment").get()).data()).toMatchObject({ state: "idle", activeGeneration: 8 });
    expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/deployments"))).toHaveLength(1);
  }
});

it("ignores draft inserts and edits to an already published record before C2", async () => {
  const publishedAt = "2026-10-25T12:00:00.000Z";
  await db.doc("cmsPages/about").set({ status: "published", publishAt: publishedAt,
    publiclyVisible: true, published: { title: "Live copy", publishedAt } });
  await prepare();
  await db.doc("cmsPosts/draft-only").set({ status: "draft", draft: { title: "New draft" } });
  await db.doc("cmsPages/about").update({ status: "draft", version: 2, draft: { title: "Changed draft" } });
  await expect(check()).resolves.toMatchObject({ generation: 8 });
});

it("requires the post-drain OLD handover before NEW can reserve the candidate", async () => {
  await seal();
  await db.doc("system/cmsPublicationRuntime").update({ phase: "paused", "cloud.phase": "paused" });
  await expect(promote()).rejects.toThrow("handover or generation is stale");
  expect((await db.doc("system/publicDeployment").get()).data().lastReservedGeneration).toBe(7);
});

it("ignores settings working values but detects its published snapshot without visibility fields", async () => {
  const ref = db.doc("cmsSettings/public-homepage-banner");
  await ref.set({ version: 1, values: { enabled: false, message: "Draft copy" }, published: { schemaVersion: 1,
    sourceVersion: 1, publishedAt: "2026-10-25T12:00:00.000Z", values: { enabled: true, message: "Live copy" } } });
  await prepare();
  await ref.update({ version: 2, values: { enabled: false, message: "New draft" } });
  await expect(check()).resolves.toMatchObject({ generation: 8 });
  await ref.update({ "published.values.message": "New published copy" });
  await expect(check()).rejects.toThrow("stale");
  expect((await db.doc("system/publicDeployment/contexts/public").get()).data().revision).toBe(11);
});

it("refuses a competing generation after handover without moving the pointer", async () => {
  await seal();
  await pauseForHandover();
  await db.doc("system/publicDeployment").update({ lastReservedGeneration: 8 });
  await expect(promote()).rejects.toThrow();
  expect((await db.doc(`system/publicDeployment/buildBatches/cms-${preparationId}`).get()).exists).toBe(false);
});

it.each(["edit", "delete"])("ignores draft media uploads and detects %s of referenced published media", async change => {
  const used = "11111111-1111-4111-8111-111111111111", draft = "22222222-2222-4222-8222-222222222222";
  await db.doc(`media_assets_public/${used}`).set({ url: "https://images.example.test/live.png" });
  await db.doc("cmsPages/about").set({ publiclyVisible: true, published: { blocks: [
    { id: "picture", type: "image", visible: true, data: { assetId: used } }] } });
  await prepare();
  await db.doc(`media_assets_public/${draft}`).set({ url: "https://images.example.test/draft.png" });
  await expect(check()).resolves.toMatchObject({ generation: 8 });
  await db.doc(`media_assets_public/${draft}`).update({ alt: "Draft-only metadata edit" });
  await expect(check()).resolves.toMatchObject({ generation: 8 });
  if (change === "edit") await db.doc(`media_assets_public/${used}`).update({ alt: "A changed public projection" });
  else await db.doc(`media_assets_public/${used}`).delete();
  await expect(check()).rejects.toThrow("stale");
});

it("retains approved library identity across draft saves and tracks its referenced media", async () => {
  const used = "11111111-1111-4111-8111-111111111111", draft = "22222222-2222-4222-8222-222222222222";
  const approved = { type: "sponsor", status: "approved", version: 1, name: "Approved sponsor", logoAssetId: used };
  await db.doc("cmsPosts/sponsor").set(approved);
  await db.doc("cmsVersionHistory/approval").set({ collection: "cmsPosts", documentId: "sponsor", action: "approve", after: approved });
  await db.doc(`media_assets_public/${used}`).set({ url: "https://images.example.test/approved.png" });
  await prepare();
  const working = { ...approved, status: "draft", version: 2, name: "Working sponsor", logoAssetId: draft };
  await db.doc("cmsPosts/sponsor").set(working);
  await db.doc("cmsVersionHistory/draft-save").set({ collection: "cmsPosts", documentId: "sponsor", action: "save", after: working });
  await db.doc(`media_assets_public/${draft}`).set({ url: "https://images.example.test/draft-logo.png" });
  await expect(check()).resolves.toMatchObject({ generation: 8 });
  await db.doc(`media_assets_public/${used}`).update({ alt: "The approved public logo changed" });
  await expect(check()).rejects.toThrow("stale");
});

it("binds the source identity to the actual cutoff when an unread source changes during preparation", async () => {
  const page = db.doc("cmsPages/about");
  await page.set({ publiclyVisible: true, published: { title: "Before" } });
  let injected = false;
  const interleaved = new Proxy(db, { get(target, field) {
    if (field === "runTransaction") return (callback, options) => target.runTransaction(transaction => {
      if (options?.readOnly) return callback(transaction);
      return callback(new Proxy(transaction, { get(tx, method) {
        if (method === "getAll") return async (...refs) => {
          const rows = await tx.getAll(...refs);
          if (!injected && refs.some(ref => ref.path === "system/publicDeployment")) {
            injected = true;
            await page.update({ "published.title": "After" });
          }
          return rows;
        };
        const value = Reflect.get(tx, method, tx);
        return typeof value === "function" ? value.bind(tx) : value;
      } }));
    }, options);
    const value = Reflect.get(target, field, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const reservation = await prepare({ firestore: interleaved });
  expect(injected).toBe(true);
  const historical = await db.runTransaction(transaction => transaction.get(page),
    { readOnly: true, readTime: reservation.cutoffAt });
  // An SDK retry may advance the final cutoff past the write. The build and
  // freshness result must agree with whichever real snapshot was retained.
  if (historical.data().published.title === "Before") await expect(check()).rejects.toThrow("stale");
  else {
    expect(historical.data().published.title).toBe("After");
    await expect(check()).resolves.toMatchObject({ generation: 8 });
  }
});
