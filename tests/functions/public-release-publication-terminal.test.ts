import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { Miniflare } from "miniflare";
import { FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";
import { activateStagedPublicReleasePairPublication } from "../../site/scripts/public-release-pair-content-activation";
import { preparePublicReleasePublicationTerminal, settlePreparedPublicReleasePublication } from "../../site/scripts/public-release-publication-terminal";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import work from "../../functions/lib/public-release-pair-work.js";
import p from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import serving from "../../functions/lib/public-release-serving.js";
import { pairTerminalRpc } from "../../publisher/pair-terminal-rpc";
import { publicReleaseTerminalTransport } from "../../site/scripts/public-release-terminal-transport";
const require = createRequire(import.meta.url), family = require("../../functions/lib/public-release-family-admission.js");
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const operationId = "T".repeat(20);
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "terminal-owner", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "terminal-owner" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  fixture = await switchedPairFixture(isolatedFirestore("publication-terminal-owner"), store);
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
  const story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const nextDocument = { ...story, version: 10, publishBuildPending: true, publishBuildQueueId: operationId,
    published: { ...story.published, sourceVersion: 10, metadata: { ...story.published.metadata, title: "Original terminal publication" } } };
  await firestore.runTransaction(async transaction => {
    const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
      nextDocument, queueRef: firestore.doc(`cmsPublishQueue/${operationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
    prepared.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
  });
  const queued = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId,
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resources"); } } });
  expect(queued.status).toBe("queued");
  const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: queued.taskId! }, store);
  const rendered = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId, now: () => Date.now() + 31_000 });
  expect(rendered.status).toBe("rendered");
  await activateStagedPublicReleasePairPublication({ firestore, store, pair, identity: staged.claim.identity,
    claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest });
}, 120_000);
afterAll(async () => { vi.unstubAllGlobals(); await fixture?.close(); await runtime?.dispose(); });
it("settles only after actual activation and full canonical SDK/R2 ingress proof", async () => {
  const { firestore, pair, sourcePair } = fixture;
  const router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }),
    slots: [pair, sourcePair].map(side => createPublicReleaseSlot({ pair: side, workerVersionId: side.publicWorker.versionId, store,
      getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair: side,
        selection, path, composedReadersEnabled: true }) })) });
  const actualIngress = { async prove(request: Request, digest: string, expected: { status: 200 | 308 | 410 }) {
    const response = await router.prove(request, digest, expected);
    if (response.status !== expected.status) throw new Error(`Actual canonical proof refused ${new URL(request.url).pathname}: ${response.status}`);
    return response;
  } };
  // Route the Node adapter's fixed private host through the actual Worker
  // handler, SDK authority, R2 bucket and canonical router proof binding.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => pairTerminalRpc(new Request(input, init), store as any,
    { pair, read: async path => (await firestore.doc(path).get()).data() ?? null }, actualIngress));
  const { ingress, store: terminalStore } = publicReleaseTerminalTransport(pair.environment);
  const pendingUnchanged = async () => {
    expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.status).toBe("pending");
    expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(true);
    expect((await firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${operationId}`).get()).exists).toBe(false);
    expect((await firestore.doc(admission.ADMISSIONS).get()).data()!.pendingCount).toBe(1);
  };
  await expect(preparePublicReleasePublicationTerminal({ firestore, store, operationId, fieldValues: FieldValue,
    ingress: { prove: request => router.fetch(request) } })).rejects.toThrow();
  await pendingUnchanged();
  let clock = 10_000;
  const expires = await preparePublicReleasePublicationTerminal({ firestore, store: terminalStore, ingress, operationId, fieldValues: FieldValue, now: () => clock });
  clock += 3_000;
  await expect(settlePreparedPublicReleasePublication({ firestore, proof: expires })).rejects.toThrow();
  clock = Number.NaN;
  await expect(settlePreparedPublicReleasePublication({ firestore, proof: expires })).rejects.toThrow();
  await pendingUnchanged();
  const proof = await preparePublicReleasePublicationTerminal({ firestore, store: terminalStore, ingress, operationId, fieldValues: FieldValue });
  await expect(settlePreparedPublicReleasePublication({ firestore, proof: { ...proof } })).rejects.toThrow();
  await expect(settlePreparedPublicReleasePublication({ firestore: isolatedFirestore("terminal-wrong-client"), proof })).rejects.toThrow();
  await firestore.doc("system/billing").update({ disabled: true });
  try { await expect(settlePreparedPublicReleasePublication({ firestore, proof })).rejects.toThrow(); await pendingUnchanged(); }
  finally { await firestore.doc("system/billing").update({ disabled: false }); }
  await firestore.doc("cmsPosts/story").update({ version: 11, title: "Private working edit after proof", blocks: [{ id: "private-block" }] });
  const result = await settlePreparedPublicReleasePublication({ firestore, proof });
  expect(result.idempotent).toBe(false); expect(result.receipt.outcome).toBe("success");
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "success", terminalReceipt: p.publicReleaseDigest(result.receipt) });
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.completedAt.toMillis()).toBeGreaterThan(0);
  const logs = await firestore.collection("admin_logs").where("action", "==", "public-release.publication-settle").get();
  expect(logs.size).toBe(1);
  expect(logs.docs[0].data()).toMatchObject({ actorUid: "system:public-release-terminal", source: "public-release-terminal" });
  expect(logs.docs[0].data().timestamp.toMillis()).toBeGreaterThan(0);
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(false);
  expect((await firestore.doc(admission.ADMISSIONS).get()).data()).toMatchObject({ pendingCount: 0, pendingDigest: "0".repeat(64) });
  expect((await firestore.doc("cmsPosts/story").get()).data()).toMatchObject({ version: 11, title: "Private working edit after proof",
    blocks: [{ id: "private-block" }], published: { sourceVersion: 10 },
    publishBuildPending: false, publishBuildQueueId: null, publicSourceVersion: 10 });
  const beforeRepeat = await firestore.doc(`cmsPublishQueue/${operationId}`).get();
  expect((await settlePreparedPublicReleasePublication({ firestore, proof })).idempotent).toBe(true);
  expect((await beforeRepeat.ref.get()).updateTime!.isEqual(beforeRepeat.updateTime!)).toBe(true);
  expect((await firestore.collection("admin_logs").where("action", "==", "public-release.publication-settle").get()).size).toBe(1);
}, 120_000);
