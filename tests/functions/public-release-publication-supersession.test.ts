import { afterAll, beforeAll, expect, it } from "vitest";
import { createRequire } from "node:module";
import { Miniflare } from "miniflare";
import { FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";
import { activateStagedPublicReleasePairPublication } from "../../site/scripts/public-release-pair-content-activation";
import { preparePublicReleasePublicationTerminal, preparePublicReleasePublicationSupersession, settlePreparedPublicReleasePublication } from "../../site/scripts/public-release-publication-terminal";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import work from "../../functions/lib/public-release-pair-work.js";
import p from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import serving from "../../functions/lib/public-release-serving.js";
const require = createRequire(import.meta.url), family = require("../../functions/lib/public-release-family-admission.js");
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const originalId = "A".repeat(20), successorId = "B".repeat(20), newestId = "C".repeat(20);
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "terminal-owner", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "terminal-owner" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  fixture = await switchedPairFixture(isolatedFirestore("publication-supersession-owner"), store);
  const { firestore, pair } = fixture;
  const code = await fixture.captureCode();
  const authorityRow = code.root.files.find(file => file.name === "authority.json")!;
  const authorityObject = await store.get(authorityRow.objectKey);
  const authority = await new Response(authorityObject!.body).json() as any;
  const codeEntry = (await firestore.doc("system/publicReleaseChanges/entries/0000000000000001").get()).data()!;
  expect(authority.readerSource).toBe(pair.commitSha);
  expect(codeEntry.pair.commitSha).toBe(fixture.sourcePair.commitSha);
  const codeTask = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
    input: { ...code.root.scope, inputManifestDigest: code.receipt.inputManifestDigest } }));
  await stagedPublicReleasePairCompositeFixture({ ...fixture, content: code, taskId: codeTask.taskId }, store);
  await accept(originalId, 10);
  // Complete A's genuine staged history so contiguous replay can reach B,
  // while its original queue still has no discovered execution descriptor.
  await render(originalId, false);
  await accept(successorId, 11);
  await render(successorId);
}, 120_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });
async function accept(operationId: string, version: number) {
  const { firestore } = fixture, story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const nextDocument = { ...story, version, publishBuildPending: true, publishBuildQueueId: operationId,
    published: { ...story.published, sourceVersion: version, metadata: { ...story.published.metadata, title: `Publication ${version}` } } };
  await firestore.runTransaction(async transaction => {
    const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
      nextDocument, queueRef: firestore.doc(`cmsPublishQueue/${operationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
    prepared.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
  });
}
async function render(operationId: string, activate = true) {
  const { firestore, pair } = fixture;
  const queued = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId,
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resources"); } } });
  expect(queued.status).toBe("queued");
  const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: queued.taskId! }, store);
  if (!activate) return;
  const rendered = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId, now: () => Date.now() + 31_000 });
  expect(rendered.status).toBe("rendered");
  await activateStagedPublicReleasePairPublication({ firestore, store, pair, identity: staged.claim.identity,
    claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest });
}
it("supersedes the original only with a later same-source FACT and fresh current canonical bytes", async () => {
  const { firestore, pair, sourcePair } = fixture;
  const router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }),
    slots: [pair, sourcePair].map(side => createPublicReleaseSlot({ pair: side, workerVersionId: side.publicWorker.versionId, store,
      getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair: side,
        selection, path, composedReadersEnabled: true }) })) });
  const options = { firestore, store, fieldValues: FieldValue, ingress: router };
  const supersede = (successorOperationId: string) => preparePublicReleasePublicationSupersession({ ...options,
    operationId: originalId, successorOperationId });
  const success = async (operationId: string) => settlePreparedPublicReleasePublication({ firestore,
    proof: await preparePublicReleasePublicationTerminal({ ...options, operationId }) });
  const originalPending = async (count: number) => {
    expect((await firestore.doc(`cmsPublishQueue/${originalId}`).get()).data()).toMatchObject({ status: "pending", execution: null });
    expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${originalId}`).get()).exists).toBe(true);
    expect((await firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${originalId}`).get()).exists).toBe(false);
    expect((await firestore.doc(admission.ADMISSIONS).get()).data()!.pendingCount).toBe(count);
  };
  // An activated/rendered successor still lacks a successful terminal FACT.
  await expect(supersede(successorId)).rejects.toThrow();
  await originalPending(2);
  expect((await success(successorId)).receipt.outcome).toBe("success");
  const stale = await supersede(successorId);
  // A real third publication changes current ownership; no prepared B proof
  // can clear A or C until C itself completes and is canonically proven.
  await accept(newestId, 12);
  await expect(settlePreparedPublicReleasePublication({ firestore, proof: stale })).rejects.toThrow();
  await expect(supersede(successorId)).rejects.toThrow();
  await originalPending(2);
  expect((await firestore.doc("cmsPosts/story").get()).data()!.publishBuildQueueId).toBe(newestId);
  await render(newestId);
  const newest = await success(newestId);
  const proof = await supersede(newestId);
  await firestore.doc("cmsPosts/story").update({ version: 13, title: "Private draft after newest public version" });
  const result = await settlePreparedPublicReleasePublication({ firestore, proof });
  expect(result.receipt).toMatchObject({ outcome: "superseded", originalExecution: null,
    supersededBy: { operationId: newestId, terminalReceiptDigest: p.publicReleaseDigest(newest.receipt) } });
  expect((await firestore.doc(`cmsPublishQueue/${originalId}`).get()).data()).toMatchObject({ status: "superseded", execution: null });
  expect((await firestore.doc(`cmsPublishQueue/${successorId}`).get()).data()!.status).toBe("success");
  expect((await firestore.doc("cmsPosts/story").get()).data()).toMatchObject({ version: 13,
    title: "Private draft after newest public version", publicSourceVersion: 12, publishBuildPending: false, publishBuildQueueId: null });
  expect((await firestore.doc(admission.ADMISSIONS).get()).data()).toMatchObject({ pendingCount: 0, pendingDigest: "0".repeat(64) });
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${originalId}`).get()).exists).toBe(false);
  expect((await firestore.doc(admission.publicationPendingPath(pair.pairId, originalId)).get()).exists).toBe(false);
  const terminal = require("../../functions/lib/public-release-terminal.js");
  expect(await firestore.runTransaction(transaction => terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore, transaction,
    operationId: originalId, admissionDigest: result.receipt.admissionDigest }))).toEqual(result.receipt);
  const queue = await firestore.doc(`cmsPublishQueue/${originalId}`).get();
  expect((await settlePreparedPublicReleasePublication({ firestore, proof })).idempotent).toBe(true);
  expect((await queue.ref.get()).updateTime!.isEqual(queue.updateTime!)).toBe(true);
  expect((await firestore.collection("admin_logs").where("action", "==", "public-release.publication-settle").get()).size).toBe(3);
  expect((await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId: originalId })).status).toBe("missing");
}, 240_000);
