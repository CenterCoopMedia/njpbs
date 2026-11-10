import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { FieldValue } from "firebase-admin/firestore";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { guardedPublicReleaseSwitchFixture } from "../helpers/guarded-public-release-switch";
import { createOriginalPublicReleaseContinuation } from "../../site/scripts/public-release-original-continuation";
import { prepareGuardedPublicReleaseSwitch, applyPreparedGuardedPublicReleaseSwitch } from "../../site/scripts/public-release-switch-operator";
import { qualifyPublicReleasePair } from "../../site/scripts/public-release-pair-qualification";
import { advancePublicReleaseSwitchCodeHead } from "../../site/scripts/public-release-switch-code-head";
import { releaseRehearsalPublicationHold } from "../../site/scripts/public-release-rehearsal-hold";
import { preparePublicReleasePublicationTerminal, settlePreparedPublicReleasePublication, releasePreparedPublicReleaseRehearsalHold } from "../../site/scripts/public-release-publication-terminal";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { pairTerminalRpc } from "../../publisher/pair-terminal-rpc";
import { pairOwnerWriteRpc } from "../../publisher/pair-owner-write-rpc";
import { pairOwnerEvidenceClient } from "../../publisher/pair-owner-evidence-client";
import { decodePairEvidenceFields } from "../../publisher/pair-work-reader";
import { publicReleaseTerminalTransport } from "../../site/scripts/public-release-terminal-transport";
import holds, { type RehearsalHoldPlan } from "../../functions/lib/public-release-rehearsal-hold.js";
import admission from "../../functions/lib/public-release-admission.js";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import work from "../../functions/lib/public-release-pair-work.js";
import serving from "../../functions/lib/public-release-serving.js";
import switches from "../../functions/lib/public-release-switch.js";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
const family = createRequire(import.meta.url)("../../functions/lib/public-release-family-admission.js"), networkFetch = globalThis.fetch;
let resources: Awaited<ReturnType<typeof publicReleaseR2Fixture>>, fixture: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
let plan: RehearsalHoldPlan, holdDigest: string, execution: any, completed: any;
let continuation: ReturnType<typeof createOriginalPublicReleaseContinuation>, boundPair: PublicReleasePair;
const db = () => fixture.selected.firestore, bucket = () => resources.store;
const options = () => ({ firestore: db(), ...publicReleaseTerminalTransport(plan.pair.environment), operationId: plan.operationId, fieldValues: FieldValue });
beforeAll(async () => {
  resources = await publicReleaseR2Fixture("rehearsal-hold-runtime");
  const database = isolatedFirestore("rehearsal-hold-runtime");
  fixture = await guardedPublicReleaseSwitchFixture(database, resources.store);
  const router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore: db(), environment: "development" }),
    slots: [fixture.selected.pair, fixture.pair].map(pair => createPublicReleaseSlot({ pair, workerVersionId: pair.publicWorker.versionId,
      store: bucket(), getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore: db(), environment: "development", pair,
        selection, path, composedReadersEnabled: true }) })) });
  const authority = () => ({ pair: boundPair, read: async (path: string) => (await db().doc(path).get()).data() ?? null,
    ...pairOwnerEvidenceClient({ pair: boundPair, projectId: database.projectId, token: "fixture-owner", decode: decodePairEvidenceFields,
      request: (input, init) => networkFetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}${new URL(String(input)).pathname}`, init) }) });
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init), host = new URL(request.url).hostname;
    if (host === "pair-owner-write.internal") return pairOwnerWriteRpc(request, bucket() as any, authority());
    if (host === "pair-terminal.internal") return pairTerminalRpc(request, bucket() as any, authority(), {
      prove: (request, digest, expected) => router.prove(request, digest, expected) });
    return networkFetch(input, init);
  });
}, 120_000);
afterAll(async () => { vi.unstubAllGlobals(); await fixture?.close(); await resources?.runtime.dispose(); });

async function acceptHeld(pair: PublicReleasePair, targetPair: PublicReleasePair, operationId: string, withdraw = false, runId = "real-two-direction-hold") {
  boundPair = pair;
  const firestore = db(), story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const root = protocol.parseStoredPublicReleaseSelector((await firestore.doc("system/publicDeployment").get()).data());
  const nextDocument = { ...story, version: story.version + 1, publishBuildPending: true, publishBuildQueueId: operationId,
    ...withdraw ? { publiclyVisible: false, status: "draft" } : { publiclyVisible: true, status: "published", published: { ...story.published, sourceVersion: story.version + 1,
      metadata: { ...story.published.metadata, title: "Held original across installed switch" } } } };
  plan = { schemaVersion: 2, runId, operationId, pair, targetPair, expectedEpoch: root.epoch,
    source: admission.publicationSource({ kind: "post", id: "story", action: withdraw ? "withdraw" : "publish", snapshot: nextDocument.published }),
    durationMs: 600_000, releaseActionId: `release-${operationId}`, cancelActionId: `cancel-${operationId}` };
  const intent = await holds.reserveRehearsalPublicationHold({ firestore, plan, enabled: true });
  holdDigest = protocol.publicReleaseDigest(intent);
  await firestore.runTransaction(async transaction => {
    const accepted = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story", nextDocument,
      queueRef: firestore.doc(`cmsPublishQueue/${operationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
    accepted.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
  });
  await fixture.replayOperation(operationId);
  const accepted = admission.parseAdmission((await firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`).get()).data());
  const bindings = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/sourceInputs`).get();
  const binding = bindings.docs.map(row => row.data()).find(row => row.scope.kind === "accepted" && row.scope.sourceOperationId === operationId)!;
  const identity = { schemaVersion: 2, pair: accepted.pair, ...binding.scope, inputManifestDigest: binding.inputManifestDigest };
  const g = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/receipts/${protocol.publicReleaseDigest(identity)}`).get()).data()!;
  completed = { identity, claimDigest: g.claimDigest, manifestDigest: g.manifestDigest };
  continuation = createOriginalPublicReleaseContinuation({ enabled: true, firestore, pair, store: bucket(),
    ingress: publicReleaseTerminalTransport("development").ingress, fieldValues: FieldValue });
  await continuation.completed!(completed);
  execution = (await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.execution;
  expect(execution).toMatchObject({ identity, claimDigest: g.claimDigest, manifestDigest: g.manifestDigest });
  expect((await holds.readRehearsalPublicationHold({ firestore, plan }))?.status).toBe("held");
  expect((await firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${operationId}`).get()).exists).toBe(false);
  return { identity, binding, g };
}
async function switchAndProve(name: string) {
  const firestore = db();
  for (const [i, pair] of [plan.pair, plan.targetPair].entries()) {
    const witness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
    await qualifyPublicReleasePair({ firestore, store: bucket(), pair, qualificationId: `${name}-${i}`,
      witnessDigest: witness.witnessDigest, credentials: fixture.transport.credentials });
  }
  const proof = await prepareGuardedPublicReleaseSwitch({ firestore, store: bucket(), oldPair: plan.pair, newPair: plan.targetPair,
    operationId: name, oldQualificationId: `${name}-0`, newQualificationId: `${name}-1` });
  const result = await applyPreparedGuardedPublicReleaseSwitch({ firestore, proof });
  expect(result.receipt.selector.epoch).toBe(plan.expectedEpoch + 1);
  await fixture.replayOperation(switches.switchChangeOperationId(name));
  const latest = await replay.sealPublicReleasePairReplayWitness({ firestore, pair: plan.targetPair });
  const opened = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair: plan.targetPair,
    headCursor: latest.witness.headCursor, witnessDigest: latest.witnessDigest });
  expect((await advancePublicReleaseSwitchCodeHead({ firestore, store: bucket(), pair: plan.targetPair,
    identity: opened.headView.identity, claimDigest: opened.headView.claimDigest, manifestDigest: opened.headView.manifestDigest })).status).toBe("activated");
  return preparePublicReleasePublicationTerminal(options());
}
async function releaseAndSettle(proof: Awaited<ReturnType<typeof preparePublicReleasePublicationTerminal>>) {
  const firestore = db(), input = { ...options(), plan, holdDigest, actionId: plan.releaseActionId, enabled: true };
  await expect(settlePreparedPublicReleasePublication({ firestore, proof })).rejects.toThrow(holds.RehearsalPublicationHeldError);
  expect((await holds.readRehearsalPublicationHold({ firestore, plan }))?.status).toBe("held");
  await expect(releaseRehearsalPublicationHold({ ...input, enabled: false })).rejects.toThrow();
  await expect(releaseRehearsalPublicationHold({ ...input, actionId: plan.cancelActionId })).rejects.toThrow();
  const releasePrepared = (extra: object = {}) => releasePreparedPublicReleaseRehearsalHold({ ...input, proof, ...extra });
  await expect(releasePrepared({ proof: { ...proof } })).rejects.toThrow();
  await expect(releasePrepared({ holdDigest: "0".repeat(64) })).rejects.toThrow();
  await expect(releasePrepared({ plan: { ...plan, operationId: "Z".repeat(20) } })).rejects.toThrow();
  await expect(releasePrepared({ plan: { ...plan, targetPair: plan.pair } })).rejects.toThrow();
  // Change actual SDK authority after opaque preparation, then restore it.
  // The release-only transaction must repeat the original terminal guards.
  const rootRef = firestore.doc("system/publicDeployment"), root = (await rootRef.get()).data()!;
  await rootRef.update({ epoch: root.epoch + 1 });
  await expect(releasePrepared()).rejects.toThrow();
  await rootRef.set(root);
  const gRef = firestore.doc(`${work.publicReleasePairPath(plan.pair.pairId)}/receipts/${execution.taskId}`), g = (await gRef.get()).data()!;
  await gRef.update({ claimDigest: "0".repeat(64) });
  await expect(releasePrepared()).rejects.toThrow();
  await gRef.set(g);
  expect((await firestore.doc(`${holds.path(plan.operationId)}/receipts/outcome`).get()).exists).toBe(false);
  const released = await releaseRehearsalPublicationHold(input);
  expect(released.outcome).toMatchObject({ outcome: "released", holdDigest, evidence: {
    epoch: plan.expectedEpoch + 1, selectedPair: protocol.publicReleasePairReference(plan.targetPair), executionDigest: protocol.publicReleaseDigest(execution) } });
  expect((await firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${plan.operationId}`).get()).exists).toBe(false);
  // Recreate the original runtime after release: no replacement queue/claim and
  // no manual future clock. The normal post-G entrypoint completes the original.
  continuation = createOriginalPublicReleaseContinuation({ enabled: true, firestore, pair: plan.pair, store: bucket(),
    ingress: publicReleaseTerminalTransport("development").ingress, fieldValues: FieldValue });
  await continuation.completed!(completed);
  const queue = (await firestore.doc(`cmsPublishQueue/${plan.operationId}`).get()).data()!;
  expect(queue).toMatchObject({ status: "success", execution, pair: protocol.publicReleasePairReference(plan.pair) });
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${plan.operationId}`).get()).exists).toBe(false);
  expect((await firestore.collection("admin_logs").where("action", "==", "public-release.publication-settle").get()).docs.filter(row => row.data().target === `cmsPublishQueue/${plan.operationId}`)).toHaveLength(1);
  expect((await releaseRehearsalPublicationHold(input)).outcome).toEqual(released.outcome);
  expect((await holds.reserveRehearsalPublicationHold({ firestore, plan, enabled: true })).plan).toEqual(plan);
}

it("holds the exact original OLD operation while real H/G staging and both replays complete", async () => {
  await acceptHeld(fixture.selected.pair, fixture.pair, "O".repeat(20));
  await expect(releaseRehearsalPublicationHold({ ...options(), plan, holdDigest, actionId: plan.releaseActionId, enabled: true })).rejects.toThrow();
  expect((await holds.readRehearsalPublicationHold({ firestore: db(), plan }))?.status).toBe("held");
}, 120_000);
it("requires the actual NEW switch and complete canonical inclusion before releasing and settling OLD once", async () => {
  const proof = await switchAndProve("hold-switch-new");
  await releaseAndSettle(proof);
}, 120_000);
it("holds the exact NEW withdrawal while preserving its original source and claim", async () => {
  await acceptHeld(fixture.pair, fixture.selected.pair, "N".repeat(20), true);
}, 120_000);
it("releases NEW only after current-content return with a new epoch and real withdrawal/aggregate inclusion", async () => {
  const proof = await switchAndProve("hold-return-old");
  await releaseAndSettle(proof);
  expect((await db().doc("cmsPosts/story").get()).data()!.publiclyVisible).toBe(false);
}, 120_000);

it("backs off a superseded hold so another original on that pair still gets the due-recovery slot", async () => {
  const firestore = db(), pair = fixture.selected.pair, operationId = "P".repeat(20), successorId = "S".repeat(20);
  await acceptHeld(pair, fixture.pair, operationId, false, "hold-supersession");
  const heldPlan = plan, heldDigest = holdDigest, originalCompleted = completed;
  async function acceptNext(id: string) {
    const story = (await firestore.doc("cmsPosts/story").get()).data()!;
    const nextDocument = { ...story, version: story.version + 1, publishBuildPending: true, publishBuildQueueId: id,
      published: { ...story.published, sourceVersion: story.version + 1,
        metadata: { ...story.published.metadata, title: `Successor ${id}` } } };
    await firestore.runTransaction(async transaction => {
      const accepted = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story", nextDocument,
        queueRef: firestore.doc(`cmsPublishQueue/${id}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
      accepted.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
    });
  }
  await acceptNext(successorId);
  await fixture.replayOperation(successorId);
  const inputs = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/sourceInputs`).get();
  const binding = inputs.docs.map(row => row.data()).find(row => row.scope.kind === "accepted" && row.scope.sourceOperationId === successorId)!;
  const identity = { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...binding.scope, inputManifestDigest: binding.inputManifestDigest };
  const g = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/receipts/${protocol.publicReleaseDigest(identity)}`).get()).data()!;
  await continuation.completed!({ identity, claimDigest: g.claimDigest, manifestDigest: g.manifestDigest });
  expect((await firestore.doc(`cmsPublishQueue/${successorId}`).get()).data()!.status).toBe("success");
  expect((await holds.readRehearsalPublicationHold({ firestore, plan: heldPlan }))?.status).toBe("held");
  await continuation.completed!(originalCompleted);
  const pending = (await firestore.doc(admission.publicationPendingPath(pair.pairId, operationId)).get()).data()!;
  expect(pending).toMatchObject({ recoveryFailure: "rehearsal-hold-pending", continuationFailures: 0, continuationDeferrals: 1 });
  expect(pending.nextAttemptAt).toBeGreaterThan(0);
  expect((await firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${operationId}`).get()).exists).toBe(false);
  const unrelatedId = "U".repeat(20);
  await acceptNext(unrelatedId);
  const due = await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/publicationPending`)
    .where("nextAttemptAt", "<=", Date.now()).limit(1).get();
  expect(due.docs[0].id).toBe(unrelatedId);
  await holds.cancelRehearsalPublicationHold({ firestore, plan: heldPlan, enabled: true, holdDigest: heldDigest, actionId: heldPlan.cancelActionId });
}, 120_000);
