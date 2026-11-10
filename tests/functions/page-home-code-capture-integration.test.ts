import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createRequire } from "node:module";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import { backgroundStorageFixture } from "./background-storage-fixture";
import { releasePair, releaseSelector } from "../helpers/private-public-release-pair.js";

const require = createRequire(import.meta.url);
const { captureHistoricalPageHomeCodeSources, capturePageHomeCodeSources, readCapturedPageHomeCodeSourcesInTransaction } = require("../../functions/lib/no-build-page-home-code-capture.js");
const deployment = require("../../functions/lib/public-deployment.js");
const target = require("../../functions/lib/publication-target.js").publicationTarget("development");
const rendererSha = "a".repeat(40);
let app: any, firestore: any, fixture: any, boundary: any;

beforeAll(async () => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") {
    throw new Error("Use the local demo Firestore emulator.");
  }
  app = initializeApp({ projectId: target.projectId }, "page-home-code-capture");
  firestore = getFirestore(app);
  boundary = await backgroundStorageFixture(target.backgroundBucket);
});
afterAll(async () => { await fixture?.close(); await boundary?.close(); await firestore?.terminate(); await deleteApp(app); });
beforeEach(async () => {
  await fixture?.close(); fixture = null;
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${target.projectId}/databases/(default)/documents`, { method: "DELETE" });
  boundary.objects.clear(); boundary.reads.length = 0; boundary.refuseReads(false);
  await firestore.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 2,
    lastReservedGeneration: 2, newestEligibleGeneration: 2, newestEligibleBuildBatchId: "fixture", activeCommitSha: rendererSha, activeDeploymentId: "fixture" });
  await firestore.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 3 });
  fixture = await schedulePacketFixture({ firestore, rendererSha, includeHomeSources: true, boundary });
});
const capture = (options = {}) => capturePageHomeCodeSources({ firestore, target, rendererSha, request: fixture.request, ...options });
const read = (transaction: any, captured: object) => readCapturedPageHomeCodeSourcesInTransaction({ firestore, transaction, target, rendererSha, capture: captured });

it("keeps the actual CODE publication and manifest through final SDK retries with all external reads unavailable", async () => {
  const captured = await capture();
  fixture.refuseCode(); boundary.refuseReads(true);
  let attempts = 0;
  await firestore.runTransaction(async (transaction: any) => {
    attempts++;
    const result = await read(transaction, captured);
    expect(result.codeSource).toEqual(fixture.reference);
    expect(result.homeSources.publication).toEqual({ buildBatchId: fixture.reference.publication.buildBatchId, generation: 2, commitSha: rendererSha });
    expect(result.homeSources.pbs.checkedAt).toBeNull();
    expect(result.homeSources.spotlight.checkedAt).toBe("2026-10-12T10:00:00.000Z");
    if (attempts === 1) throw Object.assign(new Error("Fixture SDK retry"), { code: 10 });
    transaction.set(firestore.doc("proof/home-code"), { generation: result.codeSource.publication.generation });
  }, { maxAttempts: 2 });
  expect(attempts).toBe(2); expect(fixture.codeRequests()).toBe(2); expect(boundary.reads).toEqual([]);
  expect((await firestore.doc("proof/home-code").get()).data()).toEqual({ generation: 2 });
});

it.each(["generation", "context", "manifest"])("refuses changed %s on a final SDK retry without external IO", async change => {
  const captured = await capture(); fixture.refuseCode(); boundary.refuseReads(true);
  let attempts = 0;
  await expect(firestore.runTransaction(async (transaction: any) => {
    attempts++;
    if (attempts === 2) {
      if (change === "generation") await firestore.doc("system/publicDeployment").update({ activeGeneration: 3 });
      if (change === "context") await firestore.doc("system/publicDeployment/contexts/public").update({ revision: 4 });
      if (change === "manifest") await firestore.doc(`cmsPreviewPublicContexts/${fixture.reference.publication.buildBatchId}`).update({ sha256: "f".repeat(64) });
    }
    await read(transaction, captured);
    if (attempts === 1) throw Object.assign(new Error("Fixture SDK retry"), { code: 10 });
    transaction.set(firestore.doc("proof/home-code"), { incorrectlyConfirmed: true });
  }, { maxAttempts: 2 })).rejects.toThrow();
  expect(attempts).toBe(2); expect(fixture.codeRequests()).toBe(2); expect(boundary.reads).toEqual([]);
  expect((await firestore.doc("proof/home-code").get()).exists).toBe(false);
});

it("refuses plain, expired and wrong-environment captures", async () => {
  let now = Date.now();
  const captured = await capture({ now: () => now, deadline: now + 45_000 });
  await expect(firestore.runTransaction((transaction: any) => read(transaction, {}), { readOnly: true })).rejects.toThrow();
  await expect(firestore.runTransaction((transaction: any) => readCapturedPageHomeCodeSourcesInTransaction({ firestore, transaction,
    target: require("../../functions/lib/publication-target.js").publicationTarget("production"), rendererSha, capture: captured }), { readOnly: true })).rejects.toThrow();
  now += 45_000;
  await expect(firestore.runTransaction((transaction: any) => read(transaction, captured), { readOnly: true })).rejects.toThrow();
  expect(fixture.codeRequests()).toBe(2);
});

it("preserves legacy CODE authority after the selector converts to schema two", async () => {
  await firestore.doc("system/publicDeployment").set({ ...releaseSelector(), activeGeneration: 2,
    lastReservedGeneration: 2, newestEligibleGeneration: 2, activeCommitSha: rendererSha });
  const captured = await capture();
  fixture.refuseCode(); boundary.refuseReads(true);
  const result = await firestore.runTransaction((transaction: any) => read(transaction, captured), { readOnly: true });
  expect(result.codeSource).toEqual(fixture.reference);
  expect(result.homeSources).toEqual(fixture.codeContext.homeSources);
  expect(fixture.codeRequests()).toBe(2); expect(boundary.reads).toEqual([]);
  await firestore.doc("system/publicReleaseHistoricalCode").set({ reference: fixture.reference });
  const historical = await captureHistoricalPageHomeCodeSources({ firestore, target, rendererSha, originalPair: releasePair(),
    qualifiedCode: { reference: fixture.reference, publication: fixture.reference.publication, publicContext: fixture.codeContext } });
  expect(await firestore.runTransaction((transaction: any) => read(transaction, historical), { readOnly: true })).toEqual(result);
});
