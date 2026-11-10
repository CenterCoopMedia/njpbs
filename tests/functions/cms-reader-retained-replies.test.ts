import { createRequire } from "node:module";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { retainedSourceFixture } from "../helpers/cms-reader-retained-sources";
const require = createRequire(import.meta.url);
const p = require("../../functions/lib/public-release-pair.js");
const cms = require("../../functions/lib/cms-preview-pair.js");
const source = require("../../functions/lib/cms-reader-retained-replies.js");
let app: any, db: any, fixture: any, sourceBodyDigest: string;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Local emulator only");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "retained-reply-source-emulator"); db = getFirestore(app);
});
afterAll(async () => { await db?.terminate(); if (app) await deleteApp(app); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  fixture = await retainedSourceFixture(db);
  ({ sourceBodyDigest } = await source.captureRetainedReaderReplySources({ firestore: db, ...fixture, now: () => fixture.now }));
});
function binding(kind = "preview", index = 1, root = fixture.legacyRoot) {
  return { schemaVersion: 1, sourceBodyDigest, sourcePair: p.publicReleasePairReference(fixture.oldPair),
    consumer: { kind, pairDigest: kind === "preview" ? cms.digest(fixture.previewPairs[index]) : p.publicReleaseDigest([fixture.oldPair, fixture.newPair][index]) },
    expectedPublicSelectorDigest: p.publicReleaseDigest(root) };
}
const read = (feature: string, retained = binding()) => db.runTransaction((transaction: any) => source.readRetainedReplyInTransaction({
  firestore: db, transaction, binding: retained, feature, body: fixture.requests[feature] }), { readOnly: true });
it("seals native OLD replies independently before any installed proof or NEW saved-preview request", async () => {
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
  for (const feature of source.FEATURES) {
    const value = await read(feature);
    expect(value.sourcePair).toEqual(p.publicReleasePairReference(fixture.oldPair));
    if (["postChrome", "capabilities"].includes(feature)) expect((value.value.receipt ?? value.value.contextReceipt).rendererSha).toBe(fixture.oldPair.commitSha);
    if (feature === "settings") expect(value.value).toMatchObject({ success: true, found: true, published: { sourceVersion: 3 } });
    if (feature === "previewRequest") expect(value.value.ready).toMatchObject({ queueId: fixture.admitted.queueId, sourceVersion: 7 });
  }
  expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
});
it("keeps exact OLD bytes across OLD-preserving conversion and binds NEW consumers to that original source", async () => {
  const before = await read("postChrome");
  await db.doc("system/publicDeployment").set(fixture.convertedRoot);
  await db.doc(cms.SELECTOR_PATH).set(fixture.convertedPreview);
  const after = await read("postChrome", binding("public", 1, fixture.convertedRoot));
  expect(after.json).toBe(before.json);
  expect(after.sourcePair.commitSha).toBe(fixture.oldPair.commitSha);
  expect(after.value.receipt.rendererSha).not.toBe(fixture.newPair.commitSha);
  await expect(read("postChrome", { ...binding("public", 1, fixture.convertedRoot), sourcePair: p.publicReleasePairReference(fixture.newPair) })).rejects.toThrow();
  await expect(read("postChrome", { ...binding("public", 1, fixture.convertedRoot), sourcePair: {
    ...p.publicReleasePairReference(fixture.oldPair), commitSha: "f".repeat(40) } })).rejects.toThrow();
  await expect(read("postChrome", { ...binding("public", 1, fixture.convertedRoot), consumer: { kind: "public", pairDigest: "0".repeat(64) } })).rejects.toThrow();
});
it.each(["public", "preview"])("refuses a genuinely sealed different %s consumer contract instead of relabeling the original source", async kind => {
  if (kind === "preview") {
    fixture.previewPairs[1].requirements.postChrome = 2;
    await db.doc(`${cms.PAIRS}/${fixture.previewPairs[1].pairId}`).set(fixture.previewPairs[1]);
  } else {
    fixture.newPair.readerContractDigest = "f".repeat(64);
    await db.doc(require("../../functions/lib/public-release-pair-work.js").publicReleasePairPath(fixture.newPair.pairId)).set(fixture.newPair);
  }
  ({ sourceBodyDigest } = await source.captureRetainedReaderReplySources({ firestore: db, ...fixture, now: () => fixture.now }));
  if (kind === "public") {
    await db.doc("system/publicDeployment").set(fixture.convertedRoot);
    await db.doc(cms.SELECTOR_PATH).set(fixture.convertedPreview);
  }
  await expect(read("postChrome", binding(kind, 1, kind === "public" ? fixture.convertedRoot : fixture.legacyRoot))).rejects.toThrow();
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
});
it("rechecks real expiry time after retention, without changing the original admitted queue or renewing its source", async () => {
  await db.doc("system/publicDeployment").set(fixture.convertedRoot);
  await db.doc(cms.SELECTOR_PATH).set(fixture.convertedPreview);
  const original = (await db.doc(`cmsPreviewQueue/${fixture.admitted.queueId}`).get()).data();
  await expect(db.runTransaction((transaction: any) => source.readRetainedReplyInTransaction({ firestore: db, transaction,
    binding: binding("preview", 1, fixture.convertedRoot), feature: "previewRequest", body: fixture.requests.previewRequest,
    now: () => fixture.now + 86400001 }), { readOnly: true })).rejects.toThrow();
  expect((await db.doc(`cmsPreviewQueue/${fixture.admitted.queueId}`).get()).data()).toEqual(original);
});
it("can capture a fresh native selected-OLD source after conversion/admission changes, without any installed proof or off-current NEW source", async () => {
  await db.doc("system/publicDeployment").set(fixture.convertedRoot);
  await db.doc(cms.SELECTOR_PATH).set(fixture.convertedPreview);
  await db.doc("system/noBuildPostAdmission").update({ revision: 2 });
  await expect(read("postChrome", binding("public", 1, fixture.convertedRoot))).rejects.toThrow();
  ({ sourceBodyDigest } = await source.captureRetainedReaderReplySources({ firestore: db, ...fixture, now: () => fixture.now }));
  const result = await read("postChrome", binding("public", 1, fixture.convertedRoot));
  expect(result.value.receipt).toMatchObject({ rendererSha: fixture.oldPair.commitSha, admissionRevision: 2 });
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
  const root = fixture.convertedRoot;
  await db.doc("system/publicDeployment").set({ ...root, selectedPair: root.recoveryPair, recoveryPair: root.selectedPair,
    activeCommitSha: fixture.newPair.commitSha, contentHead: { ...root.contentHead, pairId: root.recoveryPair.pairId } });
  await expect(source.captureRetainedReaderReplySources({ firestore: db, ...fixture, now: () => fixture.now })).rejects.toThrow();
});
it.each(["published-source", "new-owner", "queue", "head", "expiry", "contract", "billing"])("refuses changed %s with no new seal, queue or proof", async change => {
  const retained = binding();
  if (change === "published-source") await db.doc("cmsSettings/public-site-chrome").update({ "published.sourceVersion": 4 });
  if (change === "new-owner") await db.doc("system/publicDeployment/noBuildPostOwners/other").set({
    ...(await db.doc("system/publicDeployment/noBuildPostOwners/shadow-fixture").get()).data(), postId: "other" });
  if (change === "queue") await db.doc(`cmsPreviewQueue/${fixture.admitted.queueId}`).update({ sourceVersion: 8 });
  if (change === "head") await db.doc(fixture.headPath).update({ readyQueueId: "x".repeat(20) });
  if (change === "expiry") await db.doc(`cmsPreviewQueue/${fixture.admitted.queueId}`).update({ expiresAt: require("firebase-admin/firestore").Timestamp.fromMillis(Date.now() - 1) });
  if (change === "contract") await db.doc(`${cms.PAIRS}/${fixture.previewPairs[1].pairId}`).update({ "requirements.postChrome": 2 });
  if (change === "billing") await db.doc("system/billing").set({ disabled: true });
  const feature = ["queue", "head", "expiry"].includes(change) ? "previewRequest" : "postChrome";
  await expect(read(feature, retained)).rejects.toThrow();
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
  expect((await db.collection("cmsPreviewQueue").get()).size).toBe(1);
});
