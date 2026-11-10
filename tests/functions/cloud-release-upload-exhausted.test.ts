import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { firebaseAdminRuntime } from "../../site/scripts/firebase-admin-runtime";
import { supersedeUploadExhaustedCloudRelease } from "../../site/scripts/stage-cms-publication-cloud-release";
import { openCmsPublicationCloudTokenJournal } from "../../site/scripts/cms-publication-cloud-token-journal";

const { assertPublicDeploymentRetiredCloudReleaseBatch } = createRequire(import.meta.url)("../../functions/lib/public-deployment.js");
const queueId = "4e61308147fbac82d7ca", buildBatchId = `cms-${queueId}`;
const commitSha = "a".repeat(40), oldSha = "b".repeat(40);
const requestPath = `cmsPublicationSerializerJournals/cloudflare-publisher/releases/${queueId}`;
const batchPath = `system/publicDeployment/buildBatches/${buildBatchId}`;
const pointerPath = "system/publicDeployment", runtimePath = "system/cmsPublicationRuntime";
const journalPath = "cmsPublicationSerializerJournals/cloudflare-publisher";
const candidatePath = `${batchPath}/candidates/worker`, queuePath = `cmsPublishQueue/${queueId}`;
const otherJournalPath = "cmsPublicationSerializerJournals/node-compute-primary";
const paths = [requestPath, batchPath, pointerPath, runtimePath, journalPath, candidatePath, queuePath, otherJournalPath];
let app: ReturnType<typeof firebaseAdminRuntime.initializeApp>, firestore: ReturnType<typeof firebaseAdminRuntime.getFirestore>;
const cleanup = async () => { for (const name of paths) await firestore.doc(name).delete(); };
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-njpbs(?:-[a-z0-9-]+)?$/.test(process.env.GCLOUD_PROJECT ?? "")) {
    throw new Error("Use the isolated demo Firestore emulator");
  }
  app = firebaseAdminRuntime.initializeApp({ projectId: process.env.GCLOUD_PROJECT }, "upload-exhausted");
  firestore = firebaseAdminRuntime.getFirestore(app);
});
beforeEach(cleanup);
afterAll(async () => { if (firestore) await cleanup(); if (app) await firebaseAdminRuntime.deleteApp(app); });

async function seed() {
  const runtime = { owner: "cloudflare", release: commitSha };
  const documents = {
    [requestPath]: { schemaVersion: 1, queueId, buildBatchId, runtime, commitSha,
      inputSha256: "c".repeat(64), artifactCheckpointDigest: "d".repeat(64), status: "failed", attempts: 4,
      nextAttemptAt: null, failureReason: "candidate upload: The public Worker candidate could not be uploaded or verified." },
    [batchPath]: { schemaVersion: 1, buildBatchId, status: "reserved", runtime, commitSha, generation: 320,
      reservedAgainstGeneration: 318, reservedAgainstCommitSha: oldSha, reservedAgainstDeploymentId: "deployment-318",
      cutoffAt: firebaseAdminRuntime.Timestamp.fromMillis(1_700_000_000_000), reservedAt: firebaseAdminRuntime.Timestamp.fromMillis(1_700_000_000_000) },
    [pointerPath]: { state: "idle", activeCommitSha: oldSha, activeGeneration: 318, activeDeploymentId: "deployment-318" },
    [runtimePath]: { schemaVersion: 1, phase: "paused", commitSha, serializerId: "node-compute-primary",
      cloud: { phase: "paused", commitSha, serializerId: "cloudflare-publisher" } },
    [otherJournalPath]: { untouched: true },
  };
  for (const [name, value] of Object.entries(documents)) await firestore.doc(name).set(value);
}
const supersede = (apply = false) => supersedeUploadExhaustedCloudRelease({ firestore, queueId, commitSha, apply });
const snapshot = async () => Object.fromEntries(await Promise.all(paths.map(async name => [name, (await firestore.doc(name).get()).data()])));

it.each(["absent", "empty", "matching"])("defaults to dry-run, then atomically retires only this release with a %s journal", async mode => {
  await seed();
  const journal = await openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloudflare-publisher", runtime: { owner: "cloudflare", release: commitSha } });
  if (mode !== "absent") {
    const { job } = await journal.reserve({ queueId, buildBatchId, commitSha });
    if (mode === "empty") await journal.clear({ queueId, claimToken: job.claimToken });
  }
  const before = await snapshot();
  const result = { queueId, buildBatchId, commitSha, generation: 320, activeGeneration: 318,
    requestStatus: "superseded", batchStatus: "retired", journalCleared: mode === "matching" };
  expect(await supersede()).toEqual({ ...result, written: false, dryRun: true });
  expect(await snapshot()).toEqual(before);
  expect(await supersede(true)).toEqual({ ...result, written: true, dryRun: false });
  const after = await snapshot();
  const receipt = { schemaVersion: 1, reason: "cloud_release_not_staged", originalOwner: "cloudflare",
    activeGeneration: 318, activeCommitSha: oldSha, activeDeploymentId: "deployment-318" };
  expect(after[requestPath]).toEqual({ ...before[requestPath], status: "superseded",
    supersededAt: expect.any(firebaseAdminRuntime.Timestamp), supersessionReceipt: { ...receipt, reason: "cloud_release_upload_exhausted" } });
  expect(after[batchPath]).toEqual({ ...before[batchPath], status: "retired",
    retiredAt: after[requestPath]!.supersededAt, retirementReceipt: receipt });
  expect(assertPublicDeploymentRetiredCloudReleaseBatch(after[batchPath], buildBatchId)).toEqual(after[batchPath]);
  for (const path of [pointerPath, runtimePath, candidatePath, queuePath, otherJournalPath]) expect(after[path]).toEqual(before[path]);
  expect(after[journalPath]).toEqual(mode === "matching" ? { ...before[journalPath], job: null } : before[journalPath]);
  await expect(supersede(true)).rejects.toThrow();
  expect(await snapshot()).toEqual(after);
});

it.each([requestPath, batchPath, pointerPath, runtimePath])("refuses missing %s without writes", async path => {
  await seed(); await firestore.doc(path).delete(); const before = await snapshot();
  await expect(supersede(true)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});

const refusals: [string, string, object][] = [
  ["request schema", requestPath, { schemaVersion: 2 }], ["request id", requestPath, { queueId: "other" }],
  ["request batch", requestPath, { buildBatchId: "other" }], ["request source", requestPath, { commitSha: oldSha }],
  ["request owner", requestPath, { runtime: { owner: "node-compute", release: commitSha } }],
  ["request runtime source", requestPath, { runtime: { owner: "cloudflare", release: oldSha } }],
  ["bad input digest", requestPath, { inputSha256: "invalid" }], ["bad checkpoint digest", requestPath, { artifactCheckpointDigest: "invalid" }],
  ["pending request", requestPath, { status: "pending" }], ["deployed request", requestPath, { status: "deployed" }],
  ["attempts remaining", requestPath, { attempts: 3 }], ["attempts above limit", requestPath, { attempts: 5 }],
  ["retry scheduled", requestPath, { nextAttemptAt: 1_800_000_000_000 }],
  ["activation failure", requestPath, { failureReason: "activation: refused" }], ["no failure reason", requestPath, { failureReason: null }],
  ["ready batch", batchPath, { status: "ready" }], ["batch source", batchPath, { commitSha: oldSha }],
  ["batch owner", batchPath, { runtime: { owner: "node-compute", release: commitSha } }],
  ["batch runtime source", batchPath, { runtime: { owner: "cloudflare", release: oldSha } }],
  ["static input batch", batchPath, { noBuildStaticInput: { schemaVersion: 1 } }],
  ["busy pointer", pointerPath, { state: "deploying" }], ["retained lease", pointerPath, { lease: { retained: true } }],
  ["retained lease token", pointerPath, { leaseToken: "fixture" }],
  ["pointer generation moved", pointerPath, { activeGeneration: 319 }],
  ["pointer source moved", pointerPath, { activeCommitSha: "f".repeat(40) }],
  ["pointer deployment moved", pointerPath, { activeDeploymentId: "deployment-319" }],
  ["primary ready", runtimePath, { phase: "ready" }], ["primary source moved", runtimePath, { commitSha: oldSha }],
  ["cloud ready", runtimePath, { cloud: { phase: "ready", commitSha, serializerId: "cloudflare-publisher" } }],
  ["cloud source moved", runtimePath, { cloud: { phase: "paused", commitSha: oldSha, serializerId: "cloudflare-publisher" } }],
  ["cloud owner moved", runtimePath, { cloud: { phase: "paused", commitSha, serializerId: "other" } }],
];
it.each(refusals)("refuses %s and preserves every document", async (_label, path, change) => {
  await seed(); await firestore.doc(path).update(change); const before = await snapshot();
  await expect(supersede(true)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});

it.each([candidatePath, queuePath])("refuses an existing %s", async path => {
  await seed(); await firestore.doc(path).set({ status: "failed" }); const before = await snapshot();
  await expect(supersede(true)).rejects.toThrow(); expect(await snapshot()).toEqual(before);
});

it("never clears or changes the journal for another request", async () => {
  await seed();
  const journal = await openCmsPublicationCloudTokenJournal({ firestore, serializerId: "cloudflare-publisher", runtime: { owner: "cloudflare", release: commitSha } });
  const otherId = "Other000000000000001";
  await journal.reserve({ queueId: otherId, buildBatchId: `cms-${otherId}`, commitSha });
  const before = await snapshot();
  await expect(supersede(true)).rejects.toThrow("retained journal"); expect(await snapshot()).toEqual(before);
});

it("keeps the existing retired-batch schema accepted by the live Functions", async () => {
  await seed(); await supersede(true);
  const retired = (await firestore.doc(batchPath).get()).data()!;
  for (const change of [{ reason: "cloud_release_upload_exhausted" }, { activeCommitSha: "invalid" }, { activeDeploymentId: null }, { reason: "other" }]) {
    expect(() => assertPublicDeploymentRetiredCloudReleaseBatch({ ...retired,
      retirementReceipt: { ...retired.retirementReceipt, ...change } }, buildBatchId)).toThrow();
  }
});
