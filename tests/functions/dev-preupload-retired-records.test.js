import { beforeAll, beforeEach, expect, it } from "vitest";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import dev from "../../scripts/lib/dev-publication.cjs";
import deployment from "../../functions/lib/public-deployment.js";
import target from "../../functions/lib/publication-target.js";
import pause from "../../functions/lib/dev-public-release-pause.js";
import contract from "../../functions/lib/dev-publication-preupload.js";
import protocol from "../../functions/lib/public-release-pair.js";

// The operator that wrote dev_publish_failed_before_upload retirements is gone
// (#595 replaced it). Its records remain in the development database, so
// the readers and the pause census must still accept them and refuse a forgery.
// Synthetic code-refresh identities preserve native shapes; no live SDK read
// or credential is used by these emulator cases.
const identity = { queueId: "e8a1597005e84ced55ee", buildBatchId: "cms-e8a1597005e84ced55ee",
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const request = { schemaVersion: 1, target: target.publicationTarget("development"), identity, generation: 122,
  inputDigest: "f".repeat(64), failure: { runId: "1001", runAttempt: 1, jobId: "2001",
    completedAt: "2026-10-31T20:37:11Z", code: "retained_dev_renderer_source_differs", logDigest: "e".repeat(64) } };
const paths = { queue: `cmsPublishQueue/${identity.queueId}`, batch: `system/publicDeployment/buildBatches/${identity.buildBatchId}` };
paths.input = `${paths.batch}/inputs/devFrozen`; paths.receipt = `${paths.batch}/retirements/devPreupload`;
let db;
beforeAll(() => { db = isolatedFirestore("dev-preupload-settlement"); });
const read = async path => (await db.doc(path).get()).data();
// Writes the record shape the removed operator wrote, from the live reserved rows.
async function seedRetired() {
  const [queue, batch, input] = [await read(paths.queue), await read(paths.batch), await read(paths.input)];
  const digest = protocol.publicReleaseDigest;
  const receipt = { schemaVersion: 1, reason: contract.REASON, outcome: "failed_not_published", request,
    requestDigest: digest(request), originalQueueDigest: digest(queue), originalBatchDigest: digest(batch),
    originalInputDigest: digest(input) };
  const retiredAt = Timestamp.fromDate(new Date("2026-10-31T20:40:00Z"));
  await db.doc(paths.receipt).create({ ...receipt, retiredAt });
  await db.doc(paths.batch).update({ status: "retired", retiredAt, retirementReceipt: receipt });
  await db.doc(paths.queue).update({ status: "failed", error: contract.failureMessage(request.failure.code),
    completedAt: retiredAt, preUploadFailureReceiptDigest: digest(receipt) });
}
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(),
    activeGeneration: 121, lastReservedGeneration: 121, newestEligibleGeneration: 121,
    activeDeploymentId: "11111111-2222-4333-8444-555555555555", activeCommitSha: "dddddddddddddddddddddddddddddddddddddddd",
    newestEligibleBuildBatchId: "cms-PPPPPPPPPPPPPPPPPPPP" });
  await db.doc(paths.queue).set({ status: "pending", transport: "github", environment: "development", projectId: "njpbs-site-dev",
    triggeredBy: "dev-code-refresh", triggeredByEmail: null, triggeredAt: Timestamp.fromDate(new Date("2026-10-31T20:30:20Z")),
    completedAt: null, error: null, changes: [], runtime: { owner: "cloudflare", release: identity.commitSha } });
  // Exercise the existing reservation/input writers, rather than hand-making
  // the batch or artifactBuild shapes the new owner must consume.
  await dev.reserveDevPublication(db, identity);
  await dev.recordDevInputs(db, identity, request.inputDigest);
  // The process clock is later than the historical failure. Bind its recorded
  // timestamps to the actual failed-run window at this clock boundary.
  const reservedAt = Timestamp.fromDate(new Date("2026-10-31T20:30:22Z"));
  await db.doc(paths.batch).update({ cutoffAt: reservedAt, reservedAt });
  await db.doc(paths.queue).update({ "artifactBuild.cutoffAt": reservedAt });
  await db.doc(paths.input).update({ recordedAt: Timestamp.fromDate(new Date("2026-10-31T20:30:50Z")) });
});

it("the dev readers accept an existing pre-upload retirement", async () => {
  await seedRetired();
  const batch = await read(paths.batch);
  expect(() => contract.assertDevPreuploadRetiredBatch(batch, identity.buildBatchId)).not.toThrow();
  expect((await dev.readDevPublication(db, identity)).batch.status).toBe("retired");
  expect(await dev.finishDevPublication(db, identity)).toBe("unclaimed");
});

it("the dev pause census counts an existing pre-upload retirement and rejects a forged receipt", async () => {
  await seedRetired();
  const attempt = { oldRuntime: { commitSha: identity.commitSha, serializerId: "original-primary",
    cloud: { serializerId: "cloudflare-dev-publisher" } } };
  const census = () => db.runTransaction(transaction => pause.recoveryInternals.drain(db, transaction, attempt, true), { readOnly: true });
  expect(await census()).toMatchObject({ queues: 1, batches: 1, retiredBatches: 1 });
  await db.doc(paths.batch).update({ "retirementReceipt.request.generation": FieldValue.increment(1) });
  await expect(census()).rejects.toThrow();
});

it("existing records accept only the listed failure codes", () => {
  // Retired records in the development database carry these codes.
  const codes = ["retained_dev_renderer_source_differs", "dev_refresh_frozen_build_failed", "dev_refresh_content_check_failed"];
  expect(Object.keys(contract.FAILURES).sort()).toEqual([...codes].sort());
  for (const code of codes) {
    const value = structuredClone(request); value.failure.code = code;
    expect(contract.parseDevPreuploadSettlement(value)).toBe(value);
  }
  for (const code of ["unknown", "toString", "__proto__", null]) {
    const value = structuredClone(request); value.failure.code = code;
    expect(() => contract.parseDevPreuploadSettlement(value)).toThrow();
  }
});

it("existing records accept the template development target their operator sealed, and no other target", () => {
  // Three dev rows were sealed with the unrendered source's target. Deployed
  // Functions carry the rendered target, so both must parse.
  const template = { ...target.publicationTarget("development"), workerName: "template-dev-public",
    origin: "https://dev-public.example.org", previewBucket: "template-dev-cms-previews" };
  const sealed = { ...structuredClone(request), target: template };
  expect(contract.parseDevPreuploadSettlement(sealed)).toBe(sealed);
  for (const changed of [{ projectId: "njpbs-site" }, { workerName: "njpbs-production" }, { serializerId: "cloudflare-publisher" }, { extra: "x" }]) {
    const value = { ...structuredClone(request), target: { ...template, ...changed } };
    expect(() => contract.parseDevPreuploadSettlement(value)).toThrow();
  }
  expect(() => contract.parseDevPreuploadSettlement({ ...structuredClone(request), target: target.publicationTarget("production") })).toThrow();
});
