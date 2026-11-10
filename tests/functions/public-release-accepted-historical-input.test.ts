import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import { capabilities, fixtureGuard, fixtureReadOwner } from "../helpers/public-release-switch.js";
import { releasePair, releaseSelector, pairReference } from "../helpers/private-public-release-pair.js";
import p from "../../functions/lib/public-release-pair.js";
import admissions from "../../functions/lib/public-release-admission.js";
import work from "../../functions/lib/public-release-pair-work.js";
import switches from "../../functions/lib/public-release-switch.js";
import historicalCode from "../../functions/lib/public-release-historical-code.js";
import producer from "../../functions/lib/public-release-producer.js";
import { schedulePacketFixture } from "./page-schedule-packet-fixture";
import { frozenReplayProgramRead } from "../helpers/public-release-replay-inputs";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import { readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { openPublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";

const h = p.publicReleaseDigest, contract = { schemaVersion: 2, families: ["posts"], features: [] };
let fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>>, runtime: Miniflare, directory: string;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>, first: admissions.PairAdmission;
let nextPacket: Awaited<ReturnType<typeof schedulePacketFixture>>;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "accepted-history", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "accepted-history" } } } }] });
  store = await runtime.getR2Bucket("CONTENT"); directory = await mkdtemp(path.join(os.tmpdir(), "accepted-history-"));
  fixture = await publicReleasePairCompositeFixture({ firestore: isolatedFirestore("accepted-history"), store, directory,
    content: "baseline", readerSeals: sealedPair(undefined, releasePair("b", "b".repeat(40))).seals });
  const { firestore: db, pair, sourcePair } = fixture;
  const selector = { ...releaseSelector(), epoch: 2, activeGeneration: 2, lastReservedGeneration: 2, newestEligibleGeneration: 2,
    activeCommitSha: pair.commitSha, activeDeploymentId: pair.publicWorker.versionId,
    selectedPair: pairReference(pair), recoveryPair: pairReference(sourcePair), admittedContractDigest: h(contract),
    contentHead: { ...releaseSelector().contentHead, pairId: pair.pairId } };
  await db.doc(switches.ROOT).set({ ...releaseSelector(), activeGeneration: 1, lastReservedGeneration: 1, newestEligibleGeneration: 1,
    selectedPair: pairReference(sourcePair), recoveryPair: pairReference(pair), activeDeploymentId: sourcePair.publicWorker.versionId,
    contentHead: { ...releaseSelector().contentHead, pairId: sourcePair.pairId } });
  await db.doc(`${fixture.base}/controls/runtime`).set({ schemaVersion: 2, pairId: pair.pairId, status: "retained" });
  await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: pair.commitSha,
    serializerId: "cloudflare-dev-publisher", cloud: { phase: "ready", commitSha: pair.commitSha, serializerId: "cloudflare-dev-publisher" } });
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-background" });
  await db.doc(`${admissions.CONTRACTS}/${h(contract)}`).set(contract);
  await db.doc(admissions.ADMISSIONS).set(admissions.initialAdmissionHead());
  await db.doc(`${admissions.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
  await db.doc("system/billing").set({ disabled: false });
  // Fixture adoption appends the real CODE event and exact schema-two root
  // through the producer. The later switch below uses the guarded owner.
  const baselinePack = (await db.doc(`${fixture.base}/codePacks/baseline`).get()).data()!;
  nextPacket = await schedulePacketFixture({ firestore: db, rendererSha: pair.commitSha, generation: 2, boundary: fixture.packet.boundary,
    includeHomeSources: true, attachExternalInputs: false, programRead: frozenReplayProgramRead(pair.commitSha),
    postDocuments: [(await db.doc("cmsPosts/story").get()).data() as any] });
  nextPacket.refuseCode();
  const initialCode = historicalCode.prepareRetainedPublicReleaseCode({ reference: nextPacket.reference,
    publication: nextPacket.reference.publication, publicContext: nextPacket.codeContext });
  for (const chunk of initialCode.chunks) await db.doc(`${historicalCode.CHUNKS}/${chunk.digest}`).set(chunk.value);
  const codeReference = { schemaVersion: 2, kind: "pair", side: pairReference(pair), commitSha: pair.commitSha,
    codeAssetManifestDigest: pair.codeAssetManifestDigest, publicationDigest: "8".repeat(64) };
  await db.doc(`${fixture.base}/codePacks/publication`).set({ schemaVersion: 2, kind: "pair-code-publication", pairDigest: h(pair),
    baselineDigest: h(baselinePack), codePackManifestDigest: baselinePack.codePackManifestDigest, historicalCode: initialCode.descriptor, reference: codeReference });
  const originalMedia = { schemaVersion: 2, epoch: 2, activeGeneration: 2, lastReservedGeneration: 2, newestEligibleGeneration: 2,
    references: [pair, sourcePair].map(side => ({ pairId: side.pairId, manifestDigest: "f".repeat(64) })) };
  await db.runTransaction(async transaction => {
    const sourceDocuments = [{ path: switches.ROOT, data: selector }, { path: switches.MEDIA, data: originalMedia },
      { path: `cmsPreviewPublicContexts/${nextPacket.reference.publication.buildBatchId}`, data: nextPacket.reference.manifest },
      ...Object.entries(switches.CAPABILITY_PATHS).map(([family, path]) => ({ path, data: { ...capabilities(pair.commitSha)[family], generation: 2 } }))];
    const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction,
      operationId: "fixture-adopt-B", contextRevision: 1, pairActivation: { commitSha: pair.commitSha, codeReference },
      changes: [{ kind: "provider", id: "public-code", action: "dependency", sourceVersion: 2,
        snapshot: { commitSha: pair.commitSha, generation: 2, deploymentId: pair.publicWorker.versionId }, sourceDocuments }] });
    append(); for (const row of sourceDocuments) transaction.set(db.doc(row.path), row.data);
  });
  const story = (await db.doc("cmsPosts/story").get()).data()!;
  async function accept(operationId: string, sourceVersion: number) {
    const snapshot = { ...story.published, sourceVersion, metadata: { ...story.published.metadata, title: `Accepted ${operationId}` } };
    return db.runTransaction(async transaction => {
      const change = { kind: "post", id: "story", action: "publish", sourceVersion, snapshot };
      const prepared = await admissions.preparePairPublicationInTransaction({ firestore: db, transaction,
        operationId, source: admissions.publicationSource(change), change, contextRevision: sourceVersion - 8 });
      prepared.write(); transaction.set(db.doc("cmsPosts/story"), { ...story, version: sourceVersion, published: snapshot });
      transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision: sourceVersion - 8 });
      return prepared.admission;
    });
  }
  first = await accept("accepted-A", 10); await accept("accepted-B", 11);
  // Exercise the real guarded transaction and CODE append. The late proof
  // callbacks below are explicit switch fixtures, not operator readiness or
  // evidence that these synthetic qualifications cover actual public bytes.
  const next = sealedPair(undefined, releasePair("c", "c".repeat(40))).pair;
  await work.registerPublicReleasePair({ firestore: db, pair: next });
  await db.doc(readerSealPath(next)).create(sealedPair(undefined, next).seals);
  const nextBase = work.publicReleasePairPath(next.pairId);
  for (const side of [pair, next]) await db.doc(`${work.publicReleasePairPath(side.pairId)}/rollouts/publisher`).set({ schemaVersion: 2,
    pairId: side.pairId, pairDigest: h(side), state: "verified", readbackDigest: "c".repeat(64) });
  const pack = { schemaVersion: 1, kind: "pair-code-pack-baseline", pairDigest: h(next), commitSha: next.commitSha,
    codeAssetManifestDigest: next.codeAssetManifestDigest, codePackManifestDigest: "9".repeat(64) };
  await db.doc(`${nextBase}/codePacks/baseline`).set(pack);
  const retained = historicalCode.prepareRetainedPublicReleaseCode(publicReleaseBaselineCodeFixture(db, next.commitSha).qualified);
  for (const chunk of retained.chunks) await db.doc(`${historicalCode.CHUNKS}/${chunk.digest}`).set(chunk.value);
  await db.doc(`${nextBase}/codePacks/publication`).set({ schemaVersion: 2, kind: "pair-code-publication", pairDigest: h(next),
    baselineDigest: h(pack), codePackManifestDigest: pack.codePackManifestDigest, historicalCode: retained.descriptor,
    reference: { schemaVersion: 2, kind: "pair", side: pairReference(next), commitSha: next.commitSha,
      codeAssetManifestDigest: next.codeAssetManifestDigest, publicationDigest: "8".repeat(64) } });
  await db.doc(switches.MEDIA).set({ schemaVersion: 2, epoch: 2, activeGeneration: 2, lastReservedGeneration: 2, newestEligibleGeneration: 2,
    references: [pair, sourcePair, next].map(side => ({ pairId: side.pairId, manifestDigest: "f".repeat(64) })) });
  await db.doc("system/publicDeployment/noBuildRecordFamilies/current").set({ schemaVersion: 1, families: ["programs", "events"] });
  const paths = ["system/publicDeployment/contexts/public", "system/publicReleaseChanges", "system/publicReleaseChangeLog",
    "system/noBuildPostAdmission", "system/publicDeployment/noBuildRecordFamilies/current", switches.MEDIA, admissions.ADMISSIONS, "system/billing"];
  const rows = await db.getAll(...paths.map(path => db.doc(path))), validators = rows.map((row, index) => ({ path: paths[index], digest: h(row.data()) }));
  const cursor = rows[1].data(), acceptedWorkDigest = h(rows[6].data());
  const qualifications = [pair, next].map(side => ({ schemaVersion: 2, pairDigest: h(side),
    contentHead: { pairId: side.pairId, viewId: "historical-fixture-view", manifestDigest: "e".repeat(64), contextSequence: cursor!.sequence },
    cursor, validatorDigest: h(validators), capabilities: capabilities(side.commitSha), coverageDigest: "d".repeat(64),
    controlsDigest: h(capabilities(side.commitSha)),
    acceptedWorkDigest, admittedContractDigest: h(contract), readerReceiptDigest: side.readerReceiptDigest, providerReadbackDigest: "c".repeat(64) }));
  for (const [index, side] of [pair, next].entries()) await db.doc(`${work.publicReleasePairPath(side.pairId)}/switchQualifications/${h(qualifications[index])}`).set(qualifications[index]);
  const witness = { schemaVersion: 2, oldPairDigest: h(pair), newPairDigest: h(next), oldQualificationDigest: h(qualifications[0]),
    newQualificationDigest: h(qualifications[1]), cursor, validators, admittedContractDigest: h(contract), acceptedWorkDigest };
  await db.doc(`${switches.WITNESSES}/${h(witness)}`).set(witness);
  const attempt = { schemaVersion: 2, operationId: "historical-input-switch", expectedSelectorDigest: h(selector),
    oldPair: pair, newPair: next, witnessDigest: h(witness) };
  await switches.reservePublicReleaseSwitch({ firestore: db, attempt });
  await switches.applyPublicReleaseSwitch({ firestore: db, attempt, qualificationReadOwner: fixtureReadOwner,
    assertQualificationsCurrentInTransaction: fixtureGuard, assertAcceptedWorkIncludedInTransaction: fixtureGuard });
}, 30_000);
afterAll(async () => { await nextPacket?.close(); await fixture?.close(); await runtime?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });

it("captures A only after B and a guarded CODE switch, retaining original admission, cursor, version and sealed CODE", async () => {
  const { firestore, pair } = fixture;
  expect((await firestore.doc(switches.ROOT).get()).data()).toMatchObject({ epoch: 3, activeCommitSha: "c".repeat(40) });
  expect((await firestore.doc("cmsPosts/story").get()).data()).toMatchObject({ published: { sourceVersion: 11 } });
  const result = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId: first.operationId,
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No current resource fallback"); } } });
  expect(result.status).toBe("queued");
  const identity = (await firestore.doc(`${fixture.base}/work/${result.taskId}`).get()).data()!.identity;
  expect(identity).toMatchObject({ kind: "accepted", pair: first.pair, sourceOperationId: first.operationId,
    sourceVersion: 10, snapshotDigest: first.source.snapshotDigest, contextSequence: first.changeSequence });
  const captured = await captureHistoricalPublicReleasePairInput({ firestore, store, pair, kind: "accepted", sourceOperationId: first.operationId,
    providerStore: { async get() { throw new Error("Frozen H must not re-fetch providers"); }, async put() { throw new Error("Read only"); } } });
  const opened = await openPublicReleasePairInput({ firestore, store, pair, identity, expectedSource: captured.root.source, expectedCursor: captured.root.cursor });
  const text = async (name: string) => new TextDecoder().decode(await opened.readFile(name));
  expect(await text("snapshot.json")).toContain('"sourceVersion":10');
  expect(await text("snapshot.json")).toContain("Accepted accepted-A");
  expect(await text("snapshot.json")).not.toContain("Accepted accepted-B");
  expect(JSON.parse(await text("code-pack.json")).commitSha).toBe(pair.commitSha);
  expect(captured.root.cursor.sequence).toBe(first.changeSequence);
  expect((await firestore.doc(`${admissions.ADMISSIONS}/pending/${first.operationId}`).get()).exists).toBe(true);
});

it("refuses an unadmitted accepted capture before creating private input or capture bindings", async () => {
  const { firestore, pair } = fixture;
  const before = (await firestore.collection(`${fixture.base}/inputs`).get()).size;
  await expect(captureHistoricalPublicReleasePairInput({ firestore, store, pair, kind: "accepted", sourceOperationId: "unadmitted-A",
    providerStore: fixture.providerStore })).rejects.toThrow();
  expect((await firestore.collection(`${fixture.base}/inputs`).get()).size).toBe(before);
});
