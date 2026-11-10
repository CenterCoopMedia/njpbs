import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { guardedPublicReleaseSwitchFixture } from "../helpers/guarded-public-release-switch";
import { advancePublicReleaseSwitchCodeHead } from "../../site/scripts/public-release-switch-code-head";
import p from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import switches from "../../functions/lib/public-release-switch.js";
import writer from "../../functions/lib/public-release-writer-fence.js";
import admission from "../../functions/lib/public-release-admission.js";
import { bumpPublicContextRevision } from "../../functions/lib/public-context-revision.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import inputs from "../../functions/lib/public-release-pair-input.js";
import activation from "../../functions/lib/public-release-content-activation.js";
import { openPublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof guardedPublicReleaseSwitchFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>, first: any;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "code-head", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "code-head" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  fixture = await guardedPublicReleaseSwitchFixture(isolatedFirestore("switch-code-head"), store);
}, 120_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });
const options = () => ({ firestore: fixture.selected.firestore, store, pair: fixture.selected.pair,
  identity: fixture.oldView.identity, claimDigest: fixture.oldView.claimDigest, manifestDigest: fixture.oldView.manifestDigest });
async function acceptProvider(operationId: string, sourceVersion: number) {
  const { firestore } = options();
  await firestore.runTransaction(async transaction => {
    const context = (await transaction.get(firestore.doc("system/publicDeployment/contexts/public"))).data()!;
    const change = { kind: "provider" as const, id: "external-inputs", action: "dependency" as const, sourceVersion, snapshot: context.externalInputs };
    const accepted = await admission.preparePairPublicationInTransaction({ firestore, transaction, operationId,
      source: admission.publicationSource(change), change, contextRevision: context.revision + 1 });
    accepted.write(); bumpPublicContextRevision(transaction, firestore);
  });
}
it("reports actual log/replay lag as retryable pending without advancing authority", async () => {
  const { firestore } = options(), operationId = "code-head-lag";
  const before = (await firestore.doc(switches.ROOT).get()).data();
  await acceptProvider(operationId, 2);
  await expect(advancePublicReleaseSwitchCodeHead(options())).rejects.toMatchObject({ code: "switch-code-replay-pending" });
  expect((await firestore.doc(switches.ROOT).get()).data()).toEqual(before);
  expect((await firestore.collection(`${work.publicReleasePairPath(options().pair.pairId)}/switchCodeActivations`).get()).empty).toBe(true);
  await fixture.replayOperation(operationId);
}, 120_000);
it("classifies a real source/log append during outside preparation as a retryable conflict", async () => {
  const { firestore, pair } = options(), sealed = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
  const expanded = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair,
    headCursor: sealed.witness.headCursor, witnessDigest: sealed.witnessDigest });
  const identity = expanded.headView.identity, raw = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/inputs/${identity.inputManifestDigest}`).get()).data()!;
  const captured = inputs.parsePublicReleasePairInputReceipt(raw, pair, raw.scope, identity.inputManifestDigest);
  const frozen = await openPublicReleasePairInput({ firestore, store, pair, identity, expectedSource: captured.source, expectedCursor: captured.cursor });
  const key = frozen.root.files.find(file => file.name === "source-metadata.json")!.objectKey;
  let moved = false;
  const racingStore = { put: store.put.bind(store), async get(objectKey: string) {
    const value = await store.get(objectKey);
    if (objectKey === key && !moved) { moved = true; await acceptProvider("code-head-race", 3); }
    return value;
  } };
  await expect(advancePublicReleaseSwitchCodeHead({ ...options(), store: racingStore })).rejects.toBeInstanceOf(activation.ContentActivationConflictError);
  expect(moved).toBe(true);
  expect((await firestore.collection(`${work.publicReleasePairPath(pair.pairId)}/switchCodeActivations`).get()).empty).toBe(true);
  await fixture.replayOperation("code-head-race");
}, 120_000);
it("refuses a real shared-writer conflict before advancing the selected head", async () => {
  const { firestore } = options(), before = (await firestore.doc(switches.ROOT).get()).data();
  await firestore.doc(writer.RELEASE_WRITER_FENCE_PATH).create({ schemaVersion: 2, operationId: "another-release-writer", attemptDigest: "f".repeat(64) });
  try { await expect(advancePublicReleaseSwitchCodeHead(options())).rejects.toBeInstanceOf(p.PublicReleaseProtocolError); }
  finally { await firestore.doc(writer.RELEASE_WRITER_FENCE_PATH).delete(); }
  expect((await firestore.doc(switches.ROOT).get()).data()).toEqual(before);
  expect((await firestore.collection(`${work.publicReleasePairPath(options().pair.pairId)}/switchCodeActivations`).get()).empty).toBe(true);
}, 120_000);
it("uses actual CODE/H/G/replay/source owners to move only the head and media reference", async () => {
  const { firestore, pair } = options(), before = p.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data());
  const admissions = (await firestore.doc("system/publicReleaseAdmissions").get()).data();
  const pins = (await firestore.doc("system/cmsPublicationRuntime").get()).data();
  first = await advancePublicReleaseSwitchCodeHead(options());
  expect(first.status).toBe("activated"); expect(first.idempotent).toBe(false);
  const after = p.parseStoredPublicReleaseSelector((await firestore.doc(switches.ROOT).get()).data());
  expect(after.contentHead.contextSequence).toBe(4);
  expect(after.epoch).toBe(before.epoch); expect(after.activeGeneration).toBe(before.activeGeneration);
  expect(after.selectedPair).toEqual(before.selectedPair); expect(after.recoveryPair).toEqual(before.recoveryPair);
  expect(after.switchOperationId).toBe(before.switchOperationId);
  expect((await firestore.doc("system/publicReleaseAdmissions").get()).data()).toEqual(admissions);
  expect((await firestore.doc("system/cmsPublicationRuntime").get()).data()).toEqual(pins);
  expect((await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/heads/current`).get()).data()!.contentHead).toEqual(after.contentHead);
  expect((await firestore.doc(switches.MEDIA).get()).data()!.references.find((reference: any) => reference.pairId === pair.pairId).manifestDigest)
    .toBe(after.contentHead.manifestDigest);
  expect((await firestore.doc("cmsPublishQueue/candidate-media-ready").get()).data()!.status).toBe("pending");
  expect((await firestore.collection("system/publicReleaseAdmissions/terminalReceipts").get()).empty).toBe(true);
}, 120_000);
it("recovers the original CODE receipt without relabeling a different claim or changing the head again", async () => {
  const { firestore, pair } = options(), path = `${work.publicReleasePairPath(pair.pairId)}/switchCodeActivations/${fixture.oldView.identity.sourceOperationId}`;
  const row = await firestore.doc(path).get(), root = await firestore.doc(switches.ROOT).get();
  const repeated = await advancePublicReleaseSwitchCodeHead(options());
  expect(repeated).toEqual({ ...first, idempotent: true });
  expect((await row.ref.get()).updateTime!.isEqual(row.updateTime!)).toBe(true);
  expect((await root.ref.get()).updateTime!.isEqual(root.updateTime!)).toBe(true);
  await expect(advancePublicReleaseSwitchCodeHead({ ...options(), claimDigest: "f".repeat(64) })).rejects.toThrow();
  const saved = row.data()!, selector = { ...saved.selector,
    contentHead: { ...saved.selector.contentHead, contextSequence: fixture.oldView.identity.contextSequence - 1 } };
  await row.ref.set({ ...saved, selector, selectorDigestAfter: p.publicReleaseDigest(selector) });
  try { await expect(advancePublicReleaseSwitchCodeHead(options())).rejects.toThrow(); }
  finally { await row.ref.set(saved); }
});
