import { beforeEach, expect, it } from "vitest";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair, releaseSelector, pairReference } from "../helpers/private-public-release-pair.js";
import p from "../../functions/lib/public-release-pair.js";
import a from "../../functions/lib/public-release-admission-contract.js";
import terminal from "../../functions/lib/public-release-terminal.js";
import editorRecheck from "../../functions/lib/publication-recheck.js";
const db = isolatedFirestore("public-release-terminal.test.ts"), operationId = "A".repeat(20), baseSelector = releaseSelector();
const selector = { ...baseSelector, contentHead: { ...baseSelector.contentHead, contextSequence: 2 } };
const pair = releasePair();
const admission = { schemaVersion: 2, operationId, source: { kind: "post", id: "story", family: "posts", action: "publish",
  sourceVersion: 2, snapshotDigest: "a".repeat(64), requiredFeatures: [] }, pair: pairReference(pair), pairDigest: p.publicReleaseDigest(pair),
epoch: 1, changeSequence: 1, contextRevision: 2, admissionSequence: 1, admittedContractDigest: "b".repeat(64) };
const admissionDigest = p.publicReleaseDigest(admission);
const identity = { schemaVersion: 2, pair: admission.pair, kind: "accepted", sourceOperationId: operationId,
  sourceVersion: 2, snapshotDigest: admission.source.snapshotDigest, contextSequence: 1, inputManifestDigest: "c".repeat(64) };
const execution = { schemaVersion: 2, pair: admission.pair, pairDigest: admission.pairDigest, identity,
  taskId: p.publicReleaseDigest(identity), inputManifestDigest: identity.inputManifestDigest, claimDigest: "d".repeat(64), manifestDigest: "e".repeat(64) };
const receipt = { schemaVersion: 2, kind: "pair-publication-terminal", operationId, admissionDigest, outcome: "success", selector,
  selectorDigest: p.publicReleaseDigest(selector), originalExecution: execution,
  activation: { kind: "pair-publication", operationId, receiptDigest: "f".repeat(64) }, coverageDigest: "1".repeat(64),
  canonicalProofDigest: "2".repeat(64), supersededBy: null };
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc(`${a.ADMISSIONS}/operations/${operationId}`).set(admission);
  await db.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`).set(receipt);
  await db.doc(`cmsPublishQueue/${operationId}`).set({ schemaVersion: 2, transport: a.TRANSPORT, operationId, admissionDigest,
    pair: admission.pair, status: "success", execution, terminalReceipt: p.publicReleaseDigest(receipt) });
});
const read = () => db.runTransaction(transaction => terminal.assertPairPublicationTerminalReceiptInTransaction({ firestore: db, transaction,
  operationId, admissionDigest }), { readOnly: true });
it("reads the exact immutable terminal fact after pending has gone without changing queue ownership", async () => {
  const before = (await db.doc(`cmsPublishQueue/${operationId}`).get()).updateTime;
  expect(await read()).toEqual(receipt);
  expect((await db.doc(`cmsPublishQueue/${operationId}`).get()).updateTime).toEqual(before);
});
it.each(["missing-receipt", "queue-digest", "pending", "original-claim", "admission"])("refuses a corrupt %s link", async change => {
  if (change === "missing-receipt") await db.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`).delete();
  if (change === "queue-digest") await db.doc(`cmsPublishQueue/${operationId}`).update({ terminalReceipt: "0".repeat(64) });
  if (change === "pending") await db.doc(`${a.ADMISSIONS}/pending/${operationId}`).set({ schemaVersion: 2, operationId, admissionDigest });
  if (change === "original-claim") await db.doc(`cmsPublishQueue/${operationId}`).update({ "execution.claimDigest": "0".repeat(64) });
  if (change === "admission") await db.doc(`${a.ADMISSIONS}/operations/${operationId}`).update({ "source.sourceVersion": 3 });
  await expect(read()).rejects.toThrow();
});
it("refuses a consistently linked terminal head that predates the original admission", async () => {
  const earlier = { ...selector, contentHead: { ...selector.contentHead, contextSequence: 0 } };
  const invalid = { ...receipt, selector: earlier, selectorDigest: p.publicReleaseDigest(earlier) };
  await db.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`).set(invalid);
  await db.doc(`cmsPublishQueue/${operationId}`).update({ terminalReceipt: p.publicReleaseDigest(invalid) });
  await expect(read()).rejects.toThrow();
});
it("requires the actual linked later successful terminal fact for supersession", async () => {
  const id = "B".repeat(20), nextAdmission = { ...admission, operationId: id, admissionSequence: 2, changeSequence: 2,
    source: { ...admission.source, sourceVersion: 3, snapshotDigest: "3".repeat(64) } }, nextDigest = p.publicReleaseDigest(nextAdmission);
  const nextIdentity = { ...identity, sourceOperationId: id, sourceVersion: 3, snapshotDigest: nextAdmission.source.snapshotDigest, contextSequence: 2 };
  const nextExecution = { ...execution, identity: nextIdentity, taskId: p.publicReleaseDigest(nextIdentity) };
  const nextReceipt = { ...receipt, operationId: id, admissionDigest: nextDigest, originalExecution: nextExecution,
    activation: { ...receipt.activation, operationId: id } };
  await db.doc(`${a.ADMISSIONS}/operations/${id}`).set(nextAdmission);
  await db.doc(`${terminal.TERMINAL_RECEIPTS}/${id}`).set(nextReceipt);
  await db.doc(`cmsPublishQueue/${id}`).set({ schemaVersion: 2, transport: a.TRANSPORT, operationId: id, admissionDigest: nextDigest,
    pair: admission.pair, status: "success", execution: nextExecution, terminalReceipt: p.publicReleaseDigest(nextReceipt) });
  const replaced = { ...receipt, outcome: "superseded", originalExecution: null, supersededBy: { operationId: id,
    admissionDigest: nextDigest, terminalReceiptDigest: p.publicReleaseDigest(nextReceipt) } };
  await db.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`).set(replaced);
  await db.doc(`cmsPublishQueue/${operationId}`).update({ status: "superseded", execution: null, terminalReceipt: p.publicReleaseDigest(replaced) });
  expect((await read()).outcome).toBe("superseded");
  await db.doc(`cmsPublishQueue/${id}`).update({ terminalReceipt: "0".repeat(64) });
  await expect(read()).rejects.toThrow();
});

it("reports newer paired site work only through the exact terminal owner", async () => {
  const originalId = "C".repeat(20);
  const source = { kind: "provider", id: "provider-refresh", family: "context", action: "dependency" };
  const prior = { ...admission, operationId: originalId, source: { ...admission.source, ...source, sourceVersion: 1 } };
  const current = { ...admission, source: { ...admission.source, ...source }, admissionSequence: 2 };
  const digest = p.publicReleaseDigest(current);
  const proof = { ...receipt, admissionDigest: digest };
  const queue = db.doc(`cmsPublishQueue/${originalId}`);
  const retained = { schemaVersion: 2, transport: a.TRANSPORT, operationId: originalId, admissionDigest: p.publicReleaseDigest(prior),
    pair: prior.pair, status: "failed", execution: null, terminalReceipt: null };
  const owner = db.doc(a.ownerPath(current.source));
  const batch = db.batch();
  batch.set(db.doc(`${a.ADMISSIONS}/operations/${originalId}`), prior);
  batch.set(db.doc(`${a.ADMISSIONS}/operations/${operationId}`), current);
  batch.set(owner, { schemaVersion: 2, operationId, admissionDigest: digest, admissionSequence: 2 });
  batch.set(queue, retained);
  batch.update(db.doc(`cmsPublishQueue/${operationId}`), { admissionDigest: digest, terminalReceipt: "0".repeat(64) });
  batch.set(db.doc(`${terminal.TERMINAL_RECEIPTS}/${operationId}`), proof);
  await batch.commit();
  const actor = { uid: "fixture-admin", principal: { id: "fixture-admin", grants: [{ role: "admin" }] } };
  const check = () => editorRecheck.recheckPublication({ firestore: db, queueId: originalId, actor });
  await expect(check()).rejects.toThrow();
  expect((await queue.get()).data()).toEqual(retained);
  await db.doc(`cmsPublishQueue/${operationId}`).update({ terminalReceipt: p.publicReleaseDigest(proof) });
  expect(await check()).toMatchObject({ outcome: "superseded" });
  const { lastPublicCheck, ...after } = (await queue.get()).data()!;
  expect(after).toEqual(retained);
  expect(lastPublicCheck.outcome).toBe("superseded");
  const audit = await db.collection("admin_logs").get();
  expect(audit.docs[0].data()).toMatchObject({ target: originalId, after: { operationId, receipt: { admissionDigest: digest } } });
});
