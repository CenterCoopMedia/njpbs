import { afterAll, beforeAll, expect, it } from "vitest";
import { createRequire } from "node:module";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";
import { activateStagedPublicReleasePairPublication } from "../../site/scripts/public-release-pair-content-activation";
import work from "../../functions/lib/public-release-pair-work.js";
import p from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
const family = createRequire(import.meta.url)("../../functions/lib/public-release-family-admission.js");
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "switch-reader-controls", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "switch-reader-controls" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  fixture = await switchedPairFixture(isolatedFirestore("switch-reader-controls"), store);
}, 30_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });
it("keeps one sealed reader identity through a real guarded switch, original work and actual activation", async () => {
  const { firestore, pair } = fixture, code = await fixture.captureCode();
  expect(fixture.readerCalls()).toBeGreaterThan(0);
  const codeTask = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
    input: { ...code.root.scope, inputManifestDigest: code.receipt.inputManifestDigest } }));
  await stagedPublicReleasePairCompositeFixture({ ...fixture, content: code, taskId: codeTask.taskId }, store);
  const operationId = "V".repeat(20), story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const nextDocument = { ...story, version: 10, published: { ...story.published, sourceVersion: 10,
    metadata: { ...story.published.metadata, title: "Actual reader controls publication" } } };
  await firestore.runTransaction(async transaction => {
    const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
      nextDocument, queueRef: firestore.doc(`cmsPublishQueue/${operationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
    prepared.write(); transaction.set(firestore.doc("cmsPosts/story"), nextDocument);
  });
  const queued = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId,
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resources"); } } });
  expect(queued.status).toBe("queued");
  const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: queued.taskId! }, store);
  expect((await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId, now: () => Date.now() + 31_000 })).status).toBe("rendered");
  const activated = await activateStagedPublicReleasePairPublication({ firestore, store, pair, identity: staged.claim.identity,
    claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest });
  const selector = (await firestore.doc("system/publicDeployment").get()).data()!;
  expect(selector).toMatchObject({ epoch: 2, selectedPair: p.publicReleasePairReference(pair),
    contentHead: { pairId: pair.pairId, contextSequence: 2 } });
  expect(activated.receipt.selectedAtActivation).toBe(true);
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()).toMatchObject({ status: "pending", execution: { pairDigest: p.publicReleaseDigest(pair) } });
  expect((await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).get()).exists).toBe(true);
}, 120_000);
