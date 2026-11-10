import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleaseR2Fixture } from "../helpers/public-release-r2-fixture";
import { guardedPublicReleaseSwitchFixture } from "../helpers/guarded-public-release-switch";
import { createRehearsalPublicOwners } from "../../scripts/lib/rehearsal-public-owners.mjs";
import { rehearsalOperationId } from "../../scripts/lib/public-release-rehearsal.mjs";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { advancePublicReleaseSwitchCodeHead } from "../../site/scripts/public-release-switch-code-head";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import serving from "../../functions/lib/public-release-serving.js";
import switches from "../../functions/lib/public-release-switch.js";
import { qualificationReceiptPath } from "../../site/scripts/public-release-pair-qualification-receipt";
import { readRehearsalReturnAudit } from '../../scripts/lib/rehearsal-installed-audit.mjs';

// Owner composition proof with small sealed renderer fixtures and actual
// SDK/R2/private-reader/router boundaries. Not a compiled release rehearsal.
describe.sequential("actual rehearsal public owners", () => {
  let binding: Awaited<ReturnType<typeof publicReleaseR2Fixture>>;
  let fixture: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
  let firestore: ReturnType<typeof isolatedFirestore>;
  let owners: ReturnType<typeof createRehearsalPublicOwners>, packet: any;
  let heldOld: string, heldNew: string, forward: string, returned: string;
  let initialEpoch: number;
  let oldExecution: any, newExecution: any;
  let ownerOptions: any, failedQualification: any;
  beforeAll(async () => {
    for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) vi.stubEnv(key, undefined);
    binding = await publicReleaseR2Fixture("rehearsal-public-owners");
    firestore = isolatedFirestore("rehearsal-public-owners");
    fixture = await guardedPublicReleaseSwitchFixture(firestore, binding.store);
    const oldPair = fixture.selected.pair, newPair = fixture.pair;
    initialEpoch = protocol.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data()).epoch;
    packet = { schemaVersion: 1, runId: "rehearsal-owner-proof", projectId: firestore.projectId,
      emulatorHost: process.env.FIRESTORE_EMULATOR_HOST, ingressOrigin: "http://127.0.0.1:18396", proofOrigin: "http://127.0.0.1:18397",
      adapter: resolve("scripts/lib/public-release-rehearsal-adapter.mjs"), oldPair, newPair,
      previewPairs: { old: { pairId: "preview-old", rendererSha: oldPair.commitSha, serializerId: "preview-old" },
        new: { pairId: "preview-new", rendererSha: newPair.commitSha, serializerId: "preview-new" } } };
    const router = createPublicReleaseRouter({ environment: "development",
      readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }),
      slots: [oldPair, newPair].map(pair => createPublicReleaseSlot({ pair, workerVersionId: pair.publicWorker.versionId, store: binding.store,
        getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair, selection, path, composedReadersEnabled: true }) })) });
    ownerOptions = { packet, firestore, store: binding.store, credentials: fixture.transport.credentials,
      ingress: { prove: (request: Request, digest: string, expected: { status: 200 | 308 | 410 }) => router.prove(request, digest, expected) },
      fieldValues: FieldValue, authorized: true };
    owners = createRehearsalPublicOwners(ownerOptions);
    heldOld = rehearsalOperationId(packet, "hold-old"); heldNew = rehearsalOperationId(packet, "hold-new");
    forward = rehearsalOperationId(packet, "switch-new"); returned = rehearsalOperationId(packet, "return-old");
  }, 120_000);
  afterAll(async () => { try { await fixture?.close(); await binding?.runtime.dispose(); } finally { vi.unstubAllEnvs(); } });

  async function hold(operationId: string, title: string) {
    const source = firestore.doc("cmsPosts/story"), story = (await source.get()).data()!;
    const nextDocument = { ...story, version: story.version + 1, publishBuildPending: true, publishBuildQueueId: operationId,
      published: { ...story.published, sourceVersion: story.version + 1, metadata: { ...story.published.metadata, title } } };
    const accepted = await owners.acceptPost({ operationId, documentId: "story", nextDocument });
    await fixture.replayOperation(operationId);
    const original = await owners.recover(operationId);
    expect(original.status).toBe("rendered");
    expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "pending", execution: original.execution });
    return { accepted, execution: original.execution };
  }
  async function advanceCode(operationId: string, pair: typeof fixture.pair) {
    await fixture.replayOperation(switches.switchChangeOperationId(operationId));
    const witness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
    const current = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair,
      headCursor: witness.witness.headCursor, witnessDigest: witness.witnessDigest });
    expect((await advancePublicReleaseSwitchCodeHead({ firestore, store: binding.store, pair,
      identity: current.headView.identity, claimDigest: current.headView.claimDigest, manifestDigest: current.headView.manifestDigest })).status).toBe("activated");
  }

  it("accepts and completes the original held OLD claim without settling it", async () => {
    const held = await hold(heldOld, "Held original OLD"); oldExecution = held.execution;
    expect(held.accepted.pair).toEqual(protocol.publicReleasePairReference(packet.oldPair));
  });
  it('retains a failed pre-reservation qualification as immutable evidence for a fresh switch retry', async () => {
    const collection = firestore.doc(qualificationReceiptPath(packet.oldPair, 'rehearsal-lookup')).parent;
    const before = await collection.get(), known = new Set(before.docs.map(row => row.id));
    const failing = createRehearsalPublicOwners({ ...ownerOptions, credentials: async () => {
      if ((await collection.get()).size > before.size) throw new Error('Private NEW reader temporarily unavailable');
      return fixture.transport.credentials();
    } });
    await expect(failing.switchTo('new', forward)).rejects.toThrow();
    failedQualification = (await collection.get()).docs.find(row => !known.has(row.id));
    expect(failedQualification).toBeDefined();
    expect((await firestore.doc(`${switches.ATTEMPTS}/${forward}`).get()).exists).toBe(false);
  });
  it("qualifies current held work, switches through the actual guard and recovers the original switch receipt", async () => {
    const receipt = await owners.switchTo("new", forward);
    expect(receipt.selector.selectedPair).toEqual(protocol.publicReleasePairReference(packet.newPair));
    expect(receipt.selector.epoch).toBe(initialEpoch + 1);
    const root = await firestore.doc(switches.ROOT).get();
    expect(await owners.switchTo("new", forward)).toEqual(receipt);
    await expect(owners.switchTo("old", forward)).rejects.toThrow();
    expect((await root.ref.get()).updateTime!.isEqual(root.updateTime!)).toBe(true);
    expect((await failedQualification.ref.get()).updateTime.isEqual(failedQualification.updateTime)).toBe(true);
    const oldReceipts = await failedQualification.ref.parent.get();
    expect(oldReceipts.docs.some(row => row.id !== failedQualification.id && row.data().witnessDigest === failedQualification.data().witnessDigest)).toBe(true);
  });
  it("advances actual switch CODE through its complete current replay", async () => {
    await advanceCode(forward, packet.newPair);
  });
  it("settles held OLD through NEW under the unchanged original execution", async () => {
    const result = await owners.finish(heldOld);
    expect(result.receipt.outcome).toBe("success");
    expect((await firestore.doc(`cmsPublishQueue/${heldOld}`).get()).data()).toMatchObject({ status: "success", execution: oldExecution });
    expect((await owners.finish(heldOld)).receipt).toEqual(result.receipt);
  });
  it("accepts and completes the original held NEW claim at current content", async () => {
    await expect(readRehearsalReturnAudit({ firestore, packet, authorized: true })).rejects.toThrow();
    const held = await hold(heldNew, "Held current original NEW"); newExecution = held.execution;
    expect(held.accepted.pair).toEqual(protocol.publicReleasePairReference(packet.newPair));
  });
  it("returns through the actual current-head qualifications and inclusion census", async () => {
    const receipt = await owners.switchTo("old", returned);
    expect(receipt.selector.selectedPair).toEqual(protocol.publicReleasePairReference(packet.oldPair));
    expect(receipt.selector.epoch).toBe(initialEpoch + 2);
    expect(await readRehearsalReturnAudit({ firestore, packet, authorized: true })).toMatchObject({ returnUsedCurrentContent: true });
  });
  it("advances actual return CODE through its complete current replay", async () => {
    await advanceCode(returned, packet.oldPair);
  });
  it("settles held NEW through OLD without replacing its claim", async () => {
    expect((await owners.finish(heldNew)).receipt.outcome).toBe("success");
    expect((await firestore.doc(`cmsPublishQueue/${heldNew}`).get()).data()).toMatchObject({ status: "success", execution: newExecution });
  });
});
