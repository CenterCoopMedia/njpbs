import { afterAll, beforeAll, expect, it } from "vitest";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { guardedPublicReleaseSwitchFixture } from "../helpers/guarded-public-release-switch";
import { runCurrentPublicReleaseSwitch, readPublicReleaseSwitchOutcome, observeCurrentPublicReleaseOperation } from "../../site/scripts/public-release-switch-runner";
import { advancePublicReleaseSwitchCodeHead } from "../../site/scripts/public-release-switch-code-head";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import switches from "../../functions/lib/public-release-switch.js";
import serving from "../../functions/lib/public-release-serving.js";
import family from "../../functions/lib/public-release-family-admission.js";

let objects: Awaited<ReturnType<typeof publicReleaseR2Fixture>>;
let fixture: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
const forwardId = "runner-switch-new", returnId = "runner-return-old", publicationId = "N".repeat(20);
beforeAll(async () => {
  objects = await publicReleaseR2Fixture("switch-runner");
  fixture = await guardedPublicReleaseSwitchFixture(isolatedFirestore("switch-runner"), objects.store);
}, 120_000);
afterAll(async () => { await fixture?.close(); await objects?.runtime.dispose(); });
const input = (returning = false) => ({ firestore: fixture.selected.firestore, store: objects.store,
  from: returning ? fixture.pair : fixture.selected.pair, to: returning ? fixture.selected.pair : fixture.pair,
  operationId: returning ? returnId : forwardId, qualificationAttemptId: "original-proof",
  credentials: [fixture.transport.credentials, fixture.transport.credentials] as const });

it("preserves an uncertain original attempt without requalifying, applying or abandoning it", async () => {
  const options = input(), db = options.firestore, operationId = "uncertain-original";
  const before = await db.doc("system/publicDeployment").get();
  const attempt = { schemaVersion: 2, operationId, oldPair: options.from, newPair: options.to,
    expectedSelectorDigest: protocol.publicReleaseDigest(before.data()), witnessDigest: "f".repeat(64) };
  const ref = db.doc(`system/publicDeployment/switchAttempts/${operationId}`);
  await ref.create(attempt);
  const result = await runCurrentPublicReleaseSwitch({ ...options, operationId });
  expect(result).toMatchObject({ outcome: "unconfirmed", receipt: null, attempt });
  expect((await db.doc("system/publicDeployment").get()).updateTime).toEqual(before.updateTime);
  expect((await ref.get()).data()).toEqual(attempt);
});

it("reads the original committed receipt after the SDK loses the apply response and never repeats it", async () => {
  const db = fixture.selected.firestore;
  let dropped = false;
  // Firestore is the system boundary: execute the actual transaction, then
  // drop its reply once. No native owner or success receipt is mocked.
  const connection = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      const result = await (target.runTransaction as any)(...args);
      if (!dropped && result?.receipt?.operationId === forwardId) { dropped = true; throw new Error("Connection lost after commit"); }
      return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const result = await runCurrentPublicReleaseSwitch({ ...input(), firestore: connection });
  expect(dropped).toBe(true);
  expect(result).toMatchObject({ outcome: "committed", recovered: true, currentlySelected: true });
  const repeated = await runCurrentPublicReleaseSwitch(input());
  expect(repeated.receipt).toEqual(result.receipt);
  expect(repeated.currentSelector.epoch).toBe(result.receipt!.selector.epoch);
  expect((await db.collection("admin_logs").where("operationId", "==", forwardId).get()).size).toBe(1);
}, 120_000);

it("returns to OLD using NEW's current accepted work and keeps its original pending identity", async () => {
  const db = fixture.selected.firestore;
  await fixture.replayOperation(switches.switchChangeOperationId(forwardId));
  const story = (await db.doc("cmsPosts/story").get()).data()!;
  const next = { ...story, version: 10, publishBuildPending: true, publishBuildQueueId: publicationId,
    published: { ...story.published, sourceVersion: 10, metadata: { ...story.published.metadata, title: "Current NEW work" } } };
  await db.runTransaction(async transaction => {
    const accepted = await family.preparePairContentPublication({ firestore: db, transaction, collection: "cmsPosts", documentId: "story",
      nextDocument: next, queueRef: db.doc(`cmsPublishQueue/${publicationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
    accepted.write(); transaction.set(db.doc("cmsPosts/story"), next);
  });
  await fixture.replayOperation(publicationId);
  const original = (await db.doc(`system/publicReleaseAdmissions/operations/${publicationId}`).get()).data();
  const before = (await readPublicReleaseSwitchOutcome(input())).currentSelector;
  const result = await runCurrentPublicReleaseSwitch(input(true));
  expect(result.outcome).toBe("committed");
  expect(result.receipt!.selector.epoch).toBe(before.epoch + 1);
  expect(result.receipt!.selector.activeGeneration).toBe(before.activeGeneration + 1);
  expect(result.receipt!.selector.contentHead.contextSequence).toBe(4);
  expect((await db.doc(`system/publicReleaseAdmissions/operations/${publicationId}`).get()).data()).toEqual(original);
  expect((await db.doc(`cmsPublishQueue/${publicationId}`).get()).data()).toMatchObject({ status: "pending", execution: null,
    pair: protocol.publicReleasePairReference(fixture.pair) });
  expect((await db.doc(`system/publicReleaseAdmissions/pending/${publicationId}`).get()).exists).toBe(true);
  expect((await db.doc("cmsPosts/story").get()).data()!.published.sourceVersion).toBe(10);
  // A later return cannot erase the forward operation's historical result.
  expect(await readPublicReleaseSwitchOutcome(input())).toMatchObject({ outcome: "committed", currentlySelected: false });
}, 120_000);

it("observes pending NEW content through OLD without writes and rejects altered proof bytes or identity", async () => {
  const db = fixture.selected.firestore, pair = fixture.selected.pair;
  await fixture.replayOperation(switches.switchChangeOperationId(returnId));
  const latest = await replay.sealPublicReleasePairReplayWitness({ firestore: db, pair });
  const expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore: db, pair,
    headCursor: latest.witness.headCursor, witnessDigest: latest.witnessDigest });
  await advancePublicReleaseSwitchCodeHead({ firestore: db, store: objects.store, pair,
    identity: expanded.headView.identity, claimDigest: expanded.headView.claimDigest, manifestDigest: expanded.headView.manifestDigest });
  const router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore: db, environment: "development" }),
    slots: [fixture.pair, pair].map(side => createPublicReleaseSlot({ pair: side, workerVersionId: side.publicWorker.versionId,
      store: objects.store, getDecision: (selection, path) => serving.readPublicReleaseDecision({
        firestore: db, environment: "development", pair: side, selection, path, composedReadersEnabled: true }) })) });
  const accepted = (await db.doc(`system/publicReleaseAdmissions/operations/${publicationId}`).get()).data()!;
  const options = { firestore: db, store: { get: objects.store.get.bind(objects.store), put: async () => { throw new Error("Observer wrote storage"); } },
    ingress: { prove: router.prove }, pair, operationId: publicationId, path: "/posts/shadow-fixture/", sourceVersion: 10,
    snapshotDigest: accepted.source.snapshotDigest, status: 200 as const };
  const queueBefore = await db.doc(`cmsPublishQueue/${publicationId}`).get();
  const proof = await observeCurrentPublicReleaseOperation(options);
  expect(proof).toMatchObject({ operationId: publicationId, sourceVersion: 10, queueStatus: "pending", terminalReceiptDigest: null,
    originalPair: protocol.publicReleasePairReference(fixture.pair) });
  expect(proof.selector.selectedPair).toEqual(protocol.publicReleasePairReference(pair));
  expect((await db.doc(`cmsPublishQueue/${publicationId}`).get()).updateTime).toEqual(queueBefore.updateTime);
  for (const alteration of ["body", "identity"]) {
    await expect(observeCurrentPublicReleaseOperation({ ...options, ingress: { async prove(request, digest, expected) {
      const response = await router.prove(request, digest, expected), headers = new Headers(response.headers);
      const body = await response.arrayBuffer();
      if (alteration === "identity") headers.set("x-njpbs-publication-operation", "different-operation");
      return new Response(alteration === "body" ? "Altered bytes" : body, { status: response.status, headers });
    } } })).rejects.toThrow();
  }
  await expect(observeCurrentPublicReleaseOperation({ ...options, operationId: "wrong-operation" })).rejects.toThrow();
}, 120_000);
