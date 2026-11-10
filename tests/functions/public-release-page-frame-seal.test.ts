import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { pairReference, releasePair } from "../helpers/private-public-release-pair.js";
import { seedSwitch, fixtureGuard, fixtureReadOwner } from "../helpers/public-release-switch.js";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import { backgroundStorageFixture } from "./background-storage-fixture";
import "../../functions/lib/firebase.js";
import { createHistoricalPublicReleaseReader } from "../../site/scripts/public-release-pair-historical-reader";
import { projectPublicReleasePairSourceCensusDocuments, PairSourceCensusError } from "../../site/scripts/public-release-pair-source-census";
import { projectPublicPageContextRead } from "../../site/src/lib/public-page-context-render";
import { createNoBuildPageWorker } from "../../workers/src/no-build-page-worker";
const require = createRequire(import.meta.url);
const lineage = require("../../functions/lib/public-release-switch-lineage.js");
const producerOwner = require("../../functions/lib/public-release-producer.js");
const historical = require("../../functions/lib/public-release-historical-state.js");
const retainedCode = require("../../functions/lib/public-release-historical-code.js");
const bootstrap = require("../../functions/lib/public-release-bootstrap.js");
const switches = require("../../functions/lib/public-release-switch.js");
const work = require("../../functions/lib/public-release-pair-work.js");
const deployment = require("../../functions/lib/public-deployment.js");
const schedules = require("../../functions/lib/no-build-page-schedule-reader.js");
const decisions = require("../../functions/lib/no-build-page-context-decision.js");
const target = require("../../functions/lib/publication-target.js").publicationTarget("development");
const p = require("../../functions/lib/public-release-pair.js");
const db = isolatedFirestore("public-release-page-frame-seal.test.ts");
const sha = "a".repeat(40), now = new Date("2026-10-12T12:00:00.000Z");
let firestore: any, fixture: Awaited<ReturnType<typeof schedulePacketFixture>> | undefined;
let boundary: Awaited<ReturnType<typeof backgroundStorageFixture>>;
beforeAll(async () => { boundary = await backgroundStorageFixture(target.backgroundBucket); });
afterAll(async () => { await boundary?.close(); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  firestore = new Proxy(db, { get(owner, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(owner, key); return typeof value === "function" ? value.bind(owner) : value; } });
  boundary.objects.clear();
});
afterEach(async () => { await fixture?.close(); fixture = undefined; });
async function read(selector?: any) {
  const capture = await schedules.capturePageSchedule({ firestore, target, rendererSha: sha,
    request: fixture!.request, ...(selector ? { releaseSelector: selector } : {}) });
  return db.runTransaction(transaction => decisions.readNoBuildPageContextDecision({ firestore, transaction,
    path: "/schedule/", rendererSha: sha, target, now, scheduleCapture: capture }), { readOnly: true });
}
async function assertWorkerFrame(decision: any) {
  const content = await projectPublicPageContextRead(decision.renderContext, sha, now);
  expect(content.target.codeGeneration).toBe(decision.receipt.codeGeneration);
  const { receipt, ...context } = decision;
  const worker = createNoBuildPageWorker({ rendererSha: sha, rendererReady: true, target,
    now: () => now, readWithdrawal: async () => null,
    getDecision: async () => ({ ...context, contextReceipt: receipt }),
    cache: { async match() {}, async put() {} }, render: async () => "",
    renderContext: async () => "<!doctype html><html><body>Schedule fixture</body></html>",
    fetchAsset: async () => { throw new Error("No Assets fallback"); } });
  const response = await worker.fetch(new Request("https://dev-public.example.org/schedule/"));
  expect(response?.status).toBe(200);
  expect(response?.headers.get("x-njpbs-code-generation")).toBe(String(receipt.codeGeneration));
}
async function seedPair(generation = 1) {
  const seeded = await seedSwitch(firestore);
  const selector = { ...seeded.selector, activeGeneration: generation, lastReservedGeneration: generation,
    newestEligibleGeneration: generation };
  await db.doc("system/publicDeployment").set(selector);
  fixture = await schedulePacketFixture({ firestore, rendererSha: sha, generation, target, boundary });
  fixture.refuseCode();
  return { ...seeded, selector };
}
it("keeps the exact schema-one Schedule decision bytes captured before the change", async () => {
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "frame-baseline",
    activeCommitSha: sha, activeDeploymentId: "frame-baseline" });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  fixture = await schedulePacketFixture({ firestore, rendererSha: sha, generation: 1, target, boundary });
  const bytes = JSON.stringify(await read());
  // Captured with unchanged production code at f28fa4b4b989cd6807d46fa4e8a4ff94454b7cfe
  // and the nonempty synthetic packet inputs reviewed in PR51; never from this reader.
  const oracle = new URL("../fixtures/public-release-page-frame-schema-one.json", import.meta.url);
  expect(bytes).toBe(readFileSync(oracle, "utf8").trimEnd());
});
it("keeps steady-state schema-two Schedule seals when original CODE and selector generations agree", async () => {
  const { selector } = await seedPair();
  const decision = await read(selector);
  expect(decision.kind).toBe("context-page");
  expect(decision.renderContext.sourceSeal.codeGeneration).toBe(selector.activeGeneration);
  expect(decision.renderContext.schedule.receipt.code.generation).toBe(selector.activeGeneration);
  expect(fixture!.codeRequests()).toBe(0);
  expect(decision.receipt.codeGeneration).toBe(selector.activeGeneration);
  await assertWorkerFrame(decision);
});
it("refuses a different original CODE generation outside a recorded guarded return", async () => {
  const { selector } = await seedPair(2);
  // The actual retained CODE fixture remains generation one. No return history exists.
  await expect(read(selector)).rejects.toBeInstanceOf(p.PublicReleaseProtocolError);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(selector);
});
it("reads real bootstrap lineage through the actual bootstrap and first retained-pair switch writers", async () => {
  const seeded = await seedPair(2), currentPair = seeded.next, recoveryPair = seeded.old;
  const contract = { schemaVersion: 2, families: ["pages"], features: [] }, contractDigest = p.publicReleaseDigest(contract);
  const context = (await db.doc("system/publicDeployment/contexts/public").get()).data()!;
  await db.runTransaction(async transaction => {
    const write = await producerOwner.preparePublicReleaseProducerInTransaction({ firestore, transaction,
      operationId: "frame-schedule-input", contextRevision: context.revision,
      changes: [{ kind: "provider", id: "frame-schedule-input", action: "dependency", sourceVersion: 1,
        snapshot: context.externalInputs, sourceDocuments: [{ path: "system/publicDeployment/contexts/public", data: context }] }] });
    write();
  });
  const changes = (await db.doc("system/publicReleaseChanges").get()).data()!;
  const cursor = { baselineDigest: changes.baselineDigest, sequence: changes.sequence, lastDigest: changes.lastDigest };
  const before = { ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true, activeGeneration: 1,
    lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "frame-bootstrap",
    activeCommitSha: currentPair.commitSha, activeDeploymentId: "frame-bootstrap" };
  await db.doc(switches.ROOT).set(before);
  await db.doc(`system/publicReleaseAdmissionContracts/entries/${contractDigest}`).set(contract);
  await db.doc(switches.MEDIA).delete();
  const pins = (await db.doc("system/cmsPublicationRuntime").get()).data()!;
  await db.doc("system/cmsPublicationRuntime").set({ ...pins, commitSha: currentPair.commitSha,
    cloud: { ...pins.cloud, commitSha: currentPair.commitSha } });
  await db.doc(`${work.publicReleasePairPath(currentPair.pairId)}/controls/runtime`).set({ schemaVersion: 2, pairId: currentPair.pairId, status: "retained" });
  const producer = (await db.doc("system/publicReleaseChangeLog").get()).data()!;
  await db.doc("system/publicReleaseChangeLog").set({ ...producer, pair: p.publicReleasePairReference(currentPair) });
  const proofs = [currentPair, recoveryPair].map((pair, index) => {
    const witness = { schemaVersion: 2, pairDigest: p.publicReleaseDigest(pair), codeAssetManifestDigest: pair.codeAssetManifestDigest,
      contentViewDigest: "e".repeat(64), headCursor: cursor };
    return { witness, receipt: { schemaVersion: 2, kind: "private-pair-qualification", qualificationId: `frame-${index}`,
      pairDigest: p.publicReleaseDigest(pair), readerReceiptDigest: pair.readerReceiptDigest, codeAssetManifestDigest: pair.codeAssetManifestDigest,
      witnessDigest: p.publicReleaseDigest(witness), contentViewDigest: witness.contentViewDigest } };
  });
  // This is the established writer-seam fixture, not deployment qualification.
  // The actual bootstrap owner writes its own epoch-one receipt; the actual
  // switch owner below writes epoch two and never manufactures epoch-one history.
  const installed = await bootstrap.bootstrapPublicReleaseSelector({ firestore, dryRun: false,
    attempt: { schemaVersion: 2, operationId: "frame-bootstrap", expectedSourceDigest: p.publicReleaseDigest(before),
      currentPair, recoveryPair, admittedContractDigest: contractDigest, qualifications: proofs.map(proof => ({
        qualificationId: proof.receipt.qualificationId, receiptDigest: p.publicReleaseDigest(proof.receipt) })) },
    qualificationGuard: { begin: (transaction: any) => ({ transaction, verify: async () => proofs, finish() {} }) },
    assertInstalledConsumersInTransaction: fixtureGuard, assertClosedFenceInTransaction: fixtureGuard });
  const validators = await Promise.all(seeded.witness.validators.map(async (row: any) => ({ path: row.path,
    digest: p.publicReleaseDigest((await db.doc(row.path).get()).data()) })));
  const qualifications = await Promise.all([currentPair, recoveryPair].map(async (pair, index) => {
    const original = seeded.qualifications[index ? 0 : 1];
    return { ...original, cursor: { schemaVersion: 2, ...cursor }, admittedContractDigest: contractDigest, validatorDigest: p.publicReleaseDigest(validators),
      contentHead: (await db.doc(`${work.publicReleasePairPath(pair.pairId)}/heads/current`).get()).data()!.contentHead };
  }));
  const witness = { ...seeded.witness, cursor: { schemaVersion: 2, ...cursor }, validators, oldPairDigest: p.publicReleaseDigest(currentPair), newPairDigest: p.publicReleaseDigest(recoveryPair),
    oldQualificationDigest: p.publicReleaseDigest(qualifications[0]), newQualificationDigest: p.publicReleaseDigest(qualifications[1]),
    admittedContractDigest: contractDigest };
  for (const [index, pair] of [currentPair, recoveryPair].entries()) await db.doc(
    `${work.publicReleasePairPath(pair.pairId)}/switchQualifications/${p.publicReleaseDigest(qualifications[index])}`).set(qualifications[index]);
  await db.doc(`${switches.WITNESSES}/${p.publicReleaseDigest(witness)}`).set(witness);
  const attempt = { schemaVersion: 2, operationId: "frame-bootstrap-return", expectedSelectorDigest: p.publicReleaseDigest(installed.receipt.selector),
    oldPair: currentPair, newPair: recoveryPair, witnessDigest: p.publicReleaseDigest(witness) };
  await switches.reservePublicReleaseSwitch({ firestore, attempt });
  const switched = await switches.applyPublicReleaseSwitch({ firestore, attempt, qualificationReadOwner: fixtureReadOwner,
    assertQualificationsCurrentInTransaction: fixtureGuard, assertAcceptedWorkIncludedInTransaction: fixtureGuard });
  expect((await db.collection("system/publicReleaseSwitches/entries").where("selector.epoch", "==", 1).get()).size).toBe(0);
  const selector = switched.receipt.selector, decision = await read(selector);
  expect(decision.receipt.codeGeneration).toBe(1);
  expect(decision.renderContext.sourceSeal.codeGeneration).toBe(1);
  expect(decision.renderContext.schedule.receipt.code.generation).toBe(1);
  expect(fixture!.codeRequests()).toBe(0);
  await assertWorkerFrame(decision);
  const codeOperationId = switches.switchChangeOperationId(attempt.operationId);
  const state = await historical.reconstructPublicReleaseState({ firestore, sourceOperationId: codeOperationId });
  const lineagePath = lineage.publicReleaseSwitchLineagePath(attempt.operationId);
  expect(state.documents.get(lineagePath)).toEqual((await db.doc(lineagePath).get()).data());
  const reader = createHistoricalPublicReleaseReader({ firestore, documents: state.documents, cursor: state.cursor, renderedAt: now.toISOString() });
  const publication = (await db.doc(`${work.publicReleasePairPath(recoveryPair.pairId)}/codePacks/publication`).get()).data()!;
  const qualifiedCode = await retainedCode.readRetainedPublicReleaseCode({ firestore, descriptor: publication.historicalCode });
  const capture = await schedules.captureHistoricalPageSchedule({ firestore: reader, target, rendererSha: sha,
    originalPair: recoveryPair, qualifiedCode, storage: { get: async (key: string) => boundary.objects.get(key) ?? null } });
  const frozen = await reader.runTransaction(transaction => decisions.readNoBuildPageContextDecision({ firestore: reader, transaction,
    path: "/schedule/", rendererSha: sha, target, now, scheduleCapture: capture }), { readOnly: true });
  expect(frozen.renderContext.sourceSeal.codeGeneration).toBe(1);
  await assertWorkerFrame(frozen);
  const projected = projectPublicReleasePairSourceCensusDocuments(state.documents);
  const missing = new Map(state.documents); missing.delete(lineagePath);
  expect(projectPublicReleasePairSourceCensusDocuments(missing)).toEqual(projected);
  const altered = new Map(state.documents);
  altered.set(lineagePath, { ...state.documents.get(lineagePath), selectorDigest: "f".repeat(64) });
  expect(() => projectPublicReleasePairSourceCensusDocuments(altered)).toThrow(PairSourceCensusError);
  altered.set(lineagePath, { ...state.documents.get(lineagePath), operationId: "another-switch" });
  expect(() => projectPublicReleasePairSourceCensusDocuments(altered)).toThrow(PairSourceCensusError);
  altered.delete(`system/publicReleaseSwitches/entries/${attempt.operationId}`);
  expect(() => projectPublicReleasePairSourceCensusDocuments(altered)).toThrow(PairSourceCensusError);
  const absent = createHistoricalPublicReleaseReader({ firestore, documents: missing, cursor: state.cursor, renderedAt: now.toISOString() });
  await expect(absent.runTransaction(transaction => decisions.readNoBuildPageContextDecision({ firestore: absent, transaction,
    path: "/schedule/", rendererSha: sha, target, now, scheduleCapture: capture }), { readOnly: true })).rejects.toThrow();
  await db.doc(lineagePath).update({ selectorDigest: "f".repeat(64) });
  await expect(read(selector)).rejects.toBeInstanceOf(p.PublicReleaseProtocolError);
});
it("requires ready pins and exact pair lineage for later recorded returns", async () => {
  const { selector: raw } = await seedPair(3);
  const pins = (await db.doc("system/cmsPublicationRuntime").get()).data()!;
  const previous = { ...raw, epoch: 2, activeGeneration: 2, lastReservedGeneration: 2, newestEligibleGeneration: 2,
    selectedPair: raw.recoveryPair, recoveryPair: raw.selectedPair, activeCommitSha: raw.recoveryPair.commitSha,
    switchOperationId: "frame-outbound", contentHead: { ...raw.contentHead, pairId: raw.recoveryPair.pairId } };
  const selector = { ...raw, epoch: 3, priorSelectorDigest: p.publicReleaseDigest(previous) };
  await db.doc("system/publicDeployment").set(selector);
  const lineageRef = db.doc(lineage.publicReleaseSwitchLineagePath(selector.switchOperationId));
  await db.doc(`system/publicReleaseSwitches/entries/${selector.switchOperationId}`).set({ schemaVersion: 2,
    operationId: selector.switchOperationId, selector, pins });
  const previousPins = { ...pins, commitSha: previous.activeCommitSha, cloud: { ...pins.cloud, commitSha: previous.activeCommitSha } };
  const previousRef = db.doc(`system/publicReleaseSwitches/entries/${previous.switchOperationId}`);
  const history = { schemaVersion: 2, operationId: previous.switchOperationId, selector: previous, pins: previousPins };
  await previousRef.set(history);
  const sealed = lineage.publicReleaseSwitchLineage(previous, previousPins, selector);
  await lineageRef.set(sealed);
  expect((await read(selector)).renderContext.sourceSeal.codeGeneration).toBe(1);
  await lineageRef.update({ "pins.cloud.phase": "paused" });
  await expect(read(selector)).rejects.toBeInstanceOf(p.PublicReleaseProtocolError);
  await lineageRef.set(sealed);
  await lineageRef.update({ "previousSelector.recoveryPair": pairReference(releasePair("c", "c".repeat(40))) });
  await expect(read(selector)).rejects.toBeInstanceOf(p.PublicReleaseProtocolError);
});
